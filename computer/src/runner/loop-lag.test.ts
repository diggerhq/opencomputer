import { describe, expect, it } from 'vitest';
import { reading, sampleLoopLag } from './loop-lag.js';

describe('loop lag', () => {
  it('reports the delay beyond the sampling interval', () => {
    expect(reading({ max: 125.7e6, mean: 12.09e6, count: 57 }, 5000.4)).toEqual({ maxMs: 116, meanMs: 2.1, windowMs: 5000 });
  });

  it('never reports a negative delay', () => {
    expect(reading({ max: 9.9e6, mean: 9.8e6, count: 3 }, 5000)).toEqual({ maxMs: 0, meanMs: 0, windowMs: 5000 });
  });

  it('reports nothing for a window without samples', () => {
    expect(reading({ max: 0, mean: Number.NaN, count: 0 }, 5000)).toBeUndefined();
  });

  it('sees a blocked loop', async () => {
    const seen: number[] = [];
    const stop = sampleLoopLag((l) => seen.push(l.maxMs), 200);
    await new Promise((r) => setTimeout(r, 50));
    const t = Date.now();
    while (Date.now() - t < 80);
    await new Promise((r) => setTimeout(r, 250));
    stop();
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(50);
  });
});
