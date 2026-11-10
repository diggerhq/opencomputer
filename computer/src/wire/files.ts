// The relay's `/files/<sessionId>/<op>` routes (opc docs http/workspace.mdx;
// blue forwards `GET|PUT /sessions/{id}/workspace/*` here with the X-Wire
// headers): list, read one file, download and upload an archive. The host does
// the filesystem work (host/workspace-files.ts) behind a one-shot unix socket
// per transfer; the relay checks the caller, streams, and compresses
// downloads.
//
// Invariants:
// - Every request is authenticated (edge-auth.ts) and checked for scope, the
//   ticket's sessions and the session's access list before the host is asked.
// - Errors are the API error body `{error: {...}}` with its status; once a
//   download's headers are sent, a failure aborts the response (the client
//   sees a truncated transfer, never a bad archive passed as good).
// - An upload with an `Idempotency-Key` that succeeded is answered from memory
//   for 24 h without writing again (per member and session).

import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { ApiError } from '../protocol.js';
import { isSessionId } from '../session-ids.js';
import { authenticate, hasScope, inTicket, mayAttach, scopeFor } from './edge-auth.js';
import type { HostLink } from './host-link.js';
import { err, errors } from './rpc.js';
import type { WireEmit } from './telemetry.js';

const UPLOAD_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
const IDEM_MS = 24 * 3600_000;
const IDEM_MAX = 2000;

export const invalidPath = (message = 'path must be relative and must not contain "..".') => err('invalid_path', message, 400);

/** A workspace-relative path: no leading `/`, no `..` segment, no NUL. "" is the workspace itself. */
export function relativePath(p: string | null): string | undefined {
  const t = (p ?? '').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const s = t === '.' ? '' : t;
  if (s.startsWith('/') || s.includes('\0') || s.split('/').some((seg) => seg === '..')) return undefined;
  return s;
}

/** The archive compression for a request's Accept-Encoding: zstd, then gzip, else none. */
export function pickEncoding(accept: string | undefined): 'zstd' | 'gzip' | undefined {
  const offered = new Map<string, number>();
  for (const part of (accept ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    offered.set(name, q ? Number(q.slice(2)) : 1);
  }
  if ((offered.get('zstd') ?? 0) > 0 && typeof zlib.createZstdCompress === 'function') return 'zstd';
  if ((offered.get('gzip') ?? 0) > 0) return 'gzip';
  return undefined;
}

function sendError(res: ServerResponse, e: ApiError) {
  if (res.headersSent) return void res.destroy();
  const body = JSON.stringify({ error: e });
  res.writeHead(e.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const connect = (path: string) =>
  new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(path);
    s.once('error', reject);
    s.once('connect', () => {
      s.off('error', reject);
      resolve(s);
    });
  });

/** What one transfer reports for `wire.files`: bytes moved, or the error it ended with. */
type Done = { bytes?: number; error?: string };
const fail = (res: ServerResponse, e: ApiError): Done => (sendError(res, e), { error: e.code });

export function filesHandler(host: HostLink, now = () => Date.now(), emit?: WireEmit) {
  const idem = new Map<string, { at: number; status: number; body: unknown }>();

  return async function handle(req: IncomingMessage, res: ServerResponse, sessionId: string, op_: string, query: URLSearchParams) {
    const auth = authenticate(host.key, req.headers, now());
    if ('status' in auth) {
      if (auth.status === 503) res.setHeader('retry-after', '2');
      const code = auth.status === 503 ? 'computer_unavailable' : auth.status === 401 ? 'unauthenticated' : 'forbidden';
      return sendError(res, err(code, auth.reason, auth.status, { retryAfterMs: auth.status === 503 ? 2000 : undefined }));
    }
    const { claims } = auth;
    const write = req.method === 'PUT';
    const routes: Record<string, boolean> = { 'GET archive': true, 'PUT archive': true, 'GET file': true, 'GET files': true };
    if (!routes[`${req.method} ${op_}`]) return sendError(res, err('not_found', 'No such route.', 404));
    const scope = scopeFor(write ? 'files.put' : 'files.get');
    if (!hasScope(claims.scope, scope)) return sendError(res, errors.missingScope(scope ?? ''));
    if (!isSessionId(sessionId) || !inTicket(claims.scope, sessionId)) return sendError(res, errors.sessionNotFound());
    const access = host.access(sessionId);
    if (!access || !mayAttach(access, claims.member)) return sendError(res, errors.sessionNotFound());
    if (write && claims.scope.readOnly) return sendError(res, errors.readOnly());

    const base = { sessionId, member: claims.member };
    const t0 = now();
    const op = op_ === 'archive' ? (write ? 'put' : 'get') : op_ === 'file' ? 'file' : 'list';
    const done = await transfer(req, res, base, op_, write, query, claims.member, sessionId);
    emit?.('wire.files', {
      session_key: sessionId, person_id: claims.member, op, bytes: done.bytes, duration_ms: now() - t0,
      outcome: done.error ? 'failed' : 'completed', error_code: done.error,
    });
  };

  /** Run one authorised request; never throws. */
  async function transfer(
    req: IncomingMessage, res: ServerResponse, base: { sessionId: string; member: string }, op: string, write: boolean, query: URLSearchParams, member: string, sessionId: string,
  ): Promise<Done> {
    try {
      if (op === 'files') {
        const path = relativePath(query.get('path'));
        if (path === undefined) return fail(res, invalidPath());
        const num = (k: string) => (query.has(k) ? Number(query.get(k)) : undefined);
        const depth = num('depth');
        const limit = num('limit');
        if (depth !== undefined && !(Number.isInteger(depth) && depth >= 1 && depth <= 10)) return fail(res, errors.invalidParams('depth', 'depth is 1 to 10'));
        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) return fail(res, errors.invalidParams('limit', 'limit is 1 to 100'));
        const r = await host.call({ t: 'files.list', ...base, path, depth, limit, cursor: query.get('cursor') ?? undefined });
        if (r.error) return fail(res, r.error);
        sendJson(res, 200, r.result);
        return {};
      }
      if (op === 'file') return await getFile(req, res, base, query);
      if (!write) return await getArchive(req, res, base, query);

      const name = query.get('path') ?? '';
      if (!UPLOAD_NAME.test(name) || name.startsWith('.')) return fail(res, invalidPath('path is one level: letters, digits, ".", "-" and "_", not starting with "."'));
      const key = req.headers['idempotency-key'];
      const ik = typeof key === 'string' && key ? `${member} ${sessionId} ${key}` : undefined;
      const seen = ik ? idem.get(ik) : undefined;
      if (seen && now() - seen.at < IDEM_MS) {
        req.resume();
        sendJson(res, seen.status, seen.body);
        return {};
      }
      const enc = (req.headers['content-encoding'] ?? 'identity').toLowerCase();
      const format = enc === 'zstd' ? 'tar+zstd' : enc === 'gzip' ? 'tar+gzip' : enc === 'identity' ? 'tar' : undefined;
      if (!format) return fail(res, errors.invalidParams('content-encoding', 'content-encoding is zstd, gzip or none'));
      const length = Number(req.headers['content-length']);
      const call = host.callFiles({ t: 'files.put', ...base, path: name, format, bytes: Number.isFinite(length) ? length : undefined });
      const first = await call.first;
      if (first.error) return fail(res, first.error);
      const sock = await connect((first.result as { socket: string }).socket);
      await pipeline(req, sock).catch(() => sock.destroy());
      const done = await call.done;
      if (done.error) return fail(res, done.error);
      if (ik) {
        idem.set(ik, { at: now(), status: 200, body: done.result });
        for (const [k, v] of idem) if (idem.size > IDEM_MAX || now() - v.at > IDEM_MS) idem.delete(k);
      }
      sendJson(res, 200, done.result);
      return { bytes: sock.bytesWritten };
    } catch {
      return fail(res, errors.internal());
    }
  }

  async function getArchive(req: IncomingMessage, res: ServerResponse, base: { sessionId: string; member: string }, query: URLSearchParams): Promise<Done> {
    const path = relativePath(query.get('path'));
    if (path === undefined) return fail(res, invalidPath());
    const call = host.callFiles({ t: 'files.get', ...base, path });
    const first = await call.first;
    if (first.error) return fail(res, first.error);
    const sock = await connect((first.result as { socket: string }).socket);
    const encoding = pickEncoding(req.headers['accept-encoding']);
    res.writeHead(200, { 'content-type': 'application/x-tar', ...(encoding ? { 'content-encoding': encoding } : {}), vary: 'accept-encoding' });
    const z = encoding === 'zstd' ? zlib.createZstdCompress() : encoding === 'gzip' ? zlib.createGzip({ level: 4 }) : undefined;
    const streamed = (z ? pipeline(sock, z, res) : pipeline(sock, res)).then(
      () => true,
      () => false,
    );
    const [ok, done] = await Promise.all([streamed, call.done]);
    if (!ok || done.error) res.destroy();
    return ok && !done.error ? { bytes: sock.bytesRead } : { bytes: sock.bytesRead, error: done.error?.code ?? 'aborted' };
  }

  async function getFile(req: IncomingMessage, res: ServerResponse, base: { sessionId: string; member: string }, query: URLSearchParams): Promise<Done> {
    const path = relativePath(query.get('path'));
    if (!path) return fail(res, path === '' ? err('path_not_found', 'No file at path.', 404) : invalidPath());
    const call = host.callFiles({ t: 'files.get', ...base, path, file: true });
    const first = await call.first;
    if (first.error) return fail(res, first.error);
    const r = first.result as { socket: string; size: number; etag: string; contentType?: string };
    if (req.headers['if-none-match'] === r.etag) {
      // Not read: dialling and closing tells the host the transfer is over.
      (await connect(r.socket).catch(() => undefined))?.destroy();
      res.writeHead(304, { etag: r.etag });
      res.end();
      return { bytes: 0 };
    }
    const sock = await connect(r.socket);
    res.writeHead(200, { 'content-type': r.contentType ?? 'application/octet-stream', 'content-length': r.size, etag: r.etag });
    const ok = await pipeline(sock, res).then(
      () => true,
      () => false,
    );
    const done = await call.done;
    if (!ok || done.error) res.destroy();
    return ok && !done.error ? { bytes: sock.bytesRead } : { bytes: sock.bytesRead, error: done.error?.code ?? 'aborted' };
  }
}
