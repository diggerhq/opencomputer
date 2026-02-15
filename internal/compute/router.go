package compute

import (
	"context"
	"fmt"
	"sync"
)

// Router routes sandbox operations to the appropriate machine.
type Router struct {
	pool     Pool
	mu       sync.RWMutex
	mapping  map[string]string // sandbox ID -> machine ID
}

// NewRouter creates a new sandbox router.
func NewRouter(pool Pool) *Router {
	return &Router{
		pool:    pool,
		mapping: make(map[string]string),
	}
}

// Assign picks the least-loaded machine for a new sandbox.
func (r *Router) Assign(ctx context.Context, sandboxID string) (*Machine, error) {
	machines, err := r.pool.ListMachines(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list machines: %w", err)
	}

	// Find the machine with the most remaining capacity
	var best *Machine
	for _, m := range machines {
		if m.Status != "running" {
			continue
		}
		remaining := m.Capacity - m.Current
		if best == nil || remaining > (best.Capacity-best.Current) {
			best = m
		}
	}

	if best == nil {
		return nil, fmt.Errorf("no available machines in compute pool")
	}

	r.mu.Lock()
	r.mapping[sandboxID] = best.ID
	best.Current++
	r.mu.Unlock()

	return best, nil
}

// Lookup returns the machine that hosts a given sandbox.
func (r *Router) Lookup(sandboxID string) (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	machineID, ok := r.mapping[sandboxID]
	if !ok {
		return "", fmt.Errorf("sandbox %s not found in routing table", sandboxID)
	}
	return machineID, nil
}

// Release removes a sandbox from the routing table.
func (r *Router) Release(sandboxID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.mapping, sandboxID)
}
