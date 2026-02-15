package compute

import (
	"context"
	"fmt"
)

// LocalPool is a single-machine compute pool for development.
type LocalPool struct {
	workerAddr string
	machine    *Machine
}

// NewLocalPool creates a local compute pool pointing to localhost.
func NewLocalPool(workerAddr string) *LocalPool {
	return &LocalPool{
		workerAddr: workerAddr,
		machine: &Machine{
			ID:       "local",
			Addr:     workerAddr,
			Region:   "local",
			Status:   "running",
			Capacity: 100,
			Current:  0,
		},
	}
}

func (p *LocalPool) CreateMachine(_ context.Context, _ MachineOpts) (*Machine, error) {
	return p.machine, nil
}

func (p *LocalPool) DestroyMachine(_ context.Context, _ string) error {
	return fmt.Errorf("cannot destroy local machine")
}

func (p *LocalPool) StartMachine(_ context.Context, _ string) error {
	p.machine.Status = "running"
	return nil
}

func (p *LocalPool) StopMachine(_ context.Context, _ string) error {
	p.machine.Status = "stopped"
	return nil
}

func (p *LocalPool) ListMachines(_ context.Context) ([]*Machine, error) {
	return []*Machine{p.machine}, nil
}

func (p *LocalPool) HealthCheck(_ context.Context, _ string) error {
	return nil // Local machine is always healthy
}
