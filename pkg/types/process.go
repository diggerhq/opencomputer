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
