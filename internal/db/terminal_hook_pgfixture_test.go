//go:build pgfixture

// Verifies the terminal lifecycle hook: UpdateSandboxSessionStatus must fire
// the hook exactly on terminal transitions (stopped/error/failed) and never on
// non-terminal ones (running) or on hibernated (a pause, not a stop). This is
// the guarantee that every cell-side terminal transition publishes a `stopped`
// event to D1 — the gap that left create-failed / fork-failed / proxy-worker-
// gone / stop-handler paths billing the edge forever.
//
// Run locally:
//
//	TEST_DATABASE_URL=postgres://user:pass@localhost:5432/dbname?sslmode=disable \
//	  go test -tags=pgfixture ./internal/db/ -run TerminalHook -v
package db

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestTerminalHookFiresOnlyOnTerminalTransitions(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()

	type fired struct {
		sandboxID string
		orgID     uuid.UUID
		status    string
		reason    string
	}
	var mu sync.Mutex
	var events []fired
	store.SetTerminalHook(func(sandboxID string, orgID uuid.UUID, status, reason string) {
		mu.Lock()
		events = append(events, fired{sandboxID, orgID, status, reason})
		mu.Unlock()
	})

	// Fresh org per run isolates state; derive unique sandbox IDs from it so
	// re-runs against the same DB don't collide on the sandbox_id key.
	org := uuid.New()
	pfx := "sb-hook-" + org.String()[:8] + "-"
	cfg := json.RawMessage(`{}`)
	seed := func(sb, status string) {
		if _, err := store.CreateSandboxSessionWithStatus(
			ctx, sb, org, nil, "base", "test", "w-test", cfg, cfg, status, nil); err != nil {
			t.Fatalf("seed %s (%s): %v", sb, status, err)
		}
	}

	// --- terminal transitions: MUST fire ---
	// running -> stopped, running -> error
	for _, status := range []string{"stopped", "error"} {
		sb := pfx + status
		seed(sb, "running")
		if err := store.UpdateSandboxSessionStatus(ctx, sb, status, nil); err != nil {
			t.Fatalf("UpdateSandboxSessionStatus(%s): %v", status, err)
		}
	}
	// pending -> failed (create never succeeded)
	{
		sb := pfx + "failed"
		seed(sb, "pending")
		em := "worker create failed"
		if err := store.UpdateSandboxSessionStatus(ctx, sb, "failed", &em); err != nil {
			t.Fatalf("UpdateSandboxSessionStatus(failed): %v", err)
		}
	}

	// --- non-terminal: MUST NOT fire ---
	// pending -> running (promotion)
	{
		sb := pfx + "running"
		seed(sb, "pending")
		if err := store.UpdateSandboxSessionStatus(ctx, sb, "running", nil); err != nil {
			t.Fatalf("UpdateSandboxSessionStatus(running): %v", err)
		}
	}
	// running -> hibernated (pause, not stop — has its own event path)
	{
		sb := pfx + "hibernated"
		seed(sb, "running")
		if err := store.UpdateSandboxSessionStatus(ctx, sb, "hibernated", nil); err != nil {
			t.Fatalf("UpdateSandboxSessionStatus(hibernated): %v", err)
		}
	}
	// a no-op transition (sandbox not found / wrong precondition) MUST NOT fire
	if err := store.UpdateSandboxSessionStatus(ctx, pfx+"ghost", "stopped", nil); err != nil {
		t.Fatalf("UpdateSandboxSessionStatus(ghost): %v", err)
	}

	mu.Lock()
	defer mu.Unlock()

	byStatus := map[string]fired{}
	for _, e := range events {
		byStatus[e.status] = e
		if e.orgID != org {
			t.Errorf("hook fired with org %s, want %s (sandbox %s)", e.orgID, org, e.sandboxID)
		}
		if e.reason != "session_terminal:"+e.status {
			t.Errorf("hook reason = %q, want %q", e.reason, "session_terminal:"+e.status)
		}
	}

	for _, want := range []string{"stopped", "error", "failed"} {
		if _, ok := byStatus[want]; !ok {
			t.Errorf("expected hook to fire for terminal status %q, but it did not", want)
		}
	}
	for _, notWant := range []string{"running", "hibernated"} {
		if _, ok := byStatus[notWant]; ok {
			t.Errorf("hook fired for non-terminal status %q; it must not", notWant)
		}
	}
	if len(events) != 3 {
		t.Errorf("expected exactly 3 hook fires (stopped/error/failed), got %d: %+v", len(events), events)
	}
}

// A store with no hook wired must not panic on terminal transitions.
func TestTerminalHookUnsetIsSafe(t *testing.T) {
	store := openPgStore(t)
	ctx := context.Background()
	org := uuid.New()
	sb := "sb-nohook-" + org.String()[:8]
	cfg := json.RawMessage(`{}`)
	if _, err := store.CreateSandboxSessionWithStatus(
		ctx, sb, org, nil, "base", "test", "w-test", cfg, cfg, "running", nil); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// onTerminal is nil here — must be a no-op, not a panic.
	if err := store.UpdateSandboxSessionStatus(ctx, sb, "stopped", nil); err != nil {
		t.Fatalf("UpdateSandboxSessionStatus(stopped) with no hook: %v", err)
	}
}
