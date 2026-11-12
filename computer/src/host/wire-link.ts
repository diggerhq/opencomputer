// The host's side of the relay's local socket (work 084; WireToHost /
// HostToWire in src/protocol-api.ts; the relay is src/wire/host-link.ts):
// `<dir>/wire.sock`, one JSON object per line. The host answers `where`,
// `resume`, terminals and `/files`, and pushes what the relay needs to check
// clients by itself: the edge key, admins, access lists, revocations, and
// writer moves.
//
// Invariants:
// - `<dir>` is 0710 and wire.sock 0660, group `group` (sp-wire) when given:
//   only the host and the relay reach them, never the agent.
// - Nothing but `hello` is answered before `hello`; every `hello` gets a full
//   `welcome`, so a relay that restarts starts from the current state.
// - A terminal belongs to the relay connection that opened it: when that
//   connection drops, its terminals are hung up.
// - The host checks again what the relay checked (owner or admin for a
//   terminal; the session is one this host runs), so a confused relay cannot
//   open a shell in someone else's session.
// - terminal.opened / terminal.closed / files.pushed are recorded through
//   `record` when the host provides it; without it they are not journaled.

import { chmodSync, chownSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ApiActor, ApiError, ApiSessionStatus, HostToWire, SessionAccess, WhereResult, WireToHost } from '../protocol.js';
import { apiError } from '../api/writer.js';
import { lines, send } from '../ipc.js';
import { log } from '../log.js';
import { HOST_RUN } from '../protocol.js';
import { oneShotSocket } from './one-shot-socket.js';
import type { Terminals } from './terminal.js';
import type { WorkspaceFiles } from './workspace-files.js';

export const WIRE_DIR = path.join(HOST_RUN, 'wire');

type Workspace = { forkPath: string; owner: string };
type Refusable = Workspace | { error: ApiError } | undefined;

export interface WireLinkHooks {
  /** The session's writer, if this host runs the session. */
  where(sessionId: string): WhereResult | undefined | Promise<WhereResult | undefined>;
  /** Start the session's runner if it is suspended (attach with resume=1). */
  resume(sessionId: string, actor: ApiActor): Promise<{ status: ApiSessionStatus } | { error: ApiError }>;
  /**
   * The session's fork and owner (`usr_…`), asked before a terminal or `/files` acts in it; undefined: not a session
   * this host runs, or no fork yet; an error: the host refuses that there (work 103: a session in a container).
   */
  workspace(sessionId: string, what: 'terminal' | 'files'): Refusable | Promise<Refusable>;
  /** Record an event in the session's log through its writer; resolves with its seq. */
  record?(sessionId: string, type: 'terminal.opened' | 'terminal.closed' | 'files.pushed', data: unknown, actor: ApiActor): Promise<number | undefined>;
  /** One relay telemetry event (`wire.*`, or an opc `cli.*` event), checked and emitted by api-meter.ts. */
  telemetry?(name: string, fields: Record<string, number | string | boolean>): void;
  /** The number of open terminals of a session changed: while > 0 it is exempt from idle suspend. */
  terminalsChanged?(sessionId: string, open: number): void;
}

export interface WireLink {
  readonly socket: string;
  setKey(key: string | null): void;
  setAccess(access: SessionAccess): void;
  setAdmins(admins: string[]): void;
  revoked(keyId: string): void;
  moved(sessionId: string): void;
  /** An explicit suspend closes the session's terminals. */
  closeTerminals(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

/** `files.list`: the relay's extension frame until protocol-api.ts carries it (see src/wire/host-link.ts). */
type FilesList = { t: 'files.list'; id: string; sessionId: string; member: string; path: string; depth?: number; limit?: number; cursor?: string };
type Inbound = WireToHost | FilesList;

const memberActor = (member: string): ApiActor => ({ id: member, name: null, via: 'api', client: null });
const sessionNotFound = () => apiError('session_not_found', 'No such session on this computer.', 404);
const terminalNotFound = () => apiError('terminal_not_found', 'No such terminal.', 404);

export async function serveWireLink(hooks: WireLinkHooks, o: { dir?: string; group?: number; terminals: Terminals; files: WorkspaceFiles }): Promise<WireLink> {
  const dir = o.dir ?? WIRE_DIR;
  const filesDir = path.join(dir, 'files');
  for (const d of [dir, filesDir]) {
    mkdirSync(d, { recursive: true, mode: 0o710 });
    if (o.group !== undefined) chownSync(d, -1, o.group);
    chmodSync(d, 0o710);
  }
  const socket = path.join(dir, 'wire.sock');
  rmSync(socket, { force: true });

  let key: string | null = null;
  let admins: string[] = [];
  const access = new Map<string, SessionAccess>();
  const peers = new Set<net.Socket>();
  /** terminal id → its session and the relay connection that opened it. */
  const terms = new Map<string, { sessionId: string; peer: net.Socket }>();

  const welcome = (): HostToWire => ({ t: 'welcome', key, admins, access: [...access.values()] });
  const push = (m: HostToWire) => {
    for (const p of peers) send(p, m);
  };
  const changed = (sessionId: string) => hooks.terminalsChanged?.(sessionId, o.terminals.count(sessionId));

  async function onCall(peer: net.Socket, m: Inbound): Promise<{ result?: unknown; error?: ApiError } | undefined> {
    switch (m.t) {
      case 'where': {
        const w = await hooks.where(m.sessionId);
        return w ? { result: w } : { error: sessionNotFound() };
      }
      case 'resume': {
        const r = await hooks.resume(m.sessionId, m.actor);
        return 'error' in r ? { error: r.error } : { result: r };
      }
      case 'terminal.open': {
        const ws = await hooks.workspace(m.sessionId, 'terminal');
        if (!ws) return { error: sessionNotFound() };
        if ('error' in ws) return { error: ws.error };
        if (m.member !== ws.owner && !admins.includes(m.member) && !access.get(m.sessionId)?.admins?.includes(m.member)) return { error: apiError('forbidden', "Only the session's owner or an admin can open a terminal.", 403, { reason: 'terminal_owner_only' }) };
        const r = await o.terminals.open(
          { sessionId: m.sessionId, cwd: ws.forkPath, cols: m.cols, rows: m.rows, command: m.command, tty: m.tty, term: m.term },
          (terminalId, exitCode, signal) => {
            const t = terms.get(terminalId);
            terms.delete(terminalId);
            if (t) send(t.peer, { t: 'terminal.exited', terminalId, exitCode, signal } satisfies HostToWire);
            changed(m.sessionId);
            void hooks.record?.(m.sessionId, 'terminal.closed', { terminalId, exitCode }, memberActor(m.member)).catch((e) => log.warn('wire: terminal.closed not recorded', e));
          },
        );
        if ('error' in r) return { error: r.error };
        terms.set(r.terminalId, { sessionId: m.sessionId, peer });
        changed(m.sessionId);
        void hooks.record?.(m.sessionId, 'terminal.opened', { terminalId: r.terminalId, command: m.command ?? null }, memberActor(m.member)).catch((e) => log.warn('wire: terminal.opened not recorded', e));
        return { result: r };
      }
      // Bound to the relay peer that opened the terminal: another peer gets "not found", as for an unknown id.
      case 'terminal.resize':
        if (terms.get(m.terminalId)?.peer !== peer) return { error: terminalNotFound() };
        return o.terminals.resize(m.terminalId, m.cols, m.rows) ? { result: {} } : { error: terminalNotFound() };
      case 'terminal.eof':
        if (terms.get(m.terminalId)?.peer !== peer) return { error: terminalNotFound() };
        return o.terminals.eof(m.terminalId) ? { result: {} } : { error: terminalNotFound() };
      case 'terminal.close':
        if (terms.get(m.terminalId)?.peer !== peer) return { error: terminalNotFound() };
        return o.terminals.close(m.terminalId) ? { result: {} } : { error: terminalNotFound() };
      case 'files.list': {
        const ws = await hooks.workspace(m.sessionId, 'files');
        if (!ws) return { error: sessionNotFound() };
        if ('error' in ws) return { error: ws.error };
        const r = await o.files.list({ sessionId: m.sessionId, forkPath: ws.forkPath }, m);
        return 'error' in r ? { error: r.error } : { result: r };
      }
      case 'files.get':
      case 'files.put':
        await transfer(peer, m);
        return undefined;
      case 'telemetry':
        hooks.telemetry?.(m.name, m.fields);
        return undefined;
      default:
        return { error: apiError('invalid_request', 'Unknown call.', 400) };
    }
  }

  /** `/files` get and put: `result {socket…}` now, `files.done` when the bytes have moved. */
  async function transfer(peer: net.Socket, m: Extract<WireToHost, { t: 'files.get' | 'files.put' }>) {
    const fail = (error: ApiError) => send(peer, { t: 'result', id: m.id, error } satisfies HostToWire);
    const ws = await hooks.workspace(m.sessionId, 'files');
    if (!ws) return fail(sessionNotFound());
    if ('error' in ws) return fail(ws.error);
    const where = { sessionId: m.sessionId, forkPath: ws.forkPath };
    let out: (() => { stream: Readable; done: Promise<void> }) | undefined;
    let extra: Record<string, unknown> = {};
    if (m.t === 'files.get') {
      const r = m.file ? await o.files.file(where, m.path) : await o.files.archive(where, m.path);
      if ('error' in r) return fail(r.error);
      out = r.read;
      if ('etag' in r) extra = { size: r.size, etag: r.etag, contentType: r.contentType };
    } else {
      const taken = await o.files.canUpload(where, m.path);
      if (taken) return fail(taken.error);
    }
    const shot = await oneShotSocket(filesDir, o.group);
    send(peer, { t: 'result', id: m.id, result: { socket: shot.socket, ...extra } } satisfies HostToWire);
    const done = (r: { result?: unknown; error?: ApiError }) => send(peer, { t: 'files.done', id: m.id, ...r } satisfies HostToWire);
    let conn: net.Socket;
    try {
      conn = await shot.connection;
    } catch {
      return done({ error: apiError('unavailable', 'The transfer was not picked up.', 503, { retryable: true }) });
    }
    conn.on('error', () => {});
    if (out) {
      const r = out();
      const ok = await pipeline(r.stream, conn).then(
        () => true,
        () => false,
      );
      const ended = await r.done.then(
        () => true,
        (e) => (log.warn('wire: files.get', e?.message ?? e), false),
      );
      return done(ok && ended ? { result: {} } : { error: apiError('internal', 'The transfer failed.', 500, { retryable: true }) });
    }
    if (m.t !== 'files.put') return;
    const actor = memberActor(m.member);
    const r = await o.files.upload(where, m.path, m.format, actor, conn);
    conn.destroy();
    if ('error' in r) return done({ error: r.error });
    const u = r.upload;
    const seq = await hooks
      .record?.(m.sessionId, 'files.pushed', { path: u.path, files: u.files, bytes: u.bytes, replaced: u.replaced !== null }, actor)
      .catch((e) => (log.warn('wire: files.pushed not recorded', e), undefined));
    done({ result: { upload: u, seq: seq ?? null } });
  }

  const server = net.createServer((peer) => {
    let hello = false;
    peers.add(peer);
    peer.on('error', () => {});
    peer.on('close', () => {
      peers.delete(peer);
      for (const [id, t] of terms) if (t.peer === peer) o.terminals.close(id);
    });
    lines(peer, async (m: Inbound) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        hello = true;
        log.info(`wire: relay ${String(m.version)} connected`);
        return send(peer, welcome());
      }
      if (!hello) return peer.destroy();
      const id = 'id' in m ? m.id : undefined;
      try {
        const r = await onCall(peer, m);
        if (r && id !== undefined) send(peer, { t: 'result', id, ...r } satisfies HostToWire);
      } catch (e) {
        log.warn(`wire: ${m.t} failed`, e);
        if (id !== undefined) send(peer, { t: 'result', id, error: apiError('internal', 'The host failed this call.', 500, { retryable: true }) } satisfies HostToWire);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });
  chmodSync(socket, 0o660);
  if (o.group !== undefined) chownSync(socket, -1, o.group);
  o.terminals.prewarm();

  return {
    socket,
    setKey(k) {
      if (k === key) return;
      key = k;
      push(welcome());
    },
    setAccess(a) {
      access.set(a.sessionId, a);
      push({ t: 'access', access: a });
    },
    setAdmins(a) {
      admins = [...a];
      push({ t: 'admins', admins });
    },
    revoked: (keyId) => push({ t: 'revoked', keyId }),
    moved: (sessionId) => push({ t: 'moved', sessionId }),
    closeTerminals: (sessionId) => o.terminals.closeSession(sessionId),
    async close() {
      for (const p of peers) p.destroy();
      await o.terminals.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(socket, { force: true });
    },
  };
}
