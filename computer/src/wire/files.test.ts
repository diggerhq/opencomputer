import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWire, type WireScope } from '../signed-header.js';
import { writeLine } from './ndjson.js';
import { pickEncoding, relativePath } from './files.js';
import { startRelay, type Relay } from './relay.js';
import { accessFor, fakeDial, fakeHost, KEY, sid, until } from './test-fakes.js';

describe('relativePath and pickEncoding', () => {
  it('keeps paths inside the workspace', () => {
    expect(relativePath('a/b/')).toBe('a/b');
    expect(relativePath('./a')).toBe('a');
    expect(relativePath(null)).toBe('');
    expect(relativePath('.')).toBe('');
    expect(relativePath('...')).toBe('...');
    for (const bad of ['/etc', 'a/../b', '..', '../x', 'a\0b']) expect(relativePath(bad), bad).toBeUndefined();
  });
  it('prefers zstd, then gzip, and honours q=0', () => {
    expect(pickEncoding('gzip, zstd')).toBe('zstd');
    expect(pickEncoding('gzip, zstd;q=0')).toBe('gzip');
    expect(pickEncoding('br')).toBeUndefined();
    expect(pickEncoding(undefined)).toBeUndefined();
  });
});

const CONTENT = 'hello from the workspace\n';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wire-files-'));
let shots = 0;
let host: Awaited<ReturnType<typeof fakeHost>>;
let relay: Relay;
const session = sid();
const uploads: Buffer[] = [];

/** A one-shot socket like host/one-shot-socket.ts: `serve` runs on the relay's connection, then files.done. */
function oneShot(peer: net.Socket, id: string, serve: (c: net.Socket) => Promise<unknown>) {
  const socket = path.join(tmp, `s${++shots}.sock`);
  const server = net.createServer(async (c) => {
    c.on('error', () => {});
    server.close();
    const result = await serve(c);
    writeLine(peer, { t: 'files.done', id, result });
  });
  server.listen(socket);
  return socket;
}

beforeAll(async () => {
  host = await fakeHost({
    access: [accessFor(session)],
    answer: (m, peer) => {
      if (m.t === 'files.list') return { result: { entries: [{ path: 'a', type: 'file' }], nextCursor: null } };
      if (m.t === 'files.get' && 'file' in m && m.file) {
        const socket = oneShot(peer, m.id, async (c) => void c.end(CONTENT));
        return { result: { socket, size: CONTENT.length, etag: '"e1"', contentType: 'text/plain; charset=utf-8' } };
      }
      if (m.t === 'files.get') return { result: { socket: oneShot(peer, m.id, async (c) => void c.end(Buffer.alloc(1024, 7))) } };
      if (m.t === 'files.put') {
        const socket = oneShot(peer, m.id, (c) => {
          const parts: Buffer[] = [];
          c.on('data', (d: Buffer) => parts.push(d));
          return new Promise((r) =>
            c.on('end', () => {
              uploads.push(Buffer.concat(parts));
              c.end();
              r({ upload: { path: m.path, files: 1, bytes: uploads.at(-1)?.length, replaced: null }, seq: 7 });
            }),
          );
        });
        return { result: { socket } };
      }
      return undefined;
    },
  });
  relay = await startRelay({ host: '127.0.0.1', port: 0, socket: host.socket, version: 'test', region: null, dial: fakeDial().dial, telemetryMs: 3_600_000 });
  await until(() => relay.hostLink.key !== null);
});
afterAll(async () => {
  await relay.close();
  await host.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function req(method: string, op: string, query: string, o: { scope?: WireScope; headers?: Record<string, string>; body?: Buffer; key?: string } = {}) {
  const headers = { ...signWire(o.key ?? KEY, { member: 'usr_owner', keyId: 'ak_000000000000', client: 'opc/0.1.0', scope: o.scope ?? {} }), ...o.headers };
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: relay.port, method, path: `/files/${session}/${op}?${query}`, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

describe('/files routes', () => {
  it('reads one file with its type and etag, and 304 on a match', async () => {
    const r = await req('GET', 'file', 'path=a.txt');
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"e1"');
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.body.toString()).toBe(CONTENT);
    expect((await req('GET', 'file', 'path=a.txt', { headers: { 'if-none-match': '"e1"' } })).status).toBe(304);
  });

  it('downloads an archive compressed as asked', async () => {
    const r = await req('GET', 'archive', 'path=', { headers: { 'accept-encoding': 'gzip' } });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(r.body)).toEqual(Buffer.alloc(1024, 7));
  });

  it('uploads once per idempotency key', async () => {
    const body = Buffer.from('tar bytes');
    const first = await req('PUT', 'archive', 'path=notes', { body, headers: { 'idempotency-key': 'k1' } });
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body.toString())).toEqual({ upload: { path: 'notes', files: 1, bytes: 9, replaced: null }, seq: 7 });
    const again = await req('PUT', 'archive', 'path=notes', { body, headers: { 'idempotency-key': 'k1' } });
    expect(again.body.toString()).toBe(first.body.toString());
    expect(uploads).toHaveLength(1);
  });

  it('lists through the host', async () => {
    const r = await req('GET', 'files', 'path=&depth=2');
    expect(JSON.parse(r.body.toString()).entries).toHaveLength(1);
    expect((await req('GET', 'files', 'path=&depth=11')).status).toBe(400);
  });

  it('refuses before the host is asked', async () => {
    const asked = () => host.calls.filter((m) => (m as { t?: string }).t !== 'telemetry').length; // telemetry is not asking
    const before = asked();
    expect((await req('GET', 'file', 'path=a', { key: 'wrong' })).status).toBe(403);
    const scoped = await req('PUT', 'archive', 'path=x', { scope: { scopes: ['sessions:read'] }, body: Buffer.from('x') });
    expect(JSON.parse(scoped.body.toString()).error.reason).toBe('missing_scope');
    const ro = await req('PUT', 'archive', 'path=x', { scope: { readOnly: true }, body: Buffer.from('x') });
    expect(JSON.parse(ro.body.toString()).error.reason).toBe('read_only');
    expect(JSON.parse((await req('GET', 'archive', 'path=../x')).body.toString()).error.code).toBe('invalid_path');
    expect(JSON.parse((await req('PUT', 'archive', 'path=a/b', { body: Buffer.from('x') })).body.toString()).error.code).toBe('invalid_path');
    expect((await req('GET', 'file', 'path=a', { scope: { sessionIds: [sid()] } })).status).toBe(404);
    expect(asked()).toBe(before);
  });

  it('reports each authorised transfer as one wire.files event, never the path', async () => {
    const files = () => host.calls.filter((m) => (m as { name?: string }).name === 'wire.files') as { fields: Record<string, unknown> }[];
    const n = files().length;
    await req('GET', 'files', 'path=&depth=1');
    await until(() => files().length > n);
    const ev = files()[n];
    expect(ev.fields).toMatchObject({ op: 'list', outcome: 'completed', session_key: session });
    expect(JSON.stringify(ev.fields)).not.toContain('path');
  });
});
