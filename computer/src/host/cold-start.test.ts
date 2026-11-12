import { describe, expect, it } from 'vitest';
import { coldStart, pollReady } from './cold-start.js';

const later = <T>(ms: number, v: T, log?: string[], what?: string) =>
  new Promise<T>((r) => setTimeout(() => (what && log?.push(what), r(v)), ms));

describe('coldStart', () => {
  it('brings the runner up, then prepares the fork while waiting for the socket', async () => {
    const log: string[] = [];
    const r = await coldStart({
      up: () => later(5, undefined, log, 'up'),
      prepare: () => (log.push('prepare start'), later(60, undefined, log, 'prepared')),
      ready: () => (log.push('ready start'), later(20, 'runner', log, 'runner up')),
      abandon: async () => void log.push('abandon'),
    });
    expect(r).toBe('runner');
    // 'runner up' before 'prepared' is the concurrency. (A wall-clock bound flaked on CI.)
    expect(log).toEqual(['up', 'ready start', 'prepare start', 'runner up', 'prepared']);
  });

  it('only waits for the socket when the fork exists already', async () => {
    expect(await coldStart({ up: async () => {}, ready: async () => 1, abandon: async () => {} })).toBe(1);
  });

  it('a failed `up` fails the start; nothing else runs', async () => {
    const log: string[] = [];
    await expect(coldStart({
      up: () => Promise.reject(new Error('create')),
      prepare: async () => void log.push('prepare'),
      ready: async () => void log.push('ready'),
      abandon: async () => void log.push('abandon'),
    })).rejects.toThrow('create');
    expect(log).toEqual([]);
  });

  it('a failed fork abandons the runner and fails the start', async () => {
    const log: string[] = [];
    await expect(coldStart({
      up: async () => {},
      prepare: () => Promise.reject(new Error('worktree')),
      ready: () => later(5, 'runner'),
      abandon: async () => void log.push('abandon'),
    })).rejects.toThrow('worktree');
    expect(log).toEqual(['abandon']);
  });

  it('a runner that never answers abandons and fails the start', async () => {
    const log: string[] = [];
    await expect(coldStart({
      up: async () => {},
      prepare: () => later(20, undefined, log, 'prepared'),
      ready: () => Promise.reject(new Error('not ready')),
      abandon: async () => void log.push('abandon'),
    })).rejects.toThrow('not ready');
    expect(log).toEqual(['abandon']);
  });

  it('rethrows the first failure, also when abandoning fails', async () => {
    await expect(coldStart({
      up: async () => {},
      prepare: () => later(5, undefined).then(() => Promise.reject(new Error('first'))),
      ready: () => later(30, undefined).then(() => Promise.reject(new Error('second'))),
      abandon: () => Promise.reject(new Error('stop failed')),
    })).rejects.toThrow('first');
  });
});

describe('pollReady', () => {
  it('tries at once, without a sleep first', async () => {
    const t0 = Date.now();
    expect(await pollReady(async () => 'up', 1000)).toEqual({ value: 'up', polls: 1 });
    expect(Date.now() - t0).toBeLessThan(500); // a first sleep would be 1000 ms
  });

  it('polls until something answers', async () => {
    let n = 0;
    expect(await pollReady(async () => (++n === 4 ? 'up' : undefined), 1)).toEqual({ value: 'up', polls: 4 });
  });

  it('gives up after the timeout', async () => {
    const r = await pollReady(async () => undefined, 5, 30);
    expect(r.value).toBeUndefined();
    expect(r.polls).toBeGreaterThan(1);
  });
});
