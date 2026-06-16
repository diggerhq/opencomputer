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
	"time"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// Mount drivers. "rclone" wraps any of rclone's ~40 backends behind a simple
// remote+creds shape (the easy path). "command" runs a user-provided FUSE
// daemon / mount command directly — for callers who already have a FUSE-ready
// filesystem (their own VFS, gcsfuse, s3fs, …) and don't want rclone as a
// middle layer. Both share the same lifecycle: managed mountpoint, secret
// injection, listing, and teardown.
const (
	DriverRclone  = "rclone"
	DriverCommand = "command"
)

// MountRecord describes one FUSE mount inside a sandbox. Process-local — tracks
// what was added via this worker. Credentials are never stored: rclone creds
// live only in the in-VM tmpfs config file; command-driver secrets are injected
// as process env (in-guest only) and deliberately omitted from this record.
//
// RcloneVersion is captured at mount-add time for the rclone driver. rclone gets
// installed in the rootfs at image-build time, so different sandboxes can be on
// different versions depending on which rootfs they cold-booted from. Surfacing
// this lets ops triage "my S3 mount is broken" reports quickly — "you're on
// v1.62, the fix is in v1.65, recreate the sandbox".
type MountRecord struct {
	Path     string `json:"path"`
	Driver   string `json:"driver"` // "rclone" | "command"
	ReadOnly bool   `json:"readOnly"`

	// rclone driver
	Remote        string `json:"remote,omitempty"`
	Backend       string `json:"backend,omitempty"`
	RcloneVersion string `json:"rcloneVersion,omitempty"`

	// command driver — the resolved argv and non-secret env (secrets omitted).
	Command []string          `json:"command,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// AddRequest is the wire shape the HTTP layer parses and hands to Service.Add.
type AddRequest struct {
	Path     string `json:"path"`             // absolute mountpoint inside the VM
	Driver   string `json:"driver,omitempty"` // "rclone" (default) | "command"
	ReadOnly *bool  `json:"readOnly"`         // default true

	// rclone driver (default).
	Remote       string            `json:"remote,omitempty"`       // rclone remote spec, e.g. "s3:my-bucket/sub"
	Backend      string            `json:"backend,omitempty"`      // s3, gcs, azureblob, sftp, webdav, dropbox
	Creds        map[string]string `json:"creds,omitempty"`        // backend-specific config keys
	RcloneConfig string            `json:"rcloneConfig,omitempty"` // raw config; overrides backend+creds
	MountOptions []string          `json:"mountOptions,omitempty"` // extra args appended to `rclone mount`

	// command driver — run a user-provided FUSE daemon / mount command. The
	// platform manages the mountpoint, env/secret injection, and teardown; the
	// command itself establishes the FUSE mount. "{mountpoint}" tokens in the
	// argv are replaced with the resolved mount path. readOnly is advisory for
	// this driver (the daemon must honor it; we also pass OC_MOUNT_READONLY).
	Command []string          `json:"command,omitempty"` // argv; required for the command driver
	Env     map[string]string `json:"env,omitempty"`     // env vars (recorded, returned by list)
	Secrets map[string]string `json:"secrets,omitempty"` // secret env vars; injected, never recorded/returned
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
// records the in-memory entry. Dispatches on driver — "rclone" (default) or
// "command".
func (s *Service) Add(ctx context.Context, sandboxID string, req AddRequest) (MountRecord, error) {
	if req.Path == "" {
		return MountRecord{}, fmt.Errorf("path is required")
	}
	if !strings.HasPrefix(req.Path, "/") {
		return MountRecord{}, fmt.Errorf("path must be absolute")
	}
	driver := req.Driver
	if driver == "" {
		driver = DriverRclone
	}
	readOnly := true
	if req.ReadOnly != nil {
		readOnly = *req.ReadOnly
	}

	var rec MountRecord
	switch driver {
	case DriverRclone:
		if req.Remote == "" {
			return MountRecord{}, fmt.Errorf("remote is required for the rclone driver")
		}
		rcloneConf, err := renderRcloneConfig(req)
		if err != nil {
			return MountRecord{}, err
		}
		if err := s.doMountRclone(ctx, sandboxID, req.Path, req.Remote, rcloneConf, readOnly, req.MountOptions); err != nil {
			return MountRecord{}, err
		}
		rec = MountRecord{
			Path:          req.Path,
			Driver:        DriverRclone,
			ReadOnly:      readOnly,
			Remote:        req.Remote,
			Backend:       req.Backend,
			RcloneVersion: s.probeRcloneVersion(ctx, sandboxID),
		}

	case DriverCommand:
		if len(req.Command) == 0 {
			return MountRecord{}, fmt.Errorf("command is required for the command driver")
		}
		argv := substituteMountpoint(req.Command, req.Path)
		if err := s.doMountCommand(ctx, sandboxID, req.Path, argv, req.Env, req.Secrets, readOnly); err != nil {
			return MountRecord{}, err
		}
		rec = MountRecord{
			Path:     req.Path,
			Driver:   DriverCommand,
			ReadOnly: readOnly,
			Command:  argv,
			Env:      req.Env,
		}

	default:
		return MountRecord{}, fmt.Errorf("unsupported driver %q (supported: %q, %q)", driver, DriverRclone, DriverCommand)
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

// probeFUSE checks the sandbox image has the FUSE userspace bits. rclone is
// only required for the rclone driver; fusermount3 is required for both.
func (s *Service) probeFUSE(ctx context.Context, sandboxID string, needRclone bool) error {
	test := "command -v fusermount3 >/dev/null 2>&1"
	missing := "`fusermount3`"
	if needRclone {
		test = "command -v rclone >/dev/null 2>&1 && " + test
		missing = "`rclone` and/or `fusermount3`"
	}
	probe, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		Args:    []string{"-c", test},
		Timeout: 10,
	})
	if err != nil {
		return fmt.Errorf("probe sandbox: %w", err)
	}
	if probe == nil || probe.ExitCode != 0 {
		return fmt.Errorf("sandbox image is missing %s — rebuild from the latest default rootfs to use mounts", missing)
	}
	return nil
}

// ensureMountsDir creates the root-owned 0700 tmpfs dir that holds rclone
// config files (which carry creds) and per-mount logs.
func (s *Service) ensureMountsDir(ctx context.Context, sandboxID string) error {
	if _, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", "mkdir -p /run/oc-agent/mounts && chmod 700 /run/oc-agent/mounts"},
		Timeout: 10,
	}); err != nil {
		return fmt.Errorf("prepare mounts dir: %w", err)
	}
	return nil
}

// ensureTarget creates the mountpoint and hands it to the sandbox user so a
// non-root FUSE daemon can mount there.
func (s *Service) ensureTarget(ctx context.Context, sandboxID, target string) error {
	if _, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", fmt.Sprintf("mkdir -p %q && chown sandbox:sandbox %q", target, target)},
		Timeout: 10,
	}); err != nil {
		return fmt.Errorf("prepare mount target: %w", err)
	}
	return nil
}

// doMountRclone is the rclone-driver orchestration: write the config to tmpfs,
// mkdir the target, exec `rclone mount --daemon`.
//
// `remote` is the full rclone remote spec passed to `rclone mount` (e.g.
// "s3:my-bucket/prefix"). It is NOT derived from the config section header
// because rclone needs the `<name>:<path>` form — bare `<name>` makes rclone
// fall back to its local-filesystem backend at `~/<name>` with no error,
// which surfaces as a silently-empty mount target.
func (s *Service) doMountRclone(ctx context.Context, sandboxID, target, remote, rcloneConf string, readOnly bool, mountOptions []string) error {
	confPath := mountConfPath(target)

	if err := s.probeFUSE(ctx, sandboxID, true); err != nil {
		return err
	}
	if err := s.ensureMountsDir(ctx, sandboxID); err != nil {
		return err
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

	if err := s.ensureTarget(ctx, sandboxID, target); err != nil {
		return err
	}

	if remote == "" {
		return fmt.Errorf("internal: empty remote passed to doMountRclone")
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

// doMountCommand runs a user-provided FUSE daemon / mount command. We manage
// the mountpoint, inject env + secrets (via the in-guest process env — never
// the command line, so they don't leak via `ps`), launch the daemon as the
// sandbox user (FUSE works non-root via user_allow_other), and poll until the
// mount is live. The daemon stays running in the background; Remove unmounts it
// (a libfuse daemon exits on its own when its mount goes away).
func (s *Service) doMountCommand(ctx context.Context, sandboxID, target string, argv []string, env, secrets map[string]string, readOnly bool) error {
	if err := s.probeFUSE(ctx, sandboxID, false); err != nil {
		return err
	}
	// The daemon runs as the sandbox user, so /dev/fuse must be openable by it.
	// Some base images ship /dev/fuse as 0600 root (rclone gets away with it by
	// running as root); a user daemon can't. Make it user-accessible — the VM
	// is single-tenant, matching a normal desktop's crw-rw-rw-.
	if _, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", "[ -e /dev/fuse ] && chmod 0666 /dev/fuse || true"},
		Timeout: 5,
	}); err != nil {
		return fmt.Errorf("prepare /dev/fuse: %w", err)
	}
	if err := s.ensureMountsDir(ctx, sandboxID); err != nil {
		return err
	}
	logPath := mountLogPath(target)
	// The daemon runs as the sandbox user, so its log must live in a dir the
	// sandbox user can write — NOT the root-owned 0700 rclone-config dir (the
	// sandbox can't even traverse into it, so a redirect there fails silently
	// before the daemon starts).
	if _, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", "mkdir -p /run/oc-agent/mount-logs && chown sandbox:sandbox /run/oc-agent/mount-logs && chmod 700 /run/oc-agent/mount-logs"},
		Timeout: 10,
	}); err != nil {
		return fmt.Errorf("prepare mount log dir: %w", err)
	}
	if err := s.ensureTarget(ctx, sandboxID, target); err != nil {
		return err
	}

	// Merge env + secrets into the process environment. Both go through the
	// agent's process env (not argv), so secret values never appear in `ps`.
	procEnv := make(map[string]string, len(env)+len(secrets)+1)
	for k, v := range env {
		procEnv[k] = v
	}
	for k, v := range secrets {
		procEnv[k] = v
	}
	if readOnly {
		procEnv["OC_MOUNT_READONLY"] = "1"
	}

	// Background the daemon; shQuote each arg so arbitrary user argv is safe.
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = shQuote(a)
	}
	launch := fmt.Sprintf("nohup %s >%s 2>&1 & echo $!", strings.Join(quoted, " "), shQuote(logPath))
	resp, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		Args:    []string{"-c", launch},
		Env:     procEnv,
		Timeout: 30,
	})
	if err != nil {
		return fmt.Errorf("launch mount command: %w", err)
	}
	if resp.ExitCode != 0 {
		return fmt.Errorf("launch mount command failed (exit %d): %s", resp.ExitCode, mountErrText(resp))
	}
	pid := strings.TrimSpace(resp.Stdout)

	// Poll until the mount is live. FUSE daemons usually mount in <5s; give a
	// cold first-connect generous headroom. Bail early if the daemon dies
	// before mounting so a bad command fails fast instead of waiting it out.
	for i := 0; i < 30; i++ {
		if chk, _ := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
			Command: "sh",
			Args:    []string{"-c", fmt.Sprintf("mountpoint -q %q && echo MOUNTED", target)},
			Timeout: 5,
		}); chk != nil && strings.Contains(chk.Stdout, "MOUNTED") {
			return nil
		}
		alive, _ := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
			Command: "sh",
			Args:    []string{"-c", fmt.Sprintf("kill -0 %s 2>/dev/null && echo ALIVE", pid)},
			Timeout: 5,
		})
		if alive == nil || !strings.Contains(alive.Stdout, "ALIVE") {
			break // daemon exited without mounting
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}

	// Not mounted: capture the daemon log, tear down, and report.
	logTail := "(no output)"
	if t, _ := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		Args:    []string{"-c", fmt.Sprintf("tail -n 20 %q 2>/dev/null", logPath)},
		Timeout: 5,
	}); t != nil && strings.TrimSpace(t.Stdout) != "" {
		logTail = strings.TrimSpace(t.Stdout)
	}
	_, _ = s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sh",
		Args:    []string{"-c", fmt.Sprintf("kill %s 2>/dev/null; sudo fusermount3 -u %q 2>/dev/null; sudo rm -f %q; true", pid, target, logPath)},
		Timeout: 10,
	})
	return fmt.Errorf("mount command did not produce a live mount at %s within timeout; daemon log:\n%s", target, logTail)
}

func (s *Service) unmountInVM(ctx context.Context, sandboxID, path string) error {
	confPath := mountConfPath(path)
	logPath := mountLogPath(path)
	_, err := s.manager.Exec(ctx, sandboxID, types.ProcessConfig{
		Command: "sudo",
		Args:    []string{"sh", "-c", fmt.Sprintf("fusermount3 -u %q 2>/dev/null; rm -f %q %q 2>/dev/null; true", path, confPath, logPath)},
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

// mountLogPath is the deterministic tmpfs path for a command-driver daemon's
// stdout/stderr. Lives in a sandbox-owned dir (the daemon runs as the sandbox
// user) — distinct from the root-owned rclone-config dir. Same hashing scheme
// as mountConfPath so add→remove is self-consistent.
func mountLogPath(path string) string {
	sum := sha1.Sum([]byte(path))
	return "/run/oc-agent/mount-logs/" + hex.EncodeToString(sum[:])[:16] + ".log"
}

// shQuote single-quotes a string for safe interpolation into an `sh -c` line,
// so arbitrary user-supplied argv can't break out of the command.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// substituteMountpoint replaces "{mountpoint}" / "{path}" tokens in the argv
// with the resolved mount path, so command-driver callers can template where
// the mount lands without hardcoding it twice.
func substituteMountpoint(argv []string, target string) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		a = strings.ReplaceAll(a, "{mountpoint}", target)
		a = strings.ReplaceAll(a, "{path}", target)
		out[i] = a
	}
	return out
}

// mountErrText picks the most useful stderr/stdout text from a process result.
func mountErrText(r *types.ProcessResult) string {
	msg := strings.TrimSpace(r.Stderr)
	if msg == "" {
		msg = strings.TrimSpace(r.Stdout)
	}
	return msg
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
