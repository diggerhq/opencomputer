package awsvmlite

// hibernate.go — parking a sandbox by suspending its box.
//
// The agent path hibernates by EXPORTING the workspace to blob storage and then
// suspending, which makes the archive the durable copy and the suspended box a
// disposable latency cache. That design exists because it needs to be able to
// terminate the box: a suspended box holds regional memory quota, and quota is
// what caps warm-pool depth.
//
// This path has no file transfer on its hot side and does not want one here
// either, so hibernation is the suspend alone:
//
//	hibernate  SuspendMicrovm — memory and disk snapshotted, compute unbilled
//	wake       the next request auto-resumes; Resume just pays it earlier
//
// WHAT THIS BUYS: the customer stops paying for an idle sandbox, and the wake is
// a resume (~1s) rather than a restore. WHAT IT DOES NOT BUY: longevity. AWS
// counts RUNNING and SUSPENDED time together against the 8h service cap, so a
// suspended sandbox still dies on the same schedule — hibernation defers cost,
// not death.
//
// AND THE COST: because there is no archive, the box can never be terminated to
// reclaim its quota. A suspended sandbox holds a slot in the regional memory
// quota for as long as it exists, and that quota is the ceiling on how deep the
// warm pool can be. Parking is therefore not free to the fleet even though it
// is free to the customer, which is why suspendedCap exists below.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"
)

// defaultSuspendedCap bounds how many sandboxes may sit suspended at once.
//
// OURS, NOT AWS'S. There is no service limit on suspended microvms; this is a
// guard we impose on the quota that funds the warm pool. Every suspended box is
// a box the pool cannot have, and unlike the agent path — which exports an
// archive first and can therefore terminate the box — there is nothing here
// that would let one be reclaimed. A parked sandbox holds its slot until the 8h
// cap kills it.
//
// The arithmetic it is drawn from: the regional quota is expressed in gigabytes
// (1024 by default, adjustable), and a box costs its image's delivered size
// regardless of what the create asked for. At the default 4096 MB that is
// 1024/4 = 256 boxes for the whole cell, against a prod pool target of 150. So
// 64 is roughly a quarter of the fleet, chosen to leave the pool intact rather
// than measured against real hibernate demand — which nobody has yet, because
// this is the first release that can hibernate at all.
//
// Past the cap, hibernate is REFUSED and the sandbox keeps running. That costs
// the customer money and is the right way round: the alternative, letting
// parked sandboxes quietly eat the pool, turns into cold launches for every
// customer on the cell and is far harder to diagnose.
const defaultSuspendedCap = 64

// suspendedCap reports the effective cap. Tunable per deployment for the same
// reason OPENSANDBOX_MICROVM_MAX_TOTAL_BOXES is: the quota it protects is a
// property of the account and region, not of this code.
func (m *Manager) suspendedCap() int {
	if m.cfg.SuspendedCap > 0 {
		return m.cfg.SuspendedCap
	}
	return defaultSuspendedCap
}

// Hibernate suspends the box behind a sandbox.
//
// Returns no archive key: there is no archive. The caller records the
// hibernation against the sandbox row, and the box itself holds the state.
func (m *Manager) Hibernate(ctx context.Context, sandboxID string) error {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}

	m.mu.Lock()
	if _, already := m.suspended[sandboxID]; already {
		m.mu.Unlock()
		// Idempotent: a retried hibernate must not fail, and must not issue a
		// second SuspendMicrovm against a box that is already parked.
		return nil
	}
	if cap := m.suspendedCap(); len(m.suspended) >= cap {
		n := len(m.suspended)
		m.mu.Unlock()
		return fmt.Errorf("awsvmlite: %d sandboxes are already suspended (cap %d): "+
			"suspended boxes hold regional memory quota and cannot be reclaimed", n, cap)
	}
	// Marked BEFORE the AWS call, not after. The touch loop auto-resumes any box
	// it probes, so a box that is suspended while still unmarked would be woken
	// by the very next tick — the hibernation would appear to succeed and then
	// silently undo itself, with the customer billed throughout.
	if m.suspended == nil {
		m.suspended = map[string]time.Time{}
	}
	m.suspended[sandboxID] = time.Now()
	m.mu.Unlock()

	// Bill the slice before parking. Once suspended the sandbox reports as
	// unbillable (see SandboxManager.IsSandboxAlive) and the ticker stops
	// sampling it, so anything since the last sample has to be taken now.
	m.mu.Lock()
	obs := m.lifecycleObs
	m.mu.Unlock()
	if obs != nil {
		obs.OnSandboxHibernate(sandboxID, b.Meta.MemoryMB, b.Meta.CPUCount, b.boundAt)
	}
	if err := m.client.Suspend(ctx, b.MicrovmID); err != nil {
		// Unmark, or the sandbox is treated as parked — excluded from billing
		// and from the touch loop — while actually running.
		m.mu.Lock()
		delete(m.suspended, sandboxID)
		m.mu.Unlock()
		return err
	}
	log.Printf("awsvmlite: hibernated %s (box %s) — suspended, %d/%d parked",
		sandboxID, b.MicrovmID, len(m.suspended), m.suspendedCap())
	return nil
}

// Wake resumes a suspended sandbox.
//
// The explicit Resume is optional in principle — Lambda holds an inbound
// request while it restores, so the next exec would resume the box on its own —
// but it is issued anyway so that a wake reports its own success. Relying on
// auto-resume would mean the API returned 200 for a wake it never verified, and
// a box that failed to restore would surface as a mysteriously slow exec
// minutes later instead.
func (m *Manager) Wake(ctx context.Context, sandboxID string) error {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	if err := m.client.Resume(ctx, b.MicrovmID); err != nil {
		return err
	}
	// Resume only ASKS the provider to restore the host; the guest is not
	// serving the moment it returns. Waking and immediately using the sandbox
	// is the normal shape of the request, and without this wait the customer's
	// first call lands on a box that is still restoring and gets a 502 — a wake
	// that reports success and then does not work.
	if err := m.waitGuestReady(ctx, b); err != nil {
		// Unmarking anyway: the host IS resumed, so leaving it flagged as
		// parked would exclude it from billing and let the touch loop treat it
		// as stock. Report the error so the caller does not claim readiness.
		m.mu.Lock()
		delete(m.suspended, sandboxID)
		m.mu.Unlock()
		return fmt.Errorf("awsvmlite: woke %s but it did not become ready: %w", sandboxID, err)
	}
	m.mu.Lock()
	delete(m.suspended, sandboxID)
	// Count the resume as a touch. Otherwise the box is immediately due for one
	// and pays a probe it does not need.
	b.lastTouch = time.Now()
	obs := m.lifecycleObs
	m.mu.Unlock()
	// Restart the billing interval at the wake rather than letting the next
	// sample measure from before the sandbox was parked.
	if obs != nil {
		obs.OnSandboxWake(sandboxID)
	}
	log.Printf("awsvmlite: woke %s (box %s)", sandboxID, b.MicrovmID)
	return nil
}

// IsHibernated reports whether a sandbox is parked.
//
// Load-bearing in two places that both fail silently: billing (a suspended box
// still reports Alive() to AWS, so metering has to be told separately) and the
// touch loop (a probe auto-resumes what it touches).
func (m *Manager) IsHibernated(sandboxID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.suspended[sandboxID]
	return ok
}

// SuspendedCount reports how many sandboxes are parked, for the admin view.
func (m *Manager) SuspendedCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.suspended)
}

// waitGuestReady polls the guest's health endpoint until it answers or the
// configured ready timeout elapses.
//
// The same probe the keep-warm loop uses, for the same reason it exists: it is
// served by the in-guest front door, so a 200 means the thing that actually
// handles customer requests is up — not merely that the provider says the host
// is RUNNING.
func (m *Manager) waitGuestReady(ctx context.Context, b *Box) error {
	timeout := m.cfg.ReadyTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for attempt := 0; time.Now().Before(deadline); attempt++ {
		resp, err := m.do(ctx, b, http.MethodGet, healthPath, nil)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 400 {
				return nil
			}
			lastErr = fmt.Errorf("health returned %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("timed out after %s", timeout)
	}
	return lastErr
}
