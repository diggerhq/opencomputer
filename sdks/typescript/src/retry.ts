// Transient-failure retry for SDK HTTP calls.
//
// One retry, short fixed delay, and a deliberately narrow predicate: network
// errors (fetch rejected — DNS, reset, TLS) and proxy-level 5xx (502/503/504,
// plus 500) that almost always mean the request never reached — or never
// finished in — the origin handler. Anything else (4xx, app-level errors)
// surfaces immediately. Callers on non-idempotent paths (exec submission)
// still qualify: a 502/503/504 is emitted by an intermediary before or
// instead of origin processing, so re-sending does not double-run work in
// any case we have observed; genuinely ambiguous statuses are not retried.

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const RETRY_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch() with a single retry on transient transport failures.
 * Non-retryable responses (including 4xx) are returned as-is for the caller's
 * normal error handling.
 */
export async function transientFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const resp = await fetch(url, init);
    if (!RETRY_STATUSES.has(resp.status)) return resp;
  } catch {
    // network-level failure — retry below
  }
  await sleep(RETRY_DELAY_MS);
  return fetch(url, init);
}
