import { describe, expect, it } from 'vitest';
import { Freshness, keyedQueue, limit } from './fetch-schedule.js';

describe('Freshness', () => {
  it('is fresh only within the window after a successful fetch', () => {
    let now = 1000;
    const f = new Freshness(() => now);
    expect(f.fresh('a', 60_000)).toBe(false);
    f.fetchedFrom('a', 1000);
    now = 30_000;
    expect(f.fresh('a', 60_000)).toBe(true);
    expect(f.fresh('b', 60_000)).toBe(false);
    now = 61_000;
    expect(f.fresh('a', 60_000)).toBe(false);
    expect(f.fresh('a', 0)).toBe(false);
  });

  it('a push notification makes it stale until a fetch that started after it', () => {
    let now = 1000;
    const f = new Freshness(() => now);
    f.fetchedFrom('a', 1000);
    now = 2000;
    f.pushedNow('a');
    expect(f.fresh('a', 60_000)).toBe(false);
    // A fetch that started before the push and ended after it does not count.
    f.fetchedFrom('a', 1500);
    expect(f.fresh('a', 60_000)).toBe(false);
    // Same millisecond as the push: not provably after it.
    f.fetchedFrom('a', 2000);
    expect(f.fresh('a', 60_000)).toBe(false);
    now = 2500;
    f.fetchedFrom('a', 2001);
    expect(f.fresh('a', 60_000)).toBe(true);
  });

  it('an older fetch finishing late does not move freshness back', () => {
    let now = 5000;
    const f = new Freshness(() => now);
    f.fetchedFrom('a', 5000);
    f.fetchedFrom('a', 100);
    now = 64_000;
    expect(f.fresh('a', 60_000)).toBe(true);
  });
});

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('keyedQueue', () => {
  it('runs one function per key at a time, other keys in parallel', async () => {
    const q = keyedQueue();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a1 = q('a', async () => (log.push('a1 start'), await gate, log.push('a1 end')));
    const a2 = q('a', async () => log.push('a2'));
    const b = q('b', async () => log.push('b'));
    await b;
    expect(log).toEqual(['a1 start', 'b']);
    release();
    await Promise.all([a1, a2]);
    expect(log).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
  });

  it('a failure does not block the queue', async () => {
    const q = keyedQueue();
    await expect(q('a', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await q('a', async () => 2)).toBe(2);
  });
});

describe('limit', () => {
  it('runs at most n at once and starts the rest as slots free up', async () => {
    const run = limit(2);
    let active = 0;
    let peak = 0;
    const job = (ms: number) =>
      run(async () => {
        peak = Math.max(peak, ++active);
        for (let i = 0; i < ms; i++) await tick();
        active--;
        return ms;
      });
    const out = await Promise.all([job(3), job(1), job(2), job(1), job(1)]);
    expect(out).toEqual([3, 1, 2, 1, 1]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('starts urgent waiters before the others, each group in order', async () => {
    const run = limit(1);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = run(() => gate);
    const jobs = [
      run(async () => void order.push('p1')),
      run(async () => void order.push('p2')),
      run(async () => void order.push('u1'), true),
      run(async () => void order.push('u2'), true),
    ];
    release();
    await Promise.all([first, ...jobs]);
    expect(order).toEqual(['u1', 'u2', 'p1', 'p2']);
  });

  it('frees the slot when a function throws', async () => {
    const run = limit(1);
    await expect(run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await run(async () => 1)).toBe(1);
  });
});
