# Per-sandbox usage API — implementation plan

Working doc. Design is at `.agents/design/per-sandbox-usage-api.md`,
signed off. v1 ships **memory only**; CPU is a follow-up gated on the
`usage_collector.go:103` cgroup `cpu.stat` parse.

## Status (post-implementation)

The implementation has landed on this branch. Outcomes:

- **Q1** (alias in response): kept inline. See design's "What gets
  dropped" section for the carved-out rationale.
- **Q2** (bucket alignment): UTC-aligned buckets + per-event overlap
  clamping to `[$3, $4]` so boundary buckets correctly report only
  the fraction overlapping the original `from`/`to`. Pinned by
  `TestSandboxUsagePoints_Boundary_pgfixture`.
- **Q3** (sample.memory_mb vs scale_events): allocation reads from
  `sandbox_scale_events` exclusively to keep the billing
  reconciliation invariant.
- **Q4** (30d performance): EXPLAIN on the dev box showed acceptable
  plan; the `event_overlap` CTE materializes one row per (bucket ×
  scale_event) which Postgres handles fine for the bounded set sizes.
- **Q5** (pgfixture vs pgtest): pgfixture, matching the existing
  reconciliation test.

Two additional issues surfaced during review and were fixed in the
same PR:

- **Boundary clamp bug** (over-reported by up to 2 minutes per call
  on the default `now-1h..now` window). Same fix as Q2.
- **Uptime semantics**: switched from "sample present" to
  "scale-event overlap" so collector outages no longer masquerade as
  downtime. INNER JOIN (not LEFT) in `event_overlap` to prevent
  phantom NULL-event rows from emitting full-bucket overlap.
- **Units**: `memory_bytes / 1073741824` (GiB) to align with the
  allocation side's `memory_mb / 1024` (also GiB). Wire field names
  keep the historical `Gb` for backwards compat with the aggregator.

Sections below capture the original plan and the SQL sketch — they
are historical and do not necessarily reflect the final code. For the
shipped implementation read `internal/db/usage_points.go` directly.

## Surfaces

The change touches three layers and three artifacts:

| Layer | File | Change |
|---|---|---|
| DB query | `internal/db/usage_points.go` (new) | Build the generate-series query that returns 1m points + run server-side totals |
| HTTP handler | `internal/api/usage.go` | Replace `getSandboxUsage` (line 292) with the new shape. Drop old fields per design — `diskOverageGbSeconds`, `tags`, `tagsLastUpdatedAt`, `status`, `firstStartedAt`, `lastEndedAt` (keep `alias` per Q1) |
| Handler tests | `internal/api/usage_test.go` | Replace existing per-sandbox tests, add the cases from Testing strategy |
| SDK (TS) | `sdks/typescript/src/usage.ts` | Update `getSandboxUsage` types + helper; major bump |
| SDK (Py) | `sdks/python/opencomputer/usage.py` | Same; major bump |
| Docs | `docs/api-reference/usage/get-sandbox-usage.mdx` | Rewrite to new shape |

`internal/db/usage_query.go` (the aggregator) is untouched. The new
file lives next to it for discoverability, not on top of it — the
aggregator builder is heavily templated for groupBy/filter/sort, and
the new per-sandbox query is simpler and follows a different shape
(generate_series + LEFT JOIN, no pagination).

The web dashboard is out of scope for this PR; the design notes the
chart UI is a separate task.

## Phasing

One PR is right-sized. Internal commit order that keeps each step
reviewable:

1. **DB layer.** New `usage_points.go` + tests against `pgfixture`.
   No HTTP changes yet — the function returns `[]UsagePoint` + `UsageTotals`.
2. **Handler.** Replace `getSandboxUsage` to use the new function.
   Update `internal/api/usage_test.go`. The route stays
   `GET /api/sandboxes/:id/usage` — same path, new response shape.
3. **Docs MDX.** Rewrite the page; this is the customer-facing contract.
4. **SDK bumps.** TypeScript and Python in parallel. Both already
   wrap the endpoint, both ship as major version bumps.

The reconciliation test (totals.memoryAllocatedGbSeconds == old
`/api/usage` memoryGbSeconds) sits in step 1, against `pgfixture` data
that exercises a resize event mid-window so the weighted-allocation
math is on the critical path.

## Query approach

The handler executes one query that materializes points; totals are
summed in Go from the result rows. Sketch (not final SQL):

```sql
WITH buckets AS (
  SELECT ts, ts + interval '1 minute' AS ts_end
  FROM generate_series(
    date_trunc('minute', $3::timestamptz),
    date_trunc('minute', $4::timestamptz - interval '1 minute'),
    interval '1 minute'
  ) AS ts
),
samples AS (
  SELECT
    date_trunc('minute', sampled_at) AS bucket_ts,
    AVG(memory_bytes)::bigint  AS memory_bytes_avg,
    MAX(memory_bytes)          AS memory_bytes_peak
  FROM sandbox_usage_samples
  WHERE org_id = $1 AND sandbox_id = $2
    AND sampled_at >= $3 AND sampled_at < $4
  GROUP BY date_trunc('minute', sampled_at)
),
allocated AS (
  -- Per-bucket time-weighted average and GB-seconds, integrated from
  -- scale_events overlapping each bucket. Same math as GetOrgUsage so
  -- the reconciliation invariant holds by construction.
  SELECT
    b.ts AS bucket_ts,
    SUM(e.memory_mb::float * EXTRACT(EPOCH FROM (
      LEAST(COALESCE(e.ended_at, $4::timestamptz), b.ts_end) -
      GREATEST(e.started_at, b.ts)
    ))) / 60.0 AS weighted_memory_mb,
    SUM(e.memory_mb::float / 1024.0 * EXTRACT(EPOCH FROM (
      LEAST(COALESCE(e.ended_at, $4::timestamptz), b.ts_end) -
      GREATEST(e.started_at, b.ts)
    ))) AS gb_seconds
  FROM buckets b
  LEFT JOIN sandbox_scale_events e
    ON e.org_id = $1 AND e.sandbox_id = $2
   AND e.started_at < b.ts_end
   AND (e.ended_at IS NULL OR e.ended_at > b.ts)
  GROUP BY b.ts
)
SELECT
  b.ts,
  COALESCE(a.gb_seconds, 0)                            AS memory_allocated_gb_seconds,
  COALESCE(a.weighted_memory_mb, 0)::int               AS allocated_memory_mb,
  COALESCE(s.memory_bytes_avg::float / 1e9 * 60, 0)    AS memory_used_gb_seconds,
  COALESCE((s.memory_bytes_avg / 1024 / 1024)::int, 0) AS used_memory_mb_avg,
  COALESCE((s.memory_bytes_peak / 1024 / 1024)::int, 0) AS used_memory_mb_peak,
  CASE WHEN s.bucket_ts IS NOT NULL THEN 60 ELSE 0 END  AS uptime_seconds
FROM buckets b
LEFT JOIN samples s    ON s.bucket_ts = b.ts
LEFT JOIN allocated a  ON a.bucket_ts = b.ts
ORDER BY b.ts;
```

Notes on the sketch:

- **Allocation comes from `sandbox_scale_events`, not from the
  `memory_mb` field on samples.** The sample row records the tier at
  sample time, but if we read allocation off samples we lose
  reconciliation with the billing aggregator (samples are 60s-spaced;
  scale events are interval-of-arbitrary-length). Reading scale
  events directly is the same math `GetOrgUsage` already uses.
- **Bucketing uses `date_trunc('minute', sampled_at)`.** Collector
  cadence is 60s but not necessarily aligned to the minute. If two
  samples land in the same bucket (rare clock skew or restart), the
  AVG/MAX aggregates absorb them.
- **`memory_used_gb_seconds`** uses the sample's average bytes × 60s.
  This is an approximation — between samples we don't know what RSS
  was. At 60s cadence it's fine; long memory pressure events show up
  in the next sample.
- **Uptime is binary per bucket.** Any sample → `uptime_seconds = 60`,
  no sample → `0`. We do not try to fractional-attribute partial
  minutes at start/stop boundaries. The error is bounded by one
  minute per lifetime per sandbox; not worth the complexity.

The Go side scans points into `[]UsagePoint`, then computes totals
with a single pass (sum the integrals; track max for peak fields).
This guarantees `SUM(points[].memoryUsedGbSeconds) == totals.memoryUsedGbSeconds`
exactly — the invariant called out in the design.

## Handler shape

```go
type UsagePoint struct {
    Timestamp                  time.Time `json:"ts"`
    MemoryAllocatedGbSeconds   float64   `json:"memoryAllocatedGbSeconds"`
    MemoryUsedGbSeconds        float64   `json:"memoryUsedGbSeconds"`
    UptimeSeconds              int       `json:"uptimeSeconds"`
    AllocatedMemoryMb          int       `json:"allocatedMemoryMb"`
    UsedMemoryMbAvg            int       `json:"usedMemoryMbAvg"`
    UsedMemoryMbPeak           int       `json:"usedMemoryMbPeak"`
}

type UsageTotals struct {
    MemoryAllocatedGbSeconds float64 `json:"memoryAllocatedGbSeconds"`
    MemoryUsedGbSeconds      float64 `json:"memoryUsedGbSeconds"`
    UptimeSeconds            int     `json:"uptimeSeconds"`
    MemoryAllocatedPeakMb    int     `json:"memoryAllocatedPeakMb"`
    MemoryUsedPeakMb         int     `json:"memoryUsedPeakMb"`
}

type SandboxUsageResponse struct {
    SandboxID string       `json:"sandboxId"`
    Alias     string       `json:"alias,omitempty"`
    From      time.Time    `json:"from"`
    To        time.Time    `json:"to"`
    Totals    UsageTotals  `json:"totals"`
    Points    []UsagePoint `json:"points"`
}
```

`Alias` survives in the response (cheap, useful for "which sandbox am I
looking at?" in CLI / dashboard contexts). Reads from
`sandbox_sessions.config->>'alias'` via the existing helper; design
nominally drops it under "tags/identity stays elsewhere," but it's a
2-line addition with high readability payoff. Will flag for review.

Validation, keeping the same error shapes the current handler uses:

- `to` not after `from` → 400
- window > 30d → 400
- malformed RFC3339 → 400
- `ownsSandbox` failure → existing 403/404 path

## SDK changes

Both SDKs already wrap `GET /sandboxes/:id/usage`. The new shape is
incompatible with the old one (envelope structure differs), so both
ship as **major bumps**.

**TypeScript (`sdks/typescript/src/usage.ts:148-152`):**
- Replace the `SandboxUsage` return type
- Helper returns `{ totals, points }` directly

**Python (`sdks/python/opencomputer/usage.py:235`):**
- Replace the `SandboxUsage` dataclass
- Pydantic model regen if it's auto-generated (need to confirm)

Both SDK readmes get a one-paragraph migration note.

## Open questions / decisions for review

**Q1. Keep `alias` in the response, or drop it as design implies?**
Cheap to include; useful in CLI output and ad-hoc curling. Recommend
keep, contrary to the strict reading of the design's "identity stays
elsewhere." If reviewers disagree, drop it and clients re-fetch from
`GET /sandboxes/:id`.

**Q2. Bucket alignment.** The query uses
`date_trunc('minute', sampled_at)` — buckets are minute-aligned in
UTC, not aligned to `from`. So if `from = 12:00:30`, the first bucket
is `12:00:00` and may include samples taken before `from`. Trade-off:
strict alignment to `from` produces points at arbitrary offsets that
don't line up nicely with wall-clock minutes; UTC alignment produces
predictable timestamps but the first/last bucket may be partial.
Recommend UTC alignment; document the partial-bucket caveat in the
response. Other options: snap `from`/`to` to minute boundaries
server-side, or accept arbitrary alignment.

**Q3. Sample row's `memory_mb` field.** Schema carries it; we ignore
it in favor of `scale_events`. Worth a comment in the query explaining
why (avoid silent drift from the billing reconciliation invariant).

**Q4. Per-bucket allocated read is N joins to scale_events.** For a
30d window with 43,200 buckets and a sandbox with 1 scale event,
that's 43,200 (bucket × event) overlap calculations. Postgres handles
this fine via the EXTRACT/LEAST/GREATEST predicate and the existing
`idx_scale_events_org`. Run an EXPLAIN ANALYZE on the dev box with a
representative sandbox before merge; if it's slow, the fallback is
to materialize `(bucket_ts, weighted_memory_mb)` in a CTE that
groups by event first.

**Q5. `pgfixture` vs `pgtest`.** `internal/billing/capacity_reconciler_test.go`
uses one of these — match the existing pattern for the new tests so
they run in the same CI lane.

## Test plan

Mirrors the Testing strategy section of the design doc; specifics:

- **`internal/db/usage_points_test.go`** — generate-series cases:
  empty window, full uptime, mid-window gap, resize boundary inside a
  bucket, window pre-dating first session.
- **`internal/db/usage_reconciliation_test.go`** — for an org with
  scale events spanning the window, `SUM(points.memoryAllocatedGbSeconds)`
  must equal `GetOrgUsage`'s total seconds × allocated tier. Same
  math, must match to float precision.
- **`internal/api/usage_test.go`** — handler-layer: window validation
  400s, ownership 404, JSON shape stability snapshot.
- **Dev box E2E** — manual script captured in
  `.agents/work/per-sandbox-usage-api-impl-smoke.md` (created during
  impl): spin up sandbox → workload → wait 5min → curl → assert.

## What this doc is not capturing

- **CPU.** Deferred per design. The query and shape are easy to
  extend; nothing here forecloses that work.
- **`/api/usage` leaderboard sort.** Separate follow-up; not in this
  PR.
- **Dashboard chart.** Separate UI work that consumes this endpoint
  once it's live.
- **Sample retention policy.** `sandbox_usage_samples` retention is
  whatever the billing pipeline needs today. The 30d window cap is
  comfortably inside that; revisit only if retention shortens.
