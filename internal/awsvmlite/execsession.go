package awsvmlite

// execsession.go — long-running commands with a live output stream.
//
// /oc/run answers one command in one request, which is the right shape for
// almost everything a sandbox is asked to do and the wrong shape for anything
// a customer wants to watch: a dev server, a build, a training run. A session
// starts a process, keeps it alive across disconnects, and streams output to
// whoever is attached.
//
// Same construction as pty.go: unary calls over plain JSON, one WebSocket per
// attached client opened on demand and closed on detach, and the gRPC stream
// living entirely inside the guest. Nothing here is on the create or exec hot
// path.

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
	ocExecCreatePath = "/oc/exec/create"
	ocExecAttachPath = "/oc/exec/attach"
	ocExecListPath   = "/oc/exec/list"
	ocExecKillPath   = "/oc/exec/kill"
	ocExecResultPath = "/oc/exec/result"
)

// ExecSessionRequest starts or addresses a session. Mirrors the guest's shape.
type ExecSessionRequest struct {
	SessionID             string            `json:"sessionId,omitempty"`
	Command               string            `json:"cmd,omitempty"`
	Args                  []string          `json:"args,omitempty"`
	Env                   map[string]string `json:"envs,omitempty"`
	Cwd                   string            `json:"cwd,omitempty"`
	TimeoutSec            int32             `json:"timeoutSec,omitempty"`
	MaxRunAfterDisconnect int32             `json:"maxRunAfterDisconnect,omitempty"`
	Signal                int32             `json:"signal,omitempty"`
}

// ExecSessionInfo is one session in a listing.
type ExecSessionInfo struct {
	SessionID       string   `json:"sessionId"`
	Command         string   `json:"command"`
	Args            []string `json:"args"`
	Running         bool     `json:"running"`
	ExitCode        int32    `json:"exitCode"`
	StartedAt       int64    `json:"startedAt"`
	AttachedClients int      `json:"attachedClients"`
}

// ExecSessionResult is a session's output so far, without attaching.
type ExecSessionResult struct {
	Running  bool   `json:"running"`
	ExitCode *int32 `json:"exitCode,omitempty"`
	Stdout   []byte `json:"stdout,omitempty"`
	Stderr   []byte `json:"stderr,omitempty"`
}

func (m *Manager) ExecSessionCreate(ctx context.Context, sandboxID string, req ExecSessionRequest) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var out struct {
		SessionID string `json:"sessionId"`
	}
	if err := m.call(ctx, sandboxID, http.MethodPost, ocExecCreatePath, req, &out); err != nil {
		return "", err
	}
	return out.SessionID, nil
}

func (m *Manager) ExecSessionList(ctx context.Context, sandboxID string) ([]ExecSessionInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var out struct {
		Sessions []ExecSessionInfo `json:"sessions"`
	}
	if err := m.call(ctx, sandboxID, http.MethodGet, ocExecListPath, nil, &out); err != nil {
		return nil, err
	}
	return out.Sessions, nil
}

func (m *Manager) ExecSessionKill(ctx context.Context, sandboxID, sessionID string, signal int32) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocExecKillPath,
		ExecSessionRequest{SessionID: sessionID, Signal: signal}, nil)
}

// ExecSessionGetResult reports a session's output so far.
//
// The guest synthesises this from the agent's scrollback rather than from a
// buffer the control plane keeps — see the handler for why the SCROLLBACK_END
// marker is what makes it terminate instead of hanging on a quiet process.
func (m *Manager) ExecSessionGetResult(ctx context.Context, sandboxID, sessionID string) (*ExecSessionResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var out ExecSessionResult
	path := ocExecResultPath + "?sessionId=" + url.QueryEscape(sessionID)
	if err := m.call(ctx, sandboxID, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DialExecSession opens the WebSocket carrying one attached client.
//
// The caller owns the connection and must close it — closing is what detaches
// the client inside the guest. A detach does NOT kill the session: it outlives
// its clients by design, which is the whole point of a session as opposed to a
// run.
func (m *Manager) DialExecSession(ctx context.Context, sandboxID, sessionID string) (*websocket.Conn, error) {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return nil, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	u := url.URL{
		Scheme:   "wss",
		Host:     hostOnly(b.Endpoint),
		Path:     ocExecAttachPath,
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
		if resp != nil {
			return nil, fmt.Errorf("awsvmlite: dial exec session %s: %w (http %d)", sandboxID, err, resp.StatusCode)
		}
		return nil, fmt.Errorf("awsvmlite: dial exec session %s: %w", sandboxID, err)
	}
	m.stampTouch(b)
	return conn, nil
}
