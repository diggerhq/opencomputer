// The API socket's listener: it names each connection's caller as it is
// accepted (identity.go) and caps how many connections one caller may have
// open (-max-conns-per-caller), so one session cannot hold enough of them to
// exhaust the proxy's memory or descriptors. Connections without a caller
// share one cap. Over it, a connection is closed at once.
//
// Invariant: a connection's caller is resolved once, here, never per
// request.
package main

import (
	"context"
	"net"
	"sync"
)

type callerListener struct {
	net.Listener
	resolve Resolver
	conns   *inflight // open connections per caller
}

func (l *callerListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		caller := l.resolve(c)
		if l.conns.enter(caller) {
			return &callerConn{Conn: c, caller: caller, l: l}, nil
		}
		c.Close()
	}
}

type callerConn struct {
	net.Conn
	caller string
	l      *callerListener
	once   sync.Once
}

func (c *callerConn) Close() error {
	c.once.Do(func() { c.l.conns.leave(c.caller) })
	return c.Conn.Close()
}

// connCaller is http.Server.ConnContext: every request on a connection is
// its caller's, whatever its process does afterwards.
func connCaller(ctx context.Context, c net.Conn) context.Context {
	return context.WithValue(ctx, callerKey, c.(*callerConn).caller)
}
