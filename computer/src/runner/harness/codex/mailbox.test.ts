import { describe, expect, it } from 'vitest';
import { Mailbox } from './mailbox.js';

const drain = async <T>(b: Mailbox<T>) => {
  const out: T[] = [];
  for await (const x of b) out.push(x);
  return out;
};

describe('Mailbox', () => {
  it('yields every record once, in order, then ends', async () => {
    const b = new Mailbox<number>({ pause() {}, resume() {} });
    b.push(1, 2);
    setTimeout(() => (b.push(3), b.end()), 5);
    expect(await drain(b)).toEqual([1, 2, 3]);
  });

  it('fails after the queued records, and drops pushes after the end', async () => {
    const b = new Mailbox<number>({ pause() {}, resume() {} });
    b.push(1);
    b.end(new Error('gone'));
    b.push(2);
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const x of b) seen.push(x);
      })(),
    ).rejects.toThrow('gone');
    expect(seen).toEqual([1]);
  });

  it('pauses its producer past the high mark and resumes it at the low one, alternately', async () => {
    const calls: string[] = [];
    const b = new Mailbox<number>({ pause: () => calls.push('pause'), resume: () => calls.push('resume') }, 4, 1);
    b.push(1, 2, 3, 4, 5, 6);
    b.push(7);
    expect(calls).toEqual(['pause']);
    b.end();
    expect(await drain(b)).toHaveLength(7);
    expect(calls).toEqual(['pause', 'resume']);
  });
});
