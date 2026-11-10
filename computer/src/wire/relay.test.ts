import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { signWire } from '../signed-header.js';
import { startRelay, urlAttaches, type Relay } from './relay.js';
import { accessFor, connectClient, event, type FakeWriter, type Frame, fakeDial, fakeHost, sid, until } from './test-fakes.js';

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
  cleanup = [];
});

async function setup(o: { sessions?: string[]; key?: string | null; dial?: Parameters<typeof fakeDial>[0]; access?: ReturnType<typeof accessFor>[] } = {}) {
  const sessions = o.sessions ?? [sid()];
  const host = await fakeHost({ key: o.key, access: o.access ?? sessions.map((s) => accessFor(s)) });
  const writers = fakeDial(o.dial);
  const relay: Relay = await startRelay({ host: '127.0.0.1', port: 0, socket: host.socket, version: 'test', region: 'test-1', dial: writers.dial, telemetryMs: 3_600_000 });
  cleanup.push(() => host.close(), () => relay.close());
  if (o.key !== null) await until(() => relay.hostLink.key !== null);
  else await until(() => relay.hostLink.connected);
  return { host, relay, writers, sessions, port: relay.port };
}

/** Ids and timings out, so a run's frames compare to the golden file. */
function normalize(frames: Frame[]) {
  return JSON.parse(
    JSON.stringify(frames)
      .replace(/"cs_[0-9a-z]{16}"/g, '"cs_S"')
      .replace(/"wc_[0-9a-z]{12}"/g, '"wc_C"')
      .replace(/"serverUs":\d+/g, '"serverUs":0'),
  );
}

/** The HTTP status an upgrade gets (101 when it is upgraded). */
const upgradeStatus = (port: number, headers: Record<string, string>) =>
  new Promise<number | undefined>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/connect', headers: { connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'opc.v1', ...headers } });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', (_res, sock) => {
      sock.destroy();
      resolve(101);
    });
    req.on('error', () => resolve(undefined));
    req.end();
  });

const filesStatus = (port: number, headers: Record<string, string>) =>
  new Promise<{ status: number | undefined; code?: string; retryAfter?: string }>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/files/${sid()}/files`, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, code: JSON.parse(body).error?.code, retryAfter: res.headers['retry-after'] as string | undefined }));
    });
    req.on('error', () => resolve({ status: undefined }));
    req.end();
  });

const claims = { member: 'usr_x', keyId: 'ak_000000000000', client: '', scope: {} };

describe('the upgrade', () => {
  it('refuses a request without a valid signature before upgrading (403)', async () => {
    const { port } = await setup();
    expect(await upgradeStatus(port, signWire('wrong-key', claims))).toBe(403);
  });

  it('refuses unsigned, malformed and expired upgrades with 401 before upgrading, key or no key', async () => {
    for (const key of [undefined, null]) {
      const { port } = await setup({ key });
      const signed = signWire('any-key', claims);
      expect(await upgradeStatus(port, {})).toBe(401);
      expect(await upgradeStatus(port, { ...signed, 'x-wire-auth': 'garbage' })).toBe(401);
      expect(await upgradeStatus(port, signWire('any-key', claims, Date.now() - 31_000))).toBe(401);
      expect(await upgradeStatus(port, signWire('any-key', claims, Date.now() + 120_000))).toBe(401);
    }
  });

  it('accepts then closes with 4503 a signed upgrade while the computer has no key', async () => {
    const { port } = await setup({ key: null });
    const c = connectClient(port);
    expect((await c.closed).code).toBe(4503);
  });

  it('refuses /files the same way: 401 unsigned, 503 with Retry-After signed without a key, 403 badly signed', async () => {
    const none = await setup({ key: null });
    expect(await filesStatus(none.port, {})).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await filesStatus(none.port, signWire('any-key', claims))).toMatchObject({ status: 503, code: 'computer_unavailable', retryAfter: '2' });
    const keyed = await setup();
    expect(await filesStatus(keyed.port, {})).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await filesStatus(keyed.port, signWire('wrong-key', claims))).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('closes with 4400 without the opc.v1 subprotocol', async () => {
    const { port } = await setup();
    const c = connectClient(port, { protocol: 'other.v9' });
    expect((await c.closed).code).toBe(4400);
  });

  it('closes the 51st connection of one member with 4029', async () => {
    const { port } = await setup();
    const open = [];
    for (let i = 0; i < 50; i++) {
      const c = connectClient(port);
      open.push(c);
      await c.next((m) => m.method === 'ready');
    }
    const extra = connectClient(port);
    expect((await extra.closed).code).toBe(4029);
    const other = connectClient(port, { member: 'usr_other' });
    await other.next((m) => m.method === 'ready');
    for (const c of open) c.ws.close();
    other.ws.close();
  }, 20_000);
});

describe('frames', () => {
  it('sends ready first, then sessions.attached before the session events (golden)', async () => {
    const onSubscribe = (w: FakeWriter) => {
      for (const s of [1, 2, 3]) w.h.onEvent(event(w.sessionId, s));
    };
    const { port, sessions } = await setup({ dial: { lastSeq: 2, onSubscribe } });
    const c = connectClient(port, { query: `attach=${sessions[0]}&after=1` });
    await c.next((m) => m.params?.seq === 3, 5000).then((m) => c.frames.push(m));
    expect(c.frames[0].method).toBe('ready');
    await expect(JSON.stringify(normalize(c.frames), null, 2)).toMatchFileSnapshot('./relay.frames.golden.json');
    c.ws.close();
  });

  it('answers URL attach errors as sessions.attached with error', async () => {
    const [a, b] = [sid(), sid()];
    const { port } = await setup({ sessions: [a, b] });
    const c = connectClient(port, { query: `attach=nope&attach=${b}`, scope: { sessionIds: [a] } });
    expect((await c.next((m) => m.params?.sessionId === 'nope')).params.error.code).toBe('invalid_request');
    expect((await c.next((m) => m.params?.sessionId === b)).params.error.code).toBe('session_not_found');
    c.ws.close();
  });

  it('refuses more than 20 attached sessions', async () => {
    const sessions = Array.from({ length: 21 }, sid);
    const { port } = await setup({ sessions });
    const c = connectClient(port, { query: sessions.map((s) => `attach=${s}`).join('&') });
    expect((await c.next((m) => m.params?.sessionId === sessions[20])).params.error.code).toBe('too_many_attached');
    await until(() => c.frames.filter((m) => m.method === 'sessions.attached' && !m.params.error).length === 20);
    c.ws.close();
  });

  it("puts a write's response before the events it caused", async () => {
    const { port, sessions } = await setup({
      dial: {
        onCall: async (w, method) => {
          if (method === 'turns.send') w.h.onEvent(event(w.sessionId, 1, 'turn.started'));
          await new Promise((r) => setTimeout(r, 30));
          return { result: { turnId: 'tn_000000000000' } };
        },
      },
    });
    const c = connectClient(port);
    await c.next((m) => m.method === 'ready');
    await c.call('sessions.attach', { sessionId: sessions[0] });
    const seen: Frame[] = [];
    c.ws.on('message', (d) => seen.push(JSON.parse(d.toString())));
    const r = await c.call('turns.send', { sessionId: sessions[0], input: 'hi' });
    expect(r.result.turnId).toBe('tn_000000000000');
    await c.next((m) => m.method === 'event');
    expect(seen.map((m) => m.method ?? 'response')).toEqual(['response', 'event']);
    c.ws.close();
  });
});

describe('limits and access', () => {
  it('closes with 1009 on a message over 1 MiB', async () => {
    const { port } = await setup();
    const c = connectClient(port);
    await c.next((m) => m.method === 'ready');
    c.ws.send('x'.repeat(1024 * 1024 + 1));
    expect((await c.closed).code).toBe(1009);
  });

  it('answers rate_limited past 100 requests a second', async () => {
    const { port } = await setup();
    const c = connectClient(port);
    await c.next((m) => m.method === 'ready');
    for (let i = 0; i < 150; i++) c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: `p${i}`, method: 'ping', params: {} }));
    const limited = await c.next((m) => m.error?.data?.code === 'rate_limited' || m.error?.code === 'rate_limited');
    expect(limited).toBeTruthy();
    c.ws.close();
  });

  it('checks scopes and read-only before any writer', async () => {
    const { port, sessions, writers } = await setup();
    const reader = connectClient(port, { scope: { scopes: ['sessions:read'] } });
    const r = await reader.call('sessions.suspend', { sessionId: sessions[0] });
    expect(JSON.stringify(r.error)).toContain('missing_scope');
    const ticket = connectClient(port, { scope: { sessionIds: [sessions[0]], readOnly: true } });
    const ro = await ticket.call('sessions.suspend', { sessionId: sessions[0] });
    expect(JSON.stringify(ro.error)).toContain('read_only');
    expect(writers.writers.flatMap((w) => w.calls)).toEqual([]);
    reader.ws.close();
    ticket.ws.close();
  });

  it('closes with 4001 when the key is revoked, and when the credential expires', async () => {
    const { port, host } = await setup();
    const c = connectClient(port, { keyId: 'ak_revoked00000' });
    await c.next((m) => m.method === 'ready');
    host.push({ t: 'revoked', keyId: 'ak_revoked00000' });
    expect((await c.closed).code).toBe(4001);
    const t = connectClient(port, { scope: { until: Date.now() + 300 } });
    expect((await t.next((m) => m.method === 'ready')).params.expiresInMs).toBeLessThanOrEqual(300);
    expect((await t.closed).code).toBe(4001);
  });

  it('detaches a session whose access is lost', async () => {
    const { port, host, sessions } = await setup();
    const c = connectClient(port, { query: `attach=${sessions[0]}` });
    await c.next((m) => m.method === 'sessions.attached');
    host.push({ t: 'access', access: accessFor(sessions[0], 'usr_someone', []) });
    expect((await c.next((m) => m.method === 'session.detached')).params.reason).toBe('access_lost');
    c.ws.close();
  });

  it('follows a moved writer and resumes after the last delivered seq', async () => {
    const { port, host, sessions, writers } = await setup({ dial: { onSubscribe: (w) => w.subscribed?.after === 0 && w.h.onEvent(event(w.sessionId, 1)) } });
    const c = connectClient(port, { query: `attach=${sessions[0]}&after=0` });
    await c.next((m) => m.params?.seq === 1);
    host.push({ t: 'moved', sessionId: sessions[0] });
    await until(() => writers.writers.filter((w) => w.subscribed).length === 2);
    expect(writers.writers[1].subscribed?.after).toBe(1);
    writers.writers[1].h.onEvent(event(sessions[0], 1));
    writers.writers[1].h.onEvent(event(sessions[0], 2));
    await c.next((m) => m.params?.seq === 2);
    expect(c.frames.filter((m) => m.method === 'event')).toEqual([]);
    c.ws.close();
  });
});

describe('an adoption under attached clients (review r2 P2-4, P2-7)', () => {
  it('a writer at a new epoch detaches with epoch_changed and the new logEpoch/epochStartSeq, before any resubscribe, wherever the cursor is', async () => {
    let epoch = 1;
    const { port, host, sessions, writers } = await setup({ dial: { onSubscribe: (w) => w.subscribed?.after === 0 && w.h.onEvent(event(w.sessionId, 1)) } });
    host.state.answer = (m) =>
      m.t === 'where' ? { result: { socket: `/fake/${m.sessionId}.api.sock`, token: 'tok', writer: 'host', epoch, ...(epoch > 1 && { epochStartSeq: 4 }) } } : undefined;
    const c = connectClient(port, { query: `attach=${sessions[0]}&after=0` });
    await c.next((m) => m.params?.seq === 1);
    // The outage: the runner's events went on locally (the client's cursor passes the DO's lastSeq), then the host adopts epoch 2.
    for (const s of [2, 3, 4, 5, 6, 7, 8, 9]) writers.writers[0].h.onEvent(event(sessions[0], s));
    await c.next((m) => m.params?.seq === 9);
    epoch = 2;
    host.push({ t: 'moved', sessionId: sessions[0] });
    const d = await c.next((m) => m.method === 'session.detached');
    expect(d.params).toEqual({ sessionId: sessions[0], reason: 'epoch_changed', logEpoch: 2, epochStartSeq: 4 });
    expect(writers.writers.filter((w) => w.subscribed)).toHaveLength(1);
    c.ws.close();
  });
});

describe('urlAttaches', () => {
  it('pairs after and tailTurns by position', () => {
    const q = new URLSearchParams('attach=a&after=5&tailTurns=&attach=b&after=&tailTurns=3&deltas=1');
    expect(urlAttaches(q)).toEqual([
      { sessionId: 'a', after: 5, tailTurns: undefined, deltas: true, resume: false },
      { sessionId: 'b', after: undefined, tailTurns: 3, deltas: true, resume: false },
    ]);
  });
});

