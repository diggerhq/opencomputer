// oc-modelproxy: the model proxy on a computer. A model client in a session
// (Claude Code, Codex, anything that takes a base URL) reaches it on a Unix
// socket in plaintext with a placeholder credential; the proxy names the
// caller from its cgroup (identity.go), applies the profile that caller is
// bound to (profile.go: the upstream, the routes allowed, the headers that
// carry the binding's variables) and streams to that upstream. A binder (the
// host) binds callers over a second socket (control.go). The real credential
// is never in the session's process, files or environment.
//
// Profiles are JSON files (-profiles), read at start: a change takes a
// restart, which keeps bindings (persist.go); -check validates them without
// starting. Everything else is flags. Standard library only.
package main

import (
	"cmp"
	"context"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"
)

// version is set at build time: -ldflags "-X main.version=...".
var version = "dev"

type config struct {
	apiSocket, controlSocket string
	profilesDir              string
	placeholder              string
	identity                 string // cgroup | single
	bindingsFile             string
	hold, drain              time.Duration
	maxInflightPerCaller     int
	maxConnsPerCaller        int
	wsIdle                   time.Duration
	maxIdlePerHost           int
	maxConnsPerHost          int
	idleConnTimeout          time.Duration
	procRoot                 string // tests only; "" = /proc
	debug                    bool
	rootCAs                  *x509.CertPool // tests only; nil = system roots
}

// defaultGCPercent: the live heap is a few MiB, so at Go's default of 100
// the collector runs every few hundred requests and its assists land in
// stream latency (p99 overhead about 1.5 ms at 64 streams, versus 0.15 ms
// at 400; see BenchmarkProxyOverhead). 400 costs a few tens of MiB.
const defaultGCPercent = 400

// maxHeaderBytes bounds a request's headers; with -max-conns-per-caller it
// bounds what a caller can make the proxy hold before a request is admitted.
const maxHeaderBytes = 32 << 10

// setGCPercent applies defaultGCPercent unless GOGC is set in the environment.
func setGCPercent() {
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(defaultGCPercent)
	}
}

func main() {
	cfg, mode, err := parseFlags(os.Args[1:])
	if err != nil {
		os.Exit(2) // the FlagSet has printed it
	}
	switch mode {
	case modeVersion:
		fmt.Println(version)
		return
	case modeCheck:
		if err := checkProfiles(cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	level := slog.LevelInfo
	if cfg.debug {
		level = slog.LevelDebug
	}
	initLogger(version, level)
	setGCPercent()
	if err := run(cfg); err != nil {
		logError("exit", "error", err.Error())
		os.Exit(1)
	}
}

// checkProfiles is -check: the load a start does, and nothing else.
func checkProfiles(cfg config) error {
	_, err := loadProfiles(cfg.profilesDir)
	return err
}

// runMode is what the command line asks for instead of serving.
type runMode int

const (
	modeServe runMode = iota
	modeVersion
	modeCheck
)

func parseFlags(args []string) (config, runMode, error) {
	var cfg config
	fs := flag.NewFlagSet("oc-modelproxy", flag.ContinueOnError)
	showVersion := fs.Bool("version", false, "print the version and exit")
	check := fs.Bool("check", false, "load -profiles as a start would, print the first error and exit 0 or 1; opens no socket")
	fs.StringVar(&cfg.apiSocket, "api-socket", "/run/oc-modelproxy/api.sock", "the model clients' socket; used when not socket-activated")
	fs.StringVar(&cfg.controlSocket, "control-socket", "/run/oc-modelproxy/control.sock", "the binder's control socket; used when not socket-activated")
	fs.StringVar(&cfg.profilesDir, "profiles", "/etc/oc-modelproxy/profiles.d", "directory of profile files (*.json)")
	fs.StringVar(&cfg.placeholder, "placeholder", "ssh-placeholder", "the only credential a caller may send: `Authorization: Bearer <it>` or `x-api-key: <it>`")
	fs.StringVar(&cfg.identity, "identity", "cgroup", "how a caller is named: cgroup (<id> of its sp-runner-<id>.service unit) or single (every caller is "+singleCaller+")")
	fs.StringVar(&cfg.bindingsFile, "bindings-file", "/run/oc-modelproxy/profile-bindings.json", "persisted bindings, without their variables (empty: do not persist)")
	fs.DurationVar(&cfg.hold, "hold-timeout", 10*time.Second, "how long a request waits for its caller's credential, and then for a free upstream connection")
	fs.DurationVar(&cfg.drain, "drain-timeout", 630*time.Second, "on SIGTERM, how long in-flight streams may finish")
	fs.IntVar(&cfg.maxInflightPerCaller, "max-inflight-per-caller", 32, "concurrent requests (held ones included) one caller may have; more get 429 (0: no limit)")
	fs.IntVar(&cfg.maxConnsPerCaller, "max-conns-per-caller", 128, "connections one caller may have open on the API socket; more are closed as accepted (0: no limit)")
	fs.DurationVar(&cfg.wsIdle, "ws-idle-timeout", 5*time.Minute, "close a WebSocket idle this long between responses; it holds a caller's in-flight slot while open (0: never)")
	fs.IntVar(&cfg.maxIdlePerHost, "max-idle-conns-per-host", 96, "idle upstream connections kept")
	fs.IntVar(&cfg.maxConnsPerHost, "max-conns-per-host", 256, "upstream connection ceiling; requests beyond it queue")
	fs.DurationVar(&cfg.idleConnTimeout, "idle-conn-timeout", 50*time.Second, "close idle upstream connections after this")
	fs.BoolVar(&cfg.debug, "debug", false, "debug logging")
	if err := fs.Parse(args); err != nil {
		return cfg, modeServe, err
	}
	switch {
	case *showVersion:
		return cfg, modeVersion, nil
	case *check:
		return cfg, modeCheck, nil
	}
	return cfg, modeServe, nil
}

func run(cfg config) error {
	started := time.Now()
	ps, err := loadProfiles(cfg.profilesDir)
	if err != nil {
		return err
	}
	var resolve Resolver
	switch cfg.identity {
	case "cgroup":
		resolve = peerResolver(cmp.Or(cfg.procRoot, "/proc"))
	case "single":
		resolve = singleResolver
	default:
		return fmt.Errorf("-identity must be cgroup or single")
	}
	srv, err := newServer(cfg, ps, resolve)
	if err != nil {
		return err
	}

	ls, err := activatedListeners()
	if err != nil {
		return err
	}
	apiL, ctlL := ls["api"], ls["control"]
	if apiL == nil {
		if apiL, err = listenUnix(cfg.apiSocket); err != nil {
			return err
		}
	}
	if ctlL == nil {
		if ctlL, err = listenUnix(cfg.controlSocket); err != nil {
			return err
		}
	}
	srv.start(apiL, ctlL)
	sdNotify("READY=1")
	logInfo("ready", "activated", len(ls) > 0, "profiles", len(ps.sorted), "bindings", srv.bindings.Len(), "startup_ms", ms(time.Since(started)))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	sdNotify("STOPPING=1")
	logInfo("draining", "streams", srv.proxy.activeStreams())
	ctx, cancel := context.WithTimeout(context.Background(), cfg.drain)
	defer cancel()
	err = srv.shutdown(ctx)
	logInfo("exit", "uptime_s", int(time.Since(started).Seconds()), "dropped_messages", srv.control.Dropped())
	return err
}

// server wires the parts; tests build it with their own resolver and roots.
type server struct {
	cfg      config
	profiles *profiles
	bindings *Bindings
	control  *Control
	proxy    *Proxy
	persist  *persister
	http     *http.Server
	resolve  Resolver
	ctlL     net.Listener
	stop     chan struct{}
	done     chan struct{}
}

func (cfg config) newUpstream(p *profile) *upstream {
	return newUpstream(upstreamConfig{url: p.url, maxIdlePerHost: cfg.maxIdlePerHost, maxConnsPerHost: cfg.maxConnsPerHost,
		idleConnTimeout: cfg.idleConnTimeout, rootCAs: cfg.rootCAs})
}

// newServer builds a server on ps, one upstream per profile.
func newServer(cfg config, ps *profiles, resolve Resolver) (*server, error) {
	if cfg.placeholder == "" || !validHeaderValue(cfg.placeholder) {
		return nil, fmt.Errorf("-placeholder must be a header value")
	}
	if cfg.hold <= 0 {
		return nil, fmt.Errorf("-hold-timeout must be positive")
	}
	s := &server{cfg: cfg, profiles: ps, resolve: resolve, stop: make(chan struct{}), done: make(chan struct{})}
	s.control = NewControl(version, cfg.placeholder, ps)
	s.bindings = NewBindings(ps, s.control, nil)
	s.persist = newPersister(cfg.bindingsFile, s.bindings.Snapshot)
	s.bindings.dirty = s.persist.markDirty
	s.control.bindings = s.bindings
	entries, err := loadBindings(cfg.bindingsFile)
	if err != nil {
		logWarn("bindings file unreadable; starting empty", "error", err.Error())
	}
	s.bindings.Restore(entries)
	s.proxy = NewProxy(s.bindings, NewObserver(s.control), s.control, ps, cfg.placeholder, cfg.hold, cfg.maxInflightPerCaller)
	s.proxy.wsIdle = cfg.wsIdle
	var pool httputil.BufferPool = newBufferPool(32 << 10)
	for _, p := range ps.sorted {
		newOutbound(s.proxy, p, cfg.newUpstream(p), pool)
	}
	s.http = &http.Server{
		Handler:           s.proxy,
		ConnContext:       connCaller,
		ReadHeaderTimeout: 30 * time.Second,
		MaxHeaderBytes:    maxHeaderBytes,
		IdleTimeout:       5 * time.Minute,
		ErrorLog:          discardLog,
	}
	s.http.SetKeepAlivesEnabled(true)
	return s, nil
}

func (s *server) start(apiL, ctlL net.Listener) {
	s.ctlL = ctlL
	go s.persist.run()
	go func() {
		l := &callerListener{Listener: apiL, resolve: s.resolve, conns: newInflight(s.cfg.maxConnsPerCaller)}
		if err := s.http.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logError("api socket", "error", err.Error())
		}
	}()
	go s.control.Serve(ctlL)
	go s.poolLoop()
	e := newEvent(time.Now(), "model.proxy_started")
	e.Outcome = "completed"
	e.Data = map[string]any{"version": version, "bindings": s.bindings.Len()}
	s.control.sendKept(e)
}

// poolLoop reports each profile's upstream pool every minute, as a log line
// and a model.pool event.
func (s *server) poolLoop() {
	defer close(s.done)
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			for i, p := range s.profiles.sorted {
				e, ok := s.poolEvent(p, i == 0)
				if !ok {
					continue
				}
				args := make([]any, 0, 2*len(e.Data)+2)
				args = append(args, "profile", e.Profile)
				for k, v := range e.Data {
					args = append(args, k, v)
				}
				logInfo("pool", args...)
				s.control.send(e)
			}
		case <-s.stop:
			return
		}
	}
}

// poolEvent is one profile's model.pool telemetry event: gauges of its
// upstream pool, and the counters since the last one (which it resets). The
// first profile's is always sent and carries the proxy-wide gauges, so a
// sum over profiles counts them once; ok is false for another's idle pool
// with nothing to report.
func (s *server) poolEvent(p *profile, first bool) (eventMsg, bool) {
	up := p.up
	open, streams := up.open.Load(), up.streams.Load()
	if !first && open == 0 && streams == 0 && up.dials.Load() == 0 && up.poolMiss.Load() == 0 {
		return eventMsg{}, false
	}
	e := newEvent(time.Now(), "model.pool")
	e.Profile = p.name
	e.Outcome = "completed"
	e.Data = map[string]any{
		"open_conns": open, "idle_conns": max(open-streams, 0), "active_streams": streams,
		"idle_pool_miss": up.poolMiss.Swap(0), "dials": up.dials.Swap(0),
	}
	if first {
		e.Data["bindings"], e.Data["dropped_messages"] = s.bindings.Len(), s.control.Dropped()
	}
	return e, true
}

// shutdown: drop the binder's connection first (it reconnects to the next
// instance at once), stop accepting, let in-flight streams and WebSocket
// responses finish.
func (s *server) shutdown(ctx context.Context) error {
	s.control.Close()
	s.ctlL.Close()
	s.proxy.drainWS(ctx, false) // tunnels close between responses while HTTP streams finish
	err := s.http.Shutdown(ctx)
	s.proxy.drainWS(ctx, true)
	close(s.stop)
	<-s.done
	s.persist.close()
	for _, p := range s.profiles.sorted {
		p.up.close()
	}
	return err
}
