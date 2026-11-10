import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/socket.js';
import { type CallOutcome, RECORD_METHOD, type SubscribeOptions } from '../api/writer.js';
import type { ApiActor, GatewayToHost, HostToGateway, JournalEvent, SessionSpec } from '../protocol.js';
import { apiHost, type ApiHostDeps, type StartOptions, type WireHooks, type WireLinkLike } from './api-host.js';
import { subagentsRunning } from './runner-api.js';

const S = 'cs_0000000000000001';
const actor: ApiActor = { id: 'usr_1', name: 'Ada', via: 'api', client: null };
const owner = { userId: 'usr_1', name: 'Ada', email: 'ada@example.com', dir: 'user-usr_1', gitName: 'Ada', gitEmail: 'ada@example.com' };
const spec: SessionSpec = { key: S, kind: 'api', sessionId: S, owner, title: 'hi', mode: 'default' } as SessionSpec;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const welcome = (protocol: number, extra: object = {}) =>
  ({ t: 'welcome', protocol, credentials: {}, people: [{ ...owner, admin: true }], ...extra }) as unknown as GatewayToHost;

/** A writer with its journal in memory (the host's session-writer, or a runner's behind a fake socket). */
function memWriter(name: string, from = 0) {
  const journal: JournalEvent[] = [];
  const subs = new Set<SubscribeOptions>();
  const calls: string[] = [];
  let handedOff = false;
  const append = (type: string) => {
    const e: JournalEvent = { id: `ev_${name}${journal.length}`, seq: from + journal.length + 1, createdAt: '', sessionId: S, turnId: null, type, actor: null, data: {} };
    journal.push(e);
    for (const s of subs) s.onEvent(e);
    return e;
  };
  return {
    journal, subs, calls, append,
    get handedOff() {
      return handedOff;
    },
    sessionId: S,
    async call(method: string): Promise<CallOutcome> {
      calls.push(method);
      if (method === 'turns.send') return { result: { delivery: 'queued', seq: append('turn.queued').seq } };
      if (method === RECORD_METHOD) return { result: { seq: append(method).seq } };
      return { result: { by: name } };
    },
    subscribe(o: SubscribeOptions) {
      for (const e of journal) if (e.seq > (o.after ?? 0)) o.onEvent(e);
      subs.add(o);
      return { attached: { session: {}, after: o.after ?? 0, lastSeq: from + journal.length, epoch: 1 }, ack() {}, close: () => subs.delete(o) };
    },
    failed: [] as string[],
    failQueued(message: string) {
      this.failed.push(message);
    },
    async handOff() {
      handedOff = true;
      for (const s of [...subs]) {
        subs.delete(s);
        s.onDetached('moved');
      }
    },
  };
}

/** A dial that reaches `w` as a socket client would. */
const dialTo = (w: ReturnType<typeof memWriter>, dialled: string[]) => async (p: string, token: string): Promise<ApiClient> => {
  dialled.push(`${path.basename(p)} ${token.length}`);
  let h: SubscribeOptions | undefined;
  return {
    call: (m) => w.call(m),
    subscribe: async (o) => {
      h = o;
      return { attached: w.subscribe(o).attached };
    },
    ack() {},
    close: () => void (h && w.subs.delete(h)),
    closed: new Promise(() => {}),
  };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: Partial<ApiHostDeps> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'apihost-'));
  dirs.push(root);
  const sent: HostToGateway[] = [];
  const started: { spec: SessionSpec; o: StartOptions }[] = [];
  const host = memWriter('host');
  const runner = memWriter('runner');
  const opened: unknown[] = [];
  const dialled: string[] = [];
  const wireCalls: string[] = [];
  const wire: WireLinkLike = {
    setKey: (k) => wireCalls.push(`key ${k}`),
    setAccess: (a) => wireCalls.push(`access ${a.sessionId}`),
    setAdmins: (a) => wireCalls.push(`admins ${a.join(',')}`),
    revoked: (k) => wireCalls.push(`revoked ${k}`),
    moved: (s) => wireCalls.push(`moved ${s}`),
    close: async () => {},
  };
  const a = apiHost({
    dataDir: path.join(root, 'data'), stateDir: path.join(root, 'state'), runDir: path.join(root, 'run'), runnersDir: path.join(root, 'runners'),
    send: (m) => (sent.push(m), true),
    start: async (s, so) => (started.push({ spec: s, o: so }), 'idle'),
    openHostWriter: async (ho) => (opened.push(ho), host),
    dial: dialTo(runner, dialled),
    wire: async () => wire,
    scan: async () => [],
    flushMs: 1,
    ...o,
  });
  return { root, a, sent, started, host, runner, opened, dialled, wireCalls };
}

const api = (id: string, method: string, extra: object = {}) =>
  ({ t: 'api', id, sessionId: S, method, params: {}, actor, member: 'usr_1', ...extra }) as GatewayToHost;
const results = (sent: HostToGateway[]) => sent.flatMap((m) => (m.t === 'api-result' ? [m] : []));

describe('apiHost', () => {
  it('with a v3 gateway does nothing: frames go on to main, no RunnerApi, nothing sent, no file or socket made', async () => {
    const t = setup();
    expect(t.a.onGateway(welcome(3))).toBe(false);
    expect(t.a.onGateway({ t: 'deliver', id: 'd1', session: spec, msg: { userId: 'U1', text: 'hi', ts: '1' } })).toBe(false);
    expect(t.a.onGateway({ t: 'people', people: [] })).toBe(false);
    expect(await t.a.mint(spec, 'aaaa')).toBeUndefined();
    await t.a.boot();
    t.a.up('aaaa');
    t.a.down('aaaa');
    await tick(5);
    expect(t.sent).toEqual([]);
    expect(t.opened).toEqual([]);
    expect(t.wireCalls).toEqual([]);
    expect(readdirSync(t.root)).toEqual([]);
    await t.a.stop();
  });

  it('answers `start` with `started` and the runner status, or the error', async () => {
    const t = setup();
    t.a.onGateway(welcome(4));
    expect(t.a.onGateway({ t: 'start', id: 's1', session: spec, epoch: 1, lastSeq: 0, secrets: [] })).toBe(true);
    await tick();
    expect(t.started[0].spec).toBe(spec);
    expect(t.sent).toContainEqual({ t: 'started', id: 's1', sessionId: S, status: 'idle' });
    const f = setup({ start: async () => Promise.reject(new Error('no fork')) });
    f.a.onGateway(welcome(4));
    f.a.onGateway({ t: 'start', id: 's2', session: spec, epoch: 1, lastSeq: 0 });
    await tick();
    expect(f.sent).toMatchObject([{ t: 'started', id: 's2', status: 'suspended', error: { code: 'internal', message: 'no fork' } }]);
    await t.a.stop();
    await f.a.stop();
  });

  it("a push right after a create without a message waits for the session's fork (the `start` being served)", async () => {
    let forked: string | undefined;
    let forkDone = () => {};
    const fork = new Promise<void>((r) => (forkDone = r));
    const t = setup({ start: async () => (await fork, (forked = '/forks/s1'), 'idle'), forkPath: () => forked });
    t.a.onGateway(welcome(4));
    t.a.onGateway({ t: 'start', id: 's1', session: spec, epoch: 1, lastSeq: 0 });
    let ws: unknown = 'pending';
    void Promise.resolve(t.a.hooks.workspace(S)).then((w) => (ws = w));
    await tick(5);
    expect(ws).toBe('pending');
    forkDone();
    await tick(5);
    expect(ws).toEqual({ forkPath: '/forks/s1', owner: 'usr_1' });
    expect(await t.a.hooks.workspace('cs_unknown0000000')).toBeUndefined();
    await t.a.stop();
  });

  it('serves a session with no runner from the host writer, hands it off to a runner it mints for, then serves from the runner', async () => {
    const t = setup();
    t.a.onGateway(welcome(4, { wire: { key: 'k' } }));
    t.a.onGateway(api('a1', 'turns.send', { session: spec, epoch: 3, lastSeq: 7 }));
    await tick(5);
    expect(t.opened).toMatchObject([{ sessionId: S, epoch: 3, lastSeq: 7, seed: { owner: { id: 'usr_1' } } }]);
    expect(results(t.sent)).toEqual([{ t: 'api-result', id: 'a1', result: { delivery: 'queued', seq: 1 } }]);
    const ra = await t.a.mint(spec, 'beef');
    expect(t.host.handedOff).toBe(true);
    expect(ra).toMatchObject({ sessionId: S, epoch: 3, lastSeq: 7, socket: path.join(t.root, 'runners', 'beef.api.sock') });
    expect(ra?.token).toHaveLength(43);
    expect(ra?.journal).toBe(path.join(t.root, 'data', 'journals', `${S}.jsonl`));
    // A call while the runner starts waits for it, then goes to it.
    t.a.onGateway(api('a2', 'sessions.get'));
    await tick(5);
    expect(results(t.sent)).toHaveLength(1);
    t.a.up('beef');
    await tick(5);
    expect(results(t.sent)[1]).toEqual({ t: 'api-result', id: 'a2', result: { by: 'runner' } });
    expect(t.dialled[0]).toBe('beef.api.sock 43');
    expect(await t.a.hooks.where(S)).toMatchObject({ writer: 'runner', token: ra?.token, epoch: 3 });
    expect(t.wireCalls).toEqual(expect.arrayContaining(['key k', 'admins usr_1', `moved ${S}`]));
    await t.a.stop();
  });

  it('journals the relay\'s terminal and upload events through the session\'s writer, with their actor', async () => {
    const t = setup();
    t.a.onGateway(welcome(4));
    t.a.onGateway(api('a1', 'sessions.get', { session: spec, epoch: 1, lastSeq: 0 }));
    await tick(5);
    expect(await t.a.hooks.record(S, 'terminal.opened', { terminalId: 'tm_1', command: null }, actor)).toBe(1);
    expect(t.host.calls).toContain(RECORD_METHOD);
    expect(await t.a.hooks.record('cs_0000000000000009', 'files.pushed', {}, actor)).toBeUndefined();
    await t.a.stop();
  });

  it('wakes the runner for a send the host writer recorded, as an API delivery', async () => {
    const t = setup();
    t.a.onGateway(welcome(4));
    t.a.onGateway(api('a1', 'sessions.get', { session: spec, epoch: 1, lastSeq: 0 }));
    await tick(5);
    const o = t.opened[0] as { wake(s: string, d?: unknown): void };
    o.wake(S, { actor, member: 'usr_1', ifBusy: 'queue', turnId: 'tn_1' });
    await tick();
    expect(t.started[0].o.msg).toEqual({ userId: 'usr_1', text: '', ts: '', api: { actor, member: 'usr_1', ifBusy: 'queue', turnId: 'tn_1' } });
    await t.a.stop();
  });

  it('wakes a session the host has no spec of through the gateway, and fails its queued turns when no runner comes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let hooks: WireHooks | undefined;
      const t = setup({ wire: async (h) => ((hooks = h), { setKey() {}, setAccess() {}, setAdmins() {}, revoked() {}, moved() {}, close: async () => {} }) });
      // A session that ran before this host booted: its journal is on disk, its spec is not in memory.
      mkdirSync(path.join(t.root, 'data', 'journals'), { recursive: true });
      writeFileSync(path.join(t.root, 'data', 'journals', `${S}.jsonl`), '');
      t.a.onGateway(welcome(4, { wire: { key: 'k' } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await hooks!.where(S)).toMatchObject({ writer: 'host' });
      const o = t.opened[0] as { wake(s: string, d?: unknown): void };
      o.wake(S, { actor, member: 'usr_1', ifBusy: 'queue', turnId: 'tn_1' });
      o.wake(S, { actor, member: 'usr_1', ifBusy: 'queue', turnId: 'tn_2' });
      expect(t.sent.filter((m) => m.t === 'wake')).toEqual([{ t: 'wake', sessionId: S }]);
      expect(t.started).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.host.failed).toEqual(['The agent did not start']);

      // Answered: the gateway's `start` brings the runner, and nothing fails.
      o.wake(S);
      t.a.onGateway({ t: 'start', id: 's1', session: spec, epoch: 1, lastSeq: 0, secrets: [] });
      await t.a.mint(spec, 'aaaa');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.started.map((x) => x.spec)).toEqual([spec]);
      expect(t.host.failed.length).toBe(1);
      await t.a.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mirrors the runner, then the host writer once it exits; forwards access and revocations to the relay', async () => {
    const t = setup();
    t.a.onGateway(welcome(4, { wire: { key: 'k' } }));
    t.a.onGateway({ t: 'deliver', id: 'd1', session: spec, msg: { userId: 'U1', text: 'hi', ts: '1' }, epoch: 1, lastSeq: 0 });
    await t.a.mint(spec, 'beef');
    t.a.up('beef');
    await tick(5);
    t.runner.append('turn.completed');
    expect(t.sent.filter((m) => m.t === 'journal')).toMatchObject([{ sessionId: S, epoch: 1, events: [{ seq: 1 }] }]);
    t.a.down('beef');
    expect(t.runner.subs.size).toBe(0);
    t.a.onGateway({ t: 'access', access: { sessionId: S, owner: 'usr_1', members: null } });
    t.a.onGateway({ t: 'revoked', keyId: 'key_1' });
    expect(t.wireCalls).toEqual(expect.arrayContaining([`access ${S}`, 'revoked key_1']));
    expect(await t.a.hooks.where(S)).toMatchObject({ writer: 'host', socket: path.join(t.root, 'runners', `${S}.api.sock`) });
    await t.a.stop();
  });

  it('keys the relay from a later `previews` frame when the welcome carried no wire key, and a keyless welcome keeps it', async () => {
    const t = setup();
    expect(t.a.onGateway(welcome(4))).toBe(false); // the organization's tunnel did not exist yet
    await tick();
    expect(t.wireCalls).toContain('key null');
    const previews = (key: string) => ({ t: 'previews', preview: { tunnelToken: 't', key, ports: [] } }) as GatewayToHost;
    expect(t.a.onGateway(previews('k'))).toBe(false); // main still configures the tunnel
    expect(t.a.onGateway(previews('k'))).toBe(false);
    expect(t.wireCalls.filter((c) => c.startsWith('key '))).toEqual(['key null', 'key k']);
    t.a.onGateway(welcome(4, { definition: {} })); // a later welcome without `wire` keeps it
    expect(t.wireCalls.filter((c) => c.startsWith('key ')).at(-1)).toBe('key k');
    await t.a.stop();
  });

  it('at boot mirrors what the scan left in journals no writer holds, once the gateway speaks v4', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'apihost-'));
    dirs.push(root);
    const jdir = path.join(root, 'data', 'journals');
    mkdirSync(jdir, { recursive: true });
    const ev = (seq: number) => JSON.stringify({ id: `ev_${seq}`, seq, createdAt: '', sessionId: S, turnId: null, type: 'turn.failed', actor: null, data: {} });
    writeFileSync(path.join(jdir, `${S}.jsonl`), `${JSON.stringify({ k: 'epoch', sessionId: S, epoch: 2, startSeq: 1, at: 0 })}\n${ev(1)}\n${ev(2)}\n`);
    const t = setup({ dataDir: path.join(root, 'data'), scan: async () => [{ sessionId: S, file: '', epoch: 2, lastSeq: 2, closedTurns: ['tn_1'] }] });
    await t.a.boot();
    await tick(5);
    expect(t.sent).toEqual([]);
    t.a.onGateway(welcome(4));
    expect(t.sent.filter((m) => m.t === 'journal')).toMatchObject([{ sessionId: S, epoch: 2, events: [{ seq: 1 }, { seq: 2 }] }]);
    t.a.onGateway({ t: 'journal-ack', sessionId: S, epoch: 2, seq: 2 });
    expect(t.a.bridge.state(S)).toBeUndefined();
    expect(existsSync(path.join(root, 'data', 'journals'))).toBe(true);
    await t.a.stop();
  });
});

describe('subagentsRunning', () => {
  it('keeps a runner awake while its report counts running subagents; an older runner reports none', () => {
    const r = { key: S, status: 'idle' } as const;
    expect(subagentsRunning(undefined)).toBe(false);
    expect(subagentsRunning(r)).toBe(false);
    expect(subagentsRunning({ ...r, subagents: 0 } as typeof r)).toBe(false);
    expect(subagentsRunning({ ...r, subagents: 2 } as typeof r)).toBe(true);
  });
});
