// The host's preview proxy (work 074): cloudflared's one ingress rule points
// here, and it forwards a previews Worker request to the session's server on
// 127.0.0.1:<X-Preview-Port>, WebSocket upgrades (HMR) and streamed bodies
// (SSE) included.
//
// Invariants: it dials only loopback, only a port in the config's allow-list
// that is not one of the host's own, and only for a request whose
// X-Preview-Auth verifies (src/signed-header.ts). Every response it produces,
// proxied ones too, carries `X-Preview-Origin: computer`, the one signal the
// Worker trusts; a closed port is a 503 with `X-Preview-State: closed`, which
// the Worker turns into its "nothing is listening" page. No x-preview-* header
// reaches the app, and none of the app's reaches the Worker.

import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { PreviewConfig } from '../protocol.js';
import { log } from '../log.js';
import { verifyPreview } from '../signed-header.js';

export const PREVIEW_PROXY_PORT = 7070;
/** The proxy itself, and cloudflared's default metrics ports. */
export const HOST_PORTS = [PREVIEW_PROXY_PORT, 20241, 20242, 20243, 20244, 20245];
const MARKER = ['X-Preview-Origin', 'computer'];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

type Check = { port: number; headers: http.OutgoingHttpHeaders } | { status: number; error: string; state?: string };

/** Whether the request may reach a port, and the headers the app gets. */
export function checkRequest(req: http.IncomingMessage, config: PreviewConfig | undefined, refused: number[], now = Date.now()): Check {
  if (!config) return { status: 503, error: 'previews are not configured on this computer' };
  const raw = String(req.headers['x-preview-port'] ?? '');
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  if (!config.ports.includes(port) || refused.includes(port)) {
    log.warn(`preview proxy: refused port ${raw.slice(0, 16) || '(none)'}`);
    return { status: 403, error: 'port not previewed' };
  }
  if (!verifyPreview(config.key, port, req.headers['x-preview-auth'] as string | undefined, now))
    return { status: 403, error: 'bad or expired signature' };
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith('x-preview-') && v !== undefined) headers[k] = v;
  const host = req.headers['x-preview-host'];
  if (typeof host === 'string' && host) headers.host = headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = 'https';
  return { port, headers };
}

/** An upstream's raw headers without x-preview-* (and, for a hand-written head, framing), plus the marker. */
function marked(raw: string[], drop: (k: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    if (!k.startsWith('x-preview-') && !drop(k)) out.push(raw[i], raw[i + 1]);
  }
  return [...out, ...MARKER];
}

const closedState = (e: NodeJS.ErrnoException) => (e.code === 'ECONNREFUSED' ? { status: 503, error: 'nothing is listening', state: 'closed' }
  : { status: 502, error: 'the server did not answer' });

function refuse(res: http.ServerResponse, c: { status: number; error: string; state?: string }) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(c.status, [...MARKER, ...(c.state ? ['X-Preview-State', c.state] : []), 'Content-Type', 'text/plain; charset=utf-8']);
  res.end(`${c.error}\n`);
}

function refuseSocket(socket: Duplex, c: { status: number; error: string; state?: string }) {
  const state = c.state ? `X-Preview-State: ${c.state}\r\n` : '';
  socket.end(`HTTP/1.1 ${c.status} ${http.STATUS_CODES[c.status]}\r\n${MARKER.join(': ')}\r\n${state}Connection: close\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(c.error) + 1}\r\n\r\n${c.error}\n`);
}

const head = (status: number | undefined, message: string | undefined, raw: string[]) => {
  let s = `HTTP/1.1 ${status} ${message ?? ''}\r\n`;
  for (let i = 0; i < raw.length; i += 2) s += `${raw[i]}: ${raw[i + 1]}\r\n`;
  return `${s}\r\n`;
};

/** The proxy; `config` is read per request, so a `previews` frame applies at once. */
export function previewProxy(config: () => PreviewConfig | undefined, refused = HOST_PORTS): http.Server {
  const server = http.createServer((req, res) => {
    const c = checkRequest(req, config(), refused);
    if ('status' in c) return refuse(res, c);
    for (const k of HOP) delete c.headers[k];
    const up = http.request({ host: '127.0.0.1', port: c.port, method: req.method, path: req.url, headers: c.headers }, (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.statusMessage, marked(ures.rawHeaders, (k) => HOP.has(k)));
      res.flushHeaders(); // an SSE stream's headers leave before its first event
      ures.pipe(res);
      ures.on('error', () => res.destroy());
    });
    up.on('error', (e) => refuse(res, closedState(e)));
    res.on('close', () => res.writableFinished || up.destroy());
    req.pipe(up);
  });

  server.on('upgrade', (req, socket: Duplex, first: Buffer) => {
    socket.on('error', () => {});
    const c = checkRequest(req, config(), refused);
    if ('status' in c) return refuseSocket(socket, c);
    const up = http.request({ host: '127.0.0.1', port: c.port, method: req.method, path: req.url, headers: c.headers });
    up.on('upgrade', (ures, usock, uhead) => {
      socket.write(head(ures.statusCode, ures.statusMessage, marked(ures.rawHeaders)));
      if (uhead.length) socket.write(uhead);
      if (first.length) usock.write(first);
      usock.on('error', () => socket.destroy());
      socket.on('error', () => usock.destroy());
      usock.pipe(socket).pipe(usock);
    });
    // The app answered without upgrading: pass that answer on, then close.
    up.on('response', (ures) => {
      socket.write(head(ures.statusCode, ures.statusMessage, [...marked(ures.rawHeaders, (k) => HOP.has(k) || k === 'content-length'),
        'Connection', 'close']));
      ures.pipe(socket);
    });
    up.on('error', (e) => refuseSocket(socket, closedState(e)));
    socket.on('close', () => up.destroy());
    up.end();
  });
  return server;
}
