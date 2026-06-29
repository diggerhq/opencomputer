// OpenRouter management-key client. The edge holds exactly ONE OpenRouter secret —
// OPENROUTER_PROVISIONING_KEY, a *management/provisioning* key — and makes every OR
// API call with it: mint per-org inference keys, read their cumulative spend, push
// caps, delete on offboard, and read account analytics. The minted inference keys
// are the per-org billing keys; their plaintext is returned by `POST /keys` exactly
// ONCE and is never re-fetchable — the edge hands it straight to sessions-api to seal
// (it is never persisted on the edge). This keeps the "Autumn/OR are edge-native"
// invariant: one OR secret, in one place.
//
// Surfaces + behaviours verified live 2026-06-29 (§9.7 spike, token-billing.md):
// per-key `usage` is cumulative USD and monotonic; both the Anthropic Messages and
// the OpenAI Responses inference paths echo cost. `analytics/query` + key
// create/list/get/patch/delete require a management key (an inference key gets 401).

export interface OpenRouterEnv {
  // A management/provisioning key (NOT an inference key). Mints + manages per-org
  // keys and reads analytics. Stored write-only as a Cloudflare secret.
  OPENROUTER_PROVISIONING_KEY: string;
  // Override for tests; defaults to OpenRouter prod.
  OPENROUTER_BASE_URL?: string;
}

const OR_DEFAULT_BASE = "https://openrouter.ai/api/v1";

// A managed OR key as returned by GET/POST/PATCH /keys (the `data` envelope). The
// plaintext key string is NOT here — it only appears once, on create, as the
// sibling `key` field (see OpenRouterCreatedKey).
export interface OpenRouterKey {
  hash: string; // non-secret key id — what we persist + poll
  name: string;
  label?: string;
  disabled: boolean;
  limit: number | null; // USD spend cap; null = uncapped (we always set one)
  limit_remaining: number | null;
  limit_reset: string | null; // we always use null (cap managed dynamically)
  usage: number; // cumulative USD spent on this key — monotonic, our cost of record
  created_at?: string;
  updated_at?: string;
}

// POST /keys response: the plaintext key (returned ONCE) + the key metadata.
export interface OpenRouterCreatedKey {
  key: string; // plaintext inference key — hand to sessions-api, never persist on edge
  data: OpenRouterKey;
}

// One row of POST /analytics/query, dims [api_key_id, model] (token-billing §5.4 step 4).
export interface OpenRouterAnalyticsRow {
  api_key_id?: string;
  model?: string;
  total_usage?: number; // USD
  tokens_prompt?: number;
  tokens_completion?: number;
  [k: string]: unknown;
}

// Our OR *account* float (GET /credits), monitored by reconcile (§5.7 / §8).
export interface OpenRouterCredits {
  total_credits: number;
  total_usage: number;
}

// Carries the failing op + HTTP code so callers can emit
// model_or_api_errors_total{op,http_code} without re-parsing messages (§8).
export class OpenRouterError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`openrouter ${op} ${status}: ${body.slice(0, 300)}`);
    this.name = "OpenRouterError";
  }
}

async function orFetch(
  env: OpenRouterEnv,
  op: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const base = env.OPENROUTER_BASE_URL || OR_DEFAULT_BASE;
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_PROVISIONING_KEY}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OpenRouterError(op, resp.status, text);
  // OR wraps single resources in `{ data: ... }`; lists/analytics vary by endpoint.
  return text ? JSON.parse(text) : null;
}

// createOrKey mints a per-org inference key. `limit` is the USD spend cap (the hard
// budget — OR refuses calls past it in real time); `limit_reset:null` because we
// manage the cap dynamically off the shared credit pool (§5.4 step 3). Returns the
// plaintext key (once) + metadata.
export async function createOrKey(
  env: OpenRouterEnv,
  p: { name: string; limitUsd: number },
): Promise<OpenRouterCreatedKey> {
  const out = (await orFetch(env, "create_key", "POST", "/keys", {
    name: p.name,
    limit: p.limitUsd,
    limit_reset: null,
  })) as OpenRouterCreatedKey;
  if (!out?.key || !out?.data?.hash) {
    throw new OpenRouterError("create_key", 200, "missing key/hash in response");
  }
  return out;
}

// getOrKey reads one key's cumulative usage + current cap — the billing poll (§5.4).
export async function getOrKey(env: OpenRouterEnv, hash: string): Promise<OpenRouterKey> {
  const out = (await orFetch(env, "get_key", "GET", `/keys/${encodeURIComponent(hash)}`)) as {
    data: OpenRouterKey;
  };
  return out.data;
}

// patchOrKey pushes a new cap and/or disables the key (cap push + emergency disable, §5.4/§5.8).
export async function patchOrKey(
  env: OpenRouterEnv,
  hash: string,
  patch: { limitUsd?: number; disabled?: boolean; name?: string },
): Promise<OpenRouterKey> {
  const body: Record<string, unknown> = {};
  if (patch.limitUsd !== undefined) body.limit = patch.limitUsd;
  if (patch.disabled !== undefined) body.disabled = patch.disabled;
  if (patch.name !== undefined) body.name = patch.name;
  const out = (await orFetch(env, "patch_key", "PATCH", `/keys/${encodeURIComponent(hash)}`, body)) as {
    data: OpenRouterKey;
  };
  return out.data;
}

// deleteOrKey offboards a key (§5.8). Idempotent-ish: a 404 means already gone.
export async function deleteOrKey(env: OpenRouterEnv, hash: string): Promise<void> {
  try {
    await orFetch(env, "delete_key", "DELETE", `/keys/${encodeURIComponent(hash)}`);
  } catch (e) {
    if (e instanceof OpenRouterError && e.status === 404) return;
    throw e;
  }
}

// listOrKeys lists all keys on the account (audit / reconcile, §5.7).
export async function listOrKeys(env: OpenRouterEnv): Promise<OpenRouterKey[]> {
  const out = (await orFetch(env, "list_keys", "GET", "/keys")) as { data?: OpenRouterKey[] };
  return out.data ?? [];
}

// getOrCredits reads our OR account float (§5.7 / §8 — alert when low).
export async function getOrCredits(env: OpenRouterEnv): Promise<OpenRouterCredits> {
  const out = (await orFetch(env, "get_credits", "GET", "/credits")) as {
    data?: OpenRouterCredits;
  } & Partial<OpenRouterCredits>;
  // Some OR responses nest under `data`, some don't — accept either.
  return (out.data ?? (out as OpenRouterCredits));
}

// queryOrAnalytics pulls per-key/per-model spend for the dashboard rollup (§5.4 step 4).
// Management-key only. `dateFrom`/`dateTo` are ISO dates (YYYY-MM-DD).
export async function queryOrAnalytics(
  env: OpenRouterEnv,
  p: {
    dimensions: string[];
    granularity?: string;
    metrics?: string[];
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<OpenRouterAnalyticsRow[]> {
  const out = (await orFetch(env, "analytics_query", "POST", "/analytics/query", {
    dimensions: p.dimensions,
    granularity: p.granularity ?? "day",
    metrics: p.metrics ?? ["total_usage", "tokens_prompt", "tokens_completion"],
    ...(p.dateFrom ? { date_from: p.dateFrom } : {}),
    ...(p.dateTo ? { date_to: p.dateTo } : {}),
  })) as { data?: OpenRouterAnalyticsRow[] };
  return out.data ?? [];
}
