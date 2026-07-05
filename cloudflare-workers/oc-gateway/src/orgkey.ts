// Org OpenRouter inference-key resolution (design 013 §4, buildout W3 "org OR key from Infisical").
//
// The plaintext managed OR key lives in Infisical, sealed by sessions-api (referenced by the org's
// managed credential → `resolveManagedSecret`; edge `managed_model_keys` owns the key lifecycle). A
// CF Worker cannot reach Infisical or the box secrets-proxy (design §4), so the gateway resolves the
// key through a DEDICATED internal sessions-api seam — mirroring the edge's dedicated-secret
// plaintext-key hand-off (model_billing.ts §6.7.5): a route that carries a live key gets its OWN
// secret, never the generic internal-auth one.
//
// SEAM (sessions-api / L3 must provide — flagged in the W3 PR):
//   POST {GATEWAY_ORKEY_URL}   Authorization: Bearer {GATEWAY_ORKEY_SECRET}   body {"org": orgId}
//   → 200 {"key": "sk-or-..."}  (resolveManagedSecret for the org's active managed credential)
//   → 404/other on no active managed key.
//
// The plaintext is cached PER ORG in-isolate with a short TTL — it bounds exposure (evaporates with
// the isolate) and avoids hammering the seam on every model call in a turn. TEST_OR_KEY short-circuits
// resolution for the acceptance run against a throwaway $1-capped key (no sealed dev credential needed).

export interface OrgKeyEnv {
  GATEWAY_ORKEY_URL?: string;
  GATEWAY_ORKEY_SECRET?: string;
  /** Acceptance-test / single-key override — bypasses the seam. Never set in multi-org prod. */
  TEST_OR_KEY?: string;
}

interface CacheEntry {
  key: string;
  exp: number; // epoch ms
}
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** Resolve the org's OpenRouter inference key, or null if unavailable. Never throws. */
export async function resolveOrgKey(env: OrgKeyEnv, orgId: string, nowMs: number): Promise<string | null> {
  if (env.TEST_OR_KEY) return env.TEST_OR_KEY;

  const hit = cache.get(orgId);
  if (hit && hit.exp > nowMs) return hit.key;

  if (!env.GATEWAY_ORKEY_URL || !env.GATEWAY_ORKEY_SECRET) return null;
  try {
    const r = await fetch(env.GATEWAY_ORKEY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.GATEWAY_ORKEY_SECRET}` },
      body: JSON.stringify({ org: orgId }),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { key?: unknown };
    const key = typeof body.key === "string" && body.key ? body.key : null;
    if (key) cache.set(orgId, { key, exp: nowMs + CACHE_TTL_MS });
    return key;
  } catch {
    return null;
  }
}

/** Test-only: clear the per-isolate cache between cases. */
export function _clearOrgKeyCache(): void {
  cache.clear();
}
