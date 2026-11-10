import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Batch } from '../telemetry/emitter.js';
import { type ShipperOptions, startShipper } from './telemetry-ship.js';
import { Spool } from './telemetry-spool.js';

const batch = (from: number, n: number): Batch => ({
  events: Array.from({ length: n }, (_, i) => ({ event_id: `e${from + i}` }) as unknown as Batch['events'][number]),
  turns: [],
});

function setup(statuses: (number | 'throw' | 'hang')[], over: Partial<ShipperOptions> = {}) {
  const dropped: Record<string, number> = {};
  const spool = new Spool({ dir: mkdtempSync(path.join(tmpdir(), 'ship-')), batchRecords: 1000, onDrop: (r, n) => (dropped[r] = (dropped[r] ?? 0) + n) });
  const posts: { url: string; auth: string; body: { host_boot_id: string; batch_seq: number; events: { event_id: string }[] } }[] = [];
  let clock = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    if (status === 'throw') throw new Error('ECONNREFUSED');
    if (status === 'hang')
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    posts.push({ url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
  }) as typeof fetch;
  const sh = startShipper({
    spool,
    url: 'https://collector.test/',
    credential: () => 'cred-1',
    fetch: fakeFetch,
    intervalMs: 3_600_000,
    now: () => clock,
    ...over,
  });
  const fill = (...sizes: number[]) => {
    let at = 0;
    for (const n of sizes) {
      spool.append(batch(at, n));
      spool.seal();
      at += n;
    }
  };
  return { sh, spool, posts, dropped, fill, advance: (ms: number) => (clock += ms) };
}
const pass = (sh: { drain(ms: number): Promise<void> }) => sh.drain(1000);

describe('startShipper', () => {
  it('posts each sealed segment oldest first with its boot id and sequence, deleting on 2xx', async () => {
    const { sh, spool, posts, fill } = setup([202]);
    fill(2, 1, 3);
    await pass(sh);
    expect(posts.map((p) => p.body.batch_seq)).toEqual([1, 2, 3]);
    expect(posts.every((p) => p.body.host_boot_id === spool.bootId && p.auth === 'Bearer cred-1')).toBe(true);
    expect(posts[0].url).toBe('https://collector.test/v1/events');
    expect(posts.flatMap((p) => p.body.events.map((e) => e.event_id))).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
    expect(spool.segments()).toHaveLength(0);
  });

  it('keeps segments through a collector outage and backs off 1 s doubling to 60 s', async () => {
    const statuses: (number | 'throw')[] = [503, 'throw', 500, 500, 500, 500, 500, 500, 200];
    const { sh, spool, posts, fill, advance } = setup(statuses, {});
    fill(1, 1);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      sh.kick();
      await new Promise((r) => setTimeout(r, 5));
      seen.push(sh.backoffMs);
      sh.kick(); // inside the backoff: no request
      await new Promise((r) => setTimeout(r, 5));
      advance(sh.backoffMs);
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(spool.segments()).toHaveLength(2);
    sh.kick();
    await new Promise((r) => setTimeout(r, 5));
    await pass(sh);
    expect(spool.segments()).toHaveLength(0);
    expect(posts.at(-1)?.body.batch_seq).toBe(2);
    expect(sh.backoffMs).toBe(0);
  });

  it('drops a segment the collector rejects with 4xx and counts it', async () => {
    const { sh, spool, dropped, fill } = setup([400, 202]);
    fill(3, 2);
    await pass(sh);
    expect(dropped).toEqual({ rejected: 3 });
    expect(spool.segments()).toHaveLength(0);
  });

  it('retries 401 and 429 rather than dropping', async () => {
    for (const status of [401, 429]) {
      const { sh, spool, dropped, fill } = setup([status]);
      fill(2);
      await pass(sh);
      expect(spool.segments()).toHaveLength(1);
      expect(dropped).toEqual({});
    }
  });

  it('sends nothing without a credential, and picks up a renewed one', async () => {
    let cred: string | undefined;
    const { sh, spool, posts, fill } = setup([202], { credential: () => cred });
    fill(1);
    await pass(sh);
    expect(posts).toHaveLength(0);
    expect(spool.segments()).toHaveLength(1);
    cred = 'renewed';
    await pass(sh);
    expect(posts[0].auth).toBe('Bearer renewed');
  });

  it('drain seals the open segment and gives up at its deadline, leaving the rest on disk', async () => {
    const { sh, spool, fill } = setup(['hang']);
    fill(1);
    spool.append(batch(10, 1));
    const t0 = Date.now();
    await sh.drain(100);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(spool.segments()).toHaveLength(2);
  });
});
