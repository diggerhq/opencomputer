// The warm pool (work 069): spare runners a host keeps started, each with a
// Claude Code parked before any session is known, so a new session's first
// message skips the runner's launch and Claude Code's start. A delivery for a
// new session takes a spare (host/main.ts) instead of launching a runner.
//
// A Codex session takes one too (work 082): its runner drops the parked Claude
// Code and starts Codex, which saves the runner's launch.
//
// Invariants: at most `size` spares, counting those still launching; size 0
// is off. A spare is taken only when it is parked (`ready`), from this host's
// release, and, for Claude, started with the Claude credential the delivery
// carries (its fingerprint): Claude Code copied the environment when it
// started. Codex holds no credential (the proxy does), so any will do. One taken
// is the caller's, never offered again. A spare that dies before it was ever
// ready, or within `minLifeMs` of parking, backs the pool off (doubling, up to
// `maxBackoffMs`), so a Claude Code that cannot start or stay up is not
// restarted in a loop.

import type { SpareReport } from '../protocol.js';

export interface SpareRunner {
  /** Its latest `spare` message; absent until the first. */
  spare?: SpareReport;
}

export type EvictReason = 'version' | 'surplus';
export type MissReason = 'none' | 'credential';

export interface PoolOptions<R> {
  size: number;
  version: string;
  /** Start one spare; resolves once it is connected (and `add`ed), rejects if it never came up. */
  launch: () => Promise<void>;
  /** Tell a spare to exit. */
  evict: (r: R, reason: EvictReason) => void;
  /** A spare went away without ever being ready, or soon after. */
  failed?: () => void;
  now?: () => number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** How long a spare must have been ready for its death to count as its own, not a start that fails late. */
  minLifeMs?: number;
}

export class Pool<R extends SpareRunner> {
  readonly spares = new Set<R>();
  private launching = 0;
  private failures = 0;
  private retryAt = 0;
  private readyAt = new WeakMap<R, number>();

  constructor(private o: PoolOptions<R>) {}

  get enabled() {
    return this.o.size > 0;
  }

  /** A spare connected (launched, or found after a host restart). */
  add(r: R) {
    this.spares.add(r);
  }

  /** A spare's state changed: an older release goes, a ready one ends the back-off. */
  changed(r: R) {
    if (!this.spares.has(r) || !r.spare) return;
    if (r.spare.version !== this.o.version) return this.evict(r, 'version');
    if (r.spare.ready) {
      if (!this.readyAt.has(r)) this.readyAt.set(r, this.now());
      this.failures = 0;
    }
  }

  /** Its connection closed: a failure unless it had been ready for a while. */
  gone(r: R) {
    if (!this.spares.delete(r)) return;
    const readyAt = this.readyAt.get(r);
    if (readyAt !== undefined && this.now() - readyAt >= (this.o.minLifeMs ?? 60_000)) return;
    this.o.failed?.();
    this.backOff();
  }

  /** Start spares up to `size`; `canStart` is false while there is no Claude credential to start them with. */
  fill(canStart: boolean) {
    const surplus = [...this.spares].slice(this.o.size);
    for (const r of surplus) this.evict(r, 'surplus');
    if (!canStart || this.now() < this.retryAt) return;
    for (let n = this.spares.size + this.launching; n < this.o.size; n++) {
      this.launching++;
      this.o.launch().then(
        () => this.launching--,
        () => {
          this.launching--;
          this.backOff();
        },
      );
    }
  }

  /** A parked spare started with `credential` (a fingerprint; `any` for Codex), now the caller's; else why there is none. */
  take(credential: string | undefined, any = false): R | MissReason {
    const ready = [...this.spares].filter((r) => r.spare?.ready && r.spare.version === this.o.version);
    const r = any ? ready[0] : credential ? ready.find((s) => s.spare!.credential === credential) : undefined;
    if (!r) return ready.length ? 'credential' : 'none';
    this.spares.delete(r);
    return r;
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  private backOff() {
    this.failures++;
    this.retryAt = this.now() + Math.min(this.o.maxBackoffMs ?? 300_000, (this.o.backoffMs ?? 5000) * 2 ** (this.failures - 1));
  }

  private evict(r: R, reason: EvictReason) {
    this.spares.delete(r);
    this.o.evict(r, reason);
  }
}
