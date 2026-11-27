import { describe, expect, it } from 'vitest';
import type { Aws } from './aws.js';
import type { JobRow } from './ledger.js';
import { reap } from './reaper.js';

const NOW = 10_000_000;
const fence = { org: 'o', sessionKey: 's', runnerId: 'r', epoch: 1 };
const row = (id: string, p: Partial<JobRow>): JobRow => ({ id, fence, state: 'running', size: 's', cmd: 'x', artifacts: [], minutes: 5, sourceBytes: 1, createdAt: 0, ...p });

function fake(vms: { id: string; state?: string; age?: number; tags?: Record<string, string> }[]) {
  const terminated: string[] = [];
  const a = {
    list: async () => vms.map((v) => ({ microvmId: v.id, state: v.state ?? 'RUNNING', startedAt: new Date(NOW - (v.age ?? 3600_000)) })),
    tags: async (id: string) => vms.find((v) => v.id === id)?.tags ?? {},
    terminate: async (id: string) => void terminated.push(id),
  } as unknown as Aws;
  return { a, terminated };
}

describe('reaper', () => {
  it('keeps live jobs and other hosts, terminates the rest', async () => {
    const { a, terminated } = fake([
      { id: 'live' }, { id: 'ended' }, { id: 'late' }, { id: 'gone', state: 'TERMINATED' },
      { id: 'theirs', tags: { 'opencomputer:offload': 'i-other' } },
      { id: 'orphan', tags: { 'opencomputer:offload': 'i-me', 'opencomputer:job': 'jx' } },
      { id: 'untagged-old' }, { id: 'untagged-new', age: 60_000 },
    ]);
    const rows = [
      row('j1', { microvmId: 'live', deadline: NOW + 1 }), row('j2', { microvmId: 'ended', state: 'done' }), row('j3', { microvmId: 'late', deadline: NOW - 1 }),
    ];
    const r = await reap({ aws: a, rows: () => rows, images: ['img', 'img'], hostTag: 'i-me', now: () => NOW });
    expect(terminated.sort()).toEqual(['ended', 'late', 'orphan', 'untagged-old']);
    expect(r.kept).toBe(3);
  });
  it('spares untagged MicroVMs while one of our jobs is launching', async () => {
    const { a, terminated } = fake([{ id: 'u' }, { id: 't', tags: { 'opencomputer:offload': 'i-me', 'opencomputer:job': 'j9' } }]);
    await reap({ aws: a, rows: () => [row('j9', { state: 'launching', deadline: NOW + 1 })], images: ['img'], hostTag: 'i-me', now: () => NOW });
    expect(terminated).toEqual([]);
  });
});
