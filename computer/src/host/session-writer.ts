// The host's writer for a session no runner is serving (work 084, "One
// writer, one log"): it holds the session's journal lock, answers reads from
// the log, and records the writes that need no agent (a send is queued and the
// runner woken; update, suspend, resume, interrupt and cancel of queued turns,
// closing asks, stopping subagents), so the API works while the session
// sleeps. `scanJournals` is the boot scan: it settles every turn, ask and
// subagent a dead runner left open.
//
// Invariants:
// - It writes only while it holds the journal's flock; `handOff` detaches
//   subscribers (`moved`), closes its socket and drops the lock, after which
//   the runner opens the journal. It never runs a turn: every turn it records
//   is `queued`, and the runner it wakes starts them.
// - Events it records match EVENT_DATA exactly (every field, null when it
//   does not apply); writes go through read-methods' dispatch, so decoding,
//   errors and idempotency are the runner's.
// - The boot scan writes under the file's own epoch and only to journals it
//   can lock at once (a running runner's journal is skipped); a later, higher
//   epoch from the DO truncates past the DO's lastSeq, so the DO's copy wins.

import fs from 'node:fs';
import path from 'node:path';
import type { ApiActor, ApiDelivery, ApiError } from '../protocol.js';
import { log as logger } from '../log.js';
import { isSessionId, mintId } from '../session-ids.js';
import type { SessionCreated } from '../api/created.js';
import { type SessionSeed, SYSTEM_ACTOR } from '../api/fold.js';
import { listJournals } from '../api/journal-dir.js';
import { JournalError, readJournalFile } from '../api/journal.js';
import { dispatch, type WriteHandlers } from '../api/read-methods.js';
import { SessionLog } from '../api/session-log.js';
import { type ApiServer, serveApi } from '../api/socket.js';
import type { Subagent } from '../api/schema-objects.js';
import { apiError, type CallContext, type CallOutcome, type SubscribeOptions, type Subscription, type Writer } from '../api/writer.js';

/** Queued turns a session takes before `queue_full`. */
export const QUEUE_MAX = 20;

export interface HostWriterOptions {
  sessionId: string;
  /** The journal file (journalPath(HOST_DATA, sessionId)). */
  journal: string;
  epoch: number;
  lastSeq: number;
  epochStartSeq?: number;
  seed: SessionSeed;
  /** Recorded first when the journal is empty (created.ts). */
  created?: SessionCreated;
  /** Start the session's runner; with `delivery`, the turn it should run (recorded here as queued). */
  wake(sessionId: string, delivery?: ApiDelivery): void;
  /** Serve the API on this socket too (the relay's `where`). */
  socket?: { path: string; token: string };
  /** Wait for the journal's lock (a runner handing it back); default 0. */
  waitMs?: number;
  redact?: (s: string) => string;
}

const fail = (code: string, message: string, status: number, extra: Record<string, unknown> = {}): CallOutcome => ({
  error: apiError(code, message, status, { retryable: status >= 500, ...extra }),
});

export class HostSessionWriter implements Writer {
  readonly call: Writer['call'];
  private server?: ApiServer;

  private constructor(
    readonly log: SessionLog,
    private o: HostWriterOptions,
  ) {
    this.call = dispatch(log, this.handlers());
  }

  /** Take the journal (throws JournalError `locked` while a runner holds it) and serve. */
  static async open(o: HostWriterOptions): Promise<HostSessionWriter> {
    const log = await SessionLog.open(o.journal, {
      sessionId: o.sessionId,
      epoch: o.epoch,
      lastSeq: o.lastSeq,
      epochStartSeq: o.epochStartSeq,
      waitMs: o.waitMs,
      redact: o.redact,
      seed: o.seed,
      created: o.created,
    });
    const w = new HostSessionWriter(log, o);
    if (o.socket) {
      try {
        w.server = await serveApi(o.socket.path, w, { token: o.socket.token });
      } catch (e) {
        await log.release();
        throw e;
      }
    }
    return w;
  }

  get sessionId(): string {
    return this.log.sessionId;
  }

  subscribe(o: SubscribeOptions): Subscription | { error: ApiError } {
    return this.log.subscribe(o);
  }

  /** Detach subscribers (`moved`), stop serving and drop the lock: the runner may open the journal now. */
  async handOff(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
    await this.log.release('moved');
  }

  // ---------------------------------------------------------------- writes

  private status(to: string, actor: ApiActor | null): void {
    const from = this.log.fold.status;
    if (from !== to) this.log.append('session.status_changed', { from, to }, { actor });
  }

  /** Record that the runner is coming (unless it already is) and wake it. */
  private starting(actor: ApiActor, delivery?: ApiDelivery): void {
    const s = this.log.fold.status;
    if (s === 'suspended' || s === 'idle') {
      this.status('starting', actor);
      this.log.append('runtime.starting', { phase: 'agent' }, { actor: SYSTEM_ACTOR });
    }
    this.o.wake(this.sessionId, delivery);
  }

  /** The runner a send woke never came: the queued turns fail, so a client stops waiting on them. */
  failQueued(message: string): void {
    const queued = this.log.fold.liveTurns().filter((t) => t.status === 'queued');
    for (const t of queued) this.log.append('turn.failed', { error: { code: 'runtime_failed', message } }, { turnId: t.id, actor: SYSTEM_ACTOR });
    if (queued.length && this.log.fold.status === 'starting') this.status('suspended', SYSTEM_ACTOR);
  }

  private sessionResult(seq0: number): CallOutcome {
    return { result: { session: this.log.fold.session(), seq: Math.max(seq0, this.log.lastSeq) } };
  }

  private cancelQueued(turnId: string, reason: 'interrupted' | 'withdrawn', actor: ApiActor): void {
    const t = this.log.fold.turn(turnId);
    if (t?.status !== 'queued') return;
    this.log.append('turn.cancelled', { reason, forced: false, input: t.input }, { turnId, actor });
  }

  /** A started turn no runner runs (it crashed; the DO's recovery has not come): end it as a forced interrupt. */
  private cancelOrphan(turnId: string, actor: ApiActor): void {
    const fold = this.log.fold;
    const t = fold.turn(turnId);
    if (!t || t.status === 'queued') return;
    if (t.status !== 'cancelling') this.log.append('turn.status_changed', { from: t.status, to: 'cancelling' }, { turnId, actor });
    for (const a of fold.runningSubagents().filter((a) => a.turnId === turnId))
      this.log.append('subagent.ended', { subagent: ended(a, 'failed', { error: { ...LOST } }) }, { turnId, actor: SYSTEM_ACTOR });
    for (const ask of fold.openAsks().filter((a) => a.turnId === turnId))
      this.log.append(
        'ask.closed',
        { ask: { ...ask, status: 'interrupted', closedAt: new Date().toISOString(), closedBy: null, answer: null } },
        { turnId, actor: SYSTEM_ACTOR },
      );
    for (const c of fold.openCalls(turnId))
      this.log.append(
        'tool.failed',
        {
          subagentId: c.subagentId,
          toolName: c.toolName,
          callId: c.callId,
          parentCallId: c.parentCallId,
          title: c.title,
          message: LOST.message,
          settledBy: 'turn.cancelled',
        },
        { turnId, actor: SYSTEM_ACTOR },
      );
    this.log.append('turn.cancelled', { reason: 'interrupted', forced: true, input: t.input }, { turnId, actor });
  }

  private handlers(): WriteHandlers {
    const log = this.log;
    const fold = log.fold;
    return {
      'turns.send': (p, ctx) => {
        const queued = fold.liveTurns().filter((t) => t.status === 'queued');
        if (queued.length >= QUEUE_MAX) return fail('queue_full', `at most ${QUEUE_MAX} turns may wait`, 409, { retryable: true, retryAfterMs: 5000 });
        const ifBusy = p.ifBusy ?? 'queue';
        const turnId = mintId('tn');
        log.append('message.received', { input: p.input, ifBusy, delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] }, { turnId, actor: ctx.actor });
        const e = log.append('turn.queued', { position: queued.length + 1, trigger: 'message', subagentId: null }, { turnId, actor: ctx.actor });
        this.starting(ctx.actor, delivery(ctx, ifBusy, turnId));
        return { result: { turn: fold.turn(turnId), delivery: 'queued', duplicate: false, seq: Math.max(e.seq, log.lastSeq) } };
      },
      'sessions.update': (p, ctx) => {
        const s = fold.session();
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const set = (k: string, from: unknown, to: unknown) => {
          if (to !== undefined && from !== to) changes[k] = { from, to };
        };
        set('title', s.title, p.title);
        set('archived', s.archived, p.archived);
        set('model', s.settings.model, p.model);
        set('effort', s.settings.effort, p.effort);
        set('speed', s.settings.speed, p.speed);
        set('mode', s.settings.mode, p.mode);
        for (const [k, v] of Object.entries(p.metadata ?? {})) set(`metadata.${k}`, s.metadata[k] ?? null, v);
        const seq0 = log.lastSeq;
        if (Object.keys(changes).length) log.append('session.updated', { changes }, { actor: ctx.actor });
        return this.sessionResult(seq0);
      },
      'sessions.suspend': (p, ctx) => {
        const seq0 = log.lastSeq;
        const s = fold.status;
        if (s === 'suspended' || (p.ifIdle && s !== 'idle')) return this.sessionResult(seq0);
        for (const a of fold.runningSubagents()) {
          log.append('subagent.ended', { subagent: ended(a, 'stopped', { stoppedBy: publicActor(ctx.actor) }) }, { turnId: a.turnId, actor: ctx.actor });
        }
        log.append('runtime.suspended', { reason: 'requested' }, { actor: ctx.actor });
        this.status('suspended', ctx.actor);
        return this.sessionResult(seq0);
      },
      'sessions.resume': (_p, ctx) => {
        const seq0 = log.lastSeq;
        if (fold.status === 'suspended') this.starting(ctx.actor);
        return this.sessionResult(seq0);
      },
      'sessions.interrupt': (p, ctx) => {
        const seq0 = log.lastSeq;
        const live = fold.liveTurns();
        if (p.turnId && !live.some((t) => t.id === p.turnId)) return this.sessionResult(seq0);
        for (const t of live) {
          if (t.status === 'queued') this.cancelQueued(t.id, 'interrupted', ctx.actor);
          else this.cancelOrphan(t.id, ctx.actor); // the host holds the lock: no runner runs it (review r1 P2-5)
        }
        if (live.some((t) => t.status !== 'queued') && fold.status !== 'suspended') {
          log.append('runtime.suspended', { reason: 'lost' }, { actor: SYSTEM_ACTOR });
          this.status('suspended', SYSTEM_ACTOR);
        }
        return this.sessionResult(seq0);
      },
      'sessions.compact': (_p, ctx) => {
        // Compaction needs the agent: wake it; the caller retries (same key) once it serves.
        this.starting(ctx.actor);
        return fail('unavailable', 'the session is starting; retry', 503, { retryable: true, retryAfterMs: 2000 });
      },
      'turns.cancel': (p, ctx) => {
        const t = fold.turn(p.turnId);
        if (!t) return fail('turn_not_found', `no turn ${p.turnId}`, 404);
        if (t.status !== 'queued') return fail('turn_not_cancellable', `the turn is ${t.status}`, 409, { turn: t });
        this.cancelQueued(t.id, 'withdrawn', ctx.actor);
        return { result: { turn: fold.turn(t.id), seq: log.lastSeq } };
      },
      'subagents.stop': (p, ctx) => {
        const a = fold.subagent(p.subagentId);
        if (!a) return fail('subagent_not_found', `no subagent ${p.subagentId}`, 404);
        if (a.status !== 'running') {
          if (a.status === 'stopped' && a.stoppedBy?.id === ctx.actor.id) return { result: { subagent: a, seq: log.lastSeq } };
          return fail('subagent_ended', `the subagent is ${a.status}`, 409, { subagent: a });
        }
        // Running with no runner: what a crash left before the boot scan reached it.
        const e = log.append('subagent.ended', { subagent: ended(a, 'stopped', { stoppedBy: publicActor(ctx.actor) }) }, { turnId: a.turnId, actor: ctx.actor });
        return { result: { subagent: fold.subagent(a.id), seq: e.seq } };
      },
      'asks.answer': (p, ctx) => this.closeAsk(p.askId, 'answered', p.answer, ctx),
      'asks.dismiss': (p, ctx) => this.closeAsk(p.askId, 'dismissed', p.message === undefined ? null : { message: p.message }, ctx),
    };
  }

  /**
   * An ask open with no runner (a crash the boot scan has not reached): record its close. Normally
   * the scan has closed it as `interrupted` and this answers `ask_closed`.
   */
  private closeAsk(askId: string, status: 'answered' | 'dismissed', answer: unknown, ctx: CallContext): CallOutcome {
    const ask = this.log.fold.ask(askId);
    if (!ask) return fail('ask_not_found', `no ask ${askId}`, 404);
    if (ask.status !== 'open') return fail('ask_closed', `the ask is ${ask.status}`, 409, { ask });
    const closed = { ...ask, status, closedAt: new Date().toISOString(), closedBy: actorOf(ctx.actor), answer: status === 'answered' ? answer : null };
    const e = this.log.append('ask.closed', { ask: closed }, { turnId: ask.turnId, actor: ctx.actor });
    return { result: { ask: this.log.fold.ask(askId) ?? closed, seq: e.seq } };
  }
}

const actorOf = (a: ApiActor) => ({ ...a, name: a.name ?? a.id });

const delivery = (ctx: CallContext, ifBusy: ApiDelivery['ifBusy'], turnId: string): ApiDelivery => ({
  actor: ctx.actor,
  member: ctx.member,
  ifBusy,
  turnId,
  ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
});

/** A running subagent as ended now. */
const publicActor = (a: ApiActor) => ({ id: a.id, name: a.name ?? a.id, via: a.via, client: a.client });

function ended(a: Subagent, status: 'failed' | 'stopped', extra: Partial<Subagent> = {}): Subagent {
  const now = new Date();
  return { ...a, status, activity: null, endedAt: now.toISOString(), durationMs: Math.max(0, now.getTime() - Date.parse(a.createdAt)) || 0, ...extra };
}

// ---------------------------------------------------------------- boot scan

export interface ScanResult {
  sessionId: string;
  file: string;
  epoch: number;
  lastSeq: number;
  /** Turns this scan ended (`turn.failed runtime_lost`). */
  closedTurns: string[];
  /** Not scanned: a writer holds it (`locked`), it could not be read (`error`), or its epoch is ahead of its events (`torn`). */
  skipped?: 'locked' | 'error' | 'torn';
}

const LOST = { code: 'runtime_lost', message: 'The agent process ended unexpectedly' } as const;

/**
 * Boot: for every journal in `dir` (one directory per session, journal-dir.ts) no writer holds, close what a dead runner left open, under the
 * file's epoch: per unended turn, `tool.failed` (settledBy `turn.failed`) for each open call, then
 * `turn.failed runtime_lost`; every open ask `ask.closed` as `interrupted`; then, if anything
 * was open or the session was not suspended, `runtime.suspended {reason: 'lost'}` and the status.
 */
export async function scanJournals(dir: string, o: { owner?: SessionSeed['owner'] } = {}): Promise<ScanResult[]> {
  const out: ScanResult[] = [];
  for (const { sessionId, file } of listJournals(dir)) {
    const { epoch, through, lastSeq } = readJournalFile(file, Number.MAX_SAFE_INTEGER, 0);
    if (!epoch) continue;
    const r: ScanResult = { sessionId, file, epoch, lastSeq: 0, closedTurns: [] };
    out.push(r);
    // An adoption torn before the DO's events landed: settling would write our own events at the log's seqs. The
    // gateway's `epoch` (hello.journals shows it behind) brings the real ones (review r2 P1-2).
    if (through > lastSeq) {
      (r.skipped = 'torn'), (r.lastSeq = lastSeq);
      logger.warn('boot scan: epoch ahead of its events, left for the gateway', file);
      continue;
    }
    let log: SessionLog;
    try {
      log = await SessionLog.open(file, {
        sessionId,
        epoch,
        lastSeq: 0,
        seed: { sessionId, owner: o.owner ?? { id: 'system', name: 'system', email: null } },
      });
    } catch (e) {
      r.skipped = e instanceof JournalError && e.code === 'locked' ? 'locked' : 'error';
      if (r.skipped === 'error') logger.warn('boot scan: cannot open', file, (e as Error).message);
      continue;
    }
    try {
      settle(log, r);
      r.lastSeq = log.lastSeq;
    } catch (e) {
      r.skipped = 'error';
      logger.warn('boot scan: cannot settle', file, (e as Error).message);
    } finally {
      await log.release();
    }
  }
  return out;
}

function settle(log: SessionLog, r: ScanResult): void {
  const fold = log.fold;
  const actor = SYSTEM_ACTOR;
  let touched = false;
  for (const a of fold.runningSubagents()) {
    log.append('subagent.ended', { subagent: ended(a, 'failed', { error: { ...LOST } }) }, { turnId: a.turnId, actor });
    touched = true;
  }
  for (const ask of fold.openAsks()) {
    const closed = { ...ask, status: 'interrupted', closedAt: new Date().toISOString(), closedBy: null, answer: null };
    log.append('ask.closed', { ask: closed }, { turnId: ask.turnId, actor });
    touched = true;
  }
  for (const t of fold.liveTurns()) {
    for (const c of fold.openCalls(t.id)) {
      log.append(
        'tool.failed',
        { subagentId: c.subagentId, toolName: c.toolName, callId: c.callId, parentCallId: c.parentCallId, title: c.title, message: LOST.message, settledBy: 'turn.failed' },
        { turnId: t.id, actor },
      );
    }
    log.append('turn.failed', { error: { ...LOST } }, { turnId: t.id, actor });
    r.closedTurns.push(t.id);
    touched = true;
  }
  if (touched || fold.status !== 'suspended') {
    log.append('runtime.suspended', { reason: 'lost' }, { actor });
    if (fold.status !== 'suspended') log.append('session.status_changed', { from: fold.status, to: 'suspended' }, { actor });
  }
}
