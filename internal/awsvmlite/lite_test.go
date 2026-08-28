package awsvmlite

import (
	"testing"
	"time"
)

// The touch interval and the connection idle timeout are one mechanism, not two
// settings. The touch is a real HTTPS request, so it is what keeps the box's
// keep-alive connection open; if boxes are touched LESS often than connections
// are reaped, every connection lapses partway through every gap and some exec
// pays ~180ms of TCP+TLS to reopen it.
//
// That is not hypothetical. Dev ran touch=300s against idleConnTimeout=90s, and
// control-plane exec round-trips came back bimodal at ~83ms or ~260ms with the
// guest reporting 11-13ms of actual command in both cases.
func TestTouchIntervalStaysUnderTheConnectionIdleTimeout(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   time.Duration
	}{
		{"unset", 0},
		{"the old default that caused the lapse", 5 * time.Minute},
		{"exactly the idle timeout", idleConnTimeout},
		{"absurdly long", time.Hour},
		{"already short enough", 30 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := Config{TouchInterval: tc.in}
			c.applyDefaults()
			if c.TouchInterval >= idleConnTimeout {
				t.Fatalf("TouchInterval %s >= idleConnTimeout %s — connections will lapse between touches",
					c.TouchInterval, idleConnTimeout)
			}
			if c.TouchInterval <= 0 {
				t.Fatalf("TouchInterval %s — nothing would ever be touched", c.TouchInterval)
			}
		})
	}
}

// A short interval must be honoured rather than overwritten, or the clamp above
// would quietly become "always 60s" and no caller could tighten it.
func TestAShortTouchIntervalIsLeftAlone(t *testing.T) {
	c := Config{TouchInterval: 20 * time.Second}
	c.applyDefaults()
	if c.TouchInterval != 20*time.Second {
		t.Fatalf("TouchInterval = %s, want the configured 20s", c.TouchInterval)
	}
}

// The tick that scans for due boxes has to be finer than the interval itself.
// A box becomes due at TouchInterval and is only touched on the following tick,
// so the real worst-case gap is interval + tick — and if that reaches
// idleConnTimeout the clamp above has bought nothing. This pins the arithmetic
// the Run loop does.
func TestTouchTickKeepsTheWorstCaseGapUnderTheIdleTimeout(t *testing.T) {
	for _, in := range []time.Duration{0, 5 * time.Minute, 30 * time.Second, time.Hour} {
		c := Config{TouchInterval: in}
		c.applyDefaults()

		tick := c.TouchInterval / 4
		if tick < 5*time.Second {
			tick = 5 * time.Second
		}
		if worst := c.TouchInterval + tick; worst >= idleConnTimeout {
			t.Fatalf("in=%s: worst-case gap %s (interval %s + tick %s) >= idleConnTimeout %s",
				in, worst, c.TouchInterval, tick, idleConnTimeout)
		}
	}
}

// Delivered sizing, not requested. Warm stock is built from one image before
// anyone asks for it, so a claim cannot change what the customer physically
// gets — and recording the request instead of the delivery is what turns a
// wrong-size box into a wrong bill.
func TestDeliveredSizeFallsBackToTheImageRatherThanZero(t *testing.T) {
	m := &Manager{} // no client — must degrade to defaults, not panic on a claim
	got := m.delivered(Meta{})
	if got.CPUCount <= 0 {
		t.Fatalf("CPUCount = %d, want a positive default — a sandbox metered at 0 CPUs is billed as free",
			got.CPUCount)
	}

	// An explicitly requested size must survive when there is nothing to resolve
	// it against, rather than being zeroed.
	if got := m.delivered(Meta{MemoryMB: 8192, CPUCount: 4}); got.MemoryMB != 8192 || got.CPUCount != 4 {
		t.Fatalf("delivered = %dMB/%dcpu, want the requested 8192MB/4cpu", got.MemoryMB, got.CPUCount)
	}
}

// A box AWS has terminated must leave the warm set, or Depth() keeps counting it,
// the filler believes it is at target and launches nothing, and every claim pops
// a corpse. AWS terminates a microvm at its 8h service cap, so a pool filled in
// one go reaches that state all at once — the failure is total, not gradual.
func TestDropWarmLockedRemovesOnlyTheDeadBoxes(t *testing.T) {
	m := &Manager{warm: []*Box{
		{MicrovmID: "a"}, {MicrovmID: "b"}, {MicrovmID: "c"}, {MicrovmID: "d"},
	}}
	got := m.dropWarmLocked(map[string]struct{}{"b": {}, "d": {}})
	if got != 2 {
		t.Fatalf("evicted %d, want 2", got)
	}
	var left []string
	for _, b := range m.warm {
		left = append(left, b.MicrovmID)
	}
	if len(left) != 2 || left[0] != "a" || left[1] != "c" {
		t.Fatalf("warm = %v, want [a c]", left)
	}
	// The survivors must not be nil — a botched in-place rebuild shows up here
	// rather than as a panic on the next claim.
	for i, b := range m.warm {
		if b == nil {
			t.Fatalf("warm[%d] is nil after eviction", i)
		}
	}
}

func TestDropWarmLockedIsANoOpWhenNothingIsDead(t *testing.T) {
	m := &Manager{warm: []*Box{{MicrovmID: "a"}, {MicrovmID: "b"}}}
	if got := m.dropWarmLocked(nil); got != 0 {
		t.Fatalf("evicted %d, want 0", got)
	}
	if len(m.warm) != 2 {
		t.Fatalf("warm len %d, want 2", len(m.warm))
	}
}
