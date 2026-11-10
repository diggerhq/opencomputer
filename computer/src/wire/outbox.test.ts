import { describe, expect, it } from 'vitest';
import { completesKey, Outbox } from './outbox.js';

/** An outbox whose socket flushes only when the test says so. */
function harness(o: ConstructorParameters<typeof Outbox>[1] = {}) {
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const log: string[] = [];
  const box = new Outbox(
    {
      send: (d, done) => {
        sent.push(d.toString());
        pending.push(done);
      },
      onPause: (s) => log.push(`pause ${s}`),
      onResume: (s) => log.push(`resume ${s}`),
      onOverflow: () => log.push('overflow'),
    },
    o,
  );
  const flush = () => {
    while (pending.length) pending.shift()?.();
  };
  const methods = () => sent.map((t) => JSON.parse(t)).map((m) => (m.method === 'delta' ? `delta:${m.params.data.text}` : m.method === 'event' ? `event:${m.params.seq}` : (m.method ?? `id:${m.id}`)));
  return { box, sent, flush, log, methods };
}

const ev = (seq: number, type = 'x', data: object = {}) => JSON.stringify({ seq, type, data });
const delta = (blockId: string, text: string) => ({ type: 'message.delta', data: { blockId, text } }) as never;

describe('Outbox', () => {
  it('sends responses first, then events before deltas, sessions in turn', () => {
    const h = harness({ highWater: 1 });
    h.box.urgent('{"id":0}');
    h.box.event('a', 1, ev(1));
    h.box.event('a', 2, ev(2));
    h.box.delta('b', delta('k', 'x'));
    h.box.event('c', 1, ev(1));
    h.box.urgent('{"id":1}');
    for (let i = 0; i < 6; i++) h.flush();
    expect(h.methods()).toEqual(['id:0', 'id:1', 'event:1', 'event:1', 'event:2', 'delta:x']);
  });

  it('merges waiting deltas of one block, and a completed event removes them', () => {
    const h = harness({ highWater: 1 });
    h.box.urgent('{"id":0}');
    h.box.delta('a', delta('b1', 'he'));
    h.box.delta('a', delta('b1', 'llo'));
    h.box.delta('a', delta('b2', 'other'));
    h.box.event('a', 5, ev(5, 'message.completed', { blockId: 'b2' }), completesKey('message.completed', { blockId: 'b2' }));
    for (let i = 0; i < 5; i++) h.flush();
    expect(h.methods()).toEqual(['id:0', 'delta:hello', 'event:5']);
  });

  it('holds a session until released, other sessions flowing', () => {
    const h = harness();
    h.box.hold('a');
    h.box.event('a', 1, ev(1));
    h.box.event('b', 1, ev(1));
    h.flush();
    expect(h.sent).toHaveLength(1);
    h.box.urgent('{"id":7}');
    h.box.release('a');
    h.flush();
    expect(h.methods()).toEqual(['event:1', 'id:7', 'event:1']);
  });

  it('lets go of a hold after holdMs', async () => {
    const h = harness({ holdMs: 20 });
    h.box.hold('a');
    h.box.event('a', 1, ev(1));
    expect(h.sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(h.sent).toHaveLength(1);
  });

  it('pauses a session over pauseBytes and resumes it below half', () => {
    const h = harness({ highWater: 1, pauseBytes: 200 });
    h.box.urgent('{"id":0}');
    for (let s = 1; s <= 6; s++) h.box.event('a', s, ev(s, 'x', { pad: 'y'.repeat(20) }));
    expect(h.log).toEqual(['pause a']);
    for (let i = 0; i < 7; i++) h.flush();
    expect(h.log).toEqual(['pause a', 'resume a']);
  });

  it('overflows past maxUnsent, and sends nothing after', () => {
    const h = harness({ highWater: 10, maxUnsent: 100 });
    for (let s = 1; s <= 10; s++) h.box.event('a', s, ev(s));
    expect(h.log).toContain('overflow');
    const n = h.sent.length;
    h.box.urgent('{"id":9}');
    expect(h.sent.length).toBe(n);
  });

  it('keeps the backlog count of waiting events as they are queued and sent, deltas not counted', () => {
    const h = harness({ highWater: 1 });
    h.box.urgent('{"id":0}');
    h.box.event('a', 1, ev(1));
    h.box.delta('a', delta('b1', 'x'));
    h.box.event('a', 2, ev(2));
    h.box.event('a', 3, ev(3, 'message.completed', { blockId: 'b1' }), completesKey('message.completed', { blockId: 'b1' }));
    expect(h.box.backlog('a').events).toBe(3);
    h.flush();
    expect(h.methods()).toEqual(['id:0', 'event:1', 'event:2', 'event:3']);
    expect(h.box.backlog('a')).toEqual({ bytes: 0, events: 0 });
  });

  it('drops a detached session', () => {
    const h = harness({ highWater: 1 });
    h.box.urgent('{"id":0}');
    h.box.event('a', 1, ev(1));
    h.box.drop('a');
    h.flush();
    h.flush();
    expect(h.methods()).toEqual(['id:0']);
    expect(h.box.backlog('a')).toEqual({ bytes: 0, events: 0 });
  });
});

describe('Outbox telemetry hooks (work 084)', () => {
  it('tells the sink what it handed, and the meter of merges, without frames of its own', () => {
    const handed: unknown[] = [];
    const meter = { merges: 0, pauses: 0, merge() { this.merges++; }, pause() { this.pauses++; } };
    const sent: string[] = [];
    const pending: (() => void)[] = [];
    const box = new Outbox(
      {
        send: (d, done) => (sent.push(d.toString()), pending.push(done)),
        onPause: () => {},
        onResume: () => {},
        onOverflow: () => {},
        handed: (s, waited, created, delta) => handed.push({ s, waited: waited >= 0, created, delta }),
      },
      { highWater: 1, meter },
    );
    box.urgent('{"id":0}');
    box.event('a', 1, ev(1), undefined, 1000);
    box.delta('a', delta('k', 'x'));
    box.delta('a', delta('k', 'y'));
    while (pending.length) pending.shift()?.();
    while (pending.length) pending.shift()?.();
    while (pending.length) pending.shift()?.();
    expect(meter.merges).toBe(1);
    expect(handed).toEqual([
      { s: 'a', waited: true, created: 1000, delta: false },
      { s: 'a', waited: true, created: undefined, delta: true },
    ]);
    expect(sent).toHaveLength(3);
  });
});
