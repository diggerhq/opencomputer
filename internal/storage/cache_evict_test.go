package storage

import (
	"context"
	"testing"

	"github.com/opensandbox/opensandbox/internal/diskpolicy"
)

// cache_evict_test.go — when the checkpoint cache gives space back.
//
// Getting this wrong does not look like a cache bug. It looks like a scaler
// that will not stop launching workers, because the scaler is reacting to disk
// the cache is holding and only the cache can release.

// The reserve must be whatever the shared ladder says, not a local fraction.
//
// The literal it replaced was `totalBytes / 5` — a 20% reserve, meaning the
// cache happily filled to 80% of the volume. The scaler starts scaling up at
// 60% and evacuating at 70%, so the cache's own definition of "comfortable"
// began 20 points ABOVE the point at which the rest of the system considered
// the box in trouble.
func TestReserveTracksTheSharedLadder(t *testing.T) {
	const total = 1000

	got := cacheReserveBytes(total)
	want := uint64(float64(total) * (100 - diskpolicy.CacheEvictPct) / 100)
	if got != want {
		t.Fatalf("reserve = %d, want %d (%.0f%% free)", got, want, 100-diskpolicy.CacheEvictPct)
	}

	// The property that matters, stated independently of the formula: the cache
	// must still consider itself over budget at a fill level the scaler has
	// already started reacting to.
	usedAtScaleUp := uint64(float64(total) * diskpolicy.ScaleUpPct / 100)
	availAtScaleUp := total - usedAtScaleUp
	if availAtScaleUp > got {
		t.Fatalf("at %.0f%% full the cache still considers itself comfortable "+
			"(avail %d > reserve %d) — the scaler would be adding workers while the cache holds space",
			diskpolicy.ScaleUpPct, availAtScaleUp, got)
	}
}

// The old 20% reserve, pinned as a regression guard. Anyone reintroducing it —
// or any value that lets the cache outgrow the scaler's first rung — trips this.
func TestCacheCannotFillPastTheScalerThreshold(t *testing.T) {
	const total = 1_000_000
	reserve := cacheReserveBytes(total)

	maxCacheFillPct := 100 * float64(total-reserve) / float64(total)
	if maxCacheFillPct >= diskpolicy.ScaleUpPct {
		t.Fatalf("cache may fill to %.0f%% of the volume, at or beyond the scaler's %.0f%% "+
			"scale-up threshold — this is the 60-80%% dead band, restored",
			maxCacheFillPct, diskpolicy.ScaleUpPct)
	}
}

// The sweeper must be inert when caching is disabled. It is started from the
// worker's boot path, where a cache dir is optional, and a nil-guard failure
// there takes down the whole worker rather than degrading one feature.
func TestSweeperIsInertWithoutACacheDir(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var nilStore *CheckpointStore
	nilStore.StartEvictionSweeper(ctx) // must not panic

	(&CheckpointStore{}).StartEvictionSweeper(ctx) // no cacheDir — must not panic

	// And eviction itself must decline rather than statfs("").
	(&CheckpointStore{}).evictIfNeeded()
}
