import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Batch } from '../telemetry/emitter.js';
import { Spool, type SpoolOptions } from './telemetry-spool.js';

const event = (i: number) => ({ event_name: 'host.sample', event_id: `e${i}` }) as unknown as Batch['events'][number];
const batch = (from: number, n: number, turns = 0): Batch => ({
  events: Array.from({ length: n }, (_, i) => event(from + i)),
  turns: Array.from({ length: turns }, (_, i) => ({ turn_id: `t${from + i}` }) as unknown as Batch['turns'][number]),
});
function setup(over: Partial<SpoolOptions> = {}) {
  const dir = over.dir ?? mkdtempSync(path.join(tmpdir(), 'spool-'));
  const dropped: Record<string, number> = {};
  let full = 0;
  let clock = 1_791_840_000_000;
  const s = new Spool({
    dir,
    batchRecords: 5,
    onDrop: (r, n) => (dropped[r] = (dropped[r] ?? 0) + n),
    onFull: () => full++,
    now: () => clock++,
    ...over,
  });
  return { s, dir, dropped, full: () => full };
}
const ids = (s: Spool) => s.segments().flatMap((g) => s.load(g).events.map((e) => e.event_id));

describe('Spool', () => {
  it('round-trips events and turns through a sealed segment', () => {
    const { s } = setup();
    s.append(batch(0, 2, 1));
    expect(s.segments()).toHaveLength(0);
    s.seal();
    const [g] = s.segments();
    expect(g).toMatchObject({ bootId: s.bootId, seq: 1, records: 3 });
    expect(s.load(g)).toEqual(batch(0, 2, 1));
  });

  it('seals at batchRecords and numbers batches without gaps', () => {
    const { s, full } = setup();
    for (let i = 0; i < 5; i++) s.append(batch(i * 3, 3));
    s.seal();
    expect(s.segments().map((g) => g.seq)).toEqual([1, 2, 3]);
    expect(full()).toBe(2);
    expect(ids(s)).toEqual(Array.from({ length: 15 }, (_, i) => `e${i}`));
    s.seal(); // empty: no new number
    expect(s.segments()).toHaveLength(3);
  });

  it('survives a restart: sealed segments stay, the open one is sealed under the new boot', () => {
    const { s, dir } = setup();
    s.append(batch(0, 5));
    s.append(batch(5, 2));
    const before = s.spooledBytes;
    const next = setup({ dir }).s;
    expect(next.bootId).not.toBe(s.bootId);
    expect(next.spooledBytes).toBe(before);
    expect(next.segments().map((g) => [g.bootId, g.seq, g.records])).toEqual([
      [s.bootId, 1, 5],
      [next.bootId, 1, 2],
    ]);
    expect(ids(next)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
  });

  it('deletes only what it is told to, counting dropped records by reason', () => {
    const { s, dropped } = setup();
    s.append(batch(0, 5));
    s.append(batch(5, 5));
    const [a, b] = s.segments();
    s.remove(a);
    s.remove(b, 'rejected');
    expect(s.segments()).toHaveLength(0);
    expect(dropped).toEqual({ rejected: 5 });
    expect(s.spooledBytes).toBe(0);
  });

  it('caps disk use by dropping the oldest segment as buffer_full', () => {
    const { s, dropped } = setup({ maxBytes: 600 });
    for (let i = 0; i < 6; i++) s.append(batch(i * 5, 5));
    expect(s.spooledBytes).toBeLessThanOrEqual(600);
    expect(dropped.buffer_full).toBeGreaterThan(0);
    const kept = ids(s);
    expect(kept.at(-1)).toBe('e29');
    expect(kept.length + dropped.buffer_full).toBe(30);
  });

  it('counts unreadable lines as invalid', () => {
    const { s, dir, dropped } = setup();
    s.append(batch(0, 2));
    s.seal();
    const [g] = s.segments();
    writeFileSync(path.join(dir, g.file), '{"e":{"event_id":"ok"}}\nnot json\n{"x":1}\n');
    expect(s.load(g).events).toHaveLength(1);
    expect(dropped.invalid).toBe(2);
  });

  it('never throws on an unwritable directory; the records are counted', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spool-ro-'));
    chmodSync(dir, 0o500);
    const { s, dropped } = setup({ dir });
    expect(() => s.append(batch(0, 3))).not.toThrow();
    expect(() => s.seal()).not.toThrow();
    chmodSync(dir, 0o700);
    if (process.getuid?.() !== 0) expect(dropped.send_failed).toBe(3);
    expect(readdirSync(dir).length).toBeGreaterThanOrEqual(0);
  });
});
