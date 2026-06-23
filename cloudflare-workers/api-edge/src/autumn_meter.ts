// Edge-native autumn billing. THE place autumn usage bills — one place (this
// cron), not 70 per-cell reporters — off the same `usage_samples` rows that
// drive the Stripe billing-rollup for legacy orgs. Replaces the (deleted) cell
// AutumnReporter.
//
// Per autumn org it ships every fully-elapsed 5-minute bucket since the org's
// watermark to Autumn via track(), advancing the watermark one bucket at a time
// so a mid-run failure only replays the unfinished bucket (idempotency dedupes).
// A bucket whose track() returns a non-positive balance triggers projectOrg →
// is_halted + hibernate-dispatch.

import { type AutumnEnv, projectOrg, trackAutumnUsage } from "./autumn_webhook";

// Fixed 5-minute bucket: the unit of idempotency AND the bound on overspend past
// a zero balance before the halt fires. Mirrors the old cell autumnBucketSize.
const BUCKET_SEC = 300;

// Don't close a bucket until this long after its end, so late-delivered samples
// (forwarder + ingest + PEL retries) land before we track + advance the
// watermark. A sample arriving after the grace is bounded drift — Autumn dedupes
// the bucket's idempotency key, so it can't be re-added. Same "acceptable drift"
// model as billing-rollup.
const GRACE_SEC = 120;

// Cap buckets processed per org per run so one very-stale org can't monopolize a
// tick. Idle gaps are skipped in O(1) via the MIN(ts) fast-forward below, so this
// only bounds genuine continuous-usage catch-up; the next run continues.
const MAX_BUCKETS_PER_ORG = 24; // 2h of continuous catch-up per 5-min run

// Mirror of internal/billing/autumn.tierFeatureByMemoryMB — keep in sync with
// pricing.go and the Autumn credit schema.
const TIER_FEATURE_BY_MEMORY_MB: Record<number, string> = {
  1024: "compute_1gb",
  4096: "compute_4gb",
  8192: "compute_8gb",
  16384: "compute_16gb",
  32768: "compute_32gb",
  65536: "compute_64gb",
};

// Globally-unique, retry-stable key. Autumn dedupes on the bare key across all
// customers, so it includes the org; keyed on bucket start (not wall-clock) so a
// replay reuses it. Matches autumn.UsageIdempotencyKey on the (removed) cell.
function usageIdempotencyKey(orgID: string, bucketStartUnix: number, featureID: string): string {
  return `usage:${orgID}:${bucketStartUnix}:${featureID}`;
}

interface AutumnOrgRow {
  id: string;
  autumn_usage_watermark: number;
}

interface TierAgg {
  memory_mb: number;
  secs: number;
}

export async function runAutumnMeter(env: AutumnEnv, nowMs: number): Promise<void> {
  const nowSec = Math.floor(nowMs / 1000);
  const orgsRes = await env.OPENCOMPUTER_DB.prepare(
    "SELECT id, autumn_usage_watermark FROM orgs WHERE billing_provider = 'autumn'",
  ).all<AutumnOrgRow>();
  const orgs = orgsRes.results ?? [];
  if (orgs.length === 0) return;

  let withUsage = 0;
  for (const org of orgs) {
    try {
      if (await meterOrg(env, org, nowSec)) withUsage++;
    } catch (err) {
      // Leave the watermark; the next run replays from it (idempotent).
      console.error(`autumn-meter: org ${org.id} failed`, err);
    }
  }
  console.log(`autumn-meter: ${orgs.length} autumn org(s), ${withUsage} billed this run`);
}

// meterOrg processes one org's closed buckets. Returns true if it tracked usage.
async function meterOrg(env: AutumnEnv, org: AutumnOrgRow, nowSec: number): Promise<boolean> {
  // First sight: seed the watermark to now and bill forward only — never
  // retroactively charge usage accrued before the org moved to Autumn.
  if (!org.autumn_usage_watermark || org.autumn_usage_watermark === 0) {
    await setWatermark(env, org.id, nowSec);
    console.log(`autumn-meter: org ${org.id} seeded watermark at ${nowSec}`);
    return false;
  }

  const closeBefore = nowSec - GRACE_SEC;
  let cursor = org.autumn_usage_watermark;
  if (cursor + BUCKET_SEC > closeBefore) return false; // nothing fully closed yet

  // Earliest un-billed sample in the closeable window. If none, the org is idle:
  // fast-forward the watermark so its gap never grows (keeps catch-up O(1)).
  const win = await env.OPENCOMPUTER_DB.prepare(
    "SELECT MIN(ts) AS mn FROM usage_samples WHERE org_id = ?1 AND ts >= ?2 AND ts < ?3",
  )
    .bind(org.id, cursor * 1000, closeBefore * 1000)
    .first<{ mn: number | null }>();
  if (!win?.mn) {
    const aligned = cursor + Math.floor((closeBefore - cursor) / BUCKET_SEC) * BUCKET_SEC;
    if (aligned > cursor) await setWatermark(env, org.id, aligned);
    return false;
  }

  // Jump straight to the bucket holding the earliest sample (skip idle buckets).
  const firstSampleSec = Math.floor(win.mn / 1000);
  cursor += Math.floor((firstSampleSec - cursor) / BUCKET_SEC) * BUCKET_SEC;

  for (let n = 0; n < MAX_BUCKETS_PER_ORG; n++) {
    const bucketEnd = cursor + BUCKET_SEC;
    if (bucketEnd > closeBefore) break;
    const exhausted = await trackBucket(env, org.id, cursor, bucketEnd);
    await setWatermark(env, org.id, bucketEnd);
    cursor = bucketEnd;
    if (exhausted) {
      // projectOrg re-reads the balance, sets is_halted, and dispatches
      // /admin/halt-org to hibernate running boxes. Stop here — usage halts.
      await projectOrg(env, org.id);
      break;
    }
  }
  return true;
}

// trackBucket aggregates usage_samples in [from, to) by memory tier and tracks
// one usage event per tier to Autumn. Returns true if the balance is now <= 0.
async function trackBucket(env: AutumnEnv, orgID: string, fromSec: number, toSec: number): Promise<boolean> {
  const aggRes = await env.OPENCOMPUTER_DB.prepare(
    `SELECT memory_mb AS memory_mb, SUM(interval_s) AS secs
       FROM usage_samples
      WHERE org_id = ?1 AND ts >= ?2 AND ts < ?3
      GROUP BY memory_mb`,
  )
    .bind(orgID, fromSec * 1000, toSec * 1000)
    .all<TierAgg>();
  const tiers = aggRes.results ?? [];
  if (tiers.length === 0) return false;

  let remaining: number | null = null;
  for (const t of tiers) {
    if (!t.secs || t.secs <= 0) continue;
    const feature = TIER_FEATURE_BY_MEMORY_MB[t.memory_mb];
    if (!feature) {
      console.warn(`autumn-meter: org ${orgID} unknown memory tier ${t.memory_mb}MB — skipping`);
      continue;
    }
    remaining = await trackAutumnUsage(env, {
      customerID: orgID,
      featureID: feature,
      value: t.secs,
      idempotencyKey: usageIdempotencyKey(orgID, fromSec, feature),
    });
  }
  return remaining !== null && remaining <= 0;
}

async function setWatermark(env: AutumnEnv, orgID: string, ts: number): Promise<void> {
  await env.OPENCOMPUTER_DB.prepare("UPDATE orgs SET autumn_usage_watermark = ?1 WHERE id = ?2")
    .bind(ts, orgID)
    .run();
}
