// Colo-shared second tier (Cache API) for the per-isolate hot-path caches.
//
// The per-isolate Maps in index.ts collapse bursts WITHIN one isolate, but the
// benchmark/SDK shape — create → one exec → destroy, each on a fresh HTTP
// connection — routinely lands the exec on a DIFFERENT isolate than the create,
// so the isolate caches miss ~always and every sub-op pays 1-2 blocking D1
// reads (~100-165ms at p50). caches.default is shared by every isolate in a
// colo, so seeding it turns those cross-isolate misses into ~1-5ms colo hits.
//
// Semantics: strictly best-effort (entries evict at Cloudflare's whim), TTLs
// mirror the in-memory caches they back, and the same staleness bounds apply —
// this tier never caches anything the isolate tier wouldn't. Values are JSON.
// In plain-node vitest there is no `caches` global; helpers no-op so tests and
// local tooling behave exactly as before.

const BASE = "https://edge-colo-cache.internal/";

function cacheOrNull(): Cache | null {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

export async function coloGet<T>(kind: string, key: string): Promise<T | null> {
  const cache = cacheOrNull();
  if (!cache) return null;
  try {
    const hit = await cache.match(BASE + kind + "/" + encodeURIComponent(key));
    if (!hit) return null;
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

// coloPut stores value under kind/key for ttlSec. Await it on slow paths (it
// follows a D1 read, so ~1-2ms is noise); fire-and-forget elsewhere.
export async function coloPut(kind: string, key: string, value: unknown, ttlSec: number): Promise<void> {
  const cache = cacheOrNull();
  if (!cache) return;
  try {
    await cache.put(
      BASE + kind + "/" + encodeURIComponent(key),
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${Math.max(1, Math.floor(ttlSec))}`,
        },
      }),
    );
  } catch {
    /* best-effort */
  }
}

// coloDelete drops an entry. Best-effort like the rest of this tier, with one
// caller that genuinely needs it: a stale-while-revalidate refresh that learns
// the underlying row is GONE (an API key revoked out of band). Letting that
// entry age out on its own TTL would keep a revoked credential working for the
// remainder of the stale window in this colo, which is the exact failure the
// refresh exists to prevent — so the refresh evicts instead.
export async function coloDelete(kind: string, key: string): Promise<void> {
  const cache = cacheOrNull();
  if (!cache) return;
  try {
    await cache.delete(BASE + kind + "/" + encodeURIComponent(key));
  } catch {
    /* best-effort */
  }
}
