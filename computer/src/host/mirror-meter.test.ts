import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../protocol.js';
import { type MirrorAck, type MirrorBatch, MirrorMeter } from './mirror-meter.js';

const T0 = Date.UTC(2026, 9, 26);
const ev = (seq: number, agoMs: number, via?: string): JournalEvent =>
  ({ id: `ev_${seq}`, seq, createdAt: new Date(T0 - agoMs).toISOString(), sessionId: 'cs_a', turnId: 'tn_1', type: 'x', actor: via ? { via } : null, data: {} }) as never;

function setup() {
  let now = T0;
  const batches: MirrorBatch[] = [];
  const acks: MirrorAck[] = [];
  const m = new MirrorMeter((b) => batches.push(b), (a) => acks.push(a), () => now);
  return { m, batches, acks, tick: (ms: number) => (now += ms) };
}

describe('MirrorMeter', () => {
  it('emits one mirror.batch per batch sent and one mirror.ack per ack covering sent batches', () => {
    const { m, batches, acks, tick } = setup();
    m.batch('cs_a', [ev(1, 50, 'opc'), ev(2, 10)], true);
    tick(5);
    m.batch('cs_a', [ev(3, 0)], false);
    expect(batches).toEqual([
      { sessionId: 'cs_a', turnId: 'tn_1', surface: 'cli', events: 2, firstSeq: 1, lastSeq: 2, oldestAgeMs: 50, newestAgeMs: 10, resent: false, urgent: true },
      { sessionId: 'cs_a', turnId: 'tn_1', surface: undefined, events: 1, firstSeq: 3, lastSeq: 3, oldestAgeMs: 5, newestAgeMs: 5, resent: false, urgent: false },
    ]);
    tick(20);
    m.acked('cs_a', 2);
    expect(acks).toEqual([{ sessionId: 'cs_a', seq: 2, batches: 1, events: 2, commitMs: 25, ageMs: 35 }]);
    m.acked('cs_a', 2); // nothing new covered: no event
    m.acked('cs_a', 3);
    expect(acks).toHaveLength(2);
    expect(acks[1]).toMatchObject({ seq: 3, batches: 1, events: 1, commitMs: 20 });
    expect(m.unackedMax()).toBe(0);
  });

  it('marks a send after a relink at or below the highest seq as resent', () => {
    const { m, batches } = setup();
    m.batch('cs_a', [ev(1, 0), ev(2, 0)], false);
    m.relinked();
    expect(m.unackedMax()).toBe(0);
    m.batch('cs_a', [ev(2, 0), ev(3, 0)], false);
    expect(batches[1].resent).toBe(true);
    m.forget('cs_a');
    m.batch('cs_a', [ev(1, 0)], false);
    expect(batches[2].resent).toBe(false);
  });

  it('keeps no counters: nothing is emitted without a unit, an empty batch is not one', () => {
    const { m, batches, acks } = setup();
    m.batch('cs_a', [], true);
    m.acked('cs_b', 10);
    expect(batches).toEqual([]);
    expect(acks).toEqual([]);
  });
});
