// oc-modelproxy: the model proxy on a computer. A model client in a session
// (Claude Code, Codex, anything that takes a base URL) reaches it on a Unix
// socket in plaintext with a placeholder credential; the proxy names the
// caller's runner unit from its cgroup, applies the profile that unit is
// bound to (profile.go: the upstream, the routes allowed, the headers that
// carry the binding's variables) and streams to that upstream. The host
// binds units over a second socket. The real credential is never in the
// session's process, files or environment.
//
// Profiles are JSON files (-profiles), read at start: a change takes a
// restart, which keeps bindings (persist.go). Everything else is flags.
// Standard library only.
package main

import (
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
	defaultProfile           string
	placeholder              string
	identity                 string // cgroup | single
	bindingsFile             string
	hold, drain              time.Duration
	maxInflightPerUnit       int
	wsIdle                   time.Duration
	maxIdlePerHost           int
	maxConnsPerHost          int
	idleConnTimeout          time.Duration
	warmMax                  int
	procRoot                 string
	debug                    bool
	gcPercent                int
	rootCAs                  *x509.CertPool // tests only; nil = system roots
}

// defaultGCPercent: the live heap is a few MiB, so at Go's default of 100
// the collector runs every few hundred requests and its assists land in
// stream latency (p99 overhead about 1.5 ms at 64 streams, versus 0.15 ms
// at 400; see BenchmarkProxyOverhead). 400 costs a few tens of MiB.
const defaultGCPercent = 400

// setGCPercent applies -gc-percent unless GOGC is set in the environment.
func setGCPercent(pct int) {
	if os.Getenv("GOGC") == "" && pct != 0 {
		debug.SetGCPercent(pct)
	}
}

func main() {
	cfg, showVersion, err := parseFlags(os.Args[1:])
	if err != nil {
		os.Exit(2) // the FlagSet has printed it
	}
	if showVersion {
		fmt.Println(version)
		return
	}
	level := slog.LevelInfo
	if cfg.debug {
		level = slog.LevelDebug
	}
	initLogger(version, level)
	setGCPercent(cfg.gcPercent)
	if err := run(cfg); err != nil {
		logError("exit", "error", err.Error())
		os.Exit(1)
	}
}

func parseFlags(args []string) (config, bool, error) {
	var cfg config
	fs := flag.NewFlagSet("oc-modelproxy", flag.ContinueOnError)
	showVersion := fs.Bool("version", false, "print the version and exit")
	fs.StringVar(&cfg.apiSocket, "api-socket", "/run/oc-modelproxy/api.sock", "the model clients' socket; used when not socket-activated")
	fs.StringVar(&cfg.controlSocket, "control-socket", "/run/oc-modelproxy/control.sock", "the host's control socket; used when not socket-activated")
	fs.StringVar(&cfg.profilesDir, "profiles", "/etc/oc-modelproxy/profiles.d", "directory of profile files (*.json)")
	fs.StringVar(&cfg.defaultProfile, "default-profile", "", "profile of a bind that names none (a host from before profiles)")
	fs.StringVar(&cfg.placeholder, "placeholder", "ssh-placeholder", "the only credential a caller may send: `Authorization: Bearer <it>` or `x-api-key: <it>`")
	fs.StringVar(&cfg.identity, "identity", "cgroup", "how a caller is named: cgroup (its sp-runner-*.service unit) or single (every caller is "+singleUnit+")")
	fs.StringVar(&cfg.bindingsFile, "bindings-file", "/run/oc-modelproxy/bindings.json", "persisted bindings, without their variables (empty: do not persist)")
	fs.DurationVar(&cfg.hold, "hold-timeout", 10*time.Second, "how long a request waits for its unit's credential")
	fs.DurationVar(&cfg.drain, "drain-timeout", 630*time.Second, "on SIGTERM, how long in-flight streams may finish")
	fs.IntVar(&cfg.maxInflightPerUnit, "max-inflight-per-unit", 32, "concurrent requests (held ones included) one runner unit may have; more get 429 (0: no limit)")
	fs.DurationVar(&cfg.wsIdle, "ws-idle-timeout", 5*time.Minute, "close a WebSocket idle this long between responses; it holds a unit in-flight slot while open (0: never)")
	fs.IntVar(&cfg.maxIdlePerHost, "max-idle-conns-per-host", 96, "idle upstream connections kept")
	fs.IntVar(&cfg.maxConnsPerHost, "max-conns-per-host", 256, "upstream connection ceiling; requests beyond it queue")
	fs.DurationVar(&cfg.idleConnTimeout, "idle-conn-timeout", 50*time.Second, "close idle upstream connections after this")
	fs.IntVar(&cfg.warmMax, "warm-conns", 4, "pre-dialed TLS connections kept per upstream for new binds (0: off)")
	fs.StringVar(&cfg.procRoot, "proc", "/proc", "procfs root, for caller cgroups")
	fs.BoolVar(&cfg.debug, "debug", false, "debug logging")
	fs.IntVar(&cfg.gcPercent, "gc-percent", defaultGCPercent, "Go GC target percent (GOGC in the environment wins)")
	if err := fs.Parse(args); err != nil {
		return cfg, false, err
	}
	return cfg, *showVersion, nil
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
		resolve = peerResolver(cfg.procRoot)
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
	ctlL     net.Listener
	stop     chan struct{}
	done     chan struct{}
}

func (cfg config) newUpstream(p *profile) *upstream {
	return newUpstream(upstreamConfig{url: p.url, maxIdlePerHost: cfg.maxIdlePerHost, maxConnsPerHost: cfg.maxConnsPerHost,
		idleConnTimeout: cfg.idleConnTimeout, warmMax: cfg.warmMax, warmMaxAge: 45 * time.Second, rootCAs: cfg.rootCAs})
}

// newServer builds a server on ps, one upstream per profile.
func newServer(cfg config, ps *profiles, resolve Resolver) (*server, error) {
	if cfg.defaultProfile != "" && ps.get(cfg.defaultProfile) == nil {
		return nil, fmt.Errorf("-default-profile: no profile %q", cfg.defaultProfile)
	}
	if cfg.placeholder == "" || !validHeaderValue(cfg.placeholder) {
		return nil, fmt.Errorf("-placeholder must be a header value")
	}
	s := &server{cfg: cfg, profiles: ps, stop: make(chan struct{}), done: make(chan struct{})}
	s.control = NewControl(version, ps)
	s.bindings = NewBindings(ps, cfg.defaultProfile, s.control, nil)
	s.persist = newPersister(cfg.bindingsFile, s.bindings.Snapshot)
	s.bindings.dirty = s.persist.markDirty
	s.bindings.prewarm = func(p *profile) { p.up.prewarm() }
	s.control.bindings = s.bindings
	entries, err := loadBindings(cfg.bindingsFile)
	if err != nil {
		logWarn("bindings file unreadable; starting empty", "error", err.Error())
	}
	s.bindings.Restore(entries)
	s.proxy = NewProxy(s.bindings, NewObserver(s.control), s.control, ps, cfg.placeholder, cfg.hold, cfg.maxInflightPerUnit)
	s.proxy.wsIdle = cfg.wsIdle
	var pool httputil.BufferPool = newBufferPool(32 << 10)
	for _, p := range ps.sorted {
		newOutbound(s.proxy, p, cfg.newUpstream(p), pool)
	}
	s.http = &http.Server{
		Handler:           s.proxy,
		ConnContext:       ConnContext(resolve),
		ReadHeaderTimeout: 30 * time.Second,
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
		if err := s.http.Serve(apiL); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logError("api socket", "error", err.Error())
		}
	}()
	go func() {
		if err := s.control.Serve(ctlL); err != nil {
			logError("control socket", "error", err.Error())
		}
	}()
	go s.poolLoop()
	e := newEvent(time.Now(), "model.proxy_started")
	e.Outcome = "completed"
	e.Data = map[string]any{"version": version, "bindings": s.bindings.Len()}
	s.control.sendKept(e)
}

// poolLoop sweeps parked connections every minute and reports each
// profile's upstream pool as a log line and a model.pool event.
func (s *server) poolLoop() {
	defer close(s.done)
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			for i, p := range s.profiles.sorted {
				p.up.sweep()
				e, ok := s.poolEvent(p, i == 0)
				if !ok {
					continue
				}
				args := make([]any, 0, 2*len(e.Data)+2)
				args = append(args, "profile", e.Provider)
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
	open, streams, warm := up.open.Load(), up.streams.Load(), int64(up.warmCount())
	if !first && open == 0 && streams == 0 && warm == 0 && up.dials.Load() == 0 &&
		up.warmFailed.Load() == 0 && up.poolMiss.Load() == 0 {
		return eventMsg{}, false
	}
	e := newEvent(time.Now(), "model.pool")
	e.Provider = p.name
	e.Outcome = "completed"
	e.Data = map[string]any{
		"open_conns": open, "idle_conns": max(open-streams-warm, 0), "active_streams": streams, "warm_conns": warm,
		"idle_pool_miss": up.poolMiss.Swap(0), "warm_hits": up.warmHits.Swap(0), "warm_failed": up.warmFailed.Swap(0),
		"dials": up.dials.Swap(0),
	}
	if first {
		e.Data["bindings"], e.Data["dropped_messages"] = s.bindings.Len(), s.control.Dropped()
	}
	return e, true
}

// shutdown: drop the host's connection first (it reconnects to the next
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
