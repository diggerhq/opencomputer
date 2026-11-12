// One profile's upstream transport (one each, never shared, see
// profile.go): HTTP/1.1 only (one TCP connection per concurrent stream, so
// one lost packet stalls one stream), no transparent compression (the
// client's accept-encoding passes through), a TLS session cache, and a small
// warm pool of pre-dialed TLS connections.
//
// Pre-dial: a client reaching the proxy over a Unix socket cannot preconnect
// to the upstream itself, so on a unit's first bind the proxy dials and
// handshakes one TLS connection and parks it here; the Transport's next dial
// takes it instead of dialing. No HTTP request is sent, so no quota is
// spent. A parked connection has a watcher blocked in Read: any byte or EOF
// from the server means it is dead and it is dropped; handing it out stops
// the watcher with a past read deadline (a timeout is not sticky on a
// tls.Conn).
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

type upstreamConfig struct {
	url             *url.URL
	maxIdlePerHost  int
	maxConnsPerHost int
	idleConnTimeout time.Duration
	warmMax         int
	warmMaxAge      time.Duration
	rootCAs         *x509.CertPool // tests only; nil = system roots
}

type upstream struct {
	cfg       upstreamConfig
	tlsConf   *tls.Config
	dialer    net.Dialer
	transport *http.Transport

	open       atomic.Int64 // upstream TCP connections open
	dials      atomic.Int64
	warmHits   atomic.Int64
	warmFailed atomic.Int64 // pre-dials that failed
	streams    atomic.Int64 // requests in flight to this upstream (proxy.go)
	poolMiss   atomic.Int64 // requests that found no idle connection

	mu      sync.Mutex
	warm    []*warmConn
	warming int
	closed  bool
}

type warmConn struct {
	tc      *tls.Conn
	at      time.Time
	dead    atomic.Bool
	stopped chan struct{}
}

func newUpstream(cfg upstreamConfig) *upstream {
	host := cfg.url.Hostname()
	u := &upstream{cfg: cfg, dialer: net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}}
	u.tlsConf = &tls.Config{
		ServerName:         host,
		NextProtos:         []string{"http/1.1"},
		ClientSessionCache: tls.NewLRUClientSessionCache(256),
		MinVersion:         tls.VersionTLS12,
		RootCAs:            cfg.rootCAs,
	}
	u.transport = &http.Transport{
		Proxy:               nil, // never an environment proxy
		DialTLSContext:      u.dialTLS,
		TLSNextProto:        map[string]func(string, *tls.Conn) http.RoundTripper{}, // HTTP/1.1 only
		ForceAttemptHTTP2:   false,
		DisableCompression:  true,
		MaxIdleConnsPerHost: cfg.maxIdlePerHost,
		MaxConnsPerHost:     cfg.maxConnsPerHost,
		IdleConnTimeout:     cfg.idleConnTimeout,
		// Headers only: a stream's body may take as long as it likes once they are in.
		ResponseHeaderTimeout: 60 * time.Second,
	}
	return u
}

// countedConn decrements the open-connection gauge once on Close.
type countedConn struct {
	net.Conn
	u    *upstream
	once sync.Once
}

func (c *countedConn) Close() error {
	c.once.Do(func() { c.u.open.Add(-1) })
	return c.Conn.Close()
}

func (u *upstream) handshake(ctx context.Context, addr string) (*tls.Conn, error) {
	raw, err := u.dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	u.open.Add(1)
	u.dials.Add(1)
	tc := tls.Client(&countedConn{Conn: raw, u: u}, u.tlsConf)
	if err := tc.HandshakeContext(ctx); err != nil {
		tc.Close()
		return nil, err
	}
	return tc, nil
}

func (u *upstream) addr() string {
	port := u.cfg.url.Port()
	if port == "" {
		port = "443"
	}
	return net.JoinHostPort(u.cfg.url.Hostname(), port)
}

func (u *upstream) dialTLS(ctx context.Context, network, addr string) (net.Conn, error) {
	if addr == u.addr() {
		if tc := u.takeWarm(); tc != nil {
			u.warmHits.Add(1)
			return tc, nil
		}
	}
	return u.handshake(ctx, addr)
}

// prewarm parks one fresh TLS connection unless the pool is full.
func (u *upstream) prewarm() {
	u.mu.Lock()
	if u.closed || u.cfg.warmMax <= 0 || len(u.warm)+u.warming >= u.cfg.warmMax {
		u.mu.Unlock()
		return
	}
	u.warming++
	u.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tc, err := u.handshake(ctx, u.addr())
		u.mu.Lock()
		u.warming--
		if err != nil || u.closed {
			u.mu.Unlock()
			if err != nil {
				u.warmFailed.Add(1)
				logWarn("pre-dial failed", "error_type", errorClass(err))
			} else {
				tc.Close()
			}
			return
		}
		w := &warmConn{tc: tc, at: time.Now(), stopped: make(chan struct{})}
		u.warm = append(u.warm, w)
		u.mu.Unlock()
		go w.watch()
	}()
}

func (w *warmConn) watch() {
	defer close(w.stopped)
	var b [1]byte
	_, err := w.tc.Read(b[:])
	var ne net.Error
	if err == nil || !errors.As(err, &ne) || !ne.Timeout() {
		w.dead.Store(true) // data, EOF or a reset: the server is done with it
	}
}

// takeWarm hands out the newest live parked connection, dropping dead or old ones.
func (u *upstream) takeWarm() *tls.Conn {
	for {
		u.mu.Lock()
		n := len(u.warm)
		if n == 0 {
			u.mu.Unlock()
			return nil
		}
		w := u.warm[n-1]
		u.warm = u.warm[:n-1]
		u.mu.Unlock()
		w.tc.SetReadDeadline(time.Unix(1, 0))
		<-w.stopped
		if w.dead.Load() || time.Since(w.at) > u.cfg.warmMaxAge {
			w.tc.Close()
			continue
		}
		w.tc.SetReadDeadline(time.Time{})
		return w.tc
	}
}

// sweep drops parked connections past their age; called from the pool ticker.
func (u *upstream) sweep() {
	u.mu.Lock()
	keep := u.warm[:0]
	var drop []*warmConn
	for _, w := range u.warm {
		if w.dead.Load() || time.Since(w.at) > u.cfg.warmMaxAge {
			drop = append(drop, w)
		} else {
			keep = append(keep, w)
		}
	}
	u.warm = keep
	u.mu.Unlock()
	for _, w := range drop {
		w.tc.Close()
	}
}

func (u *upstream) warmCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.warm)
}

func (u *upstream) close() {
	u.mu.Lock()
	u.closed = true
	ws := u.warm
	u.warm = nil
	u.mu.Unlock()
	for _, w := range ws {
		w.tc.Close()
	}
	u.transport.CloseIdleConnections()
}

// errorClass is a closed class for an upstream transport error: never the
// error text, which may carry addresses.
func errorClass(err error) string {
	var ne net.Error
	var tlsErr *tls.CertificateVerificationError
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.As(err, &tlsErr):
		return "tls_verify"
	case errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	}
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Op == "dial" {
		return "connect"
	}
	return "transport"
}
