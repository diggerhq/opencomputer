// The mirror's hop to the SessionLog DO, as events (work 084 instrumentation,
// catalog v2 "dumb dump", Q2/Q3): one `mirror.batch` per journal batch sent up,
// one `mirror.ack` per `journal-ack` that covers a sent batch. Every aggregate
// (p95 commit time, batches per turn) is a query.
//
// Invariants: nothing here does I/O or waits. The only state is the sent,
// unacked batches of each session (their last seq, send time and newest
// `createdAt`: what an ack needs to describe itself), at most MAX_BATCHES per
// session (the oldest forgotten), dropped on ack, relink and unfollow.

import type { JournalEvent } from '../protocol.js';

const MAX_BATCHES = 256;

export interface MirrorBatch {
  sessionId: string;
  turnId: string | undefined;
  surface: 'slack' | 'api' | 'cli' | undefined;
  events: number;
  firstSeq: number;
  lastSeq: number;
  oldestAgeMs: number | undefined;
  newestAgeMs: number | undefined;
  resent: boolean;
  urgent: boolean;
  /** How long flushes waited for the gateway socket to drain before this batch went (api-bridge.ts); absent: they did not. */
  heldMs: number | undefined;
}

export interface MirrorAck {
  sessionId: string;
  seq: number;
  batches: number;
  events: number;
  commitMs: number;
  ageMs: number | undefined;
}

interface Sent {
  lastSeq: number;
  events: number;
  at: number;
  newestMs: number;
}

export const surfaceOfVia = (via: string | undefined): MirrorBatch['surface'] =>
  via === undefined ? undefined : via === 'slack' ? 'slack' : via === 'opc' ? 'cli' : 'api';

const createdMs = (e: JournalEvent) => Date.parse(e.createdAt);
const age = (now: number, ms: number) => (Number.isFinite(ms) ? Math.max(0, now - ms) : undefined);

export class MirrorMeter {
  private sent = new Map<string, Sent[]>();
  /** Per session: the highest seq ever sent; a send at or below it after a relink is a resend. */
  private highest = new Map<string, number>();

  constructor(
    private emitBatch: (b: MirrorBatch) => void,
    private emitAck: (a: MirrorAck) => void,
    private now: () => number = Date.now,
  ) {}

  /** A batch went up on the gateway socket. */
  batch(sessionId: string, events: JournalEvent[], urgent: boolean, heldMs?: number) {
    if (!events.length) return;
    const now = this.now();
    const first = events[0];
    const last = events[events.length - 1];
    const newestMs = createdMs(last);
    const top = this.highest.get(sessionId) ?? 0;
    const resent = first.seq <= top;
    if (last.seq > top) this.highest.set(sessionId, last.seq);
    let list = this.sent.get(sessionId);
    if (!list) this.sent.set(sessionId, (list = []));
    if (list.length >= MAX_BATCHES) list.shift();
    list.push({ lastSeq: last.seq, events: events.length, at: now, newestMs });
    this.emitBatch({
      sessionId,
      turnId: last.turnId ?? undefined,
      surface: surfaceOfVia(events.find((e) => e.actor)?.actor?.via),
      events: events.length,
      firstSeq: first.seq,
      lastSeq: last.seq,
      oldestAgeMs: age(now, createdMs(first)),
      newestAgeMs: age(now, newestMs),
      resent,
      urgent,
      heldMs,
    });
  }

  /** The DO acknowledged up to `seq`. */
  acked(sessionId: string, seq: number) {
    const list = this.sent.get(sessionId);
    if (!list?.length || list[0].lastSeq > seq) return;
    let n = 0;
    while (n < list.length && list[n].lastSeq <= seq) n++;
    const covered = list.splice(0, n);
    const now = this.now();
    this.emitAck({
      sessionId,
      seq,
      batches: covered.length,
      events: covered.reduce((s, b) => s + b.events, 0),
      commitMs: Math.max(0, now - covered[0].at),
      ageMs: age(now, covered[covered.length - 1].newestMs),
    });
  }

  /** A new gateway socket: what was in flight is sent again (`resent`), its old send times are moot. */
  relinked() {
    this.sent.clear();
  }

  forget(sessionId: string) {
    this.sent.delete(sessionId);
    this.highest.delete(sessionId);
  }

  /** The largest number of sent, unacked batches of any session now (a gauge for `api.sample`). */
  unackedMax(): number {
    let max = 0;
    for (const l of this.sent.values()) max = Math.max(max, l.length);
    return max;
  }
}
