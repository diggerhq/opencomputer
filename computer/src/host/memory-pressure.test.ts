import { describe, expect, it } from 'vitest';
import { availableMb, type EvictCandidate, EVICT_MIN_AVAILABLE_MB, evictThresholdMb, memoryPressure, pickIdle } from './memory-pressure.js';

const NOW = 10_000_000;
const runner = (id: string, idleMs: number, o: Partial<EvictCandidate> = {}): EvictCandidate => ({
  id, key: `T/${id}`, lastDelivery: NOW - idleMs, status: 'idle', inUse: false, ...o,
});

function setup(o: { mb?: number; threshold?: number; runners?: EvictCandidate[]; spares?: string[] } = {}) {
  const stopped: string[] = [];
  const lines: string[] = [];
  const spares = [...(o.spares ?? [])];
  let mb = o.mb;
  const m = memoryPressure({
    thresholdMb: o.threshold ?? 2048,
    available: () => mb,
    runners: () => o.runners ?? [],
    stopThread: (r) => stopped.push(r.id),
    dropSpare: () => spares.shift(),
    log: (l) => lines.push(l),
    now: () => NOW,
  });
  return { m, stopped, lines, spares, setMb: (v: number) => (mb = v) };
}

describe('evictThresholdMb (SP_EVICT_MIN_AVAILABLE_MB)', () => {
  it('defaults when unset or empty, 0 is off, a number of MB is taken', () => {
    expect(evictThresholdMb(undefined)).toBe(EVICT_MIN_AVAILABLE_MB);
    expect(evictThresholdMb('')).toBe(EVICT_MIN_AVAILABLE_MB);
    expect(evictThresholdMb('0')).toBe(0);
    expect(evictThresholdMb('4096')).toBe(4096);
  });
  it('throws on anything else', () => {
    expect(() => evictThresholdMb('-1')).toThrow(/SP_EVICT_MIN_AVAILABLE_MB/);
    expect(() => evictThresholdMb('2G')).toThrow(/SP_EVICT_MIN_AVAILABLE_MB/);
  });
});

describe('availableMb', () => {
  it('reads MemAvailable in MB; undefined without it', () => {
    expect(availableMb(() => 'MemTotal:       65536000 kB\nMemFree:  100 kB\nMemAvailable:    2097152 kB\n')).toBe(2048);
    expect(availableMb(() => 'MemTotal: 1 kB\n')).toBeUndefined();
    expect(availableMb(() => { throw new Error('ENOENT'); })).toBeUndefined();
  });
});

describe('pickIdle', () => {
  it('picks the least recently used idle thread', () => {
    const rs = [runner('a', 120_000), runner('b', 3_600_000), runner('c', 600_000)];
    expect(pickIdle(rs, NOW)?.id).toBe('b');
  });
  it('never picks a spare, a busy, starting, exiting or switching runner, one in use, or one delivered to just now', () => {
    const rs = [
      runner('spare', 9e6, { key: '' }),
      runner('busy', 9e6, { status: 'busy' }),
      runner('starting', 9e6, { status: 'starting' }),
      runner('exiting', 9e6, { exiting: true }),
      runner('switching', 9e6, { switching: true }),
      runner('terminal', 9e6, { inUse: true }),
      runner('fresh', 5_000),
    ];
    expect(pickIdle(rs, NOW)).toBeUndefined();
    expect(pickIdle([...rs, runner('ok', 70_000)], NOW)?.id).toBe('ok');
  });
});

describe('memoryPressure', () => {
  it('does nothing at or above the threshold', () => {
    const { m, stopped } = setup({ mb: 2048, runners: [runner('a', 9e6)], spares: ['s'] });
    expect(m.low()).toBe(false);
    expect(m.check()).toBeUndefined();
    expect(stopped).toEqual([]);
  });

  it('below it, stops one LRU idle thread per check and logs why, keeping the spares', () => {
    const { m, stopped, lines, spares } = setup({ mb: 1000, runners: [runner('a', 120_000), runner('b', 7_000_000, { status: 'busy' }), runner('c', 3_000_000)], spares: ['s'] });
    expect(m.low()).toBe(true);
    expect(m.check()).toBe('thread c');
    expect(stopped).toEqual(['c']);
    expect(spares).toEqual(['s']);
    expect(lines[0]).toMatch(/stopping idle thread runner c \(T\/c, LRU, idle 3000 s\): available 1000 MB < threshold 2048 MB/);
  });

  it('drops a spare only when no thread can be stopped', () => {
    const { m, stopped, lines } = setup({ mb: 1000, runners: [runner('busy', 9e6, { status: 'busy' })], spares: ['s1', 's2'] });
    expect(m.check()).toBe('spare s1');
    expect(stopped).toEqual([]);
    expect(lines[0]).toMatch(/dropping spare s1, no idle thread to stop: available 1000 MB < threshold 2048 MB/);
  });

  it('is off at threshold 0, and without MemAvailable', () => {
    const off = setup({ mb: 1, threshold: 0, runners: [runner('a', 9e6)], spares: ['s'] });
    expect(off.m.low()).toBe(false);
    expect(off.m.check()).toBeUndefined();
    const unknown = setup({ mb: undefined, runners: [runner('a', 9e6)] });
    expect(unknown.m.low()).toBe(false);
    expect(unknown.m.check()).toBeUndefined();
  });
});
