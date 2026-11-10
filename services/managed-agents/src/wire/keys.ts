// The wire's view of API keys (work 084): Workers KV, written by blue's
// src/computer/keys.ts when a key is made, changed or revoked, read here with
// a 60 s edge cache (so a revocation is seen within a minute).
//
//   h:<sha256 hex of the raw key>  → WireKeyRecord (JSON)
//   k:<keyId>                      → that hash, plain text (for tickets, which carry the key's id)

export interface WireKeyRecord {
  org: string;
  /** `usr_…`, the key's member. */
  member: string;
  computer: string;
  tunnelId: string;
  keyId: string;
  scopes: string[];
  /** ms epoch; null: never. */
  expiresAt: number | null;
  kind: "user" | "project";
}

export interface WireKeysKv {
  get(key: string, options: { type: "json"; cacheTtl?: number }): Promise<unknown>;
  get(key: string, options: { type: "text"; cacheTtl?: number }): Promise<string | null>;
}

export const KV_CACHE_TTL_S = 60;
export const keyHashKey = (hash: string) => `h:${hash}`;
export const keyIdKey = (keyId: string) => `k:${keyId}`;

function isRecord(value: unknown): value is WireKeyRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<WireKeyRecord>;
  return (
    typeof r.org === "string" && typeof r.member === "string" && typeof r.computer === "string" &&
    typeof r.tunnelId === "string" && typeof r.keyId === "string" &&
    Array.isArray(r.scopes) && r.scopes.every((s) => typeof s === "string") &&
    (r.expiresAt === null || r.expiresAt === undefined || typeof r.expiresAt === "number") &&
    (r.kind === "user" || r.kind === "project")
  );
}

/** The record for a key hash, or null (unknown, revoked or malformed). */
export async function recordByHash(kv: WireKeysKv, hash: string): Promise<WireKeyRecord | null> {
  const value = await kv.get(keyHashKey(hash), { type: "json", cacheTtl: KV_CACHE_TTL_S });
  return isRecord(value) ? value : null;
}

/** The record for a key id (a ticket's), or null. Two reads; both edge-cached. */
export async function recordByKeyId(kv: WireKeysKv, keyId: string): Promise<WireKeyRecord | null> {
  const stored = await kv.get(keyIdKey(keyId), { type: "text", cacheTtl: KV_CACHE_TTL_S });
  // Plain text is the contract; a JSON-encoded string is tolerated.
  const hash = stored?.replace(/^"(.*)"$/, "$1");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const record = await recordByHash(kv, hash);
  return record && record.keyId === keyId ? record : null;
}
