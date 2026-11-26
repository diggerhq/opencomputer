// Subscribers of one session's log (work 084, "The frames", flow control):
// each gets every recorded event after its cursor exactly once and in seq
// order, then live ones, and the deltas of blocks still open.
//
// Invariants:
// - A subscriber's events are pulled, never bulk-queued: `pump` reads from the
//   ring (or the journal, for a cursor older than it) while the sink is
//   writable, so replay goes at the sink's pace and costs no memory.
// - Its *live* backlog (events appended since it subscribed that it has not
//   been sent, or not acked once it acks) is capped at 8 MiB / 10,000 events;
//   over either, it alone is detached with `too_far_behind`.
// - Deltas go only to a subscriber that is caught up (sent == lastSeq), so a
//   delta never overtakes a held event (its block's start included); while
//   the sink is full they merge in place per block; a block's completed event
//   removes its pending deltas, and a delta for a completed block is dropped,
//   so no delta ever follows its block's completed record.
// - Reaching live the first time, a subscriber with deltas gets one catch-up
//   delta per open text block (the text so far), per open tool call (the
//   last 4 KiB of its output) and per running subagent (its latest progress).
// - The host's mirror (`mirror`) is given subagent progress alone, the only
//   delta it forwards: text and tool output never cross its socket.

import type { ApiError, JournalDelta, JournalEvent } from '../protocol.js';
import type { Journal } from './journal.js';
import type { Ring } from './ring.js';
import { apiError, type DetachReason, type SubscribeOptions, type Subscription } from './writer.js';

export const LIMITS = { backlogBytes: 8 << 20, backlogEvents: 10_000, toolTailBytes: 4096, completedKept: 4096 } as const;
const BATCH = 64;

/** SubscribeOptions plus the sink's readiness: `writable` false holds events and deltas (a full socket); `holdEvents` true holds events only (a write call in flight), deltas still go while caught up. */
export interface Sink extends SubscribeOptions {
  writable?(): boolean;
  holdEvents?(): boolean;
}

export type HubSubscription = Subscription & {
  /** Send what is due now (the sink became writable again). */
  pump(): void;
};

interface OpenBlock {
  delta: JournalDelta;
}

type Keyed = { blockId?: string; callId?: string; subagentId?: string; subagent?: { id?: string } };

const blockKey = (type: string, data: Keyed): string | undefined => {
  if (type.startsWith('subagent.')) {
    const id = data.subagentId ?? data.subagent?.id;
    return id && `s:${id}`;
  }
  if (type.startsWith('message.')) return data.blockId && `m:${data.blockId}`;
  if (type.startsWith('reasoning.')) return data.blockId && `r:${data.blockId}`;
  if (type.startsWith('tool.')) return data.callId && `t:${data.callId}`;
  return undefined;
};
const COMPLETES = new Set(['message.completed', 'reasoning.completed', 'tool.completed', 'tool.failed', 'subagent.ended']);
const ENDS_TURN = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);

const tail = (s: string, n: number) => (Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(-n).toString('utf8').replace(/^�+/, ''));

/** Two deltas of one block as one: text appends (a tool's keeps its last 4 KiB); progress is its latest values. */
function merge(into: JournalDelta, d: JournalDelta): JournalDelta {
  if (d.type === 'subagent.progress') return d;
  const a = into.data as { text: string };
  const b = d.data as { text: string };
  const text = a.text + b.text;
  return { ...into, data: { ...a, text: d.type === 'tool.delta' ? tail(text, LIMITS.toolTailBytes) : text } };
}

class Sub {
  sent: number;
  acked = 0;
  usesAcks = false;
  caughtUp = false;
  closed = false;
  pending = new Map<string, JournalDelta>();
  private pumping = false;

  constructor(
    private hub: Hub,
    readonly o: Sink,
    after: number,
    readonly liveFrom: number,
  ) {
    this.sent = after;
  }

  /** The deltas of block `k` go to this subscriber. */
  private wants(k: string): boolean {
    return !this.o.mirror || k.startsWith('s:');
  }

  writable(): boolean {
    return !this.closed && (this.o.writable?.() ?? true);
  }

  private eventsGo(): boolean {
    return this.writable() && !this.o.holdEvents?.();
  }

  backlog(lastSeq: number): { events: number; bytes: number } {
    const base = Math.max(this.usesAcks ? this.acked : this.sent, this.liveFrom);
    return { events: lastSeq - base, bytes: this.hub.bytesAfter(base) };
  }

  pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.eventsGo() && this.sent < this.hub.lastSeq) {
        const batch = this.hub.since(this.sent, BATCH);
        if (!batch.length) {
          // Nothing on file up to lastSeq (the DO's, past a new epoch's local tail): nothing to wait for.
          this.sent = this.hub.lastSeq;
          break;
        }
        for (const e of batch) {
          // A seq the file never had (a new epoch past the local tail) is skipped, not waited for.
          if (e.seq <= this.sent) continue;
          this.sent = e.seq;
          this.o.onEvent(e);
          if (!this.eventsGo()) break;
        }
      }
      if (!this.o.deltas || this.closed || this.sent < this.hub.lastSeq) return;
      if (!this.caughtUp) {
        this.caughtUp = true;
        for (const [k, b] of this.hub.openBlocks()) if (this.wants(k)) this.pending.set(k, b.delta);
      }
      for (const [k, d] of this.pending) {
        if (!this.writable()) break;
        this.pending.delete(k);
        this.o.onDelta(d);
      }
    } finally {
      this.pumping = false;
    }
  }

  delta(key: string, d: JournalDelta): void {
    if (!this.o.deltas || !this.caughtUp || !this.wants(key)) return;
    const p = this.pending.get(key);
    this.pending.set(key, p ? merge(p, d) : d);
    if (this.sent === this.hub.lastSeq) this.pump();
  }
}

export class Hub {
  private subs = new Set<Sub>();
  private blocks = new Map<string, OpenBlock>();
  /** Keys of blocks already completed (bounded): their late deltas are dropped. */
  private completed = new Set<string>();

  constructor(
    private journal: Journal,
    private ring: Ring,
    private session: () => unknown,
  ) {}

  get lastSeq(): number {
    return this.journal.lastSeq;
  }

  get size(): number {
    return this.subs.size;
  }

  /** Subscribers other than the host's mirror: the API clients attached now. */
  get clients(): number {
    let n = 0;
    for (const s of this.subs) if (!s.o.mirror) n++;
    return n;
  }

  /** Events after `after`, from the ring if it covers them, else the journal. */
  since(after: number, limit: number): JournalEvent[] {
    return this.ring.since(after, limit) ?? this.journal.read(after, limit);
  }

  bytesAfter(after: number): number {
    // Past the ring: at least what the ring holds; the cap (8 MiB) is twice the ring (4 MB), so this errs late, not early.
    return this.ring.bytesAfter(after);
  }

  openBlocks(): IterableIterator<[string, OpenBlock]> {
    return this.blocks.entries();
  }

  subscribe(o: Sink): HubSubscription | { error: ApiError } {
    const last = this.lastSeq;
    const after = o.tailTurns ? this.journal.tailTurnsAfter(o.tailTurns) : (o.after ?? last);
    if (after > last) return { error: apiError('cursor_ahead', `after ${after} is past the log's last seq ${last}`, 409, { session: this.session() }) };
    // The docs: an `after` more than 10,000 events back reads over HTTP first (review r1 contract E4).
    if (!o.tailTurns && last - after > LIMITS.backlogEvents)
      return { error: apiError('too_far_behind', `after ${after} is ${last - after} events back; read them over HTTP first`, 409) };
    const sub = new Sub(this, o, after, last);
    this.subs.add(sub);
    // The caller sends its result (sessions.attached) first; events follow on the next microtask.
    queueMicrotask(() => sub.pump());
    return {
      attached: { session: this.session(), after, lastSeq: last, epoch: this.journal.epoch },
      ack: (seq) => {
        sub.usesAcks = true;
        sub.acked = Math.max(sub.acked, Math.min(seq, sub.sent));
      },
      close: () => {
        sub.closed = true;
        this.subs.delete(sub);
      },
      pump: () => sub.pump(),
    };
  }

  /** An event was appended (the journal and the ring have it). */
  published(e: JournalEvent): void {
    const data = (e.data ?? {}) as Keyed;
    if (COMPLETES.has(e.type)) {
      const k = blockKey(e.type, data);
      if (k) this.complete(k);
    } else if (ENDS_TURN.has(e.type) && e.turnId) {
      // Text blocks end with their turn. Tool calls end by their own events (a turn's ending settles its own calls with
      // tool.failed first), and a background subagent's calls and progress outlive the turn that launched it.
      for (const [k, b] of this.blocks) if (b.delta.turnId === e.turnId && (k.startsWith('m:') || k.startsWith('r:'))) this.complete(k);
    }
    for (const s of this.subs) {
      const b = s.backlog(e.seq);
      if (b.events > LIMITS.backlogEvents || b.bytes > LIMITS.backlogBytes) this.detach(s, 'too_far_behind');
      else s.pump();
    }
  }

  private complete(k: string) {
    this.blocks.delete(k);
    this.completed.add(k);
    if (this.completed.size > LIMITS.completedKept) this.completed.delete(this.completed.values().next().value!);
    for (const s of this.subs) s.pending.delete(k);
  }

  /** A transient delta: kept as catch-up for its open block, sent to caught-up subscribers. */
  delta(d: JournalDelta): void {
    const k = blockKey(d.type, d.data as Keyed);
    if (!k || this.completed.has(k)) return;
    const b = this.blocks.get(k);
    this.blocks.set(k, { delta: b ? merge(b.delta, d) : d });
    for (const s of this.subs) s.delta(k, d);
  }

  private detach(s: Sub, reason: DetachReason) {
    s.closed = true;
    this.subs.delete(s);
    s.o.onDetached(reason);
  }

  /** End every subscription (`moved`: the writer handed the journal on). */
  detachAll(reason: DetachReason): void {
    for (const s of [...this.subs]) this.detach(s, reason);
  }
}
