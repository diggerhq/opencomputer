import { describe, expect, it } from 'vitest';
import { claimSpare } from './claim.js';

describe('claimSpare', () => {
  const steps = (o: { take?: () => string; claim?: () => Promise<void>; fork?: () => Promise<string> } = {}) => {
    const log: string[] = [];
    return {
      log,
      s: {
        take: o.take ?? (() => 'spare' as string),
        fork: o.fork ?? (async () => (log.push('fork'), '/fork')),
        claim: o.claim ?? (async () => void log.push('claim')),
        discard: (r: string) => void log.push(`discard ${r}`),
        release: (r: string) => void log.push(`release ${r}`),
      },
    };
  };

  it('forks, then claims the spare into the fork', async () => {
    const { s, log } = steps();
    expect(await claimSpare(s)).toEqual({ runner: 'spare', forkPath: '/fork' });
    expect(log).toEqual(['fork', 'claim']);
  });

  it('no spare: misses without forking (the cold start forks alongside the launch)', async () => {
    const { s, log } = steps({ take: () => 'none' });
    expect(await claimSpare(s as never)).toEqual({ missed: 'none' });
    expect(log).toEqual([]);
  });

  it('a refused or unanswered claim discards the spare and keeps the fork for the cold start', async () => {
    const refused = steps({ claim: () => Promise.reject(new Error('claim refused: option x')) });
    expect(await claimSpare(refused.s)).toEqual({ missed: 'refused', forkPath: '/fork' });
    expect(refused.log).toEqual(['fork', 'discard spare']);
    const slow = steps({ claim: () => Promise.reject(new Error('runner did not answer claim')) });
    expect(await claimSpare(slow.s)).toEqual({ missed: 'timeout', forkPath: '/fork' });
    const dead = steps({ claim: () => Promise.reject(new Error('runner gone')) });
    expect(await claimSpare(dead.s)).toEqual({ missed: 'gone', forkPath: '/fork' });
  });

  it('a failed fork releases the spare, which was never spoken to, and fails the start', async () => {
    const { s, log } = steps({ fork: () => Promise.reject(new Error('worktree')) });
    await expect(claimSpare(s)).rejects.toThrow('worktree');
    expect(log).toEqual(['release spare']);
    const { s: s2, log: log2 } = steps({ fork: () => Promise.reject(new Error('worktree')) });
    await expect(claimSpare({ ...s2, release: undefined })).rejects.toThrow('worktree');
    expect(log2).toEqual(['discard spare']);
  });
});
