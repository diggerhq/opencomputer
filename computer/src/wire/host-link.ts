// The relay's side of the host's wire socket (WireToHost / HostToWire,
// src/protocol-api.ts; the host serves it in host/wire-link.ts): `hello`, then
// calls answered by `result` and pushes (the edge key, access lists, admins,
// revocations, writer moves, terminal exits, files outcomes).
//
// Invariants: the link redials forever with backoff (the host restarts on its
// own schedule); what the host pushed survives a redial until the next
// `welcome` replaces it, so connected clients keep working; a call made
// while the host is away fails at once with `unavailable` (retryable).

import net from 'node:net';
import type { ApiError, HostToWire, SessionAccess, WireToHost } from '../protocol.js';
import { log } from '../log.js';
import { ndjson, writeLine } from './ndjson.js';
import { errors } from './rpc.js';

const MAX_LINE = 4 * 1024 * 1024;

export type HostCall = Extract<WireToHost, { id: string }> | WireFilesList;
/** `/files` listing (`GET …/workspace/files`): not in protocol v4 yet (requested from the lead); answered by `result`. */
export interface WireFilesList {
  t: 'files.list';
  id: string;
  sessionId: string;
  member: string;
  path: string;
  depth?: number;
  limit?: number;
  cursor?: string;
}
type Outcome = { result?: unknown; error?: ApiError };
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface HostPushes {
  /** A `welcome` replaced the key, the admins and every access list. */
  welcome(): void;
  access(access: SessionAccess): void;
  admins(): void;
  revoked(keyId: string): void;
  moved(sessionId: string): void;
  terminalExited(m: Extract<HostToWire, { t: 'terminal.exited' }>): void;
}

export interface HostLink {
  readonly key: string | null;
  readonly admins: ReadonlySet<string>;
  access(sessionId: string): SessionAccess | undefined;
  /** The access list, waiting up to `ms` for one to arrive (a session being created). */
  waitAccess(sessionId: string, ms: number): Promise<SessionAccess | undefined>;
  call(frame: WithoutId<HostCall>, timeoutMs?: number): Promise<Outcome>;
  /** For `files.put`/`files.get`: the immediate `result`, and the `files.done` that follows it. */
  callFiles(frame: WithoutId<Extract<WireToHost, { t: 'files.put' | 'files.get' }>>): { first: Promise<Outcome>; done: Promise<Outcome> };
  telemetry(name: string, fields: Record<string, number | string | boolean | undefined>): void;
  readonly connected: boolean;
  close(): void;
}

export function connectHost(socketPath: string, version: string, push: HostPushes): HostLink {
  let sock: net.Socket | undefined;
  let up = false;
  let stopped = false;
  let backoff = 100;
  let next = 0;
  let key: string | null = null;
  let admins = new Set<string>();
  const access = new Map<string, SessionAccess>();
  const pending = new Map<string, (o: Outcome) => void>();
  const filesDone = new Map<string, (o: Outcome) => void>();
  const waiting = new Map<string, Set<() => void>>();

  const fail = () => {
    for (const done of [...pending.values(), ...filesDone.values()]) done({ error: errors.unavailable() });
    pending.clear();
    filesDone.clear();
  };

  const setAccess = (a: SessionAccess) => {
    access.set(a.sessionId, a);
    for (const w of waiting.get(a.sessionId) ?? []) w();
  };

  function dial() {
    if (stopped) return;
    const s = net.connect(socketPath);
    sock = s;
    s.on('connect', () => {
      up = true;
      backoff = 100;
      writeLine(s, { t: 'hello', version } satisfies WireToHost);
      log.info('wire: host link up');
    });
    s.on('error', (e: NodeJS.ErrnoException) => {
      if (up) log.warn(`wire: host link: ${e.code ?? e.message}`);
    });
    s.on('close', () => {
      if (up) log.warn('wire: host link down; redialling');
      up = false;
      fail();
      if (!stopped) setTimeout(dial, backoff).unref();
      backoff = Math.min(backoff * 2, 2000);
    });
    ndjson(s, MAX_LINE, (raw) => {
      const m = raw as HostToWire;
      switch (m.t) {
        case 'welcome':
          key = m.key;
          admins = new Set(m.admins);
          access.clear();
          for (const a of m.access) setAccess(a);
          return push.welcome();
        case 'access':
          setAccess(m.access);
          return push.access(m.access);
        case 'admins':
          admins = new Set(m.admins);
          return push.admins();
        case 'revoked':
          return push.revoked(m.keyId);
        case 'moved':
          return push.moved(m.sessionId);
        case 'terminal.exited':
          return push.terminalExited(m);
        case 'result': {
          const done = pending.get(m.id);
          pending.delete(m.id);
          return done?.({ result: m.result, error: m.error });
        }
        case 'files.done': {
          const done = filesDone.get(m.id);
          filesDone.delete(m.id);
          return done?.({ result: m.result, error: m.error });
        }
      }
    });
  }
  dial();

  const call = (frame: WithoutId<HostCall>, timeoutMs = 15_000) =>
    new Promise<Outcome>((done) => {
      if (!up) return done({ error: errors.unavailable() });
      const id = `w${++next}`;
      const timer = setTimeout(() => pending.delete(id) && done({ error: errors.unavailable() }), timeoutMs);
      timer.unref();
      pending.set(id, (o) => (clearTimeout(timer), done(o)));
      writeLine(sock, { ...frame, id } as HostCall);
    });

  return {
    get key() {
      return key;
    },
    get admins() {
      return admins;
    },
    get connected() {
      return up;
    },
    access: (id) => access.get(id),
    waitAccess(sessionId, ms) {
      const now = access.get(sessionId);
      if (now || ms <= 0) return Promise.resolve(now);
      return new Promise((resolve) => {
        const set = waiting.get(sessionId) ?? new Set();
        waiting.set(sessionId, set);
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          if (!set.size) waiting.delete(sessionId);
          resolve(access.get(sessionId));
        };
        const timer = setTimeout(done, ms);
        set.add(done);
      });
    },
    call,
    callFiles(frame) {
      if (!up) return { first: Promise.resolve({ error: errors.unavailable() }), done: Promise.resolve({ error: errors.unavailable() }) };
      const id = `f${++next}`;
      const done = new Promise<Outcome>((r) => filesDone.set(id, r));
      const first = new Promise<Outcome>((r) => pending.set(id, r));
      writeLine(sock, { ...frame, id } as WireToHost);
      return { first, done };
    },
    telemetry: (name, fields) => void writeLine(up ? sock : undefined, { t: 'telemetry', name, fields: fields as Record<string, number | string | boolean> } satisfies WireToHost),
    close() {
      stopped = true;
      sock?.destroy();
    },
  };
}
