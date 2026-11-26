import { afterEach, describe, expect, it, vi } from 'vitest';
import { Attachment, type AttachDeps } from './attachment.js';

afterEach(() => vi.useRealTimers());

describe('Attachment rewire (084 perf fix 8)', () => {
  it('retries a writer it cannot reach after a random half to whole of its backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let wheres = 0;
    const host = { call: async () => (wheres++, { error: { code: 'unavailable', message: 'away' } }) } as unknown as AttachDeps['host'];
    const a = new Attachment('cs_1', { host, dial: (() => {}) as never, outbox: {} as never, detached: () => {} }, { deltas: false });
    void a.moved();
    await vi.advanceTimersByTimeAsync(0);
    expect(wheres).toBe(1);
    // Backoffs of 50, 100, 200 ms, waited as 25, 50, 100.
    await vi.advanceTimersByTimeAsync(25);
    expect(wheres).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(wheres).toBe(3);
    await vi.advanceTimersByTimeAsync(99);
    expect(wheres).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(wheres).toBe(4);
    a.close();
    vi.restoreAllMocks();
  });
});

describe('Attachment start', () => {
  it('waits for the writer of a session that was just created', async () => {
    vi.useFakeTimers();
    const host = { call: async () => ({ result: { epoch: 1, socket: '/s' } }) } as unknown as AttachDeps['host'];
    let dials = 0;
    const link = { closed: false, close: () => {}, subscribe: async () => ({ result: { lastSeq: 3, logEpoch: 1 } }) };
    const dial = (async () => {
      if (++dials < 3) throw new Error('ENOENT');
      return link;
    }) as unknown as AttachDeps['dial'];
    const a = new Attachment('cs_1', { host, dial, outbox: { hold: () => {} } as never, detached: () => {} }, { deltas: false });
    const out = a.start({ deltas: false }, {} as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await out).not.toHaveProperty('error');
    expect(dials).toBe(3);
    a.close();
  });
});
