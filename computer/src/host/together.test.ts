import { describe, expect, it } from 'vitest';
import { timed, together } from './together.js';

describe('steps run together', () => {
  it('resolves with every result in order', async () => {
    expect(await together<[number, string]>([Promise.resolve(1), Promise.resolve('two')])).toEqual([1, 'two']);
  });

  it('rejects with the first rejection in order, only once every step settled', async () => {
    let slowDone = false;
    const slow = new Promise<void>((resolve) => setTimeout(() => ((slowDone = true), resolve()), 30));
    const e = await together<[unknown, unknown, unknown]>([slow, Promise.reject(new Error('first')), Promise.reject(new Error('second'))]).catch((x) => x);
    expect(e.message).toBe('first');
    expect(slowDone).toBe(true);
  });

  it('timed: the step\'s time in data, only when it resolved', async () => {
    const data: Record<string, unknown> = {};
    expect(await timed(data, 'container.x_ms', new Promise((r) => setTimeout(() => r('v'), 20)))).toBe('v');
    expect(data['container.x_ms']).toBeGreaterThanOrEqual(15);
    await expect(timed(data, 'container.y_ms', Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(data).not.toHaveProperty('container.y_ms');
  });
});
