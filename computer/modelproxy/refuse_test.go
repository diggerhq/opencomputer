package main

import (
	"testing"
	"time"
)

// One log line per caller and reason in refusalLogEvery; the next one says
// how many went unlogged.
func TestRefusalLog(t *testing.T) {
	var l refusalLog
	now := time.Unix(1_800_000_000, 0)
	if ok, skipped := l.allow(now, "a", "route"); !ok || skipped != 0 {
		t.Fatalf("first: %v %d", ok, skipped)
	}
	for range 5 {
		if ok, _ := l.allow(now.Add(time.Second), "a", "route"); ok {
			t.Fatal("logged again within the interval")
		}
	}
	if ok, _ := l.allow(now, "a", "require"); !ok {
		t.Fatal("another reason not logged")
	}
	if ok, _ := l.allow(now, "b", "route"); !ok {
		t.Fatal("another caller not logged")
	}
	if ok, skipped := l.allow(now.Add(refusalLogEvery), "a", "route"); !ok || skipped != 5 {
		t.Fatalf("after the interval: %v %d", ok, skipped)
	}
	// The table is bounded.
	for i := range 3 * refusalLogKeys {
		l.allow(now, string(rune('A'+i%26))+time.Duration(i).String(), "route")
	}
	if len(l.seen) > refusalLogKeys {
		t.Fatalf("table %d", len(l.seen))
	}
}
