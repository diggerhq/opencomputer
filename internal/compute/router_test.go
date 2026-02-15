package compute

import (
	"context"
	"testing"
)

func TestRouter_AssignAndLookup(t *testing.T) {
	pool := NewLocalPool("localhost:9090")
	router := NewRouter(pool)

	machine, err := router.Assign(context.Background(), "sandbox-1")
	if err != nil {
		t.Fatalf("Assign() error: %v", err)
	}
	if machine.ID != "local" {
		t.Errorf("expected machine ID 'local', got %s", machine.ID)
	}

	machineID, err := router.Lookup("sandbox-1")
	if err != nil {
		t.Fatalf("Lookup() error: %v", err)
	}
	if machineID != "local" {
		t.Errorf("expected machine ID 'local', got %s", machineID)
	}
}

func TestRouter_LookupNotFound(t *testing.T) {
	pool := NewLocalPool("localhost:9090")
	router := NewRouter(pool)

	_, err := router.Lookup("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent sandbox")
	}
}

func TestRouter_Release(t *testing.T) {
	pool := NewLocalPool("localhost:9090")
	router := NewRouter(pool)

	_, err := router.Assign(context.Background(), "sandbox-1")
	if err != nil {
		t.Fatalf("Assign() error: %v", err)
	}

	router.Release("sandbox-1")

	_, err = router.Lookup("sandbox-1")
	if err == nil {
		t.Error("expected error after release")
	}
}
