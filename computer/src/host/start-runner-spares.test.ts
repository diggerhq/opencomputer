// Step 10 of work 103: how a new thread on a `podman` host takes a spare
// container, and what happens when it cannot (start-runner.ts).
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lines, send } from '../ipc.js';
import type { HostToRunner, RunnerToHost, SessionSpec } from '../protocol.js';
import { createTelemetry } from '../telemetry/emitter.js';
import type { TelemetryEvent } from '../telemetry/envelope.js';
import type { SandboxSpares } from './sandbox/spares.js';
import type { SandboxStarts, Started } from './sandbox/start.js';
import { type Runner, type StartDeps, runnerStarts } from './start-runner.js';

vi.mock('../workspaces/index.js', async (orig) => ({ ...(await orig<typeof import('../workspaces/index.js')>()), workspacesEnabled: () => true, workspacePrepared: () => true }));

const owner = { dir: 'pat', gitName: 'Pat', gitEmail: 'pat@example.com' };
const spec: SessionSpec = { key: 'C1:1.1', kind: 'thread', owner, title: 't', mode: 'default', sdkSessionId: 'old' };
const ID = 'aaaaaaaaaaaaaaaa';
const record = { id: ID, person: 'pat', key: 'C1:1.1', createdAt: '', usedAt: '', repos: {} };
const creds = { slackBotToken: 'x', slackBotUserId: 'U', anthropicApiKey: 'k' };
const open: (net.Socket | net.Server)[] = [];
afterEach(() => {
  for (const s of open.splice(0)) 'destroy' in s ? s.destroy() : s.close();
});

/** A connected pair: the host's end, and what the runner's end was sent; `answer` is the runner's reply to a call. */
async function pair(answer: (m: HostToRunner & { id?: string }) => RunnerToHost | undefined) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sp-')), 'r.sock');
  const got: HostToRunner[] = [];
  const server = net.createServer((s) => {
    open.push(s);
    lines(s, (m: HostToRunner) => {
      got.push(m);
      const a = answer(m);
      if (a) send(s, a);
      if (m.t === 'exit') s.end();
    });
  });
  await new Promise<void>((r) => server.listen(file, r));
  const sock = net.createConnection(file);
  await new Promise((r) => sock.once('connect', r));
  open.push(sock, server);
  return { sock, got };
}

async function rig(o: { known?: boolean; bind?: () => Promise<never>; answer?: Parameters<typeof pair>[0]; route?: string } = {}) {
  const log: string[] = [];
  const sent: TelemetryEvent[] = [];
  const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: (b) => void sent.push(...b.events) });
  const spare = await pair(o.answer ?? ((m) => (m.t === 'claim' ? { t: 'reply', id: m.id!, ok: true } : undefined)));
  const cold = await pair(() => undefined);
  const pool = new Set<Runner>();
  const spares = {
    launch: async () => ({ id: ID, run: `/run/sp/sandbox/${ID}`, sock: spare.sock, createMs: 1, startMs: 2 }),
    known: () => !!o.known,
    bind: async (id, s) => {
      log.push(`bind ${id} ${s.key}`);
      if (o.bind) return o.bind();
      const { sdkSessionId: _s, ...session } = s;
      return { record, run: `/run/sp/sandbox/${ID}`, session, api: undefined, readyMs: 2, mountMs: 3, addMs: 4 };
    },
    discard: async (id) => void log.push(`removed ${id}`),
    during: (fn) => fn(),
    turn: (_s, fn) => fn(),
  } as Partial<SandboxSpares> as SandboxSpares;
  const started: Started = { record, run: `/run/sp/sandbox/${ID}`, sock: cold.sock, session: spec, resumed: true, abandon: async () => void log.push('abandoned') };
  const sandbox: SandboxStarts = { start: async () => (log.push('cold start'), started) };
  const d = {
    tm, sandbox, spares, image: 'ghcr.io/x/y:64a672bb773b059c', launch: { mode: 'podman' }, run: '/run/sp',
    pool: {
      enabled: true,
      add: (r: Runner) => pool.add(r),
      changed: () => {},
      take: (fp: string | undefined) => {
        log.push(`take ${fp ? 'with a credential' : 'without'}`);
        const r = [...pool][0];
        return r ? (pool.delete(r), r) : 'none';
      },
    },
    serveTokens: (run: string, id: string) => (log.push(`tokens ${run} ${id}`), { close: () => void log.push('tokens closed') }),
    creds: () => undefined, forRunner: () => undefined, routeMode: () => o.route ?? 'managed',
    register: (r: Runner) => void log.push(`registered ${r.key}`), closed: () => {}, exit: (s: net.Socket) => (send(s, { t: 'exit' }), log.push('exit sent'), s.end()),
    message: (r: Runner, m: RunnerToHost) => (m.t === 'reply' ? r.calls.get(m.id)?.(m) : m.t === 'report' ? void (r.report = m.report) : undefined),
    stopSandbox: async (id: string) => void log.push(`stopped ${id}`),
    toGateway: (m: { t: string }) => void log.push(`gateway ${m.t}`), fillPool: () => void log.push('fill'),
  } as unknown as StartDeps;
  const starts = runnerStarts(d);
  await starts.launchSpare();
  const events = async () => (await tm.flush(), sent);
  return { log, starts, pool, spare, cold, events, tm };
}

describe('a new thread on a podman host with a spare', () => {
  it('the spare is adopted under its own run root, as nobody\'s', async () => {
    const t = await rig();
    expect(t.log).toEqual([`tokens /run/sp/sandbox/${ID} ${ID}`]);
    expect([...t.pool][0]).toMatchObject({ id: ID, key: '' });
    expect([...t.pool][0].sandbox).toBeUndefined();
    expect((await t.events()).find((e) => e.event_name === 'pool.spare_started')).toMatchObject({ data: { launch_mode: 'podman', image: '64a672bb773b', 'container.create_ms': 1, 'container.start_ms': 2 } });
    expect(t.tm.dropped).toEqual({});
  });

  it('takes it: bound first, then credentials and claim into /workspace with no transcript; the pool is filled after', async () => {
    const t = await rig();
    t.log.length = 0;
    const r = await t.starts.startRunner(spec, {}, creds);
    expect(r).toMatchObject({ id: ID, key: 'C1:1.1', sandbox: { record }, cold: { resumed: false, prewarmed: true } });
    expect(t.log).toEqual(['take with a credential', `bind ${ID} C1:1.1`, 'registered C1:1.1', 'fill']);
    const claim = t.spare.got.find((m) => m.t === 'claim') as Extract<HostToRunner, { t: 'claim' }>;
    expect(t.spare.got.map((m) => m.t)).toEqual(['credentials', 'claim']);
    expect(claim.session).toMatchObject({ key: 'C1:1.1', forkPath: '/workspace' });
    expect(claim.session).not.toHaveProperty('sdkSessionId');
    expect((await t.events()).find((e) => e.event_name === 'runner.claimed')).toMatchObject({ data: { launch_mode: 'podman', image: '64a672bb773b', 'container.mount_ms': 3, 'container.add_ms': 4 } });
    expect(t.tm.dropped).toEqual({});
  });

  it.each([
    ['could not be bound', { bind: () => Promise.reject(new Error('mount refused')) }, 'bind'],
    ['refused the claim', { answer: (m: HostToRunner & { id?: string }) => (m.t === 'claim' ? ({ t: 'reply', id: m.id!, ok: false, error: 'no' } as RunnerToHost) : undefined) }, 'refused'],
  ])('a spare that %s is told to exit and removed, and the delivery starts cold', async (_n, o, reason) => {
    const t = await rig(o);
    t.log.length = 0;
    const r = await t.starts.startRunner(spec, {}, creds);
    expect(r).toMatchObject({ id: ID, key: 'C1:1.1', sock: t.cold.sock });
    expect(t.log).toEqual(['take with a credential', `bind ${ID} C1:1.1`, 'exit sent', `removed ${ID}`, 'tokens closed', 'cold start', `tokens /run/sp/sandbox/${ID} ${ID}`, 'registered C1:1.1', 'fill']);
    await new Promise((x) => setTimeout(x, 20));
    expect(t.spare.got.at(-1)).toEqual({ t: 'exit' });
    expect((await t.events()).find((e) => e.event_name === 'pool.spare_missed')).toMatchObject({ data: { reason } });
    expect(t.tm.dropped).toEqual({});
  });

  it('a thread that has a record resumes: the pool is not asked', async () => {
    const t = await rig({ known: true });
    t.log.length = 0;
    await t.starts.startRunner(spec, {}, creds);
    expect(t.log).toEqual(['cold start', `tokens /run/sp/sandbox/${ID} ${ID}`, 'registered C1:1.1', 'fill']);
    expect(t.pool.size).toBe(1);
  });

  it('a session off the managed route starts cold', async () => {
    const t = await rig({ route: 'subscription' });
    t.log.length = 0;
    await t.starts.startRunner(spec, {}, creds);
    expect(t.log[0]).toBe('cold start');
  });

  it('a spare that reports a session while it is nobody\'s is stopped', async () => {
    const t = await rig();
    t.log.length = 0;
    t.spare.sock.emit('data', Buffer.from(`${JSON.stringify({ t: 'report', report: { key: 'C9:9.9', status: 'idle' } })}\n`));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.log[0]).toBe(`stopped ${ID}`); // not asked to go, which it could ignore
    expect(t.spare.sock.destroyed).toBe(true);
    expect([...t.pool][0]?.report).toBeUndefined();
  });

  it('a claimed spare that reports another thread than its record\'s is stopped', async () => {
    const t = await rig();
    const r = await t.starts.startRunner(spec, {}, creds);
    t.log.length = 0;
    r.sock.emit('data', Buffer.from(`${JSON.stringify({ t: 'report', report: { key: 'C9:9.9', status: 'idle' } })}\n`));
    await new Promise((x) => setTimeout(x, 20));
    expect(t.log[0]).toBe(`stopped ${ID}`);
    expect(r.sock.destroyed).toBe(true);
  });
});
