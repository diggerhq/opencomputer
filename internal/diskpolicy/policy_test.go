package diskpolicy

import "testing"

// The ladder only works in order. Each rung is a different actor reacting to
// the same disk, and reordering any two of them produces a system that fights
// itself rather than one that escalates.

// The invariant the whole package exists for: the cache must release space
// before the scaler spends any.
//
// Violate this and you get the 2026-08 failure mode back — a worker sitting at
// 79% full with the scaler adding capacity and migrating customer VMs, while
// the cache holds hundreds of gigabytes it considers legitimately in use. The
// scaler cannot win that fight: evacuating a sandbox frees its directory, and
// the bytes occupying the disk are cache it never touches.
func TestCacheEvictsBeforeScalerActs(t *testing.T) {
	if CacheEvictPct >= ScaleUpPct {
		t.Fatalf("CacheEvictPct (%.0f) must be below ScaleUpPct (%.0f) — otherwise the scaler "+
			"launches workers to relieve pressure the cache could have released for free",
			CacheEvictPct, ScaleUpPct)
	}
	if CacheEvictPct >= EvacuatePct {
		t.Fatalf("CacheEvictPct (%.0f) must be below EvacuatePct (%.0f) — otherwise live customer "+
			"VMs are migrated to reclaim space the cache was still holding",
			CacheEvictPct, EvacuatePct)
	}
}

// The full ordering. Written out rung by rung because the failure of any single
// pair is its own distinct incident, and a generic "sorted" assertion would
// report the wrong one.
func TestLadderIsOrdered(t *testing.T) {
	rungs := []struct {
		name string
		pct  float64
	}{
		{"CacheEvictPct", CacheEvictPct},
		{"ScaleUpPct", ScaleUpPct},
		{"EvacuatePct", EvacuatePct},
		{"RoutingExcludePct", RoutingExcludePct},
		{"EmergencyPct", EmergencyPct},
	}
	for i := 1; i < len(rungs); i++ {
		if rungs[i-1].pct >= rungs[i].pct {
			t.Errorf("%s (%.0f) must be below %s (%.0f): the ladder escalates, so a later "+
				"rung firing first means the cheaper response never gets a chance",
				rungs[i-1].name, rungs[i-1].pct, rungs[i].name, rungs[i].pct)
		}
	}
}

// Headroom between the cache and the scaler is deliberate, not incidental.
//
// Without a gap, a burst of sandbox writes crossing the cache threshold trips
// the scaler in the same instant — before eviction has had a sweep interval to
// take effect. The gap is what turns "the cache is about to give space back"
// into a state the scaler never has to react to.
func TestCacheHasHeadroomBeforeScaleUp(t *testing.T) {
	const minHeadroom = 5.0
	if got := ScaleUpPct - CacheEvictPct; got < minHeadroom {
		t.Fatalf("only %.0f points between CacheEvictPct and ScaleUpPct, want at least %.0f — "+
			"a write burst would trip the scaler before eviction could take effect", got, minHeadroom)
	}
}

// Every rung is a percentage of a volume. A value outside 0-100 is a typo that
// would silently disable whichever actor reads it.
func TestRungsArePercentages(t *testing.T) {
	for _, r := range []struct {
		name string
		pct  float64
	}{
		{"CacheEvictPct", CacheEvictPct},
		{"ScaleUpPct", ScaleUpPct},
		{"EvacuatePct", EvacuatePct},
		{"RoutingExcludePct", RoutingExcludePct},
		{"EmergencyPct", EmergencyPct},
	} {
		if r.pct <= 0 || r.pct >= 100 {
			t.Errorf("%s = %.0f is not a usable fill percentage", r.name, r.pct)
		}
	}
}
