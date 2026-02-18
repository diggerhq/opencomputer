package sandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/opensandbox/opensandbox/internal/podman"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// HibernateResult holds the result of a hibernate operation.
type HibernateResult struct {
	SandboxID     string `json:"sandboxId"`
	CheckpointKey string `json:"checkpointKey"`
	SizeBytes     int64  `json:"sizeBytes"`
}

// Hibernate checkpoints a running sandbox, uploads to S3, and removes the container.
func (m *Manager) Hibernate(ctx context.Context, sandboxID string, checkpointStore *storage.CheckpointStore) (*HibernateResult, error) {
	name := m.ContainerName(sandboxID)

	// 1. Trim memory before checkpoint (best-effort)
	m.trimBeforeCheckpoint(ctx, name)

	// 2. Checkpoint to temp file with zstd compression
	tmpDir, err := os.MkdirTemp("", "osb-checkpoint-")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)
	localPath := filepath.Join(tmpDir, "checkpoint.tar.zst")

	if m.podman.UseSSH() {
		// On macOS: checkpoint inside VM, then copy archive to host for S3 upload
		vmPath := fmt.Sprintf("/tmp/osb-checkpoint-%s.tar.zst", sandboxID)
		if err := m.podman.CheckpointContainer(ctx, name, vmPath); err != nil {
			return nil, fmt.Errorf("checkpoint failed for sandbox %s: %w", sandboxID, err)
		}
		defer m.podman.RemoveVMFile(ctx, vmPath)

		if err := m.podman.CopyFromVM(ctx, vmPath, localPath); err != nil {
			return nil, fmt.Errorf("failed to copy checkpoint from VM for sandbox %s: %w", sandboxID, err)
		}
	} else {
		// On Linux: checkpoint directly to local path
		if err := m.podman.CheckpointContainer(ctx, name, localPath); err != nil {
			return nil, fmt.Errorf("checkpoint failed for sandbox %s: %w", sandboxID, err)
		}
	}

	// 3. Upload to S3
	s3Key := storage.CheckpointKey(sandboxID)
	sizeBytes, err := checkpointStore.Upload(ctx, s3Key, localPath)
	if err != nil {
		return nil, fmt.Errorf("failed to upload checkpoint for sandbox %s: %w", sandboxID, err)
	}

	// 4. Remove the container (checkpoint --export already stopped it)
	// Note: timer management now lives in SandboxRouter (caller handles MarkHibernated)
	_ = m.podman.RemoveContainer(ctx, name, true)

	return &HibernateResult{
		SandboxID:     sandboxID,
		CheckpointKey: s3Key,
		SizeBytes:     sizeBytes,
	}, nil
}

// Wake restores a hibernated sandbox from its S3 checkpoint.
// The checkpoint is streamed directly into podman restore.
func (m *Manager) Wake(ctx context.Context, sandboxID string, checkpointKey string, checkpointStore *storage.CheckpointStore, timeout int) (*types.Sandbox, error) {
	name := m.ContainerName(sandboxID)

	// 1. Download checkpoint as a stream from S3
	reader, err := checkpointStore.Download(ctx, checkpointKey)
	if err != nil {
		return nil, fmt.Errorf("failed to download checkpoint for sandbox %s: %w", sandboxID, err)
	}
	defer reader.Close()

	// 2. Stream restore via FIFO
	if err := m.podman.RestoreContainerFromStream(ctx, reader, name); err != nil {
		return nil, fmt.Errorf("failed to restore sandbox %s: %w", sandboxID, err)
	}

	// 3. Get sandbox info (timer management now lives in SandboxRouter; caller handles Register)
	info, err := m.podman.InspectContainer(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("failed to inspect restored sandbox %s: %w", sandboxID, err)
	}

	return containerInfoToSandbox(info), nil
}

// trimBeforeCheckpoint reduces the container's memory footprint before checkpointing.
// Best-effort: errors are ignored since the container may lack permissions.
func (m *Manager) trimBeforeCheckpoint(ctx context.Context, containerName string) {
	trimCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	commands := [][]string{
		{"/bin/sh", "-c", "sync"},
		{"/bin/sh", "-c", "echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true"},
	}

	for _, cmd := range commands {
		_, _ = m.podman.ExecInContainer(trimCtx, podman.ExecConfig{
			Container: containerName,
			Command:   cmd,
		})
	}
}
