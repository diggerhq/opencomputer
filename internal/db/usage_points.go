package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Per-sandbox usage points. See design at
// .agents/design/per-sandbox-usage-api.md and impl plan at
// .agents/work/per-sandbox-usage-api-impl.md.
//
// One row per 1-minute bucket in [from, to). Buckets are minute-aligned
// in UTC, not aligned to `from`. Allocation integrals come from
// sandbox_scale_events using the same math as GetOrgUsage so totals
// reconcile to the billing pipeline by construction. Used memory comes
// from sandbox_usage_samples (cgroup memory.current).
//
// v1 is memory only. CPU mirrors this shape once usage_collector.go
// stops writing CPUUsec: 0 (see design / "Out of scope").

const usagePointsMaxWindow = 30 * 24 * time.Hour

// UsagePoint is one minute bucket of memory usage for a sandbox.
// Integrals (*GbSeconds, UptimeSeconds) compose by summation;
// snapshot scalars (AllocatedMemoryMb, UsedMemoryMb*) are for chart
// rendering and do not compose.
type UsagePoint struct {
	Timestamp                time.Time `json:"ts"`
	MemoryAllocatedGbSeconds float64   `json:"memoryAllocatedGbSeconds"`
	MemoryUsedGbSeconds      float64   `json:"memoryUsedGbSeconds"`
	UptimeSeconds            int       `json:"uptimeSeconds"`
	AllocatedMemoryMb        int       `json:"allocatedMemoryMb"`
	UsedMemoryMbAvg          int       `json:"usedMemoryMbAvg"`
	UsedMemoryMbPeak         int       `json:"usedMemoryMbPeak"`
}

// SandboxUsageTotals are envelope totals over [from, to). Computed by
// summing the materialized points in Go (not by a separate aggregate
// query), so SUM(points.MemoryAllocatedGbSeconds) ==
// totals.MemoryAllocatedGbSeconds holds exactly. Same for the used
// integral and uptime.
type SandboxUsageTotals struct {
	MemoryAllocatedGbSeconds float64 `json:"memoryAllocatedGbSeconds"`
	MemoryUsedGbSeconds      float64 `json:"memoryUsedGbSeconds"`
	UptimeSeconds            int     `json:"uptimeSeconds"`
	MemoryAllocatedPeakMb    int     `json:"memoryAllocatedPeakMb"`
	MemoryUsedPeakMb         int     `json:"memoryUsedPeakMb"`
}

// buildSandboxUsagePointsQuery returns SQL + args. Split out from
// SandboxUsagePoints so pure-Go tests can assert shape without a
// Postgres connection. Inputs are validated; callers pass already-
// validated [from, to).
//
// Units note: every GbSeconds field is GiB-seconds (binary, 2^30
// bytes/GiB). `memory_mb` is treated as MiB (`/1024.0 → GiB`) to
// match the billing pipeline; `memory_bytes` is divided by 1073741824
// for the same unit. Mixing decimal GB with binary GiB would silently
// bias the allocated-vs-used ratio.
func buildSandboxUsagePointsQuery(orgID uuid.UUID, sandboxID string, from, to time.Time) (string, []any) {
	args := []any{orgID, sandboxID, from, to}
	// $1 = orgID, $2 = sandboxID, $3 = from, $4 = to.
	//
	// Bucket grid: minute-aligned in UTC. First bucket starts at
	// date_trunc('minute', from) — may be earlier than `from` itself
	// when `from` is mid-minute. Last bucket is the one whose start is
	// strictly less than `to`. Per-event overlap is clamped to [$3, $4]
	// as well as to bucket edges, so boundary buckets report only the
	// fraction that overlaps the original window — the contract is
	// [from, to), not "the union of minutes touching [from, to)".
	//
	// Allocation source is sandbox_scale_events (same table the billing
	// aggregator reads). Open events (ended_at IS NULL) are clamped to
	// LEAST(now(), $4) to match GetOrgUsage's COALESCE idiom — so the
	// two endpoints agree exactly when ended_at IS NULL. They diverge
	// when ended_at > to: the aggregator overshoots (inherited quirk;
	// see internal/db/usage_query.go:durationExpr), the new endpoint
	// clamps to $4. This divergence is intentional and tested.
	//
	// Uptime per bucket = SUM(overlap_seconds) across joined events.
	// This makes uptime track "was a scale event open" rather than
	// "did we receive a sample," so collector outages don't masquerade
	// as downtime in the response.
	//
	// Used memory: AVG/MAX over samples that fall in the bucket. At
	// the 60s collector cadence there is usually one sample per
	// bucket; the aggregates absorb the rare clock-skew duplicate.
	sql := `
WITH buckets AS (
  SELECT
    ts,
    ts + interval '1 minute' AS ts_end
  FROM generate_series(
    date_trunc('minute', $3::timestamptz),
    date_trunc('minute', $4::timestamptz - interval '1 microsecond'),
    interval '1 minute'
  ) AS ts
),
samples AS (
  SELECT
    date_trunc('minute', sampled_at) AS bucket_ts,
    AVG(memory_bytes)::bigint        AS memory_bytes_avg,
    MAX(memory_bytes)                AS memory_bytes_peak
  FROM sandbox_usage_samples
  WHERE org_id = $1
    AND sandbox_id = $2
    AND sampled_at >= $3
    AND sampled_at <  $4
  GROUP BY date_trunc('minute', sampled_at)
),
event_overlap AS (
  -- Named event_overlap because OVERLAPS is a Postgres reserved word
  -- (temporal predicate). INNER JOIN (not LEFT) so buckets with no
  -- matching scale event produce no rows -- the outer LEFT JOIN to
  -- the allocated CTE then COALESCEs missing buckets to zero. A LEFT
  -- JOIN here would let phantom NULL-event rows sneak through the
  -- GREATEST(NULL, b.ts, $3) idiom and emit a full-bucket
  -- overlap_seconds for buckets that should have no allocation.
  SELECT
    b.ts AS bucket_ts,
    e.memory_mb,
    GREATEST(EXTRACT(EPOCH FROM (
      LEAST(COALESCE(e.ended_at, LEAST(now(), $4::timestamptz)), b.ts_end, $4::timestamptz)
      - GREATEST(e.started_at, b.ts, $3::timestamptz)
    )), 0) AS overlap_seconds
  FROM buckets b
  INNER JOIN sandbox_scale_events e
    ON e.org_id    = $1
   AND e.sandbox_id = $2
   AND e.started_at < b.ts_end
   AND (e.ended_at IS NULL OR e.ended_at > b.ts)
),
allocated AS (
  SELECT
    bucket_ts,
    SUM(memory_mb::float * overlap_seconds) / 60.0           AS weighted_memory_mb,
    MAX(memory_mb) FILTER (WHERE overlap_seconds > 0)         AS peak_memory_mb,
    SUM(memory_mb::float / 1024.0 * overlap_seconds)         AS gb_seconds,
    COALESCE(SUM(overlap_seconds)::int, 0)                   AS uptime_seconds
  FROM event_overlap
  GROUP BY bucket_ts
)
SELECT
  b.ts,
  COALESCE(a.gb_seconds, 0)::float                                       AS memory_allocated_gb_seconds,
  COALESCE(a.weighted_memory_mb, 0)::int                                 AS allocated_memory_mb,
  COALESCE(a.peak_memory_mb, 0)::int                                      AS allocated_memory_peak_mb,
  COALESCE(s.memory_bytes_avg::float / 1073741824.0 * 60, 0)             AS memory_used_gb_seconds,
  COALESCE((s.memory_bytes_avg / 1024 / 1024)::int, 0)                   AS used_memory_mb_avg,
  COALESCE((s.memory_bytes_peak / 1024 / 1024)::int, 0)                  AS used_memory_mb_peak,
  COALESCE(a.uptime_seconds, 0)                                          AS uptime_seconds
FROM buckets b
LEFT JOIN samples s   ON s.bucket_ts = b.ts
LEFT JOIN allocated a ON a.bucket_ts = b.ts
ORDER BY b.ts`
	return sql, args
}

// validateSandboxUsageWindow rejects windows outside the contract.
// Split out so the handler can return 400s with the same error text.
func validateSandboxUsageWindow(from, to time.Time) error {
	if !to.After(from) {
		return errors.New("`to` must be after `from`")
	}
	if to.Sub(from) > usagePointsMaxWindow {
		return fmt.Errorf("query window must be <= %d days", int(usagePointsMaxWindow/(24*time.Hour)))
	}
	return nil
}

// SandboxUsagePoints returns one UsagePoint per minute in [from, to) and
// the envelope totals. Totals are computed from the materialized points
// to guarantee Σ points.* == totals.* exactly.
//
// Callers must validate org ownership of sandboxID before invoking;
// this function performs no auth check (it only filters the query by
// org_id, which is necessary but not sufficient for ownership).
func (s *Store) SandboxUsagePoints(ctx context.Context, orgID uuid.UUID, sandboxID string, from, to time.Time) ([]UsagePoint, SandboxUsageTotals, error) {
	if err := validateSandboxUsageWindow(from, to); err != nil {
		return nil, SandboxUsageTotals{}, err
	}

	sql, args := buildSandboxUsagePointsQuery(orgID, sandboxID, from, to)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, SandboxUsageTotals{}, fmt.Errorf("sandbox usage points query: %w", err)
	}
	defer rows.Close()

	var points []UsagePoint
	var totals SandboxUsageTotals
	for rows.Next() {
		var p UsagePoint
		var allocatedMemoryPeakMb int
		if err := rows.Scan(
			&p.Timestamp,
			&p.MemoryAllocatedGbSeconds,
			&p.AllocatedMemoryMb,
			&allocatedMemoryPeakMb,
			&p.MemoryUsedGbSeconds,
			&p.UsedMemoryMbAvg,
			&p.UsedMemoryMbPeak,
			&p.UptimeSeconds,
		); err != nil {
			return nil, SandboxUsageTotals{}, fmt.Errorf("scan usage point: %w", err)
		}
		points = append(points, p)

		totals.MemoryAllocatedGbSeconds += p.MemoryAllocatedGbSeconds
		totals.MemoryUsedGbSeconds += p.MemoryUsedGbSeconds
		totals.UptimeSeconds += p.UptimeSeconds
		if allocatedMemoryPeakMb > totals.MemoryAllocatedPeakMb {
			totals.MemoryAllocatedPeakMb = allocatedMemoryPeakMb
		}
		if p.UsedMemoryMbPeak > totals.MemoryUsedPeakMb {
			totals.MemoryUsedPeakMb = p.UsedMemoryMbPeak
		}
	}
	if err := rows.Err(); err != nil {
		return nil, SandboxUsageTotals{}, fmt.Errorf("rows.Err: %w", err)
	}

	return points, totals, nil
}
