// The host's API leg to the gateway (work 084): HTTP routes' operations
// (`api` → the session's writer → `api-result`) and the mirror (every journal
// event of every live writer, up as `journal` batches to the SessionLog DO),
// on the one gateway socket.
//
// Invariants:
// - Read your writes: a write's `api-result` leaves only after the `journal`
//   frames holding every event up to the write's `seq`, on the same ordered
//   socket (waiting at most `seqWaitMs` for the writer's stream to show them).
// - Calls to one session reach its writer in the order the frames arrived;
//   their results go back as each finishes.
// - The mirror is at least once and in seq order per session: a subscription
//   to the live writer from the last seq seen, a spool (api-spool.ts) of what
//   the DO has not acked, resent from the ack after every reconnect; never
//   dropped. Flushed at once on turn ends, `ask.opened` and
//   `session.status_changed`, else within `flushMs` (100 ms).
// - Never ahead of the socket (084 perf fix 2): while the gateway socket holds
//   more than `holdBytes` (1 MiB) unwritten, a flush sends nothing and tries
//   again in `flushMs`; the spool keeps the events. Frames sent around the
//   mirror (Slack's, `api-result`s) so queue behind at most that much. Only a
//   write's own session goes regardless, before its `api-result`.
// - `subagent.progress` deltas (never journaled) go up as `subagent-progress`
//   frames: the latest values of the session's running subagents, at most once
//   per `progressMs` (1 s) per session, best effort (lost with the link).
// - Never relabels: a writer's events go up only under the epoch that writer
//   attached at, and a writer behind the mirror's epoch is not followed (the
//   host's `epoch` adoption, recovery-fix; review r1 P1-1).
// - Knows nothing of runners or the session-writer: `writer` hands it a
//   `WriterPort` for whichever writes now, and `follow` is called whenever that
//   changes.

import type { CallContext, CallOutcome, SubscribeOptions } from '../api/writer.js';
import { apiError } from '../api/writer.js';
import type { Attached, Writer } from '../api/writer.js';
import { isMethod, WRITER_METHODS } from '../api/schema-methods.js';
import type { ApiError, GatewayToHost, HostToGateway, JournalDelta, JournalEvent, SubagentProgress } from '../protocol.js';
import { log } from '../log.js';
import { type DiskRead, Spool, SPOOL_BYTES } from './api-spool.js';
import type { MirrorMeter } from './mirror-meter.js';

/** A subscription as the mirror holds it. */
export interface PortSubscription {
  readonly attached: Attached;
  ack(seq: number): void;
  close(): void;
}

/** A session's writer as the bridge uses it: in process (the host's session-writer) or over its socket (a runner). */
export interface WriterPort {
  call(method: string, params: unknown, ctx: CallContext): Promise<CallOutcome>;
  subscribe(o: SubscribeOptions): Promise<PortSubscription | { error: ApiError }>;
}

/** An in-process Writer as a port. */
export const localPort = (w: Writer): WriterPort => ({
  call: (method, params, ctx) => w.call(method, params, ctx),
  subscribe: async (o) => w.subscribe(o),
});

/** Where the DO's acks are kept across host restarts (mirror-acks.ts). */
export interface AckStore {
  get(sessionId: string): { epoch: number; seq: number } | undefined;
  set(sessionId: string, epoch: number, seq: number): void;
}

export interface BridgeDeps {
  /** Send on the gateway socket; false when it is not open (nothing was sent). */
  send(m: HostToGateway): boolean;
  /** Bytes sent on the gateway socket but not yet written to the network (`bufferedAmount`). */
  buffered?(): number;
  holdBytes?: number;
  /** The session's writer now: its runner's, else the host's, opened only when `open`; undefined when there is none. */
  writer(sessionId: string, open: boolean): Promise<WriterPort | undefined>;
  /** Journal events from disk, for what the spool does not hold in memory. */
  disk: DiskRead;
  acks?: AckStore;
  spoolBytes?: number;
  flushMs?: number;
  seqWaitMs?: number;
  /** Delay before following a writer again after its subscription ended. */
  retryMs?: number;
  /** At most one `subagent-progress` frame per session this often. */
  progressMs?: number;
  /** Telemetry: one event per batch sent and per ack (mirror-meter.ts, work 084 instrumentation). */
  meter?: Pick<MirrorMeter, 'batch' | 'acked' | 'relinked' | 'forget'>;
}

/** The gateway socket's unwritten bytes past which the mirror waits (two full batches). */
export const HOLD_BYTES = 2 ** 20;

type ApiFrame = Extract<GatewayToHost, { t: 'api' }>;
type AckFrame = Extract<GatewayToHost, { t: 'journal-ack' }>;

/** Events that end a wait somewhere (a turn, an ask, a status): the DO gets them at once. */
const URGENT = new Set(['turn.completed', 'turn.failed', 'turn.cancelled', 'ask.opened', 'session.status_changed']);

export function apiBridge(d: BridgeDeps) {
  const spool = new Spool(d.disk, d.spoolBytes ?? SPOOL_BYTES);
  const flushMs = d.flushMs ?? 100;
  const seqWaitMs = d.seqWaitMs ?? 2000;
  const retryMs = d.retryMs ?? 250;
  const progressMs = d.progressMs ?? 1000;
  const holdBytes = d.holdBytes ?? HOLD_BYTES;
  /** Since when flushes have waited for the socket to drain (0: they do not). */
  let heldSince = 0;
  /** Per session: the latest progress of each running subagent, whether it changed since the last frame, and when that went. */
  type Progress = { by: Map<string, SubagentProgress>; dirty: boolean; at: number; timer?: NodeJS.Timeout };
  const progress = new Map<string, Progress>();
  /** The mirror's subscription per session; `gen` makes an older follow's late result moot. */
  const follows = new Map<string, { gen: number; sub?: PortSubscription; seen: number; following?: boolean }>();
  const waiters = new Map<string, { seq: number; done: () => void }[]>();
  const chains = new Map<string, Promise<unknown>>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  /** Start the session's mirror under `epoch` with the DO holding up to `acked`, unless it already runs at that epoch. */
  function open(sessionId: string, epoch: number, acked: number) {
    const stored = d.acks?.get(sessionId);
    const from = stored?.epoch === epoch ? Math.max(stored.seq, acked) : acked;
    if (spool.open(sessionId, epoch, from) && follows.get(sessionId)?.sub) void follow(sessionId);
  }

  /** Send what is unsent, of `only` or of every session; `force`: even over a full socket (a write's own events). */
  function flush(only?: string, force = false) {
    if (timer && !only) {
      clearTimeout(timer);
      timer = undefined;
    }
    let held = 0;
    for (const sessionId of only ? [only] : spool.unsent())
      for (;;) {
        if (!force && (d.buffered?.() ?? 0) > holdBytes) {
          heldSince ||= Date.now();
          return schedule();
        }
        const { epoch, events } = spool.take(sessionId);
        if (!events.length) break;
        if (!d.send({ t: 'journal', sessionId, epoch, events })) {
          spool.rewind(); // the link is down: what was taken goes again after the reconnect (relinked)
          return;
        }
        if (heldSince && !force) {
          held = Date.now() - heldSince;
          heldSince = 0;
        }
        d.meter?.batch(sessionId, events, only !== undefined, held || undefined);
        held = 0;
      }
  }

  function schedule() {
    timer ??= setTimeout(() => {
      timer = undefined;
      flush();
    }, flushMs);
    timer.unref?.();
  }

  function received(sessionId: string, e: JournalEvent) {
    if (!spool.push(sessionId, e)) return;
    const f = follows.get(sessionId);
    if (f && ++f.seen % 64 === 0) f.sub?.ack(e.seq);
    const ws = waiters.get(sessionId);
    if (ws) {
      const left = ws.filter((w) => (e.seq >= w.seq ? (w.done(), false) : true));
      if (left.length) waiters.set(sessionId, left);
      else waiters.delete(sessionId);
    }
    if (URGENT.has(e.type)) flush(sessionId);
    else schedule();
  }

  function progressed(sessionId: string, delta: JournalDelta) {
    if (delta.type !== 'subagent.progress') return;
    const v = delta.data as SubagentProgress;
    if (typeof v?.subagentId !== 'string') return;
    const p: Progress = progress.get(sessionId) ?? { by: new Map(), dirty: false, at: 0 };
    progress.set(sessionId, p);
    p.by.set(v.subagentId, { subagentId: v.subagentId, activity: v.activity ?? null, toolCalls: v.toolCalls ?? 0, tokens: v.tokens ?? 0 });
    p.dirty = true;
    if (p.timer) return;
    const wait = p.at + progressMs - Date.now();
    if (wait <= 0) return sendProgress(sessionId);
    p.timer = setTimeout(() => sendProgress(sessionId), wait);
    p.timer.unref?.();
  }

  function sendProgress(sessionId: string) {
    const p = progress.get(sessionId);
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = undefined;
    const epoch = spool.get(sessionId)?.epoch;
    if (!p.dirty || !p.by.size || epoch === undefined) return;
    p.dirty = false;
    p.at = Date.now();
    d.send({ t: 'subagent-progress', sessionId, epoch, progress: [...p.by.values()] });
  }

  function forgetProgress(sessionId: string) {
    clearTimeout(progress.get(sessionId)?.timer);
    progress.delete(sessionId);
  }

  /** Subscribe the mirror to the session's writer now, from the last seq it has seen. */
  async function follow(sessionId: string): Promise<void> {
    if (stopped) return;
    const f = follows.get(sessionId) ?? { gen: 0, seen: 0 };
    follows.set(sessionId, f);
    const gen = ++f.gen;
    f.sub?.close();
    f.sub = undefined;
    f.following = true; // `reached` waits for the subscription (review r1 P2-4)
    try {
      await subscribe(sessionId, f, gen);
    } finally {
      if (gen === f.gen) f.following = false;
    }
  }

  async function subscribe(sessionId: string, f: { gen: number; sub?: PortSubscription; seen: number }, gen: number) {
    const w = await d.writer(sessionId, false).catch(() => undefined);
    if (!w || gen !== f.gen) return;
    const after = spool.get(sessionId)?.received ?? d.acks?.get(sessionId)?.seq ?? 0;
    // Events before the writer said its epoch wait here; a writer at an older epoch than the mirror's is never relabelled.
    let epoch: number | undefined;
    const early: JournalEvent[] = [];
    const take = (e: JournalEvent) => {
      if (e.type === 'subagent.ended') progress.get(sessionId)?.by.delete((e.data as { subagent?: { id?: string } })?.subagent?.id ?? '');
      received(sessionId, e);
    };
    const r = await w
      .subscribe({
        after,
        deltas: true, // `subagent.progress` alone: the writer sends a mirror no others (hub.ts)
        mirror: true,
        onEvent: (e) => {
          if (gen !== f.gen) return;
          if (epoch === undefined) early.push(e);
          else take(e);
        },
        onDelta: (delta) => gen === f.gen && progressed(sessionId, delta),
        onDetached: (reason) => {
          if (gen !== f.gen) return;
          f.sub = undefined;
          // `moved`: the runner exited or started; `too_far_behind`: never expected (the mirror reads at once). Either way, again.
          if (reason !== 'access_lost') setTimeout(() => gen === f.gen && void follow(sessionId), retryMs).unref?.();
        },
      })
      .catch((e: unknown): { error: ApiError } => ({ error: apiError('internal', String((e as Error)?.message ?? e), 500) }));
    if (gen !== f.gen) {
      if (!('error' in r)) r.close();
      return;
    }
    if ('error' in r) {
      log.warn(`mirror: cannot follow ${sessionId}: ${r.error.code} ${r.error.message}`);
      if (r.error.code !== 'session_not_found') setTimeout(() => gen === f.gen && void follow(sessionId), retryMs * 4).unref?.();
      return;
    }
    const s = spool.get(sessionId);
    if (s && r.attached.epoch < s.epoch) {
      // A writer the log's epoch moved past (an `epoch` frame is being adopted): its events are not the DO's. Adoption follows again.
      log.warn(`mirror: ${sessionId}'s writer is at epoch ${r.attached.epoch}, the log at ${s.epoch}: not followed`);
      r.close();
      return;
    }
    f.sub = r;
    epoch = r.attached.epoch;
    // First sight of the session (a rediscovered runner), or a writer that adopted a newer epoch: the mirror takes its epoch.
    if (!s || epoch > s.epoch) open(sessionId, epoch, s ? Math.min(s.acked, after) : after);
    for (const e of early.splice(0)) take(e);
  }

  /** Resolves once the mirror has seen `seq` of the session, or after `ms`. */
  function reached(sessionId: string, seq: number, ms: number) {
    const s = spool.get(sessionId);
    const f = follows.get(sessionId);
    if (!s || s.received >= seq || !(f?.sub || f?.following)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      const list = waiters.get(sessionId) ?? [];
      list.push({ seq, done: () => (clearTimeout(t), resolve()) });
      waiters.set(sessionId, list);
    });
  }

  /** Hand the frame to the session's writer, in arrival order per session; the result once its events went up. */
  async function api(m: ApiFrame): Promise<void> {
    const reply = (o: CallOutcome) => void d.send({ t: 'api-result', id: m.id, ...(o.error ? { error: o.error } : { result: o.result }) });
    if (!isMethod(m.method) || !WRITER_METHODS.has(m.method))
      return reply({ error: apiError('invalid_request', `${m.method} is not a session writer's method`, 400, { field: 'method' }) });
    const params = withSession(m.params, m.sessionId);
    if ('error' in params) return reply(params);
    const ctx: CallContext = { actor: m.actor, member: m.member, idempotencyKey: m.idempotencyKey, requestId: m.requestId };
    let issued: Promise<CallOutcome> = Promise.resolve({ error: apiError('session_not_found', `no session ${m.sessionId} on this computer`, 404) });
    const step = (chains.get(m.sessionId) ?? Promise.resolve()).then(async () => {
      const w = await d.writer(m.sessionId, true);
      if (w) issued = w.call(m.method, params.value, ctx);
    });
    const tail = step.catch(() => {});
    chains.set(m.sessionId, tail);
    let outcome: CallOutcome;
    try {
      await step;
      outcome = await issued;
    } catch (e) {
      outcome = { error: apiError('unavailable', String((e as Error)?.message ?? e), 503, { retryable: true }) };
    } finally {
      if (chains.get(m.sessionId) === tail) chains.delete(m.sessionId);
    }
    const seq = (outcome.result as { seq?: unknown } | undefined)?.seq;
    if (typeof seq === 'number') {
      await reached(m.sessionId, seq, seqWaitMs);
      flush(m.sessionId, true);
    }
    reply(outcome);
  }

  function ack(m: AckFrame) {
    const s = spool.get(m.sessionId);
    if (!s || m.epoch !== s.epoch) return;
    spool.ack(m.sessionId, m.epoch, m.seq);
    d.meter?.acked(m.sessionId, m.seq);
    d.acks?.set(m.sessionId, m.epoch, spool.get(m.sessionId)?.acked ?? m.seq);
    const after = spool.get(m.sessionId);
    if (after && after.acked >= after.received && !follows.get(m.sessionId)?.sub) spool.drop(m.sessionId);
  }

  /** Mirror what the journal on disk holds up to `lastSeq` (a session no writer holds: the boot scan's). */
  function backlog(sessionId: string, epoch: number, lastSeq: number) {
    open(sessionId, epoch, 0);
    spool.extend(sessionId, lastSeq);
    schedule();
  }

  return {
    open,
    backlog,
    follow,
    api,
    ack,
    /** The gateway socket is new (after its hello): everything unacked goes again. */
    relinked() {
      d.meter?.relinked();
      spool.rewind();
      flush();
    },
    /** The writer of the session is gone for good (no runner, no host writer): stop following it. */
    unfollow(sessionId: string) {
      const f = follows.get(sessionId);
      if (!f) return;
      f.gen++;
      f.sub?.close();
      follows.delete(sessionId);
      forgetProgress(sessionId);
      d.meter?.forget(sessionId);
    },
    get spooledBytes() {
      return spool.bytes;
    },
    /** For tests and host.sample. */
    state: (sessionId: string) => spool.get(sessionId),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const id of [...progress.keys()]) forgetProgress(id);
      for (const f of follows.values()) {
        f.gen++;
        f.sub?.close();
      }
      follows.clear();
    },
  };
}

export type ApiBridge = ReturnType<typeof apiBridge>;

/** The params with the frame's session id, which every writer method takes; a different one in the params is refused. */
function withSession(params: unknown, sessionId: string): { value: unknown } | { error: ApiError } {
  if (params === undefined || params === null) return { value: { sessionId } };
  if (typeof params !== 'object' || Array.isArray(params)) return { error: apiError('invalid_request', 'params must be an object', 400, { field: 'params' }) };
  const p = params as Record<string, unknown>;
  if (p.sessionId !== undefined && p.sessionId !== sessionId)
    return { error: apiError('invalid_request', 'params.sessionId differs from the frame', 400, { field: 'sessionId' }) };
  return { value: { ...p, sessionId } };
}
