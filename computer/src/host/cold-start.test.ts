import { describe, expect, it } from 'vitest';
import { coldStart, pollReady } from './cold-start.js';

const later = <T>(ms: number, v: T, log?: string[], what?: string) =>
  new Promise<T>((r) => setTimeout(() => (what && log?.push(what), r(v)), ms));

describe('coldStart', () => {
  it('starts the runner while forking and resolves only once both are done', async () => {
    const log: string[] = [];
    const r = await coldStart({
      dir: '/f',
      fork: () => (log.push('fork start'), later(60, '/f', log, 'fork done')),
      start: (dir) => (log.push(`start ${dir}`), later(20, 'runner', log, 'runner up')),
      abandon: () => log.push('abandon'),
    });
    expect(r).toEqual({ ready: 'runner', forkPath: '/f' });
    // 'runner up' before 'fork done' is the concurrency: sequential, the runner
    // couldn't start before the fork finished. (A wall-clock bound flaked on CI.)
    expect(log).toEqual(['fork start', 'start /f', 'runner up', 'fork done']);
  });

  it('forks first when the directory is not known up front (laptop)', async () => {
    const log: string[] = [];
    const r = await coldStart({
      fork: () => later(5, '/w', log, 'fork done'),
      start: (dir) => (log.push(`start ${dir}`), later(5, 1)),
      abandon: () => log.push('abandon'),
    });
    expect(r).toEqual({ ready: 1, forkPath: '/w' });
    expect(log).toEqual(['fork done', 'start /w']);
  });

  it('only starts when the fork exists already', async () => {
    const r = await coldStart({ dir: '/f', start: async (dir) => dir, abandon: () => {} });
    expect(r).toEqual({ ready: '/f', forkPath: '/f' });
  });

  it('a failed fork abandons a runner that came up, and fails the start', async () => {
    const abandoned: string[] = [];
    await expect(
      coldStart({ dir: '/f', fork: () => Promise.reject(new Error('worktree')), start: () => later(5, 'runner'), abandon: (r) => abandoned.push(r) }),
    ).rejects.toThrow('worktree');
    expect(abandoned).toEqual(['runner']);
  });

  it('a failed launch fails the start after the fork settles', async () => {
    let forked = false;
    await expect(
      coldStart({ dir: '/f', fork: () => later(10, '/f').then((v) => ((forked = true), v)), start: () => Promise.reject(new Error('launch')), abandon: () => {} }),
    ).rejects.toThrow('launch');
    expect(forked).toBe(true);
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
