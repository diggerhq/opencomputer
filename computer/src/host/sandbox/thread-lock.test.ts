import { describe, expect, it } from 'vitest';
import { threadLocks } from './thread-lock.js';

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
const tick = () => new Promise((r) => setImmediate(r));

describe('a thread\'s turn', () => {
  it('one at a time per thread, in the order asked; other threads are not held', async () => {
    const l = threadLocks();
    const log: string[] = [];
    const g = gate();
    const a = l.run('pat', 'C1:1.1', async () => (log.push('a begins'), await g.wait, log.push('a ends')));
    const b = l.run('pat', 'C1:1.1', async () => void log.push('b'));
    const c = l.run('pat', 'C1:2.2', async () => void log.push('c, another thread'));
    const d = l.run('quinn', 'C1:1.1', async () => void log.push('d, another person'));
    await Promise.all([c, d]);
    await tick();
    expect(log).toEqual(['a begins', 'c, another thread', 'd, another person']);
    expect(l.busy('pat', 'C1:1.1')).toBe(true);
    g.open();
    await Promise.all([a, b]);
    expect(log.slice(3)).toEqual(['a ends', 'b']);
    await tick();
    expect(l.busy('pat', 'C1:1.1')).toBe(false);
  });

  it('a turn that rejects ends: its error is its caller\'s, and the next turn runs', async () => {
    const l = threadLocks();
    const a = l.run('pat', 'k', async () => {
      throw new Error('boom');
    });
    const b = l.run('pat', 'k', async () => 'next');
    await expect(a).rejects.toThrow('boom');
    expect(await b).toBe('next');
  });
});
