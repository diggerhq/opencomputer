import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GatewayToHost, HostToGateway } from '../protocol.js';
import { type GatewayLink, gatewayLink } from './gateway-link.js';

const until = async (f: () => boolean) => {
  for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};

/** A stand-in gateway: records what each connection says, with its bearer token. */
function fakeGateway() {
  const wss = new WebSocketServer({ port: 0 });
  const conns: { token: string | undefined; got: HostToGateway[]; sock: WebSocket }[] = [];
  wss.on('connection', (sock, req) => {
    const c = { token: req.headers.authorization?.replace('Bearer ', ''), got: [] as HostToGateway[], sock };
    conns.push(c);
    sock.on('message', (d) => c.got.push(JSON.parse(String(d))));
  });
  const url = () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}/host`;
  return { wss, conns, url };
}

const hello = (hostId: string): Extract<HostToGateway, { t: 'hello' }> => ({ t: 'hello', protocol: 1, hostId, version: 'test', sessions: [] });

let link: GatewayLink | undefined;
let g: ReturnType<typeof fakeGateway> | undefined;
afterEach(() => {
  for (const c of g?.conns ?? []) c.sock.terminate();
  g?.wss.close();
  g = undefined;
});

describe('gateway link', () => {
  it('says hello on open with the token of the moment, hands every frame to `message`, and drops a send while down', async () => {
    g = fakeGateway();
    const got: GatewayToHost[] = [];
    let token = 't1';
    link = gatewayLink({ url: g.url, token: () => token, hello: () => hello('h1'), message: (m) => got.push(m) });
    expect(link.connected).toBe(false);
    expect(link.ask({ t: 'out-of-credits', sessionKey: 'k' })).toBe(false);
    link.send({ t: 'out-of-credits', sessionKey: 'k' }); // dropped
    link.dial();
    await until(() => g!.conns[0]?.got.length === 1);
    expect(g.conns[0].token).toBe('t1');
    expect(g.conns[0].got[0]).toEqual(hello('h1'));
    expect(link.connected && link.open).toBe(true);
    g.conns[0].sock.send(JSON.stringify({ t: 'people', people: [] }));
    g.conns[0].sock.send('not json');
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ t: 'people', people: [] });
    expect(link.seenAt).toBeGreaterThan(0);
    expect(link.ask({ t: 'out-of-credits', sessionKey: 'k' })).toBe(true);
    await until(() => g!.conns[0].got.length === 2);

    // A redial drops the link now and dials again, with what url/token/hello say then.
    token = 't2';
    link.redial();
    await until(() => g!.conns[1]?.got.length === 1);
    expect(g.conns[1].token).toBe('t2');
    expect(g.conns[0].sock.readyState).not.toBe(g.conns[0].sock.OPEN);
    g.conns[1].sock.terminate(); // the test's own cleanup; the link's redial after this is 1 s out
  });
});
