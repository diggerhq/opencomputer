import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewSocketFor } from '../ipc.js';
import { loopbackDialer, nothingListens, sandboxDialer } from './preview-dial.js';
import { probePort } from './preview-probe.js';

const servers: net.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function listen(): Promise<number> {
  const s = net.createServer((c) => c.end('hello'));
  servers.push(s);
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return (s.address() as net.AddressInfo).port;
}

describe('loopbackDialer', () => {
  it('connects to a port that listens on loopback', async () => {
    const c = loopbackDialer(await listen());
    await once(c, 'connect');
    const [data] = await once(c, 'data');
    expect(String(data)).toBe('hello');
    c.destroy();
  });

  it('reports ECONNREFUSED as an error event when nothing listens', async () => {
    const port = await listen();
    servers.splice(0)[0].close();
    await new Promise((r) => setTimeout(r, 20));
    const [e] = await once(loopbackDialer(port), 'error');
    expect((e as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });
});

/**
 * A runner's end of the preview socket (src/runner/preview-socket.ts), as the contract says it: `ports` are
 * connected and answered `ok`, 9 is previewed with nothing listening (`closed`), any other gets no reply.
 */
async function runnerEnd(ports: number[], answer = 'ok\n') {
  const run = mkdtempSync(path.join(os.tmpdir(), 'sp-dial-'));
  mkdirSync(path.join(run, 'runners'));
  const lines: string[] = [];
  const s = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', (d: Buffer) => {
      const nl = d.indexOf(0x0a);
      const port = Number(d.subarray(0, nl));
      lines.push(d.subarray(0, nl + 1).toString());
      if (port === 9) return void c.end('closed\n');
      if (!ports.includes(port)) return void c.end();
      const up = net.connect(port, '127.0.0.1', () => {
        c.write(answer);
        up.write(d.subarray(nl + 1));
        up.pipe(c).pipe(up);
      });
      up.on('error', () => c.destroy());
    });
  });
  servers.push(s);
  s.listen(previewSocketFor(run, 'r1'));
  await once(s, 'listening');
  return { run, lines };
}

async function app(): Promise<number> {
  const s = http.createServer((req, res) => res.end(`inside ${req.headers.host} ${req.url}`));
  servers.push(s as unknown as net.Server);
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return (s.address() as net.AddressInfo).port;
}

const get = (dial: ReturnType<typeof sandboxDialer>, port: number) =>
  new Promise<string>((resolve, reject) => {
    http.get({ createConnection: () => dial(port) as net.Socket, host: 'demo.example', path: '/x', headers: { host: 'demo.example' } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve(body));
    }).on('error', reject);
  });

describe('sandboxDialer', () => {
  it('names the port in one line, then carries HTTP once the runner says ok', async () => {
    const port = await app();
    const { run, lines } = await runnerEnd([port]);
    expect(await get(sandboxDialer(run, 'r1'), port)).toBe('inside demo.example /x');
    expect(lines).toEqual([`${port}\n`]);
    expect(await probePort(port, 'demo.example', 2000, sandboxDialer(run, 'r1'))).toMatchObject({ listening: true });
  });

  it('works under a keep-alive agent, as the proxy uses it', async () => {
    const port = await app();
    const { run, lines } = await runnerEnd([port]);
    const agent = new http.Agent({ keepAlive: true, timeout: 5000 });
    const dial = sandboxDialer(run, 'r1');
    agent.createConnection = (o) => dial(Number(o.port));
    const viaAgent = () =>
      new Promise<string>((resolve, reject) => {
        http.get({ agent, host: '127.0.0.1', port, path: '/x', headers: { host: 'demo.example' } }, (res) => {
          let body = '';
          res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve(body));
        }).on('error', reject);
      });
    expect(await viaAgent()).toBe('inside demo.example /x');
    expect(await viaAgent()).toBe('inside demo.example /x');
    expect(lines).toEqual([`${port}\n`]); // the second request reused the first one's connection
    agent.destroy();
  });

  it('reports ECONNREFUSED for closed, for no reply, and for any answer that is not ok', async () => {
    const port = await app();
    const { run } = await runnerEnd([]);
    for (const p of [9, port]) await expect(get(sandboxDialer(run, 'r1'), p)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(await probePort(9, 'demo.example', 300, sandboxDialer(run, 'r1'))).toEqual({ listening: false });
    const liar = await runnerEnd([port], 'okay\nHTTP/1.1 200 OK\r\n\r\n');
    await expect(get(sandboxDialer(liar.run, 'r1'), port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('refuses when the socket is missing or is not a socket, without connecting', async () => {
    const { run } = await runnerEnd([]);
    const [e] = await once(sandboxDialer(run, 'nobody')(80), 'error');
    expect((e as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    writeFileSync(previewSocketFor(run, 'file'), 'x');
    const [e2] = await once(sandboxDialer(run, 'file')(80), 'error');
    expect((e2 as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });

  it("refuses a socket that is not the named user's", async () => {
    const { run } = await runnerEnd([80]);
    const [e] = await once(sandboxDialer(run, 'r1', { uid: process.getuid!() + 1 })(80), 'error');
    expect((e as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });
});

describe('nothingListens', () => {
  it('is ECONNREFUSED', async () => {
    const [e] = await once(nothingListens(80), 'error');
    expect((e as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });
});
