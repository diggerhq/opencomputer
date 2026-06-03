// billing-rollup Worker — the global Pro-billing rollup cron.
//
// Runs on a schedule (see wrangler [triggers]). Each run:
//   1. ROLL: aggregate closed buckets of D1 `usage_samples` into the
//      `usage_meter_events` outbox — one row per Stripe meter event. Pricing is
//      billing_mode-aware: unified orgs get a single flat GB-second overage
//      meter; legacy orgs get one per-tier seconds meter per memory tier. Marks
//      the consumed samples rolled_up=1.
//   2. SEND: ship pending outbox rows to Stripe meter events, mark them 'sent'.
//      Skipped entirely in shadow mode (rows are written as 'shadow' and never
//      ship) — that's the parity-validation phase: the edge computes meter
//      events next to the cell's billable_events so they can be diffed before
//      the edge ever bills a customer.
//
// This is the edge analog of the cell's capacity allocator + BillableEventsSender,
// reading edge `usage_samples` (the `sandbox_scale_events` analog) instead of
// Postgres. Reserved capacity and disk overage are NOT handled here — they don't
// come from per-sandbox ticks and need their own paths.
//
// Idempotency: outbox `id` is deterministic ("{org}:{bucket_start}:{meter}"), so
// re-running a bucket recomputes identical ids (ON CONFLICT DO NOTHING), and the
// same id is the Stripe meter-event Identifier (Stripe dedups within 24h). A
// crash anywhere in roll→send→mark is safe to replay.

import { legacyMeterEventName, overageMeterEventName } from "./pricing";

export interface Env {
  OPENCOMPUTER_DB: D1Database;
  STRIPE_API_KEY: string;
  WORKER_ENV: string;
  // "false" => live (ship to Stripe). Anything else (incl. unset) => shadow.
  // Defaults to shadow so we never bill before the cutover is explicitly armed.
  SHADOW?: string;
  BUCKET_SECONDS?: string; // default 3600 (hourly)
  GRACE_SECONDS?: string;  // default 600 — watermark so late samples settle
  // Cutover boundary (unix seconds). Buckets that START before this are
  // consumed (samples marked rolled_up) but emit NO meter events — the cell
  // bills everything before the boundary, the edge bills from it. Unset/0 =
  // bill everything (steady state). Set it to the chosen handoff time T at
  // cutover so the edge and cell hand off at a bucket boundary with no overlap
  // (double-bill) and no gap (under-bill). Also cleanly drops late stragglers
  // below T, which the cell already billed.
  BILL_FROM?: string;
}

const BUCKET_SECONDS_DEFAULT = 3600;
const GRACE_SECONDS_DEFAULT = 600;
const SEND_LIMIT = 500;

function isShadow(env: Env): boolean {
  return env.SHADOW !== "false";
}
function billFromSeconds(env: Env): number {
  const t = Number.parseInt(env.BILL_FROM ?? "", 10);
  return Number.isFinite(t) && t > 0 ? t : 0;
}
function bucketSeconds(env: Env): number {
  return Number.parseInt(env.BUCKET_SECONDS ?? "", 10) || BUCKET_SECONDS_DEFAULT;
}
function graceSeconds(env: Env): number {
  const g = Number.parseInt(env.GRACE_SECONDS ?? "", 10);
  return Number.isFinite(g) && g >= 0 ? g : GRACE_SECONDS_DEFAULT;
}

interface RollupStats {
  buckets: number;
  meterRows: number;
  samplesRolled: number;
}
interface SendStats {
  sent: number;
  failed: number;
  skippedNoCustomer: number;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const nowMs = Date.now();
    const shadow = isShadow(env);
    try {
      const roll = await runRollup(env, nowMs);
      console.log(
        `billing-rollup: rolled ${roll.buckets} bucket(s) → ${roll.meterRows} meter row(s), ${roll.samplesRolled} sample(s) consumed (shadow=${shadow})`,
      );
      if (!shadow) {
        const send = await sendPending(env, nowMs);
        console.log(
          `billing-rollup: sent=${send.sent} failed=${send.failed} skippedNoCustomer=${send.skippedNoCustomer} (failed rows stay pending for retry)`,
        );
      } else {
        console.log("billing-rollup: shadow mode — outbox written as 'shadow', nothing shipped to Stripe");
      }
    } catch (err) {
      console.error("billing-rollup: run failed", err);
      throw err; // surface to CF so the failure is visible in dashboards
    }
  },

  // Health + dev-only manual trigger. The manual /run is handy for dev smoke
  // tests (the scheduled trigger fires hourly); it's disabled in prod so the
  // cron is the only thing that can move money.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return json({ ok: true, env: env.WORKER_ENV, shadow: isShadow(env) });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      if (env.WORKER_ENV === "prod") return new Response("not found", { status: 404 });
      const nowMs = Date.now();
      const roll = await runRollup(env, nowMs);
      const send = isShadow(env) ? null : await sendPending(env, nowMs);
      return json({
        ok: true,
        shadow: isShadow(env),
        cfg: { billFrom: billFromSeconds(env), bucketSec: bucketSeconds(env), grace: graceSeconds(env), nowSec: Math.floor(nowMs / 1000) },
        roll,
        send,
      });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// runRollup processes every closed bucket (bucket_end ≤ now − grace) that still
// has unrolled samples. The grace window lets late-delivered samples (Redis
// poll + forwarder + ingest latency, or PEL retries) land before we freeze a
// bucket — a sample arriving after its bucket is rolled is a known, bounded
// straggler (see runbook "acceptable drift").
async function runRollup(env: Env, nowMs: number): Promise<RollupStats> {
  const bucketSec = bucketSeconds(env);
  const watermark = Math.floor(nowMs / 1000) - graceSeconds(env);

  const bucketsRes = await env.OPENCOMPUTER_DB.prepare(
    `SELECT DISTINCT ((ts / 1000) / ?1) * ?1 AS bucket_start
       FROM usage_samples
      WHERE rolled_up = 0
        AND ((ts / 1000) / ?1) * ?1 + ?1 <= ?2
      ORDER BY bucket_start`,
  )
    .bind(bucketSec, watermark)
    .all<{ bucket_start: number }>();

  const stats: RollupStats = { buckets: 0, meterRows: 0, samplesRolled: 0 };
  for (const row of bucketsRes.results ?? []) {
    const r = await rollBucket(env, row.bucket_start, bucketSec, nowMs);
    stats.buckets += 1;
    stats.meterRows += r.meterRows;
    stats.samplesRolled += r.samplesRolled;
  }
  return stats;
}

interface TierAgg {
  org_id: string;
  memory_mb: number;
  secs: number;
  mem_mb_secs: number;
  billing_mode: string;
}

async function rollBucket(
  env: Env,
  bucketStart: number,
  bucketSec: number,
  nowMs: number,
): Promise<{ meterRows: number; samplesRolled: number }> {
  const bucketEnd = bucketStart + bucketSec;
  const startMs = bucketStart * 1000;
  const endMs = bucketEnd * 1000;

  // Cutover boundary: buckets that start before BILL_FROM belong to the cell
  // (it bills everything up to the handoff). Consume the samples (mark them
  // rolled so they don't pile up) but emit NO meter events — that's what makes
  // the edge↔cell handoff at T overlap-free (no double-bill) and gap-free, and
  // it absorbs late stragglers below T (already billed by the cell).
  const billFrom = billFromSeconds(env);
  if (billFrom > 0 && bucketStart < billFrom) {
    const res = await env.OPENCOMPUTER_DB.prepare(
      `UPDATE usage_samples SET rolled_up = 1 WHERE rolled_up = 0 AND ts >= ?1 AND ts < ?2`,
    )
      .bind(startMs, endMs)
      .run();
    return { meterRows: 0, samplesRolled: res.meta?.changes ?? 0 };
  }

  // Aggregate unrolled samples in the bucket by (org, tier). We carry both
  // seconds (legacy per-tier unit) and memory_mb·seconds (→ GB-seconds for
  // unified) so the per-org branch below can pick whichever the mode needs.
  const aggRes = await env.OPENCOMPUTER_DB.prepare(
    `SELECT s.org_id            AS org_id,
            s.memory_mb         AS memory_mb,
            SUM(s.interval_s)              AS secs,
            SUM(s.memory_mb * s.interval_s) AS mem_mb_secs,
            o.billing_mode      AS billing_mode
       FROM usage_samples s
       JOIN orgs o ON o.id = s.org_id
      WHERE s.rolled_up = 0 AND s.ts >= ?1 AND s.ts < ?2
      GROUP BY s.org_id, s.memory_mb`,
  )
    .bind(startMs, endMs)
    .all<TierAgg>();

  // Group tier rows by org so we can decide the meter shape per billing_mode.
  const byOrg = new Map<string, TierAgg[]>();
  for (const r of aggRes.results ?? []) {
    const list = byOrg.get(r.org_id);
    if (list) list.push(r);
    else byOrg.set(r.org_id, [r]);
  }

  const state = isShadow(env) ? "shadow" : "pending";
  const nowSec = Math.floor(nowMs / 1000);
  const insert = env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO usage_meter_events
       (id, org_id, meter_event_name, value, billing_mode, bucket_start, bucket_end, state, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO NOTHING`,
  );

  const stmts: D1PreparedStatement[] = [];
  for (const [orgId, tiers] of byOrg) {
    const mode = tiers[0].billing_mode;
    if (mode === "legacy") {
      // One meter event per memory tier; value = seconds at that tier.
      for (const t of tiers) {
        const meter = legacyMeterEventName(t.memory_mb);
        if (!meter) {
          console.warn(`billing-rollup: org=${orgId} unknown tier memory_mb=${t.memory_mb} — skipping (no legacy meter)`);
          continue;
        }
        if (t.secs <= 0) continue;
        stmts.push(
          insert.bind(`${orgId}:${bucketStart}:${meter}`, orgId, meter, t.secs, "legacy", bucketStart, bucketEnd, state, nowSec),
        );
      }
    } else {
      // unified — single flat overage meter; value = GB-seconds across tiers.
      let memMbSecs = 0;
      for (const t of tiers) memMbSecs += t.mem_mb_secs;
      const gbSeconds = memMbSecs / 1024;
      if (gbSeconds <= 0) continue;
      const meter = overageMeterEventName();
      stmts.push(
        insert.bind(`${orgId}:${bucketStart}:${meter}`, orgId, meter, gbSeconds, "unified", bucketStart, bucketEnd, state, nowSec),
      );
    }
  }

  // Outbox-first, then mark samples rolled — so a crash between the two just
  // replays: re-aggregating recomputes identical deterministic ids (deduped),
  // and the unmarked samples get picked up and marked next run. Marking first
  // would risk dropping samples whose meter rows never landed (underbilling).
  const markRolled = env.OPENCOMPUTER_DB.prepare(
    `UPDATE usage_samples SET rolled_up = 1 WHERE rolled_up = 0 AND ts >= ?1 AND ts < ?2`,
  ).bind(startMs, endMs);

  const batchRes = await env.OPENCOMPUTER_DB.batch([...stmts, markRolled]);
  const marked = batchRes[batchRes.length - 1]?.meta?.changes ?? 0;
  return { meterRows: stmts.length, samplesRolled: marked };
}

interface PendingMeterRow {
  id: string;
  org_id: string;
  meter_event_name: string;
  value: number;
  bucket_end: number;
  cust: string | null;
}

// sendPending ships pending outbox rows to Stripe. stripe_customer_id is read
// fresh from orgs at send time (it can be set after the usage was incurred —
// e.g. an org metered while still finishing Stripe onboarding). Rows for an org
// with no customer yet stay pending and retry on a later run.
async function sendPending(env: Env, nowMs: number): Promise<SendStats> {
  const res = await env.OPENCOMPUTER_DB.prepare(
    `SELECT m.id AS id, m.org_id AS org_id, m.meter_event_name AS meter_event_name,
            m.value AS value, m.bucket_end AS bucket_end, o.stripe_customer_id AS cust
       FROM usage_meter_events m
       JOIN orgs o ON o.id = m.org_id
      WHERE m.state = 'pending'
      ORDER BY m.bucket_start
      LIMIT ?1`,
  )
    .bind(SEND_LIMIT)
    .all<PendingMeterRow>();

  const stats: SendStats = { sent: 0, failed: 0, skippedNoCustomer: 0 };
  const nowSec = Math.floor(nowMs / 1000);
  for (const r of res.results ?? []) {
    if (!r.cust) {
      stats.skippedNoCustomer += 1;
      continue;
    }
    try {
      const identifier = await reportMeterEvent(env, r.meter_event_name, r.cust, r.value, r.id, r.bucket_end);
      await env.OPENCOMPUTER_DB.prepare(
        `UPDATE usage_meter_events SET state = 'sent', stripe_identifier = ?1, sent_at = ?2 WHERE id = ?3`,
      )
        .bind(identifier, nowSec, r.id)
        .run();
      stats.sent += 1;
    } catch (err) {
      // Leave the row 'pending' — Stripe dedups on identifier, so re-send next
      // run is safe even if Stripe actually accepted it but we failed to mark.
      console.error(`billing-rollup: send ${r.id} (meter=${r.meter_event_name} org=${r.org_id}) failed`, err);
      stats.failed += 1;
    }
  }
  return stats;
}

// reportMeterEvent POSTs one Stripe meter event. identifier = outbox id makes
// at-least-once shipping safe (Stripe dedups within 24h). timestamp = bucket_end,
// the moment usage was "incurred" — stable across retries. Mirrors the Go
// StripeClient.ReportMeterEvent; value is high-precision so fractional
// GB-seconds aren't truncated.
async function reportMeterEvent(
  env: Env,
  eventName: string,
  customerID: string,
  value: number,
  identifier: string,
  timestampSec: number,
): Promise<string> {
  const body = new URLSearchParams({
    event_name: eventName,
    identifier,
    timestamp: String(timestampSec),
    "payload[stripe_customer_id]": customerID,
    "payload[value]": value.toFixed(6),
  });
  const resp = await fetch("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.STRIPE_API_KEY,
      "stripe-version": "2024-06-20",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const text = await resp.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    throw new Error(parsed?.error?.message ?? parsed?.raw ?? `stripe meter_events returned ${resp.status}`);
  }
  // Stripe echoes the identifier on success; fall back to ours if absent.
  return parsed?.identifier ?? identifier;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
