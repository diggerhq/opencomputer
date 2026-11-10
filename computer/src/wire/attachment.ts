// How one connection reaches session writers: an `Attachment` per attached
// session (a subscription on the writer's API socket, followed across writer
// moves), and `WriterLinks` for calls to sessions it is not attached to.
//
// Invariants:
// - Events reach the outbox in seq order, each once: after a move the
//   attachment resubscribes after the last seq it delivered and drops any seq
//   at or below it.
// - A rewire whose writer is at a different epoch detaches with
//   `epoch_changed` and the new `logEpoch`/`epochStartSeq` (the log was
//   rebuilt; the client must re-read), checked before resubscribing so the
//   cursor's position cannot turn it into `too_far_behind` (review r2 P2-4);
//   one that cannot reach a writer within `rewireMs` detaches with `unavailable`.
//   Its retries wait a random half to whole of the backoff: every attachment
//   of a moved writer rewires at once, and they do not retry in step.
// - The attach's response is queued before any of its replayed events (the
//   outbox holds the session while the subscribe is in flight).
// - A call never goes to a link known to be closed; a cached link is dropped
//   when its socket closes.

import type { ApiActor, JournalDelta, JournalEvent, WhereResult } from '../protocol.js';
import type { CallOutcome, DetachReason } from '../api/writer.js';
import { LIMITS } from './limits.js';
import type { HostLink } from './host-link.js';
import { completesKey, type Outbox } from './outbox.js';
import { errors } from './rpc.js';
import type { DialWriter, WriterLink } from './writer-client.js';

export type WireDetachReason = DetachReason | 'unavailable';
/** With `epoch_changed`: the new epoch and its first seq (the client discards from it and re-reads from the seq before). */
export interface EpochMoved {
  logEpoch: number;
  epochStartSeq?: number;
}

export interface AttachDeps {
  host: HostLink;
  dial: DialWriter;
  outbox: Outbox;
  /** The attachment ended on its own: send `session.detached` and forget it. */
  detached(sessionId: string, reason: WireDetachReason, moved?: EpochMoved): void;
  now?: () => bigint;
  /** Telemetry: an event at or below the cursor was dropped (`wire.flush.duplicates`). */
  duplicate?(): void;
  /** Telemetry: queue live events with their `createdAt` (for `wire.flush.oldest_age_ms`). */
  metered?: boolean;
}

export interface AttachRequest {
  after?: number;
  tailTurns?: number;
  deltas: boolean;
  resume?: boolean;
  readOnly?: boolean;
}

async function where(host: HostLink, sessionId: string): Promise<{ where: WhereResult } | { error: CallOutcome['error'] & object }> {
  const r = await host.call({ t: 'where', sessionId });
  if (r.error) return { error: r.error };
  return { where: r.result as WhereResult };
}

/** What a writer's subscribe result says: api/writer.ts `Attached` ({session, after, lastSeq, epoch}), or already the API body. */
type WriterAttached = {
  session?: { lastSeq?: number } | null;
  after?: number;
  lastSeq?: number;
  epoch?: number;
  logEpoch?: number;
  epochStartSeq?: number;
  capabilities?: unknown;
  earlierTurns?: unknown;
};

/** The `sessions.attached` body (less sessionId and timing) from the writer's result; fields the writer does not give are null. */
export function attachBody(raw: unknown) {
  const b = (raw ?? {}) as WriterAttached;
  return {
    session: b.session ?? null,
    logEpoch: b.logEpoch ?? b.epoch ?? null,
    epochStartSeq: b.epochStartSeq ?? null,
    capabilities: b.capabilities ?? null,
    earlierTurns: b.earlierTurns ?? null,
  };
}

/** The seq replay starts after (events at or below it are already the client's). */
const startAfter = (raw: unknown) => {
  const b = (raw ?? {}) as WriterAttached;
  return b.after ?? b.lastSeq ?? b.session?.lastSeq ?? undefined;
};

export class Attachment {
  link: WriterLink | undefined;
  readOnly: boolean;
  deltas: boolean;
  /** The last seq handed to the outbox (or the seq live delivery starts after). */
  cursor: number | undefined;
  epoch: number | undefined;
  acked = 0;
  /** Events above this seq are live (their delivery lag counts); at or below, replay. */
  private liveAfter = Number.MAX_SAFE_INTEGER;
  private closed = false;
  private rewiring: Promise<void> | undefined;
  private generation = 0;

  constructor(
    readonly sessionId: string,
    private deps: AttachDeps,
    o: AttachRequest,
  ) {
    this.readOnly = !!o.readOnly;
    this.deltas = o.deltas;
  }

  /**
   * Subscribe; the result is the attach result body (less `timing`, which the caller adds). The session stays held in
   * the outbox: the caller queues the response, then calls `outbox.release(sessionId)`.
   */
  async start(o: AttachRequest, actor: ApiActor): Promise<CallOutcome> {
    const { outbox, host } = this.deps;
    outbox.hold(this.sessionId);
    if (o.resume) {
      const r = await host.call({ t: 'resume', sessionId: this.sessionId, actor });
      if (r.error) return { error: r.error };
    }
    // A session just created or resumed may have no writer listening yet: retry `unavailable` as rewire() does.
    const deadline = Date.now() + LIMITS.rewireMs;
    let out: CallOutcome;
    for (let wait = 50; ; wait = Math.min(wait * 2, 2000)) {
      const w = await where(host, this.sessionId);
      out = 'error' in w ? { error: w.error } : await this.subscribe(w.where, { after: o.after, tailTurns: o.tailTurns });
      const ms = wait * (0.5 + Math.random() / 2);
      if (!out.error || out.error.code !== 'unavailable' || this.closed || Date.now() + ms > deadline) break;
      await new Promise((r) => setTimeout(r, ms));
    }
    if (out.error) return out;
    const body = attachBody(out.result);
    this.epoch = body.logEpoch ?? undefined;
    this.cursor ??= startAfter(out.result) ?? o.after;
    this.liveAfter = body.session?.lastSeq ?? this.cursor ?? 0;
    return { result: body };
  }

  ack(seq: number) {
    if (seq > this.acked) this.acked = seq;
    this.link?.ack(seq);
  }

  pause() {
    this.link?.pause();
  }

  resume() {
    this.link?.resume();
  }

  close() {
    this.closed = true;
    this.link?.close();
    this.link = undefined;
  }

  /** The writer moved (host `moved`, writer `detached moved`, or its socket closed): follow it. */
  moved(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.rewiring ??= this.rewire().finally(() => {
      this.rewiring = undefined;
    });
    return this.rewiring;
  }

  private async rewire() {
    this.link?.close();
    this.link = undefined;
    const deadline = Date.now() + LIMITS.rewireMs;
    for (let wait = 50; !this.closed; wait = Math.min(wait * 2, 2000)) {
      const w = await where(this.deps.host, this.sessionId);
      if (this.closed) return;
      if ('where' in w) {
        const epoch = this.epoch;
        if (epoch !== undefined && w.where.epoch !== epoch)
          return this.end('epoch_changed', { logEpoch: w.where.epoch, epochStartSeq: w.where.epochStartSeq });
        const out = await this.subscribe(w.where, { after: this.cursor });
        if (this.closed) return;
        if (!out.error) {
          const b = attachBody(out.result);
          if (epoch !== undefined && b.logEpoch !== null && b.logEpoch !== epoch)
            return this.end('epoch_changed', { logEpoch: b.logEpoch, epochStartSeq: b.epochStartSeq ?? undefined });
          this.cursor ??= startAfter(out.result);
          return;
        }
        if (out.error.code === 'session_not_found') return this.end('access_lost');
        if (out.error.code === 'too_far_behind' || out.error.code === 'cursor_ahead') return this.end('too_far_behind');
      } else if (w.error.code === 'session_not_found') return this.end('access_lost');
      const ms = wait * (0.5 + Math.random() / 2);
      if (Date.now() + ms > deadline) return this.end('unavailable');
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  private end(reason: WireDetachReason, moved?: EpochMoved) {
    if (this.closed) return;
    this.close();
    this.deps.detached(this.sessionId, reason, moved);
  }

  private async subscribe(w: WhereResult, o: { after?: number; tailTurns?: number }): Promise<CallOutcome> {
    const gen = ++this.generation;
    let link: WriterLink;
    try {
      link = await this.deps.dial(w, {
        onEvent: (e) => gen === this.generation && this.onEvent(e),
        onDelta: (d) => gen === this.generation && this.onDelta(d),
        onDetached: (reason) => {
          if (gen !== this.generation) return;
          if (reason === 'moved') void this.moved();
          else this.end(reason);
        },
        onClose: () => gen === this.generation && void this.moved(),
      });
    } catch {
      return { error: errors.unavailable() };
    }
    if (this.closed || gen !== this.generation) {
      link.close();
      return { error: errors.unavailable() };
    }
    this.link = link;
    const out = await link.subscribe({ after: o.after, tailTurns: o.tailTurns, deltas: this.deltas });
    if (out.error) {
      link.close();
      if (this.link === link) this.link = undefined;
    }
    return out;
  }

  private onEvent(e: JournalEvent) {
    if (this.closed) return;
    if (this.cursor !== undefined && e.seq <= this.cursor) return void this.deps.duplicate?.();
    this.cursor = e.seq;
    const { outbox } = this.deps;
    const createdMs = this.deps.metered && e.seq > this.liveAfter ? Date.parse(e.createdAt) : undefined;
    outbox.event(this.sessionId, e.seq, JSON.stringify(e), completesKey(e.type, e.data), createdMs);
    if (this.acked && e.seq - this.acked > LIMITS.backlogEvents) return this.end('too_far_behind');
    if (outbox.backlog(this.sessionId).bytes > LIMITS.backlogBytes) this.end('too_far_behind');
  }

  private onDelta(d: JournalDelta) {
    if (!this.closed && this.deltas) this.deps.outbox.delta(this.sessionId, d);
  }
}

/** Call-only links to writers of sessions the connection is not attached to, most recent `callLinks` kept. */
export class WriterLinks {
  private links = new Map<string, Promise<WriterLink | undefined>>();

  constructor(
    private host: HostLink,
    private dial: DialWriter,
  ) {}

  async get(sessionId: string): Promise<WriterLink | { error: NonNullable<CallOutcome['error']> }> {
    const cached = this.links.get(sessionId);
    if (cached) {
      const link = await cached;
      if (link && !link.closed) {
        this.links.delete(sessionId);
        this.links.set(sessionId, cached);
        return link;
      }
      this.links.delete(sessionId);
    }
    const w = await where(this.host, sessionId);
    if ('error' in w) return { error: w.error };
    const p = this.dial(w.where, {
      onEvent: () => {},
      onDelta: () => {},
      onDetached: () => {},
      onClose: () => {
        if (this.links.get(sessionId) === p) this.links.delete(sessionId);
      },
    }).catch(() => undefined);
    this.links.set(sessionId, p);
    while (this.links.size > LIMITS.callLinks) {
      const [oldest, op] = this.links.entries().next().value as [string, Promise<WriterLink | undefined>];
      this.links.delete(oldest);
      void op.then((l) => l?.close());
    }
    const link = await p;
    return link ?? { error: errors.unavailable() };
  }

  /** The session's writer moved: the next call asks `where` again. */
  forget(sessionId: string) {
    const p = this.links.get(sessionId);
    this.links.delete(sessionId);
    void p?.then((l) => l?.close());
  }

  close() {
    for (const p of this.links.values()) void p.then((l) => l?.close());
    this.links.clear();
  }
}
