// A JSON-RPC client for one `codex app-server` child: newline-delimited JSON
// over its stdio (0.163.0 sends no `jsonrpc` field). Three kinds of message
// come in: responses to our requests (`id`, no `method`), the server's own
// requests (`id` and `method`: approvals, dynamic tool calls), and
// notifications (`method`, no `id`).
//
// Invariants:
// - our ids are this client's own counter; the server's request ids are a
//   separate namespace and are only ever echoed back, never matched against
//   ours, so a server request can never resolve one of our calls;
// - every request we send settles exactly once: its response, its timeout,
//   or the child's exit (which fails everything pending);
// - every server request gets exactly one reply, an error when its handler
//   throws; nothing is written after the child exited; its handler is called
//   synchronously, in the order read, so what it registers precedes the
//   messages after it;
// - notifications are handed over in the order read; `pause` stops reading
//   stdout (back-pressure reaches Codex through the pipe), never drops;
// - `kill` is synchronous (scope finalizers are) and idempotent; signals go
//   to the child's process group (it is spawned detached, as its leader), so
//   what the npm shim spawned under it goes too; a child still running when
//   this process exits is signalled then: SIGKILL if `kill` already asked it
//   to stop (the 3 s escalation would not get to run), SIGTERM otherwise.
//   Under systemd the unit's cgroup ends it anyway; this is for a laptop or
//   a detached runner.

import { type ChildProcess, spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { log } from '../../../log.js';

export type RequestId = number | string;

/**
 * JSON as Codex sends it. Untyped on purpose: the app-server schema moves
 * between releases, so each reader checks the fields it uses where it reads
 * them (translate.ts, serve.ts) instead of trusting a generated type.
 */
// biome-ignore lint/suspicious/noExplicitAny: one alias for untyped wire JSON, read defensively where used
export type Wire = any;

/** A JSON-RPC error: the server's answer, or ours when it gave none. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
  ) {
    super(message);
  }
}
/** Our codes for failures the server did not answer: it went away, or it took too long. */
export const EXITED = -32099;
export const TIMED_OUT = -32098;
export const METHOD_NOT_FOUND = -32601;

export interface AppServerOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification(method: string, params: Wire): void;
  /** A server request; its result is the reply, a thrown RpcError (or any error) the error reply. */
  onRequest(method: string, params: Wire, id: RequestId): Promise<unknown>;
  /** The child is gone and its stdout is drained: `why` is its exit code or signal, or the spawn error. */
  onClose(why: string): void;
  /** A request of ours failed (telemetry; never content). */
  onFailed?(method: string, code: number): void;
  /** A single line longer than this is a protocol failure (the child is killed). */
  maxLine?: number;
}

const MAX_LINE = 64 * 1024 * 1024;
const KILL_AFTER_MS = 3000;
const live = new Set<AppServer>();
let exitHook = false;

export class AppServer {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { method: string; resolve(r: unknown): void; reject(e: RpcError): void; timer?: NodeJS.Timeout }>();
  private parts: string[] = [];
  private partLen = 0;
  private gone?: string;
  private closed = false;
  private errTail = '';
  private stopping = false;
  readonly pid?: number;

  constructor(private o: AppServerOptions) {
    if (!exitHook) {
      exitHook = true;
      process.once('exit', () => {
        for (const c of live) c.signal(c.stopping ? 'SIGKILL' : 'SIGTERM');
      });
    }
    this.child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.pid = this.child.pid;
    live.add(this);
    this.child.stdout!.setEncoding('utf8').on('data', (c: string) => this.data(c));
    this.child.stderr!.setEncoding('utf8').on('data', (c: string) => this.stderr(c));
    this.child.stdin!.on('error', () => {}); // EPIPE after an exit: the exit handler reports it
    this.child.on('exit', (code, signal) => this.exited(signal ?? `exit ${code}`));
    // 'error' is a failed spawn only when there is no pid; after a spawn it is a failed kill or
    // signal, and the child's own exit (or `close`) still reports it.
    this.child.on('error', (e) =>
      this.child.pid === undefined ? (this.exited(`spawn failed: ${e.message}`), this.close()) : log.warn(`codex: ${e.message}`),
    );
    this.child.on('close', () => this.close());
  }

  get alive() {
    return !this.gone;
  }

  request<T = Wire>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.gone) return reject(this.failed(method, EXITED, `codex app-server is gone (${this.gone})`));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.failed(method, TIMED_OUT, `codex app-server did not answer ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve: resolve as (r: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  pause() {
    this.child.stdout?.pause();
  }

  resume() {
    this.child.stdout?.resume();
  }

  /** End the child: stdin closed, SIGTERM, SIGKILL if it lingers. Synchronous; safe to repeat. */
  kill() {
    if (this.gone) return;
    this.stopping = true;
    this.child.stdin?.end();
    this.signal('SIGTERM');
    setTimeout(() => this.signal('SIGKILL'), KILL_AFTER_MS).unref();
  }

  /** `sig` to the child's process group; to the child alone when the group cannot be signalled (not its leader, or gone). */
  private signal(sig: NodeJS.Signals) {
    if (this.gone || this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, sig);
    } catch {
      this.child.kill(sig);
    }
  }

  private write(m: object) {
    if (this.gone || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(m)}\n`);
  }

  private failed(method: string, code: number, message: string) {
    this.o.onFailed?.(method, code);
    return new RpcError(code, message, method);
  }

  private exited(why: string) {
    if (this.gone) return;
    this.gone = why;
    live.delete(this);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(this.failed(p.method, EXITED, `codex app-server exited (${why}) before answering ${p.method}`));
    }
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.o.onClose(this.gone ?? 'closed');
  }

  private data(chunk: string) {
    let start = 0;
    for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
      const tail = chunk.slice(start, nl);
      const line = this.parts.length ? this.parts.join('') + tail : tail;
      this.parts = [];
      this.partLen = 0;
      start = nl + 1;
      this.line(line);
    }
    if (start >= chunk.length) return;
    this.parts.push(chunk.slice(start));
    this.partLen += chunk.length - start;
    if (this.partLen > (this.o.maxLine ?? MAX_LINE)) {
      log.error(`codex: a line over ${this.o.maxLine ?? MAX_LINE} bytes; killing the app-server`);
      this.parts = [];
      this.partLen = 0;
      this.kill();
    }
  }

  private line(line: string) {
    if (!line.trim()) return;
    let m: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      m = JSON.parse(line);
    } catch {
      return void log.warn(`codex: not JSON on stdout: ${line.slice(0, 200)}`);
    }
    if (typeof m !== 'object' || m === null) return void log.warn(`codex: not a message: ${line.slice(0, 200)}`);
    if (m.method !== undefined && m.id !== undefined) return this.serve(m.id, m.method, m.params);
    if (m.method !== undefined) {
      try {
        this.o.onNotification(m.method, m.params);
      } catch (e) {
        log.error(`codex: handling ${m.method}`, e);
      }
      return;
    }
    if (typeof m.id !== 'number') return void log.warn(`codex: a response to an id we never sent: ${String(m.id).slice(0, 40)}`);
    const p = this.pending.get(m.id);
    if (!p) return void log.warn(`codex: a response to request ${m.id}, which is no longer waiting`);
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(this.failed(p.method, m.error.code ?? -32603, m.error.message ?? 'error'));
    else p.resolve(m.result);
  }

  private serve(id: RequestId, method: string, params: unknown) {
    // Called synchronously, before the next message is read: a handler registers what may cancel it
    // (serve.ts) before a `serverRequest/resolved` or turn end in the same chunk can arrive.
    let r: Promise<unknown>;
    try {
      r = Promise.resolve(this.o.onRequest(method, params, id));
    } catch (e) {
      r = Promise.reject(e);
    }
    r.then(
        (result) => this.write({ id, result: result ?? {} }),
        (e: Wire) => this.write({ id, error: { code: e instanceof RpcError ? e.code : -32603, message: String(e?.message ?? e) } }),
      );
  }

  /** Codex's own log (stderr), one runner-log line each, without its colours. */
  private stderr(chunk: string) {
    const lines = (this.errTail + chunk).split('\n');
    this.errTail = (lines.pop() ?? '').slice(-4096);
    for (const l of lines) {
      const clean = stripVTControlCharacters(l).trim();
      if (clean) log.info(`codex: ${clean.slice(0, 1000)}`);
    }
  }
}
