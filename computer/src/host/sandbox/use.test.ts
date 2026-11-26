import { describe, expect, it } from 'vitest';
import { Unavailable, UPDATING } from '../unavailable.js';
import type { SandboxRecord } from './records.js';
import { sandboxUses } from './use.js';

const ID = '00aa11bb22cc33dd';
const record = { id: ID, person: 'pat', key: 'C1:1.0', usedAt: '2026-11-13T00:00:00.000Z' } as SandboxRecord;

function rig(o: { held?: boolean; record?: SandboxRecord | undefined; active?: boolean } = {}) {
  const log: string[] = [];
  const uses = sandboxUses({
    as: { settled: async (ms) => {
      log.push(`settled ${ms}`);
      if (o.held) throw new Unavailable(UPDATING);
    } },
    records: { get: () => ('record' in o ? o.record : record) },
    workspace: (r) => `/data/people/${r.person}/sessions/k`,
    unitActive: async () => (log.push('active?'), o.active ?? true),
  });
  return { uses, log };
}

describe('entering a sandbox (work 103, C13)', () => {
  it('waits for the image lock, 10 s at most, then says where the thread is now', async () => {
    const t = rig({ active: false });
    const use = await t.uses.enter(ID);
    expect(use.place).toEqual({ id: ID, person: 'pat', workspace: '/data/people/pat/sessions/k', running: false });
    expect(t.log).toEqual(['settled 10000', 'active?']);
  });

  it('is refused while provisioning holds the storage, and asks nothing of Podman or the unit', async () => {
    const t = rig({ held: true });
    await expect(t.uses.enter(ID)).rejects.toThrow(/The computer is updating, try again/);
    expect(t.log).toEqual(['settled 10000']);
  });

  it('a thread is in use from the moment it is entered until it is left, and nobody may claim it then or for what was read before', async () => {
    const t = rig();
    const t0 = Date.now();
    const use = await t.uses.enter(ID);
    expect(t.uses.claim(ID, t0)).toBeUndefined();
    use.leave();
    use.leave();
    // Used since `t0`: what was found out about the thread before may be old.
    expect(t.uses.claim(ID, t0)).toBeUndefined();
    const free = t.uses.claim(ID, Date.now() + 1);
    expect(free).toBeTypeOf('function');
    // Claimed: nothing enters, and nobody else claims.
    expect(t.uses.claim(ID, Date.now() + 1)).toBeUndefined();
    const e = await t.uses.enter(ID).catch((x) => x);
    expect([e.name, e.retryable]).toEqual(['Unavailable', true]);
    expect(e.message).toMatch(/being cleaned up/);
    free?.();
    (await t.uses.enter(ID)).leave();
  });

  it('one that waits for the image lock is in use already, and one that was refused is not', async () => {
    const t = rig({ held: true });
    const entering = t.uses.enter(ID);
    expect(t.uses.claim(ID, 0)).toBeUndefined();
    await expect(entering).rejects.toThrow(/updating/);
    expect(t.uses.claim(ID, Date.now() + 1)).toBeTypeOf('function');
  });

  it('a thread whose record is gone has nothing to enter', async () => {
    const t = rig({ record: undefined });
    const e = await t.uses.enter(ID).catch((x) => x);
    expect(e).toBeInstanceOf(Unavailable);
    expect(e.retryable).toBe(false);
  });
});
