package types

// PTYCreateRequest is the request body for creating a PTY session.
type PTYCreateRequest struct {
	Cols  int    `json:"cols,omitempty"`  // default 80
	Rows  int    `json:"rows,omitempty"`  // default 24
	Shell string `json:"shell,omitempty"` // default /bin/bash
}

// PTYSession represents an active PTY session.
type PTYSession struct {
	SessionID string `json:"sessionID"`
	SandboxID string `json:"sandboxID"`
}

// PTYResizeRequest is a WebSocket control frame for resizing the terminal.
type PTYResizeRequest struct {
	Type string `json:"type"` // "resize"
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}
