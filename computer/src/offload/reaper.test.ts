import { describe, expect, it } from 'vitest';
import type { Aws } from './aws.js';
import type { JobRow } from './ledger.js';
import { reap } from './reaper.js';

const NOW = 10_000_000;
const fence = { org: 'o', sessionKey: 's', runnerId: 'r', epoch: 1 };
const row = (id: string, p: Partial<JobRow>): JobRow => ({ id, fence, state: 'running', size: 's', cmd: 'x', artifacts: [], minutes: 5, sourceBytes: 1, createdAt: 0, ...p });

function fake(vms: { id: string; state?: string; age?: number }[], fail = new Set<string>()) {
  const terminated: string[] = [];
  const a = {
    list: async () => vms.map((v) => ({ microvmId: v.id, state: v.state ?? 'RUNNING', startedAt: new Date(NOW - (v.age ?? 3600_000)) })),
    terminate: async (id: string) => {
      if (fail.has(id)) throw new Error('AccessDeniedException');
      terminated.push(id);
    },
  } as unknown as Aws;
  return { a, terminated };
}

describe('reaper', () => {
  it('keeps live jobs and young unowned MicroVMs, terminates the rest', async () => {
    const { a, terminated } = fake([
      { id: 'live' }, { id: 'ended' }, { id: 'late' }, { id: 'gone', state: 'TERMINATED' },
      { id: 'unowned-old' }, { id: 'unowned-new', age: 60_000 },
    ]);
    const rows = [
      row('j1', { microvmId: 'live', deadline: NOW + 1 }), row('j2', { microvmId: 'ended', state: 'done' }), row('j3', { microvmId: 'late', deadline: NOW - 1 }),
    ];
    const r = await reap({ aws: a, rows: () => rows, images: ['img', 'img'], now: () => NOW });
    expect(terminated.sort()).toEqual(['ended', 'late', 'unowned-old']);
    expect(r.kept).toBe(2);
  });
  it('spares unowned MicroVMs while one of our jobs is launching', async () => {
    const { a, terminated } = fake([{ id: 'u' }]);
    await reap({ aws: a, rows: () => [row('j9', { state: 'launching', deadline: NOW + 1 })], images: ['img'], now: () => NOW });
    expect(terminated).toEqual([]);
  });
  it('reports a denied terminate and retries it on the next pass', async () => {
    const fail = new Set(['u']);
    const { a, terminated } = fake([{ id: 'u' }], fail);
    const first = await reap({ aws: a, rows: () => [], images: ['img'], now: () => NOW });
    expect(first.errors).toEqual(['TerminateMicrovm u: AccessDeniedException']);
    fail.clear();
    await reap({ aws: a, rows: () => [], images: ['img'], now: () => NOW });
    expect(terminated).toEqual(['u']);
  });
});
