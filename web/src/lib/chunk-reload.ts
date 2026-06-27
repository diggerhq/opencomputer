// Recovery for stale code-split chunks after a deploy.
//
// Each build emits content-hashed route chunks (e.g. Billing-a1b2.js). A deploy
// replaces them, so a tab opened before the deploy still holds an index.html
// that references chunk URLs which no longer exist. Navigating to a
// not-yet-loaded route then fails the dynamic import() — and because the CF
// assets binding uses not_found_handling="single-page-application", the missing
// .js is answered with index.html (HTML), so the browser gets a document where
// it expected a module. React.lazy rethrows that rejection and the route
// ErrorBoundary shows "Something went wrong".
//
// The fix is to reload once: a fresh index.html references the current chunk
// hashes. A short time window guards against a reload loop when the failure is
// not a stale chunk (a genuinely broken/unreachable build), in which case the
// error surfaces normally for a manual retry.

const RELOAD_AT_KEY = 'oc:chunk-reload-at'
const RELOAD_WINDOW_MS = 10_000

// Messages browsers/Vite use when a dynamic import() can't load or parse a
// module: stale chunk, network miss, or HTML served where a module was expected.
const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|module script failed|expected a JavaScript module|ChunkLoadError|Loading chunk [\w-]+ failed/i

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR_RE.test(error.message)
}

/**
 * Reload the page to recover a stale chunk, at most once per RELOAD_WINDOW_MS so
 * a persistently-broken deploy can't reload-loop. Returns true if a reload was
 * started (the caller should stop and render nothing), false if it declined (the
 * caller should surface the error normally).
 */
export function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_AT_KEY)) || 0
    if (Date.now() - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()))
  } catch {
    // sessionStorage blocked (private mode / partitioned storage) — can't guard
    // against a loop, so don't auto-reload; let the error surface instead.
    return false
  }
  window.location.reload()
  return true
}
