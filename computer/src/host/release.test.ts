import { describe, expect, it } from 'vitest';
import { ofAnotherRelease, updateOnClose } from './release.js';

describe('release', () => {
  it('asks for the self-update on close 4426 and on no other code', () => {
    const wrote: string[] = [];
    expect(updateOnClose(1006, '/run/sp', (f) => wrote.push(f))).toBe(false);
    expect(updateOnClose(4010, '/run/sp', (f) => wrote.push(f))).toBe(false);
    expect(wrote).toEqual([]);
    expect(updateOnClose(4426, '/run/sp', (f) => wrote.push(f))).toBe(true);
    expect(wrote).toEqual(['/run/sp/update-now']);
  });

  it('a request that cannot be written does not throw', () => {
    expect(updateOnClose(4426, '/run/sp', () => { throw new Error('EACCES'); })).toBe(true);
  });

  it('picks the runners another release started', () => {
    const mine = { id: 'a', report: { runnerVersion: 'abc' } };
    const old = { id: 'b', report: { runnerVersion: 'old' } };
    const silent = { id: 'c', report: {} };
    expect(ofAnotherRelease([mine, old, silent], 'abc').map((r) => r.id)).toEqual(['b', 'c']);
  });
});
