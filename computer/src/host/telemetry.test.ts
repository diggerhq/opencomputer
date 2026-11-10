import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTelemetry, type Batch } from '../telemetry/emitter.js';
import { uuidv7 } from '../telemetry/envelope.js';
import { startHostTelemetry, workspaceTelemetry } from './telemetry.js';

async function runnerBatch(): Promise<Batch> {
  let out: Batch = { events: [], turns: [] };
  const t = createTelemetry({ service: 'runner', version: 'r1', region: 'westus2', send: (b) => void (out = b) });
  t.emit('intro.posted', { session_key: 'T1:C1:1.2', duration_ms: 12 });
  t.turn({ turn_id: uuidv7(), trace_id: uuidv7(), session_key: 'T1:C1:1.2', sent_at: '2026-10-12 10:00:00.000', gateway_version: 'g',
    host_version: '', runner_version: 'r', synthetic: false, outcome: 'completed' });
  await t.flush();
  return out;
}

/** A collector stand-in that records every POST. */
async function collector() {
  const posts: { auth?: string; body: { host_boot_id: string; batch_seq: number; events: { event_name: string; service_name: string }[]; turns: unknown[] } }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      posts.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts, close: () => server.close() };
}

describe('host telemetry', () => {
  it("relays runners' records after re-validation and ships them with its own", async () => {
    const c = await collector();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'host-tm-'));
    const h = startHostTelemetry({ dataDir, url: c.url, credential: 'cred-env', version: 'h1', region: 'westus2', base: { host_id: 'vm-1' }, intervalMs: 3_600_000 });
    const good = await runnerBatch();
    h.relay(good);
    h.relay({ events: [{ ...good.events[0], event_name: 'render.started', data: { kind: 'browser' } }], turns: [] }); // not in the catalog: passes
    h.relay({ events: [{ ...good.events[0], data: { text: 'line one\nline two' } }] }); // content-shaped: dropped
    h.relay('garbage');
    h.t.emit('fork.done', { session_key: 'T1:C1:1.2', data: { repos: 2 } });
    expect(h.dropped).toBe(2);
    await h.close(2000);
    c.close();
    const events = c.posts.flatMap((p) => p.body.events);
    expect(c.posts.every((p) => p.auth === 'Bearer cred-env')).toBe(true);
    expect(events.map((e) => `${e.service_name}:${e.event_name}`).sort()).toEqual(['host:fork.done', 'host:telemetry.dropped', 'runner:intro.posted', 'runner:render.started']);
    expect(c.posts.flatMap((p) => p.body.turns)).toMatchObject([{ host_version: 'h1' }]); // the runner leaves it to the host
    expect(c.posts.map((p) => p.body.batch_seq)).toEqual(c.posts.map((_, i) => i + 1));
    expect(h.spooledBytes).toBe(0);
  });

  it('keeps a renewed credential across restarts, readable only by the host user', async () => {
    const c = await collector();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'host-tm-'));
    const opts = { dataDir, url: c.url, credential: 'cred-env', version: 'h1', region: 'r', base: {}, intervalMs: 3_600_000 };
    const h = startHostTelemetry(opts);
    h.renew('cred-renewed');
    const file = path.join(dataDir, 'state', 'telemetry', 'credential');
    expect(readFileSync(file, 'utf8').trim()).toBe('cred-renewed');
    expect(statSync(file).mode & 0o077).toBe(0);
    await h.close(10);
    const again = startHostTelemetry(opts);
    again.t.emit('fork.done', { session_key: 'k' });
    await again.close(2000);
    c.close();
    expect(c.posts.at(-1)?.auth).toBe('Bearer cred-renewed');
  });

  it("starts sending with the collector URL a welcome brings when host.env has none", async () => {
    const c = await collector();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'host-tm-'));
    const h = startHostTelemetry({ dataDir, version: 'h1', region: 'r', base: {}, intervalMs: 3_600_000 });
    h.renew('cred-welcome', c.url);
    h.t.emit('fork.done', { session_key: 'k' });
    await h.close(2000);
    c.close();
    expect(c.posts.at(-1)?.auth).toBe('Bearer cred-welcome');
    expect(c.posts.flatMap((p) => p.body.events).map((e) => e.event_name)).toContain('fork.done');
  });

  it('with no collector URL, validates and discards: no spool on disk', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'host-tm-'));
    const h = startHostTelemetry({ dataDir, version: 'h1', region: 'r', base: {} });
    h.relay(await runnerBatch());
    h.relay('garbage');
    h.t.emit('fork.done', { session_key: 'k' });
    await h.close(10);
    expect(h.dropped).toBe(1);
    expect(existsSync(path.join(dataDir, 'state', 'telemetry', 'spool'))).toBe(false);
  });

  it('reports workspace timings as valid events', async () => {
    const sent: Batch[] = [];
    const t = createTelemetry({ service: 'host', version: 'v', region: 'r', send: (b) => void sent.push(b) });
    const w = workspaceTelemetry(t, () => ({ trace_id: uuidv7(), session_key: 'T1:C1:1.2' }));
    w.repoForked?.({ repo: 'calvin', ms: 900, fetchMs: 700, worktreeMs: 150, lockWaitMs: 50, fetchSkipped: false });
    w.repoForked?.({ repo: 'calvin', ms: 5000, fetchMs: 5000, worktreeMs: 0, lockWaitMs: 0, fetchSkipped: false, fetchError: 'timeout' });
    w.repoForked?.({ repo: 'calvin', ms: 40, fetchMs: 0, worktreeMs: 40, lockWaitMs: 0, fetchSkipped: true });
    w.repoFetched?.({ repo: 'calvin', ms: 300, fastForwarded: true, trigger: 'periodic' });
    w.repoFetched?.({ repo: 'calvin', ms: 300, fastForwarded: false, trigger: 'pushed', fetchError: 'git_fetch' });
    await t.flush();
    expect(t.dropped).toEqual({});
    expect(sent[0].events.map((e) => [e.event_name, e.outcome, e.error_type, e.data.fetch_error_type, e.data.fetch_skipped ?? e.data.trigger])).toEqual([
      ['fork.repo', 'completed', undefined, undefined, false],
      ['fork.repo', 'completed', undefined, 'timeout', false],
      ['fork.repo', 'completed', undefined, undefined, true],
      ['housekeeping.fetch', 'completed', undefined, undefined, 'periodic'],
      ['housekeeping.fetch', 'failed', 'git_fetch', undefined, 'pushed'],
    ]);
  });
});
