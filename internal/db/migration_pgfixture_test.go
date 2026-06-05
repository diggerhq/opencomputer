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

func TestReconcileWorkerSessionsSkipsResumable_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)
	orgID := seedOrgWithCap(t, store, 16)
	workerID := "worker-reconcile-resumable"

	resumableID := freshSandboxID("reconcile-resumable")
	hibernatableID := freshSandboxID("reconcile-hibernatable")
	stoppableID := freshSandboxID("reconcile-stoppable")

	if _, err := store.CreateSandboxSession(ctx, resumableID, orgID, nil, "default", "us-east-2", workerID, json.RawMessage(`{"resumable":true}`), json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("create resumable session: %v", err)
	}
	if _, err := store.CreateSandboxSession(ctx, hibernatableID, orgID, nil, "default", "us-east-2", workerID, json.RawMessage(`{}`), json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("create hibernatable session: %v", err)
	}
	if _, _, err := store.CreateHibernation(ctx, hibernatableID, orgID, "s3://checkpoint", 123, "us-east-2", "default", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("create hibernation: %v", err)
	}
	if _, err := store.CreateSandboxSession(ctx, stoppableID, orgID, nil, "default", "us-east-2", workerID, json.RawMessage(`{}`), json.RawMessage(`{}`), nil); err != nil {
		t.Fatalf("create stoppable session: %v", err)
	}

	hibernated, stopped, err := store.ReconcileWorkerSessions(ctx, workerID)
	if err != nil {
		t.Fatalf("reconcile worker sessions: %v", err)
	}
	if !containsOrphan(hibernated, hibernatableID) {
		t.Fatalf("expected hibernatable sandbox to be hibernated, got %#v", hibernated)
	}
	if !containsOrphan(stopped, stoppableID) {
		t.Fatalf("expected stoppable sandbox to be stopped, got %#v", stopped)
	}
	if containsOrphan(hibernated, resumableID) || containsOrphan(stopped, resumableID) {
		t.Fatalf("resumable sandbox should not be reconciled, hibernated=%#v stopped=%#v", hibernated, stopped)
	}

	resumable, err := store.GetSandboxSession(ctx, resumableID)
	if err != nil {
		t.Fatalf("get resumable session: %v", err)
	}
	if resumable.Status != "running" {
		t.Fatalf("expected resumable session to stay running, got %q", resumable.Status)
	}
}

func containsOrphan(rows []OrphanedSandbox, sandboxID string) bool {
	for _, row := range rows {
		if row.SandboxID == sandboxID {
			return true
		}
	}
	return false
}
