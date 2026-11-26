// Ships the host's spool to the telemetry collector (work 054, "Pipeline"):
// every 2 s the open segment is sealed and sealed segments are POSTed oldest
// first, one batch per request, until one fails.
//
//   POST <SP_TELEMETRY_URL>/v1/events
//   Authorization: Bearer <signed telemetry credential>
//   { "host_boot_id": "…", "batch_seq": 7, "events": [...], "turns": [...] }
//
// 2xx deletes the segment. 5xx, 401, 408, 429, a timeout or no network back
// off 1 s, doubling to 60 s, and keep the segment (401 too: a renewed
// credential arrives with the next `welcome`). Any other 4xx deletes it and
// counts its records `rejected`. Without a credential nothing is sent and the
// spool keeps filling up to its cap.
//
// Invariants: never more than one request in flight; no method throws or
// rejects. `drain` is the SIGTERM path: one pass within the deadline, ignoring
// the backoff, and whatever is left stays on disk for the next process.

import type { Spool, Segment } from './telemetry-spool.js';

export interface ShipperOptions {
  spool: Spool;
  /** The collector's base URL. */
  url: string;
  /** The current credential; read per request, so a renewal applies at once. */
  credential: () => string | undefined;
  fetch?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export interface Shipper {
  /** Send now (a segment just filled up), unless backing off. */
  kick(): void;
  /** Stop the timer, then try to send everything within `ms`. */
  drain(ms: number): Promise<void>;
  /** Current backoff, 0 when the last request succeeded. */
  readonly backoffMs: number;
}

const RETRY = new Set([401, 408, 429]);
type Result = 'sent' | 'rejected' | 'retry';

export function startShipper(o: ShipperOptions): Shipper {
  const send = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const maxBackoff = o.maxBackoffMs ?? 60_000;
  const endpoint = `${o.url.replace(/\/+$/, '')}/v1/events`;
  let backoff = 0;
  let retryAt = 0;
  let stopped = false;
  let running: Promise<void> | undefined;

  async function post(s: Segment, credential: string, ms: number): Promise<Result> {
    const batch = o.spool.load(s);
    if (!batch.events.length && !batch.turns.length) return 'sent';
    try {
      const res = await send(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ host_boot_id: s.bootId, batch_seq: s.seq, ...batch }),
        signal: AbortSignal.timeout(ms),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return 'sent';
      return res.status >= 500 || RETRY.has(res.status) ? 'retry' : 'rejected';
    } catch {
      return 'retry';
    }
  }

  /** Send sealed segments oldest first until one fails, the spool is empty or the deadline passes. */
  async function pump(deadline?: number) {
    try {
      for (;;) {
        if (deadline === undefined && (stopped || now() < retryAt)) return;
        const credential = o.credential();
        const s = o.spool.segments()[0];
        if (!credential || !s) return;
        const left = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - now());
        if (left <= 0) return;
        const r = await post(s, credential, left);
        if (r === 'retry') {
          backoff = backoff ? Math.min(backoff * 2, maxBackoff) : 1000;
          retryAt = now() + backoff;
          return;
        }
        backoff = 0;
        o.spool.remove(s, r === 'rejected' ? 'rejected' : undefined);
      }
    } catch {
      // Spool and clock errors end this pass; the next tick tries again.
    }
  }

  const run = () => {
    running ??= pump().finally(() => (running = undefined));
    return running;
  };
  const timer = setInterval(() => {
    o.spool.seal();
    void run();
  }, o.intervalMs ?? 2000);
  timer.unref?.();

  return {
    kick: () => void run(),
    async drain(ms) {
      stopped = true;
      clearInterval(timer);
      const deadline = now() + ms;
      if (running) {
        let wake: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        await Promise.race([running.then(() => (finished = true)), new Promise<void>((r) => (wake = setTimeout(r, ms)))]);
        clearTimeout(wake);
        if (!finished) return; // the request in flight outlived the deadline; its segment stays on disk
      }
      o.spool.seal();
      await pump(deadline);
    },
    get backoffMs() {
      return backoff;
    },
  };
}
