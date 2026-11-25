import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { signWire } from '../signed-header.js';
import { startRelay, type Relay } from './relay.js';
import { accessFor, connectClient, fakeDial, fakeHost, sid, until } from './test-fakes.js';

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
  it('sends ready first, and no longer knows sessions.attach', async () => {
    const { port, sessions } = await setup();
    const c = connectClient(port, { query: `attach=${sessions[0]}` });
    await c.next((m) => m.method === 'ready');
    expect((await c.call('sessions.attach', { sessionId: sessions[0] })).error.code).toBe(-32601);
    expect(c.frames).toEqual([]);
    c.ws.close();
  });

  it('forwards a call to the session writer, and asks where again once it moved', async () => {
    const { port, host, sessions, writers } = await setup({ dial: { onCall: async () => ({ result: { turnId: 'tn_000000000000' } }) } });
    const c = connectClient(port);
    await c.next((m) => m.method === 'ready');
    expect((await c.call('turns.send', { sessionId: sessions[0], input: 'hi' })).result.turnId).toBe('tn_000000000000');
    await c.call('turns.send', { sessionId: sessions[0], input: 'again' });
    expect(writers.writers).toHaveLength(1);
    host.push({ t: 'moved', sessionId: sessions[0] });
    await until(() => writers.writers[0].closed);
    await c.call('turns.send', { sessionId: sessions[0], input: 'third' });
    expect(writers.writers).toHaveLength(2);
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
});
