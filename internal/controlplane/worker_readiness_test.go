package controlplane

import "testing"

func TestWorkerEntryRoutingReadiness(t *testing.T) {
	legacy := &WorkerEntry{}
	if !legacy.AcceptsCreateRouting() || !legacy.AcceptsMigrationRouting() {
		t.Fatal("legacy worker with no readiness fields should accept both routing classes")
	}

	migrationOnly := &WorkerEntry{AcceptsCreates: false, AcceptsMigrations: true}
	if migrationOnly.AcceptsCreateRouting() {
		t.Fatal("migration-only worker should not accept create routing")
	}
	if !migrationOnly.AcceptsMigrationRouting() {
		t.Fatal("migration-only worker should accept migration routing")
	}

	createOnly := &WorkerEntry{AcceptsCreates: true, AcceptsMigrations: false}
	if !createOnly.AcceptsCreateRouting() {
		t.Fatal("create-only worker should accept create routing")
	}
	if createOnly.AcceptsMigrationRouting() {
		t.Fatal("create-only worker should not accept migration routing")
	}
}
