import type { SpareProcess } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { Spare } from './spare.js';

function fake() {
  let exit!: () => void;
  const p = { closed: false, exited: new Promise<void>((r) => (exit = r)), close: () => void (p.closed = true) };
  return { p: p as unknown as SpareProcess & { closed: boolean }, exit };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function holder(procs: ReturnType<typeof fake>[]) {
  const log: string[] = [];
  const spare = new Spare(async () => procs.shift()!.p, { changed: () => log.push('changed'), died: (w) => log.push(`died: ${w}`) });
  return { spare, log };
}

describe('Spare', () => {
  it('parks a process, keeps it for the same credential and replaces it for another', async () => {
    const a = fake();
    const b = fake();
    const { spare, log } = holder([a, b]);
    spare.warm('fp1');
    expect(spare.ready).toBe(false);
    await tick();
    expect(spare.ready).toBe(true);
    spare.warm('fp1');
    spare.warm('fp2');
    expect(a.p.closed).toBe(true);
    expect(spare.credential).toBe('fp2');
    await tick();
    expect(spare.take()).toBe(b.p);
    expect(spare.ready).toBe(false);
    b.exit(); // taken: the session's now, not a death
    a.exit();
    await tick();
    expect(log).toEqual(['changed', 'changed', 'changed', 'changed']);
  });

  it('reports a parked process that exits', async () => {
    const a = fake();
    const { spare, log } = holder([a]);
    spare.warm('fp');
    await tick();
    a.exit();
    await tick();
    expect(log.at(-1)).toBe('died: exited while parked');
    expect(spare.take()).toBeUndefined();
  });

  it('closes a process that finishes starting after it was replaced', async () => {
    const a = fake();
    const b = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const spare = new Spare(async () => (n++ === 0 ? (await gate, a.p) : b.p), { changed: () => {}, died: () => {} });
    spare.warm('fp1');
    spare.warm('fp2');
    await tick();
    release();
    await tick();
    expect(a.p.closed).toBe(true);
    expect(spare.take()).toBe(b.p);
  });
});
