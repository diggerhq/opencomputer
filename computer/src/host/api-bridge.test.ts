import { describe, expect, it } from 'vitest';
import type { CallOutcome, SubscribeOptions } from '../api/writer.js';
import type { ApiActor, HostToGateway, JournalEvent } from '../protocol.js';
import { apiBridge, type WriterPort } from './api-bridge.js';

const S = 'cs_0000000000000000';
const actor: ApiActor = { id: 'usr_1', name: 'Ada', via: 'api', client: null };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A writer with a journal in memory; `lag` delays its stream behind its call results, as a runner's socket may. */
function fakeWriter(o: { lag?: number } = {}) {
  const journal: JournalEvent[] = [];
  const subs = new Set<SubscribeOptions>();
  const calls: { method: string; params: unknown }[] = [];
  const append = (type: string) => {
    const e: JournalEvent = { id: `ev_${journal.length}`, seq: journal.length + 1, createdAt: '', sessionId: S, turnId: null, type, actor: null, data: { pad: 'x'.repeat(200) } };
    journal.push(e);
    for (const s of subs) (o.lag ? setTimeout(() => s.onEvent(e), o.lag) : s.onEvent(e));
    return e;
  };
  const port: WriterPort = {
    async call(method, params): Promise<CallOutcome> {
      calls.push({ method, params });
      if (method === 'turns.send') {
        append('message.received');
        const e = append('turn.queued');
        return { result: { delivery: 'queued', seq: e.seq } };
      }
      return { result: { ok: true } };
    },
    async subscribe(so) {
      for (const e of journal) if (e.seq > (so.after ?? journal.length)) so.onEvent(e);
      subs.add(so);
      return { attached: { session: {}, after: so.after ?? 0, lastSeq: journal.length, epoch: 1 }, ack() {}, close: () => subs.delete(so) };
    },
  };
  return { journal, subs, calls, append, port };
}

function gateway() {
  const sent: HostToGateway[] = [];
  let open = true;
  return {
    sent,
    set open(v: boolean) {
      open = v;
    },
    send: (m: HostToGateway) => (open ? (sent.push(m), true) : false),
    journal: () => sent.flatMap((m) => (m.t === 'journal' ? m.events.map((e) => e.seq) : [])),
  };
}

const frame = (id: string, method: string, params: unknown = {}) =>
  ({ t: 'api', id, sessionId: S, method, params, actor, member: 'usr_1' }) as const;

describe('apiBridge', () => {
  it('answers an api frame from the writer, after the journal frames holding its events', async () => {
    const w = fakeWriter({ lag: 5 });
    const g = gateway();
    const b = apiBridge({ send: g.send, writer: async () => w.port, disk: () => [], flushMs: 10_000 });
    b.open(S, 1, 0);
    await b.follow(S);
    await b.api(frame('a1', 'turns.send', { input: 'hi' }));
    expect(w.calls[0]).toEqual({ method: 'turns.send', params: { input: 'hi', sessionId: S } });
    const kinds = g.sent.map((m) => m.t);
    expect(kinds).toEqual(['journal', 'api-result']);
    expect(g.journal()).toEqual([1, 2]);
    expect(g.sent[1]).toEqual({ t: 'api-result', id: 'a1', result: { delivery: 'queued', seq: 2 } });
    b.stop();
  });

  it('refuses a method the writer does not serve, and a session it has no writer for', async () => {
    const g = gateway();
    const b = apiBridge({ send: g.send, writer: async () => undefined, disk: () => [] });
    await b.api(frame('a1', 'terminals.open'));
    await b.api(frame('a2', 'sessions.get'));
    await b.api(frame('a3', 'sessions.get', { sessionId: 'cs_1111111111111111' }));
    expect(g.sent.map((m) => m.t === 'api-result' && m.error?.code)).toEqual(['invalid_request', 'session_not_found', 'invalid_request']);
    b.stop();
  });

  it('calls one session in arrival order even when finding its writer takes time', async () => {
    const w = fakeWriter();
    const g = gateway();
    let first = true;
    const b = apiBridge({
      send: g.send, disk: () => [],
      writer: async () => {
        if (first) (first = false), await tick(20);
        return w.port;
      },
    });
    await Promise.all([b.api(frame('a1', 'sessions.get')), b.api(frame('a2', 'turns.get', { turnId: 'tn_000000000000' }))]);
    expect(w.calls.map((c) => c.method)).toEqual(['sessions.get', 'turns.get']);
    b.stop();
  });

  it('flushes at once on urgent events and within flushMs otherwise', async () => {
    const w = fakeWriter();
    const g = gateway();
    const b = apiBridge({ send: g.send, writer: async () => w.port, disk: () => [], flushMs: 20 });
    b.open(S, 1, 0);
    await b.follow(S);
    w.append('message.completed');
    expect(g.journal()).toEqual([]);
    w.append('turn.completed');
    expect(g.journal()).toEqual([1, 2]);
    w.append('tool.started');
    await tick(40);
    expect(g.journal()).toEqual([1, 2, 3]);
    b.stop();
  });

  it('waits while the gateway socket holds more than holdBytes unwritten, except for a write before its api-result (084 perf fix 2)', async () => {
    const w = fakeWriter();
    const g = gateway();
    let buffered = 5000;
    const held: (number | undefined)[] = [];
    const meter = { batch: (_s: string, _e: unknown, _u: boolean, ms?: number) => void held.push(ms), acked() {}, relinked() {}, forget() {} };
    const b = apiBridge({ send: g.send, buffered: () => buffered, holdBytes: 1000, writer: async () => w.port, disk: () => [], flushMs: 10, meter });
    b.open(S, 1, 0);
    await b.follow(S);
    w.append('message.completed');
    w.append('turn.completed'); // urgent, and still waits
    await tick(30);
    expect(g.journal()).toEqual([]);
    expect(b.state(S)?.received).toBe(2); // the spool holds them
    // A write's own events go regardless, ahead of its result (read your writes).
    await b.api(frame('a1', 'turns.send', { input: 'hi' }));
    expect(g.sent.map((m) => m.t)).toEqual(['journal', 'api-result']);
    expect(g.journal()).toEqual([1, 2, 3, 4]);
    w.append('tool.started');
    await tick(30);
    expect(g.journal()).toEqual([1, 2, 3, 4]);
    buffered = 0;
    await tick(30);
    expect(g.journal()).toEqual([1, 2, 3, 4, 5]);
    // Only the batch that ended a wait says how long it was.
    expect(held[0]).toBeUndefined();
    expect(held[1]).toBeGreaterThan(0);
    b.stop();
  });

  it('resends from the last journal-ack after a reconnect, and nothing the DO acked', async () => {
    const w = fakeWriter();
    const g = gateway();
    const b = apiBridge({ send: g.send, writer: async () => w.port, disk: () => [], flushMs: 1 });
    b.open(S, 1, 0);
    await b.follow(S);
    for (let i = 0; i < 4; i++) w.append('turn.completed');
    expect(g.journal()).toEqual([1, 2, 3, 4]);
    b.ack({ t: 'journal-ack', sessionId: S, epoch: 1, seq: 2 });
    b.ack({ t: 'journal-ack', sessionId: S, epoch: 0, seq: 4 }); // a stale epoch's ack is ignored
    g.open = false;
    w.append('turn.completed'); // lost with the link
    g.open = true;
    g.sent.length = 0;
    b.relinked();
    expect(g.journal()).toEqual([3, 4, 5]);
    b.stop();
  });

  it('after a 4010 close (a journal gap: the DO acks nothing) resends everything since the last ack', async () => {
    const w = fakeWriter();
    const g = gateway();
    const b = apiBridge({ send: g.send, writer: async () => w.port, disk: () => [], flushMs: 1 });
    b.open(S, 1, 0);
    await b.follow(S);
    w.append('turn.completed');
    b.ack({ t: 'journal-ack', sessionId: S, epoch: 1, seq: 1 });
    for (let i = 0; i < 3; i++) w.append('turn.completed'); // the DO saw a gap: no ack, then 4010
    g.sent.length = 0;
    b.relinked(); // the welcome on the new socket
    expect(g.journal()).toEqual([2, 3, 4]);
    b.relinked(); // still unacked: the next reconnect sends them again
    expect(g.journal()).toEqual([2, 3, 4, 2, 3, 4]);
    b.stop();
  });

  it('sends subagent.progress deltas up as subagent-progress frames, at most once per progressMs per session', async () => {
    const w = fakeWriter();
    const g = gateway();
    const b = apiBridge({ send: g.send, writer: async () => w.port, disk: () => [], flushMs: 1, progressMs: 30 });
    b.open(S, 1, 0);
    await b.follow(S);
    const [sub] = w.subs;
    expect(sub.deltas).toBe(true);
    const p = (subagentId: string, toolCalls: number) => ({ subagentId, activity: 'Reading', toolCalls, tokens: 10 * toolCalls });
    const delta = (data: unknown, type = 'subagent.progress') => sub.onDelta({ type, sessionId: S, turnId: null, data });
    const frames = () => g.sent.filter((m) => m.t === 'subagent-progress');
    delta(p('sa_1', 1));
    delta({ blockId: 'b', text: 'hi' }, 'message.delta'); // other deltas are not the mirror's
    delta(p('sa_1', 2));
    delta(p('sa_2', 1));
    expect(frames()).toEqual([{ t: 'subagent-progress', sessionId: S, epoch: 1, progress: [p('sa_1', 1)] }]);
    await tick(50);
    expect(frames().at(-1)).toEqual({ t: 'subagent-progress', sessionId: S, epoch: 1, progress: [p('sa_1', 2), p('sa_2', 1)] });
    const before = frames().length;
    await tick(50);
    expect(frames()).toHaveLength(before); // nothing changed: no frame
    // An ended subagent leaves the frame.
    sub.onEvent({ id: 'ev_x', seq: 1, createdAt: '', sessionId: S, turnId: null, type: 'subagent.ended', actor: null, data: { subagent: { id: 'sa_1' } } });
    delta(p('sa_2', 3));
    await tick(50);
    expect(frames().at(-1)).toMatchObject({ progress: [p('sa_2', 3)] });
    b.stop();
  });

  it('beyond the spool budget re-reads from the journal on disk', async () => {
    const w = fakeWriter();
    const g = gateway();
    const reads: number[] = [];
    const disk = (_: string, after: number, limit: number) => (reads.push(after), w.journal.filter((e) => e.seq > after).slice(0, limit));
    const b = apiBridge({ send: g.send, writer: async () => w.port, disk, flushMs: 10_000, spoolBytes: 1000 });
    b.open(S, 1, 0);
    await b.follow(S);
    g.open = false;
    for (let i = 0; i < 20; i++) w.append('message.completed');
    expect(b.spooledBytes).toBeLessThanOrEqual(1000);
    g.open = true;
    b.relinked();
    expect(g.journal()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(reads.length).toBeGreaterThan(0);
    b.stop();
  });

  it('follows a new writer from the last seq it saw, and a higher epoch starts over at the DO lastSeq', async () => {
    const w = fakeWriter();
    const g = gateway();
    const b = apiBridge({ send: g.send, writer: async () => w.port, disk: () => [], flushMs: 1 });
    b.open(S, 1, 0);
    await b.follow(S);
    w.append('turn.completed');
    w.append('turn.completed');
    const [sub] = w.subs;
    w.subs.delete(sub); // the writer handed the journal on
    sub.onDetached('moved');
    await b.follow(S);
    expect(w.subs.size).toBe(1);
    expect([...w.subs][0].after).toBe(2);
    b.open(S, 2, 1);
    expect(b.state(S)).toMatchObject({ epoch: 2, acked: 1, received: 1 });
    b.stop();
  });
});
