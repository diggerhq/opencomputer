package worker

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/sandbox"
)

// decodeTicks pulls the usage_tick payloads a ticker wrote for a sandbox.
func decodeTicks(t *testing.T, dbs *sandbox.SandboxDBManager, sandboxID string) []map[string]any {
	t.Helper()
	sdb, err := dbs.Get(sandboxID)
	if err != nil {
		t.Fatalf("open sandbox db: %v", err)
	}
	evs, err := sdb.GetUnsyncedEvents(100)
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	var out []map[string]any
	for _, e := range evs {
		if e.Type != "usage_tick" {
			continue
		}
		var p map[string]any
		if err := json.Unmarshal([]byte(e.Payload), &p); err != nil {
			t.Fatalf("payload not json: %v", err)
		}
		out = append(out, p)
	}
	return out
}

// The closing slice must be marked `final`, and an ordinary mid-life slice must
// not be.
//
// This flag is the difference between a sandbox being billed and being free.
// events-ingest discards usage_ticks for sandboxes already terminal in its
// index — correct for a straggler, and exactly wrong for the tick emitted BY
// the destroy. Unflagged, the closing slice is dropped, so any sandbox that
// lived and died inside one 20s sampling window bills nothing at all. Measured
// on dev: 2,685 such slices discarded.
//
// Scale is the control. It also flushes a slice, but the sandbox keeps running
// and keeps being sampled, so it is NOT final — marking it so would let a tick
// bypass the terminal check for a sandbox that is genuinely still alive.
func TestClosingSliceIsMarkedFinalAndMidLifeSliceIsNot(t *testing.T) {
	dbs := sandbox.NewSandboxDBManager(t.TempDir())
	ticker := newTestTicker(20*time.Second, 10)
	ticker.sandboxDBs = dbs
	startedAt := time.Now().Add(-4 * time.Second)

	ticker.OnSandboxDestroy("sb-destroyed", 4096, 1, startedAt)
	ticker.OnSandboxHibernate("sb-parked", 4096, 1, startedAt)
	ticker.OnSandboxScale("sb-resized", 4096, 1, startedAt)

	for _, tc := range []struct {
		sandboxID string
		wantFinal bool
		why       string
	}{
		{"sb-destroyed", true, "a destroy ends the sandbox; its closing slice is the only record a short-lived sandbox ever produces"},
		{"sb-parked", true, "a hibernate stops it being billable until wake, so the slice before parking is closing too"},
		{"sb-resized", false, "a scale flushes a slice but the sandbox keeps running and keeps being sampled"},
	} {
		ticks := decodeTicks(t, dbs, tc.sandboxID)
		if len(ticks) != 1 {
			t.Fatalf("%s: got %d usage_tick(s), want exactly 1 — a duplicate would double-bill now that these are no longer discarded", tc.sandboxID, len(ticks))
		}
		got, _ := ticks[0]["final"].(bool)
		if got != tc.wantFinal {
			t.Errorf("%s: final=%v, want %v — %s", tc.sandboxID, got, tc.wantFinal, tc.why)
		}
		// The slice has to carry what it is priced on, or the consumer inserts a
		// zero-sized sample and the sandbox is billed for nothing anyway.
		if ticks[0]["memory_mb"] == nil || ticks[0]["interval_s"] == nil {
			t.Errorf("%s: slice missing pricing dimensions: %v", tc.sandboxID, ticks[0])
		}
	}
}
