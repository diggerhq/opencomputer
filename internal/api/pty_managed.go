package api

// pty_managed.go — serving PTY for a backend the control plane holds.
//
// The fleet reaches a terminal by proxying to the worker that owns the sandbox.
// A managed backend has no worker, so those routes were refused (see
// refuseIfManaged, and the bug it exists to prevent). These handlers serve them
// in-process instead: three small JSON calls, and one WebSocket spliced through
// to the box.
//
// The splice is deliberately DUMB. Both sides speak the same frame format —
// the customer's SDK to us, and us to the guest — so this copies messages
// without interpreting them. Anything smarter would be a second implementation
// of a protocol that already has one, on the path where a bug shows up as a
// corrupted terminal rather than an error.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/awsvmlite"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// ptyBackend is implemented by a backend that can serve terminals itself.
type ptyBackend interface {
	PTYCreate(ctx context.Context, sandboxID string, req awsvmlite.PTYRequest) (string, error)
	PTYResize(ctx context.Context, sandboxID, sessionID string, cols, rows int32) error
	PTYKill(ctx context.Context, sandboxID, sessionID string) error
	DialPTY(ctx context.Context, sandboxID, sessionID string) (*websocket.Conn, error)
}

// ptyBackendFor returns the backend serving this sandbox's terminals, if any.
func (s *Server) ptyBackendFor(ctx context.Context, sandboxID string) (ptyBackend, bool) {
	b, _, ok := s.backendFor(ctx, sandboxID)
	if !ok {
		return nil, false
	}
	pb, ok := b.(ptyBackend)
	return pb, ok
}

// dispatchPTY serves a PTY route locally when a managed backend holds the
// sandbox, and otherwise hands it to the proxy — which is every QEMU sandbox,
// unchanged.
func (s *Server) dispatchPTY(local, proxied echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if _, ok := s.ptyBackendFor(c.Request().Context(), c.Param("id")); ok {
			return local(c)
		}
		return proxied(c)
	}
}

func (s *Server) createPTYManaged(c echo.Context) error {
	id := c.Param("id")
	b, ok := s.ptyBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "terminals are not supported for this sandbox"})
	}
	var req types.PTYCreateRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	sessionID, err := b.PTYCreate(c.Request().Context(), id, awsvmlite.PTYRequest{
		Cols: int32(req.Cols), Rows: int32(req.Rows), Shell: req.Shell,
	})
	if err != nil {
		return respondFSErr(c, err)
	}
	return c.JSON(http.StatusCreated, types.PTYSession{SessionID: sessionID, SandboxID: id})
}

func (s *Server) resizePTYManaged(c echo.Context) error {
	id, sessionID := c.Param("id"), c.Param("sessionID")
	b, ok := s.ptyBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "terminals are not supported for this sandbox"})
	}
	var req types.PTYResizeRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	if err := b.PTYResize(c.Request().Context(), id, sessionID, int32(req.Cols), int32(req.Rows)); err != nil {
		return respondFSErr(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

func (s *Server) killPTYManaged(c echo.Context) error {
	id, sessionID := c.Param("id"), c.Param("sessionID")
	b, ok := s.ptyBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "terminals are not supported for this sandbox"})
	}
	if err := b.PTYKill(c.Request().Context(), id, sessionID); err != nil {
		return respondFSErr(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// ptyUpgrader accepts the customer's side of the terminal.
var ptyUpgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	// The edge has already authenticated this request; there is no browser
	// origin to check it against.
	CheckOrigin: func(*http.Request) bool { return true },
}

// ptyWebSocketManaged splices the customer's terminal socket to the box's.
//
// Dial FIRST, upgrade second. Upgrading commits a 101 that cannot be taken
// back, so a box that refuses the connection would leave the customer with an
// open socket and no way to be told why — this way the failure is an ordinary
// HTTP status.
func (s *Server) ptyWebSocketManaged(c echo.Context) error {
	id, sessionID := c.Param("id"), c.Param("sessionID")
	b, ok := s.ptyBackendFor(c.Request().Context(), id)
	if !ok {
		return c.JSON(http.StatusNotImplemented, map[string]string{"error": "terminals are not supported for this sandbox"})
	}

	// Not the request context: it is cancelled when the handler returns, and
	// this socket has to outlive that for the length of the session.
	box, err := b.DialPTY(context.Background(), id, sessionID)
	if err != nil {
		log.Printf("pty: dial %s/%s: %v", id, sessionID, err)
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "could not attach to the terminal"})
	}
	defer box.Close()

	client, err := ptyUpgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		log.Printf("pty: upgrade %s/%s: %v", id, sessionID, err)
		return nil // Upgrade already wrote a response
	}
	defer client.Close()

	// Either direction ending ends the session: a terminal with one live half
	// is a terminal that echoes into nothing.
	// TRANSLATED, not spliced. The guest speaks a framed protocol
	// ({data:base64, cols, rows}) because a PTY needs an out-of-band resize;
	// the customer-facing contract, set by the QEMU path, is raw binary frames
	// with resize over HTTP. Passing the guest's frames straight through made a
	// terminal that works on one runtime print base64 JSON on the other — the
	// customer's SDK is identical, so the runtime must not be visible here.
	done := make(chan struct{}, 2)
	go pumpPTYToClient(client, box, done)
	go pumpPTYToBox(box, client, done)
	<-done

	// Nudge the other pump: closing both sockets makes its blocked read return,
	// so neither goroutine outlives the session.
	_ = client.SetReadDeadline(time.Now())
	_ = box.SetReadDeadline(time.Now())
	return nil
}

// pumpWS copies messages one way until either side fails.
func pumpWS(dst, src *websocket.Conn, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	for {
		mt, msg, err := src.ReadMessage()
		if err != nil {
			return
		}
		if err := dst.WriteMessage(mt, msg); err != nil {
			return
		}
	}
}

// ptyServerFrame / ptyClientFrame mirror cmd/microvm-hooks' oc_stream.go. Kept
// as private copies rather than shared types because they are a WIRE contract
// with a separately-deployed binary: an import would let a change here silently
// imply a guest that has not been rebuilt.
type ptyServerFrame struct {
	Data     string `json:"data,omitempty"`
	Exited   bool   `json:"exited,omitempty"`
	ExitCode int32  `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

type ptyClientFrame struct {
	Data string `json:"data,omitempty"`
	Cols int32  `json:"cols,omitempty"`
	Rows int32  `json:"rows,omitempty"`
}

// pumpPTYToClient unwraps the guest's frames into the raw bytes a terminal
// expects.
func pumpPTYToClient(client, box *websocket.Conn, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	for {
		_, msg, err := box.ReadMessage()
		if err != nil {
			return
		}
		var f ptyServerFrame
		if err := json.Unmarshal(msg, &f); err != nil {
			// Not a frame we understand. Forwarding it raw is the safer
			// failure: a guest that ever sends plain bytes still works, and
			// the alternative is a terminal that silently drops output.
			if err := client.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				return
			}
			continue
		}
		if f.Data != "" {
			out, dErr := base64.StdEncoding.DecodeString(f.Data)
			if dErr != nil {
				continue
			}
			if err := client.WriteMessage(websocket.BinaryMessage, out); err != nil {
				return
			}
		}
		if f.Exited {
			// The shell is gone; closing tells the customer's socket so rather
			// than leaving it open against a dead PTY.
			return
		}
	}
}

// pumpPTYToBox wraps the customer's keystrokes into the guest's frames.
func pumpPTYToBox(box, client *websocket.Conn, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	for {
		_, msg, err := client.ReadMessage()
		if err != nil {
			return
		}
		frame, mErr := json.Marshal(ptyClientFrame{Data: base64.StdEncoding.EncodeToString(msg)})
		if mErr != nil {
			return
		}
		if err := box.WriteMessage(websocket.TextMessage, frame); err != nil {
			return
		}
	}
}
