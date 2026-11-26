import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Hub, staticTokenMatch } from './hosts.js';
import { Store } from './db.js';

const digest = (t: string) => createHash('sha256').update(t).digest();

describe('staticTokenMatch', () => {
  const tokens = ['first-token', 'second-token'].map(digest);
  it('accepts any listed token, whatever its position', () => {
    expect(staticTokenMatch(tokens, 'first-token')).toBe(true);
    expect(staticTokenMatch(tokens, 'second-token')).toBe(true);
  });
  it('refuses prefixes, extensions, other tokens and an empty list', () => {
    for (const t of ['first', 'first-token-x', 'second-tokem', '']) expect(staticTokenMatch(tokens, t)).toBe(false);
    expect(staticTokenMatch([], 'first-token')).toBe(false);
  });
});

describe('/host upgrade', () => {
  let server: Server;
  let hub: Hub;
  afterEach(async () => {
    hub.closeAll();
    await new Promise((ok) => server.close(ok));
  });

  /** A gateway server whose HTTP handler answers 404 to everything (like setup mode) with the hub attached. */
  async function start(checkToken?: (t: string) => string | undefined) {
    hub = new Hub({
      store: new Store(':memory:'),
      tokens: ['static-host-token'],
      ...(checkToken ? { checkToken } : {}),
      credentials: () => ({ slackBotToken: '', slackBotUserId: '' }),
      models: () => ({}),
      mintToken: async () => ({ token: '', expiresAt: '' }),
    });
    server = createServer((_req, res) => res.writeHead(404).end());
    hub.attach(server);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** 101 when the upgrade is accepted, else the HTTP status it got. */
  const dial = (url: string, token?: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
      ws.on('open', () => (ws.close(), resolve(101)));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });

  it('refuses a missing or wrong token with 401', async () => {
    const url = await start();
    expect(await dial(`${url}/host`)).toBe(401);
    expect(await dial(`${url}/host`, 'static-host-toke')).toBe(401);
    expect(await dial(`${url}/host`, 'static-host-token2')).toBe(401);
  });

  it('accepts a static SP_HOST_TOKENS token and a /setup-issued one', async () => {
    const url = await start((t) => (t === 'sph_issued' ? 'vm-1' : undefined));
    expect(await dial(`${url}/host`, 'static-host-token')).toBe(101);
    expect(await dial(`${url}/host`, 'sph_issued')).toBe(101);
  });

  it('only upgrades /host', async () => {
    const url = await start();
    expect(await dial(`${url}/setup`, 'static-host-token')).toBe(0);
  });
});
