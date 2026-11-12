import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { previewSocketFor } from '../ipc.js';
import { gatedPreviews, portOf, previewSocket } from './preview-socket.js';

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

/** A run root with a preview socket for runner `r1`, as a container's runner and the host both see it. */
async function gate() {
  const run = mkdtempSync(path.join(os.tmpdir(), 'sp-prev-'));
  mkdirSync(path.join(run, 'runners'));
  const g = previewSocket(previewSocketFor(run, 'r1'));
  await once(g.server, 'listening');
  closers.push(() => (g.server.close(), rmSync(run, { recursive: true, force: true })));
  return { run, g, file: previewSocketFor(run, 'r1') };
}

async function app(body = 'hello from inside') {
  const s = http.createServer((req, res) => res.end(`${body} ${req.headers.host} ${req.url}`));
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  closers.push(() => (s.closeAllConnections(), s.close()));
  return (s.address() as net.AddressInfo).port;
}

/** Everything the socket answers to `line`, until it ends. */
function raw(file: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(file, () => c.write(line));
    let got = '';
    c.on('data', (d) => (got += d)).on('end', () => resolve(got)).on('error', reject);
  });
}

/** One HTTP request through the socket, as the host's dialer makes it: the line, then the request. */
const get = async (file: string, port: number, urlPath = '/') => {
  const got = await raw(file, `${port}\nGET ${urlPath} HTTP/1.1\r\nHost: demo.example\r\nConnection: close\r\n\r\n`);
  return { ok: got.startsWith('ok\nHTTP/1.1 200 OK\r\n'), body: got.split('\r\n\r\n')[1] ?? '' };
};

describe('portOf', () => {
  it('takes a decimal port and nothing else', () => {
    expect(portOf('5173')).toBe(5173);
    expect(portOf('65535')).toBe(65535);
    for (const bad of ['', '0', '65536', '080', '5173 ', '-1', '1e3', '0x50', '51a']) expect(portOf(bad), bad).toBeUndefined();
  });
});

describe('the preview socket', () => {
  it('is 0660 and carries bytes both ways to a previewed port', async () => {
    const { g, file } = await gate();
    expect(statSync(file).mode & 0o777).toBe(0o660);
    const port = await app();
    g.allow(port);
    const r = await get(file, port, '/a?b=1');
    expect(r.ok).toBe(true);
    expect(r.body).toContain('hello from inside demo.example /a?b=1');
  });

  it('ends without a reply for a port the runner did not preview, and for what is not a port line', async () => {
    const { g, file } = await gate();
    const port = await app();
    expect(await raw(file, `${port}\n`)).toBe('');
    for (const line of ['GET / HTTP/1.1\r\n', '1234567', '\n', '65536\n', '22 \n']) expect(await raw(file, line), line).toBe('');
    g.allow(port);
    expect((await get(file, port)).ok).toBe(true);
    g.revoke(port);
    expect(await raw(file, `${port}\n`)).toBe('');
  });

  it('answers closed when nothing listens on a previewed port', async () => {
    const { g, file } = await gate();
    const port = await app();
    closers.splice(1)[0](); // the app goes, the gate stays
    await new Promise((r) => setTimeout(r, 20));
    g.allow(port);
    expect(await raw(file, `${port}\n`)).toBe('closed\n');
  });
});

describe('gatedPreviews', () => {
  const fakeGate = () => {
    const ports = new Set<number>();
    return { ports, allow: (p: number) => void ports.add(p), revoke: (p: number) => void ports.delete(p), allowed: (p: number) => ports.has(p) };
  };

  it('opens the port before the request goes out and keeps it until its name is unpreviewed', async () => {
    const g = fakeGate();
    let during: boolean | undefined;
    const hooks = gatedPreviews({
      preview: async (req) => ((during = g.ports.has(req.port)), { url: 'https://demo.x', name: 'demo', port: req.port, listening: true }),
      unpreview: async () => {},
    }, g);
    await hooks.preview({ port: 5173 });
    expect(during).toBe(true);
    expect([...g.ports]).toEqual([5173]);
    await hooks.unpreview('other');
    expect([...g.ports]).toEqual([5173]);
    await hooks.unpreview('demo');
    expect([...g.ports]).toEqual([]);
  });

  it('closes a port whose request failed, unless it was open before', async () => {
    const g = fakeGate();
    let fail = true;
    const hooks = gatedPreviews({
      preview: async (req) => {
        if (fail) throw new Error('demo is taken');
        return { url: 'https://demo.x', name: 'demo', port: req.port, listening: true };
      },
      unpreview: async () => {},
    }, g);
    await expect(hooks.preview({ port: 3000 })).rejects.toThrow('demo is taken');
    expect([...g.ports]).toEqual([]);
    fail = false;
    await hooks.preview({ port: 3000 });
    fail = true;
    await expect(hooks.preview({ port: 3000, name: 'taken' })).rejects.toThrow();
    expect([...g.ports]).toEqual([3000]);
  });
});
