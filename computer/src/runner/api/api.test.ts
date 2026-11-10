import { readFileSync } from 'node:fs';
// SessionApi (work 084) over a real Session and a scripted harness: sends and
// their busy policies, idempotency, interrupt with its forced cancel, asks
// answered over the API (the Slack prompt goes), subagents stopped and the
// turn Claude Code starts when a background one ends.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANN, ANN_CTX, assertEvent, openLog, tempSession } from '../../api/testing.js';
import type { JournalEvent } from '../../protocol.js';

vi.mock('../harness/claude/process.js', () => ({
  startHarness: () => {
    throw new Error('the test runs a fake harness');
  },
}));
vi.mock('../harness/claude/mcp.js', () => ({ calvinServer: () => ({}) }));
vi.mock('../../workspace.js', async (orig) => ({ ...(await orig<object>()), gitBranch: async () => 'main', gitDiff: async () => '' }));

const BOB = { actor: { id: 'usr_bob', name: 'Bob', via: 'api' as const, client: 'test/1' }, member: 'usr_bob' };
const OWNER = { slackUserId: 'U1', userId: 'usr_ann', name: 'Ann', dir: 'u1', gitName: 'Ann', gitEmail: 'ann@x' };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.useRealTimers();
});

/** `before`: what the journal holds when the runner attaches (it then resumes, as attachApi does). */
async function world(before?: (log: Awaited<ReturnType<typeof openLog>>) => void) {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'], now: new Date('2026-10-26T00:00:00Z') });
  const T = await import('./testing.js');
  const { SessionApi } = await import('./api.js');
  const rec: unknown[] = [];
  const t = T.fakeSession(rec);
  const tmp = tempSession();
  const log = await openLog(tmp.file, tmp.sessionId);
  before?.(log);
  const suspended = { n: 0 };
  const api = new SessionApi(log, t.sess, { owner: OWNER, suspend: () => void suspended.n++ });
  if (before) api.resume();
  cleanups.push(async () => (t.sess.end(), await log.release(), tmp.cleanup()));
  const sessionId = tmp.sessionId;
  const call = async (method: string, params: Record<string, unknown> = {}, ctx: Parameters<typeof api.call>[2] = ANN_CTX) => {
    const p = api.call(method, { sessionId, ...params }, ctx);
    await t.settle();
    return p;
  };
  const events = (): JournalEvent[] => log.journal.read(0, 10_000);
  const of = (type: string) => events().filter((e) => e.type === type);
  const sends = () => rec.filter((r) => (r as { harness?: string }).harness === 'send');
  return { T, t, rec, api, log, call, events, of, sends, suspended };
}

const result = (o: { result?: unknown; error?: unknown }) => {
  expect(o.error).toBeUndefined();
  // biome-ignore lint/suspicious/noExplicitAny: results are read loosely in tests
  return o.result as Record<string, any>;
};

describe('SessionApi', () => {
  it('turns.send starts a turn when idle and queues one when busy; the queued one starts when the first ends', async () => {
    const w = await world();
    const a = result(await w.call('turns.send', { input: 'first' }));
    expect(a.delivery).toBe('started');
    expect(a.turn.status).toBe('running');
    await w.t.feed(w.T.first(), ...w.T.text('0', 'working'));
    const b = result(await w.call('turns.send', { input: 'second' }, BOB));
    expect(b.delivery).toBe('queued');
    expect(w.of('turn.queued').map((e) => e.data)).toEqual([{ position: 1, trigger: 'message', subagentId: null }]);
    expect(w.sends()).toHaveLength(1);
    await w.t.feed(w.T.done());
    expect(w.sends()).toHaveLength(2);
    const started = w.of('turn.started').map((e) => e.turnId);
    expect(started).toEqual([a.turn.id, b.turn.id]);
    expect(w.log.fold.turn(b.turn.id)?.input).toBe('second');
    for (const e of w.events()) assertEvent(e);
  });

  it('one idempotency key gives one turn', async () => {
    const w = await world();
    const ctx = { ...ANN_CTX, idempotencyKey: 'k-1' };
    const [a, b] = await Promise.all([w.call('turns.send', { input: 'hello' }, ctx), w.call('turns.send', { input: 'hello' }, ctx)]);
    const c = await w.call('turns.send', { input: 'hello' }, ctx);
    expect(result(a).turn.id).toBe(result(b).turn.id);
    expect(result(c).turn.id).toBe(result(a).turn.id);
    expect(result(c).duplicate).toBe(true);
    expect(w.of('message.received')).toHaveLength(1);
    expect(w.sends()).toHaveLength(1);
    const d = await w.call('turns.send', { input: 'other' }, ctx);
    expect((d.error as { code: string }).code).toBe('idempotency_conflict');
  });

  it('a Delivery.api with an idempotency key is one turn too, and one the host recorded starts in its turn', async () => {
    const w = await world();
    const d = { actor: ANN, member: 'usr_ann', ifBusy: 'queue' as const, idempotencyKey: 'k-2' };
    await w.api.deliver('hello', d);
    await w.api.deliver('hello', d);
    await w.t.settle();
    expect(w.of('message.received')).toHaveLength(1);
    await w.t.feed(w.T.first(), ...w.T.text('0', 'hi'), w.T.done());
    // Recorded by the host's writer while no runner ran.
    const turnId = 'tn_0000000000zz';
    w.log.append('message.received', { input: 'queued', ifBusy: 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] }, { turnId, actor: ANN });
    w.log.append('turn.queued', { position: 1 }, { turnId, actor: ANN });
    await w.api.deliver('queued', { ...d, idempotencyKey: undefined, turnId });
    await w.t.settle();
    expect(w.of('message.received')).toHaveLength(2);
    expect(w.of('turn.started').at(-1)?.turnId).toBe(turnId);
    expect(w.sends()).toHaveLength(2);
  });

  it('sessions.interrupt returns at once; the turn is cancelling, then cancelled forced after 10 s', async () => {
    const w = await world();
    const a = result(await w.call('turns.send', { input: 'long job' }));
    await w.t.feed(w.T.first(), ...w.T.text('0', 'on it'));
    const r = result(await w.call('sessions.interrupt'));
    expect(r.seq).toBeGreaterThan(0);
    expect(w.log.fold.turn(a.turn.id)?.status).toBe('cancelling');
    expect(w.rec).toContainEqual({ harness: 'interrupt' });
    await w.t.settle(10_000);
    const c = w.of('turn.cancelled');
    expect(c).toHaveLength(1);
    expect(c[0].data).toMatchObject({ reason: 'interrupted', forced: true });
    expect(w.of('turn.failed')).toHaveLength(0);
    for (const e of w.events()) assertEvent(e);
  });

  it('an interrupt the harness honours is cancelled unforced; queued turns are cancelled with their input', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'job' });
    await w.t.feed(w.T.first(), ...w.T.text('0', 'on it'));
    const q = result(await w.call('turns.send', { input: 'later' }));
    w.t.h.onInterrupt = () => w.t.h.push({ t: 'turn_ended', reason: 'error', detail: 'error_during_execution', usage: { input: 1 } });
    await w.call('sessions.interrupt');
    const c = w.of('turn.cancelled').map((e) => [e.turnId, e.data]);
    expect(c).toContainEqual([q.turn.id, { reason: 'interrupted', forced: false, input: 'later' }]);
    expect(c.find(([id]) => id !== q.turn.id)?.[1]).toMatchObject({ reason: 'interrupted', forced: false });
    await w.t.settle(10_000);
    expect(w.of('turn.cancelled')).toHaveLength(2);
  });

  it('turns.cancel withdraws a queued turn; a running one is not cancellable', async () => {
    const w = await world();
    const a = result(await w.call('turns.send', { input: 'job' }));
    await w.t.feed(w.T.first());
    const q = result(await w.call('turns.send', { input: 'later' }));
    expect(result(await w.call('turns.cancel', { turnId: q.turn.id })).turn.status).toBe('cancelled');
    const r = await w.call('turns.cancel', { turnId: a.turn.id });
    expect((r.error as { code: string; status: number }).code).toBe('turn_not_cancellable');
  });

  it('an API answer resolves the Slack prompt: the gate gets the decision and the prompt message goes', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'clean up' });
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'Bash', { command: 'rm -rf build' }));
    const decided: unknown[] = [];
    void w.t.sess.gate('Bash', { command: 'rm -rf build' }, { id: 'tu_1', kind: 'command', signal: new AbortController().signal, canRemember: true }).then((d) => decided.push(d));
    await w.t.settle();
    expect(w.t.prompts.size).toBe(1);
    expect(w.log.fold.status).toBe('waiting');
    const askId = (w.of('ask.opened')[0].data as { ask: { id: string } }).ask.id;
    const before = w.rec.length;
    const r = result(await w.call('asks.answer', { askId, answer: { decision: 'allow' } }));
    expect(r.ask.status).toBe('answered');
    expect(r.ask.closedBy).toMatchObject({ id: 'usr_ann' });
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ behavior: 'allow' });
    expect(w.t.prompts.size).toBe(0);
    const slack = w.rec.slice(before).map((x) => (x as { slack?: string }).slack).filter(Boolean);
    expect(slack.some((m) => m === 'chat.delete' || m === 'chat.update')).toBe(true);
    expect(w.log.fold.status).toBe('running');
    // First answer wins: the same answer again is 200, anyone else's is 409.
    expect(result(await w.call('asks.answer', { askId, answer: { decision: 'allow' } })).ask.id).toBe(askId);
    const late = await w.call('asks.answer', { askId, answer: { decision: 'deny' } }, BOB);
    expect((late.error as { code: string }).code).toBe('ask_closed');
    // A Slack press after it is a no-op.
    expect(w.of('ask.closed')).toHaveLength(1);
  });

  it('an API answer to a question resolves its prompt with the chosen labels', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'pick' });
    const questions = [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }];
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'AskUserQuestion', { questions }));
    const decided: unknown[] = [];
    void w.t.sess.gate('AskUserQuestion', { questions }, { id: 'tu_1', kind: 'question', signal: new AbortController().signal, canRemember: false }).then((d) => decided.push(d));
    await w.t.settle();
    const ask = (w.of('ask.opened')[0].data as { ask: { id: string; question: { questions: Array<{ id: string }> } } }).ask;
    const bad = await w.call('asks.answer', { askId: ask.id, answer: { answers: [{ questionId: ask.question.questions[0].id, choices: ['Green'], text: null }] } });
    expect((bad.error as { code: string }).code).toBe('invalid_answer');
    result(await w.call('asks.answer', { askId: ask.id, answer: { answers: [{ questionId: ask.question.questions[0].id, choices: ['Blue'], text: null }] } }));
    expect(JSON.stringify(decided)).toContain('Blue');
    expect(w.t.prompts.size).toBe(0);
  });

  it('a Slack answer closes the ask, which the API then refuses', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'clean up' });
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'Bash', { command: 'make' }));
    w.t.gate('Bash', { command: 'make' }, 'tu_1', 'command');
    await w.t.settle();
    await w.t.press('allow', 'U2');
    const ask = (w.of('ask.closed')[0].data as { ask: { id: string; closedBy: unknown } }).ask;
    expect(ask.closedBy).toMatchObject({ id: 'U2', via: 'slack' });
    const r = await w.call('asks.dismiss', { askId: ask.id });
    expect((r.error as { code: string }).code).toBe('ask_closed');
  });

  it('a steer declines every open ask and reaches the agent through the first; a queued message leaves them open', async () => {
    const w = await world();
    const a = result(await w.call('turns.send', { input: 'go' }));
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'Bash', { command: 'make' }), ...w.T.tool('tu_2', 'Bash', { command: 'lint' }));
    w.t.gate('Bash', { command: 'make' }, 'tu_1', 'command');
    w.t.gate('Bash', { command: 'lint' }, 'tu_2', 'command');
    await w.t.settle();
    const askIds = w.of('ask.opened').map((e) => (e.data as { ask: { id: string } }).ask.id);
    expect(askIds).toHaveLength(2);
    expect(result(await w.call('turns.send', { input: 'later', ifBusy: 'queue' })).delivery).toBe('queued');
    expect(w.of('ask.closed')).toHaveLength(0);
    const s = result(await w.call('turns.send', { input: 'use pnpm', ifBusy: 'steer' }, BOB));
    expect(s.delivery).toBe('steered');
    expect(s.turn.id).toBe(a.turn.id);
    const got = w.of('message.received').at(-1)!;
    expect(got.data).toMatchObject({ delivery: 'steered', declinedAskIds: askIds });
    const closed = w.of('ask.closed').map((e) => (e.data as { ask: Record<string, unknown> }).ask);
    expect(closed.map((k) => k.status)).toEqual(['declined', 'declined']);
    for (const k of closed) expect(k).toMatchObject({ answer: { message: 'use pnpm', messageSeq: got.seq }, closedBy: { id: 'usr_bob' } });
    const decisions = w.rec.filter((r) => (r as { decision?: string }).decision).map((r) => (r as { d: { behavior: string; message: string } }).d);
    expect(decisions.map((d) => d.behavior)).toEqual(['deny', 'deny']);
    expect(decisions.filter((d) => d.message.includes('use pnpm'))).toHaveLength(1);
    expect(w.sends()).toHaveLength(1); // the text went through the denials, not as another message
    expect(w.log.fold.status).toBe('running');
    // The harness takes it with its next request.
    expect(w.of('turn.steered')).toHaveLength(0);
    await w.t.feed({ t: 'request', phase: 'start' });
    expect(w.of('turn.steered').map((e) => (e.actor as { id: string } | null)?.id)).toEqual(['usr_bob']);
    expect(w.of('turn.steered')[0].data).toEqual({ messageSeq: got.seq });
    for (const e of w.events()) assertEvent(e);
  });

  it('a steer with no ask open is turn.steered when the harness next requests, not when it arrives', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'go' });
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'Bash', { command: 'sleep 20' }));
    expect(result(await w.call('turns.send', { input: 'also BANANA', ifBusy: 'steer' })).delivery).toBe('steered');
    expect(w.sends()).toHaveLength(2);
    expect(w.of('turn.steered')).toHaveLength(0);
    await w.t.feed(w.T.result('tu_1', ''), { t: 'request', phase: 'start' });
    expect(w.of('turn.steered').map((e) => e.data)).toEqual([{ messageSeq: w.of('message.received').at(-1)!.seq }]);
    await w.t.feed({ t: 'request', phase: 'start' });
    expect(w.of('turn.steered')).toHaveLength(1);
  });

  it('a plan approval may name the mode the session continues in', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'plan it' });
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'Bash', { command: 'make' }));
    w.t.gate('Bash', { command: 'make' }, 'tu_1', 'command');
    await w.t.settle();
    const bash = (w.of('ask.opened')[0].data as { ask: { id: string } }).ask.id;
    const notPlan = await w.call('asks.answer', { askId: bash, answer: { decision: 'allow', mode: 'auto' } });
    expect(notPlan.error).toMatchObject({ code: 'invalid_answer' });
    await w.call('asks.answer', { askId: bash, answer: { decision: 'allow' } });
    await w.t.feed(w.T.result('tu_1', 'ok'), w.T.first(), ...w.T.tool('tu_2', 'ExitPlanMode', { plan: '1. ship' }));
    w.t.gate('ExitPlanMode', { plan: '1. ship' }, 'tu_2', 'plan');
    await w.t.settle();
    const plan = (w.of('ask.opened')[1].data as { ask: { id: string } }).ask.id;
    for (const answer of [{ decision: 'deny', mode: 'auto' }, { decision: 'allow', mode: 'plan' }]) {
      const bad = await w.call('asks.answer', { askId: plan, answer });
      expect((bad.error as { code: string }).code).toBe('invalid_answer');
    }
    const r = result(await w.call('asks.answer', { askId: plan, answer: { decision: 'allow', mode: 'auto' } }));
    expect(r.ask).toMatchObject({ status: 'answered', answer: { decision: 'allow', mode: 'auto' } });
    expect(w.t.sess.info.mode).toBe('auto');
    const d = w.rec.filter((x) => (x as { decision?: string }).decision === 'tu_2').map((x) => (x as { d: unknown }).d);
    expect(d).toEqual([expect.objectContaining({ behavior: 'allow', mode: 'auto' })]);
  });

  it('subagents: stop goes to the harness, records who stopped it; a repeat is 200, another member 409', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'research' });
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'Task', { description: 'dig', prompt: 'dig', subagent_type: 'general' }));
    await w.t.feed({ t: 'task', id: 'tk_1', state: 'started', title: 'dig', agentType: 'general' });
    const sa = (w.of('subagent.started')[0].data as { subagent: { id: string; callId: string } }).subagent;
    expect(sa.callId).toBe('tu_1');
    const r = result(await w.call('subagents.stop', { subagentId: sa.id }));
    expect(r.subagent.status).toBe('running');
    expect(w.rec).toContainEqual({ harness: 'stopTask', v: 'tk_1' });
    await w.t.feed({ t: 'task', id: 'tk_1', state: 'stopped' });
    expect((w.of('subagent.ended')[0].data as { subagent: { stoppedBy: { id: string } | null } }).subagent).toMatchObject({ status: 'stopped', stoppedBy: { id: 'usr_ann' } });
    expect(result(await w.call('subagents.stop', { subagentId: sa.id })).subagent.status).toBe('stopped');
    const other = await w.call('subagents.stop', { subagentId: sa.id }, BOB);
    expect((other.error as { code: string; status: number }).status).toBe(409);
    expect((other.error as { code: string }).code).toBe('subagent_ended');
  });

  it('a turn the harness starts after a background subagent ends is that subagent’s, with no input', async () => {
    const w = await world();
    await w.call('turns.send', { input: 'kick off' });
    await w.t.feed(w.T.first(), ...w.T.tool('tu_1', 'Task', { description: 'bg', prompt: 'bg', subagent_type: 'general', run_in_background: true }));
    await w.t.feed({ t: 'task', id: 'tk_1', state: 'started', title: 'bg', background: true });
    await w.t.feed(w.T.result('tu_1', 'launched'), ...w.T.text('0', 'started it'), w.T.done());
    expect(w.log.fold.status).toBe('idle');
    // Suspend with ifIdle waits for the subagent.
    await w.call('sessions.suspend', { ifIdle: true });
    expect(w.suspended.n).toBe(0);
    await w.t.feed({ t: 'task', id: 'tk_1', state: 'done', result: 'found it' });
    await w.t.feed(w.T.first(), ...w.T.text('1', 'The subagent found it.'), w.T.done());
    const sa = (w.of('subagent.ended')[0].data as { subagent: { id: string } }).subagent;
    const turnId = w.of('turn.started').at(-1)!.turnId!;
    expect(w.log.fold.turn(turnId)).toMatchObject({ trigger: 'subagent', subagentId: sa.id, input: null, status: 'completed' });
    expect(result(await w.call('subagents.get', { subagentId: sa.id })).subagent.result).toBe('found it');
    expect(w.of('turn.started').at(-1)!.data).toMatchObject({ subagentId: sa.id });
    // A result past the 8 KiB the event carries is on disk, not in the runner (084 perf fix 7).
    await w.t.feed({ t: 'task', id: 'tk_2', state: 'started', title: 'long' });
    await w.t.feed({ t: 'task', id: 'tk_2', state: 'done', result: 'r'.repeat(20_000) });
    const long = (w.of('subagent.ended')[1].data as { subagent: { id: string; result: string; resultTruncated: boolean } }).subagent;
    expect([long.result.length, long.resultTruncated]).toEqual([8192, true]);
    expect(readFileSync(`${w.log.journal.file}.results/${long.id}`, 'utf8')).toHaveLength(20_000);
    expect(result(await w.call('subagents.get', { subagentId: long.id })).subagent).toMatchObject({ resultTruncated: false, result: 'r'.repeat(20_000) });
    for (const e of w.events()) assertEvent(e);
  });

  it('sessions.update changes the title and mode and journals them; suspend records runtime.suspended', async () => {
    const w = await world();
    result(await w.call('sessions.update', { title: 'New title', mode: 'plan' }));
    const changes = w.of('session.updated').map((e) => (e.data as { changes: Record<string, unknown> }).changes);
    expect(changes).toContainEqual(expect.objectContaining({ title: { from: 'golden', to: 'New title' } }));
    expect(changes).toContainEqual(expect.objectContaining({ mode: { from: 'default', to: 'plan' } }));
    expect(w.t.sess.info.mode).toBe('plan');
    const r = result(await w.call('sessions.suspend'));
    expect(r.session.status).toBe('suspended');
    expect(w.of('runtime.suspended').map((e) => e.data)).toEqual([{ reason: 'requested' }]);
    expect(w.suspended.n).toBe(1);
    for (const e of w.events()) assertEvent(e);
  });

  it('sessions.update speed reaches the harness, the session and the journal; a bad one is refused', async () => {
    const w = await world();
    const r = result(await w.call('sessions.update', { speed: 'standard' }));
    expect(r.session.settings.speed).toBe('standard');
    expect(w.rec).toContainEqual({ harness: 'setSpeed', v: 'standard' });
    expect(w.t.sess.info.speed).toBe('standard');
    expect(w.of('session.updated').map((e) => (e.data as { changes: Record<string, unknown> }).changes)).toContainEqual(expect.objectContaining({ speed: { from: null, to: 'standard' } }));
    expect((await w.call('sessions.update', { speed: 'slow' })).error).toMatchObject({ code: 'invalid_request' });
    for (const e of w.events()) assertEvent(e);
  });

  it('a runner that attaches runs the turns the journal holds queued, in order, once each', async () => {
    const [run, b, c] = ['tn_0000000000a1', 'tn_0000000000b2', 'tn_0000000000c3'];
    const received = (input: string) => ({ input, ifBusy: 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] });
    const w = await world((log) => {
      // The runner that died: one turn running (the host's recovery failed it), two queued behind it.
      log.append('message.received', { ...received('first'), delivery: 'started' }, { turnId: run, actor: ANN });
      log.append('turn.started', { model: null, effort: null, mode: 'default' }, { turnId: run });
      log.append('message.received', received('second'), { turnId: b, actor: ANN });
      log.append('turn.queued', { position: 1 }, { turnId: b, actor: ANN });
      log.append('message.received', received('third'), { turnId: c, actor: BOB.actor });
      log.append('turn.queued', { position: 2 }, { turnId: c, actor: BOB.actor });
      log.append('turn.failed', { error: { code: 'runtime_lost', message: 'the runner ended' } }, { turnId: run });
    });
    // The host's Delivery.api for a turn already queued does not queue it again.
    await w.api.deliver('third', { actor: BOB.actor, member: 'usr_bob', ifBusy: 'queue', turnId: c });
    await w.t.settle();
    expect(w.sends().map((r) => (r as { v: { text: string } }).v.text)).toEqual(['second']);
    await w.t.feed(w.T.first(), ...w.T.text('0', 'two'), w.T.done());
    await w.t.feed(w.T.first(), ...w.T.text('1', 'three'), w.T.done());
    expect(w.sends().map((r) => (r as { v: { text: string } }).v.text)).toEqual(['second', 'third']);
    expect(w.of('turn.started').map((e) => e.turnId)).toEqual([run, b, c]);
    expect(w.of('message.received')).toHaveLength(3);
    expect(w.log.fold.turn(c)).toMatchObject({ status: 'completed', author: { id: 'usr_bob' } });
    expect(w.log.fold.session().queued).toEqual([]);
  });

  it('turns.send ifBusy interrupt is recorded and answered before the harness stops; the send follows in order', async () => {
    const w = await world();
    const a = result(await w.call('turns.send', { input: 'job' }));
    await w.t.feed(w.T.first(), ...w.T.text('0', 'on it'));
    let stopped!: () => void;
    w.t.h.stall = new Promise<void>((r) => (stopped = r));
    // The harness ends the turn while its interrupt has not returned.
    w.t.h.onInterrupt = () => w.t.h.push({ t: 'turn_ended', reason: 'error', detail: 'error_during_execution', usage: { input: 1 } });
    const r = result(await w.call('turns.send', { input: 'redo', ifBusy: 'interrupt' }, BOB));
    expect(r.delivery).toBe('started');
    expect(w.rec).toContainEqual({ harness: 'interrupt' });
    const got = w.of('message.received').at(-1)!;
    expect(got.turnId).toBe(r.turn.id);
    expect(got.data).toMatchObject({ ifBusy: 'interrupt', delivery: 'started', interruptedTurnIds: [a.turn.id] });
    expect(w.sends()).toHaveLength(1);
    // Another send meanwhile waits its turn.
    const q = result(await w.call('turns.send', { input: 'after' }));
    expect(q.delivery).toBe('queued');
    stopped();
    await w.t.settle();
    expect(w.sends().map((x) => (x as { v: unknown }).v)).toEqual([
      { text: 'job', how: 'queue' },
      { text: 'redo', how: 'queue' },
    ]);
    expect(w.of('turn.cancelled').map((e) => [e.turnId, (e.data as { forced: boolean }).forced])).toEqual([[a.turn.id, false]]);
    expect(w.of('turn.started').at(-1)?.turnId).toBe(r.turn.id);
    await w.t.feed(w.T.first(), ...w.T.text('1', 'redone'), w.T.done());
    expect(w.of('turn.started').map((e) => e.turnId)).toEqual([a.turn.id, r.turn.id, q.turn.id]);
    for (const e of w.events()) assertEvent(e);
  });

  it('an API interrupt after a Slack `!!` still goes cancelling, once, and is forced after 10 s', async () => {
    const w = await world();
    const a = result(await w.call('turns.send', { input: 'long job' }));
    await w.t.feed(w.T.first(), ...w.T.text('0', 'on it'));
    await w.t.send('!! stop that'); // the harness does not stop
    expect(w.log.fold.turn(a.turn.id)?.status).toBe('running');
    await w.call('sessions.interrupt');
    await w.call('sessions.interrupt');
    const changed = w.of('turn.status_changed').filter((e) => e.turnId === a.turn.id);
    expect(changed.map((e) => e.data)).toEqual([{ from: 'running', to: 'cancelling' }]);
    await w.t.settle(10_000);
    const c = w.of('turn.cancelled').filter((e) => e.turnId === a.turn.id);
    expect(c.map((e) => e.data)).toEqual([expect.objectContaining({ reason: 'interrupted', forced: true })]);
  });
});
