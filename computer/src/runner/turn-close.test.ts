import { describe, expect, it } from 'vitest';
import type { Segment } from './segment.js';
import { TurnCloser } from './turn-close.js';

/** A Segment whose close waits until released, and says whether chat.stopStream carried a status. */
function slowSegment() {
  let release!: () => void;
  const landed = new Promise<void>((r) => (release = r));
  const seen: (string | undefined)[] = [];
  const seg = {
    empty: false,
    close: async (o: { sessionStatus?: () => string | undefined }) => {
      await landed;
      const s = o.sessionStatus?.();
      seen.push(s);
      return !!s;
    },
    discard: async () => void (await landed),
  } as unknown as Segment;
  return { seg, release, seen };
}

function closer() {
  const log: string[] = [];
  let busy = false;
  const c = new TurnCloser({
    busy: () => busy,
    setStatus: async (s) => void log.push(`status:${s}`),
    closed: () => void log.push('closed'),
    idle: () => void log.push('idle'),
  });
  return { c, log, setBusy: (b: boolean) => (busy = b) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('TurnCloser', () => {
  it('runs closes in turn order; idle only once every close landed', async () => {
    const { c, log } = closer();
    const a = slowSegment();
    const b = slowSegment();
    c.finish(a.seg, 'f1');
    c.discard(b.seg);
    b.release(); // the second can't overtake the first
    await tick();
    expect(log).toEqual([]);
    a.release();
    await c.settled;
    expect(log).toEqual(['closed', 'status:active', 'closed', 'idle']);
  });

  it('a close that lands while a turn runs puts its working status back, and fires no idle', async () => {
    const { c, log, setBusy } = closer();
    const a = slowSegment();
    c.finish(a.seg, 'f');
    setBusy(true);
    a.release();
    await c.settled;
    expect(a.seen).toEqual([undefined]); // chat.stopStream carried no status
    expect(log).toEqual(['status:processing', 'closed']);
  });

  it('a close that fails still counts as landed', async () => {
    const { c, log } = closer();
    c.finish({ close: async () => Promise.reject(new Error('boom')) } as unknown as Segment, 'f');
    await c.settled;
    expect(log).toEqual(['closed', 'idle']);
  });
});
