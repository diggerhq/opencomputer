package worker

import (
	"context"
	"fmt"
	"testing"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// recordingMigrator implements LiveMigrator and records which prepare path the
// PrepareMigrationIncoming handler chose. Both prepare methods return an error
// so the handler returns right after the gate, before the router/store code.
type recordingMigrator struct {
	withS3        bool
	direct        bool
	gotWorkspace  string
	gotRootfsPath string
}

func (m *recordingMigrator) PrepareIncomingMigration(ctx context.Context, sandboxID, rootfsPath, workspacePath string, cpus, memMB, guestPort int, template string) (string, int, error) {
	m.direct = true
	m.gotRootfsPath = rootfsPath
	return "", 0, fmt.Errorf("stub: direct path")
}

func (m *recordingMigrator) PrepareIncomingMigrationWithS3(ctx context.Context, sandboxID, rootfsS3Key, workspaceS3Key string, cpus, memMB, guestPort int, template string, cs *storage.CheckpointStore, overlayMode bool, sourceGoldenVersion string, secrets sandbox.MigrationSecrets) (string, int, error) {
	m.withS3 = true
	m.gotWorkspace = workspaceS3Key
	return "", 0, fmt.Errorf("stub: s3 path")
}

func (m *recordingMigrator) PreCopyDrives(ctx context.Context, sandboxID string, cs *storage.CheckpointStore) (string, string, string, int, int, int, sandbox.MigrationSecrets, error) {
	return "", "", "", 0, 0, 0, sandbox.MigrationSecrets{}, nil
}
func (m *recordingMigrator) CompleteIncomingMigration(ctx context.Context, sandboxID string) error {
	return nil
}
func (m *recordingMigrator) LiveMigrate(ctx context.Context, sandboxID, incomingAddr string) error {
	return nil
}

// TestPrepareMigrationIncoming_MergedRoutesToS3 is the regression guard for the
// stranded-merged-box incident: a MERGED sandbox has no workspace, so its
// WorkspaceS3Key is empty, but its rootfs IS in S3. It must route to the S3
// path (which carries the real disk), NOT the direct path (which would rebuild
// a blank rootfs from the template base and lose the box's disk). The old gate
// `RootfsS3Key != "" && WorkspaceS3Key != ""` sent merged boxes to the direct
// path — this test would then fail.
func TestPrepareMigrationIncoming_MergedRoutesToS3(t *testing.T) {
	cases := []struct {
		name        string
		rootfsS3    string
		workspaceS3 string
		wantWithS3  bool
	}{
		{"merged (rootfs in S3, no workspace)", "migrations/sb/rootfs.qcow2", "", true},
		{"split (both drives in S3)", "migrations/sb/rootfs.qcow2", "migrations/sb/workspace.qcow2.zst", true},
		{"no S3 keys (genuine direct/local migration)", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := &recordingMigrator{}
			s := &GRPCServer{migrator: m}
			req := &pb.PrepareMigrationIncomingRequest{
				SandboxId:      "sb-test",
				RootfsS3Key:    tc.rootfsS3,
				WorkspaceS3Key: tc.workspaceS3,
				TargetMemoryMb: 0, // 0 skips the capacity guard (no manager set)
			}
			// Migrator stubs return an error, so the handler returns right after
			// the gate — we assert on which path it took, not on success.
			_, _ = s.PrepareMigrationIncoming(context.Background(), req)

			if m.withS3 != tc.wantWithS3 {
				t.Fatalf("withS3=%v, want %v (direct=%v)", m.withS3, tc.wantWithS3, m.direct)
			}
			if tc.wantWithS3 && m.direct {
				t.Fatal("took BOTH paths; expected only the S3 path")
			}
			if !tc.wantWithS3 && !m.direct {
				t.Fatal("expected the direct path, but it was not taken")
			}
			// The merged case specifically must forward the empty workspace key
			// (WithS3 keys `merged := workspaceS3Key == ""` off it).
			if tc.name == "merged (rootfs in S3, no workspace)" && m.gotWorkspace != "" {
				t.Fatalf("merged box forwarded non-empty workspace key %q", m.gotWorkspace)
			}
		})
	}
}
