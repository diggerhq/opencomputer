import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackDialer } from './preview-dial.js';
import { frameworkHint, probePort } from './preview-probe.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function freePort() {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

function serve(port: number, handler: http.RequestListener) {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
}

describe('frameworkHint', () => {
  it('names the config line for Next, webpack-dev-server and Vite host checks, and nothing else', () => {
    expect(frameworkHint(403, 'Blocked cross-origin request from x.opencomputer.app')).toMatch(/allowedDevOrigins: \['\*\.opencomputer\.app'\]/);
    expect(frameworkHint(403, 'Invalid Host header')).toMatch(/allowedHosts: \['\.opencomputer\.app'\]/);
    expect(frameworkHint(403, 'Blocked request. This host ("x.opencomputer.app") is not allowed.')).toMatch(/vite\.config/);
    expect(frameworkHint(403, 'Forbidden')).toBeUndefined();
    expect(frameworkHint(200, 'Invalid Host header')).toBeUndefined();
  });
});

describe('probePort', () => {
  it('answers as soon as a server that starts late responds, with the preview Host', async () => {
    const port = await freePort();
    let host: string | undefined;
    setTimeout(() => void serve(port, (req, res) => ((host = req.headers.host), res.end('ok'))), 600);
    const t0 = Date.now();
    expect(await probePort(port, 'demo.opencomputer.app', 5000)).toEqual({ listening: true });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(host).toBe('demo.opencomputer.app');
  });

  it('reaches the port only through the dialer it is given', async () => {
    const port = await freePort();
    await serve(port, (_req, res) => (res.setHeader('x-powered-by', 'Next.js'), res.end('ok')));
    const dialed: number[] = [];
    const dial = (p: number) => (dialed.push(p), loopbackDialer(p));
    expect(await probePort(port, 'demo.opencomputer.app', 2000, dial)).toEqual({ listening: true });
    expect(dialed).toEqual([port, port]); // the page, then Next's HMR endpoint
    // A dialer that reaches nothing: the port is not listening, though this machine's loopback has it.
    const nowhere = await freePort();
    expect(await probePort(port, 'demo.opencomputer.app', 600, () => loopbackDialer(nowhere))).toEqual({ listening: false });
  });

  it('gives up after the wait when nothing listens', async () => {
    const port = await freePort();
    const t0 = Date.now();
    expect(await probePort(port, 'demo.opencomputer.app', 800)).toEqual({ listening: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
  });

  it('turns a framework\'s host-check 403 into a hint', async () => {
    const port = await freePort();
    await serve(port, (_req, res) => (res.statusCode = 403, res.end('Invalid Host header')));
    const r = await probePort(port, 'demo.opencomputer.app', 2000);
    expect(r.listening).toBe(true);
    expect(r.hint).toMatch(/devServer/);
  });

  it('asks a Next server for its HMR endpoint with the preview origin, and hints when it is refused', async () => {
    const port = await freePort();
    let origin: string | undefined;
    await serve(port, (req, res) => {
      res.setHeader('x-powered-by', 'Next.js');
      if (req.url !== '/_next/webpack-hmr') return res.end('<html>page</html>');
      origin = req.headers.origin;
      res.statusCode = 403;
      res.end('Unauthorized');
    });
    const r = await probePort(port, 'demo.opencomputer.app', 2000);
    expect(origin).toBe('https://demo.opencomputer.app');
    expect(r).toEqual({ listening: true, hint: expect.stringMatching(/allowedDevOrigins/) });
  });

  it('gives no hint for a Next server that allows the preview origin', async () => {
    const port = await freePort();
    await serve(port, (req, res) => (res.setHeader('x-powered-by', 'Next.js'), res.statusCode = req.url === '/' ? 200 : 404, res.end('ok')));
    expect(await probePort(port, 'demo.opencomputer.app', 2000)).toEqual({ listening: true });
  });

  it('counts a server that accepts but has not answered by the deadline as listening', async () => {
    const port = await freePort();
    await serve(port, () => {});
    expect(await probePort(port, 'demo.opencomputer.app', 500)).toEqual({ listening: true });
  });
});
