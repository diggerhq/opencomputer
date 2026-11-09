// Edge-side secret stores — replaces the legacy per-cell PG-backed
// /api/secret-stores routes. Stores live in D1; entries are envelope-
// encrypted at the edge with SECRET_ENCRYPTION_KEY. The cell-facing side
// (the /internal/secret-stores HMAC endpoints and the refresh fan-out) was
// removed with the sandbox code in 097 step 7.2; only the D1 CRUD remains.
//
// JSON shapes mirror internal/api/projects.go (camelCase) so the existing
// CLI/SDK and dashboard talk to the edge unchanged.

import { encryptSecret } from "./crypto";

export interface SecretStoresEnv {
  OPENCOMPUTER_DB: D1Database;
  SECRET_ENCRYPTION_KEY: string;
}

interface Caller {
  orgID: string;
  userID: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ── store shape mapping ──────────────────────────────────────────────────

interface StoreRow {
  id: string;
  org_id: string;
  name: string;
  egress_allowlist: string;
  created_at: number;
  updated_at: number;
}

function storeToJSON(row: StoreRow): Record<string, unknown> {
  let allowlist: string[] = [];
  try {
    allowlist = JSON.parse(row.egress_allowlist) as string[];
  } catch {
    /* malformed JSON in D1 — degrade to empty list rather than 500 */
  }
  return {
    id: row.id,
    orgID: row.org_id,
    name: row.name,
    egressAllowlist: allowlist,
    // ISO strings (not unix seconds) — matches the legacy CP /api/secret-stores
    // shape that the Go CLI's struct expects. Storing seconds in D1 is fine;
    // serialize for the wire.
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

// ── CRUD: stores ────────────────────────────────────────────────────────

export async function createStore(req: Request, env: SecretStoresEnv, caller: Caller): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { name?: string; egressAllowlist?: string[] } | null;
  if (!body || !body.name) return json({ error: "name is required" }, 400);
  const allowlist = Array.isArray(body.egressAllowlist) ? body.egressAllowlist : [];

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO secret_stores (id, org_id, name, egress_allowlist, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind(id, caller.orgID, body.name, JSON.stringify(allowlist), now)
      .run();
  } catch (e) {
    // UNIQUE(org_id, name) collision → 409
    const msg = (e as Error).message ?? "";
    if (/UNIQUE/.test(msg)) return json({ error: "a store with that name already exists" }, 409);
    throw e;
  }
  return json(
    storeToJSON({ id, org_id: caller.orgID, name: body.name, egress_allowlist: JSON.stringify(allowlist), created_at: now, updated_at: now }),
    201,
  );
}

export async function listStores(_req: Request, env: SecretStoresEnv, caller: Caller): Promise<Response> {
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, org_id, name, egress_allowlist, created_at, updated_at
       FROM secret_stores WHERE org_id = ?1 ORDER BY name ASC`,
  )
    .bind(caller.orgID)
    .all<StoreRow>();
  return json((results ?? []).map(storeToJSON));
}

async function loadStore(env: SecretStoresEnv, orgID: string, id: string): Promise<StoreRow | null> {
  return env.OPENCOMPUTER_DB.prepare(
    `SELECT id, org_id, name, egress_allowlist, created_at, updated_at
       FROM secret_stores WHERE id = ?1 AND org_id = ?2`,
  )
    .bind(id, orgID)
    .first<StoreRow>();
}

export async function getStore(_req: Request, env: SecretStoresEnv, caller: Caller, id: string): Promise<Response> {
  const row = await loadStore(env, caller.orgID, id);
  if (!row) return json({ error: "secret store not found" }, 404);
  return json(storeToJSON(row));
}

export async function updateStore(req: Request, env: SecretStoresEnv, caller: Caller, id: string): Promise<Response> {
  const existing = await loadStore(env, caller.orgID, id);
  if (!existing) return json({ error: "secret store not found" }, 404);
  const body = (await req.json().catch(() => null)) as { name?: string | null; egressAllowlist?: string[] | null } | null;

  const name = typeof body?.name === "string" ? body.name : existing.name;
  const allowlist = Array.isArray(body?.egressAllowlist) ? body!.egressAllowlist! : (JSON.parse(existing.egress_allowlist) as string[]);
  const now = Math.floor(Date.now() / 1000);
  await env.OPENCOMPUTER_DB.prepare(
    `UPDATE secret_stores SET name = ?1, egress_allowlist = ?2, updated_at = ?3
      WHERE id = ?4 AND org_id = ?5`,
  )
    .bind(name, JSON.stringify(allowlist), now, id, caller.orgID)
    .run();
  return json(
    storeToJSON({ id, org_id: caller.orgID, name, egress_allowlist: JSON.stringify(allowlist), created_at: existing.created_at, updated_at: now }),
  );
}

export async function deleteStore(_req: Request, env: SecretStoresEnv, caller: Caller, id: string): Promise<Response> {
  const row = await loadStore(env, caller.orgID, id);
  if (!row) return json({ error: "secret store not found" }, 404);
  // Cascade-delete entries (D1 doesn't enforce FK CASCADE — do it explicitly).
  await env.OPENCOMPUTER_DB.batch([
    env.OPENCOMPUTER_DB.prepare(`DELETE FROM secret_store_entries WHERE store_id = ?1`).bind(id),
    env.OPENCOMPUTER_DB.prepare(`DELETE FROM secret_stores WHERE id = ?1 AND org_id = ?2`).bind(id, caller.orgID),
  ]);
  return new Response(null, { status: 204 });
}

// ── CRUD: entries ──────────────────────────────────────────────────────

interface EntryRow {
  id: string;
  store_id: string;
  name: string;
  encrypted_value: ArrayBuffer | Uint8Array;
  allowed_hosts: string;
  created_at: number;
  updated_at: number;
}

function entryToJSON(row: EntryRow, includeValue = false): Record<string, unknown> {
  let hosts: string[] = [];
  try {
    hosts = JSON.parse(row.allowed_hosts) as string[];
  } catch {
    /* malformed JSON */
  }
  const out: Record<string, unknown> = {
    name: row.name,
    allowedHosts: hosts,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
  if (includeValue) {
    const bytes = row.encrypted_value instanceof Uint8Array ? row.encrypted_value : new Uint8Array(row.encrypted_value);
    out.encryptedValueB64 = btoa(String.fromCharCode(...bytes));
  }
  return out;
}

export async function setEntry(
  req: Request,
  env: SecretStoresEnv,
  caller: Caller,
  storeID: string,
  name: string,
): Promise<Response> {
  if (!name) return json({ error: "secret name required" }, 400);
  const store = await loadStore(env, caller.orgID, storeID);
  if (!store) return json({ error: "secret store not found" }, 404);

  const body = (await req.json().catch(() => null)) as { value?: string; allowedHosts?: string[] } | null;
  if (!body || typeof body.value !== "string" || body.value === "") {
    return json({ error: 'secret value required: {"value": "...", "allowedHosts": [...]}' }, 400);
  }
  const hosts = Array.isArray(body.allowedHosts) ? body.allowedHosts.map((h) => h.trim()) : [];
  if (hosts.some((h) => h === "")) return json({ error: "allowedHosts entries cannot be empty" }, 400);

  const encrypted = await encryptSecret(env.SECRET_ENCRYPTION_KEY, body.value);
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  // UPSERT on (store_id, name).
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO secret_store_entries (id, store_id, name, encrypted_value, allowed_hosts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(store_id, name) DO UPDATE SET
       encrypted_value = excluded.encrypted_value,
       allowed_hosts   = excluded.allowed_hosts,
       updated_at      = excluded.updated_at`,
  )
    .bind(id, storeID, name, encrypted, JSON.stringify(hosts), now)
    .run();

  // This used to fan the new value out to running sandboxes on every active
  // cell. The cells are retired (097 step 7.2), so nothing is refreshed; the
  // response keeps its shape for the CLI.
  return json({ name, status: "set", refreshed: 0, cellsContacted: 0, failures: [] });
}

export async function deleteEntry(
  _req: Request,
  env: SecretStoresEnv,
  caller: Caller,
  storeID: string,
  name: string,
): Promise<Response> {
  const store = await loadStore(env, caller.orgID, storeID);
  if (!store) return json({ error: "secret store not found" }, 404);
  const res = await env.OPENCOMPUTER_DB.prepare(
    `DELETE FROM secret_store_entries WHERE store_id = ?1 AND name = ?2`,
  )
    .bind(storeID, name)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return json({ error: "secret entry not found" }, 404);
  return new Response(null, { status: 204 });
}

export async function listEntries(
  _req: Request,
  env: SecretStoresEnv,
  caller: Caller,
  storeID: string,
): Promise<Response> {
  const store = await loadStore(env, caller.orgID, storeID);
  if (!store) return json({ error: "secret store not found" }, 404);
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id, store_id, name, encrypted_value, allowed_hosts, created_at, updated_at
       FROM secret_store_entries WHERE store_id = ?1 ORDER BY name ASC`,
  )
    .bind(storeID)
    .all<EntryRow>();
  // Never return plaintext or ciphertext on the user-facing route — names only.
  return json((results ?? []).map((r) => entryToJSON(r, false)));
}
