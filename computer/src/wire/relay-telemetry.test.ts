// The relay's telemetry (work 084): one wire.* event per unit sent over
// wire.sock as it happens, every one passing the host's check; opc's
// telemetry frames forwarded event by event, limited, never answered.
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCliForward } from '../api/cli-telemetry.js';
import { checkWireEvent } from '../api/wire-events.js';
import { startRelay, type Relay } from './relay.js';
import { accessFor, connectClient, fakeDial, fakeHost, sid, until } from './test-fakes.js';

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
  cleanup = [];
});

type Sent = { t: 'telemetry'; name: string; fields: Record<string, unknown> };

async function setup() {
  const session = sid();
  const host = await fakeHost({ access: [accessFor(session)] });
  const writers = fakeDial();
  const relay: Relay = await startRelay({ host: '127.0.0.1', port: 0, socket: host.socket, version: 'test', region: 'test-1', dial: writers.dial, telemetryMs: 3_600_000 });
  cleanup.push(() => host.close(), () => relay.close());
  await until(() => relay.hostLink.key !== null);
  const sent = () => (host.calls as Sent[]).filter((m) => m.t === 'telemetry');
  const named = (n: string) => sent().filter((m) => m.name === n);
  return { session, port: relay.port, sent, named };
}

const upgrade = (port: number) =>
  new Promise<void>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/connect', headers: { connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'opc.v1' } });
    req.on('response', () => resolve());
    req.on('upgrade', (_r, s) => (s.destroy(), resolve()));
    req.on('error', () => resolve());
    req.end();
  });

describe('relay telemetry', () => {
  it('connect, attach and close: one event each, all valid for the host, no content', async () => {
    const { session, port, named, sent } = await setup();
    const c = connectClient(port, { query: `attach=${session}` });
    await c.next((m) => m.method === 'sessions.attached');
    c.ws.close();
    await until(() => named('wire.close').length === 1);
    expect(named('wire.connect')).toHaveLength(1);
    const [attach] = named('wire.attach');
    expect(attach.fields).toMatchObject({ session_key: session, person_id: 'usr_owner', outcome: 'completed', via: 'url' });
    expect(named('wire.close')[0].fields).toMatchObject({ code: 1005 });
    for (const m of sent()) expect(checkWireEvent(m.name, m.fields), m.name).toBeDefined();
  });

  it('a refused upgrade is one wire.refused with its status and nothing else', async () => {
    const { port, named } = await setup();
    await upgrade(port);
    await until(() => named('wire.refused').length === 1);
    expect(named('wire.refused')[0].fields).toEqual({ status: 401 });
  });

  it("forwards opc's events stamped with the member, never answers, and limits frames", async () => {
    const { session, port, named } = await setup();
    const c = connectClient(port);
    await c.next((m) => m.method === 'ready');
    const frame = (data: Record<string, unknown>) =>
      c.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'telemetry', params: { v: 1, client: { name: 'opc', version: '0.1.0', os: 'linux', arch: 'x64' }, events: [{ name: 'cli.render', sessionId: session, data }] } }));
    frame({ lag_ms: 120, draw_ms: 8 });
    frame({ lag_ms: 120, text: 'my secret prompt' });
    for (let i = 0; i < 4; i++) frame({ lag_ms: 1, draw_ms: 1 });
    c.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'telemetry', params: { pad: 'x'.repeat(70_000) } })); // over frameBytes
    await until(() => named('wire.telemetry').length === 3);
    const results = named('wire.telemetry').map((m) => m.fields.result);
    expect(results).toEqual(['ok', 'invalid', 'ok']);
    // The four refused frames (three over the rate, one too large) are no events of their own: wire.flush counts them.
    c.ws.close();
    await until(() => named('wire.close').length === 1);
    expect(named('wire.flush').reduce((n, m) => n + Number(m.fields.telemetry_refused ?? 0), 0)).toBe(4);
    expect(named('wire.telemetry')).toHaveLength(3);
    const cli = named('cli.render');
    expect(cli).toHaveLength(2);
    expect(checkCliForward(cli[0].name, cli[0].fields)).toMatchObject({ person_id: 'usr_owner', session_key: session, data: { lag_ms: 120, draw_ms: 8 } });
    expect(JSON.stringify(cli)).not.toContain('secret');
    expect(c.frames.filter((m) => m.id === undefined && m.method !== 'ready')).toEqual([]);
  });

  it('caps error events per connection', async () => {
    const { port, named } = await setup();
    const c = connectClient(port);
    await c.next((m) => m.method === 'ready');
    for (let i = 0; i < 40; i++) c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'sessions.attach', params: { sessionId: 'nope' } }));
    await c.next((m) => m.id === 40);
    await new Promise((r) => setTimeout(r, 20));
    const n = named('wire.error').length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(21);
    c.ws.close();
  });
});
