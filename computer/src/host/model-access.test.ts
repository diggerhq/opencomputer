// The host's model access (design C3, C4, C6) against the real model proxy:
// computer/modelproxy built into a temp directory and run on test profiles
// whose upstream nothing listens on. What the proxy holds is read from the
// hello a second binder gets, which also replaces the host's connection, so
// every peek exercises a re-hello. The relays of observed and event frames
// use the proxy's golden frames. Skipped when there is no Go toolchain.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GatewayToHost, HarnessName, HostCredentials, HostToGateway, HostToRunner, ModelRoute } from '../protocol.js';
import type { Telemetry } from '../telemetry/emitter.js';
import { lines } from '../ipc.js';
import { spareKind } from '../model-key.js';
import { hostModelAccess, NO_MODEL_CREDENTIAL, noProfile, proxyRefused, SWITCHING, type HostModelAccessDeps } from './model-access.js';

const PROXY_SRC = path.resolve(import.meta.dirname, '../../modelproxy');
const GO = ['go', '/usr/local/go/bin/go'].find((g) => {
  try {
    return execFileSync(g, ['version'], { stdio: 'pipe' }) && true;
  } catch {
    return false;
  }
});

const claudeKey = { tokenEnv: 'ANTHROPIC_API_KEY' };
const profile = (harness: object) => ({ upstream: 'https://127.0.0.1:1', routes: { 'GET /v1/models': {} }, set: { 'X-Api-Key': '{token}' }, harness });
const PROFILES = {
  'claude-a': profile({ claude: claudeKey }),
  'claude-b': profile({ claude: claudeKey }),
  'claude-c': profile({ claude: { tokenEnv: 'ANTHROPIC_AUTH_TOKEN' } }),
  'codex-only': profile({ codex: {} }),
};
const route = (p: string, token = 'sk-test-1', key = `${p}-key`): ModelRoute => ({ mode: 'profile', profile: p, vars: { token }, key });
// A field no runner may get (protocol 4's Claude credential), as an older gateway would still send it.
const creds = { slackBotToken: 'xoxb', slackBotUserId: 'B', claudeOAuthToken: 'never-forwarded' } as HostCredentials;
const welcome = (models: Record<string, ModelRoute>) => ({ t: 'welcome', protocol: 5, credentials: creds, people: [], models }) as unknown as GatewayToHost;

let dir: string;
let bin: string;
let proxy: ChildProcess | undefined;
let cleanup: (() => unknown)[] = [];

async function startProxy() {
  const control = path.join(dir, 'control.sock');
  rmSync(control, { force: true });
  proxy = spawn(bin, ['-profiles', path.join(dir, 'profiles'), '-api-socket', path.join(dir, 'api.sock'), '-control-socket', control,
    '-bindings-file', '', '-hold-timeout', '1s', '-drain-timeout', '1s'], { stdio: 'ignore' });
  await vi.waitFor(() => expect(existsSync(control)).toBe(true), { timeout: 5000 });
}
async function stopProxy() {
  const p = proxy;
  proxy = undefined;
  if (!p || p.exitCode !== null) return;
  await new Promise((r) => (p.once('exit', r), p.kill('SIGKILL')));
}

/** Every host model access under test that is not stopped: how often it dialled, and whether it is up. */
const hosts = new Set<{ dials: number; up: () => boolean }>();

/**
 * What the proxy holds, from the hello a new binder gets. That replaces each live host's connection:
 * resolves once every one dialled again and is up (its re-sent binds are on their way).
 */
async function peek(): Promise<{ caller: string; sessionKey: string; mode: string; profile?: string; key?: string }[]> {
  const before = [...hosts].map((h) => [h, h.dials] as const);
  const bindings = await new Promise<{ caller: string; sessionKey: string; mode: string; profile?: string; key?: string }[]>((resolve, reject) => {
    const s = net.createConnection(path.join(dir, 'control.sock'));
    s.on('error', reject);
    lines(s, (m) => m.t === 'hello' && (s.destroy(), resolve(m.bindings)));
  });
  for (const [h, n] of before) if (hosts.has(h)) await vi.waitFor(() => expect(h.dials > n && h.up()).toBe(true), { timeout: 8000 });
  return bindings;
}

interface FakeRunner { id: string; sock: net.Socket; harness?: HarnessName; sent: HostToRunner[] }
function fakeRunner(id: string, harness?: HarnessName): FakeRunner {
  const sent: HostToRunner[] = [];
  const sock = new net.Socket();
  Object.assign(sock, { writable: true, write: (d: string) => (sent.push(JSON.parse(d)), true) });
  return { id, sock, harness, sent };
}

function setup(o: Partial<HostModelAccessDeps> = {}) {
  const runners = new Map<string, FakeRunner>();
  const out: HostToGateway[] = [];
  const emit = vi.fn();
  const deps = {
    controlSocket: path.join(dir, 'control.sock'),
    modelSocket: '/run/test/api.sock',
    toGateway: (m: HostToGateway) => out.push(m),
    runner: (key: string) => runners.get(key),
    creds: () => creds,
    exit: vi.fn(),
    unitExists: vi.fn(async () => true),
    rehello: vi.fn(),
    tm: { emit } as unknown as Telemetry,
    ...o,
  };
  const host = { dials: 0, up: () => a.up };
  const a = hostModelAccess({ ...deps, proxy: { connect: (p) => (host.dials++, net.createConnection(p)) } });
  hosts.add(host);
  const stop = a.stop;
  a.stop = () => (hosts.delete(host), stop());
  cleanup.push(() => a.stop());
  /** A runner `id` on `harness` serves `key` and is bound. */
  const register = async (key: string, id: string, harness: HarnessName = 'claude') => {
    const r = fakeRunner(id, harness);
    runners.set(key, r);
    a.registered(key, id, harness);
    await a.ready(key);
    return r;
  };
  const up = () => vi.waitFor(() => expect(a.up).toBe(true), { timeout: 8000 });
  return { a, deps, runners, out, emit, register, up };
}

const held = async (caller: string) => (await peek()).find((b) => b.caller === caller);

describe.skipIf(!GO)('host model access against the real model proxy', () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hma-'));
    bin = path.join(dir, 'oc-modelproxy');
    execFileSync(GO!, ['build', '-o', bin, '.'], { cwd: PROXY_SRC, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });
    mkdirSync(path.join(dir, 'profiles'));
    writeFileSync(path.join(dir, 'profiles', 'test.json'), JSON.stringify(PROFILES));
    await startProxy();
  }, 180_000);
  afterEach(async () => {
    for (const c of cleanup.reverse()) await c();
    cleanup = [];
    if (!proxy) await startProxy();
  });
  afterAll(async () => {
    await stopProxy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bind: a registered runner is bound to its session route, `model-bound` is relayed, and the runner gets C4 and no value', async () => {
    const t = setup();
    await t.up();
    t.a.onGateway(welcome({ claude: route('claude-a') }));
    await t.register('s1', 'r1');
    expect(t.out).toContainEqual({ t: 'model-bound', sessionKey: 's1', mode: 'profile', profile: 'claude-a', key: 'claude-a-key' });
    expect(await held('r1')).toEqual({ caller: 'r1', sessionKey: 's1', mode: 'profile', profile: 'claude-a', key: 'claude-a-key' });
    const c = t.a.forRunner('s1', creds)!;
    expect(c).toEqual({ slackBotToken: 'xoxb', slackBotUserId: 'B', model: { profile: 'claude-a', key: 'claude-a-key', harness: claudeKey,
      endpoint: { unixSocket: '/run/test/api.sock' }, placeholder: 'ssh-placeholder' } });
    expect(JSON.stringify(c)).not.toMatch(/sk-test|never-forwarded/);
    expect(t.a.profiles()?.map((p) => p.name)).toEqual(['claude-a', 'claude-b', 'claude-c']); // codex-only: no Codex binary
  });

  it('refuse: no route, an unknown profile, a profile without the harness, and a refuse route are bound as refusals, and the runner told why', async () => {
    const t = setup();
    await t.up();
    const none = await t.register('none', 'r-none');
    expect(t.out).toContainEqual({ t: 'model-bound', sessionKey: 'none', mode: 'refuse' });
    t.a.onGateway({ t: 'model', sessionKey: 'gone', model: route('no-such-profile') });
    await t.register('gone', 'r-gone');
    t.a.onGateway({ t: 'model', sessionKey: 'codex', model: route('claude-a') });
    await t.register('codex', 'r-codex', 'codex');
    t.a.onGateway({ t: 'model', sessionKey: 'paused', model: { mode: 'refuse', reason: 'paused' } });
    await t.register('paused', 'r-paused');
    const b = await peek();
    for (const caller of ['r-none', 'r-gone', 'r-codex', 'r-paused']) expect(b.find((x) => x.caller === caller)?.mode).toBe('refuse');
    expect(t.a.forRunner('none', creds)).toEqual({ slackBotToken: 'xoxb', slackBotUserId: 'B', model: { refused: NO_MODEL_CREDENTIAL } });
    expect(none.sent.at(-1)).toEqual({ t: 'credentials', credentials: { slackBotToken: 'xoxb', slackBotUserId: 'B', model: { refused: NO_MODEL_CREDENTIAL } } });
    expect(t.a.forRunner('gone', creds)?.model).toEqual({ refused: noProfile('no-such-profile') });
    expect(t.a.forRunner('codex', creds)?.model).toEqual({ refused: SWITCHING });
    expect(t.a.forRunner('paused', creds)?.model).toEqual({ refused: 'paused' });
    expect(t.deps.exit).not.toHaveBeenCalled();
    expect(NO_MODEL_CREDENTIAL).toBe('No model credential is configured for this computer.');
  });

  it('a bind the proxy refuses is bound again as a refusal and reported as model.profile_refused', async () => {
    const t = setup();
    await t.up();
    t.a.onGateway({ t: 'model', sessionKey: 's2', model: { mode: 'profile', profile: 'claude-a', vars: {}, key: 'k' } }); // missing_var
    const r = await t.register('s2', 'r2');
    await vi.waitFor(async () => expect((await held('r2'))?.mode).toBe('refuse'), { timeout: 8000 });
    await vi.waitFor(() => expect(r.sent.at(-1)).toMatchObject({ t: 'credentials', credentials: { model: { refused: proxyRefused('missing_var') } } }));
    expect(t.emit).toHaveBeenCalledWith('model.profile_refused', expect.objectContaining({ session_key: 's2', provider: 'claude-a', data: { caller: 'r2', code: 'missing_var' } }));
  });

  it('rebind: an equal harness object rebinds in place and pushes C4; another exits the runner; a refusal only rebinds', async () => {
    const t = setup();
    await t.up();
    t.a.onGateway(welcome({ claude: route('claude-a') }));
    const r = await t.register('s3', 'r3');
    await t.a.delivered('s3', creds, undefined, 'claude');
    t.a.onGateway({ t: 'model', sessionKey: 's3', model: route('claude-b', 'sk-test-2') });
    await t.a.ready('s3');
    expect(await held('r3')).toMatchObject({ sessionKey: 's3', profile: 'claude-b', key: 'claude-b-key' });
    expect(r.sent.at(-1)).toMatchObject({ t: 'credentials', credentials: { model: { profile: 'claude-b' } } });
    expect(t.deps.exit).not.toHaveBeenCalled();

    // The same route again changes nothing. (held() reconnects, and the host binds again: wait for that first.)
    await t.a.ready('s3');
    const n = r.sent.length;
    await t.a.delivered('s3', creds, route('claude-b', 'sk-test-2'), 'claude');
    expect(r.sent.length).toBe(n);

    await t.up();
    t.a.onGateway({ t: 'model', sessionKey: 's3', model: route('claude-c') });
    await t.a.ready('s3');
    expect(t.deps.exit).toHaveBeenCalledWith('s3');
    expect(await held('r3')).toMatchObject({ profile: 'claude-c' });

    await t.up();
    t.a.onGateway({ t: 'model', sessionKey: 's3', model: { mode: 'refuse', reason: 'limit' } });
    await t.a.ready('s3');
    expect(t.deps.exit).toHaveBeenCalledTimes(1);
    expect((await held('r3'))?.mode).toBe('refuse');
  });

  it('a `credentials` frame replaces `models` and rebinds the sessions that run on it, not those with their own route', async () => {
    const t = setup();
    await t.up();
    t.a.onGateway(welcome({ claude: route('claude-a') }));
    await t.register('on-models', 'r-m');
    t.a.onGateway({ t: 'model', sessionKey: 'own', model: route('claude-a', 'sk-own', 'own-key') });
    await t.register('own', 'r-o');
    t.a.onGateway({ t: 'credentials', credentials: creds, models: { claude: route('claude-b') } });
    await t.a.ready('on-models');
    const b = await peek();
    expect(b.find((x) => x.caller === 'r-m')).toMatchObject({ profile: 'claude-b' });
    expect(b.find((x) => x.caller === 'r-o')).toMatchObject({ profile: 'claude-a', key: 'own-key' });
  });

  it('release: a closed runner is released; on hello, a listed caller whose unit is gone is released and a live one kept', async () => {
    const t = setup({ unitExists: vi.fn(async (c: string) => c !== 'ghost') });
    await t.up();
    await t.register('s4', 'r4');
    await t.register('ghost-session', 'ghost');
    t.runners.delete('ghost-session');
    t.a.stop(); // the host goes: its bindings stay with the proxy
    await vi.waitFor(async () => expect((await peek()).map((b) => b.caller)).toEqual(expect.arrayContaining(['r4', 'ghost'])));

    const u = setup({ unitExists: vi.fn(async (c: string) => c !== 'ghost') });
    await u.up();
    u.a.registered('s4', 'r4', 'claude', true); // found again: not bound until its route arrives
    const callers = async () => (await peek()).map((b) => b.caller);
    await vi.waitFor(async () => expect(await callers()).not.toContain('ghost'), { timeout: 8000 });
    expect(await callers()).toContain('r4');
    await u.up();
    u.a.closed('s4', 'r4');
    await vi.waitFor(async () => expect(await callers()).not.toContain('r4'), { timeout: 8000 });
  }, 30_000);

  it('a runner found after a restart keeps its binding until a delivery brings its route', async () => {
    const t = setup();
    await t.up();
    await t.register('s5', 'r5');
    t.a.stop();
    const u = setup();
    await u.up();
    u.a.onGateway(welcome({ claude: route('claude-a') }));
    u.runners.set('s5', fakeRunner('r5'));
    u.a.registered('s5', 'r5', 'claude', true);
    expect(u.a.forRunner('s5', creds)?.model).toBeUndefined();
    expect((await held('r5'))?.mode).toBe('refuse'); // the old binding, untouched by `models`
    await u.up();
    const c = await u.a.delivered('s5', creds, route('claude-b'), 'claude');
    expect(c?.model).toMatchObject({ profile: 'claude-b' });
    expect(await held('r5')).toMatchObject({ profile: 'claude-b' });
  });

  it('re-hello: a proxy that restarts empty gets every held bind again; while down the host advertises no profiles', async () => {
    const t = setup();
    await t.up();
    t.a.onGateway(welcome({ claude: route('claude-a') }));
    await t.register('s6', 'r6');
    expect(t.deps.rehello).toHaveBeenCalledTimes(1);
    await stopProxy();
    await vi.waitFor(() => expect(t.a.up).toBe(false));
    expect(t.a.profiles()).toBeUndefined();
    expect(t.deps.rehello).toHaveBeenCalledTimes(2);
    expect(t.a.canSpare()).toBe(false);
    expect(t.a.downS()).toBeGreaterThanOrEqual(0);
    t.a.onGateway({ t: 'model-request', id: 'q1', profile: 'claude-a', vars: { token: 'x' }, method: 'GET', path: '/v1/models' });
    await vi.waitFor(() => expect(t.out).toContainEqual({ t: 'model-response', id: 'q1', error: 'proxy_unavailable' }));
    await startProxy();
    await t.up();
    expect(t.deps.rehello).toHaveBeenCalledTimes(3);
    await vi.waitFor(async () => expect(await held('r6')).toMatchObject({ sessionKey: 's6', profile: 'claude-a' }), { timeout: 8000 });
  }, 30_000);

  it('proxy down from the start: no SP_MODEL_PROXY, or nothing listening', async () => {
    for (const controlSocket of [undefined, path.join(dir, 'nothing.sock')]) {
      const t = setup({ controlSocket });
      expect(t.a.up).toBe(false);
      expect(t.a.profiles()).toBeUndefined();
      await expect(t.a.spare('x')).rejects.toThrow();
    }
  });

  it('model-request: relayed to the proxy, and its response back', async () => {
    const t = setup();
    await t.up();
    t.a.onGateway({ t: 'model-request', id: 'q2', profile: 'claude-a', vars: { token: 'x' }, method: 'GET', path: '/v1/models' });
    t.a.onGateway({ t: 'model-request', id: 'q3', profile: 'claude-a', vars: { token: 'x' }, method: 'GET', path: '/elsewhere' });
    await vi.waitFor(() => expect(t.out).toContainEqual({ t: 'model-response', id: 'q2', error: 'unreachable' }), { timeout: 15_000 });
    expect(t.out).toContainEqual({ t: 'model-response', id: 'q3', error: 'unknown_route' });
  }, 20_000);

  it('spares: bound as spare/<id> to models.claude, matched by kind, released and bound to the session when claimed', async () => {
    // No spare unit exists: a release lost with a replaced connection is made good on the next hello.
    const t = setup({ unitExists: vi.fn(async () => false) });
    await t.up();
    expect(t.a.canSpare()).toBe(false); // no models.claude yet
    t.a.onGateway(welcome({ claude: route('claude-a') }));
    expect(t.a.canSpare()).toBe(true);
    await t.a.spare('sp1');
    expect(await held('sp1')).toEqual({ caller: 'sp1', sessionKey: 'spare/sp1', mode: 'profile', profile: 'claude-a', key: 'claude-a-key' });
    expect(t.out.filter((m) => m.t === 'model-bound')).toEqual([]); // a spare is no session
    expect(t.a.forRunner('', creds)?.model).toMatchObject({ harness: claudeKey });
    expect(t.a.kind('s7', 'claude')).toBe(spareKind('claude', claudeKey));
    t.a.onGateway({ t: 'model', sessionKey: 's8', model: route('claude-c') });
    expect(t.a.kind('s8', 'claude')).not.toBe(t.a.kind('s7', 'claude'));
    await t.up();
    await t.a.claim('sp1', 's7', 'claude');
    expect(await held('sp1')).toMatchObject({ sessionKey: 's7', profile: 'claude-a' });

    await t.up();
    t.a.onGateway(welcome({ claude: { mode: 'profile', profile: 'claude-a', vars: {}, key: 'k' } }));
    await expect(t.a.spare('sp2')).rejects.toThrow(/did not bind/);
    await vi.waitFor(async () => expect(await held('sp2')).toBeUndefined(), { timeout: 8000 });
  });

  it('a profile only for Codex is advertised only when the Codex binary exists', async () => {
    const t = setup({ codexBin: path.join(dir, 'profiles', 'test.json') });
    await t.up();
    expect(t.a.profiles()?.map((p) => p.name)).toContain('codex-only');
  });
});

describe('host model access relays (golden frames)', () => {
  const GOLDEN = path.resolve(import.meta.dirname, '../../modelproxy/testdata/control');
  const golden = (name: string) => readFileSync(path.join(GOLDEN, `${name}.json`), 'utf8');

  it('observed → model-observed without the caller (never for a spare), event → telemetry with the profile as provider', async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'hmr-'));
    const control = path.join(d, 'control.sock');
    let conn: net.Socket | undefined;
    const server = net.createServer((c) => ((conn = c), c.write(golden('hello'))));
    await new Promise<void>((r) => server.listen(control, r));
    const out: HostToGateway[] = [];
    const emit = vi.fn();
    const a = hostModelAccess({ controlSocket: control, toGateway: (m) => out.push(m), runner: () => undefined, creds: () => undefined, exit: () => {},
      unitExists: async () => true, rehello: () => {}, tm: { emit } as unknown as Telemetry });
    await vi.waitFor(() => expect(a.up).toBe(true));
    conn!.write(golden('observed') + golden('observed-error') + golden('event-request') + golden('event-binding'));
    conn!.write(`${JSON.stringify({ ...JSON.parse(golden('observed')), sessionKey: 'spare/x' })}\n`);
    conn!.write(`${JSON.stringify({ t: 'event', name: 'not.an.event', at: 1 })}\n`);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    const { t: _, caller: _c, ...observed } = JSON.parse(golden('observed'));
    expect(out).toEqual([{ t: 'model-observed', ...observed }, expect.objectContaining({ t: 'model-observed', error: 'connect' })]);
    const e = JSON.parse(golden('event-request'));
    expect(emit).toHaveBeenCalledWith('model.request', { session_key: e.session_key, duration_ms: e.duration_ms, outcome: 'completed', provider: 'openai-key', data: e.data }, e.at);
    a.stop();
    conn?.destroy();
    await new Promise((r) => server.close(r));
    rmSync(d, { recursive: true, force: true });
  });
});
