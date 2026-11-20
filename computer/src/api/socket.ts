// A session writer's API socket (work 084): `serveApi` puts a Writer on a unix
// socket speaking ApiClientFrame / ApiWriterFrame (src/protocol-api.ts), and
// `dialApi` is its client (the relay, tests).
//
// Invariants:
// - The first frame must be `hello` with the writer's token (compared in
//   constant time); anything else first, a wrong token, or no hello within
//   5 s closes the connection. The token stands in for SO_PEERCRED, which
//   node cannot read.
// - A line over 1 MiB closes the connection (the peer is broken, not slow).
// - A write's `result` goes out before any event it caused: while a write
//   call is in flight the subscription's sink holds events (the hub pulls
//   them from the log later, never queued here). A connection is one
//   session's writer, so only that session's events wait, and only on this
//   connection (each relay attachment dials its own). Deltas still go while
//   no event is held (the hub sends deltas only when caught up, so none
//   overtakes a held event), so a slow write (a model switch, a suspend) does
//   not freeze streaming text. A full socket holds both until `drain`.
// - At most one subscription per connection; its `result` (the
//   `sessions.attached` body less sessionId) goes out before its events.
// - Closing the connection closes its subscription; a client's pending calls
//   resolve `unavailable` (retryable) when the socket closes first.

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { ApiClientFrame, ApiError, ApiWriterFrame, JournalDelta, JournalEvent } from '../protocol.js';
import { log } from '../log.js';
import type { HubSubscription, Sink } from './hub.js';
import { WRITES } from './schema-methods.js';
import { type Attached, apiError, type CallContext, type CallOutcome, type SubscribeOptions, type Subscription, type Writer } from './writer.js';

export const MAX_LINE = 1 << 20;
/** The client's cap: a writer's result may carry an events page of up to 500 events. */
const CLIENT_MAX_LINE = 64 << 20;
const HELLO_MS = 5000;

/** Read NDJSON from `sock`, bounding each line; `on` runs synchronously in arrival order. */
function readLines(sock: net.Socket, maxLine: number, on: (m: unknown) => void): void {
  let parts: Buffer[] = [];
  let held = 0;
  sock.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      const line = held ? Buffer.concat([...parts, chunk.subarray(start, i)]) : chunk.subarray(start, i);
      parts = [];
      held = 0;
      start = i + 1;
      if (line.length > maxLine) return void sock.destroy(new Error(`line over ${maxLine} bytes`));
      if (!line.length) continue;
      let m: unknown;
      try {
        m = JSON.parse(line.toString('utf8'));
      } catch {
        log.warn('api socket: bad json line', line.subarray(0, 120).toString('utf8'));
        continue;
      }
      on(m);
      if (sock.destroyed) return;
    }
    if (start < chunk.length) {
      held += chunk.length - start;
      if (held > maxLine) return void sock.destroy(new Error(`line over ${maxLine} bytes`));
      parts.push(chunk.subarray(start));
    }
  });
}

const write = (sock: net.Socket, m: ApiWriterFrame | ApiClientFrame): boolean =>
  !sock.destroyed && sock.writable && sock.write(`${JSON.stringify(m)}\n`);

const digest = (s: string) => createHash('sha256').update(s).digest();
const tokenMatches = (given: unknown, token: string) => typeof given === 'string' && timingSafeEqual(digest(given), digest(token));

export interface ApiServer {
  close(): Promise<void>;
  connections(): number;
}

/** Serve `writer` on the unix socket `path` (replacing a stale file), mode 0660 by default. */
export async function serveApi(path: string, writer: Writer, o: { token: string; mode?: number }): Promise<ApiServer> {
  const socks = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    sock.on('error', () => {});
    connection(sock, writer, o.token);
  });
  fs.rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(path, o.mode ?? 0o660);
  return {
    connections: () => socks.size,
    close: async () => {
      for (const s of socks) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(path, { force: true });
    },
  };
}

function connection(sock: net.Socket, writer: Writer, token: string): void {
  let authed = false;
  let writing = 0;
  let sub: Subscription | undefined;
  let subscribing = false;
  const helloTimer = setTimeout(() => sock.destroy(), HELLO_MS);
  helloTimer.unref?.();
  const pump = () => (sub as HubSubscription | undefined)?.pump?.();
  sock.on('drain', pump);
  sock.on('close', () => {
    clearTimeout(helloTimer);
    sub?.close();
    sub = undefined;
  });

  const result = (id: string, out: CallOutcome) =>
    write(sock, out.error ? { t: 'result', id, error: out.error } : { t: 'result', id, result: out.result });

  readLines(sock, MAX_LINE, (raw) => {
    const m = raw as ApiClientFrame;
    if (!authed) {
      if (m?.t !== 'hello' || !tokenMatches(m.token, token)) return void sock.destroy();
      authed = true;
      clearTimeout(helloTimer);
      return;
    }
    switch (m?.t) {
      case 'call': {
        const ctx: CallContext = { actor: m.actor, member: m.member, idempotencyKey: m.idempotencyKey, requestId: m.requestId };
        const isWrite = WRITES.has(m.method as never);
        if (isWrite) writing++;
        writer
          .call(m.method, m.params, ctx)
          .catch((e): CallOutcome => ({ error: apiError('internal', String((e as Error)?.message ?? e), 500, { retryable: true }) }))
          .then((out) => {
            result(m.id, out);
            if (isWrite) writing--;
            pump();
          });
        return;
      }
      case 'subscribe': {
        if (sub || subscribing) return void result(m.id, { error: apiError('invalid_request', 'one subscription per connection', 400, { field: 'subscribe' }) });
        subscribing = true;
        const sink: Sink = {
          after: m.after,
          tailTurns: m.tailTurns,
          deltas: m.deltas,
          mirror: m.mirror === true,
          writable: () => !sock.writableNeedDrain && !sock.destroyed,
          holdEvents: () => writing > 0,
          onEvent: (event: JournalEvent) => void write(sock, { t: 'event', event }),
          onDelta: (delta: JournalDelta) => void write(sock, { t: 'delta', delta }),
          onDetached: (reason) => {
            write(sock, { t: 'detached', reason });
            sub = undefined;
            subscribing = false;
          },
        };
        const s = writer.subscribe(sink);
        if ('error' in s) {
          subscribing = false;
          return void result(m.id, { error: s.error });
        }
        sub = s;
        result(m.id, { result: s.attached });
        return;
      }
      case 'ack':
        if (typeof m.seq === 'number') sub?.ack(m.seq);
        return;
      default:
        return;
    }
  });
}

// ---------------------------------------------------------------- client

export interface ApiClient {
  call(method: string, params: unknown, ctx: CallContext): Promise<CallOutcome>;
  /** Resolves with the attached body (then events arrive through `o`), or the writer's error. */
  subscribe(o: SubscribeOptions & { resume?: boolean }): Promise<{ attached: Attached } | { error: ApiError }>;
  ack(seq: number): void;
  close(): void;
  /** Resolves when the socket has closed, for any reason. */
  readonly closed: Promise<void>;
}

const gone = (): CallOutcome => ({ error: apiError('unavailable', 'the session writer went away', 503, { retryable: true, retryAfterMs: 250 }) });

/** Connect to a writer's socket and say hello. `connect`: how, when the socket is where its path cannot be trusted (it may throw). */
export function dialApi(path: string, token: string, connect: (path: string) => net.Socket = net.connect): Promise<ApiClient> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const pending = new Map<string, (o: CallOutcome) => void>();
    let next = 0;
    let handlers: SubscribeOptions | undefined;
    let ended = false;
    const closed = new Promise<void>((r) =>
      sock.on('close', () => {
        ended = true;
        for (const p of pending.values()) p(gone());
        pending.clear();
        r();
      }),
    );
    sock.once('error', reject);
    sock.on('error', () => {});
    readLines(sock, CLIENT_MAX_LINE, (raw) => {
      const m = raw as ApiWriterFrame;
      if (m.t === 'result') {
        const p = pending.get(m.id);
        pending.delete(m.id);
        p?.(m.error ? { error: m.error } : { result: m.result });
      } else if (m.t === 'event') handlers?.onEvent(m.event);
      else if (m.t === 'delta') handlers?.onDelta(m.delta);
      else if (m.t === 'detached') {
        const h = handlers;
        handlers = undefined;
        h?.onDetached(m.reason);
      }
    });
    const request = (frame: (id: string) => ApiClientFrame): Promise<CallOutcome> => {
      if (ended) return Promise.resolve(gone());
      const id = String(++next);
      return new Promise((r) => {
        pending.set(id, r);
        write(sock, frame(id));
      });
    };
    sock.once('connect', () => {
      sock.off('error', reject);
      write(sock, { t: 'hello', token });
      resolve({
        closed,
        call: (method, params, ctx) =>
          request((id) => ({ t: 'call', id, method, params, actor: ctx.actor, member: ctx.member, idempotencyKey: ctx.idempotencyKey, requestId: ctx.requestId })),
        subscribe: async (o) => {
          handlers = o;
          const out = await request((id) => ({ t: 'subscribe', id, after: o.after, tailTurns: o.tailTurns, deltas: o.deltas, resume: o.resume, mirror: o.mirror }));
          if (out.error) {
            handlers = undefined;
            return { error: out.error };
          }
          return { attached: out.result as Attached };
        },
        ack: (seq) => void write(sock, { t: 'ack', seq }),
        close: () => void sock.end(),
      });
    });
  });
}
