// The relay's server (work 084, "The relay"): an HTTP listener on loopback
// that the computer's tunnel routes `<tunnelId>.w.opencomputer.dev` to.
// `/connect` upgrades to the client WebSocket (connection.ts), `/files/…` is
// the workspace routes (files.ts), `/health` says whether the host link is up.
// It holds the registry the host's pushes fan out over: connections by member
// and key, and terminals by id.
//
// Invariants:
// - Nothing is upgraded without a valid edge signature: 401 before the upgrade
//   when X-Wire-Auth is missing, malformed or expired (checked before the key,
//   so unsigned local callers never get a handshake), 403 when it does not
//   verify. With no key from the host yet, only a well-formed signed upgrade
//   is accepted and closed with 4503, so the Worker's client sees a retryable
//   code rather than 1006 (a browser cannot read an HTTP 503 on a WebSocket).
// - Refusals after authentication are accept-then-close with the docs' codes:
//   4400 without `opc.v1`, 4029 over 50 connections per member.
// - The relay keeps no state worth saving: restarting it closes every
//   connection (1012) and clients reconnect and re-attach after their seq.

import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { log } from '../log.js';
import { authenticate } from './edge-auth.js';
import { Connection, type UrlAttach } from './connection.js';
import { filesHandler } from './files.js';
import { connectHost, type HostLink } from './host-link.js';
import { closeCode } from '../api/wire-events.js';
import { LIMITS, TokenBucket } from './limits.js';
import type { WireEmit } from './telemetry.js';
import type { WireTerminals } from './terminal.js';
import { type DialWriter, dialWriter } from './writer-client.js';

export const PROTOCOL = 'opc.v1';

export interface RelayOptions {
  host: string;
  port: number;
  /** The host's wire socket (`<HOST_RUN>/wire/wire.sock`). */
  socket: string;
  version: string;
  region: string | null;
  dial?: DialWriter;
  pingMs?: number;
  telemetryMs?: number;
}

export interface Relay {
  readonly port: number;
  readonly hostLink: HostLink;
  connections(): number;
  /** Close every connection with `code` (1012 on restart) and stop listening. */
  close(code?: number): Promise<void>;
}

/** `?attach=…&after=…&tailTurns=…&deltas=1&resume=1`, `after`/`tailTurns` paired by position. */
export function urlAttaches(q: URLSearchParams): UrlAttach[] {
  const ids = q.getAll('attach');
  const after = q.getAll('after');
  const tail = q.getAll('tailTurns');
  const num = (s: string | undefined) => (s === undefined || s === '' || !/^\d+$/.test(s) ? undefined : Number(s));
  return ids.map((sessionId, i) => ({
    sessionId,
    after: num(after[i]),
    tailTurns: num(after[i]) === undefined ? num(tail[i]) : undefined,
    deltas: q.get('deltas') === '1',
    resume: q.get('resume') === '1',
  }));
}

export async function startRelay(o: RelayOptions): Promise<Relay> {
  const conns = new Set<Connection>();
  const perMember = new Map<string, number>();
  const terminals = new Map<string, WireTerminals>();
  // Telemetry (catalog v2): each event goes to the host as it happens; refusals before auth at most 10 a second.
  const refusals = new TokenBucket(10, 10);

  const hostLink = connectHost(o.socket, o.version, {
    welcome: () => {
      for (const c of conns) c.recheckAccess((sid) => hostLink.access(sid));
    },
    access: (a) => {
      for (const c of conns) c.accessChanged(a);
    },
    admins: () => {},
    revoked: (keyId) => {
      for (const c of [...conns]) c.revoked(keyId);
    },
    moved: (sid) => {
      for (const c of conns) c.moved(sid);
    },
    terminalExited: (m) => terminals.get(m.terminalId)?.exited(m),
  });
  const emit: WireEmit = (name, fields) => hostLink.telemetry(name, fields);
  const refused = (status: number) => refusals.take() === 0 && emit('wire.refused', { status });
  const files = filesHandler(hostLink, undefined, emit);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxMessageBytes,
    perMessageDeflate: false,
    // Without opc.v1 the client's first offer is echoed so the handshake completes and the client sees 4400, not 1006.
    handleProtocols: (offered) => (offered.has(PROTOCOL) ? PROTOCOL : (offered.values().next().value ?? false)),
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    const m = url.pathname.match(/^\/files\/([^/]+)\/([a-z]+)$/);
    if (m) return void files(req, res, m[1], m[2], url.searchParams);
    if (url.pathname === '/health') {
      res.writeHead(hostLink.connected ? 200 : 503, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ host: hostLink.connected, key: hostLink.key !== null, connections: conns.size }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'No such route.', status: 404 } }));
  });

  const refuse = (sock: Duplex, status: number, reason: string) => {
    refused(status);
    sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
  };

  server.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname !== '/connect') return refuse(sock, 404, 'not found');
    const auth = authenticate(hostLink.key, req.headers);
    if ('status' in auth && auth.status !== 503) return refuse(sock, auth.status, auth.reason);
    wss.handleUpgrade(req, sock, head, (ws) => {
      const closeWith = (code: number, reason: string) => {
        refused(code);
        ws.close(code, reason);
      };
      if ('status' in auth) return closeWith(4503, JSON.stringify({ retryAfterMs: 2000 }));
      if (ws.protocol !== PROTOCOL) return closeWith(4400, 'offer opc.v1');
      const { member } = auth.claims;
      const n = perMember.get(member) ?? 0;
      if (n >= LIMITS.maxConnectionsPerMember) return closeWith(4029, 'more than 50 connections');
      perMember.set(member, n + 1);
      const c = new Connection(ws, auth.claims, {
        host: hostLink,
        dial: o.dial ?? dialWriter,
        version: o.version,
        region: o.region,
        pingMs: o.pingMs,
        emit,
        forward: (name, fields) => hostLink.telemetry(name, fields),
        routeTerminal: (id, to) => (to ? terminals.set(id, to) : terminals.delete(id)),
        closed: (gone) => {
          conns.delete(gone);
          const left = (perMember.get(member) ?? 1) - 1;
          if (left > 0) perMember.set(member, left);
          else perMember.delete(member);
        },
      });
      emit('wire.connect', { connection_id: c.id, person_id: member });
      ws.on('close', (code) => emit('wire.close', { connection_id: c.id, person_id: member, code: closeCode(code), ...c.totals() }));
      conns.add(c);
      c.start(urlAttaches(url.searchParams));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  log.info(`wire: relay listening on ${o.host}:${port}`);
  // Gauges only, read now; nothing while no one is connected.
  const sample = setInterval(() => {
    if (!conns.size) return;
    let attached = 0;
    let queued = 0;
    for (const c of conns) {
      attached += c.attachedCount;
      queued = Math.max(queued, c.outbox.unsent);
    }
    emit('wire.sample', { connections: conns.size, members: perMember.size, attached, terminals: terminals.size, queued_bytes_max: queued });
  }, o.telemetryMs ?? 60_000);
  sample.unref?.();

  return {
    port,
    hostLink,
    connections: () => conns.size,
    async close(code = 1012) {
      clearInterval(sample);
      for (const c of [...conns]) c.close(code, 'relay restarting');
      wss.close();
      hostLink.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
