import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { mintId } from '../session-ids.js';
import { dispatch, type WriteHandlers } from './read-methods.js';
import { METHODS } from './schema-methods.js';
import { Subagent } from './schema-objects.js';
import { RECORD_METHOD } from './writer.js';
import { ANN, ANN_CTX, askOf, openLog, subagentOf, tempSession, turn } from './testing.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fresh(writes: WriteHandlers = {}) {
  const t = tempSession();
  const log = await openLog(t.file, t.sessionId);
  cleanups.push(t.cleanup, () => log.release());
  const call = dispatch(log, writes);
  const sid = t.sessionId;
  return { log, sid, call };
}

/** Results must decode against the method's result schema. */
const decodeResult = (method: keyof typeof METHODS, r: unknown) => Schema.decodeUnknownSync(METHODS[method].result as unknown as Schema.Codec<unknown, unknown>)(r);

describe('dispatch', () => {
  it('rejects unknown methods, bad params, other sessions and missing writes; catches throws', async () => {
    const { sid, call } = await fresh({ 'sessions.update': () => { throw new Error('boom'); } });
    expect((await call('nope', {}, ANN_CTX)).error).toMatchObject({ code: 'invalid_request', field: 'method', status: 400 });
    expect((await call('terminals.open', { sessionId: sid }, ANN_CTX)).error).toMatchObject({ code: 'invalid_request', field: 'method' });
    expect((await call('turns.get', { sessionId: sid, turnId: 'bad' }, ANN_CTX)).error).toMatchObject({ code: 'invalid_request', field: 'turnId' });
    expect((await call('sessions.get', { sessionId: mintId('cs') }, ANN_CTX)).error).toMatchObject({ code: 'session_not_found', status: 404 });
    expect((await call('turns.send', { sessionId: sid, input: 'x' }, ANN_CTX)).error).toMatchObject({ code: 'feature_unavailable', status: 409 });
    expect((await call('sessions.update', { sessionId: sid, title: 'x' }, ANN_CTX)).error).toMatchObject({ code: 'internal', status: 500, retryable: true });
  });

  it('host.record journals only terminal and upload events, data decoded strictly, as the caller', async () => {
    const { log, sid, call } = await fresh();
    const r = await call(RECORD_METHOD, { sessionId: sid, type: 'terminal.opened', data: { terminalId: 'tm_1', command: null } }, ANN_CTX);
    expect(r.result).toEqual({ seq: log.lastSeq });
    const ev = await call('events.list', { sessionId: sid, after: log.lastSeq - 1 }, ANN_CTX);
    expect(ev.result).toMatchObject({ events: [{ type: 'terminal.opened', actor: ANN }] });
    expect((await call(RECORD_METHOD, { sessionId: sid, type: 'turn.completed', data: {} }, ANN_CTX)).error).toMatchObject({ field: 'type' });
    expect((await call(RECORD_METHOD, { sessionId: sid, type: 'terminal.closed', data: { terminalId: 'x', exitCode: 0, extra: 1 } }, ANN_CTX)).error).toMatchObject({ field: 'data' });
    expect((await call(RECORD_METHOD, { sessionId: mintId('cs'), type: 'terminal.closed', data: {} }, ANN_CTX)).error?.code).toBe('session_not_found');
  });

  it('sessions.get and turns.get read the fold; minSeq waits, then 503', async () => {
    const { log, sid, call } = await fresh();
    const t = turn(log, 'hi', 'done');
    const s = await call('sessions.get', { sessionId: sid }, ANN_CTX);
    decodeResult('sessions.get', s.result);
    const g = await call('turns.get', { sessionId: sid, turnId: t }, ANN_CTX);
    expect(decodeResult('turns.get', g.result)).toMatchObject({ turn: { id: t, status: 'completed', text: 'done' } });
    expect((await call('turns.get', { sessionId: sid, turnId: mintId('tn') }, ANN_CTX)).error?.code).toBe('turn_not_found');
    const waiting = call('sessions.get', { sessionId: sid, minSeq: 5 }, ANN_CTX);
    setTimeout(() => turn(log), 20);
    expect((await waiting).result).toMatchObject({ session: { lastSeq: 8 } });
    const t0 = Date.now();
    expect((await call('sessions.get', { sessionId: sid, minSeq: 99 }, ANN_CTX)).error).toMatchObject({ code: 'unavailable', status: 503, retryAfterMs: 500 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  }, 10_000);

  it('turns.get long-polls until the turn ends', async () => {
    const { log, sid, call } = await fresh();
    const t = mintId('tn');
    log.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN });
    const r = call('turns.get', { sessionId: sid, turnId: t, waitMs: 2000, status: 'queued' }, ANN_CTX);
    const p = call('turns.get', { sessionId: sid, turnId: t, waitMs: 2000 }, ANN_CTX);
    setTimeout(() => log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN }), 10);
    setTimeout(() => log.append('turn.completed', { text: 'x', durationMs: 1, silent: false }, { turnId: t, actor: ANN }), 30);
    expect((await r).result).toMatchObject({ turn: { status: 'running' } });
    expect((await p).result).toMatchObject({ turn: { status: 'completed' } });
    // With `status`: returns once the status differs from it (here: at the timeout, as it still is that status).
    const t0 = Date.now();
    const q = call('turns.get', { sessionId: sid, turnId: t, waitMs: 50, status: 'completed' }, ANN_CTX);
    expect((await q).result).toMatchObject({ turn: { status: 'completed' } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  }, 10_000);

  it('asks.list pages newest first; asks.get finds one', async () => {
    const { log, sid, call } = await fresh();
    const t = mintId('tn');
    const asks = [0, 1, 2].map(() => askOf(sid, t));
    for (const a of asks) log.append('ask.opened', { ask: a }, { turnId: t, actor: ANN });
    const p1 = decodeResult('asks.list', (await call('asks.list', { sessionId: sid, limit: 2 }, ANN_CTX)).result) as { asks: { id: string }[]; nextCursor: string };
    expect(p1.asks.map((a) => a.id)).toEqual([asks[2].id, asks[1].id]);
    const p2 = (await call('asks.list', { sessionId: sid, limit: 2, cursor: p1.nextCursor }, ANN_CTX)).result as { asks: { id: string }[]; nextCursor: null };
    expect(p2).toEqual({ asks: [expect.objectContaining({ id: asks[0].id })], nextCursor: null });
    expect((await call('asks.list', { sessionId: sid, cursor: 'zz' }, ANN_CTX)).error).toMatchObject({ code: 'invalid_cursor', status: 400 });
    expect((await call('asks.list', { sessionId: sid, status: 'answered' }, ANN_CTX)).result).toEqual({ asks: [], nextCursor: null });
    expect((await call('asks.get', { sessionId: sid, askId: asks[1].id }, ANN_CTX)).result).toMatchObject({ ask: { id: asks[1].id } });
    expect((await call('asks.get', { sessionId: sid, askId: mintId('ak') }, ANN_CTX)).error?.code).toBe('ask_not_found');
  });

  it('list cursors are blue\'s (base64url kind:seq:filter): an HTTP cursor continues here, another filter is invalid_cursor (review r2 P2-6)', async () => {
    const { log, sid, call } = await fresh();
    const t = mintId('tn');
    const asks = [0, 1, 2].map(() => askOf(sid, t));
    const seqs = asks.map((a) => log.append('ask.opened', { ask: a }, { turnId: t, actor: ANN }).seq);
    // blue's encodeCursor: btoa(`a:${seq}:${filter}`) made URL-safe, padding dropped.
    const blue = (kind: string, seq: number, filter: string) => btoa(`${kind}:${seq}:${filter}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const p1 = (await call('asks.list', { sessionId: sid, limit: 1 }, ANN_CTX)).result as { nextCursor: string };
    expect(p1.nextCursor).toBe(blue('a', seqs[2], 'open'));
    const fromHttp = (await call('asks.list', { sessionId: sid, cursor: blue('a', seqs[1], 'open') }, ANN_CTX)).result as { asks: { id: string }[] };
    expect(fromHttp.asks.map((a) => a.id)).toEqual([asks[0].id]);
    for (const [params, cursor] of [
      [{ status: 'all' }, p1.nextCursor], // made under `open`
      [{}, blue('s', seqs[2], 'open')], // another list's
    ] as const)
      expect((await call('asks.list', { sessionId: sid, ...params, cursor }, ANN_CTX)).error).toMatchObject({ code: 'invalid_cursor', status: 400, field: 'cursor' });
    const subs = await call('subagents.list', { sessionId: sid, status: 'all', cursor: blue('s', 1, 'running') }, ANN_CTX);
    expect(subs.error).toMatchObject({ code: 'invalid_cursor' });
  });

  it('subagents.list (running by default, or all) and subagents.get with the whole result from disk (084 perf fix 7)', async () => {
    const { log, sid, call } = await fresh();
    const t = mintId('tn');
    const a = subagentOf(sid, t);
    const b = subagentOf(sid, t);
    log.append('subagent.started', { subagent: a }, { turnId: t, actor: ANN });
    log.append('subagent.started', { subagent: b }, { turnId: t, actor: ANN });
    log.journal.keepResult(a.id, 'x'.repeat(20_000));
    log.append('subagent.ended', { subagent: { ...a, status: 'completed', result: 'x'.repeat(10), resultTruncated: true, endedAt: new Date().toISOString(), durationMs: 1 } }, { turnId: t, actor: ANN });
    const running = decodeResult('subagents.list', (await call('subagents.list', { sessionId: sid }, ANN_CTX)).result) as { subagents: { id: string }[] };
    expect(running.subagents.map((s) => s.id)).toEqual([b.id]);
    const all = (await call('subagents.list', { sessionId: sid, status: 'all' }, ANN_CTX)).result as { subagents: { id: string }[] };
    expect(all.subagents.map((s) => s.id)).toEqual([b.id, a.id]);
    const got = (await call('subagents.get', { sessionId: sid, subagentId: a.id }, ANN_CTX)).result as { subagent: { result: string; resultTruncated: boolean } };
    Schema.decodeUnknownSync(Subagent)(got.subagent);
    expect(got.subagent.result.length).toBe(20_000);
    expect(got.subagent.resultTruncated).toBe(false);
    expect((await call('subagents.get', { sessionId: sid, subagentId: b.id }, ANN_CTX)).result).toMatchObject({ subagent: { result: null } });
    // Another writer of the session (the host's, a new runner) reads the same file.
    await log.release();
    const again = await openLog(log.journal.file, sid, { redact: (x) => x.replaceAll('hunter2', '[secret]') });
    cleanups.push(() => again.release());
    const other = (await dispatch(again, {})('subagents.get', { sessionId: sid, subagentId: a.id }, ANN_CTX)).result as { subagent: { result: string } };
    expect(other.subagent.result.length).toBe(20_000);
    // A truncated result not on disk (its write failed, an older build): what the event carries.
    const c = subagentOf(sid, t);
    const d = subagentOf(sid, t);
    again.journal.keepResult(d.id, `${'z'.repeat(9000)} hunter2`); // redacted as events are
    again.append('subagent.ended', { subagent: { ...d, status: 'completed', result: 'z', resultTruncated: true, endedAt: new Date().toISOString(), durationMs: 1 } }, { turnId: t, actor: ANN });
    const kept = (await dispatch(again, {})('subagents.get', { sessionId: sid, subagentId: d.id }, ANN_CTX)).result as { subagent: { result: string } };
    expect(kept.subagent.result.endsWith(' [secret]')).toBe(true);
    again.append('subagent.ended', { subagent: { ...c, status: 'completed', result: 'y'.repeat(10), resultTruncated: true, endedAt: new Date().toISOString(), durationMs: 1 } }, { turnId: t, actor: ANN });
    expect((await dispatch(again, {})('subagents.get', { sessionId: sid, subagentId: c.id }, ANN_CTX)).result).toMatchObject({ subagent: { result: 'y'.repeat(10), resultTruncated: true } });
    expect((await call('subagents.get', { sessionId: sid, subagentId: mintId('sa') }, ANN_CTX)).error).toMatchObject({ code: 'subagent_not_found', status: 404 });
  });

  it('events.list: after, limit, types, turnId, tailTurns, cursor_ahead and waitMs', async () => {
    const { log, sid, call } = await fresh();
    const t1 = turn(log);
    const t2 = turn(log);
    turn(log);
    const ev = async (p: Record<string, unknown>) => (await call('events.list', { sessionId: sid, ...p }, ANN_CTX)) as { result: { events: { seq: number; type: string }[]; earlierTurns: { id: string }[] | null; lastSeq: number; hasMore: boolean } };
    const r1 = await ev({ after: 2, limit: 3 });
    decodeResult('events.list', r1.result);
    expect(r1.result).toMatchObject({ lastSeq: 12, hasMore: true, earlierTurns: null });
    expect(r1.result.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect((await ev({ types: 'turn.*' })).result.events.map((e) => e.type)).toEqual(Array(3).fill(['turn.started', 'turn.completed']).flat());
    expect((await ev({ types: 'turn.completed', limit: 2 })).result).toMatchObject({ hasMore: true });
    expect((await ev({ types: 'turn.completed', limit: 3 })).result).toMatchObject({ hasMore: false });
    expect((await ev({ turnId: t2 })).result.events.map((e) => e.seq)).toEqual([5, 6, 7, 8]);
    const tail = (await ev({ tailTurns: 1 })).result;
    expect(tail.events.map((e) => e.seq)).toEqual([9, 10, 11, 12]);
    expect(tail.earlierTurns?.map((t) => t.id)).toEqual([t2, t1]);
    expect((await call('events.list', { sessionId: sid, tailTurns: 1, after: 0 }, ANN_CTX)).error).toMatchObject({ code: 'invalid_request', field: 'tailTurns' });
    expect((await call('events.list', { sessionId: sid, after: 13 }, ANN_CTX)).error).toMatchObject({ code: 'cursor_ahead', status: 409 });
    const waiting = ev({ after: 12, waitMs: 2000 });
    setTimeout(() => turn(log), 20);
    expect((await waiting).result.events.map((e) => e.seq)).toEqual([13, 14, 15, 16]);
    expect((await ev({ after: 16, waitMs: 20 })).result).toMatchObject({ events: [], hasMore: false });
  }, 10_000);
});

describe('idempotency', () => {
  function sender() {
    let runs = 0;
    let fails = 0;
    const writes: WriteHandlers = {
      'turns.send': async (p, ctx) => {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        const t = mintId('tn');
        log().append('message.received', { input: p.input, ifBusy: p.ifBusy ?? 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] }, { turnId: t, actor: ctx.actor });
        const e = log().append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: t, actor: ctx.actor });
        return { result: { turn: log().fold.turn(t), delivery: 'queued', duplicate: false, seq: e.seq } };
      },
      'sessions.update': () => {
        fails++;
        return { error: { code: 'nope', message: 'x', status: 409 } };
      },
    };
    let holder: Awaited<ReturnType<typeof fresh>> | undefined;
    const log = () => holder!.log;
    return { writes, runs: () => runs, fails: () => fails, set: (h: Awaited<ReturnType<typeof fresh>>) => (holder = h) };
  }

  it('a repeat returns the first result, current and marked duplicate; another body conflicts', async () => {
    const s = sender();
    const h = s.set(await fresh(s.writes));
    const ctx = { ...ANN_CTX, idempotencyKey: 'k1' };
    const first = (await h.call('turns.send', { sessionId: h.sid, input: 'hi' }, ctx)).result as { turn: { id: string; status: string }; duplicate: boolean };
    expect(first.duplicate).toBe(false);
    h.log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: first.turn.id, actor: ANN });
    // Same request (ifBusy defaulted) under the key in params: the same turn, as it is now.
    const again = (await h.call('turns.send', { sessionId: h.sid, input: 'hi', ifBusy: 'queue', idempotencyKey: 'k1' }, ANN_CTX)).result as typeof first;
    expect(again).toMatchObject({ duplicate: true, turn: { id: first.turn.id, status: 'running' } });
    expect(s.runs()).toBe(1);
    expect((await h.call('turns.send', { sessionId: h.sid, input: 'other' }, ctx)).error).toMatchObject({ code: 'idempotency_conflict', status: 409 });
    // Another member's key is its own.
    await h.call('turns.send', { sessionId: h.sid, input: 'hi' }, { ...ctx, member: 'usr_bob' });
    expect(s.runs()).toBe(2);
  });

  it('concurrent repeats wait for the first; failures are not recorded', async () => {
    const s = sender();
    const h = s.set(await fresh(s.writes));
    const ctx = { ...ANN_CTX, idempotencyKey: 'k2' };
    const [a, b] = await Promise.all([h.call('turns.send', { sessionId: h.sid, input: 'hi' }, ctx), h.call('turns.send', { sessionId: h.sid, input: 'hi' }, ctx)]);
    expect(s.runs()).toBe(1);
    expect((a.result as { turn: { id: string } }).turn.id).toBe((b.result as { turn: { id: string } }).turn.id);
    expect((b.result as { duplicate: boolean }).duplicate).toBe(true);
    const u = { ...ANN_CTX, idempotencyKey: 'k3' };
    expect((await h.call('sessions.update', { sessionId: h.sid, title: 't' }, u)).error?.code).toBe('nope');
    expect((await h.call('sessions.update', { sessionId: h.sid, title: 't' }, u)).error?.code).toBe('nope');
    expect(s.fails()).toBe(2);
  });

  it('the record survives a reopen', async () => {
    const s = sender();
    const t = tempSession();
    cleanups.push(t.cleanup);
    const a = await openLog(t.file, t.sessionId);
    s.set({ log: a, sid: t.sessionId, call: dispatch(a, s.writes) });
    const ctx = { ...ANN_CTX, idempotencyKey: 'k4' };
    const first = (await dispatch(a, s.writes)('turns.send', { sessionId: t.sessionId, input: 'hi' }, ctx)).result as { turn: { id: string } };
    await a.release();
    const b = await openLog(t.file, t.sessionId, { lastSeq: a.lastSeq });
    cleanups.push(() => b.release());
    s.set({ log: b, sid: t.sessionId, call: dispatch(b, s.writes) });
    const again = (await dispatch(b, s.writes)('turns.send', { sessionId: t.sessionId, input: 'hi' }, ctx)).result as { turn: { id: string }; duplicate: boolean };
    expect(again).toMatchObject({ duplicate: true, turn: { id: first.turn.id } });
    expect(s.runs()).toBe(1);
  });
});
