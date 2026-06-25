package types

// ExecSessionCreateRequest is the request body for creating an exec session.
type ExecSessionCreateRequest struct {
	Command               string            `json:"cmd"`
	Args                  []string          `json:"args,omitempty"`
	Env                   map[string]string `json:"envs,omitempty"`
	Cwd                   string            `json:"cwd,omitempty"`
	Timeout               int               `json:"timeout,omitempty"`
	MaxRunAfterDisconnect int               `json:"maxRunAfterDisconnect,omitempty"`
}

// ExecSessionResult is the terminal/intermediate result of an exec session,
// fetched without attaching a live stream. Used by the async exec/run poll
// path. Stdout/Stderr are the scrollback snapshot split by frame tag.
type ExecSessionResult struct {
	Running   bool   `json:"running"`
	ExitCode  *int   `json:"exitCode,omitempty"`
	Stdout    []byte `json:"stdout,omitempty"`
	Stderr    []byte `json:"stderr,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	CommandMs int64  `json:"commandMs,omitempty"` // command wall-clock (start→exit/now)
}

// ExecSessionInfo is the response body for exec session metadata.
type ExecSessionInfo struct {
	SessionID       string   `json:"sessionID"`
	SandboxID       string   `json:"sandboxID"`
	Command         string   `json:"command"`
	Args            []string `json:"args"`
	Running         bool     `json:"running"`
	ExitCode        *int     `json:"exitCode,omitempty"`
	StartedAt       string   `json:"startedAt"`
	AttachedClients int      `json:"attachedClients"`
}
