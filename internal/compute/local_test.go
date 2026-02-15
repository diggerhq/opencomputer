package compute

import (
	"context"
	"testing"
)

func TestLocalPool_ListMachines(t *testing.T) {
	pool := NewLocalPool("localhost:9090")
	machines, err := pool.ListMachines(context.Background())
	if err != nil {
		t.Fatalf("ListMachines() error: %v", err)
	}
	if len(machines) != 1 {
		t.Fatalf("expected 1 machine, got %d", len(machines))
	}
	if machines[0].ID != "local" {
		t.Errorf("expected machine ID 'local', got %s", machines[0].ID)
	}
	if machines[0].Status != "running" {
		t.Errorf("expected status 'running', got %s", machines[0].Status)
	}
}

func TestLocalPool_CreateMachine(t *testing.T) {
	pool := NewLocalPool("localhost:9090")
	m, err := pool.CreateMachine(context.Background(), MachineOpts{})
	if err != nil {
		t.Fatalf("CreateMachine() error: %v", err)
	}
	if m.Addr != "localhost:9090" {
		t.Errorf("expected addr localhost:9090, got %s", m.Addr)
	}
}

func TestLocalPool_DestroyMachine(t *testing.T) {
	pool := NewLocalPool("localhost:9090")
	err := pool.DestroyMachine(context.Background(), "local")
	if err == nil {
		t.Error("expected error when destroying local machine")
	}
}

func TestLocalPool_HealthCheck(t *testing.T) {
	pool := NewLocalPool("localhost:9090")
	err := pool.HealthCheck(context.Background(), "local")
	if err != nil {
		t.Errorf("HealthCheck() error: %v", err)
	}
}
