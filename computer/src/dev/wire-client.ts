// The relay's side of the host's wire socket, for dev checks (the real one is
// src/wire/host-link.ts): `hello`, calls answered by `result`, a terminal run
// to its exit, and `/files` list, get and put with their one-shot sockets,
// also cut short.
//
// Invariants: it checks nothing a relay would (no member, key or scope): it
// is the trusted peer the host takes a relay for, so what it is refused, the
// host refused. Run it as a user that may open the socket (the host's own).

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { ApiError, HostToWire } from '../protocol.js';
import { lines, send } from '../ipc.js';

type Outcome<T> = { result?: T; error?: ApiError };

export interface WireClient {
  call<T = unknown>(m: { t: string } & Record<string, unknown>): Promise<Outcome<T>>;
  /** Run `command` in the session's terminal (no tty) to its exit: what it wrote, or why it did not open. */
  terminal(sessionId: string, member: string, command: string): Promise<{ out: string; exitCode: number | null } | { error: ApiError }>;
  /** Upload a tar as the top-level name `path`. */
  put(sessionId: string, member: string, path: string, tar: Buffer): Promise<Outcome<{ upload: { path: string; files: number; bytes: number } }>>;
  /** One file's bytes (`file`), or a directory's tar. */
  get(sessionId: string, member: string, path: string, file: boolean): Promise<{ body: Buffer } | { error: ApiError }>;
  /** An upload that says `tar.length` bytes come and hangs up after `sent` of them: how the host ended it. */
  putCut(sessionId: string, member: string, path: string, tar: Buffer, sent: number): Promise<Outcome<unknown>>;
  /** A download whose reader hangs up at its first bytes: how many came. */
  getCut(sessionId: string, member: string, path: string, file: boolean): Promise<{ got: number } | { error: ApiError }>;
  close(): void;
}

const drain = (socket: string, write?: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const c = net.connect(socket, () => write && c.end(write));
    c.on('data', (d: Buffer) => chunks.push(d)).on('close', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });

export async function wireClient(socket: string): Promise<WireClient> {
  const waiting = new Map<string, (m: Outcome<unknown>) => void>();
  const done = new Map<string, (m: Outcome<unknown>) => void>();
  const exits = new Map<string, (code: number | null) => void>();
  const sock = net.connect(socket);
  await new Promise<void>((resolve, reject) => sock.once('connect', resolve).once('error', reject));
  sock.on('error', () => {});
  lines(sock, (m: HostToWire) => {
    if (m.t === 'result') waiting.get(m.id)?.(m);
    else if (m.t === 'files.done') done.get(m.id)?.(m);
    else if (m.t === 'terminal.exited') exits.get(m.terminalId)?.(m.exitCode);
  });
  send(sock, { t: 'hello', version: 'dev-check' });

  function ask<T>(m: { t: string } & Record<string, unknown>, id: string = randomUUID()): Promise<Outcome<T>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: { code: 'timeout', message: `no answer to ${m.t} in 60 s`, status: 504 } as ApiError }), 60_000);
      waiting.set(id, (r) => (clearTimeout(timer), waiting.delete(id), resolve(r as Outcome<T>)));
      send(sock, { ...m, id });
    });
  }
  const finished = (id: string) => new Promise<Outcome<unknown>>((resolve) => done.set(id, (r) => (done.delete(id), resolve(r))));

  return {
    call: (m) => ask(m),
    async terminal(sessionId, member, command) {
      const r = await ask<{ terminalId: string; socket: string }>({ t: 'terminal.open', sessionId, member, cols: 80, rows: 24, command, tty: false });
      if (!r.result) return { error: r.error as ApiError };
      const exited = new Promise<number | null>((resolve) => exits.set(r.result!.terminalId, resolve));
      const out = await drain(r.result.socket);
      return { out: out.toString('utf8'), exitCode: await exited };
    },
    async put(sessionId, member, path, tar) {
      const id = randomUUID();
      const end = finished(id);
      const r = await ask<{ socket: string }>({ t: 'files.put', sessionId, member, path, format: 'tar', bytes: tar.length }, id);
      if (!r.result) return { error: r.error };
      await drain(r.result.socket, tar);
      return (await end) as Outcome<{ upload: { path: string; files: number; bytes: number } }>;
    },
    async get(sessionId, member, path, file) {
      const id = randomUUID();
      const end = finished(id);
      const r = await ask<{ socket: string }>({ t: 'files.get', sessionId, member, path, file }, id);
      if (!r.result) return { error: r.error as ApiError };
      const body = await drain(r.result.socket);
      const d = await end;
      return d.error ? { error: d.error } : { body };
    },
    async putCut(sessionId, member, path, tar, sent) {
      const id = randomUUID();
      const end = finished(id);
      const r = await ask<{ socket: string }>({ t: 'files.put', sessionId, member, path, format: 'tar', bytes: tar.length }, id);
      if (!r.result) return { error: r.error };
      const c = net.connect(r.result.socket, () => c.write(tar.subarray(0, sent), () => setTimeout(() => c.destroy(), 1000)));
      c.on('error', () => {});
      return end;
    },
    async getCut(sessionId, member, path, file) {
      const r = await ask<{ socket: string }>({ t: 'files.get', sessionId, member, path, file });
      if (!r.result) return { error: r.error as ApiError };
      const c = net.connect(r.result.socket);
      return new Promise((resolve) => c.once('data', (d: Buffer) => (c.destroy(), resolve({ got: d.length }))).once('error', () => resolve({ got: 0 })).once('end', () => resolve({ got: 0 })));
    },
    close: () => sock.destroy(),
  };
}
