// The mirror's spool (work 084, "The mirror"): per session, the journal events
// the host has seen from the session's writer but the SessionLog DO has not
// acked, and which of them went up the gateway socket since it last opened.
//
// Invariants:
// - Never drops an event. Memory holds a contiguous run of each session's
//   unacked events (`acked + 1 … memEnd`), all sessions together within
//   `budget` bytes (64 MiB); everything past `memEnd` up to `received` is read
//   back from the session's journal on disk when it is sent.
// - `sent` only moves forward on the current connection; `rewind` (after a
//   reconnect) moves it back to `acked`, so everything unacked goes again:
//   at least once, in seq order. The DO upserts by (session, seq).
// - An ack under another epoch than the session's is ignored: events of an old
//   epoch are never acked into a new one. A higher epoch (`reset`) starts the
//   session over at the DO's `lastSeq`.

import type { JournalEvent } from '../protocol.js';

export const SPOOL_BYTES = 64 * 2 ** 20;
/** A journal batch stays well under the gateway's frame limit. */
export const BATCH_BYTES = 512 * 1024;
export const BATCH_EVENTS = 500;

/** Events of `sessionId` with seq > `after`, oldest first, at most `limit` of them (the journal on disk, read lock-free). */
export type DiskRead = (sessionId: string, after: number, limit: number) => JournalEvent[];

interface Held {
  e: JournalEvent;
  bytes: number;
}

interface Session {
  epoch: number;
  /** The DO stored everything up to here (its ack, or `lastSeq` from a frame). */
  acked: number;
  /** The highest seq seen from the writer. */
  received: number;
  /** Sent on the current connection up to here. */
  sent: number;
  /** In memory: seqs acked+1 … memEnd, contiguous. */
  mem: Held[];
  memEnd: number;
}

export class Spool {
  private readonly sessions = new Map<string, Session>();
  private used = 0;

  constructor(
    private readonly disk: DiskRead,
    private readonly budget = SPOOL_BYTES,
  ) {}

  /** Bytes held in memory. */
  get bytes() {
    return this.used;
  }

  has(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): Readonly<Omit<Session, 'mem'>> | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Start (or restart) a session at `epoch` with the DO holding everything up to `acked`. A higher epoch, or a session
   * not seen yet, starts over; the same epoch only raises `acked`; a lower one is ignored. Returns whether it started over.
   */
  open(sessionId: string, epoch: number, acked: number): boolean {
    const s = this.sessions.get(sessionId);
    if (s && epoch < s.epoch) return false;
    if (s && epoch === s.epoch) {
      this.ack(sessionId, epoch, acked);
      return false;
    }
    if (s) this.release(s, s.mem.length);
    this.sessions.set(sessionId, { epoch, acked, received: acked, sent: acked, mem: [], memEnd: acked });
    return true;
  }

  /** Forget a session (its writer is gone and every event is acked, or the host stops mirroring it). */
  drop(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.release(s, s.mem.length);
    this.sessions.delete(sessionId);
  }

  /** A live event from the session's writer. Repeats are ignored; after a gap the missing ones come from disk. */
  push(sessionId: string, e: JournalEvent): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || e.seq <= s.received) return false;
    if (e.seq === s.memEnd + 1 && s.memEnd === s.received) {
      const bytes = JSON.stringify(e).length;
      if (this.used + bytes <= this.budget) {
        s.mem.push({ e, bytes });
        s.memEnd = e.seq;
        this.used += bytes;
      }
    }
    s.received = e.seq;
    return true;
  }

  /** The journal on disk holds events up to `seq` this spool has not seen (the boot scan's): they are read from disk. */
  extend(sessionId: string, seq: number) {
    const s = this.sessions.get(sessionId);
    if (s && seq > s.received) s.received = seq;
  }

  /** The DO stored every event of `epoch` up to `seq`. */
  ack(sessionId: string, epoch: number, seq: number) {
    const s = this.sessions.get(sessionId);
    if (!s || epoch !== s.epoch || seq <= s.acked) return;
    // Past what the writer has shown us (its stream lags the DO's copy): those need not come again.
    s.acked = seq;
    if (s.received < seq) s.received = seq;
    let n = 0;
    while (n < s.mem.length && s.mem[n].e.seq <= s.acked) n++;
    this.release(s, n);
    if (s.mem.length === 0 && s.memEnd < s.acked) s.memEnd = s.acked;
    if (s.sent < s.acked) s.sent = s.acked;
  }

  /** The connection to the gateway is new: everything unacked goes again. */
  rewind() {
    for (const s of this.sessions.values()) s.sent = s.acked;
  }

  /** Sessions with events not yet sent on this connection. */
  unsent(): string[] {
    return [...this.sessions].filter(([, s]) => s.sent < s.received).map(([id]) => id);
  }

  /** Whether everything up to `seq` has been sent on this connection. */
  sentUpTo(sessionId: string, seq: number) {
    const s = this.sessions.get(sessionId);
    return !s || s.sent >= seq;
  }

  /** The next batch to send for the session (seq order, after `sent`), marked sent; empty when none. */
  take(sessionId: string, maxBytes = BATCH_BYTES, maxEvents = BATCH_EVENTS): { epoch: number; events: JournalEvent[] } {
    const s = this.sessions.get(sessionId);
    if (!s || s.sent >= s.received) return { epoch: s?.epoch ?? 0, events: [] };
    const out: JournalEvent[] = [];
    if (s.sent < s.memEnd) {
      let i = s.mem.length - (s.memEnd - s.sent);
      for (let bytes = 0; i < s.mem.length && out.length < maxEvents && (out.length === 0 || bytes + s.mem[i].bytes <= maxBytes); i++) {
        out.push(s.mem[i].e);
        bytes += s.mem[i].bytes;
      }
    } else {
      let bytes = 0;
      for (const e of this.disk(sessionId, s.sent, Math.min(maxEvents, s.received - s.sent))) {
        if (e.seq <= s.sent) continue;
        // In order and gapless only: a gap on disk stops the batch there, never skips past it.
        if (e.seq > s.received || e.seq !== (out.length ? out[out.length - 1].seq : s.sent) + 1 || out.length >= maxEvents) break;
        bytes += JSON.stringify(e).length;
        if (out.length && bytes > maxBytes) break;
        out.push(e);
      }
    }
    if (out.length) s.sent = out[out.length - 1].seq;
    return { epoch: s.epoch, events: out };
  }

  private release(s: Session, n: number) {
    for (let i = 0; i < n; i++) this.used -= s.mem[i].bytes;
    s.mem.splice(0, n);
  }
}
