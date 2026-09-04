package awsvmlite

// pty.go — interactive terminals, on a data plane that has no persistent
// connection.
//
// The tunnel this needs already exists on every box: handleAgentTunnel splices
// a WebSocket to the agent's gRPC listener, and it works through the proxy.
// What made it a liability on the agent path was that it was ALWAYS ON — one
// pre-dialed channel per box, keepalives, a re-dial ladder, and a Durable
// Object holding sockets open, decaying whether or not anybody was attached.
//
// Here it is opened only when a customer attaches a terminal and closed when
// they detach. A box with no terminal open has no socket, nothing to keep
// alive, and nothing to re-dial — so create and exec are untouched, which is
// the property this whole backend exists to protect.
//
// And the gRPC stream itself never leaves the guest: the customer's side of
// this socket carries a small JSON frame format (see cmd/microvm-hooks/
// oc_stream.go), which the guest translates. So the proxy's trailer stripping —
// the reason gRPC cannot cross it — never comes into play.

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

const (
	ocPTYCreatePath = "/oc/pty/create"
	ocPTYAttachPath = "/oc/pty/attach"
	ocPTYResizePath = "/oc/pty/resize"
	ocPTYKillPath   = "/oc/pty/kill"
)

// PTYRequest is the body of the unary PTY calls, matching the guest's shape.
type PTYRequest struct {
	SessionID string `json:"sessionId,omitempty"`
	Cols      int32  `json:"cols,omitempty"`
	Rows      int32  `json:"rows,omitempty"`
	Shell     string `json:"shell,omitempty"`
}

// PTYCreate starts a terminal and returns its session id.
func (m *Manager) PTYCreate(ctx context.Context, sandboxID string, req PTYRequest) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var out struct {
		SessionID string `json:"sessionId"`
	}
	if err := m.call(ctx, sandboxID, http.MethodPost, ocPTYCreatePath, req, &out); err != nil {
		return "", err
	}
	return out.SessionID, nil
}

// PTYResize tells the terminal its new dimensions. Out of band, because a
// resize has to reach the PTY even when the customer is not typing — a terminal
// that cannot be resized renders every full-screen program wrong.
func (m *Manager) PTYResize(ctx context.Context, sandboxID, sessionID string, cols, rows int32) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocPTYResizePath,
		PTYRequest{SessionID: sessionID, Cols: cols, Rows: rows}, nil)
}

// PTYKill ends a terminal.
func (m *Manager) PTYKill(ctx context.Context, sandboxID, sessionID string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocPTYKillPath,
		PTYRequest{SessionID: sessionID}, nil)
}

// ptyDialTimeout bounds the handshake to the box. Only the handshake — the
// socket it returns has no deadline, because a terminal is idle most of the
// time and a read deadline would close it under a customer who stopped typing.
const ptyDialTimeout = 20 * time.Second

// DialPTY opens the WebSocket carrying one terminal session.
//
// The caller owns the returned connection and must close it; closing it is what
// releases the gRPC stream inside the guest, so a caller that leaks this leaks
// a PTY on the box too.
func (m *Manager) DialPTY(ctx context.Context, sandboxID, sessionID string) (*websocket.Conn, error) {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return nil, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	u := url.URL{
		Scheme:   "wss",
		Host:     hostOnly(b.Endpoint),
		Path:     ocPTYAttachPath,
		RawQuery: "sessionId=" + url.QueryEscape(sessionID),
	}
	dialer := &websocket.Dialer{
		HandshakeTimeout: ptyDialTimeout,
		ReadBufferSize:   32 * 1024,
		WriteBufferSize:  32 * 1024,
	}
	hdr := http.Header{}
	hdr.Set("X-aws-proxy-auth", m.token(ctx, b))
	hdr.Set("X-aws-proxy-port", strconv.FormatInt(int64(b.Port), 10))

	conn, resp, err := dialer.DialContext(ctx, u.String(), hdr)
	if err != nil {
		// The status is worth reporting: the proxy answers 403 for a bad token
		// and 502 for a box that is gone, and those want very different
		// responses from the caller.
		if resp != nil {
			return nil, fmt.Errorf("awsvmlite: dial pty %s: %w (http %d)", sandboxID, err, resp.StatusCode)
		}
		return nil, fmt.Errorf("awsvmlite: dial pty %s: %w", sandboxID, err)
	}
	m.stampTouch(b)
	return conn, nil
}
