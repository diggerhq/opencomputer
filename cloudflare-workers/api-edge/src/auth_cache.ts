// The API-key auth cache's isolate tier, in a module of its own so the
// dashboard (which index.ts imports) can evict entries without importing
// index.ts back. index.ts owns the entry shape and every read; this module only
// holds the Map and the eviction a revocation needs.

import { coloDelete } from "./colo_cache";

export const authCache = new Map<string, unknown>();

// evictAuth drops revoked keys from this isolate and this colo at once. Other
// colos keep a fresh entry for at most AUTH_TTL_MS; after that their stale
// copy triggers a refresh that finds the row gone and evicts it there too.
export async function evictAuth(hashes: Iterable<string>): Promise<void> {
  for (const hash of hashes) {
    authCache.delete(hash);
    await coloDelete("auth", hash);
  }
}
