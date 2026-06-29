// Token / model-usage billing — provisioning state machine + the edge→sessions-api
// key hand-off (design: .agents/work/token-billing.md §5.1, §6.7.5). The edge owns
// the whole OpenRouter lifecycle (Autumn/OR are edge-native); this module drives one
// managed org from `model_billing_status` off → provisioning → active, minting a
// per-org OR key and binding it to a sessions-api credential.
//
// The metering cron (model_meter, §5.4) is a separate file (step 3); this is step 1:
// the key lifecycle + per-org state only.

import { type AutumnApiEnv, getAutumnCustomer } from "./autumn_webhook";
import {
  createOrKey,
  deleteOrKey,
  type OpenRouterEnv,
} from "./openrouter";

export interface ModelBillingEnv extends OpenRouterEnv, AutumnApiEnv {
  OPENCOMPUTER_DB: D1Database;
  // sessions-api base URL (shared with the dashboard /v3 proxy). Default = prod.
  SESSIONS_API_URL?: string;
  // DEDICATED HMAC secret for the plaintext-key hand-off (§6.7.5 / P2-f). NOT the
  // generic internal-auth secret — this route carries a live model key. Shared
  // only with sessions-api.
  OC_MANAGED_CRED_HMAC_SECRET: string;
  // Optional env-default markup (basis points) when the org row's is 0. Org wins.
  OPENROUTER_MARKUP_BPS?: string;
}

// Bounded retries before parking the org in 'error' (§5.1).
const MAX_PROVISION_ATTEMPTS = 5;
// Accepted clock skew on the hand-off HMAC (replay window, §6.7.5).
const HANDOFF_SKEW_SEC = 60;
const DEFAULT_SESSIONS_API = "https://api.opencomputer.dev";
const HANDOFF_PATH = "/internal/managed-credential";

export type ManagedKeyStatus = "active" | "superseded" | "deleting";

export interface ManagedModelKeyRow {
  id: string;
  org_id: string;
  or_key_hash: string | null;
  managed_credential_id: string | null;
  operation_id: string | null;
  status: ManagedKeyStatus;
  committed_micro: number;
  pending_from_micro: number | null;
  pending_to_micro: number | null;
  pending_idem: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  superseded_at: number | null;
}

interface OrgBillingRow {
  id: string;
  billing_provider: string;
  model_billing_status: string;
  model_markup_bps: number;
}

// sessions-api owner id for an OC org. MUST match sessions-api's ownerIdForOrg
// (src/v3/auth/org-token.ts) — the managed credential is stored + resolved under it.
export function ownerIdForOrg(orgId: string): string {
  return "oc-org:" + orgId;
}

// Stable, human-greppable OR key name (also our reconcile anchor). One per org.
function orKeyName(orgId: string): string {
  return `oc-org-${orgId}`;
}

function newRowId(): string {
  return "mmk_" + crypto.randomUUID().replace(/-/g, "");
}
function newOperationId(): string {
  return "op_" + crypto.randomUUID().replace(/-/g, "");
}

function markupBps(env: ModelBillingEnv, org: OrgBillingRow): number {
  if (org.model_markup_bps && org.model_markup_bps > 0) return org.model_markup_bps;
  const envDefault = parseInt(env.OPENROUTER_MARKUP_BPS ?? "", 10);
  return Number.isFinite(envDefault) && envDefault > 0 ? envDefault : 0;
}

// ── D1 access ──────────────────────────────────────────────────────────────

async function getOrg(env: ModelBillingEnv, orgId: string): Promise<OrgBillingRow | null> {
  return env.OPENCOMPUTER_DB.prepare(
    "SELECT id, billing_provider, model_billing_status, model_markup_bps FROM orgs WHERE id = ?1",
  )
    .bind(orgId)
    .first<OrgBillingRow>();
}

async function setOrgStatus(env: ModelBillingEnv, orgId: string, status: string): Promise<void> {
  await env.OPENCOMPUTER_DB.prepare("UPDATE orgs SET model_billing_status = ?1 WHERE id = ?2")
    .bind(status, orgId)
    .run();
}

// The org's resumable provisioning row: its single non-deleting key. (Normally one
// 'active'; a 'superseded' is a rotation we don't resume here.)
async function getResumableRow(env: ModelBillingEnv, orgId: string): Promise<ManagedModelKeyRow | null> {
  return env.OPENCOMPUTER_DB.prepare(
    "SELECT * FROM managed_model_keys WHERE org_id = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(orgId)
    .first<ManagedModelKeyRow>();
}

export async function getActiveKeyRow(env: ModelBillingEnv, orgId: string): Promise<ManagedModelKeyRow | null> {
  return env.OPENCOMPUTER_DB.prepare(
    "SELECT * FROM managed_model_keys WHERE org_id = ?1 AND status = 'active' AND or_key_hash IS NOT NULL AND managed_credential_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(orgId)
    .first<ManagedModelKeyRow>();
}

async function insertRow(env: ModelBillingEnv, row: { id: string; orgId: string; operationId: string; createdAt: number }): Promise<ManagedModelKeyRow> {
  await env.OPENCOMPUTER_DB.prepare(
    "INSERT INTO managed_model_keys (id, org_id, operation_id, status, committed_micro, attempts, created_at) VALUES (?1, ?2, ?3, 'active', 0, 0, ?4)",
  )
    .bind(row.id, row.orgId, row.operationId, row.createdAt)
    .run();
  return {
    id: row.id,
    org_id: row.orgId,
    or_key_hash: null,
    managed_credential_id: null,
    operation_id: row.operationId,
    status: "active",
    committed_micro: 0,
    pending_from_micro: null,
    pending_to_micro: null,
    pending_idem: null,
    attempts: 0,
    last_error: null,
    created_at: row.createdAt,
    superseded_at: null,
  };
}

// Targeted column updates. `or_key_hash`/`managed_credential_id` accept null so the
// recover-by-delete path (lost plaintext) can clear the hash before recreating.
async function updateRow(
  env: ModelBillingEnv,
  id: string,
  fields: Partial<Pick<ManagedModelKeyRow, "or_key_hash" | "managed_credential_id" | "status" | "attempts" | "last_error" | "superseded_at">>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?${sets.length + 1}`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  vals.push(id);
  await env.OPENCOMPUTER_DB.prepare(`UPDATE managed_model_keys SET ${sets.join(", ")} WHERE id = ?${vals.length}`)
    .bind(...vals)
    .run();
}

// ── Autumn balance → initial OR cap ─────────────────────────────────────────

async function remainingCreditsUsd(env: ModelBillingEnv, orgId: string): Promise<number> {
  const cust = await getAutumnCustomer(env, orgId);
  const remaining = cust?.balances?.credits?.remaining;
  return typeof remaining === "number" ? remaining : 0;
}

// Initial provider-spend cap = remaining / (1+markup) so the Autumn balance is the
// hard customer budget even with markup (§7). usage=0 at provision time.
function initialCapUsd(remainingUsd: number, bps: number): number {
  return Math.max(0, remainingUsd / (1 + bps / 10000));
}

// ── edge → sessions-api hand-off (HMAC, §6.7.5) ─────────────────────────────

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Signs `${ts}.${method}.${path}.${body}` (path includes query) and calls
// sessions-api. Returns the parsed JSON. `path` must start with HANDOFF_PATH.
async function signedHandoff(
  env: ModelBillingEnv,
  method: "POST" | "GET",
  path: string,
  body: string,
): Promise<unknown> {
  if (!env.OC_MANAGED_CRED_HMAC_SECRET) {
    throw new Error("model-billing: OC_MANAGED_CRED_HMAC_SECRET unset — refusing hand-off");
  }
  const base = (env.SESSIONS_API_URL ?? DEFAULT_SESSIONS_API).replace(/\/+$/, "");
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(env.OC_MANAGED_CRED_HMAC_SECRET, `${ts}.${method}.${path}.${body}`);
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-oc-managed-ts": ts,
      "x-oc-managed-sig": sig,
    },
    body: method === "GET" ? undefined : body,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`managed-credential ${method} ${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Hand the freshly-minted plaintext OR key to sessions-api to seal. Idempotent per
// (owner_id, operation_id): a re-call rotates rather than duplicates. Returns the
// managed_credential_id. The plaintext is NEVER persisted on the edge.
async function bindManagedCredential(
  env: ModelBillingEnv,
  p: { ownerId: string; orKeyHash: string; operationId: string; key: string },
): Promise<string> {
  const body = JSON.stringify({
    owner_id: p.ownerId,
    provider: "openrouter",
    key: p.key,
    or_key_hash: p.orKeyHash,
    operation_id: p.operationId,
  });
  const out = (await signedHandoff(env, "POST", HANDOFF_PATH, body)) as { managed_credential_id?: string };
  if (!out?.managed_credential_id) throw new Error("managed-credential POST: no managed_credential_id in response");
  return out.managed_credential_id;
}

// Lost-response recovery (§5.1): is a managed credential already bound for this
// (owner, or_key_hash)? Returns its id, or null if not bound (plaintext is gone →
// caller must delete + recreate the OR key).
async function lookupManagedCredential(
  env: ModelBillingEnv,
  p: { ownerId: string; orKeyHash: string },
): Promise<string | null> {
  const qs = `?owner_id=${encodeURIComponent(p.ownerId)}&or_key_hash=${encodeURIComponent(p.orKeyHash)}`;
  const out = (await signedHandoff(env, "GET", HANDOFF_PATH + qs, "")) as { managed_credential_id?: string | null };
  return out?.managed_credential_id ?? null;
}

// ── the state machine ───────────────────────────────────────────────────────

export interface EnableResult {
  status: "active" | "error";
  credentialId?: string;
}

// enableManagedBilling drives one autumn org off→provisioning→active, idempotently.
// Safe to re-invoke: it resumes from persisted state (insert → create OR key → bind
// → flip), repairing partial failures (§5.1 partial-failure repair).
export async function enableManagedBilling(env: ModelBillingEnv, orgId: string): Promise<EnableResult> {
  const org = await getOrg(env, orgId);
  if (!org) throw new Error(`model-billing: org ${orgId} not found`);
  // Managed billing is autumn-only (§3 invariant 6).
  if (org.billing_provider !== "autumn") {
    throw new Error(`model-billing: org ${orgId} is '${org.billing_provider}', not autumn — refusing`);
  }

  await setOrgStatus(env, orgId, "provisioning");

  let row = await getResumableRow(env, orgId);
  if (!row) {
    row = await insertRow(env, {
      id: newRowId(),
      orgId,
      operationId: newOperationId(),
      createdAt: Math.floor(Date.now() / 1000),
    });
  }
  return driveProvisioning(env, org, row);
}

async function driveProvisioning(env: ModelBillingEnv, org: OrgBillingRow, row: ManagedModelKeyRow): Promise<EnableResult> {
  try {
    // Step 2: mint the OR key (once). Persist the hash before binding so a lost
    // bind response is recoverable.
    if (!row.or_key_hash) {
      const remaining = await remainingCreditsUsd(env, org.id);
      const limitUsd = initialCapUsd(remaining, markupBps(env, org));
      const created = await createOrKey(env, { name: orKeyName(org.id), limitUsd });
      await updateRow(env, row.id, { or_key_hash: created.data.hash, attempts: 0, last_error: null });
      row.or_key_hash = created.data.hash;

      // Step 3: hand the plaintext to sessions-api immediately (still in memory,
      // never persisted). On success persist the credential id.
      const credId = await bindManagedCredential(env, {
        ownerId: ownerIdForOrg(org.id),
        orKeyHash: created.data.hash,
        operationId: row.operation_id!,
        key: created.key,
      });
      await updateRow(env, row.id, { managed_credential_id: credId });
      row.managed_credential_id = credId;
    } else if (!row.managed_credential_id) {
      // Step 3 recovery: the OR key exists but the bind never completed (its
      // response was lost, or it crashed before persisting). The plaintext is
      // one-time and gone, so we CANNOT re-send. Look it up; adopt if bound, else
      // delete the orphan key and recreate from step 2.
      const existing = await lookupManagedCredential(env, {
        ownerId: ownerIdForOrg(org.id),
        orKeyHash: row.or_key_hash,
      });
      if (existing) {
        await updateRow(env, row.id, { managed_credential_id: existing });
        row.managed_credential_id = existing;
      } else {
        await deleteOrKey(env, row.or_key_hash);
        await updateRow(env, row.id, { or_key_hash: null });
        row.or_key_hash = null;
        return driveProvisioning(env, org, row);
      }
    }

    // Step 4: flip the org active — Managed is now offered + resolvable.
    await setOrgStatus(env, org.id, "active");
    console.log(`model-billing: org ${org.id} active (key ${row.or_key_hash}, cred ${row.managed_credential_id})`);
    return { status: "active", credentialId: row.managed_credential_id ?? undefined };
  } catch (e) {
    const attempts = row.attempts + 1;
    const msg = e instanceof Error ? e.message : String(e);
    await updateRow(env, row.id, { attempts, last_error: msg });
    if (attempts >= MAX_PROVISION_ATTEMPTS) {
      await setOrgStatus(env, org.id, "error");
      console.error(`model-billing: org ${org.id} parked in 'error' after ${attempts} attempts: ${msg}`);
      return { status: "error" };
    }
    console.error(`model-billing: org ${org.id} provisioning attempt ${attempts} failed: ${msg}`);
    throw e;
  }
}

// reconcileManagedBilling repairs an org whose status disagrees with its rows
// (§5.1 / §5.7). Drives 'active' orgs back to a consistent active state and resumes
// stuck 'provisioning' ones. Returns the resolved state.
export async function reconcileManagedBilling(env: ModelBillingEnv, orgId: string): Promise<EnableResult> {
  const org = await getOrg(env, orgId);
  if (!org) throw new Error(`model-billing: org ${orgId} not found`);
  if (org.model_billing_status === "off") return { status: "error" };

  const complete = await getActiveKeyRow(env, orgId);
  if (complete) {
    if (org.model_billing_status !== "active") await setOrgStatus(env, orgId, "active");
    return { status: "active", credentialId: complete.managed_credential_id ?? undefined };
  }
  // No complete key but status isn't off → finish provisioning.
  return enableManagedBilling(env, orgId);
}

// disableManagedBilling marks the org's active key 'deleting' (§5.8). The metering
// cron (step 3) keeps polling it until spend quiesces, does a final debit, then
// DELETEs the OR key + revokes the credential, and flips the org 'off' once no
// usable key remains. We only move state here; we do NOT delete mid-spend.
export async function disableManagedBilling(env: ModelBillingEnv, orgId: string): Promise<void> {
  const row = await getActiveKeyRow(env, orgId);
  if (row) {
    await updateRow(env, row.id, { status: "deleting" });
    console.log(`model-billing: org ${orgId} key ${row.or_key_hash} → deleting (drain + offboard handled by cron)`);
  } else {
    // Nothing usable to drain → off immediately.
    await setOrgStatus(env, orgId, "off");
  }
}
