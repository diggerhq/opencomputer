// Terminals in a session's workspace, host side (work 084; opc docs
// websocket/terminals.mdx). Each runs terminal-pty.py as the agent user, in
// its own systemd unit `sp-term-<n>` when runners are launched that way, and
// is reached by the relay on a unix socket per stream under `dir`
// (`<id>.sock`, and `<id>.err.sock` with tty false), which this file serves
// and copies to and from the helper's framed stdio.
//
// Invariants:
// - At most 8 terminals per session, across connections (`too_many_terminals`).
// - The shell's environment is built here from a fixed list (HOME, USER,
//   LOGNAME, SHELL, PATH, LANG, TERM): no session secret, no BASH_ENV.
// - Each socket takes one connection (the relay's) and is removed when the
//   terminal ends; output that arrives before the relay connects is kept, up
//   to 1 MiB.
// - Closing hangs up (SIGHUP to the process group, SIGKILL after 5 s in the
//   helper); if the helper has not exited 6 s later its unit is stopped.
// - `onExit` runs once, after every socket has been ended.
// - One helper is kept started ahead (`prewarm`), so an open costs a frame,
//   not a process start.

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ApiError } from '../protocol.js';
import { apiError } from '../api/writer.js';
import { mintId } from '../session-ids.js';
import { log } from '../log.js';
import type { RunnerUser } from './runner-user.js';

export const TERMINALS_PER_SESSION = 8;
const PENDING_MAX = 1 << 20;
const STOP_AFTER_MS = 6000;
const HELPER = path.join(import.meta.dirname, 'terminal-pty.py');

export interface TerminalOpen {
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
  command?: string;
  tty: boolean;
  term?: string;
}

export type TerminalExit = (terminalId: string, exitCode: number | null, signal: string | null) => void;

export interface Terminals {
  open(o: TerminalOpen, onExit: TerminalExit): Promise<{ terminalId: string; socket: string; stderrSocket: string | null } | { error: ApiError }>;
  resize(terminalId: string, cols: number, rows: number): boolean;
  eof(terminalId: string): boolean;
  close(terminalId: string): boolean;
  count(sessionId: string): number;
  /** Hang up every terminal of a session (explicit suspend), resolved once they exited. */
  closeSession(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  /** Keep one helper started ahead. */
  prewarm(): void;
}

export interface TerminalsOptions {
  dir: string;
  launch: 'systemd' | 'detached';
  user?: RunnerUser;
  /** The systemd-run prefix runners use (`SP_SYSTEMD_RUN`, else runner-limits.ts). */
  systemdRun?: string;
  /** The PATH a shell gets (SP_RUNNER_PATH); else the user's, else the host's. */
  path?: string;
  /** gid that may connect to the sockets (sp-wire). */
  group?: number;
  python?: string;
}

interface Helper {
  proc: ChildProcess;
  unit: string | undefined;
  exited: Promise<void>;
}

interface Term {
  id: string;
  sessionId: string;
  helper: Helper;
  servers: net.Server[];
  out: Stream;
  err: Stream | undefined;
  onExit: TerminalExit;
  done: boolean;
  stopTimer?: NodeJS.Timeout;
}

/** One output stream toward the relay: its server's single accepted socket, or what waits for it. */
interface Stream {
  sock?: net.Socket;
  pending: Buffer[];
  pendingBytes: number;
  ended: boolean;
}

export function frame(kind: string, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Splits the helper's stdout into frames. */
export function frames(on: (kind: string, payload: Buffer) => void) {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) break;
      on(String.fromCharCode(buf[0]), buf.subarray(5, 5 + n));
      buf = buf.subarray(5 + n);
    }
  };
}

export function createTerminals(o: TerminalsOptions): Terminals {
  const terms = new Map<string, Term>();
  let warm: Helper | undefined;
  mkdirSync(o.dir, { recursive: true, mode: 0o710 });
  if (o.group !== undefined) {
    chownSync(o.dir, -1, o.group);
    chmodSync(o.dir, 0o710);
  }

  const shellEnv = (term?: string) => {
    const u = o.user?.env;
    const user = u?.USER ?? process.env.USER ?? 'agent';
    return {
      HOME: u?.HOME ?? process.env.HOME ?? '/',
      USER: user,
      LOGNAME: user,
      SHELL: u?.SHELL ?? process.env.SHELL ?? '/bin/bash',
      PATH: o.path ?? u?.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LANG: process.env.LANG || 'C.UTF-8',
      TERM: term || 'xterm-256color',
    };
  };

  function startHelper(): Helper {
    const python = o.python ?? 'python3';
    let unit: string | undefined;
    let cmd: string;
    let args: string[];
    if (o.launch === 'systemd') {
      unit = `sp-term-${randomBytes(6).toString('hex')}`;
      const prefix = [...(o.user?.sudo ?? []), ...(o.systemdRun ?? 'systemd-run --user').trim().split(/\s+/)];
      [cmd, ...args] = [...prefix, `--unit=${unit}`, '--collect', '--quiet', '--pipe', '--', python, HELPER];
    } else {
      [cmd, args] = [python, [HELPER]];
    }
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...o.user?.env } });
    proc.stderr?.on('data', (d: Buffer) => log.warn('terminal helper:', d.toString('utf8').trim().slice(0, 300)));
    proc.stdin?.on('error', () => {});
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    return { proc, unit, exited };
  }

  const takeHelper = () => {
    const h = warm && warm.proc.exitCode === null && !warm.proc.killed ? warm : startHelper();
    warm = undefined;
    return h;
  };

  function serve(t: Term, file: string, s: Stream): Promise<net.Server> {
    rmSync(file, { force: true });
    const server = net.createServer({ pauseOnConnect: false }, (sock) => {
      if (s.sock || t.done) return void sock.destroy();
      s.sock = sock;
      server.close();
      sock.on('error', () => {});
      for (const b of s.pending) sock.write(b);
      s.pending = [];
      s.pendingBytes = 0;
      if (s.ended) sock.end();
      if (s === t.out) {
        sock.on('data', (d: Buffer) => t.helper.proc.stdin?.write(frame('D', d)));
        // The relay hung up (its connection closed): hang up the shell.
        sock.on('close', () => !t.done && hangUp(t));
      }
      sock.on('drain', () => t.helper.proc.stdout?.resume());
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, () => {
        try {
          chmodSync(file, 0o660);
          if (o.group !== undefined) chownSync(file, -1, o.group);
        } catch (e) {
          return reject(e);
        }
        resolve(server);
      });
    });
  }

  function write(t: Term, s: Stream | undefined, data: Buffer) {
    if (!s || s.ended) return;
    if (s.sock) {
      if (!s.sock.write(data)) t.helper.proc.stdout?.pause();
    } else if (s.pendingBytes < PENDING_MAX) {
      s.pending.push(Buffer.from(data));
      s.pendingBytes += data.length;
    }
  }

  function hangUp(t: Term) {
    t.helper.proc.stdin?.write(frame('H', ''));
    t.stopTimer ??= setTimeout(() => {
      if (t.done) return;
      log.warn(`terminal ${t.id}: helper did not exit; stopping it`);
      if (t.helper.unit) {
        const [cmd, ...pre] = [...(o.user?.sudo ?? []), 'systemctl', '--user', 'stop', t.helper.unit];
        execFile(cmd, pre, { env: { ...process.env, ...o.user?.env } }, () => {});
      }
      t.helper.proc.kill('SIGKILL');
    }, STOP_AFTER_MS);
    t.stopTimer.unref?.();
  }

  function finish(t: Term, exitCode: number | null, signal: string | null) {
    if (t.done) return;
    t.done = true;
    clearTimeout(t.stopTimer);
    terms.delete(t.id);
    for (const s of [t.out, t.err]) {
      if (!s) continue;
      s.ended = true;
      s.sock?.end();
    }
    for (const server of t.servers) server.close();
    rmSync(path.join(o.dir, `${t.id}.sock`), { force: true });
    rmSync(path.join(o.dir, `${t.id}.err.sock`), { force: true });
    t.onExit(t.id, exitCode, signal);
  }

  const self: Terminals = {
    async open(req, onExit) {
      if (self.count(req.sessionId) >= TERMINALS_PER_SESSION) {
        return { error: apiError('too_many_terminals', '8 terminals are already open in this session.', 409, { retryable: false }) };
      }
      const id = mintId('tm');
      const helper = takeHelper();
      const t: Term = {
        id, sessionId: req.sessionId, helper, servers: [], onExit, done: false,
        out: { pending: [], pendingBytes: 0, ended: false },
        err: req.tty ? undefined : { pending: [], pendingBytes: 0, ended: false },
      };
      terms.set(id, t);
      const socket = path.join(o.dir, `${id}.sock`);
      const stderrSocket = t.err ? path.join(o.dir, `${id}.err.sock`) : null;
      try {
        t.servers.push(await serve(t, socket, t.out));
        if (t.err && stderrSocket) t.servers.push(await serve(t, stderrSocket, t.err));
      } catch (e) {
        log.warn(`terminal ${id}: cannot serve its socket: ${(e as Error).message}`);
        helper.proc.kill('SIGKILL');
        finish(t, null, null);
        return { error: apiError('unavailable', 'The terminal could not start.', 503, { retryable: true }) };
      }
      let exit: { exitCode: number | null; signal: string | null } | undefined;
      helper.proc.stdout?.on(
        'data',
        frames((kind, payload) => {
          if (kind === 'O') write(t, t.out, payload);
          else if (kind === 'X') write(t, t.err, payload);
          else if (kind === 'Z') exit = JSON.parse(payload.toString('utf8'));
        }),
      );
      helper.proc.once('exit', (code) => finish(t, exit?.exitCode ?? (exit ? null : code), exit?.signal ?? null));
      helper.proc.stdin?.write(
        frame('S', JSON.stringify({ cols: req.cols, rows: req.rows, command: req.command ?? null, tty: req.tty, term: req.term, env: shellEnv(req.term), cwd: req.cwd })),
      );
      self.prewarm();
      return { terminalId: id, socket, stderrSocket };
    },
    resize(id, cols, rows) {
      const t = terms.get(id);
      return !!t?.helper.proc.stdin?.write(frame('R', JSON.stringify({ cols, rows }))) || !!t;
    },
    eof(id) {
      const t = terms.get(id);
      t?.helper.proc.stdin?.write(frame('E', ''));
      return !!t;
    },
    close(id) {
      const t = terms.get(id);
      if (t) hangUp(t);
      return !!t;
    },
    count: (sessionId) => [...terms.values()].filter((t) => t.sessionId === sessionId).length,
    async closeSession(sessionId) {
      const mine = [...terms.values()].filter((t) => t.sessionId === sessionId);
      for (const t of mine) hangUp(t);
      await Promise.all(mine.map((t) => t.helper.exited));
    },
    async closeAll() {
      const all = [...terms.values()];
      for (const t of all) hangUp(t);
      if (warm) {
        warm.proc.stdin?.end();
        warm = undefined;
      }
      await Promise.all(all.map((t) => t.helper.exited));
    },
    prewarm() {
      if (!warm || warm.proc.exitCode !== null) warm = startHelper();
    },
  };
  return self;
}
