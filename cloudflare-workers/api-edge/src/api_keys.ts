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
  expiresAt?: string;
}

export async function hashAPIKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates an ordinary OpenComputer org key. The caller owns the one-time
 * plaintext response; only its SHA-256 hash is persisted. `expiresAt` (epoch
 * seconds) is optional; key validation refuses the key after it. `cliLogin`
 * marks a key minted by `opencomputer login`, the only kind that may later be
 * traded for a key in another of its creator's orgs.
 */
export async function createAPIKey(
  env: APIKeyEnv,
  input: { orgID: string; userID: string; name: string; expiresAt?: number; cliLogin?: boolean },
): Promise<CreatedAPIKey> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const plainKey = "osb_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashAPIKey(plainKey);
  const prefix = plainKey.slice(0, 8);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO api_keys (id, org_id, created_by, key_hash, key_prefix, name, scopes, created_at, expires_at, cli_login)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sandbox:*', ?7, ?8, ?9)`,
  )
    .bind(id, input.orgID, input.userID, hash, prefix, input.name, now, input.expiresAt ?? null, input.cliLogin ? 1 : 0)
    .run();

  return {
    id,
    orgId: input.orgID,
    name: input.name,
    key: plainKey,
    keyPrefix: prefix,
    scopes: ["sandbox:*"],
    createdAt: new Date(now * 1000).toISOString(),
    ...(input.expiresAt !== undefined
      ? { expiresAt: new Date(input.expiresAt * 1000).toISOString() }
      : {}),
  };
}
