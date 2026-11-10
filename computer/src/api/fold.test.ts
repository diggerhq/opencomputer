import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../protocol.js';
import { mintId } from '../session-ids.js';
import { Fold } from './fold.js';
import { EVENT_DATA, type EventDataOf, type EventType } from './schema-events.js';
import { Ask, Session, Turn } from './schema-objects.js';

const sid = mintId('cs');
const ann = { id: 'usr_ann', name: 'Ann', via: 'api', client: null };

function feed() {
  const fold = new Fold({ sessionId: sid, owner: { id: 'usr_ann', name: 'Ann', email: null }, dashboardUrl: 'https://x/d' });
  let seq = 0;
  const add = <T extends EventType>(type: T, data: EventDataOf<T>, turnId: string | null = null) => {
    Schema.decodeUnknownSync(EVENT_DATA[type] as unknown as Schema.Codec<unknown, unknown>)(data);
    const e: JournalEvent = { id: mintId('ev'), seq: ++seq, createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(), sessionId: sid, turnId, type, actor: ann, data };
    fold.apply(e);
    fold.setLog({ lastSeq: seq, logEpoch: 1, epochStartSeq: 1 });
    return e;
  };
  return { fold, add };
}

const ask = (id: string, turnId: string, status = 'open') => ({
  id, sessionId: sid, turnId, kind: 'question', status, createdAt: new Date(0).toISOString(), closedAt: null, closedBy: null, answer: null,
  approval: null, question: { questions: [] }, secret: null,
});

describe('Fold', () => {
  it('builds the Session, Turns and Asks from events', () => {
    const { fold, add } = feed();
    add('session.created', { title: 'hello', origin: { type: 'opc', client: 'opc/1', slack: null }, settings: { model: 'm1', effort: null, mode: 'default', speed: null } });
    add('session.status_changed', { from: null, to: 'idle' });
    const t1 = mintId('tn');
    add('message.received', { input: 'do it', ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] }, t1);
    add('turn.started', { model: 'm1', effort: null, mode: 'default', trigger: 'message', subagentId: null }, t1);
    add('session.status_changed', { from: 'idle', to: 'running' });
    add('tool.started', { subagentId: null, toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls', input: {}, inputTruncated: false }, t1);
    expect(fold.openCalls(t1)).toEqual([{ subagentId: null, toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls' }]);
    const t2 = mintId('tn');
    add('message.received', { input: 'next', ifBusy: 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] }, t2);
    add('turn.queued', { position: 1, trigger: 'message', subagentId: null }, t2);
    const a1 = mintId('ak');
    add('ask.opened', { ask: ask(a1, t1) as never }, t1);

    let s = Schema.decodeUnknownSync(Session)(fold.session());
    expect(s.status).toBe('running');
    expect(s.activeTurnId).toBe(t1);
    expect(s.queued.map((t) => t.id)).toEqual([t2]);
    expect(s.asks.map((a) => a.id)).toEqual([a1]);
    expect(s.settings.model).toBe('m1');
    expect(s.urls.dashboard).toBe('https://x/d');

    add('ask.closed', { ask: { ...ask(a1, t1, 'answered'), closedAt: new Date(1).toISOString(), closedBy: ann } as never }, t1);
    add('tool.completed', { subagentId: null, toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls', output: 'x', outputTruncated: false, fileChanges: null, durationMs: 5 }, t1);
    add('message.completed', { blockId: 'b1', parentCallId: null, text: 'done' }, t1);
    add('usage.recorded', {
      model: 'm1', inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: '0.01', firstTokenMs: null, durationMs: null, usedTokens: 1000, windowTokens: 200000,
    }, t1);
    add('turn.completed', { text: 'done', durationMs: 100, silent: false }, t1);

    const turn = Schema.decodeUnknownSync(Turn)(fold.turn(t1));
    expect(turn).toMatchObject({ status: 'completed', input: 'do it', text: 'done', usage: { inputTokens: 10, costUsd: '0.01' } });
    expect(Schema.decodeUnknownSync(Ask)(fold.ask(a1)).status).toBe('answered');
    s = Schema.decodeUnknownSync(Session)(fold.session());
    expect(s.lastTurn).toMatchObject({ id: t1, status: 'completed', text: 'done' });
    expect(s.lastText).toBe('done');
    expect(s.context).toEqual({ usedTokens: 1000, windowTokens: 200000 });
    expect(s.asks).toEqual([]);
    expect(s.lastSeq).toBe(14);
    expect(fold.liveTurns().map((t) => t.id)).toEqual([t2]);
    expect(fold.isEnded(t1)).toBe(true);
  });

  it('steering messages join the running turn', () => {
    const { fold, add } = feed();
    const t1 = mintId('tn');
    add('message.received', { input: 'a', ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] }, t1);
    add('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, t1);
    add('message.received', { input: 'b', ifBusy: 'steer', delivery: 'steered', interruptedTurnIds: [], declinedAskIds: [] }, t1);
    add('turn.steered', { messageSeq: 1 }, t1);
    expect(fold.turn(t1)?.steering.map((m) => m.input)).toEqual(['b']);
  });

  it('session.updated changes settings, title, archive and metadata keys', () => {
    const { fold, add } = feed();
    add('session.updated', { changes: { title: { from: '', to: 'T' }, model: { from: null, to: 'm2' }, archived: { from: false, to: true }, 'metadata.k': { from: null, to: 'v' } } });
    expect(fold.session()).toMatchObject({ title: 'T', archived: true, settings: { model: 'm2' }, metadata: { k: 'v' } });
    add('session.updated', { changes: { 'metadata.k': { from: 'v', to: null } } });
    expect(fold.session().metadata).toEqual({});
  });

  it('speed: null from a session.created written before it, then what session.updated sets', () => {
    const { fold } = feed();
    const at = (seq: number, type: string, data: unknown): JournalEvent => ({ id: mintId('ev'), seq, createdAt: new Date(0).toISOString(), sessionId: sid, turnId: null, type, actor: ann, data });
    fold.apply(at(1, 'session.created', { title: 'old', origin: { type: 'api', client: null, slack: null }, settings: { model: null, effort: null, mode: 'default' } }));
    expect(fold.session().settings).toEqual({ model: null, effort: null, mode: 'default', speed: null });
    fold.apply(at(2, 'session.updated', { changes: { speed: { from: null, to: 'standard' } } }));
    expect(fold.session().settings.speed).toBe('standard');
  });

  it('tracks subagents: running on the Session, progress folded in, background ones outliving their turn', () => {
    const { fold, add } = feed();
    const t1 = mintId('tn');
    add('message.received', { input: 'go', ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] }, t1);
    add('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, t1);
    const sa = mintId('sa');
    const sub = {
      id: sa, sessionId: sid, turnId: t1, callId: 'c9', name: 'auth flow', agentType: 'Explore', background: true, status: 'running', activity: null,
      toolCalls: 0, tokens: 0, createdAt: new Date(0).toISOString(), endedAt: null, durationMs: null, result: null, resultTruncated: false, error: null, stoppedBy: null,
    };
    add('subagent.started', { subagent: sub }, t1);
    fold.progress({ subagentId: sa, activity: 'reading x.ts', toolCalls: 3, tokens: 1200 });
    add('turn.completed', { text: null, durationMs: 1, silent: false }, t1);
    let s = Schema.decodeUnknownSync(Session)(fold.session());
    expect(s.subagents).toMatchObject([{ id: sa, activity: 'reading x.ts', toolCalls: 3, tokens: 1200 }]);
    expect(fold.turnSubagents(t1)).toEqual([{ id: sa, name: 'auth flow', status: 'running', background: true }]);
    add('subagent.ended', { subagent: { ...sub, status: 'completed', toolCalls: 9, endedAt: new Date(5).toISOString(), durationMs: 5, result: 'found it' } }, t1);
    s = Schema.decodeUnknownSync(Session)(fold.session());
    expect(s.subagents).toEqual([]);
    expect(fold.subagent(sa)).toMatchObject({ status: 'completed', result: 'found it', toolCalls: 9 });
    // The harness starts a turn for the ended subagent: trigger subagent, no author (review r1 contract 4, 5).
    const t2 = mintId('tn');
    fold.apply({ id: mintId('ev'), seq: 99, createdAt: new Date().toISOString(), sessionId: sid, turnId: t2, type: 'turn.started', actor: null, data: { model: null, effort: null, mode: null, trigger: 'subagent', subagentId: sa } });
    expect(Schema.decodeUnknownSync(Turn)(fold.turn(t2))).toMatchObject({ trigger: 'subagent', subagentId: sa, input: null, author: null });
    expect(fold.turn(t1)).toMatchObject({ trigger: 'message', subagentId: null, input: 'go' });
  });

  it('turn.failed records the error and ignores a second ending', () => {
    const { fold, add } = feed();
    const t = mintId('tn');
    add('turn.queued', { position: 1, trigger: 'message', subagentId: null }, t);
    add('turn.failed', { error: { code: 'runtime_lost', message: 'gone' } }, t);
    add('turn.completed', { text: 'late', durationMs: 1, silent: false }, t);
    expect(fold.turn(t)).toMatchObject({ status: 'failed', error: { code: 'runtime_lost' }, text: null });
  });

  it('a snapshot restored and fed the rest equals the fold of the whole log (journal checkpoint)', () => {
    const { fold, add } = feed();
    const events: JournalEvent[] = [];
    const t1 = mintId('tn');
    const sa = mintId('sa');
    const sub = {
      id: sa, sessionId: sid, turnId: t1, callId: 'c9', name: 'n', agentType: 'Explore', background: true, status: 'running', activity: null,
      toolCalls: 0, tokens: 0, createdAt: new Date(0).toISOString(), endedAt: null, durationMs: null, result: null, resultTruncated: false, error: null, stoppedBy: null,
    };
    events.push(
      add('session.created', { title: 'hello', origin: { type: 'opc', client: 'opc/1', slack: null }, settings: { model: 'm1', effort: null, mode: 'default', speed: null } }),
      add('session.updated', { changes: { 'metadata.k': { from: null, to: 'v' } } }),
      add('message.received', { input: 'go', ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] }, t1),
      add('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, t1),
      add('tool.started', { subagentId: null, toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls', input: {}, inputTruncated: false }, t1),
      add('subagent.started', { subagent: sub }, t1),
      add('ask.opened', { ask: ask(mintId('ak'), t1) as never }, t1),
      add('usage.recorded', { model: null, inputTokens: 5, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: '0.01', firstTokenMs: null, durationMs: null, usedTokens: 10, windowTokens: 100 }, t1),
    );
    const restored = Fold.restore(fold.seed, JSON.parse(JSON.stringify(fold.snapshot())))!;
    expect(restored).toBeDefined();
    const rest = [
      add('tool.completed', { subagentId: null, toolName: 'Bash', callId: 'c1', parentCallId: null, title: 'ls', output: '', outputTruncated: false, fileChanges: null, durationMs: null }, t1),
      add('turn.completed', { text: 'done', durationMs: 1, silent: false }, t1),
    ];
    for (const e of rest) restored.apply(e);
    restored.setLog({ lastSeq: events.length + rest.length, logEpoch: 1, epochStartSeq: 1 });
    const view = (f: Fold) => ({ s: { ...f.session(), lastActiveAt: null }, t: f.turns(), a: f.asks(), sa: f.subagents(), c: f.openCalls(t1), q: f.seqOf(sa) });
    expect(view(restored)).toEqual(view(fold));
    expect(view(fold).s).toMatchObject({ title: 'hello', metadata: { k: 'v' }, context: { usedTokens: 10 }, lastText: 'done' });
    expect(Fold.restore(fold.seed, { ...fold.snapshot(), v: 0 })).toBeUndefined();
    expect(Fold.restore(fold.seed, null)).toBeUndefined();
  });
});
