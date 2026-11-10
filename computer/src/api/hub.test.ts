import { afterEach, describe, expect, it } from 'vitest';
import type { JournalDelta, JournalEvent } from '../protocol.js';
import { mintId } from '../session-ids.js';
import { LIMITS } from './hub.js';
import type { SessionLog } from './session-log.js';
import { ANN, assertEvent, openLog, tempSession, turn } from './testing.js';
import type { DetachReason } from './writer.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fresh() {
  const t = tempSession();
  const log = await openLog(t.file, t.sessionId);
  cleanups.push(t.cleanup, () => log.release());
  return { ...t, log };
}

function collector(o: { after?: number; tailTurns?: number; deltas?: boolean; mirror?: boolean; writable?: () => boolean } = {}) {
  const events: JournalEvent[] = [];
  const deltas: JournalDelta[] = [];
  const detached: DetachReason[] = [];
  return {
    events,
    deltas,
    detached,
    sink: {
      deltas: o.deltas ?? true,
      after: o.after,
      tailTurns: o.tailTurns,
      writable: o.writable,
      mirror: o.mirror,
      onEvent: (e: JournalEvent) => events.push(e),
      onDelta: (d: JournalDelta) => deltas.push(d),
      onDetached: (r: DetachReason) => detached.push(r),
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const msgDelta = (log: SessionLog, turnId: string, blockId: string, text: string) =>
  log.delta({ type: 'message.delta', turnId, data: { blockId, parentCallId: null, text } });

describe('Hub via SessionLog', () => {
  it('replays after a cursor, then live, once each and in order', async () => {
    const { log } = await fresh();
    turn(log);
    turn(log);
    const c = collector({ after: 2 });
    const sub = log.subscribe(c.sink);
    if ('error' in sub) throw new Error('subscribe failed');
    expect(sub.attached).toMatchObject({ after: 2, lastSeq: 8, epoch: 1 });
    expect(c.events).toEqual([]); // events follow the result on a microtask
    await tick();
    turn(log);
    expect(c.events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const e of c.events) assertEvent(e);
  });

  it('subscribes live by default, by tailTurns, and refuses a cursor ahead', async () => {
    const { log } = await fresh();
    turn(log);
    turn(log);
    turn(log);
    const live = collector();
    const s1 = log.subscribe(live.sink);
    expect('attached' in s1 && s1.attached.after).toBe(12);
    const tail = collector({ tailTurns: 1 });
    const s2 = log.subscribe(tail.sink);
    expect('attached' in s2 && s2.attached.after).toBe(8);
    await tick();
    expect(live.events).toEqual([]);
    expect(tail.events.map((e) => e.seq)).toEqual([9, 10, 11, 12]);
    const ahead = log.subscribe(collector({ after: 99 }).sink);
    expect('error' in ahead && ahead.error).toMatchObject({ code: 'cursor_ahead', status: 409 });
  });

  it('attached is the full AttachResult; an after more than 10,000 events back is too_far_behind (review r1 contract 7, E4)', async () => {
    const { log } = await fresh();
    const t1 = turn(log);
    turn(log);
    const s = log.subscribe(collector({ tailTurns: 1 }).sink);
    if ('error' in s) throw new Error('subscribe failed');
    expect(s.attached).toMatchObject({ logEpoch: 1, epochStartSeq: 1, capabilities: { features: { steer: true } } });
    expect((s.attached.earlierTurns as { id: string }[]).map((t) => t.id)).toEqual([t1]);
    const plain = log.subscribe(collector({ after: 0 }).sink);
    expect('attached' in plain && plain.attached.earlierTurns).toBeNull();
    for (let i = 0; i < 2501; i++) turn(log, 'x', 'y');
    const far = log.subscribe(collector({ after: 0 }).sink);
    expect('error' in far && far.error).toMatchObject({ code: 'too_far_behind', status: 409 });
    expect('attached' in log.subscribe(collector({ after: log.lastSeq - 10_000 }).sink)).toBe(true);
  });

  it('holds events while the sink is not writable, and pump sends them', async () => {
    const { log } = await fresh();
    let open = false;
    const c = collector({ after: 0, writable: () => open });
    const sub = log.subscribe(c.sink);
    if ('error' in sub) throw new Error('subscribe failed');
    turn(log);
    await tick();
    expect(c.events).toEqual([]);
    open = true;
    sub.pump();
    expect(c.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('detaches a subscriber too far behind, alone', async () => {
    const { log } = await fresh();
    const slow = collector({ writable: () => false });
    const fast = collector();
    log.subscribe(slow.sink);
    log.subscribe(fast.sink);
    const t = mintId('tn');
    for (let i = 0; i <= LIMITS.backlogEvents; i++) log.append('message.completed', { blockId: `b${i}`, parentCallId: null, text: 'x' }, { turnId: t, actor: ANN });
    expect(slow.detached).toEqual(['too_far_behind']);
    expect(fast.detached).toEqual([]);
    expect(fast.events.length).toBe(LIMITS.backlogEvents + 1);
    expect(log.hub.size).toBe(1);
  });

  it('acks bound the backlog to what the client has not confirmed', async () => {
    const { log } = await fresh();
    const c = collector();
    const sub = log.subscribe(c.sink);
    if ('error' in sub) throw new Error('subscribe failed');
    turn(log);
    sub.ack(2);
    sub.ack(99); // capped at what was sent
    sub.ack(1); // never moves back
    // Same backlog math the hub uses: acked = 4, so nothing is pending.
    turn(log);
    expect(c.detached).toEqual([]);
    expect(c.events.length).toBe(8);
  });

  it('merges deltas per block, gives a catch-up delta on reaching live, and drops them once completed', async () => {
    const { log } = await fresh();
    const t = mintId('tn');
    log.append('message.received', { input: 'hi', ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] }, { turnId: t, actor: ANN });
    log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN });
    msgDelta(log, t, 'b1', 'hel');
    msgDelta(log, t, 'b1', 'lo');
    const c = collector({ after: 0 });
    log.subscribe(c.sink);
    await tick();
    expect(c.events.length).toBe(2);
    expect(c.deltas.map((d) => (d.data as { text: string }).text)).toEqual(['hello']);
    msgDelta(log, t, 'b1', '!');
    expect(c.deltas.map((d) => (d.data as { text: string }).text)).toEqual(['hello', '!']);
    log.append('message.completed', { blockId: 'b1', parentCallId: null, text: 'hello!' }, { turnId: t, actor: ANN });
    msgDelta(log, t, 'b1', 'late');
    expect(c.deltas.length).toBe(2);
    const late = collector({ after: 0 });
    log.subscribe(late.sink);
    await tick();
    expect(late.deltas).toEqual([]);
  });

  it('gives the host\'s mirror subagent progress alone, live and as catch-up (084 perf fix 4)', async () => {
    const { log } = await fresh();
    const t = mintId('tn');
    log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN });
    const progress = (id: string, toolCalls: number) => log.delta({ type: 'subagent.progress', turnId: t, data: { subagentId: id, activity: 'reading', toolCalls, tokens: null } });
    msgDelta(log, t, 'b1', 'hel');
    progress('sa_1', 1);
    const m = collector({ after: 0, mirror: true });
    log.subscribe(m.sink);
    await tick();
    msgDelta(log, t, 'b1', 'lo');
    progress('sa_1', 2);
    expect(m.deltas.map((d) => [d.type, (d.data as { toolCalls: number }).toolCalls])).toEqual([
      ['subagent.progress', 1],
      ['subagent.progress', 2],
    ]);
  });

  it('closes a turn\'s text blocks at its end but keeps tool calls and subagents open', async () => {
    const { log } = await fresh();
    const t = mintId('tn');
    log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN });
    msgDelta(log, t, 'b1', 'x');
    log.delta({ type: 'tool.delta', turnId: t, data: { subagentId: null, callId: 'c1', parentCallId: null, text: 'out' } });
    log.delta({ type: 'subagent.progress', turnId: t, data: { subagentId: 'sa_1', activity: 'reading', toolCalls: 1, tokens: 10 } });
    log.delta({ type: 'subagent.progress', turnId: t, data: { subagentId: 'sa_1', activity: 'writing', toolCalls: 3, tokens: 50 } });
    log.append('turn.completed', { text: 'x', durationMs: 1, silent: false }, { turnId: t, actor: ANN });
    const c = collector();
    log.subscribe(c.sink);
    await tick();
    expect(c.deltas.map((d) => d.type).sort()).toEqual(['subagent.progress', 'tool.delta']);
    expect(c.deltas.find((d) => d.type === 'subagent.progress')?.data).toMatchObject({ activity: 'writing', toolCalls: 3 });
  });

  it('keeps a tool delta catch-up to its last 4 KiB', async () => {
    const { log } = await fresh();
    const t = mintId('tn');
    log.delta({ type: 'tool.delta', turnId: t, data: { subagentId: null, callId: 'c1', parentCallId: null, text: 'a'.repeat(5000) } });
    log.delta({ type: 'tool.delta', turnId: t, data: { subagentId: null, callId: 'c1', parentCallId: null, text: 'b' } });
    const c = collector();
    log.subscribe(c.sink);
    await tick();
    const text = (c.deltas[0].data as { text: string }).text;
    expect(text.length).toBe(LIMITS.toolTailBytes);
    expect(text.endsWith('ab')).toBe(true);
  });

  it('skips subscribers without deltas, and detaches everyone on release', async () => {
    const t = tempSession();
    cleanups.push(t.cleanup);
    const log = await openLog(t.file, t.sessionId);
    const c = collector({ deltas: false });
    log.subscribe(c.sink);
    msgDelta(log, mintId('tn'), 'b1', 'x');
    await tick();
    expect(c.deltas).toEqual([]);
    await log.release();
    expect(c.detached).toEqual(['moved']);
  });

  it('folds the whole file again on reopen', async () => {
    const t = tempSession();
    cleanups.push(t.cleanup);
    const a = await openLog(t.file, t.sessionId);
    const t1 = turn(a, 'one', 'done');
    await a.release();
    const b = await openLog(t.file, t.sessionId, { lastSeq: 4 });
    cleanups.push(() => b.release());
    expect(b.lastSeq).toBe(4);
    expect(b.fold.turn(t1)?.status).toBe('completed');
    expect(b.ring.since(0, 10)?.length).toBe(4);
  });

  it('waitFor resolves on an append, or false after the wait', async () => {
    const { log } = await fresh();
    const w = log.waitFor(() => log.lastSeq >= 1, 1000);
    turn(log);
    expect(await w).toBe(true);
    expect(await log.waitFor(() => log.lastSeq >= 99, 20)).toBe(false);
  });
});
