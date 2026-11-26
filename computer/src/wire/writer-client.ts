// The relay's client of one session writer's API socket (ApiClientFrame /
// ApiWriterFrame, src/protocol-api.ts): `hello {token}` first, then calls and
// at most one subscription. A thin stand-in for src/api/socket.ts's
// `dialApi`; the lead swaps it in once that lands (same frames, same shape).
//
// Invariants: every call resolves exactly once, with the writer's outcome or,
// when the socket closes first, `unavailable` (retryable: the session's
// writer moved or restarted, and the caller retries with the same
// idempotency key); `pause()` stops reading the socket, so a writer replaying
// the journal is paced by how fast this connection's client reads.

import net from 'node:net';
import type { ApiClientFrame, ApiError, JournalDelta, JournalEvent, WhereResult } from '../protocol.js';
import type { CallContext, CallOutcome, DetachReason } from '../api/writer.js';
import { ndjson, writeLine } from './ndjson.js';
import { errors } from './rpc.js';

/** A writer's frames may carry an events page; well above the client's 1 MiB. */
const MAX_LINE = 32 * 1024 * 1024;

export interface WriterHandlers {
  onEvent(event: JournalEvent): void;
  onDelta(delta: JournalDelta): void;
  onDetached(reason: DetachReason): void;
  /** The socket closed (writer exited or handed the journal on). Not called after `close()`. */
  onClose(): void;
}

export interface SubscribeFrame {
  after?: number;
  tailTurns?: number;
  deltas: boolean;
}

export interface WriterLink {
  call(method: string, params: unknown, ctx: CallContext): Promise<CallOutcome>;
  /** The `sessions.attached` body less `sessionId`, then events through the handlers. */
  subscribe(o: SubscribeFrame): Promise<CallOutcome>;
  ack(seq: number): void;
  pause(): void;
  resume(): void;
  close(): void;
  readonly closed: boolean;
}

export type DialWriter = (where: WhereResult, h: WriterHandlers) => Promise<WriterLink>;

export const dialWriter: DialWriter = (where, h) =>
  new Promise((resolve, reject) => {
    const sock = net.connect(where.socket);
    const pending = new Map<string, (o: CallOutcome) => void>();
    let next = 0;
    let closed = false;
    let mine = false;
    sock.setNoDelay?.(true);
    sock.once('error', reject);
    sock.on('error', () => {});
    sock.once('connect', () => {
      sock.off('error', reject);
      writeLine(sock, { t: 'hello', token: where.token } satisfies ApiClientFrame);
      resolve(link);
    });
    sock.on('close', () => {
      closed = true;
      for (const done of pending.values()) done({ error: errors.unavailable() });
      pending.clear();
      if (!mine) h.onClose();
    });
    ndjson(sock, MAX_LINE, (raw) => {
      const m = raw as { t?: string; id?: string; result?: unknown; error?: ApiError; event?: JournalEvent; delta?: JournalDelta; reason?: DetachReason };
      if (m.t === 'event' && m.event) h.onEvent(m.event);
      else if (m.t === 'delta' && m.delta) h.onDelta(m.delta);
      else if (m.t === 'result' && typeof m.id === 'string') {
        const done = pending.get(m.id);
        pending.delete(m.id);
        done?.(m.error ? { error: m.error } : { result: m.result });
      } else if (m.t === 'detached') h.onDetached(m.reason ?? 'moved');
    });

    type Ask<F> = F extends { id: string } ? Omit<F, 'id'> : never;
    const ask = (frame: Ask<ApiClientFrame>) =>
      new Promise<CallOutcome>((done) => {
        if (closed) return done({ error: errors.unavailable() });
        const id = String(++next);
        pending.set(id, done);
        writeLine(sock, { ...frame, id } as ApiClientFrame);
      });

    const link: WriterLink = {
      call: (method, params, ctx) =>
        ask({ t: 'call', method, params, actor: ctx.actor, member: ctx.member, idempotencyKey: ctx.idempotencyKey, requestId: ctx.requestId }),
      subscribe: (o) => ask({ t: 'subscribe', after: o.after, tailTurns: o.tailTurns, deltas: o.deltas }),
      ack: (seq) => void writeLine(sock, { t: 'ack', seq } satisfies ApiClientFrame),
      pause: () => sock.pause(),
      resume: () => sock.resume(),
      close: () => {
        mine = true;
        sock.destroy();
      },
      get closed() {
        return closed;
      },
    };
  });
