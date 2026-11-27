// SessionApi with a message's attachments (work 126): the frame's metadata is
// recorded on `message.received` as it came, fetched through the runner's
// fetcher before the turn starts, and recovered from the journal for a queued
// turn the runner that queued it never ran. api.test.ts covers the rest.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANN, ANN_CTX, assertEvent, openLog, tempSession } from '../../api/testing.js';
import type { ApiAttachment, JournalEvent } from '../../protocol.js';
import type { SessionApiOptions } from './api.js';

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

/** A SessionApi over a fake harness, with `fetched` every list of attachments it asked the fetcher for. `before` fills the journal; the API then resumes. */
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
  const fetched: ApiAttachment[][] = [];
  const attachments: SessionApiOptions['attachments'] = async (atts) => {
    fetched.push(atts);
    return atts.map((a) => ({ name: a.name, path: `/tmp/x/${a.id}-${a.name}`, mimetype: a.mimetype }));
  };
  const api = new SessionApi(log, t.sess, { owner: OWNER, attachments, suspend: () => {} });
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
  return { T, t, call, events, of, sends, fetched };
}

const result = (o: { result?: unknown; error?: unknown }) => {
  expect(o.error).toBeUndefined();
  // biome-ignore lint/suspicious/noExplicitAny: results are read loosely in tests
  return o.result as Record<string, any>;
};

const ids = (a: unknown) => (a as { id: string }[]).map((x) => x.id);

describe('SessionApi with attachments', () => {
  it("turns.send with attachments: the frame's metadata is recorded on message.received and fetched through the runner's fetcher", async () => {
    const w = await world();
    const atts = [{ id: 'at_1', name: 'shot.png', mimetype: 'image/png', bytes: 11 }];
    const a = result(await w.call('turns.send', { input: 'look at this' }, { ...BOB, attachments: atts }));
    expect(a.delivery).toBe('started');
    expect(w.fetched).toEqual([atts]);
    expect(w.sends()).toHaveLength(1);
    const received = w.of('message.received');
    expect(received.map((e) => (e.data as { attachments: unknown }).attachments)).toEqual([atts]);
    for (const e of w.events()) assertEvent(e);

    // Queued and steered sends carry theirs too; one with none records an empty list.
    await w.t.feed(w.T.first(), ...w.T.text('0', 'working'));
    const b = result(await w.call('turns.send', { input: 'and this', ifBusy: 'queue' }, { ...BOB, attachments: [{ ...atts[0], id: 'at_2' }] }));
    expect(b.delivery).toBe('queued');
    const s = result(await w.call('turns.send', { input: 'plain', ifBusy: 'steer' }, BOB));
    expect(s.delivery).toBe('steered');
    expect(w.of('message.received').map((e) => ids((e.data as { attachments: unknown }).attachments))).toEqual([['at_1'], ['at_2'], []]);
    await w.t.feed(w.T.done());
    expect(w.fetched.map(ids)).toEqual([['at_1'], ['at_2']]);
    for (const e of w.events()) assertEvent(e);
  });

  it('a message may be its attachments alone; one with neither text nor attachments is refused', async () => {
    const w = await world();
    const atts = [{ id: 'at_7', name: 'spec.pdf', mimetype: 'application/pdf', bytes: 5 }];
    const empty = await w.call('turns.send', { input: '' }, BOB);
    expect(empty.error).toMatchObject({ code: 'invalid_request', field: 'input', status: 400 });
    expect(w.of('message.received')).toHaveLength(0);
    const none = await w.call('turns.send', { input: '' }, { ...BOB, attachments: [] });
    expect(none.error).toMatchObject({ code: 'invalid_request', field: 'input' });
    const a = result(await w.call('turns.send', { input: '' }, { ...BOB, attachments: atts }));
    expect(a.delivery).toBe('started');
    expect(w.fetched).toEqual([atts]);
    expect(w.of('message.received').map((e) => e.data)).toMatchObject([{ input: '', attachments: atts }]);
    for (const e of w.events()) assertEvent(e);
  });

  it('a queued turn with attachments survives the runner that queued it: the resume fetches them again from the journal', async () => {
    const atts = [{ id: 'at_9', name: 'spec.pdf', mimetype: 'application/pdf', bytes: 5 }];
    const w = await world((log) => {
      log.append('message.received', { input: 'read the spec', ifBusy: 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [], attachments: atts }, { turnId: 'tn_0000000000q1', actor: ANN });
      log.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: 'tn_0000000000q1', actor: ANN });
    });
    await w.t.settle();
    expect(w.of('turn.started').map((e) => e.turnId)).toEqual(['tn_0000000000q1']);
    expect(w.fetched).toEqual([atts]);
  });
});
