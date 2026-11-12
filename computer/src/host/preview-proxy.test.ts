import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { PreviewConfig } from '../protocol.js';
import { signPreview } from '../signed-header.js';
import { loopbackDialer } from './preview-dial.js';
import { previewProxy } from './preview-proxy.js';

const KEY = Buffer.alloc(32, 7).toString('base64url');
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function listen(s: http.Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

/** A proxy allowing `ports`, and the headers the Worker would send for `port`. */
async function proxy(ports: number[], config?: Partial<PreviewConfig>) {
  const at = await listen(previewProxy(() => ({ tunnelToken: 't', key: KEY, ports, ...config }), []));
  const signed = (port: number, extra: Record<string, string> = {}) => ({
    'x-preview-port': String(port), 'x-preview-auth': signPreview(KEY, port), 'x-preview-host': 'demo.opencomputer.app', ...extra });
  return { at, signed };
}

function get(port: number, headers: Record<string, string>, path = '/') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject);
  });
}

/** An app that echoes what it received. */
const echo = () => listen(http.createServer((req, res) => {
  res.setHeader('x-preview-state', 'forged');
  res.setHeader('set-cookie', ['a=1', 'b=2']);
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
}));

describe('preview proxy', () => {
  it('forwards an allowed, signed request with the visitor\'s Host and marks the response', async () => {
    const app = await echo();
    const { at, signed } = await proxy([app]);
    const r = await get(at, signed(app), '/a?b=1');
    expect(r.status).toBe(200);
    expect(r.headers['x-preview-origin']).toBe('computer');
    expect(r.headers['x-preview-state']).toBeUndefined();
    expect(r.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    const seen = JSON.parse(r.body);
    expect(seen.url).toBe('/a?b=1');
    expect(seen.headers.host).toBe('demo.opencomputer.app');
    expect(seen.headers['x-forwarded-host']).toBe('demo.opencomputer.app');
    expect(seen.headers['x-forwarded-proto']).toBe('https');
    expect(Object.keys(seen.headers).filter((k) => k.startsWith('x-preview-'))).toEqual([]);
  });

  it('keeps the connection to the app between requests, and dials it through its dialer', async () => {
    const sockets = new Set<unknown>();
    const seen: (string | undefined)[] = [];
    const app = await listen(http.createServer((req, res) => (sockets.add(req.socket), seen.push(req.headers.connection), res.end('ok'))));
    const dialed: number[] = [];
    const at = await listen(previewProxy(() => ({ tunnelToken: 't', key: KEY, ports: [app] }), [], (p) => (dialed.push(p), loopbackDialer(p))));
    const headers = { 'x-preview-port': String(app), 'x-preview-auth': signPreview(KEY, app) };
    for (let n = 0; n < 3; n++) expect((await get(at, headers)).status).toBe(200);
    expect(sockets.size).toBe(1);
    expect(dialed).toEqual([app]);
    expect(seen).toEqual(['keep-alive', 'keep-alive', 'keep-alive']);
  });

  it('closes its idle connections to the app when it closes', async () => {
    let open = 0;
    const appServer = http.createServer((_req, res) => res.end('ok'));
    appServer.on('connection', (s) => (open++, s.on('close', () => open--)));
    const app = await listen(appServer);
    const p = previewProxy(() => ({ tunnelToken: 't', key: KEY, ports: [app] }), []);
    await new Promise<void>((r) => p.listen(0, '127.0.0.1', r));
    const at = (p.address() as AddressInfo).port;
    expect((await get(at, { 'x-preview-port': String(app), 'x-preview-auth': signPreview(KEY, app) })).status).toBe(200);
    expect(open).toBe(1);
    p.closeAllConnections();
    await new Promise((r) => p.close(r));
    await new Promise((r) => setTimeout(r, 50));
    expect(open).toBe(0);
  });

  it('with a table of previewed ports, dials only a port the table holds', async () => {
    const app = await echo();
    const dialed: number[] = [];
    const held = new Set([30001]);
    const config = { tunnelToken: 't', key: KEY, ports: [30001, 30002] };
    const at = await listen(previewProxy(() => config, [], (port) => (dialed.push(port), loopbackDialer(app)), (port) => held.has(port)));
    const signed = (port: number) => ({ 'x-preview-port': String(port), 'x-preview-auth': signPreview(KEY, port), 'x-preview-host': 'demo.opencomputer.app' });
    expect((await get(at, signed(30001))).status).toBe(200);
    const r = await get(at, signed(30002)); // signed and allowed by the gateway, but the table lost it
    expect([r.status, r.body.trim()]).toEqual([403, 'port not previewed']);
    expect(dialed).toEqual([30001]);
  });

  it('refuses a port not in the allow-list, a host port, and a request without config', async () => {
    const app = await echo();
    const { at, signed } = await proxy([app + 1]);
    const r = await get(at, signed(app));
    expect([r.status, r.headers['x-preview-origin']]).toEqual([403, 'computer']);
    const own = await listen(previewProxy(() => ({ tunnelToken: 't', key: KEY, ports: [app] }), [app]));
    expect((await get(own, signed(app))).status).toBe(403);
    const none = await listen(previewProxy(() => undefined));
    const n = await get(none, signed(app));
    expect([n.status, n.headers['x-preview-origin']]).toEqual([503, 'computer']);
  });

  it('refuses a bad or expired signature', async () => {
    const app = await echo();
    const { at, signed } = await proxy([app]);
    const bad = await get(at, signed(app, { 'x-preview-auth': signPreview(Buffer.alloc(32).toString('base64url'), app) }));
    expect([bad.status, bad.headers['x-preview-origin']]).toEqual([403, 'computer']);
    const expired = await get(at, signed(app, { 'x-preview-auth': signPreview(KEY, app, Date.now() - 61_000) }));
    expect(expired.status).toBe(403);
    const otherPort = await get(at, signed(app, { 'x-preview-auth': signPreview(KEY, app + 1) }));
    expect(otherPort.status).toBe(403);
  });

  it('answers 503, closed, for a registered port nothing listens on', async () => {
    const free = await listen(http.createServer());
    await new Promise((r) => servers.pop()!.close(r));
    const { at, signed } = await proxy([free]);
    const r = await get(at, signed(free));
    expect([r.status, r.headers['x-preview-origin'], r.headers['x-preview-state']]).toEqual([503, 'computer', 'closed']);
  });

  it('streams a response as it is written (SSE)', async () => {
    let next!: () => void;
    const app = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      next = () => res.end('data: two\n\n');
    }));
    const { at, signed } = await proxy([app]);
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: at, headers: signed(app) }, (res) => {
        expect(res.headers['x-preview-origin']).toBe('computer');
        res.setEncoding('utf8').on('data', (d: string) => {
          chunks.push(d);
          if (chunks.length === 1) next(); // the first event arrived before the app ended the response
        }).on('end', resolve);
      }).on('error', reject);
    });
    expect(chunks.join('')).toBe('data: one\n\ndata: two\n\n');
  });

  it('passes a WebSocket upgrade through both ways, marked, with the visitor\'s Host', async () => {
    const appServer = http.createServer();
    const wss = new WebSocketServer({ server: appServer });
    let host: string | undefined;
    wss.on('connection', (sock, req) => {
      host = req.headers.host;
      sock.on('message', (d) => sock.send(`echo ${d}`));
    });
    const app = await listen(appServer);
    const { at, signed } = await proxy([app]);
    const client = new WebSocket(`ws://127.0.0.1:${at}/hmr`, { headers: signed(app) });
    const marker = new Promise<string | undefined>((r) => client.on('upgrade', (res) => r(res.headers['x-preview-origin'] as string)));
    await new Promise((r) => client.on('open', r));
    client.send('hi');
    const reply = await new Promise<string>((r) => client.on('message', (d) => r(String(d))));
    expect(reply).toBe('echo hi');
    expect(await marker).toBe('computer');
    expect(host).toBe('demo.opencomputer.app');
    client.close();
    wss.close();
  });

  it('refuses an unsigned upgrade with the marker', async () => {
    const app = await echo();
    const { at } = await proxy([app]);
    const client = new WebSocket(`ws://127.0.0.1:${at}/`, { headers: { 'x-preview-port': String(app) } });
    const res = await new Promise<http.IncomingMessage>((r) => client.on('unexpected-response', (_req, res) => r(res)));
    expect([res.statusCode, res.headers['x-preview-origin']]).toEqual([403, 'computer']);
    res.destroy();
  });
});
