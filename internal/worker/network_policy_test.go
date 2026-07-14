package worker

import (
	"context"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

type networkPolicyRecordingManager struct {
	sandbox.Manager
	created *types.SandboxConfig
	forked  *types.SandboxConfig
}

type networkPolicyRecordingMigrator struct {
	LiveMigrator
	prepared types.NetworkPolicy
}

func (m *networkPolicyRecordingMigrator) PreCopyDrives(_ context.Context, _ string, _ *storage.CheckpointStore) (string, string, string, int, int, int, sandbox.MigrationSecrets, error) {
	return "rootfs", "workspace", "golden", 1, 1024, 512, sandbox.MigrationSecrets{NetworkPolicy: "public"}, nil
}

func (m *networkPolicyRecordingMigrator) PrepareIncomingMigration(_ context.Context, _, _, _ string, _, _, _ int, _ string, policy types.NetworkPolicy) (string, int, error) {
	m.prepared = policy
	return "127.0.0.1:1234", 0, nil
}

func (m *networkPolicyRecordingManager) Create(_ context.Context, cfg types.SandboxConfig) (*types.Sandbox, error) {
	m.created = &cfg
	return &types.Sandbox{
		ID:        "sb-test",
		Status:    types.SandboxStatusRunning,
		StartedAt: time.Now(),
		MemoryMB:  cfg.MemoryMB,
	}, nil
}

func (m *networkPolicyRecordingManager) ForkFromCheckpoint(_ context.Context, _ string, cfg types.SandboxConfig) (*types.Sandbox, error) {
	m.forked = &cfg
	return &types.Sandbox{
		ID:        "sb-fork",
		Status:    types.SandboxStatusRunning,
		StartedAt: time.Now(),
		MemoryMB:  cfg.MemoryMB,
	}, nil
}

func TestCreateSandboxPropagatesNetworkPolicy(t *testing.T) {
	t.Parallel()

	manager := &networkPolicyRecordingManager{}
	server := &GRPCServer{manager: manager}
	if _, err := server.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId:      "sb-test",
		MemoryMb:       1024,
		NetworkPolicy:  "public",
		NetworkEnabled: true,
	}); err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}
	if manager.created == nil || manager.created.NetworkPolicy != types.NetworkPolicyPublic {
		t.Fatalf("manager received network policy %#v", manager.created)
	}
}

func TestCheckpointCreatePropagatesNetworkPolicy(t *testing.T) {
	t.Parallel()

	manager := &networkPolicyRecordingManager{}
	server := &GRPCServer{manager: manager}
	if _, err := server.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId:      "sb-fork",
		CheckpointId:   "cp-test",
		MemoryMb:       1024,
		NetworkPolicy:  "public",
		NetworkEnabled: true,
	}); err != nil {
		t.Fatalf("CreateSandbox checkpoint path: %v", err)
	}
	if manager.forked == nil || manager.forked.NetworkPolicy != types.NetworkPolicyPublic {
		t.Fatalf("fork manager received network policy %#v", manager.forked)
	}
}

func TestCreateSandboxRejectsUnknownNetworkPolicy(t *testing.T) {
	t.Parallel()

	manager := &networkPolicyRecordingManager{}
	server := &GRPCServer{manager: manager}
	if _, err := server.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId:     "sb-test",
		NetworkPolicy: "private",
	}); err == nil {
		t.Fatal("CreateSandbox unexpectedly accepted an unknown policy")
	}
	if manager.created != nil || manager.forked != nil {
		t.Fatal("invalid policy reached the sandbox manager")
	}
}

func TestMigrationPropagatesNetworkPolicy(t *testing.T) {
	t.Parallel()

	migrator := &networkPolicyRecordingMigrator{}
	server := &GRPCServer{migrator: migrator}
	preCopy, err := server.PreCopyDrives(context.Background(), &pb.PreCopyDrivesRequest{SandboxId: "sb-test"})
	if err != nil {
		t.Fatalf("PreCopyDrives: %v", err)
	}
	if preCopy.NetworkPolicy != "public" {
		t.Fatalf("pre-copy network policy = %q, want public", preCopy.NetworkPolicy)
	}

	if _, err := server.PrepareMigrationIncoming(context.Background(), &pb.PrepareMigrationIncomingRequest{
		SandboxId:     "sb-test",
		NetworkPolicy: preCopy.NetworkPolicy,
	}); err != nil {
		t.Fatalf("PrepareMigrationIncoming: %v", err)
	}
	if migrator.prepared != types.NetworkPolicyPublic {
		t.Fatalf("prepared policy = %q, want public", migrator.prepared)
	}
}
