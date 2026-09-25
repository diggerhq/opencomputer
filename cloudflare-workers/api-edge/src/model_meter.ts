// Token / model-usage metering cron (token-billing §5.4/§7). Sibling of
// autumn_meter.ts (which meters compute). Per managed OpenRouter key it:
//   1. reads the key's cumulative spend from OpenRouter,
//   2. debits the *new* spend to the org's Autumn `credits` pool via the
//      `model_spend` feature, using a PERSIST-BEFORE-TRACK immutable interval so
//      the debit is exactly-once across crashes (§7),
//   3. halts the org at ≤0 balance (projectOrg), and pushes the markup-correct
//      OpenRouter cap so total spendable across the org's keys never exceeds the
//      remaining prepaid balance.
//
// OpenRouter remains the real-time limiter (its per-key cap); this cron moves spend
// into the Autumn ledger + keeps the cap aligned with the shared balance. Mirrors
// the autumn_meter idempotency model (Autumn dedupes the track key).

import {
  type AutumnApiEnv,
  type AutumnEnv,
  getAutumnCustomer,
  projectOrg,
  trackAutumnUsage,
} from "./autumn_webhook";
import { getOrKey, patchOrKey, type OpenRouterEnv } from "./openrouter";
import type { ManagedModelKeyRow } from "./model_billing";

// Enough to debit + push caps for one org, without the dispatch secrets the halt
// path needs. Satisfied by the dashboard + webhook handlers.
export interface ModelCapSyncEnv extends OpenRouterEnv, AutumnApiEnv {
  OPENCOMPUTER_DB: D1Database;
  OPENROUTER_MARKUP_BPS?: string; // env-default markup when an org's column is 0
}

export interface ModelMeterEnv extends ModelCapSyncEnv, AutumnEnv {}

const MODEL_SPEND_FEATURE = "model_spend";
// Grace headroom left on a superseded key so an in-flight call can finish while the
// active key carries the remaining budget (§5.4 step 3).
const CAP_EPSILON_USD = 0.01;
// Only PATCH a cap when it moves by more than this (avoid churn / rate limits).
const CAP_MIN_DELTA_USD = 0.01;
// How long one settlement may own an org's caps before a crashed holder is
// presumed gone. Well above a normal run (a few provider round-trips), well below
// the cron period so a crash costs at most one tick.
const SETTLE_LEASE_SEC = 60;

interface OrgMeterRow {
  id: string;
  model_markup_bps: number;
  billing_provider: string;
}

function markupBps(env: ModelCapSyncEnv, org: OrgMeterRow): number {
  if (org.model_markup_bps && org.model_markup_bps > 0) return org.model_markup_bps;
  const envDefault = parseInt(env.OPENROUTER_MARKUP_BPS ?? "", 10);
  return Number.isFinite(envDefault) && envDefault > 0 ? envDefault : 0;
}

export async function runModelMeter(env: ModelMeterEnv, _nowMs: number): Promise<void> {
  // Every key still worth polling: active (live spend), plus superseded/deleting
  // (rotation/offboard — keep debiting until they quiesce, P2-g). Skip rows without
  // a hash (mid-provision) or credential (not yet usable).
  const res = await env.OPENCOMPUTER_DB.prepare(
    `SELECT * FROM managed_model_keys
      WHERE status IN ('active','superseded','deleting') AND or_key_hash IS NOT NULL
      ORDER BY org_id`,
  ).all<ManagedModelKeyRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return;

  const byOrg = new Map<string, ManagedModelKeyRow[]>();
  for (const r of rows) {
    const list = byOrg.get(r.org_id) ?? [];
    list.push(r);
    byOrg.set(r.org_id, list);
  }

  let billed = 0;
  for (const [orgId, keys] of byOrg) {
    try {
      if (await meterOrg(env, orgId, keys)) billed++;
    } catch (err) {
      // Leave watermarks; next tick replays (idempotent). One org's failure never
      // blocks the others.
      console.error(`model-meter: org ${orgId} failed`, err);
    }
  }
  console.log(`model-meter: ${byOrg.size} org(s), ${billed} debited this run`);
}

// syncManagedModelCaps re-aligns one org's OpenRouter key caps with its Autumn
// balance NOW rather than on the next cron tick. Called right after a balance
// change the user is waiting on (a top-up landing via webhook or checkout return),
// so the provider stops rejecting the moment the dashboard shows new credit. Debits
// outstanding spend first so the cap is computed off a balance that reflects it.
// Halting stays with the cron. Never throws — a failed sync just leaves the cron
// to catch up.
export async function syncManagedModelCaps(env: ModelCapSyncEnv, orgId: string): Promise<void> {
  try {
    const res = await env.OPENCOMPUTER_DB.prepare(
      `SELECT * FROM managed_model_keys
        WHERE org_id = ?1 AND status IN ('active','superseded','deleting') AND or_key_hash IS NOT NULL`,
    )
      .bind(orgId)
      .all<ManagedModelKeyRow>();
    const keys = res.results ?? [];
    if (keys.length === 0) return;
    await settleOrg(env, orgId, keys);
  } catch (err) {
    console.error(`model-meter: cap sync for org ${orgId} failed`, err);
  }
}

async function meterOrg(env: ModelMeterEnv, orgId: string, keys: ManagedModelKeyRow[]): Promise<boolean> {
  const settled = await settleOrg(env, orgId, keys);
  if (!settled) return false;
  if (settled.remaining <= 0) {
    // Halt immediately (mirror autumn_meter) — don't wait on the Autumn webhook.
    await projectOrg(env, orgId).catch((e) => console.error(`model-meter: projectOrg ${orgId} failed`, e));
  }
  return settled.debited;
}

// settleOrg = debit new spend + push caps for one org. Returns the post-debit
// balance so the caller can decide about halting, or null when the org is not
// metered — or when another settlement (the cron, an inline sync) holds the org
// right now. Settlements read usage and balance as a snapshot and write an
// absolute cap, so only one may run per org at a time or an older snapshot could
// land last; a run that cannot take the lease leaves the org to the holder and
// to the next trigger.
async function settleOrg(
  env: ModelCapSyncEnv,
  orgId: string,
  keys: ManagedModelKeyRow[],
): Promise<{ debited: boolean; remaining: number } | null> {
  const org = await env.OPENCOMPUTER_DB.prepare(
    "SELECT id, model_markup_bps, billing_provider FROM orgs WHERE id = ?1",
  )
    .bind(orgId)
    .first<OrgMeterRow>();
  if (!org) return null;
  // Decoupled billing: only autumn orgs are on the shared credit pool, so only they
  // are metered, capped-to-credits, and halted. Non-autumn orgs run on the FIXED OR
  // key budget set at provision — the key limit is the ceiling; we never debit or
  // halt them. This guard is also a correctness requirement, not just a skip: with
  // no Autumn customer, `remaining` below would read 0 and wrongly halt the org
  // (hibernate its boxes). Top-up = move the org to autumn + grant credits.
  if (org.billing_provider !== "autumn") return null;

  const now = Math.floor(Date.now() / 1000);
  const leaseUntil = now + SETTLE_LEASE_SEC;
  const lease = await env.OPENCOMPUTER_DB.prepare(
    "UPDATE orgs SET model_settle_lease_until=?1 WHERE id=?2 AND model_settle_lease_until < ?3",
  )
    .bind(leaseUntil, orgId, now)
    .run();
  if (lease.meta.changes === 0) {
    console.log(`model-meter: org ${orgId} is being settled elsewhere; skipping`);
    return null;
  }
  try {
    return await settleOrgHeld(env, org, keys);
  } finally {
    await env.OPENCOMPUTER_DB.prepare(
      "UPDATE orgs SET model_settle_lease_until=0 WHERE id=?1 AND model_settle_lease_until=?2",
    )
      .bind(orgId, leaseUntil)
      .run()
      .catch((e) => console.error(`model-meter: release lease for org ${orgId} failed`, e));
  }
}

async function settleOrgHeld(
  env: ModelCapSyncEnv,
  org: OrgMeterRow,
  keys: ManagedModelKeyRow[],
): Promise<{ debited: boolean; remaining: number }> {
  const orgId = org.id;
  const bps = markupBps(env, org);

  // Read each key's current OpenRouter usage once (reused for debit + cap).
  const usage = new Map<string, { usageUsd: number; limitUsd: number | null }>();
  for (const k of keys) {
    if (!k.or_key_hash) continue;
    const ok = await getOrKey(env, k.or_key_hash);
    usage.set(k.id, { usageUsd: ok.usage, limitUsd: ok.limit });
  }

  // 1. Debit the new spend for each key (persist-before-track, §7).
  let debited = false;
  for (const k of keys) {
    const u = usage.get(k.id);
    if (!u) continue;
    if (await debitKey(env, orgId, k, u.usageUsd, bps)) debited = true;
  }

  // 2. Push caps off the post-debit balance (read once).
  const cust = await getAutumnCustomer(env, orgId);
  const remainingUsd = cust?.balances?.credits?.remaining;
  const remaining = typeof remainingUsd === "number" ? remainingUsd : 0;
  await pushCaps(env, keys, usage, remaining, bps);
  return { debited, remaining };
}

// debitKey moves a key's NEW OpenRouter spend into Autumn, exactly-once (§7):
// persist an immutable [from,to) interval BEFORE the track; on a crashed retry,
// re-send the SAME interval/key (never recompute against newer usage).
async function debitKey(
  env: ModelCapSyncEnv,
  orgId: string,
  row: ManagedModelKeyRow,
  usageUsd: number,
  bps: number,
): Promise<boolean> {
  const usageMicro = Math.round(usageUsd * 1e6);
  let from: number;
  let to: number;
  let idem: string;

  if (row.pending_from_micro != null && row.pending_to_micro != null && row.pending_idem) {
    // A prior tick persisted but may have crashed before/after the track → retry verbatim.
    from = row.pending_from_micro;
    to = row.pending_to_micro;
    idem = row.pending_idem;
  } else if (usageMicro > row.committed_micro) {
    from = row.committed_micro;
    to = usageMicro;
    idem = `${MODEL_SPEND_FEATURE}:${orgId}:${from}:${to}`;
    // Persist the interval FIRST (durable before any Autumn call) so a crash replays
    // the exact same key+interval — a true dup, never a widened key (§7). The
    // claim is conditional on the row being as we read it: the cron and an inline
    // sync (webhook, billing page) can settle the same org at once, and only the
    // one that wins the claim may track — a loser leaves the spend to the winner.
    const claim = await env.OPENCOMPUTER_DB.prepare(
      `UPDATE managed_model_keys SET pending_from_micro=?1, pending_to_micro=?2, pending_idem=?3
        WHERE id=?4 AND committed_micro=?1 AND pending_idem IS NULL`,
    )
      .bind(from, to, idem, row.id)
      .run();
    if (claim.meta.changes === 0) return false;
  } else {
    return false; // no new spend
  }

  // Markup-applied debit, in micro-credits (credits feature credit_cost = 1e-6).
  const value = Math.round((to - from) * (1 + bps / 10000));
  await trackAutumnUsage(env, { customerID: orgId, featureID: MODEL_SPEND_FEATURE, value, idempotencyKey: idem });

  // Track succeeded (or 409 dup) → advance the watermark + clear pending. Keyed on
  // the idem so a concurrent replay of the same pending interval settles it once.
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE managed_model_keys SET committed_micro=?1, pending_from_micro=NULL, pending_to_micro=NULL, pending_idem=NULL
      WHERE id=?2 AND pending_idem=?3`,
  )
    .bind(to, row.id, idem)
    .run();
  return true;
}

// pushCaps keeps total spendable across the org's keys ≤ remaining/(1+markup) (§7):
// freeze every superseded/deleting key near its own usage (+ε grace), and give the
// active key the rest of the headroom. PATCH only when a cap actually moves.
async function pushCaps(
  env: ModelCapSyncEnv,
  keys: ManagedModelKeyRow[],
  usage: Map<string, { usageUsd: number; limitUsd: number | null }>,
  remainingUsd: number,
  bps: number,
): Promise<void> {
  const others = keys.filter((k) => k.status !== "active");
  const active = keys.find((k) => k.status === "active");
  let sumEps = 0;

  for (const k of others) {
    const u = usage.get(k.id);
    if (!u || !k.or_key_hash) continue;
    const cap = u.usageUsd + CAP_EPSILON_USD;
    sumEps += CAP_EPSILON_USD;
    if (u.limitUsd == null || Math.abs(u.limitUsd - cap) > CAP_MIN_DELTA_USD) {
      await patchOrKey(env, k.or_key_hash, { limitUsd: cap }).catch((e) =>
        console.error(`model-meter: cap patch (superseded) ${k.or_key_hash} failed`, e),
      );
    }
  }

  if (active?.or_key_hash) {
    const u = usage.get(active.id);
    if (u) {
      const headroom = Math.max(0, remainingUsd) / (1 + bps / 10000) - sumEps;
      const cap = Math.max(0, u.usageUsd + headroom);
      if (u.limitUsd == null || Math.abs(u.limitUsd - cap) > CAP_MIN_DELTA_USD) {
        await patchOrKey(env, active.or_key_hash, { limitUsd: cap }).catch((e) =>
          console.error(`model-meter: cap patch (active) ${active.or_key_hash} failed`, e),
        );
      }
    }
  }
}
