import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiDelivery, JournalEvent } from '../protocol.js';
import { mintId } from '../session-ids.js';
import { ensureSessionJournalDir, journalPath } from '../api/journal.js';
import { dialApi } from '../api/socket.js';
import { ANN, ANN_CTX, askOf, assertEvent, openLog, subagentOf, tempSession, turn } from '../api/testing.js';
import { HostSessionWriter, QUEUE_MAX, scanJournals } from './session-writer.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const owner = { id: 'usr_ann', name: 'Ann', email: null };

async function host(o: { socket?: boolean; prepare?: (log: Awaited<ReturnType<typeof openLog>>) => void } = {}) {
  const t = tempSession();
  cleanups.push(t.cleanup);
  if (o.prepare) {
    const log = await openLog(t.file, t.sessionId);
    o.prepare(log);
    await log.release();
  }
  const wakes: { sessionId: string; delivery?: ApiDelivery }[] = [];
  const socket = o.socket ? { path: path.join(t.dir, 'h.api.sock'), token: 'tok' } : undefined;
  const w = await HostSessionWriter.open({
    sessionId: t.sessionId,
    journal: t.file,
    epoch: 1,
    lastSeq: 0,
    seed: { sessionId: t.sessionId, owner },
    wake: (sessionId, delivery) => wakes.push({ sessionId, delivery }),
    socket,
  });
  cleanups.push(() => w.handOff());
  const events = () => w.log.journal.read(0, 10_000);
  const sid = t.sessionId;
  return { t, w, sid, wakes, events, socket };
}

const types = (es: JournalEvent[]) => es.map((e) => e.type);

describe('HostSessionWriter', () => {
  it('turns.send records a queued turn, records the start, and wakes the runner with the turn', async () => {
    const { w, sid, wakes, events } = await host({ prepare: (log) => log.append('session.status_changed', { from: null, to: 'suspended' }, { actor: null }) });
    const out = await w.call('turns.send', { sessionId: sid, input: 'hello' }, { ...ANN_CTX, idempotencyKey: 'k' });
    const r = out.result as { turn: { id: string; status: string; input: string }; delivery: string; seq: number };
    expect(r).toMatchObject({ delivery: 'queued', duplicate: false, turn: { status: 'queued', input: 'hello' } });
    expect(types(events())).toEqual(['session.status_changed', 'message.received', 'turn.queued', 'session.status_changed', 'runtime.starting']);
    for (const e of events()) assertEvent(e);
    expect(r.seq).toBe(5);
    expect(wakes).toEqual([{ sessionId: sid, delivery: { actor: ANN, member: 'usr_ann', ifBusy: 'queue', turnId: r.turn.id, idempotencyKey: 'k' } }]);
    // A repeat is the same turn, and wakes nothing new.
    const again = await w.call('turns.send', { sessionId: sid, input: 'hello' }, { ...ANN_CTX, idempotencyKey: 'k' });
    expect(again.result).toMatchObject({ duplicate: true, turn: { id: r.turn.id } });
    expect(wakes.length).toBe(1);
    // A second send while starting: queued at position 2, no second start.
    await w.call('turns.send', { sessionId: sid, input: 'next' }, ANN_CTX);
    expect(events().at(-1)).toMatchObject({ type: 'turn.queued', data: { position: 2 } });
    expect(types(events()).filter((t) => t === 'runtime.starting').length).toBe(1);
  });

  it('failQueued fails the queued turns and leaves `starting` for `suspended`', async () => {
    const { w, sid, events } = await host({ prepare: (log) => log.append('session.status_changed', { from: null, to: 'suspended' }, { actor: null }) });
    await w.call('turns.send', { sessionId: sid, input: 'one' }, ANN_CTX);
    await w.call('turns.send', { sessionId: sid, input: 'two' }, ANN_CTX);
    w.failQueued('The agent did not start');
    const failed = events().filter((e) => e.type === 'turn.failed');
    expect(failed.map((e) => e.data)).toEqual([0, 1].map(() => ({ error: { code: 'runtime_failed', message: 'The agent did not start' } })));
    for (const e of events()) assertEvent(e);
    expect(events().at(-1)).toMatchObject({ type: 'session.status_changed', data: { from: 'starting', to: 'suspended' } });
    expect(w.log.fold.liveTurns()).toEqual([]);
    // Nothing queued: nothing written.
    const n = events().length;
    w.failQueued('again');
    expect(events().length).toBe(n);
  });

  it('refuses a send over the queue limit', async () => {
    const { w, sid } = await host();
    for (let i = 0; i < QUEUE_MAX; i++) expect((await w.call('turns.send', { sessionId: sid, input: `m${i}` }, ANN_CTX)).error).toBeUndefined();
    expect((await w.call('turns.send', { sessionId: sid, input: 'one more' }, ANN_CTX)).error).toMatchObject({ code: 'queue_full', status: 409, retryable: true });
  });

  it('turns.cancel withdraws a queued turn only; interrupt cancels the queue', async () => {
    const { w, sid, events } = await host();
    const a = ((await w.call('turns.send', { sessionId: sid, input: 'a' }, ANN_CTX)).result as { turn: { id: string } }).turn.id;
    const b = ((await w.call('turns.send', { sessionId: sid, input: 'b' }, ANN_CTX)).result as { turn: { id: string } }).turn.id;
    expect((await w.call('turns.cancel', { sessionId: sid, turnId: a }, ANN_CTX)).result).toMatchObject({ turn: { id: a, status: 'cancelled', reason: 'withdrawn' } });
    expect((await w.call('turns.cancel', { sessionId: sid, turnId: a }, ANN_CTX)).error).toMatchObject({ code: 'turn_not_cancellable', status: 409 });
    expect((await w.call('turns.cancel', { sessionId: sid, turnId: mintId('tn') }, ANN_CTX)).error?.code).toBe('turn_not_found');
    await w.call('sessions.interrupt', { sessionId: sid }, ANN_CTX);
    expect(w.log.fold.turn(b)).toMatchObject({ status: 'cancelled', reason: 'interrupted', input: 'b' });
    expect(w.log.fold.liveTurns()).toEqual([]);
    for (const e of events()) assertEvent(e);
  });

  it('sessions.update records a speed for the next start; only fast or standard', async () => {
    const { w, sid, events } = await host();
    const u = await w.call('sessions.update', { sessionId: sid, speed: 'standard' }, ANN_CTX);
    expect(u.result).toMatchObject({ session: { settings: { speed: 'standard' } } });
    expect(events().at(-1)?.data).toEqual({ changes: { speed: { from: null, to: 'standard' } } });
    expect((await w.call('sessions.update', { sessionId: sid, speed: 'turbo' }, ANN_CTX)).error).toMatchObject({ code: 'invalid_request', status: 400 });
    for (const e of events()) assertEvent(e);
  });

  it('sessions.update, suspend (stopping subagents) and resume', async () => {
    const t0 = mintId('tn');
    let sa = '';
    const { w, sid, wakes, events } = await host({
      prepare: (log) => {
        log.append('session.status_changed', { from: null, to: 'idle' }, { actor: null });
        const s = subagentOf(log.sessionId, t0);
        sa = s.id;
        log.append('subagent.started', { subagent: s }, { turnId: t0, actor: null });
      },
    });
    const u = await w.call('sessions.update', { sessionId: sid, title: 'T', metadata: { k: 'v' } }, ANN_CTX);
    expect(u.result).toMatchObject({ session: { title: 'T', metadata: { k: 'v' } }, seq: 3 });
    expect(events().at(-1)?.data).toEqual({ changes: { title: { from: '', to: 'T' }, 'metadata.k': { from: null, to: 'v' } } });
    expect((await w.call('sessions.update', { sessionId: sid, title: 'T' }, ANN_CTX)).result).toMatchObject({ seq: 3 }); // no change, no event
    const s = await w.call('sessions.suspend', { sessionId: sid }, ANN_CTX);
    expect(s.result).toMatchObject({ session: { status: 'suspended', subagents: [] } });
    expect(w.log.fold.subagent(sa)).toMatchObject({ status: 'stopped', stoppedBy: { id: 'usr_ann' } });
    expect(types(events()).slice(-3)).toEqual(['subagent.ended', 'runtime.suspended', 'session.status_changed']);
    await w.call('sessions.resume', { sessionId: sid }, ANN_CTX);
    expect(w.log.fold.status).toBe('starting');
    expect(wakes).toEqual([{ sessionId: sid, delivery: undefined }]);
    for (const e of events()) assertEvent(e);
  });

  it('subagents.stop, asks.answer/dismiss and compact', async () => {
    const t0 = mintId('tn');
    let sa = '';
    let ak = '';
    let ak2 = '';
    const { w, sid, wakes } = await host({
      prepare: (log) => {
        const s = subagentOf(log.sessionId, t0);
        sa = s.id;
        log.append('subagent.started', { subagent: s }, { turnId: t0, actor: null });
        const a = askOf(log.sessionId, t0);
        const b = askOf(log.sessionId, t0);
        ak = a.id;
        ak2 = b.id;
        log.append('ask.opened', { ask: a }, { turnId: t0, actor: null });
        log.append('ask.opened', { ask: b }, { turnId: t0, actor: null });
      },
    });
    expect((await w.call('subagents.stop', { sessionId: sid, subagentId: sa }, ANN_CTX)).result).toMatchObject({ subagent: { status: 'stopped', stoppedBy: { id: 'usr_ann' } } });
    expect((await w.call('subagents.stop', { sessionId: sid, subagentId: sa }, ANN_CTX)).result).toMatchObject({ subagent: { status: 'stopped' } });
    expect((await w.call('subagents.stop', { sessionId: sid, subagentId: sa }, { actor: { ...ANN_CTX.actor, id: 'usr_bob' }, member: 'usr_bob' })).error).toMatchObject({ code: 'subagent_ended', status: 409 });
    expect((await w.call('subagents.stop', { sessionId: sid, subagentId: mintId('sa') }, ANN_CTX)).error?.code).toBe('subagent_not_found');
    const answer = { answers: [] };
    const ans = await w.call('asks.answer', { sessionId: sid, askId: ak, answer }, ANN_CTX);
    expect(ans.error).toBeUndefined();
    expect(ans.result).toMatchObject({ ask: { status: 'answered', closedBy: { id: 'usr_ann' } } });
    expect((await w.call('asks.answer', { sessionId: sid, askId: ak, answer }, ANN_CTX)).error?.code).toBe('ask_closed');
    expect((await w.call('asks.dismiss', { sessionId: sid, askId: ak2, message: 'no' }, ANN_CTX)).result).toMatchObject({ ask: { status: 'dismissed' } });
    expect((await w.call('asks.dismiss', { sessionId: sid, askId: mintId('ak') }, ANN_CTX)).error?.code).toBe('ask_not_found');
    expect((await w.call('sessions.compact', { sessionId: sid }, ANN_CTX)).error).toMatchObject({ code: 'unavailable', status: 503, retryAfterMs: 2000 });
    expect(wakes.length).toBe(1);
    for (const e of w.log.journal.read(0, 100)) assertEvent(e);
  });

  it('sessions.interrupt with no runner ends a started turn as a forced interrupt (review r1 P2-5)', async () => {
    const live = mintId('tn');
    const queued = mintId('tn');
    const { w, sid, events } = await host({
      prepare: (log) => {
        log.append('session.status_changed', { from: null, to: 'running' }, { actor: null });
        log.append(
          'message.received',
          { input: 'work', ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] },
          { turnId: live, actor: ANN },
        );
        log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: live, actor: ANN });
        log.append(
          'tool.started',
          { subagentId: null, toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls', input: {}, inputTruncated: false },
          { turnId: live, actor: ANN },
        );
        log.append('ask.opened', { ask: askOf(log.sessionId, live) }, { turnId: live, actor: ANN });
        log.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: queued, actor: ANN });
      },
    });
    const r = await w.call('sessions.interrupt', { sessionId: sid }, ANN_CTX);
    expect(r.result).toMatchObject({ session: { status: 'suspended', activeTurnId: null } });
    expect(types(events()).slice(6)).toEqual([
      'turn.status_changed',
      'ask.closed',
      'tool.failed',
      'turn.cancelled',
      'turn.cancelled',
      'runtime.suspended',
      'session.status_changed',
    ]);
    expect(events().find((e) => e.type === 'turn.cancelled' && e.turnId === live)?.data).toMatchObject({ reason: 'interrupted', forced: true });
    for (const e of events()) assertEvent(e);
  });

  it('serves its socket, and handOff detaches subscribers and frees the journal', async () => {
    const { t, w, sid, socket } = await host({ socket: true });
    const c = await dialApi(socket!.path, socket!.token);
    const detached: string[] = [];
    await c.subscribe({ deltas: false, onEvent: () => {}, onDelta: () => {}, onDetached: (r) => detached.push(r) });
    expect((await c.call('sessions.get', { sessionId: sid }, ANN_CTX)).result).toMatchObject({ session: { id: sid } });
    await w.call('turns.send', { sessionId: sid, input: 'x' }, ANN_CTX);
    await w.handOff();
    await c.closed;
    expect(fs.existsSync(socket!.path)).toBe(false);
    const next = await openLog(t.file, sid, { lastSeq: 2 });
    expect(next.fold.liveTurns().map((x) => x.status)).toEqual(['queued']);
    await next.release();
  });
});

describe('scanJournals', () => {
  it('settles what a dead runner left open, skips locked journals, and is a no-op the second time', async () => {
    const t = tempSession();
    cleanups.push(t.cleanup);
    const log = await openLog(t.file, t.sessionId);
    log.append('session.status_changed', { from: null, to: 'running' }, { actor: null });
    const done = turn(log);
    const live = mintId('tn');
    log.append('message.received', { input: 'work', ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] }, { turnId: live, actor: ANN });
    log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: live, actor: ANN });
    log.append('tool.started', { subagentId: null, toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls', input: {}, inputTruncated: false }, { turnId: live, actor: ANN });
    const queued = mintId('tn');
    log.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: queued, actor: ANN });
    const s = subagentOf(t.sessionId, live);
    log.append('subagent.started', { subagent: s }, { turnId: live, actor: ANN });
    const a = askOf(t.sessionId, live);
    log.append('ask.opened', { ask: a }, { turnId: live, actor: ANN });

    // A second, locked journal (a running runner's) is skipped.
    const other = mintId('cs');
    ensureSessionJournalDir(t.dir, other);
    const held = await openLog(journalPath(t.dir, other), other);
    turn(held);
    cleanups.push(() => held.release());
    const before = log.lastSeq;
    await log.release();

    const dir = path.join(t.dir, 'journals');
    const r1 = await scanJournals(dir, { owner });
    const mine = r1.find((r) => r.sessionId === t.sessionId);
    expect(r1.find((r) => r.sessionId === other)?.skipped).toBe('locked');
    expect(mine?.closedTurns.sort()).toEqual([live, queued].sort());

    const after = await openLog(t.file, t.sessionId, { lastSeq: mine!.lastSeq });
    const added = after.journal.read(before, 100);
    for (const e of added) assertEvent(e);
    expect(types(added)).toEqual(['subagent.ended', 'ask.closed', 'tool.failed', 'turn.failed', 'turn.failed', 'runtime.suspended', 'session.status_changed']);
    expect(added.find((e) => e.type === 'tool.failed')?.data).toMatchObject({ callId: 'c1', settledBy: 'turn.failed' });
    expect(after.fold.subagent(s.id)).toMatchObject({ status: 'failed', error: { code: 'runtime_lost' } });
    expect(after.fold.ask(a.id)?.status).toBe('interrupted');
    expect(after.fold.turn(done)?.status).toBe('completed');
    expect(after.fold.turn(live)).toMatchObject({ status: 'failed', error: { code: 'runtime_lost' } });
    expect(after.fold.status).toBe('suspended');
    await after.release();

    const r2 = await scanJournals(dir, { owner });
    expect(r2.find((r) => r.sessionId === t.sessionId)).toMatchObject({ closedTurns: [], lastSeq: mine!.lastSeq });
  });

  it('returns nothing for a missing dir and skips files that are not journals', async () => {
    expect(await scanJournals('/nonexistent/dir')).toEqual([]);
    const t = tempSession();
    cleanups.push(t.cleanup);
    const journals = path.join(t.dir, 'journals');
    fs.writeFileSync(path.join(journals, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(path.dirname(t.file), 'notes.txt'), 'x');
    // A journal directly in journals/ (the layout before work 103) is not one, nor is a directory that is not a session's.
    fs.writeFileSync(path.join(journals, `${t.sessionId}.jsonl`), `${JSON.stringify({ k: 'epoch', sessionId: t.sessionId, epoch: 1, startSeq: 1, at: 0 })}\n`);
    fs.mkdirSync(path.join(journals, 'other'));
    expect(await scanJournals(journals)).toEqual([]);
  });
});
