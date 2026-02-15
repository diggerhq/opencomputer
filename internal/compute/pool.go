package compute

import "context"

// Machine represents a worker machine in the compute pool.
type Machine struct {
	ID       string `json:"id"`
	Addr     string `json:"addr"`     // internal address (host:port)
	Region   string `json:"region"`
	Status   string `json:"status"`   // "running", "stopped", "creating"
	Capacity int    `json:"capacity"` // max sandboxes
	Current  int    `json:"current"`  // current sandbox count
}

// MachineOpts are options for creating a new machine.
type MachineOpts struct {
	Region string
	Size   string // provider-specific machine size
	Image  string // worker Docker image
}

// Pool is the interface for compute pool providers.
type Pool interface {
	CreateMachine(ctx context.Context, opts MachineOpts) (*Machine, error)
	DestroyMachine(ctx context.Context, machineID string) error
	StartMachine(ctx context.Context, machineID string) error
	StopMachine(ctx context.Context, machineID string) error
	ListMachines(ctx context.Context) ([]*Machine, error)
	HealthCheck(ctx context.Context, machineID string) error
}
