package types

import "time"

// SandboxStatus represents the current state of a sandbox.
type SandboxStatus string

const (
	SandboxStatusRunning SandboxStatus = "running"
	SandboxStatusStopped SandboxStatus = "stopped"
	SandboxStatusError   SandboxStatus = "error"
)

// Sandbox represents a running sandbox instance.
type Sandbox struct {
	ID         string            `json:"sandboxID"`
	Template   string            `json:"templateID,omitempty"`
	Alias      string            `json:"alias,omitempty"`
	ClientID   string            `json:"clientID,omitempty"`
	Status     SandboxStatus     `json:"status"`
	StartedAt  time.Time         `json:"startedAt"`
	EndAt      time.Time         `json:"endAt"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	CpuCount   int               `json:"cpuCount"`
	MemoryMB   int               `json:"memoryMB"`
	MachineID  string            `json:"machineID,omitempty"`
}

// SandboxConfig is the request body for creating a sandbox.
type SandboxConfig struct {
	Template   string            `json:"templateID,omitempty"`
	Alias      string            `json:"alias,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	Timeout    int               `json:"timeout,omitempty"`    // seconds, default 300
	CpuCount   int               `json:"cpuCount,omitempty"`   // default 1
	MemoryMB   int               `json:"memoryMB,omitempty"`   // default 512
	Envs       map[string]string `json:"envs,omitempty"`
	NetworkEnabled bool          `json:"networkEnabled,omitempty"`
}

// SandboxListResponse is the response for listing sandboxes.
type SandboxListResponse struct {
	Sandboxes []Sandbox `json:"sandboxes"`
}

// TimeoutRequest is the request body for updating sandbox timeout.
type TimeoutRequest struct {
	Timeout int `json:"timeout"` // seconds
}
