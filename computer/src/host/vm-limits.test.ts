// The machine-wide limits live in a shell script (deploy/vm/limits.sh, run at
// provision time and on every boot); this runs its pure part with fake
// machines and checks it against the per-runner limits in runner-limits.ts.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnerMemoryLimits } from './runner-limits.js';

const SCRIPT = path.resolve(import.meta.dirname, '../../deploy/vm/limits.sh');

function limits(memTotalKib: number, nproc: number): Record<string, number> {
  const out = execFileSync('bash', [SCRIPT, '--print'], {
    env: { ...process.env, SP_LIMITS_MEMTOTAL_KIB: String(memTotalKib), SP_LIMITS_NPROC: String(nproc) },
    encoding: 'utf8',
  });
  return Object.fromEntries(out.trim().split('\n').map((l) => [l.split('=')[0], Number(l.split('=')[1])]));
}

const mib = (s: string) => Number.parseInt(s, 10) * (s.endsWith('G') ? 1024 : 1);

describe('deploy/vm/limits.sh', () => {
  it('stays close to the hand-tuned values on the 64 GiB / 16 vCPU host', () => {
    const l = limits(65_842_600, 16);
    expect(l).toMatchObject({ USER_CPU: 1500, RUNNERS_CPU: 1400, HOST_MAX_MIB: 2048 });
    // Was MemoryHigh=54G/MemoryMax=58G (user) and 50G/54G (runners).
    expect(l.USER_MAX_MIB / 1024).toBeCloseTo(56.5, 0);
    expect(l.RUNNERS_HIGH_MIB / 1024).toBeCloseTo(48.9, 0);
  });

  it('leaves the system a CPU and at least 1 GiB on an 8 GiB / 2 vCPU computer', () => {
    const l = limits(8_090_000, 2);
    expect(l).toMatchObject({ USER_CPU: 100, RUNNERS_CPU: 100, USER_MAX_MIB: 7900 - 1024 });
    expect(l.HOST_MAX_MIB).toBeGreaterThanOrEqual(768);
  });

  it('nests: runners inside the user slice, one runner inside the runners slice, high below max', () => {
    for (const [kib, n] of [[2_000_000, 1], [8_090_000, 2], [16_300_000, 4], [32_800_000, 8], [65_842_600, 16], [263_000_000, 64]]) {
      const l = limits(kib, n);
      expect(l.USER_HIGH_MIB).toBeLessThan(l.USER_MAX_MIB);
      expect(l.RUNNERS_MAX_MIB).toBeLessThanOrEqual(l.USER_HIGH_MIB);
      expect(l.RUNNERS_HIGH_MIB).toBeLessThan(l.RUNNERS_MAX_MIB);
      expect(l.RUNNERS_CPU).toBeLessThanOrEqual(l.USER_CPU);
      expect(l.USER_MAX_MIB + 1024).toBeLessThanOrEqual(l.MEM_TOTAL_MIB);
      if (kib >= 8_000_000) expect(mib(runnerMemoryLimits(kib * 1024).max)).toBeLessThanOrEqual(l.RUNNERS_MAX_MIB);
    }
  });
});
