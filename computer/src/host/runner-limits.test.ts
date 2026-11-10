import { describe, expect, it } from 'vitest';
import { runnerMemoryLimits, systemdRunPrefix } from './runner-limits.js';

const GIB = 1024 ** 3;

describe('runnerMemoryLimits', () => {
  it('keeps the 64 GiB host limits on big machines', () => {
    expect(runnerMemoryLimits(64 * GIB)).toEqual({ high: '12G', max: '16G' });
    // MemTotal is a little under the nominal size; still the caps.
    expect(runnerMemoryLimits(62.8 * GIB)).toEqual({ high: '12G', max: '16G' });
  });

  it('scales to 60% / 75% on an 8 GiB computer', () => {
    expect(runnerMemoryLimits(8 * GIB)).toEqual({ high: '4915M', max: '6G' });
    // What a D2as_v7 actually reports (about 7.75 GiB).
    expect(runnerMemoryLimits(7.75 * GIB)).toEqual({ high: '4761M', max: '5952M' });
  });

  it('keeps high below max and caps on the way up', () => {
    for (const g of [1, 2, 4, 7.75, 8, 16, 20, 21.4, 32, 64, 256]) {
      const { high, max } = runnerMemoryLimits(g * GIB);
      const bytes = (s: string) => Number.parseInt(s, 10) * (s.endsWith('G') ? GIB : 1024 ** 2);
      expect(bytes(high)).toBeLessThan(bytes(max));
      expect(bytes(max)).toBeLessThanOrEqual(16 * GIB);
      expect(high).toMatch(/^\d+[MG]$/);
    }
    expect(runnerMemoryLimits(16 * GIB)).toEqual({ high: '9830M', max: '12G' });
  });
});

describe('systemdRunPrefix', () => {
  it('is the same command as before on the 64 GiB host', () => {
    expect(systemdRunPrefix(64 * GIB)).toBe('systemd-run --user --slice=slack-presence-runners.slice -p MemoryHigh=12G -p MemoryMax=16G');
  });
});
