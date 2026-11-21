// Memory-pressure eviction: when the machine's available memory drops below
// SP_EVICT_MIN_AVAILABLE_MB, the host stops idle threads before SP_IDLE_MS
// would, least recently used first, and only when none is left drops a spare.
// A stopped thread resumes on its next message (a container in ~0.8 s), as
// after an idle exit; a spare is cheaper to keep than that resume is to pay,
// so the warm pool goes last. While memory is low the pool is not refilled.
//
// Invariants:
// - Never a runner that is busy, starting, exiting or switching, has a
//   subagent running or a terminal open, or had a delivery in the last
//   `minIdleMs`: only what the idle exit would stop, earlier.
// - At most one runner per check, so the memory it frees is seen before the
//   next goes; checks run every `intervalMs`, never in a loop.
// - Threshold 0, or no MemAvailable (not Linux): never evicts.

import { readFileSync } from 'node:fs';

export const EVICT_MIN_AVAILABLE_MB = 2048;
export const EVICT_INTERVAL_MS = 10_000;
/** A runner delivered to this recently may not have reported `busy` yet. */
export const EVICT_MIN_IDLE_MS = 60_000;

/** SP_EVICT_MIN_AVAILABLE_MB: unset or empty is the default, 0 is off; anything else that is not a number ≥ 0 throws at boot. */
export function evictThresholdMb(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return EVICT_MIN_AVAILABLE_MB;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`SP_EVICT_MIN_AVAILABLE_MB must be a number of MB ≥ 0 (0: off), not ${JSON.stringify(v)}`);
  return n;
}

/** MemAvailable from /proc/meminfo, in MB; undefined where there is none. */
export function availableMb(meminfo = () => readFileSync('/proc/meminfo', 'utf8')): number | undefined {
  try {
    const kb = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo())?.[1];
    return kb === undefined ? undefined : Math.round(Number(kb) / 1024);
  } catch {
    return undefined;
  }
}

/** What the check needs to know of a thread's runner. */
export interface EvictCandidate {
  id: string;
  key: string;
  lastDelivery: number;
  status?: string;
  exiting?: boolean;
  switching?: boolean;
  /** A subagent running or a terminal open: the idle exit waits for these too. */
  inUse: boolean;
}

/** The least recently used thread runner the idle exit would stop, if any. */
export function pickIdle<R extends EvictCandidate>(runners: Iterable<R>, now: number, minIdleMs = EVICT_MIN_IDLE_MS): R | undefined {
  let lru: R | undefined;
  for (const r of runners) {
    if (!r.key || r.status !== 'idle' || r.exiting || r.switching || r.inUse || now - r.lastDelivery < minIdleMs) continue;
    if (!lru || r.lastDelivery < lru.lastDelivery) lru = r;
  }
  return lru;
}

export interface MemoryPressureDeps<R extends EvictCandidate> {
  thresholdMb: number;
  available(): number | undefined;
  /** The threads' runners, as candidates. */
  runners(): Iterable<R>;
  /** Stop this thread's runner (the idle exit). */
  stopThread(r: R): void;
  /** Drop one spare; its id, or undefined when there is none. */
  dropSpare(): string | undefined;
  log(line: string): void;
  now?: () => number;
  minIdleMs?: number;
}

export function memoryPressure<R extends EvictCandidate>(d: MemoryPressureDeps<R>) {
  const off = d.thresholdMb <= 0;
  const low = () => {
    if (off) return false;
    const mb = d.available();
    return mb !== undefined && mb < d.thresholdMb;
  };
  return {
    /** Whether available memory is below the threshold now: the pool is not refilled then. */
    low,
    /** One check: stop the LRU idle thread, else drop a spare. What it did, for tests. */
    check(): string | undefined {
      if (off) return;
      const mb = d.available();
      if (mb === undefined || mb >= d.thresholdMb) return;
      const why = `available ${mb} MB < threshold ${d.thresholdMb} MB`;
      const r = pickIdle(d.runners(), d.now?.() ?? Date.now(), d.minIdleMs);
      if (r) {
        const idleS = Math.round(((d.now?.() ?? Date.now()) - r.lastDelivery) / 1000);
        d.log(`memory pressure: stopping idle thread runner ${r.id} (${r.key}, LRU, idle ${idleS} s): ${why}`);
        d.stopThread(r);
        return `thread ${r.id}`;
      }
      const spare = d.dropSpare();
      if (spare) {
        d.log(`memory pressure: dropping spare ${spare}, no idle thread to stop: ${why}`);
        return `spare ${spare}`;
      }
    },
  };
}
