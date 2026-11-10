// The runner's event-loop delay (work 082, `loop.lag`): how late the loop ran
// what it was given, the number that says whether a change to the runner (a
// journal, a second subscriber, a bigger record) costs the person latency.
// Node's delay histogram samples every 10 ms; each window reports its max and
// mean beyond that interval, then starts over. The caller decides whether a
// window is worth emitting (turn-events.ts: only while a turn is open).
//
// Invariants: the sampler never keeps the process alive, never throws into
// the loop it measures, and reports facts per window, never a percentile
// (work 054: the pipes aggregate).

import { monitorEventLoopDelay } from 'node:perf_hooks';

export const RESOLUTION_MS = 10;
export const WINDOW_MS = 5000;

export interface LoopLag {
  /** The longest delay beyond the sampling interval in the window, ms. */
  maxMs: number;
  /** The mean delay beyond the sampling interval, ms, one decimal. */
  meanMs: number;
  windowMs: number;
}

/** What a window of node's histogram (nanoseconds) reports; undefined when it took no sample. */
export function reading(h: { max: number; mean: number; count: number }, windowMs: number): LoopLag | undefined {
  if (!h.count) return undefined;
  const excess = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS);
  return { maxMs: Math.round(excess(h.max)), meanMs: Math.round(excess(h.mean) * 10) / 10, windowMs: Math.round(windowMs) };
}

/** Start sampling; `report` gets one reading per window. Returns a stop function. */
export function sampleLoopLag(report: (l: LoopLag) => void, windowMs = WINDOW_MS): () => void {
  const h = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  h.enable();
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    try {
      const r = reading(h, now - last);
      if (r) report(r);
    } catch {
      // Telemetry never fails the runner.
    }
    h.reset();
    last = now;
  }, windowMs);
  timer.unref();
  return () => (clearInterval(timer), h.disable());
}
