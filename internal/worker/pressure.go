package worker

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/firecracker"
)

const (
	pressureTickInterval = 10 * time.Second
	gbBytes              = 1 << 30 // 1 GiB in bytes
	vmCeilingGB          = 8.0
	minCapGB             = 0.5

	// Pressure thresholds (fraction of worker RAM)
	hibernateThreshold = 0.55
	migrateThreshold   = 0.70
)

// SandboxUsage tracks per-sandbox resource usage for billing and pressure management.
type SandboxUsage struct {
	SandboxID    string
	CpuCount     int
	MemoryBytes  int64   // current RSS from cgroup
	MemoryGB     float64 // convenience
	CgroupCapGB  float64 // current cgroup limit
	State        string  // "idle", "light", "medium", "heavy" (derived from RSS)

	// Billing accumulators (running totals since sandbox creation)
	AccumVCPUSeconds float64
	AccumGBSeconds   float64
}

// UsageFlush is sent to the flush callback with accumulated billing data.
type UsageFlush struct {
	SandboxID    string
	VCPUSeconds  float64
	GBSeconds    float64
}

// PressureMonitor runs on the worker every 10 seconds to:
//  1. Read per-sandbox memory usage from cgroups
//  2. Compute weighted fair-share cgroup limits
//  3. Update cgroup memory.max for each sandbox
//  4. Accumulate vCPU-seconds and GB-seconds for billing
//  5. Signal when pressure-based hibernation is needed
type PressureMonitor struct {
	workerRAMBytes int64
	getSandboxes   func() []SandboxInfo // returns list of running sandboxes
	onFlush        func([]UsageFlush)   // called periodically to persist billing data

	mu     sync.RWMutex
	usages map[string]*SandboxUsage // sandboxID → usage
	stop   chan struct{}
}

// SandboxInfo is the minimal info the pressure monitor needs about each sandbox.
type SandboxInfo struct {
	ID       string
	CpuCount int
	MemoryMB int // Firecracker configured memory (ceiling)
}

// NewPressureMonitor creates a new pressure monitor.
// workerRAMBytes: total worker RAM (e.g., 512 * 1024^3 for r7gd.metal)
// getSandboxes: callback to get current sandbox list from manager
// onFlush: callback to persist billing data (called every 60s)
func NewPressureMonitor(workerRAMBytes int64, getSandboxes func() []SandboxInfo, onFlush func([]UsageFlush)) *PressureMonitor {
	return &PressureMonitor{
		workerRAMBytes: workerRAMBytes,
		getSandboxes:   getSandboxes,
		onFlush:        onFlush,
		usages:         make(map[string]*SandboxUsage),
		stop:           make(chan struct{}),
	}
}

// Start begins the pressure monitoring loop.
func (pm *PressureMonitor) Start() {
	go pm.loop()
}

// Stop stops the pressure monitor and flushes final billing data.
func (pm *PressureMonitor) Stop() {
	close(pm.stop)
}

// GetUsage returns the current usage for a sandbox (for API/dashboard).
func (pm *PressureMonitor) GetUsage(sandboxID string) *SandboxUsage {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	if u, ok := pm.usages[sandboxID]; ok {
		copy := *u
		return &copy
	}
	return nil
}

// TotalMemoryUsed returns total physical memory used by all sandboxes (bytes).
func (pm *PressureMonitor) TotalMemoryUsed() int64 {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	var total int64
	for _, u := range pm.usages {
		total += u.MemoryBytes
	}
	return total
}

// MemoryUsagePct returns worker memory usage as a percentage.
func (pm *PressureMonitor) MemoryUsagePct() float64 {
	return float64(pm.TotalMemoryUsed()) / float64(pm.workerRAMBytes) * 100
}

// SandboxesOverPressure returns sandbox IDs that should be hibernated
// to relieve memory pressure, sorted by least recently active.
func (pm *PressureMonitor) SandboxesOverPressure() []string {
	if pm.MemoryUsagePct() < hibernateThreshold*100 {
		return nil
	}
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	var idle []string
	for _, u := range pm.usages {
		if u.State == "idle" || u.State == "light" {
			idle = append(idle, u.SandboxID)
		}
	}
	return idle
}

func (pm *PressureMonitor) loop() {
	ticker := time.NewTicker(pressureTickInterval)
	defer ticker.Stop()

	flushTicker := time.NewTicker(60 * time.Second)
	defer flushTicker.Stop()

	tickCount := 0

	for {
		select {
		case <-ticker.C:
			pm.tick()
			tickCount++
		case <-flushTicker.C:
			pm.flushBilling()
		case <-pm.stop:
			pm.flushBilling() // final flush
			return
		}
	}
}

func (pm *PressureMonitor) tick() {
	sandboxes := pm.getSandboxes()

	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Clean up usages for sandboxes that no longer exist
	active := make(map[string]bool, len(sandboxes))
	for _, sb := range sandboxes {
		active[sb.ID] = true
	}
	for id := range pm.usages {
		if !active[id] {
			delete(pm.usages, id)
		}
	}

	// Read current memory usage from cgroups and update/create usage entries
	for _, sb := range sandboxes {
		memBytes, err := firecracker.ReadCgroupMemoryCurrent(sb.ID)
		if err != nil {
			// Cgroup might not exist yet (sandbox still booting)
			continue
		}

		memGB := float64(memBytes) / float64(gbBytes)
		state := classifyState(memGB)

		u, exists := pm.usages[sb.ID]
		if !exists {
			u = &SandboxUsage{SandboxID: sb.ID, CpuCount: sb.CpuCount}
			pm.usages[sb.ID] = u
		}

		u.MemoryBytes = memBytes
		u.MemoryGB = memGB
		u.CpuCount = sb.CpuCount
		u.State = state

		// Accumulate billing (10 seconds per tick)
		u.AccumVCPUSeconds += float64(sb.CpuCount) * pressureTickInterval.Seconds()
		u.AccumGBSeconds += memGB * pressureTickInterval.Seconds()
	}

	// Compute and apply weighted fair-share cgroup limits
	pm.applyWeightedFairShare(sandboxes)
}

// applyWeightedFairShare computes per-sandbox memory caps and writes them to cgroups.
// Algorithm: give each VM a base cap of 2× its current RSS, then distribute
// surplus to VMs that want more (heavy/medium VMs get the extra).
func (pm *PressureMonitor) applyWeightedFairShare(sandboxes []SandboxInfo) {
	if len(sandboxes) == 0 {
		return
	}

	budget := float64(pm.workerRAMBytes) * 0.95 / float64(gbBytes) // 95% of worker RAM in GB

	type vmCap struct {
		id   string
		base float64
		want float64
	}

	var caps []vmCap
	totalBase := 0.0
	totalWant := 0.0

	for _, sb := range sandboxes {
		u, ok := pm.usages[sb.ID]
		if !ok {
			continue
		}

		// Base cap: 2× current RSS (generous headroom for spikes)
		base := u.MemoryGB * 2.0
		if base < minCapGB {
			base = minCapGB
		}
		if base > vmCeilingGB {
			base = vmCeilingGB
		}

		want := vmCeilingGB - base
		if want < 0 {
			want = 0
		}

		caps = append(caps, vmCap{sb.ID, base, want})
		totalBase += base
		totalWant += want
	}

	if len(caps) == 0 {
		return
	}

	surplus := budget - totalBase

	for _, vc := range caps {
		var capGB float64
		if surplus < 0 {
			// Over budget at base — scale down proportionally
			capGB = vc.base * (budget / totalBase)
		} else {
			// Distribute surplus proportionally to want
			extra := 0.0
			if totalWant > 0 {
				extra = surplus * (vc.want / totalWant)
			}
			capGB = vc.base + extra
		}

		if capGB > vmCeilingGB {
			capGB = vmCeilingGB
		}
		if capGB < minCapGB {
			capGB = minCapGB
		}

		// Update cgroup
		capBytes := int64(capGB * float64(gbBytes))
		if err := firecracker.UpdateCgroupMemoryLimit(vc.id, capBytes); err != nil {
			log.Printf("pressure: failed to update cgroup for %s: %v", vc.id, err)
		}

		// Track the cap we set
		if u, ok := pm.usages[vc.id]; ok {
			u.CgroupCapGB = capGB
		}
	}
}

func (pm *PressureMonitor) flushBilling() {
	if pm.onFlush == nil {
		return
	}

	pm.mu.RLock()
	var flushes []UsageFlush
	for _, u := range pm.usages {
		if u.AccumVCPUSeconds > 0 || u.AccumGBSeconds > 0 {
			flushes = append(flushes, UsageFlush{
				SandboxID:   u.SandboxID,
				VCPUSeconds: u.AccumVCPUSeconds,
				GBSeconds:   u.AccumGBSeconds,
			})
		}
	}
	pm.mu.RUnlock()

	if len(flushes) > 0 {
		pm.onFlush(flushes)
	}
}

// FinalizeUsage returns and resets the accumulated usage for a sandbox.
// Called when a sandbox is killed or hibernated to get the final billing data.
func (pm *PressureMonitor) FinalizeUsage(sandboxID string) (vcpuSeconds, gbSeconds float64) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	u, ok := pm.usages[sandboxID]
	if !ok {
		return 0, 0
	}
	vcpuSeconds = u.AccumVCPUSeconds
	gbSeconds = u.AccumGBSeconds
	delete(pm.usages, sandboxID)
	return
}

// classifyState returns a state label based on current memory usage.
func classifyState(memGB float64) string {
	switch {
	case memGB < 0.5:
		return "idle"
	case memGB < 1.5:
		return "light"
	case memGB < 4.0:
		return "medium"
	default:
		return "heavy"
	}
}

// SystemRAMBytes reads total system RAM from /proc/meminfo.
func SystemRAMBytes() int64 {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = ctx
	// Read from /proc/meminfo
	data, err := readProcMeminfo()
	if err != nil {
		// Fallback: 512GB (r7gd.metal)
		return 512 * gbBytes
	}
	return data
}

func readProcMeminfo() (int64, error) {
	// Already implemented in stats.go — we just need the total
	// Parse MemTotal from /proc/meminfo
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, err := strconv.ParseInt(fields[1], 10, 64)
				if err != nil {
					return 0, err
				}
				return kb * 1024, nil // convert KB to bytes
			}
		}
	}
	return 0, fmt.Errorf("MemTotal not found in /proc/meminfo")
}
