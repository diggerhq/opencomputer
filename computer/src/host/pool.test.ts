import { describe, expect, it } from 'vitest';
import type { SpareReport } from '../protocol.js';
import { Pool } from './pool.js';

type R = { spare?: SpareReport; name: string };
const spare = (name: string, s: Partial<SpareReport> = {}): R => ({ name, spare: { id: name, ready: true, version: 'v1', credential: 'fp', ...s } });

function pool(size = 2) {
  let t = 0;
  const launches: { resolve: () => void; reject: () => void }[] = [];
  const evicted: string[] = [];
  let failed = 0;
  const p = new Pool<R>({
    size,
    version: 'v1',
    launch: () => new Promise<void>((resolve, reject) => launches.push({ resolve, reject })),
    evict: (r, why) => evicted.push(`${r.name}:${why}`),
    failed: () => failed++,
    now: () => t,
    backoffMs: 1000,
    minLifeMs: 60_000,
  });
  return { p, launches, evicted, advance: (ms: number) => (t += ms), failed: () => failed };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Pool', () => {
  it('is off at size 0', () => {
    const { p, launches } = pool(0);
    p.fill(true);
    expect(p.enabled).toBe(false);
    expect(launches).toHaveLength(0);
  });

  it('launches up to size, counting spares still launching, and only with a credential', () => {
    const { p, launches } = pool(2);
    p.fill(false);
    expect(launches).toHaveLength(0);
    p.fill(true);
    p.fill(true);
    expect(launches).toHaveLength(2);
    p.add(spare('a'));
    launches[0].resolve();
    p.fill(true);
    expect(launches).toHaveLength(2);
  });

  it('gives a ready spare of this release with the delivery credential, once', () => {
    const { p } = pool();
    const a = spare('a', { ready: false });
    const b = spare('b', { credential: 'other' });
    const c = spare('c', { version: 'v0' });
    for (const r of [a, b, c]) p.add(r);
    expect(p.take('fp')).toBe('credential');
    expect(p.take(undefined)).toBe('credential');
    a.spare!.ready = true;
    expect(p.take('fp')).toBe(a);
    expect(p.take('fp')).toBe('credential');
    expect(pool().p.take('fp')).toBe('none');
  });

  it('gives Codex a ready spare whatever its credential', () => {
    const { p } = pool();
    const a = spare('a', { ready: false });
    const b = spare('b', { credential: 'other' });
    for (const r of [a, b]) p.add(r);
    expect(p.take(undefined, true)).toBe(b);
    expect(p.take(undefined, true)).toBe('none');
  });

  it('evicts spares of another release and beyond size', () => {
    const { p, evicted } = pool(1);
    const old = spare('old', { version: 'v0' });
    p.add(old);
    p.changed(old);
    p.add(spare('a'));
    p.add(spare('b'));
    p.fill(true);
    expect(evicted).toEqual(['old:version', 'b:surplus']);
    expect(p.spares.size).toBe(1);
  });

  it('backs off after spares die before they were ready, and resets once one is', async () => {
    const { p, launches, advance, failed } = pool(1);
    const a = spare('a', { ready: false });
    p.add(a);
    p.gone(a);
    expect(failed()).toBe(1);
    p.fill(true);
    expect(launches).toHaveLength(0);
    advance(1000);
    p.fill(true);
    expect(launches).toHaveLength(1);
    launches[0].reject();
    await settle();
    advance(1999);
    p.fill(true);
    expect(launches).toHaveLength(1); // second failure: 2 s
    advance(1);
    p.fill(true);
    expect(launches).toHaveLength(2);
    const b = spare('b');
    p.add(b);
    p.changed(b);
    launches[1].resolve();
    await settle();
    advance(60_000);
    p.gone(b); // it was ready for a minute: no back-off
    p.fill(true);
    expect(launches).toHaveLength(3);
  });

  it('backs off after a spare dies soon after it was ready, so one that parks and crashes is not restarted in a loop', () => {
    const { p, launches, advance, failed } = pool(1);
    const a = spare('a');
    p.add(a);
    p.changed(a);
    advance(59_999);
    p.gone(a);
    expect(failed()).toBe(1);
    p.fill(true);
    expect(launches).toHaveLength(0);
    advance(1000);
    p.fill(true);
    expect(launches).toHaveLength(1);
  });
});
