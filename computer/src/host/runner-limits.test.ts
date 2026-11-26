import { describe, expect, it } from 'vitest';
import { parseSize, RUNNER_MAX_CAP, runnerMaxCap, runnerMemoryLimits, systemdRunPrefix } from './runner-limits.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

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

describe('parseSize', () => {
  it('reads bytes and K/M/G/T as powers of 1024', () => {
    expect(parseSize('17179869184')).toBe(16 * GIB);
    expect(parseSize('32G')).toBe(32 * GIB);
    expect(parseSize('32GiB')).toBe(32 * GIB);
    expect(parseSize('32g')).toBe(32 * GIB);
    expect(parseSize(' 32768M ')).toBe(32 * GIB);
    expect(parseSize('1T')).toBe(1024 * GIB);
    expect(parseSize('1048576K')).toBe(GIB);
    expect(parseSize('1.5G')).toBe(1.5 * GIB);
  });

  it('refuses anything else', () => {
    for (const v of ['', 'G', 'abc', '-8G', '32 G', '32GB', '32Gi', '0x10', '1e3', '32P', '16G 12G']) expect(parseSize(v)).toBeUndefined();
  });
});

describe('runnerMaxCap', () => {
  it('is 16G when unset or empty', () => {
    expect(runnerMaxCap(undefined)).toEqual({ cap: RUNNER_MAX_CAP });
    expect(runnerMaxCap('')).toEqual({ cap: RUNNER_MAX_CAP });
    expect(runnerMaxCap('  ')).toEqual({ cap: 16 * GIB });
  });

  it('takes a valid size, in whole MiB', () => {
    expect(runnerMaxCap('32G')).toEqual({ cap: 32 * GIB });
    expect(runnerMaxCap('48GiB')).toEqual({ cap: 48 * GIB });
    expect(runnerMaxCap('8G')).toEqual({ cap: 8 * GIB });
    expect(runnerMaxCap('1G')).toEqual({ cap: GIB });
    expect(runnerMaxCap(String(GIB + 12345))).toEqual({ cap: GIB });
  });

  it('falls back to 16G with a reason for garbage, zero, negative and under 1G', () => {
    for (const v of ['lots', '0', '0G', '-32G', '512M', '1023M', '32GB']) {
      const r = runnerMaxCap(v);
      expect(r.cap).toBe(16 * GIB);
      expect(r.error).toContain(`SP_RUNNER_MEMORY_MAX=${v}`);
    }
    expect(runnerMaxCap('512M').error).toMatch(/minimum of 1G/);
    expect(runnerMaxCap('lots').error).toMatch(/not a size/);
  });
});

describe('runnerMemoryLimits with a cap', () => {
  it('raises max to the cap and high to 75% of it on a big machine', () => {
    expect(runnerMemoryLimits(128 * GIB, 32 * GIB)).toEqual({ high: '24G', max: '32G' });
    expect(runnerMemoryLimits(256 * GIB, 100 * GIB)).toEqual({ high: '75G', max: '100G' });
  });

  it('never lifts the 60% / 75% of RAM ceilings', () => {
    expect(runnerMemoryLimits(64 * GIB, 64 * GIB)).toEqual({ high: '39321M', max: '48G' });
    expect(runnerMemoryLimits(8 * GIB, 32 * GIB)).toEqual(runnerMemoryLimits(8 * GIB));
  });

  it('can lower the limits', () => {
    expect(runnerMemoryLimits(64 * GIB, 8 * GIB)).toEqual({ high: '6G', max: '8G' });
    expect(runnerMemoryLimits(64 * GIB, 1500 * MIB)).toEqual({ high: '1125M', max: '1500M' });
  });

  it('is the default with the default cap', () => {
    for (const g of [7.75, 16, 64, 256]) expect(runnerMemoryLimits(g * GIB, RUNNER_MAX_CAP)).toEqual(runnerMemoryLimits(g * GIB));
  });

  it('keeps high below max and both whole MiB', () => {
    for (const g of [1, 4, 8, 16, 32, 64, 256])
      for (const cap of [1, 1.3, 8, 16, 24, 32, 100, 1000]) {
        const { high, max } = runnerMemoryLimits(g * GIB, runnerMaxCap(`${cap}G`).cap);
        const bytes = (s: string) => Number.parseInt(s, 10) * (s.endsWith('G') ? GIB : MIB);
        expect(bytes(high)).toBeLessThan(bytes(max));
        expect(bytes(max)).toBeLessThanOrEqual(cap * GIB);
        expect(high).toMatch(/^\d+[MG]$/);
        expect(max).toMatch(/^\d+[MG]$/);
      }
  });

  it('puts the raised limits in the prefix', () => {
    expect(systemdRunPrefix(128 * GIB, 32 * GIB)).toBe('systemd-run --user --slice=slack-presence-runners.slice -p MemoryHigh=24G -p MemoryMax=32G');
  });
});
