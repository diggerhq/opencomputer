package api

import (
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/pkg/types"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now; tighten in production
	},
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

func (s *Server) createPTY(c echo.Context) error {
	id := c.Param("id")

	var req types.PTYCreateRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body: " + err.Error(),
		})
	}

	session, err := s.ptyManager.CreateSession(id, req)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
	}

	return c.JSON(http.StatusCreated, types.PTYSession{
		SessionID: session.ID,
		SandboxID: id,
	})
}

func (s *Server) ptyWebSocket(c echo.Context) error {
	sessionID := c.Param("sessionID")

	session, err := s.ptyManager.GetSession(sessionID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": err.Error(),
		})
	}

	ws, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return err
	}
	defer ws.Close()

	// Read from PTY -> send to WebSocket
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := session.PTY.Read(buf)
			if n > 0 {
				if writeErr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); writeErr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Read from WebSocket -> write to PTY
	go func() {
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if _, err := session.PTY.Write(msg); err != nil {
				return
			}
		}
	}()

	// Wait for PTY process to end or connection to close
	select {
	case <-done:
	case <-session.Done:
	}

	// Give the reader goroutine a moment to flush remaining output
	ws.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(time.Second))

	return nil
}

func (s *Server) killPTY(c echo.Context) error {
	sessionID := c.Param("sessionID")

	if err := s.ptyManager.KillSession(sessionID); err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": err.Error(),
		})
	}

	return c.NoContent(http.StatusNoContent)
}

