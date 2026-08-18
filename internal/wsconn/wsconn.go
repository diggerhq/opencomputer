// Package wsconn adapts a WebSocket into a net.Conn.
//
// It exists because AWS Lambda MicroVMs' auth proxy strips HTTP/2 trailers.
// gRPC delivers its status (grpc-status/grpc-message) in trailers, so an RPC
// forwarded through that proxy as ordinary HTTP/2 completes in the guest and
// then fails at the client with "server closed the stream without sending
// trailers" — verified directly by round-tripping an unannounced trailer, which
// vanished, while the identical exchange against a local Go server preserved it.
//
// A WebSocket, however, passes through intact. Wrapping it as a net.Conn lets
// gRPC run its own HTTP/2 over the tunnel: the proxy sees opaque WebSocket
// frames and never inspects — or discards — the trailers inside. The agent's
// entire API keeps working unchanged, which is the point; the alternatives
// (gRPC-Web, Connect, a bespoke HTTP/JSON exec route) all mean reworking the
// service definition the QEMU backend already depends on.
package wsconn

import (
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Conn is a net.Conn backed by a WebSocket connection.
type Conn struct {
	ws *websocket.Conn

	// readMu serialises readers and guards the partial-message remainder.
	// gorilla permits only one concurrent reader and one concurrent writer,
	// while HTTP/2 above us will happily use the conn from several goroutines.
	readMu sync.Mutex
	rest   io.Reader

	writeMu sync.Mutex
}

// New wraps a WebSocket connection as a net.Conn.
func New(ws *websocket.Conn) *Conn { return &Conn{ws: ws} }

// Read fills p from the current WebSocket message, pulling the next message
// when the current one is exhausted.
//
// Message boundaries carry no meaning here: HTTP/2 has its own framing, and a
// reader may ask for fewer bytes than a message holds. Keeping the remainder is
// what makes this a byte stream rather than a datagram channel.
func (c *Conn) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()

	for {
		if c.rest != nil {
			n, err := c.rest.Read(p)
			if err == io.EOF {
				c.rest = nil
				// A zero-length message must not surface as a spurious EOF to
				// the caller — go back for the next one.
				if n == 0 {
					continue
				}
				return n, nil
			}
			return n, err
		}
		_, r, err := c.ws.NextReader()
		if err != nil {
			return 0, translateErr(err)
		}
		c.rest = r
	}
}

// Write sends p as a single binary WebSocket message.
func (c *Conn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, translateErr(err)
	}
	return len(p), nil
}

func (c *Conn) Close() error { return c.ws.Close() }

func (c *Conn) LocalAddr() net.Addr  { return c.ws.LocalAddr() }
func (c *Conn) RemoteAddr() net.Addr { return c.ws.RemoteAddr() }

func (c *Conn) SetDeadline(t time.Time) error {
	if err := c.ws.SetReadDeadline(t); err != nil {
		return err
	}
	return c.ws.SetWriteDeadline(t)
}

func (c *Conn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *Conn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

// translateErr maps a normal WebSocket close onto io.EOF. Without this, an
// orderly shutdown reaches gRPC as an unexpected transport failure and surfaces
// to callers as an error rather than a clean end of stream.
func translateErr(err error) error {
	if err == nil {
		return nil
	}
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		switch ce.Code {
		case websocket.CloseNormalClosure, websocket.CloseGoingAway:
			return io.EOF
		}
	}
	return err
}
