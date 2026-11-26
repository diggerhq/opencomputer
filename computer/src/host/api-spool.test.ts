import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../protocol.js';
import { Spool } from './api-spool.js';

const ev = (seq: number, pad = ''): JournalEvent => ({
  id: `ev_${String(seq).padStart(16, '0')}`, seq, createdAt: '2026-10-26T00:00:00.000Z', sessionId: 'cs_0000000000000000',
  turnId: null, type: 'message.completed', actor: null, data: { text: pad },
});
const S = 'cs_0000000000000000';
const seqs = (b: { events: JournalEvent[] }) => b.events.map((e) => e.seq);

/** A journal on "disk": every event pushed, as the writer appended it. */
function disk() {
  const all: JournalEvent[] = [];
  const reads: number[] = [];
  return {
    all,
    reads,
    read: (_: string, after: number, limit: number) => {
      reads.push(after);
      return all.filter((e) => e.seq > after).slice(0, limit);
    },
  };
}

describe('Spool', () => {
  it('sends in seq order once per connection, and again from the ack after a reconnect', () => {
    const d = disk();
    const sp = new Spool(d.read);
    sp.open(S, 1, 0);
    for (let i = 1; i <= 5; i++) sp.push(S, ev(i));
    expect(seqs(sp.take(S))).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(sp.take(S))).toEqual([]);
    sp.ack(S, 1, 3);
    sp.rewind();
    expect(seqs(sp.take(S))).toEqual([4, 5]);
    expect(d.reads).toEqual([]);
  });

  it('ignores repeats, and an ack of another epoch', () => {
    const sp = new Spool(disk().read);
    sp.open(S, 2, 10);
    sp.push(S, ev(11));
    expect(sp.push(S, ev(11))).toBe(false);
    expect(sp.push(S, ev(9))).toBe(false);
    sp.ack(S, 1, 11);
    sp.rewind();
    expect(seqs(sp.take(S))).toEqual([11]);
    sp.ack(S, 2, 11);
    expect(sp.bytes).toBe(0);
  });

  it('a higher epoch starts over at the DO lastSeq; a lower one is ignored', () => {
    const sp = new Spool(disk().read);
    sp.open(S, 1, 0);
    sp.push(S, ev(1));
    sp.push(S, ev(2));
    expect(sp.open(S, 2, 1)).toBe(true);
    expect(sp.get(S)).toMatchObject({ epoch: 2, acked: 1, received: 1, sent: 1 });
    expect(sp.bytes).toBe(0);
    expect(sp.open(S, 1, 0)).toBe(false);
    expect(sp.get(S)?.epoch).toBe(2);
  });

  it('beyond its budget re-reads from the journal on disk, and drops nothing', () => {
    const d = disk();
    const one = JSON.stringify(ev(1, 'x'.repeat(100))).length;
    const sp = new Spool(d.read, one * 3);
    sp.open(S, 1, 0);
    for (let i = 1; i <= 10; i++) {
      const e = ev(i, 'x'.repeat(100));
      d.all.push(e);
      sp.push(S, e);
    }
    expect(sp.bytes).toBeLessThanOrEqual(one * 3);
    const got: number[] = [];
    for (let b = sp.take(S, one * 2); b.events.length; b = sp.take(S, one * 2)) got.push(...seqs(b));
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d.reads.length).toBeGreaterThan(0);
    // A reconnect before any ack: everything again, from memory then disk.
    sp.rewind();
    const again: number[] = [];
    for (let b = sp.take(S); b.events.length; b = sp.take(S)) again.push(...seqs(b));
    expect(again).toEqual(got);
    // Acked past memory: memory is empty, and new live events are held again once the disk part is acked.
    sp.ack(S, 1, 10);
    expect(sp.bytes).toBe(0);
    sp.push(S, ev(11));
    expect(sp.bytes).toBeGreaterThan(0);
  });

  it('a gap in what the writer showed is filled from disk', () => {
    const d = disk();
    const sp = new Spool(d.read);
    sp.open(S, 1, 0);
    for (let i = 1; i <= 4; i++) d.all.push(ev(i));
    sp.push(S, ev(1));
    sp.push(S, ev(4)); // 2 and 3 missed by the subscription
    const got: number[] = [];
    for (let b = sp.take(S); b.events.length; b = sp.take(S)) got.push(...seqs(b));
    expect(got).toEqual([1, 2, 3, 4]);
  });

  it('an ack past what the writer showed skips those events when they arrive', () => {
    const sp = new Spool(disk().read);
    sp.open(S, 1, 0);
    sp.push(S, ev(1));
    sp.ack(S, 1, 3);
    expect(sp.push(S, ev(2))).toBe(false);
    expect(sp.push(S, ev(4))).toBe(true);
    expect(seqs(sp.take(S))).toEqual([4]);
  });
});
