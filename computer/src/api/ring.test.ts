import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../protocol.js';
import { Ring } from './ring.js';

const ev = (seq: number): JournalEvent => ({ id: `ev_${seq}`, seq, createdAt: '', sessionId: 'cs_x', turnId: null, type: 't', actor: null, data: {} });

describe('Ring', () => {
  it('answers a covered cursor, not an older one', () => {
    const r = new Ring(1000);
    for (let s = 1; s <= 5; s++) r.push(ev(s), 10);
    expect(r.since(0)?.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.since(3, 1)?.map((e) => e.seq)).toEqual([4]);
    expect(r.since(5)).toEqual([]);
    expect(r.since(6)).toBeUndefined();
  });

  it('drops from the front by bytes, keeping the newest event', () => {
    const r = new Ring(30);
    for (let s = 1; s <= 5; s++) r.push(ev(s), 10);
    expect([r.first, r.last, r.bytes]).toEqual([3, 5, 30]);
    expect(r.since(1)).toBeUndefined();
    expect(r.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
    r.push(ev(6), 100);
    expect([r.first, r.last, r.count]).toEqual([6, 6, 1]);
  });

  it('clears on a gap', () => {
    const r = new Ring();
    r.push(ev(1), 1);
    r.push(ev(5), 1);
    expect([r.first, r.last]).toEqual([5, 5]);
  });

  it('bytesAfter is exact inside the ring and what it holds past it', () => {
    const r = new Ring(30);
    for (let s = 1; s <= 5; s++) r.push(ev(s), s);
    // holds 1..5 (15 bytes)
    expect(r.bytesAfter(2)).toBe(3 + 4 + 5);
    expect(r.bytesAfter(5)).toBe(0);
    for (let s = 6; s <= 9; s++) r.push(ev(s), 10);
    // holds 7..9 (30 bytes)
    expect(r.first).toBe(7);
    expect(r.bytesAfter(1)).toBe(30);
    expect(r.bytesAfter(7)).toBe(20);
  });

  it('compacts its arrays over many pushes', () => {
    const r = new Ring(100);
    for (let s = 1; s <= 50_000; s++) r.push(ev(s), 10);
    expect(r.count).toBe(10);
    expect(r.since(49_995)?.map((e) => e.seq)).toEqual([49_996, 49_997, 49_998, 49_999, 50_000]);
    expect(r.bytesAfter(49_995)).toBe(50);
  });
});
