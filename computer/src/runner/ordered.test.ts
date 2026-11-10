import { describe, expect, it } from 'vitest';
import { Ordered } from './ordered.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Ordered', () => {
  it('runs jobs in the order queued, each after the one before', async () => {
    const o = new Ordered(1000);
    const seen: string[] = [];
    const a = o.run(async () => (await sleep(30), seen.push('a'), 'A'));
    const b = o.run(async () => (seen.push('b'), 'B'));
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    expect(seen).toEqual(['a', 'b']);
  });

  it('a failing job fails only its caller', async () => {
    const o = new Ordered(1000);
    const a = o.run(async () => {
      throw new Error('x');
    });
    const b = o.run(async () => 'B');
    await expect(a).rejects.toThrow('x');
    expect(await b).toBe('B');
  });

  it('a hung job holds the queue only until it is stuck', async () => {
    let stuck = 0;
    const o = new Ordered(50, () => stuck++);
    void o.run(() => new Promise(() => {}));
    const t0 = Date.now();
    expect(await o.run(async () => 'B')).toBe('B');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(stuck).toBe(1);
  });

  it('the stuck timer counts from a job start, not from when it was queued', async () => {
    let stuck = 0;
    const o = new Ordered(80, () => stuck++);
    void o.run(() => sleep(60));
    await o.run(() => sleep(60)); // queued at 0, starts at 60, ends at 120: never stuck
    expect(stuck).toBe(0);
  });
});
