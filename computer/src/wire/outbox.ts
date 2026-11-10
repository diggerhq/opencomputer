// One connection's outbound queues (opc docs websocket/flow-control.mdx): what
// goes out next, in what order, and when a reader is too slow.
//
//   1. responses and terminal bytes: one FIFO, always first
//   2. recorded events, 3. deltas: one queue per attached session, taken in turn
//      (an event-headed queue before a delta-headed one), so a busy session does
//      not hold up the others
//
// Invariants:
// - At most `socketHighWater` bytes are handed to the socket and unacknowledged
//   by its send callback; the rest waits here, where it can still be merged.
// - A session's queue is in order; deltas waiting for the same block are
//   merged in place (text appended, up to `mergedDeltaBytes`), and a block's
//   completed event removes its waiting deltas, so no delta follows its block's
//   completed event.
// - A held session (a write or attach in flight) sends nothing until released
//   (or `holdMs` passes): a response always precedes the events it caused.
// - A session queue over `sessionQueuePauseBytes` pauses that session's writer
//   (`onPause`), resumed below half of it: replay is paced by the reader.
// - More than `maxUnsentBytes` waiting → `onOverflow` (the caller closes 4008).
// - Telemetry (`meter`, `sink.handed`) is told as entries move: a clock read
//   per queued entry, never a frame of its own.

import type { JournalDelta } from '../protocol.js';
import { LIMITS } from './limits.js';
import { encodeRaw } from './rpc.js';

type Entry =
  | { kind: 'event'; text: string; bytes: number; seq: number; completes?: string; at: number; createdMs?: number }
  | { kind: 'delta'; key: string; delta: JournalDelta; bytes: number; dead?: boolean; at: number };

/** What the outbox tells telemetry (the connection's write batch, wire/telemetry.ts). */
export interface OutboxMeter {
  /** Waiting deltas merged into one, or dropped because their block completed. */
  merge(): void;
  /** A session queue went over the pause threshold. */
  pause(): void;
}

const COMPLETES: Record<string, (d: Record<string, unknown>) => string | undefined> = {
  'message.completed': (d) => key('m', d.blockId),
  'reasoning.completed': (d) => key('r', d.blockId),
  'tool.completed': (d) => key('t', d.callId),
  'tool.failed': (d) => key('t', d.callId),
};
const DELTA_KEY: Record<string, (d: Record<string, unknown>) => string | undefined> = {
  'message.delta': (d) => key('m', d.blockId),
  'reasoning.delta': (d) => key('r', d.blockId),
  'tool.delta': (d) => key('t', d.callId),
};
function key(p: string, id: unknown) {
  return typeof id === 'string' ? `${p}:${id}` : undefined;
}

/** The block a recorded event completes, if any (computed once by whoever parses the event). */
export function completesKey(type: string, data: unknown): string | undefined {
  return data && typeof data === 'object' ? COMPLETES[type]?.(data as Record<string, unknown>) : undefined;
}

class SessionQueue {
  items: Entry[] = [];
  head = 0;
  bytes = 0;
  /** Event entries waiting (kept on push/shift, so `backlog` is O(1)). */
  events = 0;
  /** Waiting deltas by block, for merging. */
  open = new Map<string, Extract<Entry, { kind: 'delta' }>>();
  held = 0;
  holdTimer: NodeJS.Timeout | undefined;
  paused = false;

  peek(): Entry | undefined {
    while (this.head < this.items.length) {
      const e = this.items[this.head];
      if (e.kind === 'delta' && e.dead) {
        this.head++;
        continue;
      }
      return e;
    }
    return undefined;
  }
  shift(): Entry | undefined {
    const e = this.peek();
    if (!e) return undefined;
    this.head++;
    this.bytes -= e.bytes;
    if (e.kind === 'delta') this.open.delete(e.key);
    else this.events--;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return e;
  }
}

export interface OutboxSink {
  /** Hand a frame to the socket; `done` when it is flushed (ws's send callback). */
  send(data: string | Buffer, done: () => void): void;
  onPause(sessionId: string): void;
  onResume(sessionId: string): void;
  onOverflow(): void;
  /** A session entry was handed to the socket after waiting `waitedMs` here; `createdMs` as the event was queued with. */
  handed?(sessionId: string, waitedMs: number, createdMs: number | undefined, delta: boolean): void;
}

export interface OutboxOptions {
  highWater?: number;
  pauseBytes?: number;
  maxUnsent?: number;
  holdMs?: number;
  meter?: OutboxMeter;
}

export class Outbox {
  private high: Array<string | Buffer> = [];
  private highHead = 0;
  private highBytes = 0;
  private queues = new Map<string, SessionQueue>();
  private order: string[] = [];
  private turn = 0;
  private inflight = 0;
  private closed = false;
  private drainWaiters: Array<() => void> = [];
  private readonly highWater: number;
  private readonly pauseBytes: number;
  private readonly maxUnsent: number;
  private readonly holdMs: number;
  private readonly meter: OutboxMeter | undefined;

  constructor(
    private sink: OutboxSink,
    o: OutboxOptions = {},
  ) {
    this.highWater = o.highWater ?? LIMITS.socketHighWater;
    this.pauseBytes = o.pauseBytes ?? LIMITS.sessionQueuePauseBytes;
    this.maxUnsent = o.maxUnsent ?? LIMITS.maxUnsentBytes;
    this.holdMs = o.holdMs ?? LIMITS.holdWriteMs;
    this.meter = o.meter;
  }

  /** Bytes waiting here or in the socket. */
  get unsent() {
    let n = this.highBytes + this.inflight;
    for (const q of this.queues.values()) n += q.bytes;
    return n;
  }

  /** Whether a byte producer (a terminal) should stop until `whenDrained`. */
  get congested() {
    return this.highBytes + this.inflight > this.pauseBytes;
  }

  whenDrained(fn: () => void) {
    if (!this.congested) return fn();
    this.drainWaiters.push(fn);
  }

  /** A response, a notification other than event/delta, or a terminal frame. */
  urgent(data: string | Buffer) {
    if (this.closed) return;
    this.high.push(data);
    this.highBytes += data.length;
    this.pump();
  }

  /** A recorded event, already serialized; `completes` from `completesKey`. */
  /** `createdMs`: the event's `createdAt` (epoch ms) when it is live, for telemetry. */
  event(sessionId: string, seq: number, json: string, completes?: string, createdMs?: number) {
    const q = this.queue(sessionId);
    if (!q) return;
    if (completes) {
      const d = q.open.get(completes);
      if (d) {
        d.dead = true;
        q.bytes -= d.bytes;
        q.open.delete(completes);
        this.meter?.merge();
      }
    }
    const text = encodeRaw('event', json);
    q.items.push({ kind: 'event', text, bytes: text.length, seq, completes, at: performance.now(), createdMs });
    q.bytes += text.length;
    q.events++;
    this.after(sessionId, q);
  }

  delta(sessionId: string, delta: JournalDelta) {
    const q = this.queue(sessionId);
    if (!q) return;
    const data = delta.data as Record<string, unknown> | null;
    const k = data && typeof data === 'object' ? DELTA_KEY[delta.type]?.(data) : undefined;
    const text = typeof data?.text === 'string' ? data.text : undefined;
    const prev = k ? q.open.get(k) : undefined;
    if (prev && text !== undefined && prev.bytes + text.length <= LIMITS.mergedDeltaBytes) {
      const pd = prev.delta.data as Record<string, unknown>;
      pd.text = `${pd.text as string}${text}`;
      prev.bytes += text.length;
      q.bytes += text.length;
      this.meter?.merge();
    } else {
      const copy: JournalDelta = { ...delta, data: data && typeof data === 'object' ? { ...data } : data };
      const bytes = JSON.stringify(copy).length + 40;
      const e = { kind: 'delta' as const, key: k ?? '', delta: copy, bytes, at: performance.now() };
      q.items.push(e);
      q.bytes += bytes;
      if (k) q.open.set(k, e);
    }
    this.after(sessionId, q);
  }

  /** Hold a session's events until `release` (a write or attach in flight); `holdMs` at most. */
  hold(sessionId: string) {
    const q = this.queue(sessionId, true);
    if (!q) return;
    q.held++;
    clearTimeout(q.holdTimer);
    q.holdTimer = setTimeout(() => {
      q.held = 0;
      this.pump();
    }, this.holdMs);
    q.holdTimer.unref?.();
  }

  release(sessionId: string) {
    const q = this.queues.get(sessionId);
    if (!q || q.held === 0) return;
    if (--q.held === 0) clearTimeout(q.holdTimer);
    this.pump();
  }

  /** Detach: drop what waits for the session. */
  drop(sessionId: string) {
    const q = this.queues.get(sessionId);
    if (!q) return;
    clearTimeout(q.holdTimer);
    this.queues.delete(sessionId);
    this.order = this.order.filter((s) => s !== sessionId);
    if (q.paused) this.sink.onResume(sessionId);
  }

  /** Bytes and events waiting for one session (for `too_far_behind`). */
  backlog(sessionId: string) {
    const q = this.queues.get(sessionId);
    return q ? { bytes: q.bytes, events: q.events } : { bytes: 0, events: 0 };
  }

  close() {
    this.closed = true;
    for (const q of this.queues.values()) clearTimeout(q.holdTimer);
    this.queues.clear();
    this.order = [];
    this.high = [];
    this.drainWaiters = [];
  }

  private queue(sessionId: string, create = true) {
    if (this.closed) return undefined;
    let q = this.queues.get(sessionId);
    if (!q && create) {
      q = new SessionQueue();
      this.queues.set(sessionId, q);
      this.order.push(sessionId);
    }
    return q;
  }

  private after(sessionId: string, q: SessionQueue) {
    if (!q.paused && q.bytes > this.pauseBytes) {
      q.paused = true;
      this.meter?.pause();
      this.sink.onPause(sessionId);
    }
    this.pump();
  }

  private next(): string | Buffer | undefined {
    if (this.highHead < this.high.length) {
      const d = this.high[this.highHead];
      this.high[this.highHead++] = '';
      this.highBytes -= d.length;
      if (this.highHead === this.high.length) {
        this.high = [];
        this.highHead = 0;
      }
      return d;
    }
    // Events before deltas: first pass takes only event-headed queues.
    const n = this.order.length;
    for (const wantEvent of [true, false]) {
      for (let i = 0; i < n; i++) {
        const sid = this.order[(this.turn + i) % n];
        const q = this.queues.get(sid);
        if (!q || q.held) continue;
        const head = q.peek();
        if (!head || (wantEvent && head.kind !== 'event')) continue;
        this.turn = (this.turn + i + 1) % n;
        q.shift();
        if (q.paused && q.bytes < this.pauseBytes / 2) {
          q.paused = false;
          this.sink.onResume(sid);
        }
        this.sink.handed?.(sid, performance.now() - head.at, head.kind === 'event' ? head.createdMs : undefined, head.kind === 'delta');
        return head.kind === 'event' ? head.text : encodeRaw('delta', JSON.stringify(head.delta));
      }
    }
    return undefined;
  }

  private pump() {
    if (this.closed) return;
    while (this.inflight < this.highWater) {
      const d = this.next();
      if (d === undefined) break;
      const n = d.length;
      this.inflight += n;
      this.sink.send(d, () => {
        this.inflight -= n;
        this.pump();
      });
      if (this.closed) return;
    }
    if (this.unsent > this.maxUnsent) {
      this.closed = true;
      return this.sink.onOverflow();
    }
    if (!this.congested && this.drainWaiters.length) {
      const w = this.drainWaiters;
      this.drainWaiters = [];
      for (const f of w) f();
    }
  }
}
