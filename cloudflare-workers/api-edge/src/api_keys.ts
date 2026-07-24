export interface APIKeyEnv {
  OPENCOMPUTER_DB: D1Database;
}

export interface CreatedAPIKey {
  id: string;
  orgId: string;
  name: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
}

export async function hashAPIKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates an ordinary OpenComputer org key. The caller owns the one-time
 * plaintext response; only its SHA-256 hash is persisted.
 */
export async function createAPIKey(
  env: APIKeyEnv,
  input: { orgID: string; userID: string; name: string },
): Promise<CreatedAPIKey> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const plainKey = "osb_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashAPIKey(plainKey);
  const prefix = plainKey.slice(0, 8);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO api_keys (id, org_id, created_by, key_hash, key_prefix, name, scopes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sandbox:*', ?7)`,
  )
    .bind(id, input.orgID, input.userID, hash, prefix, input.name, now)
    .run();

  return {
    id,
    orgId: input.orgID,
    name: input.name,
    key: plainKey,
    keyPrefix: prefix,
    scopes: ["sandbox:*"],
    createdAt: new Date(now * 1000).toISOString(),
  };
}
