// One profile's upstream transport (one each, never shared, see
// profile.go): HTTP/1.1 only (one TCP connection per concurrent stream, so
// one lost packet stalls one stream), no transparent compression (the
// client's accept-encoding passes through), a TLS session cache, and the
// standard library's connection pool.
//
// Limits: 10 s to connect, 10 s more for the TLS handshake, 600 s for the
// response headers (a request that does not stream answers only when the
// model is done); none on a body once its headers are in. How long a request
// may queue for one of MaxConnsPerHost connections is the proxy's (proxy.go).
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

const (
	dialTimeout           = 10 * time.Second
	tlsHandshakeTimeout   = 10 * time.Second
	responseHeaderTimeout = 600 * time.Second
)

type upstreamConfig struct {
	url             *url.URL
	maxIdlePerHost  int
	maxConnsPerHost int
	idleConnTimeout time.Duration
	rootCAs         *x509.CertPool // tests only; nil = system roots
}

type upstream struct {
	cfg              upstreamConfig
	tlsConf          *tls.Config
	dialer           net.Dialer
	transport        *http.Transport
	handshakeTimeout time.Duration

	open     atomic.Int64 // upstream TCP connections open
	dials    atomic.Int64
	streams  atomic.Int64 // requests in flight to this upstream (proxy.go)
	poolMiss atomic.Int64 // requests that found no idle connection
}

func newUpstream(cfg upstreamConfig) *upstream {
	u := &upstream{cfg: cfg, handshakeTimeout: tlsHandshakeTimeout, dialer: net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}}
	u.tlsConf = &tls.Config{
		ServerName:         cfg.url.Hostname(),
		NextProtos:         []string{"http/1.1"},
		ClientSessionCache: tls.NewLRUClientSessionCache(256),
		MinVersion:         tls.VersionTLS12,
		RootCAs:            cfg.rootCAs,
	}
	u.transport = &http.Transport{
		Proxy:                 nil, // never an environment proxy
		DialTLSContext:        u.dialTLS,
		TLSNextProto:          map[string]func(string, *tls.Conn) http.RoundTripper{}, // HTTP/1.1 only
		ForceAttemptHTTP2:     false,
		DisableCompression:    true,
		MaxIdleConnsPerHost:   cfg.maxIdlePerHost,
		MaxConnsPerHost:       cfg.maxConnsPerHost,
		IdleConnTimeout:       cfg.idleConnTimeout,
		ResponseHeaderTimeout: responseHeaderTimeout,
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

func (u *upstream) dialTLS(ctx context.Context, network, addr string) (net.Conn, error) {
	raw, err := u.dialer.DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	u.open.Add(1)
	u.dials.Add(1)
	tc := tls.Client(&countedConn{Conn: raw, u: u}, u.tlsConf)
	ctx, cancel := context.WithTimeout(ctx, u.handshakeTimeout)
	defer cancel()
	if err := tc.HandshakeContext(ctx); err != nil {
		tc.Close()
		return nil, err
	}
	return tc, nil
}

func (u *upstream) close() { u.transport.CloseIdleConnections() }

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
