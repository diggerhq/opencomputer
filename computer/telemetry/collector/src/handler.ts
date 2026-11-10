// The telemetry collector's request handler (work 054, "Independence from the product"):
// hosts POST batches here with a backend-signed credential; the collector
// verifies it offline, rate-limits per host, stamps identity, re-validates,
// digests repository names and forwards to Tinybird.
//
// Invariants: stateless; no storage, Durable Objects, service bindings or
// calls to anything we run (the rate-limit binding is the only binding), and
// nothing imported from the backend, so a product outage cannot stop collection.
// Status codes are the host's contract: 2xx delete the batch, 401/400/413
// drop it (`rejected`), 429 and 5xx keep it and retry with backoff.

import { parseDenylist, verify } from './credential.js';
import { digestKey, parseBatch, processBatch } from './batch.js';
import { forward } from './tinybird.js';

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Tinybird regional API base, e.g. `https://api.us-west-2.aws.tinybird.co`. */
  TINYBIRD_API_URL?: string;
  /** `calvin_append_collector`. Unset: accept and discard (telemetry off). */
  TINYBIRD_APPEND_TOKEN?: string;
  /** Secret for repository-name digests. */
  REPO_DIGEST_KEY?: string;
  /** The backend's Ed25519 public key(s), raw base64url, comma-separated during rotation. */
  CREDENTIAL_PUBLIC_KEY?: string;
  /** Revoked host ids and `org:<org_id>` entries, comma-separated. */
  CREDENTIAL_DENYLIST?: string;
  /** Set at deploy (`--var VERSION:<sha>`). */
  VERSION?: string;
  RATE_LIMITER?: RateLimit;
}

export const MAX_BODY_BYTES = 1 << 20;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export async function handle(req: Request, env: Env, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/healthz') return json(200, { ok: true });
  if (url.pathname !== '/v1/events') return json(404, { error: 'not found' });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  // Telemetry off: accept and discard, so hosts never build up a spool against it.
  if (!env.TINYBIRD_APPEND_TOKEN) return json(202, { discarded: true });
  if (!env.CREDENTIAL_PUBLIC_KEY || !env.TINYBIRD_API_URL || !env.REPO_DIGEST_KEY) return json(503, { error: 'collector not configured' });

  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const who = await verify(token, env.CREDENTIAL_PUBLIC_KEY, Math.floor(now / 1000), parseDenylist(env.CREDENTIAL_DENYLIST));
  if (!who) return json(401, { error: 'invalid credential' });

  if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: who.host_id })).success)
    return json(429, { error: 'rate limited' }, { 'Retry-After': '10' });

  const declared = Number(req.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'too large' });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: 'too large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'not JSON' });
  }
  const batch = parseBatch(body);
  if (typeof batch === 'string') return json(400, { error: batch });

  const cf = (req as unknown as { cf?: { colo?: string } }).cf;
  const out = await processBatch(batch, who, await digestKey(env.REPO_DIGEST_KEY), {
    version: env.VERSION || 'dev',
    region: cf?.colo ?? 'unknown',
    now,
  });
  const ok = await forward({ url: env.TINYBIRD_API_URL, token: env.TINYBIRD_APPEND_TOKEN, fetch: fetcher }, out.events, out.turns);
  if (!ok) return json(503, { error: 'storage unavailable' });
  return json(200, { events: out.events.length, turns: out.turns.length, invalid: out.invalid });
}
