package awsvm

import (
	"errors"
	"testing"
	"time"
)

// The bug these cover: a stocked box's agent channel that went bad was never
// replaced. warmTunnels healed a MISSING channel by re-dialling, but a channel
// that was present-and-dead only ever got ClientConn.Connect() — a no-op on a
// conn already in TransientFailure — so the pool decayed monotonically and every
// exec that landed on one of those boxes paid a full cold dial. Measured on dev
// at a 130-box pool: 75 live tunnels, then 55, then 30.

func TestFailedPingRetiresChannelForRedial(t *testing.T) {
	p, _ := testPool(t, PoolConfig{TargetStock: 2})

	entry := &StockEntry{MicrovmID: "mvm-dead"}
	entry.agent = &agentConn{}
	live := []*StockEntry{entry}
	boom := errors.New("agent tunnel handshake: 401")

	// One failure is forgiven: a box that is merely mid-resume must not have a
	// working tunnel churned out from under it.
	ok, failed, retired, dead, sample := p.applyPingResults(live, []error{boom})
	if ok != 0 || failed != 1 || retired != 0 {
		t.Fatalf("first failure: ok=%d failed=%d retired=%d, want 0/1/0", ok, failed, retired)
	}
	if len(dead) != 0 {
		t.Fatalf("first failure closed %d channel(s), want 0", len(dead))
	}
	if entry.agent == nil {
		t.Fatal("first failure cleared the channel; one blip must be tolerated")
	}
	if sample == nil {
		t.Fatal("sampled error not returned — an unexplained failure count is what hid this bug")
	}

	// The second consecutive failure retires it, so the bounded re-dial path
	// rebuilds it next tick with a freshly minted token.
	_, _, retired, dead, _ = p.applyPingResults(live, []error{boom})
	if retired != 1 {
		t.Fatalf("retired = %d after %d consecutive failures, want 1", retired, maxAgentPingFailures)
	}
	if len(dead) != 1 {
		t.Fatalf("returned %d channel(s) to close, want 1 — not closing it leaks the socket", len(dead))
	}
	if entry.agent != nil {
		t.Fatal("agent still set after retirement; warmTunnels only re-dials entries with agent == nil")
	}
}

func TestSuccessfulPingResetsTheFailureRun(t *testing.T) {
	p, _ := testPool(t, PoolConfig{TargetStock: 2})

	entry := &StockEntry{MicrovmID: "mvm-flaky"}
	entry.agent = &agentConn{}
	live := []*StockEntry{entry}

	// Fail, recover, fail: the run is broken by the success, so this must not
	// count as two consecutive failures and retire a working channel.
	p.applyPingResults(live, []error{errors.New("timeout")})
	p.applyPingResults(live, []error{nil})
	if entry.agentFailures != 0 {
		t.Fatalf("agentFailures = %d after a success, want 0", entry.agentFailures)
	}
	_, _, retired, _, _ := p.applyPingResults(live, []error{errors.New("timeout")})
	if retired != 0 {
		t.Fatalf("retired a channel whose failures were not consecutive")
	}
	if entry.agent == nil {
		t.Fatal("cleared the channel of a box that answered in between")
	}
}

// A box claimed between the ping and the fold-back has had its channel handed to
// the manager, which clears this field. Closing the conn we pinged would tear
// down a live customer's tunnel.
func TestRetirementNeverClosesAChannelTheEntryNoLongerHolds(t *testing.T) {
	p, _ := testPool(t, PoolConfig{TargetStock: 2})

	entry := &StockEntry{MicrovmID: "mvm-claimed"}
	entry.agent = &agentConn{}
	live := []*StockEntry{entry}
	boom := errors.New("unavailable")

	p.applyPingResults(live, []error{boom})
	// TrackClaimed transfers ownership and clears the field.
	entry.agent = nil

	_, _, retired, dead, _ := p.applyPingResults(live, []error{boom})
	if retired != 0 || len(dead) != 0 {
		t.Fatalf("retired=%d closed=%d for an entry that no longer owns its channel, want 0/0", retired, len(dead))
	}
}

// The same defect lived on the edge-reservation path, where it matters more:
// these boxes are one claim away from a customer, so a dead channel here IS the
// cold dial on someone's first exec. warm() could only call Connect() (a no-op
// in TransientFailure) and get() deliberately left every non-Shutdown state
// alone, so nothing ever replaced a channel that had gone bad.
func TestDropIfOnlyRetiresTheChannelThatFailed(t *testing.T) {
	p := newAgentPool()
	failed := &agentConn{}
	p.conns["sb-1"] = failed

	if !p.dropIf("sb-1", failed) {
		t.Fatal("dropIf refused to retire the channel it was given")
	}
	if _, still := p.conns["sb-1"]; still {
		t.Fatal("channel still cached after retirement; get() re-dials only on a miss")
	}

	// The hazard: the box is claimed between the ping and the retirement, and
	// put() installs a fresh channel for its new owner. Retiring by id alone
	// would close that one and hand the customer a broken tunnel.
	fresh := &agentConn{}
	p.conns["sb-2"] = fresh
	stale := &agentConn{}
	if p.dropIf("sb-2", stale) {
		t.Fatal("dropIf closed a channel that had already been replaced")
	}
	if p.conns["sb-2"] != fresh {
		t.Fatal("the new owner's channel was evicted")
	}
}

func TestPingTrackedForgetsFailureCountsForUnreservedBoxes(t *testing.T) {
	p := newAgentPool()
	// Left over from a box that stopped being reserved while mid-failure. Without
	// pruning, this map grows for the process's lifetime.
	p.failures["sb-gone"] = 1

	p.pingTracked(t.Context(), map[string]struct{}{"sb-here": {}})
	if _, leaked := p.failures["sb-gone"]; leaked {
		t.Fatal("failure count retained for a box that is no longer reserved")
	}
}

// The idle-timer touch is the ONLY thing in this package AWS's idle accounting
// can see — an h2 PING inside an established tunnel is not inbound proxy
// traffic. So the one property that matters is that the touch cadence stays
// comfortably inside whatever idle window the box was launched with, for every
// window someone might configure. Getting this wrong does not fail loudly: the
// box is suspended, answers 502, and is terminated half an hour later.
func TestIdleTouchIntervalStaysInsideTheIdleWindow(t *testing.T) {
	for _, tc := range []struct {
		name      string
		windowSec int32
		want      time.Duration
		mustCover bool // the interval must leave room for two missed touches
	}{
		// The 8h ceiling, which is the default. A literal third would be 2h40m —
		// long enough that a window lowered elsewhere would go unnoticed for
		// hours, so the ceiling clamp holds it at 15 minutes.
		{name: "8h ceiling", windowSec: 28_800, want: 15 * time.Minute, mustCover: true},
		// The old default, and the one that was actually suspending stock.
		{name: "old 15m default", windowSec: 900, want: 5 * time.Minute, mustCover: true},
		// The service minimum. A third is 20s, floored to a minute — which no
		// longer covers two missed touches, and cannot: we refuse to send a
		// network request per box more often than that.
		{name: "service minimum", windowSec: 60, want: time.Minute, mustCover: false},
		// Unset — the pool must still touch on some sane cadence rather than
		// treating "no window" as "never suspends".
		{name: "unconfigured", windowSec: 0, want: 5 * time.Minute, mustCover: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := NewClientWithAPI(&poolAPI{}, Config{
				ImageIdentifier:        "arn:image",
				MaxIdleDurationSeconds: tc.windowSec,
			})
			// Config.applyDefaults raises a zero window to the ceiling, so drive
			// the unconfigured case through the field the method actually reads.
			if tc.windowSec == 0 {
				c.cfg.MaxIdleDurationSeconds = 0
			}
			got := NewPool(c, PoolConfig{TargetStock: 1}).idleTouchInterval()
			if got != tc.want {
				t.Fatalf("idleTouchInterval() = %s, want %s", got, tc.want)
			}
			if got < time.Minute {
				t.Fatalf("interval %s would touch every box more than once a minute", got)
			}
			window := time.Duration(tc.windowSec) * time.Second
			if tc.mustCover && tc.windowSec > 0 && got*3 > window {
				t.Fatalf("interval %s leaves no room for two missed touches inside a %s window", got, window)
			}
		})
	}
}

func TestPingEachReportsPerIndexSoFailuresCanBeAttributed(t *testing.T) {
	// A nil client pings OK (see agentConn.ping), which is enough to prove the
	// result slice stays aligned with the input — the property retirement relies
	// on to map a failure back to the entry that owns the channel.
	conns := []*agentConn{{}, {}, {}}
	errs := pingEach(t.Context(), conns)
	if len(errs) != len(conns) {
		t.Fatalf("pingEach returned %d results for %d conns", len(errs), len(conns))
	}
	ok, failed := pingAll(t.Context(), conns)
	if ok != 3 || failed != 0 {
		t.Fatalf("pingAll = %d ok / %d failed, want 3/0", ok, failed)
	}
}
