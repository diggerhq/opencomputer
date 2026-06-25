package types

// ProcessResult is the result of a completed command execution.
type ProcessResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

// ProcessConfig is the request body for running a command.
type ProcessConfig struct {
	Command string            `json:"cmd"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"envs,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Timeout int               `json:"timeout,omitempty"` // seconds, default 60
}

// ExecRunResponse is the immediate handle returned by the async exec/run
// endpoint. The command runs as a background exec session; the caller polls
// GET /exec/:execId/result for completion.
type ExecRunResponse struct {
	ExecID    string `json:"execId"`
	Running   bool   `json:"running"`
	StartedAt string `json:"startedAt"`
}

// ExecRunResult is the polled result of an async exec/run session. ExitCode is
// nil while Running is true. Truncated indicates the 1MB scrollback ring
// dropped older output (attach via WS for full live output). Waking is true
// while the sandbox is still auto-waking / the session is being created (no
// output yet). Error is set if the wake or session-create failed.
type ExecRunResult struct {
	Running   bool   `json:"running"`
	Waking    bool   `json:"waking,omitempty"`
	ExitCode  *int   `json:"exitCode,omitempty"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated,omitempty"`
	Error     string `json:"error,omitempty"`

	// Timing (524 attribution; observable per-request, not just in logs).
	// WakeMs = checkpoint-restore latency before the command could start;
	// CreateMs = session create once the box was up; CommandMs = the command's
	// own wall-clock. wake/command being the two things that used to hold the
	// synchronous connection past Cloudflare's 100s.
	WakeMs    int64 `json:"wakeMs,omitempty"`
	CreateMs  int64 `json:"createMs,omitempty"`
	CommandMs int64 `json:"commandMs,omitempty"`
}

// BackgroundProcess represents a background process.
type BackgroundProcess struct {
	PID int    `json:"pid"`
	Tag string `json:"tag,omitempty"`
}

// ProcessInfo describes a running process inside a sandbox.
type ProcessInfo struct {
	PID     int    `json:"pid"`
	Command string `json:"cmd"`
}
