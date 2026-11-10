// The organization's API keys as the wire sees them (work 084). The OpenComputer edge owns keys
// (D1 `api_keys`); it tells blue when one is made (`POST /v1/computer/keys/sync`) or revoked
// (`/keys/revoke`), and every key-authenticated API call carries the key's claims, which fill a
// key blue has not heard of yet (keys older than 084) in the background. This writes the wire
// Worker's KV records (src/wire/keys.ts reads them):
//
//   h:<sha256 hex>  → WireKeyRecord      k:<keyId> → the hash, plain text
//
// The Computer DO is the single writer per organization, so the `wire_keys` table here is the
// truth for "what KV should hold": a tunnel change (the record carries tunnelId) rewrites every
// record from it, and a revocation deletes both KV entries and tells the host (`revoked`), so the
// relay closes the key's sockets at once instead of after KV's 60 s edge cache.

import type { ApiTelemetry } from "./telemetry/api.js";
import type { AssertedApiKey } from "../edge/auth.js";
import { API_SCOPES, type ApiScope } from "./api-types.js";
import { keyHashKey, keyIdKey, type WireKeyRecord } from "../wire/keys.js";

/** What keys.ts needs of the KV binding. */
export interface WireKeysWriter {
  put(key: string, value: string, options?: { expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Scopes a wildcard never grants: the key must name them (work 095). */
const NAMED_ONLY: readonly ApiScope[] = ["secrets:write"];

/**
 * A key's API scopes. Keys made before scopes existed carry `sandbox:*` (the edge hardcodes it),
 * and `*` or no scopes at all mean the same: every scope except `secrets:write`, which a key gets
 * only by naming it (work 095: the one-hour keys sessions mint are `sandbox:*`, and a session must
 * not be able to set a secret). Otherwise the scopes the API knows.
 */
export function apiScopes(raw: readonly string[] | undefined): ApiScope[] {
  const named = (scope: ApiScope) => raw?.includes(scope) ?? false;
  const wildcard = !raw || raw.length === 0 || raw.some((s) => s === "*" || s === "sandbox:*");
  return API_SCOPES.filter((scope) => named(scope) || (wildcard && !NAMED_ONLY.includes(scope)));
}

export interface KeyRow {
  keyId: string;
  hash: string;
  member: string;
  scopes: string;
  kind: "user" | "project";
  expiresAt: number | null;
  /** The tunnel the KV record names; null: not written (no tunnel yet). */
  tunnelId: string | null;
}

export interface ComputerKeysDeps {
  sql: SqlStorage;
  kv: WireKeysWriter | undefined;
  organizationId: () => string | undefined;
  /** The organization's tunnel id, or null before it has one. */
  tunnelId: () => string | null;
  /** Tells the host a key is gone (protocol v4 `revoked`); false when no v4 host is connected. */
  revoked: (keyId: string) => boolean | void;
  /** Keeps a background write alive past the response. */
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  /** Work 084 instrumentation: one `keys.synced` per sync, one `keys.revoked` per revoke. */
  telemetry?: Pick<ApiTelemetry, "keySynced" | "keyRevoked">;
}

export type SyncTrigger = "sync" | "observe" | "ensure" | "rewrite";

export interface SyncedKey {
  id: string;
  hash: string;
  kind: "user" | "project";
  scopes: string[];
  /** ISO, ms epoch or null. */
  expiresAt: string | number | null;
  member: string;
}

const HASH = /^[0-9a-f]{64}$/;

export class ComputerKeys {
  private readonly now: () => number;

  constructor(private readonly deps: ComputerKeysDeps) {
    this.now = deps.now ?? Date.now;
    deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS wire_keys (
        key_id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        member TEXT NOT NULL,
        scopes TEXT NOT NULL,
        kind TEXT NOT NULL,
        expires_at INTEGER,
        tunnel_id TEXT
      );
    `);
  }

  private row(keyId: string): KeyRow | undefined {
    return [
      ...this.deps.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT key_id AS keyId, hash, member, scopes, kind, expires_at AS expiresAt, tunnel_id AS tunnelId FROM wire_keys WHERE key_id = ?",
        keyId,
      ),
    ][0] as unknown as KeyRow | undefined;
  }

  /** The key's record as KV holds it; null without a tunnel or organization. */
  private record(row: KeyRow, tunnelId: string): WireKeyRecord | null {
    const org = this.deps.organizationId();
    if (!org) return null;
    return {
      org,
      member: row.member,
      computer: org,
      tunnelId,
      keyId: row.keyId,
      scopes: row.scopes ? row.scopes.split(",") : [],
      expiresAt: row.expiresAt,
      kind: row.kind,
    };
  }

  /** Records (or updates) a key and writes its KV records. Idempotent. */
  async sync(key: SyncedKey, trigger: SyncTrigger = "sync"): Promise<void> {
    const t = this.deps.telemetry;
    if (!t) return void (await this.syncNow(key));
    const began = performance.now();
    let kvWrites = 0;
    let ok = false;
    try {
      kvWrites = await this.syncNow(key);
      ok = true;
    } finally {
      t.keySynced({ keyId: key.id, trigger, ms: performance.now() - began, ok, kvWrites });
    }
  }

  /** `sync`, answering the KV puts and deletes it made. */
  private async syncNow(key: SyncedKey): Promise<number> {
    if (!key.id || !HASH.test(key.hash)) throw new Error("invalid key");
    const expiresAt =
      key.expiresAt === null ? null : typeof key.expiresAt === "number" ? key.expiresAt : Date.parse(key.expiresAt);
    if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new Error("invalid expiresAt");
    const previous = this.row(key.id);
    const scopes = apiScopes(key.scopes).join(",");
    this.deps.sql.exec(
      `INSERT INTO wire_keys (key_id, hash, member, scopes, kind, expires_at, tunnel_id) VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(key_id) DO UPDATE SET hash = excluded.hash, member = excluded.member, scopes = excluded.scopes,
         kind = excluded.kind, expires_at = excluded.expires_at`,
      key.id,
      key.hash,
      key.member,
      scopes,
      key.kind,
      expiresAt,
    );
    // A changed hash (never expected: keys are not rotated in place) must not leave the old one live.
    let writes = 0;
    if (previous && previous.hash !== key.hash && this.deps.kv) {
      await this.deps.kv.delete(keyHashKey(previous.hash));
      writes++;
    }
    return writes + (await this.write(this.row(key.id)!));
  }

  /**
   * Fills a key the caller authenticated with but this computer has not recorded (keys made
   * before 084, or a sync that failed), in the background. One indexed read on the hot path.
   */
  observe(key: AssertedApiKey, member: string): void {
    const row = this.row(key.id);
    const tunnelId = this.deps.tunnelId();
    if (row && row.hash === key.hash && (row.tunnelId === tunnelId || !tunnelId)) return;
    this.deps.waitUntil(
      this.sync({ id: key.id, hash: key.hash, kind: key.kind, scopes: key.scopes, expiresAt: key.expiresAt, member }, "observe").catch(
        (error) => console.warn(JSON.stringify({ level: "warn", event: "computer.wire_key_fill_failed", keyId: key.id, message: String(error) })),
      ),
    );
  }

  /**
   * Like `observe`, but awaited: a ticket names the key by id and the wire looks it up in KV at
   * once, so the record must be there before the ticket leaves.
   */
  async ensure(key: AssertedApiKey, member: string): Promise<boolean> {
    const row = this.row(key.id);
    const tunnelId = this.deps.tunnelId();
    if (row && row.hash === key.hash && row.tunnelId === tunnelId) return false;
    await this.sync({ id: key.id, hash: key.hash, kind: key.kind, scopes: key.scopes, expiresAt: key.expiresAt, member }, "ensure");
    return true;
  }

  /** Forgets a key: deletes its KV records and tells the host. Idempotent; unknown ids are fine. */
  async revoke(keyId: string): Promise<boolean> {
    const began = performance.now();
    const row = this.row(keyId);
    this.deps.sql.exec("DELETE FROM wire_keys WHERE key_id = ?", keyId);
    const hostTold = this.deps.revoked(keyId) === true;
    let ok = false;
    try {
      if (this.deps.kv) {
        await Promise.all([
          this.deps.kv.delete(keyIdKey(keyId)),
          ...(row ? [this.deps.kv.delete(keyHashKey(row.hash))] : []),
        ]);
      }
      ok = true;
    } finally {
      this.deps.telemetry?.keyRevoked({ keyId, ms: performance.now() - began, known: Boolean(row), hostTold, ok });
    }
    return Boolean(row);
  }

  /** Rewrites every record whose tunnel is not the current one (after the tunnel is made or changed). */
  async rewriteAll(): Promise<number> {
    const tunnelId = this.deps.tunnelId();
    if (!tunnelId || !this.deps.kv) return 0;
    const stale = [
      ...this.deps.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT key_id AS keyId, hash, member, scopes, kind, expires_at AS expiresAt, tunnel_id AS tunnelId FROM wire_keys WHERE tunnel_id IS NULL OR tunnel_id != ?",
        tunnelId,
      ),
    ] as unknown as KeyRow[];
    for (const row of stale) {
      const began = performance.now();
      let ok = false;
      let kvWrites = 0;
      try {
        kvWrites = await this.write(row);
        ok = true;
      } finally {
        this.deps.telemetry?.keySynced({ keyId: row.keyId, trigger: "rewrite", ms: performance.now() - began, ok, kvWrites });
      }
    }
    return stale.length;
  }

  /** Writes the row's KV records (or deletes an expired key's); answers the KV calls made. */
  private async write(row: KeyRow): Promise<number> {
    const tunnelId = this.deps.tunnelId();
    const kv = this.deps.kv;
    if (!tunnelId || !kv) return 0;
    if (row.expiresAt !== null && row.expiresAt <= this.now()) {
      await Promise.all([kv.delete(keyHashKey(row.hash)), kv.delete(keyIdKey(row.keyId))]);
      return 2;
    }
    const record = this.record(row, tunnelId);
    if (!record) return 0;
    // KV refuses an expiration under 60 s out; such a key is about to die anyway, and the wire
    // checks `expiresAt` itself.
    const expiration =
      row.expiresAt !== null && row.expiresAt - this.now() > 120_000 ? Math.ceil(row.expiresAt / 1000) : undefined;
    const options = expiration ? { expiration } : undefined;
    // The hash record first: a `k:` entry never points at a missing record for long.
    await kv.put(keyHashKey(row.hash), JSON.stringify(record), options);
    await kv.put(keyIdKey(row.keyId), row.hash, options);
    this.deps.sql.exec("UPDATE wire_keys SET tunnel_id = ? WHERE key_id = ?", tunnelId, row.keyId);
    return 2;
  }
}
