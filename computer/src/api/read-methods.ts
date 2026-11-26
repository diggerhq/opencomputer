// The writer's side of `Writer.call` that both writers share (work 084): the
// dispatch (decode strictly, check the session, route), every read answered
// from the log (`sessions.get`, `turns.get`, `asks.list`, `asks.get`,
// `subagents.list`, `subagents.get`, `events.list`, with `minSeq` and
// long-polls), and idempotency for writes.
//
// Invariants:
// - `call` never throws: a bad method or params is `invalid_request` naming
//   the field, another session's id is `session_not_found`, a throw is
//   `internal`.
// - Idempotency: one key per (member, operation); the record is
//   sha256(member|op|key) and a hash of the normalised params, written to the
//   journal after the write succeeded (24 h). A repeat with the same params
//   gets the first result with the objects in it re-read from the fold (the
//   current state) and `duplicate: true` where the result has that field; a
//   different body is `409 idempotency_conflict`; a concurrent repeat waits for
//   the first. Errors are not recorded: a retry of a failed write runs again.

import { createHash } from 'node:crypto';
import type { JournalEvent } from '../protocol.js';
import { decodeParams, isMethod, type Method, type ParamsOf, WRITER_METHODS, WRITES } from './schema-methods.js';
import type { Turn } from './schema-objects.js';
import type { SessionLog } from './session-log.js';
import { loadResult } from './subagent-results.js';
import { Schema } from 'effect';
import { EVENT_DATA } from './schema-events.js';
import { apiError, type CallContext, type CallOutcome, RECORD_METHOD, RECORDABLE } from './writer.js';
import { type CursorKind, decodeCursor, encodeCursor } from './list-cursor.js';

/** A write's implementation, given decoded params. */
export type WriteHandler<M extends Method = Method> = (params: ParamsOf<M>, ctx: CallContext) => Promise<CallOutcome> | CallOutcome;
export type WriteHandlers = { [M in Method]?: WriteHandler<M> };

const MIN_SEQ_WAIT_MS = 2000;
const ENDED = ['completed', 'failed', 'cancelled'];

const ok = (result: unknown): CallOutcome => ({ result });
const fail = (code: string, message: string, status: number, extra: Record<string, unknown> = {}): CallOutcome => ({
  error: apiError(code, message, status, { retryable: status >= 500 || status === 429, ...extra }),
});

/** `Writer.call` for the session of `log`: reads from the log, writes through `writes`. */
export function dispatch(
  log: SessionLog,
  writes: WriteHandlers,
): (method: string, params: unknown, ctx: CallContext) => Promise<CallOutcome> {
  return async (method, params, ctx) => {
    if (method === RECORD_METHOD) return record(log, params, ctx);
    if (!isMethod(method) || !WRITER_METHODS.has(method)) return fail('invalid_request', `unknown method ${method}`, 400, { field: 'method' });
    const p = decodeParams(method, params);
    if (!p.ok) return fail('invalid_request', p.message, 400, { field: p.field });
    const v = p.value as ParamsOf<Method> & { sessionId?: string; idempotencyKey?: string };
    if (v.sessionId !== log.sessionId) return fail('session_not_found', `no session ${v.sessionId} here`, 404);
    try {
      if (!WRITES.has(method)) return await readCall(log, method, v);
      const handler = writes[method] as WriteHandler | undefined;
      if (!handler) return fail('feature_unavailable', `${method} is not available on this writer`, 409, { feature: method });
      const run = async () => handler(v, ctx);
      const key = ctx.idempotencyKey ?? v.idempotencyKey;
      return key ? await idempotent(log, method, v, { ...ctx, idempotencyKey: key }, run) : await run();
    } catch (e) {
      return fail('internal', (e as Error).message ?? String(e), 500);
    }
  };
}

/** `host.record`: append one of RECORDABLE with its data decoded strictly, as `ctx.actor`; answers `{seq}`. */
function record(log: SessionLog, params: unknown, ctx: CallContext): CallOutcome {
  const p = (params ?? {}) as { sessionId?: unknown; type?: unknown; data?: unknown };
  if (p.sessionId !== log.sessionId) return fail('session_not_found', `no session ${String(p.sessionId)} here`, 404);
  const type = RECORDABLE.find((t) => t === p.type);
  if (!type) return fail('invalid_request', `cannot record ${String(p.type)}`, 400, { field: 'type' });
  try {
    const data = Schema.decodeUnknownSync(EVENT_DATA[type] as Schema.Codec<unknown>)(p.data, { onExcessProperty: 'error' });
    return ok({ seq: log.append(type, data, { actor: ctx.actor }).seq });
  } catch (e) {
    return fail('invalid_request', (e as Error).message ?? String(e), 400, { field: 'data' });
  }
}

// ---------------------------------------------------------------- reads

/** Wait (≤ 2 s) until the log has `minSeq`; an error outcome when it does not. */
async function reach(log: SessionLog, minSeq: number | undefined): Promise<CallOutcome | undefined> {
  if (minSeq === undefined || minSeq <= log.lastSeq) return undefined;
  if (await log.waitFor(() => log.lastSeq >= minSeq, MIN_SEQ_WAIT_MS)) return undefined;
  return fail('unavailable', `the log has not reached seq ${minSeq}`, 503, { retryAfterMs: 500 });
}

const typeFilter = (types: string | undefined): ((t: string) => boolean) => {
  if (!types) return () => true;
  const wanted = types.split(',').map((s) => s.trim()).filter(Boolean);
  return (t) => wanted.some((w) => (w.endsWith('*') ? t.startsWith(w.slice(0, -1)) : t === w));
};

/**
 * Newest first, `limit` (default 20) below the cursor's seq. Cursors are blue's (list-cursor.ts): bound to the list and
 * its `filter`, so a cursor from HTTP continues here and the reverse, and another filter set is `invalid_cursor`.
 */
function page<T extends { id: string }>(name: string, kind: CursorKind, filter: string, newestFirst: T[], seqOf: (id: string) => number, cursor: string | undefined, limit = 20): CallOutcome {
  let items = newestFirst;
  if (cursor !== undefined) {
    const before = decodeCursor(kind, cursor, filter);
    if (before === null) return fail('invalid_cursor', 'cursor is not from this listing.', 400, { field: 'cursor' });
    items = items.filter((x) => seqOf(x.id) < before);
  }
  const out = items.slice(0, limit);
  return ok({ [name]: out, nextCursor: items.length > limit ? encodeCursor(kind, seqOf(out[out.length - 1].id), filter) : null });
}

/** A read method, answered from the log. */
export async function readCall(log: SessionLog, method: Method, params: Record<string, unknown>): Promise<CallOutcome> {
  const fold = log.fold;
  switch (method) {
    case 'sessions.get': {
      const p = params as ParamsOf<'sessions.get'>;
      return (await reach(log, p.minSeq)) ?? ok({ session: fold.session() });
    }
    case 'turns.get': {
      const p = params as ParamsOf<'turns.get'>;
      const late = await reach(log, p.minSeq);
      if (late) return late;
      const first = fold.turn(p.turnId);
      if (!first) return fail('turn_not_found', `no turn ${p.turnId}`, 404);
      const done = (t: Turn | undefined) => !t || (p.status ? t.status !== p.status : ENDED.includes(t.status));
      if (p.waitMs && !done(first)) await log.waitFor(() => done(fold.turn(p.turnId)), p.waitMs);
      return ok({ turn: fold.turn(p.turnId) ?? first });
    }
    case 'asks.get': {
      const p = params as ParamsOf<'asks.get'>;
      const ask = fold.ask(p.askId);
      return ask ? ok({ ask }) : fail('ask_not_found', `no ask ${p.askId}`, 404);
    }
    case 'asks.list': {
      const p = params as ParamsOf<'asks.list'>;
      const status = p.status ?? 'open';
      const all = fold.asks().filter((a) => status === 'all' || status.split(',').includes(a.status));
      return page('asks', 'a', status, all.reverse(), (id) => fold.seqOf(id), p.cursor, p.limit);
    }
    case 'subagents.get': {
      const p = params as ParamsOf<'subagents.get'>;
      const subagent = fold.subagent(p.subagentId);
      if (!subagent) return fail('subagent_not_found', `no subagent ${p.subagentId}`, 404);
      const whole = subagent.resultTruncated ? loadResult(log.journal.file, subagent.id) : undefined;
      return ok({ subagent: whole === undefined ? subagent : { ...subagent, result: whole, resultTruncated: false } });
    }
    case 'subagents.list': {
      const p = params as ParamsOf<'subagents.list'>;
      const status = p.status === 'all' ? 'all' : 'running';
      const all = status === 'all' ? fold.subagents() : fold.runningSubagents();
      return page('subagents', 's', status, all.reverse(), (id) => fold.seqOf(id), p.cursor, p.limit);
    }
    case 'events.list':
      return eventsList(log, params as ParamsOf<'events.list'>);
    default:
      return fail('invalid_request', `${method} is not a read`, 400, { field: 'method' });
  }
}

async function eventsList(log: SessionLog, p: ParamsOf<'events.list'>): Promise<CallOutcome> {
  if (p.tailTurns !== undefined && p.after !== undefined) return fail('invalid_request', 'tailTurns cannot be combined with after', 400, { field: 'tailTurns' });
  const limit = p.limit ?? 100;
  let after = p.after ?? 0;
  let earlierTurns: Turn[] | null = null;
  if (p.tailTurns !== undefined) {
    after = log.journal.tailTurnsAfter(p.tailTurns);
    earlierTurns = log.earlierTurns(p.tailTurns);
  }
  if (after > log.lastSeq) return fail('cursor_ahead', `after ${after} is past the log's last seq ${log.lastSeq}`, 409, { session: log.fold.session() });
  if (p.waitMs && after >= log.lastSeq) await log.waitFor(() => log.lastSeq > after, p.waitMs);
  const want = typeFilter(p.types);
  const events: JournalEvent[] = [];
  let scanned = after;
  // Filters leave gaps; page through the log until the page is full or the log ends.
  while (events.length < limit && scanned < log.lastSeq) {
    const batch = log.hub.since(scanned, 500);
    if (!batch.length) {
      scanned = log.lastSeq; // the rest is not on file (a new epoch past the local tail)
      break;
    }
    for (const e of batch) {
      scanned = e.seq;
      if ((!p.turnId || e.turnId === p.turnId) && want(e.type)) {
        events.push(e);
        if (events.length >= limit) break;
      }
    }
  }
  const lastSeq = log.lastSeq;
  // The scan stops at a full page (its last event) or at the log's end, so the last event's seq is the next `after`.
  return ok({ events, earlierTurns, lastSeq, hasMore: scanned < lastSeq });
}

// ---------------------------------------------------------------- idempotency

const inflight = new WeakMap<SessionLog, Map<string, Promise<CallOutcome>>>();

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with sorted keys, so equal params hash equally. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The params as one request: no key, defaults filled in (an omitted ifBusy is `queue`). */
function normalised(method: Method, params: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey: _, ...rest } = params;
  if (method === 'turns.send') rest.ifBusy ??= 'queue';
  return rest;
}

/** The stored result as of now: its turn, ask or session re-read from the fold. */
function current(log: SessionLog, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = { ...(result as Record<string, unknown>) };
  const id = (x: unknown) => (x && typeof x === 'object' ? (x as { id?: string }).id : undefined);
  const tid = id(r.turn);
  if (tid) r.turn = log.fold.turn(tid) ?? r.turn;
  const aid = id(r.ask);
  if (aid) r.ask = log.fold.ask(aid) ?? r.ask;
  if (r.session) r.session = log.fold.session();
  if ('duplicate' in r) r.duplicate = true;
  return r;
}

/** Run `run` once per (member, method, key); see the header. */
export async function idempotent(
  log: SessionLog,
  method: Method,
  params: Record<string, unknown>,
  ctx: CallContext,
  run: () => Promise<CallOutcome>,
): Promise<CallOutcome> {
  const key = ctx.idempotencyKey;
  if (!key) return run();
  const id = sha256(`${ctx.member}|${method}|${key}`);
  const hash = sha256(stable(normalised(method, params)));
  let mine = inflight.get(log);
  if (!mine) inflight.set(log, (mine = new Map()));
  const pending = mine.get(id);
  if (pending) await pending.catch(() => undefined);
  const seen = log.journal.idemGet(id);
  if (seen) {
    if (seen.hash !== hash) return fail('idempotency_conflict', 'this idempotency key was used for a different request', 409);
    return ok(current(log, seen.result));
  }
  const p = run();
  mine.set(id, p);
  try {
    const out = await p;
    if (!out.error) log.journal.idemPut({ id, op: method, hash, result: out.result, seq: log.lastSeq });
    return out;
  } finally {
    if (mine.get(id) === p) mine.delete(id);
  }
}
