// Package mounts implements rclone-backed FUSE mounts inside a sandbox.
//
// Wired into two HTTP layers — internal/api (combined mode) and internal/worker
// (server mode) — both delegating to the same Service so behavior is identical
// regardless of which path reached the worker that owns the sandbox.
//
// Lifecycle note: mounts survive hibernate/wake naturally because savevm
// captures the live FUSE kernel state AND the rclone daemon process; loadvm
// restores both. The platform does the work for us. Callers explicitly
// remove a mount via Service.Remove when they want it gone.
package mounts

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// MountRecord describes one rclone-backed FUSE mount inside a sandbox.
// Process-local — tracks what was added via this worker. Credentials are
// not stored anywhere outside the in-VM tmpfs config file.
//
// RcloneVersion is captured at mount-add time. rclone gets installed in the
// rootfs at image-build time, so different sandboxes can be on different
// versions depending on which rootfs they cold-booted from. Surfacing this
// lets ops triage "my S3 mount is broken" reports quickly — "you're on
// v1.62, the fix is in v1.65, recreate the sandbox".
type MountRecord struct {
	Path          string `json:"path"`
	Remote        string `json:"remote"`
	Backend       string `json:"backend,omitempty"`
	ReadOnly      bool   `json:"readOnly"`
	RcloneVersion string `json:"rcloneVersion,omitempty"`
}

// AddRequest is the wire shape the HTTP layer parses and hands to Service.Add.
type AddRequest struct {
	Path         string            `json:"path"`         // absolute path inside the VM
	Remote       string            `json:"remote"`       // rclone remote spec, e.g. "s3:my-bucket/sub"
	Backend      string            `json:"backend"`      // s3, gcs, azureblob, sftp, webdav, dropbox
	Creds        map[string]string `json:"creds"`        // backend-specific config keys
	RcloneConfig string            `json:"rcloneConfig"` // raw config; overrides backend+creds
	ReadOnly     *bool             `json:"readOnly"`     // default true
	MountOptions []string          `json:"mountOptions"` // extra args appended to `rclone mount`
}

// Service is the rclone-mount orchestrator. Process-local Registry tracks
// what we know about; no persistence, no encryption — savevm/loadvm captures
// and restores live mounts intrinsically.
type Service struct {
	manager  sandbox.Manager
	registry *Registry
}

// NewService wires a Service.
func NewService(manager sandbox.Manager) *Service {
	return &Service{
		manager:  manager,
		registry: newRegistry(),
	}
}

// List returns the current view of mounts the worker knows about for this
// sandbox. Non-nil empty slice when there are none.
func (s *Service) List(sandboxID string) []MountRecord {
	recs := s.registry.get(sandboxID)
	if recs == nil {
		return []MountRecord{}
	}
	return recs
}

// Add validates the request, performs the live mount in the sandbox, and
// records the in-memory entry.
func (s *Service) Add(ctx context.Context, sandboxID string, req AddRequest) (MountRecord, error) {
	if req.Path == "" || req.Remote == "" {
		return MountRecord{}, fmt.Errorf("path and remote are required")
	}
	if !strings.HasPrefix(req.Path, "/") {
		return MountRecord{}, fmt.Errorf("path must be absolute")
	}

	rcloneConf, err := renderRcloneConfig(req)
	if err != nil {
		return MountRecord{}, err
	}
	readOnly := true
	if req.ReadOnly != nil {
		readOnly = *req.ReadOnly
	}

	if err := s.doMount(ctx, sandboxID, req.Path, req.Remote, rcloneConf, readOnly, req.MountOptions); err != nil {
		return MountRecord{}, err
	}

	rec := MountRecord{
		Path:          req.Path,
		Remote:        req.Remote,
		Backend:       req.Backend,
		ReadOnly:      readOnly,
		RcloneVersion: s.probeRcloneVersion(ctx, sandboxID),
	}
	s.registry.put(sandboxID, rec)
	return rec, nil
}

// probeRcloneVersion runs `rclone version` in the VM and returns the version
// token (e.g. "v1.65.2"). Best-effort — returns empty on any failure since
// this is purely for ops visibility, never load-bearing.
func (s *Service) probeRcloneVersion(ctx context.Context, sandboxID string) string {
	resp, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		Args:    []string{"-c", "rclone version 2>/dev/null | head -1"},
		Timeout: 5,
	})
	if err != nil || resp == nil || resp.ExitCode != 0 {
		return ""
	}
	out := strings.TrimSpace(resp.Stdout)
	// Expected first line: "rclone v1.65.2" — strip the prefix.
	out = strings.TrimPrefix(out, "rclone ")
	return out
}

// Remove unmounts and forgets the mount. Idempotent — no error when the path
// isn't currently mounted.
func (s *Service) Remove(ctx context.Context, sandboxID, path string) error {
	if err := s.unmountInVM(ctx, sandboxID, path); err != nil {
		return err
	}
	s.registry.remove(sandboxID, path)
	return nil
}

// doMount is the shared orchestration: probe rclone is present, write the
// config to tmpfs, mkdir the target, exec `rclone mount --daemon`.
//
// `remote` is the full rclone remote spec passed to `rclone mount` (e.g.
// "s3:my-bucket/prefix"). It is NOT derived from the config section header
// because rclone needs the `<name>:<path>` form — bare `<name>` makes rclone
// fall back to its local-filesystem backend at `~/<name>` with no error,
// which surfaces as a silently-empty mount target.
func (s *Service) doMount(ctx context.Context, sandboxID, target, remote, rcloneConf string, readOnly bool, mountOptions []string) error {
	confPath := mountConfPath(target)

	probe, perr := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		Args:    []string{"-c", "command -v rclone >/dev/null 2>&1 && command -v fusermount3 >/dev/null 2>&1"},
		Timeout: 10,
	})
	if perr != nil {
		return fmt.Errorf("probe sandbox: %w", perr)
	}
	if probe == nil || probe.ExitCode != 0 {
		return fmt.Errorf("sandbox image is missing `rclone` and/or `fusermount3` — rebuild from the latest default rootfs to use mounts")
	}

	if _, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", "mkdir -p /run/oc-agent/mounts && chmod 700 /run/oc-agent/mounts"},
		Timeout: 10,
	}); err != nil {
		return fmt.Errorf("prepare config dir: %w", err)
	}

	if err := s.manager.WriteFile(ctx, sandboxID, confPath, rcloneConf); err != nil {
		return fmt.Errorf("write rclone config: %w", err)
	}
	if _, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"chmod", "600", confPath},
		Timeout: 5,
	}); err != nil {
		return fmt.Errorf("chmod config: %w", err)
	}

	if _, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", fmt.Sprintf("mkdir -p %q && chown sandbox:sandbox %q", target, target)},
		Timeout: 10,
	}); err != nil {
		return fmt.Errorf("prepare mount target: %w", err)
	}

	if remote == "" {
		return fmt.Errorf("internal: empty remote passed to doMount")
	}

	mountArgs := []string{
		"rclone", "mount", remote, target,
		"--config", confPath,
		"--daemon",
		// Cap how long rclone waits for "mount ready" before forking; without
		// a timeout, an unreachable remote makes the call hang indefinitely.
		// 60s gives cold first-mount paths headroom (DNS + S3 TLS + rclone
		// init on a fresh sandbox can chew 30-40s before steady-state).
		"--daemon-timeout", "60s",
		"--allow-other",
	}
	if readOnly {
		mountArgs = append(mountArgs, "--read-only")
	} else {
		mountArgs = append(mountArgs, "--vfs-cache-mode", "writes")
	}
	mountArgs = append(mountArgs, mountOptions...)

	resp, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    mountArgs,
		// Outer cap on the agent-side exec; needs to be > --daemon-timeout
		// so rclone's own timeout fires first and we get a clean error
		// message instead of an agent-killed-the-subprocess error.
		Timeout: 75,
	})
	if err != nil {
		return fmt.Errorf("rclone mount: %w", err)
	}
	if resp.ExitCode != 0 {
		_, _ = s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
			Command: "sudo",
			Args:    []string{"rm", "-f", confPath},
			Timeout: 5,
		})
		msg := strings.TrimSpace(resp.Stderr)
		if msg == "" {
			msg = strings.TrimSpace(resp.Stdout)
		}
		return fmt.Errorf("rclone mount failed (exit %d): %s", resp.ExitCode, msg)
	}
	return nil
}

func (s *Service) unmountInVM(ctx context.Context, sandboxID, path string) error {
	confPath := mountConfPath(path)
	_, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", fmt.Sprintf("fusermount3 -u %q 2>/dev/null; rm -f %q 2>/dev/null; true", path, confPath)},
		Timeout: 15,
	})
	return err
}

// --- Registry ---

type Registry struct {
	mu sync.Mutex
	m  map[string][]MountRecord
}

func newRegistry() *Registry {
	return &Registry{m: make(map[string][]MountRecord)}
}

func (r *Registry) put(sandboxID string, rec MountRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur := r.m[sandboxID]
	for i := range cur {
		if cur[i].Path == rec.Path {
			cur[i] = rec
			r.m[sandboxID] = cur
			return
		}
	}
	r.m[sandboxID] = append(cur, rec)
}

func (r *Registry) remove(sandboxID, path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur := r.m[sandboxID]
	out := cur[:0]
	for _, rec := range cur {
		if rec.Path != path {
			out = append(out, rec)
		}
	}
	if len(out) == 0 {
		delete(r.m, sandboxID)
	} else {
		r.m[sandboxID] = out
	}
}

func (r *Registry) get(sandboxID string) []MountRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur := r.m[sandboxID]
	if len(cur) == 0 {
		return nil
	}
	out := make([]MountRecord, len(cur))
	copy(out, cur)
	return out
}

// --- Helpers ---

// MountConfPath derives a deterministic tmpfs path for the mount's rclone
// config. Hashing the target path means add→remove for the same mount path
// always touches the same file with no opaque ID to track.
func MountConfPath(path string) string { return mountConfPath(path) }

func mountConfPath(path string) string {
	sum := sha1.Sum([]byte(path))
	return "/run/oc-agent/mounts/" + hex.EncodeToString(sum[:])[:16] + ".conf"
}

// RenderRcloneConfig builds a single-section rclone config from the typed
// backend+creds shape, or returns the raw user-supplied config if present.
func RenderRcloneConfig(req AddRequest) (string, error) { return renderRcloneConfig(req) }

func renderRcloneConfig(req AddRequest) (string, error) {
	if req.RcloneConfig != "" {
		return req.RcloneConfig, nil
	}
	colon := strings.Index(req.Remote, ":")
	if colon <= 0 {
		return "", fmt.Errorf(`remote must be "<name>:<path>" (got %q) when rcloneConfig is not supplied`, req.Remote)
	}
	name := req.Remote[:colon]

	var typ string
	switch req.Backend {
	case "s3":
		typ = "s3"
	case "gcs":
		typ = "google cloud storage"
	case "azureblob":
		typ = "azureblob"
	case "sftp":
		typ = "sftp"
	case "webdav":
		typ = "webdav"
	case "dropbox":
		typ = "dropbox"
	case "":
		return "", fmt.Errorf("backend is required when rcloneConfig is not supplied (or pass rcloneConfig directly)")
	default:
		return "", fmt.Errorf("unsupported backend %q (supported: s3, gcs, azureblob, sftp, webdav, dropbox — or pass rcloneConfig directly)", req.Backend)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "[%s]\ntype = %s\n", name, typ)
	if req.Backend == "s3" {
		if _, ok := req.Creds["provider"]; !ok {
			b.WriteString("provider = AWS\n")
		}
	}
	keys := make([]string, 0, len(req.Creds))
	for k := range req.Creds {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s = %s\n", k, req.Creds[k])
	}
	return b.String(), nil
}
