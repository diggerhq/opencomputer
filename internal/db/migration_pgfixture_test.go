//go:build pgfixture

package db

import (
	"context"
	"encoding/json"
	"testing"
)

func TestCompleteMigrationRecoversPostQMPError_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)
	orgID := seedOrgWithCap(t, store, 16)
	sandboxID := freshSandboxID("recover-post-qmp")

	if _, err := store.CreateSandboxSession(ctx, sandboxID, orgID, nil, "default", "us-east-2", "source-worker", json.RawMessage(`{}`), json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("create sandbox session: %v", err)
	}
	if err := store.SetMigrating(ctx, sandboxID, "first-target"); err != nil {
		t.Fatalf("set migrating: %v", err)
	}
	if err := store.FailMigrationPostQMP(ctx, sandboxID, PostQMPMigrationFailureMessage); err != nil {
		t.Fatalf("fail post-qmp: %v", err)
	}

	if err := store.CompleteMigration(ctx, sandboxID, "second-target"); err != nil {
		t.Fatalf("complete migration should recover post-QMP error: %v", err)
	}

	sess, err := store.GetSandboxSession(ctx, sandboxID)
	if err != nil {
		t.Fatalf("get sandbox session: %v", err)
	}
	if sess.Status != "running" {
		t.Fatalf("expected running, got %q", sess.Status)
	}
	if sess.WorkerID != "second-target" {
		t.Fatalf("expected worker second-target, got %q", sess.WorkerID)
	}
	if sess.MigratingToWorker != "" {
		t.Fatalf("expected migrating_to_worker cleared, got %q", sess.MigratingToWorker)
	}
	if sess.ErrorMsg != nil {
		t.Fatalf("expected error_msg cleared, got %q", *sess.ErrorMsg)
	}
	if sess.StoppedAt != nil {
		t.Fatalf("expected stopped_at cleared, got %s", sess.StoppedAt)
	}
}

func TestCompleteMigrationDoesNotRecoverUnrelatedError_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)
	orgID := seedOrgWithCap(t, store, 16)
	sandboxID := freshSandboxID("unrelated-error")

	if _, err := store.CreateSandboxSession(ctx, sandboxID, orgID, nil, "default", "us-east-2", "source-worker", json.RawMessage(`{}`), json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("create sandbox session: %v", err)
	}
	errMsg := "some unrelated failure"
	if err := store.UpdateSandboxSessionStatus(ctx, sandboxID, "error", &errMsg); err != nil {
		t.Fatalf("mark unrelated error: %v", err)
	}

	if err := store.CompleteMigration(ctx, sandboxID, "second-target"); err == nil {
		t.Fatalf("expected unrelated error row not to recover")
	}

	sess, err := store.GetSandboxSession(ctx, sandboxID)
	if err != nil {
		t.Fatalf("get sandbox session: %v", err)
	}
	if sess.Status != "error" {
		t.Fatalf("expected error status preserved, got %q", sess.Status)
	}
	if sess.WorkerID != "source-worker" {
		t.Fatalf("expected worker source-worker preserved, got %q", sess.WorkerID)
	}
	if sess.ErrorMsg == nil || *sess.ErrorMsg != errMsg {
		t.Fatalf("expected unrelated error message preserved, got %#v", sess.ErrorMsg)
	}
}
