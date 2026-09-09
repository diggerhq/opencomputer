package awsvmlite

import (
	"fmt"
	"log"
	"time"
)

// idle.go — the customer-settable idle timeout.
//
// A sandbox that has gone unused for its timeout is PARKED, not destroyed:
// hibernate is suspend on this runtime, which stops the meter while keeping the
// disk, and the customer can wake it. That matches the QEMU fleet, where the
// same timeout drives auto-hibernate rather than a kill, so a customer moving
// between runtimes sees one behaviour.
//
// Two things make this runtime different, and both are visible below:
//
//   - The keepalive already pokes every box on a timer to stop the provider
//     suspending idle stock. Driving an idle policy off that clock would find
//     every sandbox permanently busy. Hence lastUsed, stamped only by customer
//     traffic, distinct from lastTouch.
//
//   - The provider destroys every host at a hard cap regardless of anything we
//     do. A timeout longer than the time remaining to that cap cannot be
//     honoured, so it is refused rather than silently stored — see
//     SetIdleTimeout.

// Coarse on
// purpose: this decides when to stop billing, not when to answer a request, and
// each pass may issue a suspend per expired sandbox against a rate-limited API.
// IdleSweepInterval is how often the control plane collects expired sandboxes.
const IdleSweepInterval = 30 * time.Second

// MarkUsed records customer activity against a sandbox, refreshing its idle
// timeout. Cheap and called on every customer-facing operation; a sandbox this
// process does not hold is silently ignored.
func (m *Manager) MarkUsed(sandboxID string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	if b, ok := m.bound[sandboxID]; ok {
		b.lastUsed = time.Now()
	}
	m.mu.Unlock()
}

// SetIdleTimeout sets how long a sandbox may sit unused before being parked,
// and reports the timeout actually in force.
//
// d <= 0 clears it: the sandbox runs until killed or until the provider's cap
// ends it.
//
// A timeout at or beyond the host's remaining life is NOT stored, and the
// returned duration is zero to say so. The provider terminates the host at its
// cap whatever we do, so accepting a longer timeout would be a promise this
// runtime cannot keep — the sandbox would vanish at the cap while the API
// claimed it had hours left. Refusing is the honest answer, and the row's
// end_at already tells the customer when the host actually dies.
func (m *Manager) SetIdleTimeout(sandboxID string, d time.Duration) (time.Duration, error) {
	if m == nil {
		return 0, fmt.Errorf("awsvmlite: manager unavailable")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.bound[sandboxID]
	if !ok {
		return 0, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	if d <= 0 {
		b.idleTimeout = 0
		b.lastUsed = time.Now()
		return 0, nil
	}
	// Measured against the host's OWN remaining life, not a fixed 8h: a box
	// claimed off the warm set was launched earlier, so it has less than a full
	// cap left, and the honest ceiling is per sandbox.
	if m.client != nil {
		if deadline := m.client.Config().Deadline(b.launchedAt); !deadline.IsZero() {
			if remaining := time.Until(deadline); d >= remaining {
				b.idleTimeout = 0
				b.lastUsed = time.Now()
				log.Printf("awsvmlite: %s: idle timeout %s ignored — the host is destroyed at its cap in %s regardless",
					sandboxID, d, remaining.Truncate(time.Second))
				return 0, nil
			}
		}
	}
	b.idleTimeout = d
	b.lastUsed = time.Now()
	return d, nil
}

// IdleTimeout reports the timeout in force for a sandbox, zero for none.
func (m *Manager) IdleTimeout(sandboxID string) time.Duration {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if b, ok := m.bound[sandboxID]; ok {
		return b.idleTimeout
	}
	return 0
}

// ExpiredIdle lists sandboxes whose idle timeout has elapsed.
//
// Exported because this manager deliberately does NOT park them itself. Parking
// is as much a database transition as a provider call — the row has to move to
// hibernated AND a hibernation record has to exist, or wake answers "no active
// hibernation found" and the sandbox is stranded parked forever. Only the
// control-plane backend can do that, so it owns the sweep and this reports what
// is due. See liteBackend.StartIdleSweeper.
//
// Snapshotted under the lock and acted on outside it: parking a sandbox issues
// a provider call, and holding the manager's mutex across that would stall
// every claim and route on the cell behind a rate-limited API.
func (m *Manager) ExpiredIdle(now time.Time) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for id, b := range m.bound {
		if b.idleTimeout <= 0 {
			continue
		}
		if _, parked := m.suspended[id]; parked {
			continue // already parked; nothing to collect
		}
		// A sandbox that has never been used measures from when it was bound,
		// so a create followed by silence still expires.
		since := b.lastUsed
		if since.IsZero() {
			since = b.boundAt
		}
		if now.Sub(since) >= b.idleTimeout {
			out = append(out, id)
		}
	}
	return out
}
