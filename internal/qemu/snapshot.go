package qemu

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/opensandbox/opensandbox/internal/metrics"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/pkg/types"
	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// SnapshotMeta holds metadata persisted alongside snapshot files.
type SnapshotMeta struct {
	SandboxID     string         `json:"sandboxId"`
	Network       *NetworkConfig `json:"network"`
	GuestCID      uint32         `json:"guestCID"`
	GuestMAC      string         `json:"guestMAC"`
	BootArgs      string         `json:"bootArgs"`
	RootfsPath    string         `json:"rootfsPath"`
	WorkspacePath string         `json:"workspacePath"`
	CpuCount      int            `json:"cpuCount"`
	MemoryMB      int            `json:"memoryMB"`
	BaseMemoryMB  int            `json:"baseMemoryMB,omitempty"`
	Template      string         `json:"template"`
	GuestPort        int                 `json:"guestPort"`
	GoldenVersion    string              `json:"goldenVersion,omitempty"`
	// DiskLayout records the block topology this snapshot was captured with
	// (see disk_layout.go). Empty ⇒ split (legacy two-disk), so pre-merge
	// snapshots restore as split. Route through EffectiveDiskLayout on read.
	DiskLayout       string              `json:"diskLayout,omitempty"`
	SnapshotedAt     time.Time           `json:"snapshotedAt,omitempty"`
	SealedTokens     map[string]string   `json:"sealedTokens,omitempty"`
	// SealedNames is the env-var-name → sealed-token index. Persisted alongside
	// SealedTokens so secret-store refresh-by-name (UpdateSecretValue) keeps
	// working after a wake or migration handoff.
	SealedNames      map[string]string   `json:"sealedNames,omitempty"`
	EgressAllowlist  []string            `json:"egressAllowlist,omitempty"`
	TokenHosts       map[string][]string `json:"tokenHosts,omitempty"`
}

// doHibernate pauses a running VM, saves VM state via QMP migrate, and kicks off
// an async S3 upload. QEMU migration produces a single state file (memory + device
// state combined), unlike Firecracker's separate mem + vmstate files.
//
// Flow:
//  1. SyncFS via agent (flush disk buffers — agent stays alive)
//  2. Close gRPC connection (vsock must be inactive for migration)
//  3. QMP stop (pause VM)
//  4. QMP migrate "exec:cat > /path/snapshot/mem" (saves full VM state)
//  5. Poll query-migrate until completed
//  6. QMP quit (kill QEMU process)
//  7. Write snapshot-meta.json
//  8. Clean up network
//  9. (async) Archive snapshot files → tar.zst, upload to S3
func (m *Manager) doHibernate(ctx context.Context, vm *VMInstance, checkpointStore *storage.CheckpointStore) (*sandbox.HibernateResult, error) {
	t0 := time.Now()

	// Deep-hibernating a VM that's in the paused tier: its vCPUs are frozen and
	// guest RAM is paged out. Un-freeze (raw QMP cont — no billing change, both
	// tiers are unbilled) so the guest can quiesce (agent sync) before savevm;
	// the paged-out RAM faults back in as savevm reads it. Handles every deep
	// entrypoint uniformly (idle promotion, emergency, cross-cell cap).
	if !vm.pausedAt.IsZero() && vm.qmp != nil {
		if err := vm.qmp.Cont(); err != nil {
			return nil, fmt.Errorf("hibernate %s: un-pause before savevm: %w", vm.ID, err)
		}
		vm.pausedAt = time.Time{}
	}

	snapshotDir := filepath.Join(vm.sandboxDir, "snapshot")
	if err := os.MkdirAll(snapshotDir, 0755); err != nil {
		return nil, fmt.Errorf("mkdir snapshot dir: %w", err)
	}

	// Step 1: Sync filesystems, quiesce agent, close host conn, and WAIT for
	// the guest to process EOF before savevm. See quiesceAndCloseAgent.
	// Don't unmount /workspace — open FDs prevent clean unmount and cause ext4 corruption.
	//
	// If quiesce fails (agent unresponsive), DO NOT proceed to savevm: the
	// captured qcow2 would carry un-synced page cache + pending EXT4 journal
	// entries and become unbootable on the next cold-mount (inode #2 checksum
	// failure → kernel panic loop). Bubble the error up so the API caller
	// gets a clear refusal instead of a silently-corrupted sandbox.
	if vm.agent != nil {
		// FUSE mounts intentionally are NOT torn down before savevm —
		// loadvm restores them along with the rest of VM memory (including
		// the rclone daemons), so mounts naturally survive hibernate/wake.
		// Two earlier attempts at pre-savevm teardown both wedged the wake
		// path: `pkill -KILL rclone` captured zombie state that loadvm
		// couldn't recover; `fusermount3 -u -z` alone left the in-VM agent
		// unreachable post-loadvm. The "mounts come back on wake" behavior
		// turned out to be the right product semantics anyway — callers can
		// explicitly `mounts.remove` when they want a mount gone.
		if err := quiesceAndCloseAgent(ctx, vm.agent); err != nil {
			log.Printf("qemu: hibernate %s: refusing savevm — %v", vm.ID, err)
			return nil, fmt.Errorf("hibernate %s: %w", vm.ID, err)
		}
		vm.agent = nil
	}
	log.Printf("qemu: hibernate %s: guest sync + unmount done (%dms)", vm.ID, time.Since(t0).Milliseconds())

	// Step 2: savevm — saves memory + device state INTO the qcow2 files.
	// Same mechanism as CreateCheckpoint. On wake, loadvm restores everything
	// including running processes, open files, and memory contents.
	//
	// Explicit Stop() before savevm: although savevm internally pauses and
	// resumes the VM, the explicit pause closes the small race where in-flight
	// virtio-blk writes from the guest can still land in the qcow2 between
	// the agent's `sync` and the start of savevm. Halting vCPUs first makes
	// the captured state strictly post-sync. doHibernate proceeds straight
	// to Quit on success, so leaving the VM in stopped state is fine; only
	// the failure path resumes (so we don't leak a wedged paused VM).
	if vm.qmp == nil {
		return nil, fmt.Errorf("no QMP client for VM %s", vm.ID)
	}
	snapshotName := "hibernate"
	if stopErr := vm.qmp.Stop(); stopErr != nil {
		return nil, fmt.Errorf("qmp stop before savevm: %w", stopErr)
	}
	if err := vm.qmp.SaveVM(snapshotName); err != nil {
		// Resume so we don't leave the VM wedged paused on the error path.
		if contErr := vm.qmp.Cont(); contErr != nil {
			log.Printf("qemu: hibernate %s: failed to resume after savevm failure: %v", vm.ID, contErr)
		}
		// Try to reconnect agent
		if agent, reconnErr := m.waitForAgentSocket(context.Background(), vm.agentSockPath, 5*time.Second); reconnErr == nil {
			vm.agent = agent
		}
		return nil, fmt.Errorf("savevm failed: %w", err)
	}
	log.Printf("qemu: hibernate %s: savevm complete (%dms)", vm.ID, time.Since(t0).Milliseconds())

	// Step 3: Quit QEMU process (snapshot is inside the qcow2 files now)
	_ = vm.qmp.Quit()
	vm.qmp.Close()
	vm.qmp = nil

	if vm.cmd != nil && vm.cmd.Process != nil {
		done := make(chan error, 1)
		go func() { done <- vm.cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			vm.cmd.Process.Kill()
			<-done
		}
	}
	// Brief pause to ensure qcow2 file locks are released after QEMU exit
	time.Sleep(200 * time.Millisecond)

	// Step 4: Write snapshot metadata
	merged := IsMerged(vm.diskLayout)
	workspaceMetaPath := ""
	if !merged {
		workspaceMetaPath = detectDrivePath(vm.sandboxDir, "workspace")
	}
	meta := &SnapshotMeta{
		SandboxID:     vm.ID,
		Network:       vm.network,
		GuestCID:      vm.guestCID,
		GuestMAC:      vm.guestMAC,
		BootArgs:      vm.bootArgs,
		RootfsPath:    detectDrivePath(vm.sandboxDir, "rootfs"),
		WorkspacePath: workspaceMetaPath,
		CpuCount:      vm.CpuCount,
		MemoryMB:      vm.MemoryMB,
		BaseMemoryMB:  vm.baseMemoryMB,
		Template:      vm.Template,
		GuestPort:     vm.GuestPort,
		GoldenVersion: vm.goldenVersion,
		DiskLayout:    vm.diskLayout,
		SnapshotedAt:  time.Now(),
	}

	// Persist secrets proxy state so wake can re-register the session.
	if m.secretsProxy != nil && vm.network != nil {
		meta.SealedTokens = m.secretsProxy.GetSessionTokens(vm.network.GuestIP)
		meta.SealedNames = m.secretsProxy.GetSessionNames(vm.network.GuestIP)
		meta.EgressAllowlist = m.secretsProxy.GetSessionAllowlist(vm.network.GuestIP)
		meta.TokenHosts = m.secretsProxy.GetSessionTokenHosts(vm.network.GuestIP)
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return nil, fmt.Errorf("marshal snapshot meta: %w", err)
	}
	metaPath := filepath.Join(snapshotDir, "snapshot-meta.json")
	// Atomic write: write to temp file then rename to avoid partial JSON on crash
	tmpMetaPath := metaPath + ".tmp"
	if err := os.WriteFile(tmpMetaPath, metaJSON, 0644); err != nil {
		return nil, fmt.Errorf("write snapshot meta: %w", err)
	}
	if err := os.Rename(tmpMetaPath, metaPath); err != nil {
		return nil, fmt.Errorf("rename snapshot meta: %w", err)
	}

	// Step 5: Clean up network
	if vm.network != nil {
		RemoveMetadataDNAT(vm.network.TAPName, vm.network.HostIP)
		RemoveDNAT(vm.network)
		DeleteTAP(vm.network.TAPName)
		m.subnets.Release(vm.network.TAPName)
	}

	if vm.qmpSockPath != "" {
		os.Remove(vm.qmpSockPath)
	}

	// Per-hibernation unique paths. Pre-fix used a single sandbox-scoped
	// `archive-staging/` and `checkpoint.tar.zst`, so back-to-back
	// hibernate→wake→hibernate cycles raced: the second hibernate's
	// copyFileReflink overwrote the first goroutine's staging files mid-tar,
	// and both goroutines wrote the same checkpoint.tar.zst path. End state:
	// neither blob landed in S3, the DB still showed both rows as hibernated,
	// and cross-worker wake failed with "blob: object not found". Including
	// UnixNano in the staging dir name is enough to make the paths unique.
	epochSec := time.Now().Unix()
	checkpointKey := fmt.Sprintf("checkpoints/%s/%d.tar.zst", vm.ID, epochSec)
	localElapsed := time.Since(t0)
	log.Printf("qemu: hibernate %s: local snapshot complete (%dms), starting async S3 upload",
		vm.ID, localElapsed.Milliseconds())

	// Step 9: Archive + upload to S3 in the background.
	// Reflink-copy the qcow2 drives so the archive reads from stable copies
	// while wake can freely open the originals. Without this, wake starts QEMU
	// which modifies the qcow2 files while tar is still reading them →
	// "file changed as we read it" → corrupted archive → data loss on next wake.
	sandboxDir := vm.sandboxDir
	sandboxID := vm.ID
	rootfsFile := filepath.Base(detectDrivePath(sandboxDir, "rootfs"))
	// Merged hibernations archive only the rootfs; split archive both drives.
	driveFiles := []string{rootfsFile}
	if !merged {
		driveFiles = append(driveFiles, filepath.Base(detectDrivePath(sandboxDir, "workspace")))
	}

	archiveDir := filepath.Join(sandboxDir, fmt.Sprintf("archive-staging-%d", time.Now().UnixNano()))
	if err := os.MkdirAll(archiveDir, 0755); err != nil {
		return nil, fmt.Errorf("mkdir archive-staging: %w", err)
	}
	// Copy metadata
	snapshotStaging := filepath.Join(archiveDir, "snapshot")
	os.MkdirAll(snapshotStaging, 0755)
	copyFileReflink(metaPath, filepath.Join(snapshotStaging, "snapshot-meta.json"))

	// Reflink-copy drives (COW — fast, no extra disk until divergence).
	// cp --reflink=auto falls back to regular copy if reflink not supported.
	for _, driveFile := range driveFiles {
		src := filepath.Join(sandboxDir, driveFile)
		dst := filepath.Join(archiveDir, driveFile)
		if err := copyFileReflink(src, dst); err != nil {
			os.RemoveAll(archiveDir)
			return nil, fmt.Errorf("copy %s for archive staging: %w", driveFile, err)
		}
	}
	// Flatten staged rootfs for S3 portability — the qcow2 overlay references a
	// local backing file (base ext4 image) that won't exist on other workers.
	// `qemu-img rebase -b ""` merges backing file data into the overlay, making it
	// self-contained while preserving internal savevm snapshots (unlike qemu-img convert).
	stagedRootfs := filepath.Join(archiveDir, rootfsFile)
	rebaseCmd := exec.Command("qemu-img", "rebase", "-b", "", stagedRootfs)
	if out, err := rebaseCmd.CombinedOutput(); err != nil {
		log.Printf("qemu: hibernate %s: rootfs rebase failed (archive may not be portable): %v (%s)",
			sandboxID, err, strings.TrimSpace(string(out)))
	}
	log.Printf("qemu: hibernate %s: archive staging ready (dir=%s)", sandboxID, filepath.Base(archiveDir))

	// Signal channel so destroyVM can wait for archive completion before deleting files.
	archiveDone := make(chan struct{})
	vm.archiveDone = archiveDone

	uploadCb := m.onHibernationUpload
	m.uploadWg.Add(1)
	go func() {
		defer m.uploadWg.Done()
		defer close(archiveDone)
		defer os.RemoveAll(archiveDir) // clean up staging copies when done

		var sizeBytes int64
		var goroutineErr error
		defer func() {
			if uploadCb != nil {
				uploadCb(sandboxID, checkpointKey, sizeBytes, goroutineErr)
			}
		}()

		t1 := time.Now()
		// Tar lives inside the per-hibernation staging dir so concurrent
		// hibernations of the same sandbox don't write to the same path.
		archivePath := filepath.Join(archiveDir, "checkpoint.tar.zst")

		// Archive from the staging copies — originals are free for wake/QEMU.
		if err := createArchive(archivePath, archiveDir, append([]string{
			"snapshot/snapshot-meta.json",
		}, driveFiles...)); err != nil {
			goroutineErr = fmt.Errorf("archive: %w", err)
			log.Printf("qemu: async archive failed for %s: %v", sandboxID, err)
			return
		}
		archiveInfo, err := os.Stat(archivePath)
		if err != nil {
			goroutineErr = fmt.Errorf("stat archive: %w", err)
			log.Printf("qemu: async archive stat failed for %s: %v", sandboxID, err)
			return
		}
		sizeBytes = archiveInfo.Size()
		log.Printf("qemu: hibernate %s: archive created (%dms, %.1f MB)",
			sandboxID, time.Since(t1).Milliseconds(), float64(sizeBytes)/(1024*1024))

		t2 := time.Now()
		uploadCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, err := checkpointStore.Upload(uploadCtx, checkpointKey, archivePath); err != nil {
			goroutineErr = fmt.Errorf("upload: %w", err)
			log.Printf("qemu: async S3 upload failed for %s: %v", sandboxID, err)
			return // archiveDir cleanup via defer takes the tar with it
		}
		log.Printf("qemu: hibernate %s: S3 upload complete (%dms, key=%s)",
			sandboxID, time.Since(t2).Milliseconds(), checkpointKey)
	}()

	return &sandbox.HibernateResult{
		SandboxID:      sandboxID,
		HibernationKey: checkpointKey,
		SizeBytes:      0,
	}, nil
}

// doWake restores a VM from a savevm snapshot. Uses the same mechanism as
// ForkFromCheckpoint: start QEMU paused, loadvm from the qcow2 files, cont.
// All processes, memory, open files, and PIDs are restored exactly.
//
// Flow:
//  1. Ensure qcow2 files are local (download from S3 if needed)
//  2. Read snapshot-meta.json
//  3. Set up network (TAP, DNAT)
//  4. Start QEMU paused (-S) with the user's qcow2 drives
//  5. loadvm "hibernate" → restores full VM state from qcow2
//  6. cont → VM resumes with all processes alive
//  7. Agent reconnects via virtio-serial
//  8. Mount /workspace, patch network, sync clock
func (m *Manager) doWake(ctx context.Context, sandboxID, checkpointKey string, checkpointStore *storage.CheckpointStore, timeout int) (*types.Sandbox, error) {
	sandboxDir := filepath.Join(m.cfg.DataDir, "sandboxes", sandboxID)
	snapshotDir := filepath.Join(sandboxDir, "snapshot")
	metaPath := filepath.Join(snapshotDir, "snapshot-meta.json")

	// Per-hibernation archive staging dirs are named `archive-staging-<nano>` and
	// each goroutine cleans up its own dir via defer. Wake doesn't need the
	// archive (same-worker uses local qcow2; cross-worker downloads from S3),
	// so there is nothing to wait for here. Pre-fix this loop watched a single
	// fixed `archive-staging/` path — irrelevant under the new scheme.

	// Step 1: Ensure qcow2 files are local
	t0 := time.Now()
	rootfsPath := detectDrivePath(sandboxDir, "rootfs")
	rootfsExists := fileExists(rootfsPath)

	isLocalWorkspace := strings.HasPrefix(checkpointKey, "local://")

	if !rootfsExists {
		if isLocalWorkspace {
			log.Printf("qemu: wake %s: local workspace recovery (no snapshot)", sandboxID)
			return m.coldBootLocal(ctx, sandboxID, timeout)
		}
		log.Printf("qemu: wake %s: local files missing, downloading from S3 (key=%s)", sandboxID, checkpointKey)
		if err := os.MkdirAll(sandboxDir, 0755); err != nil {
			return nil, fmt.Errorf("mkdir sandbox dir: %w", err)
		}
		if err := os.MkdirAll(snapshotDir, 0755); err != nil {
			return nil, fmt.Errorf("mkdir snapshot dir: %w", err)
		}

		archiveData, err := checkpointStore.Download(ctx, checkpointKey)
		if err != nil {
			return nil, fmt.Errorf("download checkpoint: %w", err)
		}

		archivePath := filepath.Join(sandboxDir, "checkpoint.tar.zst")
		archiveFile, err := os.Create(archivePath)
		if err != nil {
			archiveData.Close()
			return nil, fmt.Errorf("create archive file: %w", err)
		}
		if _, err := io.Copy(archiveFile, archiveData); err != nil {
			archiveFile.Close()
			archiveData.Close()
			return nil, fmt.Errorf("write archive: %w", err)
		}
		archiveFile.Close()
		archiveData.Close()

		log.Printf("qemu: wake %s: downloaded archive (%dms)", sandboxID, time.Since(t0).Milliseconds())
		if err := extractArchive(archivePath, sandboxDir); err != nil {
			return nil, fmt.Errorf("extract archive: %w", err)
		}
		os.Remove(archivePath)
		log.Printf("qemu: wake %s: extracted (%dms total)", sandboxID, time.Since(t0).Milliseconds())
		rootfsPath = detectDrivePath(sandboxDir, "rootfs")
	} else {
		log.Printf("qemu: wake %s: local files found", sandboxID)
	}

	// Step 2: Read snapshot metadata
	metaJSON, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("read snapshot meta: %w", err)
	}
	var meta SnapshotMeta
	if err := json.Unmarshal(metaJSON, &meta); err != nil {
		return nil, fmt.Errorf("parse snapshot meta: %w", err)
	}

	// Merged snapshots have no workspace disk; workspacePath stays "" so the
	// woken QEMU reconstructs the single-disk device model captured in the
	// savevm state. Split snapshots must still have their workspace present.
	var workspacePath string
	if !IsMerged(meta.DiskLayout) {
		workspacePath = detectDrivePath(sandboxDir, "workspace")
		if !fileExists(workspacePath) {
			return nil, fmt.Errorf("workspace not found at %s", workspacePath)
		}
	}

	// Step 3: Set up network. Prefer the original TAP/subnet so the gateway
	// IP remains stable across hibernate→wake cycles. The VM's HTTPS_PROXY
	// env var was baked at create time pointing at the original gateway IP
	// (e.g. 172.16.0.1). If wake reallocates a fresh subnet, the env still
	// points at the stale gateway and every outbound HTTPS through the
	// secrets proxy times out — silent breakage of the entire proxy path
	// for any sandbox with a secret store.
	//
	// Fall back to a fresh allocation if the original block was claimed by a
	// different sandbox while this one was hibernated. The fallback path
	// will leave HTTPS_PROXY stale, so log a clear warning — operators who
	// see this in journal know why post-wake outbound HTTPS is broken.
	var netCfg *NetworkConfig
	if meta.Network != nil && meta.Network.TAPName != "" {
		netCfg, err = m.subnets.AllocateSpecific(meta.Network.TAPName)
		if err != nil {
			log.Printf("qemu: wake %s: original TAP %q unavailable (%v) — falling back to fresh subnet; HTTPS_PROXY env will be stale, outbound HTTPS through proxy will fail until sandbox is recreated",
				sandboxID, meta.Network.TAPName, err)
		}
	}
	if netCfg == nil {
		netCfg, err = m.subnets.Allocate()
		if err != nil {
			return nil, fmt.Errorf("allocate subnet: %w", err)
		}
	}
	if err := CreateTAP(netCfg); err != nil {
		m.subnets.Release(netCfg.TAPName)
		return nil, fmt.Errorf("create TAP: %w", err)
	}

	hostPort, err := FindFreePort()
	if err != nil {
		DeleteTAP(netCfg.TAPName)
		m.subnets.Release(netCfg.TAPName)
		return nil, fmt.Errorf("find free port: %w", err)
	}
	netCfg.HostPort = hostPort
	netCfg.GuestPort = meta.GuestPort
	if netCfg.GuestPort == 0 {
		netCfg.GuestPort = 80
	}

	if err := AddDNAT(netCfg); err != nil {
		DeleteTAP(netCfg.TAPName)
		m.subnets.Release(netCfg.TAPName)
		return nil, fmt.Errorf("add DNAT: %w", err)
	}
	if err := AddMetadataDNAT(netCfg.TAPName, netCfg.HostIP); err != nil {
		log.Printf("qemu: warning: metadata DNAT failed: %v", err)
	}

	// Step 4: Start QEMU paused with the user's qcow2 drives
	guestCID := m.allocateCID()
	guestMAC := generateMAC(sandboxID)
	baseMem := meta.BaseMemoryMB
	if baseMem <= 0 {
		baseMem = m.cfg.DefaultMemoryMB
	}
	bootArgs := fmt.Sprintf(
		"console=ttyS0 reboot=k panic=1 "+
			"root=/dev/vda rw "+
			"ip=%s::%s:%s::eth0:off "+
			"init=/sbin/init "+
			"osb.gateway=%s",
		netCfg.GuestIP, netCfg.HostIP, netCfg.Mask, netCfg.HostIP,
	)

	qmpSockPath := filepath.Join(sandboxDir, "qmp.sock")
	agentSockPath := filepath.Join(sandboxDir, "agent.sock")
	os.Remove(qmpSockPath)
	os.Remove(agentSockPath)

	logPath := filepath.Join(sandboxDir, "qemu.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("create log: %w", err)
	}

	args := m.buildQEMUArgs(meta.CpuCount, baseMem, rootfsPath, workspacePath,
		netCfg.TAPName, guestMAC, agentSockPath, qmpSockPath, bootArgs)
	args = append(args, "-S") // start paused for loadvm

	cmd := exec.Command(m.cfg.QEMUBin, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("start qemu: %w", err)
	}
	logFile.Close()

	// Step 5: Connect QMP, loadvm, cont — same as RestoreFromCheckpoint
	qmpClient, err := waitForQMP(qmpSockPath, 30*time.Second)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("QMP connect: %w", err)
	}

	if err := qmpClient.LoadVM("hibernate"); err != nil {
		// loadvm failed — fall back to cold boot
		log.Printf("qemu: wake %s: loadvm failed (%v), falling back to cold boot", sandboxID, err)
		qmpClient.Close()
		cmd.Process.Kill()
		cmd.Wait()
		m.cleanupVM(netCfg, "")
		return m.coldBootLocal(ctx, sandboxID, timeout)
	}

	// Re-plug virtio-mem to match the pre-hibernate total BEFORE Cont. The VM
	// is paused, so the kernel sees the full memory map immediately on resume
	// — without this, restored processes that were using more than baseMem
	// OOM before any post-resume scale could land. Mirrors the
	// RestoreFromCheckpoint path (manager.go:2536). Also keeps host-side
	// accounting honest: vm.MemoryMB stays equal to what's actually plugged,
	// not the ceiling, so TotalCommittedMemoryMB reflects reality.
	pluggedMB := 0
	if meta.MemoryMB > baseMem {
		additionalMB := alignVirtioMemBlock(meta.MemoryMB - baseMem)
		if err := qmpClient.SetVirtioMemSize(additionalMB); err != nil {
			log.Printf("qemu: wake %s: pre-resume virtio-mem plug to %dMB failed: %v (continuing with base %dMB)",
				sandboxID, additionalMB, err, baseMem)
		} else {
			pluggedMB = additionalMB
			log.Printf("qemu: wake %s: pre-resume virtio-mem plug %dMB (base=%d, total=%d)",
				sandboxID, additionalMB, baseMem, baseMem+additionalMB)
		}
	}

	if err := qmpClient.Cont(); err != nil {
		qmpClient.Close()
		cmd.Process.Kill()
		cmd.Wait()
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("QMP cont: %w", err)
	}
	log.Printf("qemu: wake %s: loadvm + cont done (%dms)", sandboxID, time.Since(t0).Milliseconds())

	// Step 6: Reconnect agent + mount workspace + patch network
	agentClient, err := m.waitForAgentSocket(context.Background(), agentSockPath, 10*time.Second)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("agent not ready: %w", err)
	}

	// Unfreeze the guest filesystems that prepareAgentForHibernate froze
	// before savevm. MUST run before verifyWakeIntegrity (whose drop_caches
	// and exec calls write to the fs) and before any customer traffic.
	m.agentFsThawAfterWake(context.Background(), sandboxID, agentClient)

	// Verify the wake didn't land in a savevm/loadvm-corrupted state (see
	// verifyWakeIntegrity docstring + 2026-05-19 incident analysis). If the
	// ext4 metadata_csum corruption signature is present, every subsequent
	// fork/exec inside the VM will hit EBADMSG once dentries evict — the
	// sandbox is effectively dead, the customer sees "command not found".
	// In that case, tear down + cold-boot the same qcow2: customer keeps
	// their workspace files but loses running process state.
	if err := m.verifyWakeIntegrity(context.Background(), sandboxID, agentClient); err != nil {
		log.Printf("qemu: wake %s: %v — falling back to cold boot", sandboxID, err)
		metrics.WakeRecoveryTotal.WithLabelValues(m.cfg.Region, "detected").Inc()
		log.Printf("wake-metric: outcome=corruption-detected sandbox=%s", sandboxID)
		_ = agentClient.Close()
		qmpClient.Close()
		cmd.Process.Kill()
		cmd.Wait()
		m.cleanupVM(netCfg, "")
		return m.recoverCorruptWake(ctx, sandboxID, timeout)
	}

	// Hibernate captured the guest with its mount state intact (we never
	// unmount before savevm), so loadvm restores the correct mount layout
	// automatically. Do NOT blindly mount /dev/vdb on /home/sandbox here:
	// cold-booted VMs have their workspace disk mounted at /workspace per the
	// guest's fstab, with /home/sandbox being a regular directory on the
	// rootfs. If we force-mount /dev/vdb over /home/sandbox post-wake, we
	// shadow any files the user wrote to /home/sandbox (which live on the
	// rootfs qcow2) with the empty workspace qcow2 view, silently losing
	// their data.

	if err := patchGuestNetwork(context.Background(), agentClient, netCfg); err != nil {
		log.Printf("qemu: wake %s: network patch failed: %v", sandboxID, err)
	}

	if err := syncGuestClock(context.Background(), agentClient); err != nil {
		log.Printf("qemu: wake %s: clock sync failed: %v", sandboxID, err)
	}

	// Re-register secrets proxy session from persisted tokens. An allowlist
	// alone is enough — without a session the proxy 407s every request.
	if m.secretsProxy != nil && (len(meta.SealedTokens) > 0 || len(meta.EgressAllowlist) > 0) {
		m.secretsProxy.ReregisterSession(sandboxID, netCfg.GuestIP, meta.SealedTokens, meta.EgressAllowlist, meta.TokenHosts, meta.SealedNames)
		log.Printf("qemu: wake %s: re-registered secrets proxy session (%d tokens, %d allowlist, %d names)", sandboxID, len(meta.SealedTokens), len(meta.EgressAllowlist), len(meta.SealedNames))
	}
	// Refresh the proxy CA in the guest's trust store. Wake may land on a
	// different worker than the one that hibernated the sandbox, in which
	// case the cert in the guest's trust store no longer matches what this
	// worker's proxy presents. Idempotent on same-worker wake.
	m.reinstallProxyCA(context.Background(), sandboxID, agentClient)

	// Re-apply the apt-cache bind-mount. Idempotent: no-op if already in place
	// (e.g., same-worker wake where the loadvm-restored mount table preserved
	// the bind). On cross-worker wake or sandboxes that pre-date this fix,
	// this is the first chance to set it up.
	m.setupAptCacheBindMount(context.Background(), sandboxID, agentClient)

	log.Printf("qemu: wake %s: golden restore complete (port=%d, tap=%s)",
		sandboxID, hostPort, netCfg.TAPName)

	now := time.Now()
	ttl := time.Duration(timeout) * time.Second
	if ttl <= 0 {
		ttl = 300 * time.Second
	}

	vm := &VMInstance{
		ID:                   sandboxID,
		Template:             meta.Template,
		Status:               types.SandboxStatusRunning,
		StartedAt:            now,
		EndAt:                now.Add(ttl),
		CpuCount:             meta.CpuCount,
		MemoryMB:             baseMem + pluggedMB, // actually-plugged total, not the ceiling — keeps committed accounting honest
		baseMemoryMB:         baseMem,
		virtioMemRequestedMB: pluggedMB,
		HostPort:             hostPort,
		GuestPort:             netCfg.GuestPort,
		pid:           cmd.Process.Pid,
		cmd:           cmd,
		network:       netCfg,
		sandboxDir:    sandboxDir,
		qmpSockPath:   qmpSockPath,
		agentSockPath: agentSockPath,
		qmp:           qmpClient,
		guestMAC:      guestMAC,
		guestCID:      guestCID,
		bootArgs:      bootArgs,
		goldenVersion: m.goldenVersion, // set on wake — VM runs on the current worker's base
		diskLayout:    EffectiveDiskLayout(meta.DiskLayout),
	}
	// Recompute virtio-mem amount from the meta. Without this the field
	// stays at zero on wake, which would (a) make grow deltas under-charge
	// the host capacity check and (b) make the shrink-OOM-floor in
	// SetResourceLimits silently no-op since `additional == requested == 0`
	// is treated as "no change" and skips the check entirely.
	if meta.MemoryMB > baseMem {
		vm.virtioMemRequestedMB = meta.MemoryMB - baseMem
	}
	vm.agent = agentClient

	// Agent binary updates happen via qemu-img rebase of the rootfs, not via
	// runtime re-exec. See the "Runtime agent upgrade" comment in manager.go
	// for the rationale.

	m.mu.Lock()
	m.vms[sandboxID] = vm
	m.mu.Unlock()

	// Notify metadata server
	if m.onSandboxReady != nil {
		m.onSandboxReady(sandboxID, netCfg.GuestIP, vm.Template, vm.StartedAt)
	}

	log.Printf("qemu: woke VM %s (port=%d, tap=%s)",
		sandboxID, hostPort, netCfg.TAPName)
	return vmToSandbox(vm), nil
}

// recoverCorruptWake recovers a sandbox whose loadvm restore tripped the
// wake-integrity check. Two-stage, matching where the corruption can live:
//
//  1. Cold boot from the existing disks. A fresh kernel with a clean page
//     cache recovers the memory-only corruption case, and keeps everything
//     the customer installed on the rootfs (apt packages etc.).
//  2. If the cold-booted guest ALSO fails the integrity probe, the rootfs is
//     structurally corrupt on disk (e2fsck-confirmed failure mode: savevm
//     persisted bad ext4 metadata). Discard the rootfs and cold-boot again —
//     coldBootLocal recreates it from the template base. The workspace disk
//     survives (it carries the customer's /workspace files and has been clean
//     in every observed instance); the rootfs is golden-derived OS state, so
//     losing it costs installed packages, not workspace data. Discarding the
//     rootfs also discards the corrupt savevm snapshot embedded in the qcow2,
//     which is what previously kept wake retries looping on the same bad
//     restore forever.
func (m *Manager) recoverCorruptWake(ctx context.Context, sandboxID string, timeout int) (*types.Sandbox, error) {
	log.Printf("qemu: recover %s: stage 1 — cold boot from existing disks", sandboxID)
	sb, err := m.coldBootLocal(ctx, sandboxID, timeout)
	if err == nil {
		m.mu.RLock()
		vm := m.vms[sandboxID]
		m.mu.RUnlock()
		var agent *AgentClient
		if vm != nil {
			agent = vm.agent
		}
		if verr := m.verifyWakeIntegrity(ctx, sandboxID, agent); verr == nil {
			log.Printf("qemu: recover %s: stage 1 succeeded (memory-only corruption; rootfs kept)", sandboxID)
			metrics.WakeRecoveryTotal.WithLabelValues(m.cfg.Region, "recovered_stage1").Inc()
			log.Printf("wake-metric: outcome=recovered stage=1 sandbox=%s", sandboxID)
			return sb, nil
		}
		log.Printf("qemu: recover %s: cold boot from existing rootfs still fails integrity — rootfs is corrupt on disk", sandboxID)
		if kerr := m.Kill(ctx, sandboxID); kerr != nil {
			log.Printf("qemu: recover %s: kill stage-1 VM: %v (continuing)", sandboxID, kerr)
		}
	} else {
		log.Printf("qemu: recover %s: stage 1 cold boot failed: %v — escalating to rootfs rebuild", sandboxID, err)
	}

	// Stage 2: discard the corrupt rootfs (and the bad savevm inside it);
	// coldBootLocal rebuilds it from the template base image.
	sandboxDir := filepath.Join(m.cfg.DataDir, "sandboxes", sandboxID)
	rootfsPath := detectDrivePath(sandboxDir, "rootfs")
	if fileExists(rootfsPath) {
		if rerr := os.Remove(rootfsPath); rerr != nil {
			metrics.WakeRecoveryTotal.WithLabelValues(m.cfg.Region, "failed").Inc()
			log.Printf("wake-metric: outcome=recovery-failed sandbox=%s err=%q", sandboxID, rerr.Error())
			return nil, fmt.Errorf("recover %s: remove corrupt rootfs: %w", sandboxID, rerr)
		}
		log.Printf("qemu: recover %s: stage 2 — discarded corrupt rootfs %s (workspace kept; installed packages lost)", sandboxID, rootfsPath)
	}
	sb, err = m.coldBootLocal(ctx, sandboxID, timeout)
	if err != nil {
		metrics.WakeRecoveryTotal.WithLabelValues(m.cfg.Region, "failed").Inc()
		log.Printf("wake-metric: outcome=recovery-failed sandbox=%s err=%q", sandboxID, err.Error())
		return nil, fmt.Errorf("recover %s: cold boot after rootfs rebuild: %w", sandboxID, err)
	}
	log.Printf("qemu: recover %s: stage 2 succeeded — rootfs rebuilt from template, workspace intact", sandboxID)
	metrics.WakeRecoveryTotal.WithLabelValues(m.cfg.Region, "recovered_stage2").Inc()
	log.Printf("wake-metric: outcome=recovered stage=2 sandbox=%s", sandboxID)
	return sb, nil
}

// coldBootLocal boots a fresh VM using an existing workspace.ext4 on disk.
// Thin logging wrapper: this is the recovery path of last resort, so both its
// start and any failure must be visible in the journal — a silent error here
// previously left wake failures looping with no trace of why the fallback
// never produced a VM.
// recoveryColdBootAgentWait is how long a recovery cold boot waits for the
// in-VM agent before giving up. Deliberately longer than the normal 30s boot
// wait: every coldBootLocal caller is a recovery/fallback path, and a
// premature timeout here escalates to a destructive rootfs rebuild.
const recoveryColdBootAgentWait = 90 * time.Second

func (m *Manager) coldBootLocal(ctx context.Context, sandboxID string, timeout int) (*types.Sandbox, error) {
	log.Printf("qemu: cold-boot-local %s: starting", sandboxID)
	sb, err := m.coldBootLocalInner(ctx, sandboxID, timeout)
	if err != nil {
		log.Printf("qemu: cold-boot-local %s: FAILED: %v", sandboxID, err)
	}
	return sb, err
}

// guestBootMarker is the last line the in-guest init prints before the agent
// starts accepting. Its presence means the guest reached a healthy userspace;
// its ABSENCE after an agent timeout means the guest never finished booting.
const guestBootMarker = "cgroup sandbox ready"

// classifyGuestBoot inspects a VM's qemu serial log after an agent-connect
// timeout to tell apart three cases, so the caller can retry safely and only
// fail-fast on deterministic corruption:
//
//   - booted=true: the guest reached healthy userspace (guestBootMarker present).
//     The agent socket just wasn't ready in time — a transient virtio-serial
//     flake. Caller should RETRY. Precedence matters: a booted guest is never
//     flagged as a failure even if an earlier, survived kernel message matches a
//     signature (else we'd suppress a legitimate retry).
//   - booted=false, sig!="": the guest did NOT boot AND an explicit kernel/init
//     failure signature is present — deterministic (a rootfs rebased onto the
//     wrong base golden can't mount root or exec init). Caller should FAIL FAST
//     with an actionable error; retrying the same boot is pointless.
//   - booted=false, sig=="": the guest didn't reach the marker but printed no
//     explicit failure — ambiguous (e.g. an unusually slow cold boot). Caller
//     should keep the normal RETRY path; we only log the tail for diagnosis.
//
// tail is the last serial lines, for the worker log.
func classifyGuestBoot(sandboxDir string) (booted bool, sig, tail string) {
	data, err := os.ReadFile(filepath.Join(sandboxDir, "qemu.log"))
	if err != nil {
		return false, "", ""
	}
	s := string(data)
	tail = lastLines(s, 12)

	// Reaching the in-guest init's ready marker means userspace came up healthy,
	// whatever transient messages appeared earlier — treat as a bootable guest.
	if strings.Contains(s, guestBootMarker) {
		return true, "", tail
	}
	// Guest did not finish booting — look for an explicit failure signature
	// (rootfs mount failure from metadata corruption, or an init-exec failure
	// from corrupt base binaries) to classify it as deterministic.
	for _, m := range []string{
		"Unable to mount root fs",
		"Cannot open root device",
		"unable to read superblock",
		"EXT4-fs error",
		"Attempted to kill init",
		"No working init found",
		"Failed to execute",
		"Kernel panic",
		"segfault",
	} {
		if strings.Contains(s, m) {
			return false, m, tail
		}
	}
	return false, "", tail
}

// lastLines returns up to n trailing non-empty lines of s.
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	out := make([]string, 0, n)
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			out = append([]string{lines[i]}, out...)
		}
	}
	return strings.Join(out, "\n")
}

func (m *Manager) coldBootLocalInner(ctx context.Context, sandboxID string, timeout int) (*types.Sandbox, error) {
	sandboxDir := filepath.Join(m.cfg.DataDir, "sandboxes", sandboxID)
	rootfsPath := detectDrivePath(sandboxDir, "rootfs")

	// Determine the disk layout from the snapshot meta (authoritative). A merged
	// sandbox has no workspace disk to require or attach; workspacePath stays "".
	merged := false
	if snapJSON, err := os.ReadFile(filepath.Join(sandboxDir, "snapshot", "snapshot-meta.json")); err == nil {
		var sm SnapshotMeta
		if json.Unmarshal(snapJSON, &sm) == nil {
			merged = IsMerged(sm.DiskLayout)
		}
	}

	var workspacePath string
	if !merged {
		workspacePath = detectDrivePath(sandboxDir, "workspace")
		if !fileExists(workspacePath) {
			return nil, fmt.Errorf("workspace not found at %s", workspacePath)
		}
	}

	// Resolve the sandbox config. The create-time sandbox-meta.json lives only
	// on the worker that created the sandbox and is NOT included in the
	// hibernate archive, so on a cross-worker recovery cold boot (the common
	// case after a worker roll) it's absent. Fall back to snapshot-meta.json,
	// which IS in the archive and carries the same template/cpu/mem/port.
	// Without this fallback, recovering a corrupted wake on any worker other
	// than the creator fails with "read sandbox-meta.json: no such file".
	var meta SandboxMeta
	sbMetaPath := filepath.Join(sandboxDir, "sandbox-meta.json")
	if metaJSON, readErr := os.ReadFile(sbMetaPath); readErr == nil {
		if err := json.Unmarshal(metaJSON, &meta); err != nil {
			return nil, fmt.Errorf("parse sandbox-meta.json: %w", err)
		}
	} else {
		snapPath := filepath.Join(sandboxDir, "snapshot", "snapshot-meta.json")
		snapJSON, snapErr := os.ReadFile(snapPath)
		if snapErr != nil {
			return nil, fmt.Errorf("read sandbox-meta.json: %w (snapshot-meta.json fallback also failed: %v)", readErr, snapErr)
		}
		var snap SnapshotMeta
		if err := json.Unmarshal(snapJSON, &snap); err != nil {
			return nil, fmt.Errorf("parse snapshot-meta.json (sandbox-meta.json fallback): %w", err)
		}
		meta = SandboxMeta{
			SandboxID: sandboxID,
			Template:  snap.Template,
			CpuCount:  snap.CpuCount,
			MemoryMB:  snap.MemoryMB,
			GuestPort: snap.GuestPort,
		}
		log.Printf("qemu: cold-boot-local %s: sandbox-meta.json absent — recovered config from snapshot-meta.json (template=%q, mem=%dMB, cpu=%d)",
			sandboxID, meta.Template, meta.MemoryMB, meta.CpuCount)
	}
	// Normalize "base" (the default template alias) to "default" so cold-boot
	// recovery resolves the on-disk base (default.ext4) — matching
	// createFromGolden. Without the "base" case, ResolveBaseImage looked for a
	// nonexistent base.ext4 and this recovery hard-failed the wake.
	if meta.Template == "" || meta.Template == "base" {
		meta.Template = "default"
	}

	if !fileExists(rootfsPath) {
		// PrepareRootfs emits a qcow2 overlay, so the rebuilt rootfs must land
		// at rootfs.qcow2 — otherwise detectDrivePath's .ext4 fallback (which
		// fires once stage-2 recovery has discarded rootfs.qcow2) names the
		// qcow2 file rootfs.ext4, and buildQEMUArgs then attaches it as raw.
		// The guest kernel reads the qcow2 header as the filesystem, fails to
		// mount root, and the agent never comes up (30s socket timeout).
		rootfsPath = filepath.Join(sandboxDir, "rootfs.qcow2")
		baseImage, err := ResolveBaseImage(m.cfg.ImagesDir, meta.Template)
		if err != nil {
			return nil, fmt.Errorf("resolve base image: %w", err)
		}
		if err := PrepareRootfs(baseImage, rootfsPath); err != nil {
			return nil, fmt.Errorf("prepare rootfs: %w", err)
		}
		log.Printf("qemu: cold-boot-local %s: rootfs recreated from template %q", sandboxID, meta.Template)
	}

	netCfg, err := m.subnets.Allocate()
	if err != nil {
		return nil, fmt.Errorf("allocate subnet: %w", err)
	}
	if err := CreateTAP(netCfg); err != nil {
		m.subnets.Release(netCfg.TAPName)
		return nil, fmt.Errorf("create TAP: %w", err)
	}

	hostPort, err := FindFreePort()
	if err != nil {
		DeleteTAP(netCfg.TAPName)
		m.subnets.Release(netCfg.TAPName)
		return nil, fmt.Errorf("find free port: %w", err)
	}
	guestPort := meta.GuestPort
	if guestPort == 0 {
		guestPort = 80
	}
	netCfg.HostPort = hostPort
	netCfg.GuestPort = guestPort

	if err := AddDNAT(netCfg); err != nil {
		DeleteTAP(netCfg.TAPName)
		m.subnets.Release(netCfg.TAPName)
		return nil, fmt.Errorf("add DNAT: %w", err)
	}

	// Add metadata service DNAT (169.254.169.254:80 → host:8888)
	if err := AddMetadataDNAT(netCfg.TAPName, netCfg.HostIP); err != nil {
		log.Printf("qemu: warning: metadata DNAT failed for %s: %v", netCfg.TAPName, err)
	}

	cpus := meta.CpuCount
	if cpus <= 0 {
		cpus = m.cfg.DefaultCPUs
	}
	memMB := meta.MemoryMB
	if memMB <= 0 {
		memMB = m.cfg.DefaultMemoryMB
	}

	guestCID := m.allocateCID()
	guestMAC := generateMAC(sandboxID)
	bootArgs := fmt.Sprintf(
		"console=ttyS0 reboot=k panic=1 "+
			"root=/dev/vda rw "+
			"ip=%s::%s:%s::eth0:off "+
			"init=/sbin/init "+
			"osb.gateway=%s",
		netCfg.GuestIP, netCfg.HostIP, netCfg.Mask, netCfg.HostIP,
	)

	qmpSockPath := filepath.Join(sandboxDir, "qmp.sock")
	os.Remove(qmpSockPath)
	agentSockPath := filepath.Join(sandboxDir, "agent.sock")
	os.Remove(agentSockPath)

	logPath := filepath.Join(sandboxDir, "qemu.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("create log file: %w", err)
	}

	args := m.buildQEMUArgs(cpus, memMB, rootfsPath, workspacePath,
		netCfg.TAPName, guestMAC, agentSockPath, qmpSockPath, bootArgs)

	cmd := exec.Command(m.cfg.QEMUBin, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("start qemu: %w", err)
	}
	logFile.Close()

	qmpClient, err := waitForQMP(qmpSockPath, 10*time.Second)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("QMP connect: %w", err)
	}

	now := time.Now()
	ttl := time.Duration(timeout) * time.Second
	if ttl <= 0 {
		ttl = 300 * time.Second
	}

	vm := &VMInstance{
		ID:            sandboxID,
		Template:      meta.Template,
		Status:        types.SandboxStatusRunning,
		StartedAt:     now,
		EndAt:         now.Add(ttl),
		CpuCount:      cpus,
		MemoryMB:      memMB,
		baseMemoryMB:  memMB,
		HostPort:      hostPort,
		GuestPort:     guestPort,
		pid:           cmd.Process.Pid,
		cmd:           cmd,
		network:       netCfg,
		sandboxDir:    sandboxDir,
		qmpSockPath:   qmpSockPath,
		agentSockPath: agentSockPath,
		qmp:           qmpClient,
		guestMAC:      guestMAC,
		guestCID:      guestCID,
		bootArgs:      bootArgs,
		goldenVersion: m.goldenVersion, // cold boot: VM runs on the current worker's base
		diskLayout:    boolToLayout(merged),
	}

	// Generous agent wait: coldBootLocalInner is only reached on the
	// corrupt-wake / loadvm-failure recovery paths, where the alternative to
	// waiting is escalating to a destructive rootfs rebuild (stage 2, which
	// discards the customer's installed packages). A few extra seconds on a
	// rare path is far cheaper than that escalation, and a healthy worker
	// still connects in ~1.5s — the longer ceiling only bites under load.
	agentClient, err := m.waitForAgentSocket(context.Background(), agentSockPath, recoveryColdBootAgentWait)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		m.cleanupVM(netCfg, "")
		return nil, fmt.Errorf("agent not ready after cold boot: %w", err)
	}
	vm.agent = agentClient

	if err := syncGuestClock(context.Background(), agentClient); err != nil {
		log.Printf("qemu: cold-boot-local %s: clock sync failed: %v", sandboxID, err)
	}

	m.mu.Lock()
	m.vms[sandboxID] = vm
	m.mu.Unlock()

	// Notify metadata server
	if m.onSandboxReady != nil {
		m.onSandboxReady(sandboxID, netCfg.GuestIP, meta.Template, vm.StartedAt)
	}

	log.Printf("qemu: cold-boot-local %s (template=%s, port=%d, tap=%s)", sandboxID, meta.Template, hostPort, netCfg.TAPName)
	return vmToSandbox(vm), nil
}

// createArchive creates a tar.zst archive of specific files from a directory.
func createArchive(archivePath, baseDir string, files []string) error {
	args := []string{
		"--zstd",
		"-cf", archivePath,
		"-C", baseDir,
	}
	args = append(args, files...)

	cmd := exec.Command("tar", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar create: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// extractArchive extracts a tar.zst archive to a directory.
func extractArchive(archivePath, destDir string) error {
	cmd := exec.Command("tar", "--zstd", "-xf", archivePath, "-C", destDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar extract: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// fileExists checks if a file exists and is not a directory.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// checkReflinkSupport verifies the filesystem supports reflink by creating a test file
// and reflink-copying it. Returns nil if reflink works, error otherwise.
func checkReflinkSupport(dir string) error {
	testFile := filepath.Join(dir, ".reflink-test")
	testCopy := filepath.Join(dir, ".reflink-test-copy")
	defer os.Remove(testFile)
	defer os.Remove(testCopy)

	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := os.WriteFile(testFile, []byte("reflink-test"), 0644); err != nil {
		return err
	}
	cmd := exec.Command("cp", "--reflink=always", testFile, testCopy)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("reflink test failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// diskUsagePercent returns the disk usage percentage for the given path.
func diskUsagePercent(path string) (int, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bfree * uint64(stat.Bsize)
	if total == 0 {
		return 0, nil
	}
	used := total - free
	return int(used * 100 / total), nil
}

// copyFileReflink copies a file using cp --reflink=auto.
func copyFileReflink(src, dst string) error {
	cmd := exec.Command("cp", "--reflink=auto", src, dst)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("cp %s → %s: %w (%s)", src, dst, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// syncGuestClock sets the guest clock to the current host time via agent exec.
//
// Wraps the underlying RPC with a 10s deadline (caller-side timeout, NOT just
// the agent-side TimeoutSeconds) and one Redial-on-transport-error retry. Prior
// version used the caller's context.Background() which had no deadline at all,
// so a wedged virtio-serial channel would block until gRPC keepalive (~7 min)
// gave up. That stall is what produced the multi-minute "from-checkpoint"
// requests in load tests.
func syncGuestClock(ctx context.Context, agent *AgentClient) error {
	now := time.Now().Unix()
	req := &pb.ExecRequest{
		Command:        "/bin/sh",
		Args:           []string{"-c", fmt.Sprintf("date -s @%d > /dev/null 2>&1", now)},
		TimeoutSeconds: 5,
		RunAsRoot:      true,
	}
	rpcCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := agent.Exec(rpcCtx, req)
	if err != nil && IsTransportError(err) {
		log.Printf("qemu: syncGuestClock: transport error %v, redialing and retrying once", err)
		if rdErr := agent.Redial(); rdErr != nil {
			return fmt.Errorf("clock sync redial: %w (orig: %v)", rdErr, err)
		}
		rpcCtx2, cancel2 := context.WithTimeout(ctx, 10*time.Second)
		defer cancel2()
		resp, err = agent.Exec(rpcCtx2, req)
	}
	if err != nil {
		return fmt.Errorf("exec clock sync: %w", err)
	}
	if resp.ExitCode != 0 {
		return fmt.Errorf("clock sync failed (exit %d): %s", resp.ExitCode, resp.Stderr)
	}
	return nil
}

// waitForQMP polls until the QMP socket appears and connects.
func waitForQMP(socketPath string, timeout time.Duration) (*QMPClient, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(socketPath); err == nil {
			qmp, err := ConnectQMP(socketPath, 5*time.Second)
			if err == nil {
				return qmp, nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("QMP socket %s not ready after %v", socketPath, timeout)
}

// classifyWakeFailure maps a wake error to a stable reason label for the
// WakeFailuresTotal metric and the wake-metric log event. Mirrors the
// worker-side classifier (internal/worker) intentionally; kept package-local
// to avoid a cross-package import just for a label string.
func classifyWakeFailure(err error) string {
	if err == nil {
		return "other"
	}
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "bad message"), strings.Contains(s, "metadata_csum"), strings.Contains(s, "corrupt"):
		return "corruption"
	case strings.Contains(s, "snapshot-meta"), strings.Contains(s, "sandbox-meta"), strings.Contains(s, "rebuild"):
		return "recovery_failed"
	case strings.Contains(s, "agent not ready"), strings.Contains(s, "agent.sock"):
		return "agent_timeout"
	case strings.Contains(s, "no s3 key"), strings.Contains(s, "not in local cache"), strings.Contains(s, "not found in cache"), strings.Contains(s, "object not found"):
		return "checkpoint_missing"
	case strings.Contains(s, "download"):
		return "s3_download"
	case strings.Contains(s, "rebase"):
		return "rebase"
	default:
		return "other"
	}
}
