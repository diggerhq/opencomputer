package sandbox

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/podman"
	"github.com/opensandbox/opensandbox/pkg/types"
)

const (
	labelPrefix   = "opensandbox"
	labelID       = labelPrefix + ".id"
	labelTemplate = labelPrefix + ".template"
	labelCreated  = labelPrefix + ".created"
	labelTimeout  = labelPrefix + ".timeout"
	containerName = "osb"

	defaultTimeout  = 300 // 5 minutes
	defaultImage    = "docker.io/library/ubuntu:22.04"
	defaultMemoryMB = 512
	defaultCPU      = 1
)

// Manager handles sandbox lifecycle operations.
type Manager struct {
	podman  *podman.Client
	mu      sync.RWMutex
	timers  map[string]*time.Timer // sandbox ID -> timeout timer
}

// NewManager creates a new sandbox manager.
func NewManager(client *podman.Client) *Manager {
	return &Manager{
		podman: client,
		timers: make(map[string]*time.Timer),
	}
}

// Create creates a new sandbox container and starts it.
func (m *Manager) Create(ctx context.Context, cfg types.SandboxConfig) (*types.Sandbox, error) {
	id := uuid.New().String()[:8]
	name := fmt.Sprintf("%s-%s", containerName, id)

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	image := defaultImage
	if cfg.Template != "" {
		image = resolveTemplateImage(cfg.Template)
	}

	memoryMB := cfg.MemoryMB
	if memoryMB <= 0 {
		memoryMB = defaultMemoryMB
	}
	cpuCount := cfg.CpuCount
	if cpuCount <= 0 {
		cpuCount = defaultCPU
	}

	now := time.Now()

	ccfg := podman.DefaultContainerConfig(name, image)
	ccfg.Labels[labelID] = id
	ccfg.Labels[labelTemplate] = cfg.Template
	ccfg.Labels[labelCreated] = now.Format(time.RFC3339)
	ccfg.Labels[labelTimeout] = strconv.Itoa(timeout)
	ccfg.Memory = fmt.Sprintf("%dm", memoryMB)
	ccfg.CPUs = fmt.Sprintf("%d", cpuCount)

	for k, v := range cfg.Envs {
		ccfg.Env[k] = v
	}

	if cfg.NetworkEnabled {
		ccfg.NetworkMode = "slirp4netns"
	}

	// Make /tmp writable for sandbox use
	ccfg.TmpFS["/tmp"] = "rw,size=100m"
	// Add a writable home directory
	ccfg.TmpFS["/home/user"] = "rw,size=200m"

	if _, err := m.podman.CreateContainer(ctx, ccfg); err != nil {
		return nil, fmt.Errorf("failed to create sandbox %s: %w", id, err)
	}

	if err := m.podman.StartContainer(ctx, name); err != nil {
		// Clean up the created container on start failure
		_ = m.podman.RemoveContainer(ctx, name, true)
		return nil, fmt.Errorf("failed to start sandbox %s: %w", id, err)
	}

	sandbox := &types.Sandbox{
		ID:        id,
		Template:  cfg.Template,
		Alias:     cfg.Alias,
		Status:    types.SandboxStatusRunning,
		StartedAt: now,
		EndAt:     now.Add(time.Duration(timeout) * time.Second),
		Metadata:  cfg.Metadata,
		CpuCount:  cpuCount,
		MemoryMB:  memoryMB,
	}

	m.scheduleTimeout(id, name, time.Duration(timeout)*time.Second)

	return sandbox, nil
}

// Get returns sandbox info by ID.
func (m *Manager) Get(ctx context.Context, id string) (*types.Sandbox, error) {
	name := fmt.Sprintf("%s-%s", containerName, id)
	info, err := m.podman.InspectContainer(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("sandbox %s not found: %w", id, err)
	}
	return containerInfoToSandbox(info), nil
}

// Kill forcefully removes a sandbox.
func (m *Manager) Kill(ctx context.Context, id string) error {
	name := fmt.Sprintf("%s-%s", containerName, id)
	m.cancelTimeout(id)
	if err := m.podman.RemoveContainer(ctx, name, true); err != nil {
		return fmt.Errorf("failed to kill sandbox %s: %w", id, err)
	}
	return nil
}

// List returns all sandboxes.
func (m *Manager) List(ctx context.Context) ([]types.Sandbox, error) {
	entries, err := m.podman.ListContainers(ctx, labelID)
	if err != nil {
		return nil, fmt.Errorf("failed to list sandboxes: %w", err)
	}

	sandboxes := make([]types.Sandbox, 0, len(entries))
	for _, e := range entries {
		sandboxes = append(sandboxes, psEntryToSandbox(e))
	}
	return sandboxes, nil
}

// SetTimeout updates the timeout for a running sandbox.
func (m *Manager) SetTimeout(ctx context.Context, id string, timeoutSec int) error {
	name := fmt.Sprintf("%s-%s", containerName, id)

	// Verify sandbox exists and is running
	info, err := m.podman.InspectContainer(ctx, name)
	if err != nil {
		return fmt.Errorf("sandbox %s not found: %w", id, err)
	}
	if !info.State.Running {
		return fmt.Errorf("sandbox %s is not running", id)
	}

	m.scheduleTimeout(id, name, time.Duration(timeoutSec)*time.Second)
	return nil
}

// ContainerName returns the podman container name for a sandbox ID.
func (m *Manager) ContainerName(id string) string {
	return fmt.Sprintf("%s-%s", containerName, id)
}

// Close cancels all timeout timers.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, timer := range m.timers {
		timer.Stop()
	}
	m.timers = make(map[string]*time.Timer)
}

func (m *Manager) scheduleTimeout(id, name string, d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.timers[id]; ok {
		existing.Stop()
	}

	m.timers[id] = time.AfterFunc(d, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = m.podman.RemoveContainer(ctx, name, true)

		m.mu.Lock()
		delete(m.timers, id)
		m.mu.Unlock()
	})
}

func (m *Manager) cancelTimeout(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if timer, ok := m.timers[id]; ok {
		timer.Stop()
		delete(m.timers, id)
	}
}

func resolveTemplateImage(template string) string {
	switch template {
	case "base", "":
		return "docker.io/library/ubuntu:22.04"
	case "python":
		return "docker.io/library/python:3.12-slim"
	case "node":
		return "docker.io/library/node:20-slim"
	default:
		// Custom template: assume it's an image name tagged by the template system
		return fmt.Sprintf("localhost/opensandbox-template/%s:latest", template)
	}
}

func containerInfoToSandbox(info *podman.ContainerInfo) *types.Sandbox {
	status := types.SandboxStatusStopped
	if info.State.Running {
		status = types.SandboxStatusRunning
	}

	id := info.Config.Labels[labelID]

	startedAt, _ := time.Parse(time.RFC3339, info.Config.Labels[labelCreated])
	timeoutSec, _ := strconv.Atoi(info.Config.Labels[labelTimeout])
	endAt := startedAt.Add(time.Duration(timeoutSec) * time.Second)

	return &types.Sandbox{
		ID:        id,
		Template:  info.Config.Labels[labelTemplate],
		Status:    status,
		StartedAt: startedAt,
		EndAt:     endAt,
	}
}

func psEntryToSandbox(entry podman.PSEntry) types.Sandbox {
	status := types.SandboxStatusStopped
	if entry.State == "running" {
		status = types.SandboxStatusRunning
	}

	id := entry.Labels[labelID]

	startedAt, _ := time.Parse(time.RFC3339, entry.Labels[labelCreated])
	timeoutSec, _ := strconv.Atoi(entry.Labels[labelTimeout])
	endAt := startedAt.Add(time.Duration(timeoutSec) * time.Second)

	return types.Sandbox{
		ID:        id,
		Template:  entry.Labels[labelTemplate],
		Status:    status,
		StartedAt: startedAt,
		EndAt:     endAt,
	}
}
