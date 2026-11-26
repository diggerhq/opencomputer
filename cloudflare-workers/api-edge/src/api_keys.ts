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
 * seconds) is optional; key validation refuses the key after it.
 */
export async function createAPIKey(
  env: APIKeyEnv,
  input: CreateAPIKeyInput,
): Promise<CreatedAPIKey> {
  return (await createAPIKeyWithHash(env, input)).created;
}

/**
 * The scopes a new key names (work 095). The computer API reads them; a key
 * made before scopes carries `sandbox:*`, which it reads as all of these.
 * `secrets:write` is deliberately absent: no key gets it without naming it,
 * and nothing here mints one that does.
 */
export const KEY_SCOPES: readonly string[] = [
  "sessions:read",
  "sessions:write",
  "asks:answer",
  "terminals",
];

/**
 * The scopes of the one-hour key a computer session mints. Listed apart from
 * KEY_SCOPES so that widening people's keys never widens a session's.
 */
export const COMPUTER_SESSION_KEY_SCOPES: readonly string[] = [
  "sessions:read",
  "sessions:write",
  "asks:answer",
  "terminals",
];

export interface CreateAPIKeyInput {
  orgID: string;
  userID: string;
  name: string;
  /** Every minter names its scopes; there is no default. */
  scopes: readonly string[];
  expiresAt?: number;
  sessionKey?: string;
}

/**
 * createAPIKey plus the stored SHA-256 hex, for callers that tell the
 * computer API about the new key (work 084). The hash never goes in the
 * one-time response.
 */
export async function createAPIKeyWithHash(
  env: APIKeyEnv,
  input: CreateAPIKeyInput,
): Promise<{ created: CreatedAPIKey; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const plainKey = "osb_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashAPIKey(plainKey);
  const prefix = plainKey.slice(0, 8);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.some((scope) => !/^[a-z]+(:[a-z]+)?$/.test(scope))) {
    // An empty list or a wildcard would read as "everything" downstream.
    throw new Error("api key scopes must be an explicit list");
  }

  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO api_keys (id, org_id, created_by, key_hash, key_prefix, name, scopes, created_at, expires_at, session_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?10, ?7, ?8, ?9)`,
  )
    .bind(id, input.orgID, input.userID, hash, prefix, input.name, now, input.expiresAt ?? null, input.sessionKey ?? null, scopes.join(","))
    .run();

  const created: CreatedAPIKey = {
    id,
    orgId: input.orgID,
    name: input.name,
    key: plainKey,
    keyPrefix: prefix,
    scopes,
    createdAt: new Date(now * 1000).toISOString(),
    ...(input.expiresAt !== undefined
      ? { expiresAt: new Date(input.expiresAt * 1000).toISOString() }
      : {}),
  };
  return { created, hash };
}
