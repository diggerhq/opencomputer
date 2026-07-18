package controlplane

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/alert"
)

// rollHealthConfig tunes the roll-stuck detector.
type rollHealthConfig struct {
	// Deadline is how long a condition (version skew or creation backoff) may
	// persist before it's treated as a stuck roll worth alerting. A healthy
	// rolling replace converges well under this. Default 45m.
	Deadline time.Duration
	// clearGrace tolerates brief gaps — e.g. the creation-backoff window
	// expiring for a single tick between retries — without resetting the
	// persistence timer. Default 3m.
	clearGrace time.Duration
}

// rollFleetSnapshot is the per-region view the monitor evaluates each tick.
type rollFleetSnapshot struct {
	region        string
	targetVersion string
	workers       []*WorkerInfo
	backoffActive bool
	backoffUntil  time.Time
}

// rollHealthMonitor watches for a rolling replace that has stopped making
// progress and alerts (subject to the alerter's cooldown). It covers the two
// failure modes we've actually hit in prod:
//
//   - version skew: workers stuck on an old worker_version long after the roll
//     should have finished — a wedged drain, workers that won't come up, etc.
//   - creation backoff: the scaler can't launch replacement workers at all
//     (Azure core quota / capacity exhausted), so the roll can never proceed.
//
// A single deadline separates a normal in-flight roll from a stuck one, so it
// needs no per-worker drain state: if skew persists past the deadline it's
// stuck regardless of the reason.
type rollHealthMonitor struct {
	alerter  alert.Alerter
	deadline time.Duration
	grace    time.Duration
	now      func() time.Time

	mu        sync.Mutex
	firstSeen map[string]time.Time // condition key -> when it began
	lastSeen  map[string]time.Time // condition key -> last tick it was true
}

func newRollHealthMonitor(alerter alert.Alerter, cfg rollHealthConfig) *rollHealthMonitor {
	if alerter == nil {
		alerter = alert.Nop{}
	}
	deadline := cfg.Deadline
	if deadline <= 0 {
		deadline = 45 * time.Minute
	}
	grace := cfg.clearGrace
	if grace <= 0 {
		grace = 3 * time.Minute
	}
	return &rollHealthMonitor{
		alerter:   alerter,
		deadline:  deadline,
		grace:     grace,
		now:       time.Now,
		firstSeen: map[string]time.Time{},
		lastSeen:  map[string]time.Time{},
	}
}

// observe evaluates one region snapshot, advancing persistence timers and
// firing alerts for conditions that have been continuously true past the
// deadline. Safe to call every scaler tick; the alerter dedups repeats.
func (m *rollHealthMonitor) observe(ctx context.Context, snap rollFleetSnapshot) {
	now := m.now()

	// --- version skew: workers not yet on the target version ---
	stale := staleWorkers(snap)
	skewKey := "roll_skew:" + snap.region
	if len(stale) > 0 {
		if since, firing := m.track(skewKey, now); firing {
			m.alerter.Send(ctx, alert.Alert{
				Severity: alert.Critical,
				Title:    fmt.Sprintf("rolling replace stuck in %s", snap.region),
				Detail: fmt.Sprintf("%d/%d workers still not on target version %q after ~%s. Stale: %s",
					len(stale), len(snap.workers), snap.targetVersion, roundDur(now.Sub(since)), strings.Join(staleIDs(stale), ", ")),
				DedupKey: skewKey,
			})
		}
	} else {
		m.reset(skewKey, now)
	}

	// --- creation backoff: scaler cannot launch replacement workers ---
	backoffKey := "roll_backoff:" + snap.region
	if snap.backoffActive {
		if since, firing := m.track(backoffKey, now); firing {
			m.alerter.Send(ctx, alert.Alert{
				Severity: alert.Critical,
				Title:    fmt.Sprintf("scaler cannot create workers in %s", snap.region),
				Detail: fmt.Sprintf("creation backoff active for ~%s (until %s) — likely core quota or capacity exhausted. Scale-up and rolling replace are blocked until this clears.",
					roundDur(now.Sub(since)), snap.backoffUntil.Format(time.RFC3339)),
				DedupKey: backoffKey,
			})
		}
	} else {
		m.reset(backoffKey, now)
	}
}

// track records that a condition is true at now and reports whether it has
// persisted past the deadline. The first observation starts the timer.
func (m *rollHealthMonitor) track(key string, now time.Time) (since time.Time, firing bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	first, ok := m.firstSeen[key]
	if !ok {
		first = now
		m.firstSeen[key] = first
	}
	m.lastSeen[key] = now
	return first, now.Sub(first) >= m.deadline
}

// reset is called on a tick where the condition is false. It clears the timers
// only after the condition has been false longer than the grace window, so a
// one-tick flicker doesn't discard accumulated progress.
func (m *rollHealthMonitor) reset(key string, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	last, ok := m.lastSeen[key]
	if !ok {
		return
	}
	if now.Sub(last) >= m.grace {
		delete(m.firstSeen, key)
		delete(m.lastSeen, key)
	}
}

// staleWorkers returns workers whose reported version differs from the target.
// A worker with no reported version yet is ignored (still registering).
func staleWorkers(snap rollFleetSnapshot) []*WorkerInfo {
	if snap.targetVersion == "" {
		return nil
	}
	var out []*WorkerInfo
	for _, w := range snap.workers {
		if w.WorkerVersion != "" && w.WorkerVersion != snap.targetVersion {
			out = append(out, w)
		}
	}
	return out
}

func staleIDs(ws []*WorkerInfo) []string {
	out := make([]string, 0, len(ws))
	for _, w := range ws {
		out = append(out, fmt.Sprintf("%s(%s)", w.ID, w.WorkerVersion))
	}
	sort.Strings(out)
	return out
}

// roundDur rounds a duration to a readable granularity for alert text.
func roundDur(d time.Duration) time.Duration {
	if d >= time.Minute {
		return d.Round(time.Minute)
	}
	return d.Round(time.Second)
}
