//go:build pgfixture

// Per-sandbox usage-points correctness against real Postgres. Runs only
// under `go test -tags=pgfixture` with TEST_DATABASE_URL set. The pure-
// Go tests in usage_points_test.go cover SQL shape and validation but
// cannot exercise generate_series, the LEAST/GREATEST overlap clamp,
// or the reconciliation invariant against GetOrgUsage. Those live here.
//
// Run locally:
//
//	TEST_DATABASE_URL=postgres://user:pass@localhost:5432/dbname?sslmode=disable \
//	  go test -tags=pgfixture ./internal/db/ -run UsagePoints -v
package db

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
)

// freshSandboxID picks a sandbox_id that won't collide with prior test
// runs in the same database. The sandbox_usage_samples PK is
// (sandbox_id, sampled_at) — not (org_id, sandbox_id, sampled_at) —
// so even with a fresh orgID, reusing a hardcoded sandbox_id across
// runs can cause ON CONFLICT DO NOTHING to silently drop the new
// fixture data. See the P1 schema gap in the reviewer notes.
func freshSandboxID(prefix string) string {
	return fmt.Sprintf("%s-%s", prefix, uuid.New().String()[:8])
}

// seedSandboxUsagePointsFixture writes a deterministic set of scale
// events and usage samples for a single sandbox, scoped to a fresh
// org UUID so repeated runs don't leak state.
//
// Layout (t0 = `from`):
//
//	scale_event #1:  [t0-1h, t0+6h30s),   memory_mb=2048
//	scale_event #2:  [t0+6h30s, t0+18h),  memory_mb=4096
//
//	samples Phase A: t0 .. t0+(6h-1m)     360 rows, memory_bytes=1.4 GB
//	samples Phase B: t0+6h .. t0+(8h-1m)  120 rows, memory_bytes=2.8 GB
//	samples GAP:     t0+8h .. t0+(9h-1m)  no rows  (60 missing buckets)
//	samples Phase C: t0+9h .. t0+(18h-1m) 540 rows, memory_bytes=3.5 GB
//	(no samples after t0+18h — sandbox stopped)
//
// This shape exercises: resize event mid-bucket (bucket 360), a gap
// where the scale event is still open (allocation accrues, uptime
// reads 0), and post-stop buckets (both zero).
func seedSandboxUsagePointsFixture(t *testing.T, store *Store, orgID uuid.UUID, sandboxID string, t0 time.Time) {
	t.Helper()
	ctx := context.Background()

	resizeAt := t0.Add(6*time.Hour + 30*time.Second)
	stoppedAt := t0.Add(18 * time.Hour)

	insertSE := func(memMB int, started, ended time.Time) {
		if _, err := store.pool.Exec(ctx,
			`INSERT INTO sandbox_scale_events (sandbox_id, org_id, memory_mb, cpu_percent, disk_mb, started_at, ended_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			sandboxID, orgID, memMB, memMB/40, 20480, started, ended); err != nil {
			t.Fatalf("seed scale event: %v", err)
		}
	}
	insertSamples := func(startMin, endMin int, memMB int, memBytes int64) {
		startTs := t0.Add(time.Duration(startMin) * time.Minute)
		endTs := t0.Add(time.Duration(endMin) * time.Minute)
		if _, err := store.pool.Exec(ctx, `
			INSERT INTO sandbox_usage_samples
			  (sandbox_id, org_id, sampled_at, memory_mb, cpu_usec, memory_bytes, pids)
			SELECT $1, $2, gs.ts, $3, 0, $4, 1
			FROM generate_series($5::timestamptz, $6::timestamptz - interval '1 minute', interval '1 minute') AS gs(ts)
			ON CONFLICT DO NOTHING`,
			sandboxID, orgID, memMB, memBytes, startTs, endTs); err != nil {
			t.Fatalf("seed samples %d..%d: %v", startMin, endMin, err)
		}
	}

	insertSE(2048, t0.Add(-1*time.Hour), resizeAt)
	insertSE(4096, resizeAt, stoppedAt)

	insertSamples(0, 6*60, 2048, 1_400_000_000)    // Phase A
	insertSamples(6*60, 8*60, 4096, 2_800_000_000) // Phase B
	// Gap: 8*60..9*60 — no samples
	insertSamples(9*60, 18*60, 4096, 3_500_000_000) // Phase C
}

// TestSandboxUsagePoints_Shape_pgfixture asserts the bucket grid, the
// time-weighted allocation across the resize bucket, the gap-with-open-
// allocation behavior, and the post-stop zero buckets.
func TestSandboxUsagePoints_Shape_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)

	orgID := uuid.New()
	sandboxID := freshSandboxID("sbx-usage-shape")
	t0 := time.Now().UTC().Truncate(time.Hour).Add(-24 * time.Hour)
	to := t0.Add(24 * time.Hour)
	seedSandboxUsagePointsFixture(t, store, orgID, sandboxID, t0)

	points, totals, err := store.SandboxUsagePoints(ctx, orgID, sandboxID, t0, to)
	if err != nil {
		t.Fatalf("SandboxUsagePoints: %v", err)
	}

	if got, want := len(points), 24*60; got != want {
		t.Fatalf("len(points) = %d, want %d", got, want)
	}

	// Bucket 0 — phase A, sample present.
	p0 := points[0]
	if !p0.Timestamp.Equal(t0) {
		t.Errorf("points[0].Timestamp = %v, want %v", p0.Timestamp, t0)
	}
	if p0.AllocatedMemoryMb != 2048 {
		t.Errorf("points[0].AllocatedMemoryMb = %d, want 2048", p0.AllocatedMemoryMb)
	}
	assertClose(t, "points[0].MemoryAllocatedGbSeconds", 120, p0.MemoryAllocatedGbSeconds)
	if p0.UptimeSeconds != 60 {
		t.Errorf("points[0].UptimeSeconds = %d, want 60", p0.UptimeSeconds)
	}
	// 1.4 GB sample → 1.4e9 / 1073741824 GiB × 60s.
	expUsed := 1_400_000_000.0 / (1024 * 1024 * 1024) * 60
	assertClose(t, "points[0].MemoryUsedGbSeconds (GiB units)", expUsed, p0.MemoryUsedGbSeconds)

	// Bucket 360 — resize at t0+6h+30s splits the bucket 50/50 between
	// 2 GiB and 4 GiB tiers. Weighted allocated MB:
	//   (2048 * 30 + 4096 * 30) / 60 = 3072
	// GB-seconds:
	//   (2048/1024) * 30 + (4096/1024) * 30 = 60 + 120 = 180
	p360 := points[360]
	if p360.AllocatedMemoryMb != 3072 {
		t.Errorf("points[360].AllocatedMemoryMb = %d, want 3072 (resize bucket)", p360.AllocatedMemoryMb)
	}
	assertClose(t, "points[360].MemoryAllocatedGbSeconds (resize bucket)", 180, p360.MemoryAllocatedGbSeconds)
	if p360.UptimeSeconds != 60 {
		t.Errorf("points[360].UptimeSeconds = %d, want 60 (resize bucket fully covered by events)", p360.UptimeSeconds)
	}

	// Bucket 480 — inside the sample gap (t0+8h..t0+9h). Scale event 2
	// is still open here, so allocation AND uptime accrue (uptime now
	// derives from scale-event overlap, not sample presence — collector
	// gaps don't masquerade as downtime).
	p480 := points[480]
	if p480.AllocatedMemoryMb != 4096 {
		t.Errorf("points[480].AllocatedMemoryMb = %d, want 4096 (gap with open scale event)", p480.AllocatedMemoryMb)
	}
	assertClose(t, "points[480].MemoryAllocatedGbSeconds (gap)", 240, p480.MemoryAllocatedGbSeconds)
	if p480.UptimeSeconds != 60 {
		t.Errorf("points[480].UptimeSeconds = %d, want 60 (scale event open)", p480.UptimeSeconds)
	}
	if p480.UsedMemoryMbAvg != 0 {
		t.Errorf("points[480].UsedMemoryMbAvg = %d, want 0 (no sample in gap)", p480.UsedMemoryMbAvg)
	}

	// Bucket 1080 — after stop (t0+18h). No scale event, no sample.
	p1080 := points[1080]
	if p1080.AllocatedMemoryMb != 0 || p1080.UptimeSeconds != 0 {
		t.Errorf("points[1080] = %+v, want all zeros (post-stop)", p1080)
	}
	assertClose(t, "points[1080].MemoryAllocatedGbSeconds", 0, p1080.MemoryAllocatedGbSeconds)

	// Totals sanity.
	//   Expected allocated_gb_seconds:
	//     event 1 in [t0, t0+6h30s) → 21630s × 2 GiB = 43260
	//     event 2 in [t0+6h30s, t0+18h) → 43170s × 4 GiB = 172680
	//   Sum = 215940
	assertClose(t, "totals.MemoryAllocatedGbSeconds", 215940, totals.MemoryAllocatedGbSeconds)
	if totals.MemoryAllocatedPeakMb != 4096 {
		t.Errorf("totals.MemoryAllocatedPeakMb = %d, want 4096", totals.MemoryAllocatedPeakMb)
	}
	// Uptime now derives from scale-event overlap: 18h × 60min/h × 60s/min
	// = 64800. The 60 minutes of sample gap no longer subtract from uptime.
	if totals.UptimeSeconds != 18*3600 {
		t.Errorf("totals.UptimeSeconds = %d, want %d (18h × 3600s)", totals.UptimeSeconds, 18*3600)
	}
}

func TestSandboxUsagePoints_PartialBucketAllocatedPeak_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)

	orgID := uuid.New()
	sandboxID := freshSandboxID("sbx-usage-partial-peak")
	t0 := time.Now().UTC().Truncate(time.Hour).Add(-24 * time.Hour)
	seedSandboxUsagePointsFixture(t, store, orgID, sandboxID, t0)

	// The fixture resizes from 2048MB to 4096MB at t0+6h30s.
	// Query only 5 seconds inside the post-resize side of that bucket.
	// allocatedMemoryMb remains the bucket-normalized chart value, but
	// the envelope peak should still report the actual tier encountered.
	from := t0.Add(6*time.Hour + 45*time.Second)
	to := t0.Add(6*time.Hour + 50*time.Second)
	points, totals, err := store.SandboxUsagePoints(ctx, orgID, sandboxID, from, to)
	if err != nil {
		t.Fatalf("SandboxUsagePoints: %v", err)
	}
	if got, want := len(points), 1; got != want {
		t.Fatalf("len(points) = %d, want %d", got, want)
	}
	if points[0].UptimeSeconds != 5 {
		t.Errorf("points[0].UptimeSeconds = %d, want 5", points[0].UptimeSeconds)
	}
	assertClose(t, "points[0].MemoryAllocatedGbSeconds", 20, points[0].MemoryAllocatedGbSeconds)
	if points[0].AllocatedMemoryMb != 341 {
		t.Errorf("points[0].AllocatedMemoryMb = %d, want 341 (4096MB * 5/60)", points[0].AllocatedMemoryMb)
	}
	if totals.MemoryAllocatedPeakMb != 4096 {
		t.Errorf("totals.MemoryAllocatedPeakMb = %d, want 4096", totals.MemoryAllocatedPeakMb)
	}
}

// TestSandboxUsagePoints_SumInvariant_pgfixture pins the contract that
// Σ points.* == totals.* exactly (Go-side sum, not a separate query),
// for every additive field. If this drifts, the response shape breaks
// composability — a client summing points to reconstruct totals would
// get a different number than the totals field.
func TestSandboxUsagePoints_SumInvariant_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)

	orgID := uuid.New()
	sandboxID := freshSandboxID("sbx-usage-sum-invariant")
	t0 := time.Now().UTC().Truncate(time.Hour).Add(-24 * time.Hour)
	to := t0.Add(24 * time.Hour)
	seedSandboxUsagePointsFixture(t, store, orgID, sandboxID, t0)

	points, totals, err := store.SandboxUsagePoints(ctx, orgID, sandboxID, t0, to)
	if err != nil {
		t.Fatalf("SandboxUsagePoints: %v", err)
	}

	var sumAlloc, sumUsed float64
	var sumUptime int
	for _, p := range points {
		sumAlloc += p.MemoryAllocatedGbSeconds
		sumUsed += p.MemoryUsedGbSeconds
		sumUptime += p.UptimeSeconds
	}
	assertClose(t, "Σ MemoryAllocatedGbSeconds == totals", totals.MemoryAllocatedGbSeconds, sumAlloc)
	assertClose(t, "Σ MemoryUsedGbSeconds == totals", totals.MemoryUsedGbSeconds, sumUsed)
	if sumUptime != totals.UptimeSeconds {
		t.Errorf("Σ UptimeSeconds = %d, totals = %d", sumUptime, totals.UptimeSeconds)
	}
}

// TestSandboxUsagePoints_Reconciliation_pgfixture pins the load-bearing
// claim that totals.MemoryAllocatedGbSeconds == GetOrgUsage's rolled-up
// allocated total for the same sandbox + window. If this drifts, the
// new endpoint's "what would the bill say" answer disagrees with what
// the Stripe pipeline actually reports — a silent correctness bug.
func TestSandboxUsagePoints_Reconciliation_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)

	orgID := uuid.New()
	sandboxID := freshSandboxID("sbx-usage-reconcile")
	t0 := time.Now().UTC().Truncate(time.Hour).Add(-24 * time.Hour)
	to := t0.Add(24 * time.Hour)
	seedSandboxUsagePointsFixture(t, store, orgID, sandboxID, t0)

	_, totals, err := store.SandboxUsagePoints(ctx, orgID, sandboxID, t0, to)
	if err != nil {
		t.Fatalf("SandboxUsagePoints: %v", err)
	}

	// GetOrgUsage groups by (memory_mb, cpu_percent, disk_mb). Since we
	// seeded exactly one sandbox, the org-level rollup IS this sandbox's
	// rollup; allocated GB-seconds = SUM(memory_mb/1024 * total_seconds).
	summaries, err := store.GetOrgUsage(ctx, orgID.String(), t0, to)
	if err != nil {
		t.Fatalf("GetOrgUsage: %v", err)
	}
	var rollupAlloc float64
	for _, s := range summaries {
		rollupAlloc += float64(s.MemoryMB) / 1024.0 * s.TotalSeconds
	}
	if rollupAlloc == 0 {
		t.Fatal("expected GetOrgUsage to return non-zero allocated; fixture not seeded?")
	}
	assertClose(t, "totals.MemoryAllocatedGbSeconds vs GetOrgUsage", rollupAlloc, totals.MemoryAllocatedGbSeconds)
}

// TestSandboxUsagePoints_Boundary_pgfixture pins the [from, to) contract
// when callers pass mid-minute timestamps. Boundary buckets must report
// only the fraction of the bucket that overlaps the original window —
// not the full minute they nominally cover. Without per-event clamping
// to $3/$4, a default `now-1h .. now` query (almost never aligned)
// over-reports allocation by up to two full minutes per call.
func TestSandboxUsagePoints_Boundary_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)

	orgID := uuid.New()
	sandboxID := freshSandboxID("sbx-usage-boundary")

	// Anchor everything to a known minute so the fractional math is
	// reproducible regardless of when the test runs.
	anchor := time.Now().UTC().Truncate(time.Hour)
	from := anchor.Add(30 * time.Second)             // mid-minute lower bound
	to := anchor.Add(1*time.Minute + 45*time.Second) // mid-minute upper bound; 75s window total

	// Scale event covers the entire window and beyond.
	if _, err := store.pool.Exec(ctx,
		`INSERT INTO sandbox_scale_events
		 (sandbox_id, org_id, memory_mb, cpu_percent, disk_mb, started_at, ended_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		sandboxID, orgID, 1024, 25, 20480, anchor.Add(-1*time.Hour), anchor.Add(1*time.Hour)); err != nil {
		t.Fatalf("seed scale event: %v", err)
	}

	points, totals, err := store.SandboxUsagePoints(ctx, orgID, sandboxID, from, to)
	if err != nil {
		t.Fatalf("SandboxUsagePoints: %v", err)
	}
	if len(points) != 2 {
		t.Fatalf("expected 2 buckets (date_trunc(from) .. date_trunc(to-1us)), got %d", len(points))
	}

	// Bucket 0 = [anchor, anchor+1m). Effective overlap with [from, to)
	// = [from, anchor+1m) = 30 seconds. Allocated GiB-seconds = 1 × 30.
	assertClose(t, "boundary bucket 0 allocated", 30, points[0].MemoryAllocatedGbSeconds)
	if points[0].UptimeSeconds != 30 {
		t.Errorf("boundary bucket 0 uptime = %d, want 30 (clamped to from)", points[0].UptimeSeconds)
	}

	// Bucket 1 = [anchor+1m, anchor+2m). Effective overlap = [anchor+1m, to)
	// = 45 seconds. Allocated GiB-seconds = 1 × 45.
	assertClose(t, "boundary bucket 1 allocated", 45, points[1].MemoryAllocatedGbSeconds)
	if points[1].UptimeSeconds != 45 {
		t.Errorf("boundary bucket 1 uptime = %d, want 45 (clamped to to)", points[1].UptimeSeconds)
	}

	// Totals = 30 + 45 = 75 GiB-seconds for the 75-second window.
	// Without clamping, this would be 120 (2 × 60s).
	assertClose(t, "boundary totals", 75, totals.MemoryAllocatedGbSeconds)
	if totals.UptimeSeconds != 75 {
		t.Errorf("boundary totals.UptimeSeconds = %d, want 75", totals.UptimeSeconds)
	}
}

// TestSandboxUsagePoints_OvershootDivergence_pgfixture pins the
// intentional divergence between this endpoint and /api/usage when a
// scale event extends past `to`. The aggregator's GetOrgUsage uses
// COALESCE(ended_at, LEAST(now(), to)) — which DOES NOT clamp when
// ended_at is set, so it over-reports. The new per-sandbox endpoint
// clamps to $4 via the LEAST(..., b.ts_end, $4) chain, so it reports
// the mathematically correct value.
//
// This test exists so the divergence is a known, tested property, not
// a silent disagreement between two public usage APIs. If billing is
// later fixed, both endpoints will agree again and this test will
// require updating to match.
func TestSandboxUsagePoints_OvershootDivergence_pgfixture(t *testing.T) {
	ctx := context.Background()
	store := openPgStore(t)

	orgID := uuid.New()
	sandboxID := freshSandboxID("sbx-usage-overshoot")

	// Anchor to an even hour so seconds-precision arithmetic is exact.
	anchor := time.Now().UTC().Truncate(time.Hour).Add(-24 * time.Hour)
	from := anchor
	to := anchor.Add(24 * time.Hour)

	// Event started 1h after `from`, ends 6h after `to`. In-window
	// allocation should be 23h × 1 GiB = 82800 GiB-seconds.
	if _, err := store.pool.Exec(ctx,
		`INSERT INTO sandbox_scale_events
		 (sandbox_id, org_id, memory_mb, cpu_percent, disk_mb, started_at, ended_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		sandboxID, orgID, 1024, 25, 20480,
		anchor.Add(1*time.Hour), anchor.Add(30*time.Hour)); err != nil {
		t.Fatalf("seed scale event: %v", err)
	}

	_, totals, err := store.SandboxUsagePoints(ctx, orgID, sandboxID, from, to)
	if err != nil {
		t.Fatalf("SandboxUsagePoints: %v", err)
	}
	const expectedCorrect = 23.0 * 3600.0 // 23h × 1 GiB
	assertClose(t, "new endpoint clamps to `to`", expectedCorrect, totals.MemoryAllocatedGbSeconds)

	// GetOrgUsage reports 29h (started_at = anchor+1h, ended_at = anchor+30h,
	// no upper clamp). For memory_mb=1024 → 29 × 3600 = 104400 GiB-seconds.
	summaries, err := store.GetOrgUsage(ctx, orgID.String(), from, to)
	if err != nil {
		t.Fatalf("GetOrgUsage: %v", err)
	}
	var rollup float64
	for _, s := range summaries {
		rollup += float64(s.MemoryMB) / 1024.0 * s.TotalSeconds
	}
	const expectedOvershoot = 29.0 * 3600.0
	assertClose(t, "aggregator overshoots `to`", expectedOvershoot, rollup)

	// The divergence is exactly 6 hours of allocation.
	const expectedDivergence = 6.0 * 3600.0
	if diff := rollup - totals.MemoryAllocatedGbSeconds; math.Abs(diff-expectedDivergence) > 1e-6 {
		t.Errorf("divergence = %.3f, want %.3f (6h × 1 GiB)", diff, expectedDivergence)
	}
}
