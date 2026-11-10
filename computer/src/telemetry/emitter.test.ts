import { describe, expect, it } from 'vitest';
import { type Batch, createTelemetry, type TelemetryOptions } from './emitter.js';
import { uuidv7 } from './envelope.js';

function setup(over: Partial<TelemetryOptions> = {}) {
  const sent: Batch[] = [];
  let mono = 0;
  const t = createTelemetry({
    service: 'host',
    version: 'abc123',
    region: 'westus2',
    send: (b) => void sent.push(b),
    now: () => Date.UTC(2026, 9, 12),
    mono: () => mono,
    ...over,
  });
  return { t, sent, tick: (ms: number) => (mono += ms) };
}
const names = (b: Batch[]) => b.flatMap((x) => x.events.map((e) => e.event_name));
const turnRow = () => ({
  turn_id: uuidv7(),
  trace_id: uuidv7(),
  session_key: 'T1:C1:1.2',
  turn_seq: 1,
  sent_at: '2026-10-12 10:00:00.000',
  gateway_version: 'g',
  host_version: 'h',
  runner_version: 'r',
  synthetic: false,
  outcome: 'completed' as const,
  cost_usd: 0.01,
});

describe('createTelemetry', () => {
  it('stamps the envelope and sends on flush', async () => {
    const { t, sent } = setup({ base: { host_id: 'h1', substrate: 'vm' } });
    t.emit('fork.done', { session_key: 'T1:C1:1.2', data: { repos: 3 } });
    expect(sent).toHaveLength(0);
    await t.flush();
    const e = sent[0].events[0];
    expect(e).toMatchObject({ event_name: 'fork.done', service_name: 'host', host_id: 'h1', substrate: 'vm', data: { repos: 3 }, synthetic: false });
    expect(e.occurred_at).toBe('2026-10-12 00:00:00.000');
  });

  it('measures a span on the monotonic clock', async () => {
    const { t, sent, tick } = setup();
    const span = t.start('fork.repo', { session_key: 'k' });
    tick(250);
    span.end({ outcome: 'completed', data: { repo: 'r1', fetch_ms: 200 } });
    span.end();
    await t.flush();
    expect(sent[0].events).toHaveLength(1);
    expect(sent[0].events[0]).toMatchObject({ duration_ms: 250, outcome: 'completed' });
  });

  it('drops invalid events and reports the count on the next flush', async () => {
    const { t, sent } = setup();
    t.emit('fork.repo', { data: { repo: '/home/owner/secret' } });
    t.emit('fork.repo', { data: { prompt: 'line one\nline two' } as never });
    expect(t.dropped.invalid).toBe(2);
    await t.flush();
    expect(sent[0].events).toEqual([expect.objectContaining({ event_name: 'telemetry.dropped', data: { reason: 'invalid', count: 2 } })]);
  });

  it('drops the oldest record when the buffer is full', async () => {
    const { t, sent } = setup({ maxBuffer: 3 });
    for (let i = 0; i < 5; i++) t.emit('runner.ready', { data: { polls: i } });
    expect(t.buffered).toBe(3);
    expect(t.dropped.buffer_full).toBe(2);
    await t.flush();
    const polls = sent[0].events.filter((e) => e.event_name === 'runner.ready').map((e) => e.data.polls);
    expect(polls.at(-1)).toBe(4);
  });

  it('validates turn rows and sends them beside events', async () => {
    const { t, sent } = setup();
    t.turn(turnRow());
    t.turn({ ...turnRow(), outcome: 'exploded' as never });
    await t.flush();
    expect(sent[0].turns).toHaveLength(1);
    expect(sent[0].turns[0].region).toBe('westus2');
    expect(t.dropped.invalid).toBe(1);
  });

  it('never throws when send, now or mono throw', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    const { t } = setup({ send: boom, now: boom, mono: boom });
    expect(() => t.emit('runner.ready')).not.toThrow();
    expect(() => t.start('fork.done').end()).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.dropped.send_failed).toBeGreaterThan(0);
  });

  it('counts a rejected send', async () => {
    const { t } = setup({ send: () => Promise.reject(new Error('503')) });
    t.emit('runner.ready');
    await t.flush();
    expect(t.dropped.send_failed).toBe(1);
  });

  it('validates and discards without send (telemetry off)', async () => {
    const { t } = setup({ send: undefined });
    t.emit('fork.repo', { data: { repo: '/etc/passwd' } });
    t.emit('runner.ready');
    expect(t.dropped.invalid).toBe(1);
    await t.flush();
    expect(t.buffered).toBe(0);
  });

  it('waits for open spans before flushing, up to a deadline', async () => {
    const { t, sent } = setup();
    const fork = t.start('fork.done');
    const flushed = t.flush(1000);
    setTimeout(() => fork.end({ outcome: 'completed' }), 5);
    await flushed;
    expect(names(sent)).toContain('fork.done');

    const never = t.start('fork.done');
    const started = Date.now();
    await t.flush(20);
    expect(Date.now() - started).toBeLessThan(500);
    never.end();
  });

  it('emits in microseconds (overhead budget: < 500 µs per event)', () => {
    // Guards the order of magnitude (no blocking I/O or flush on emit), not a
    // benchmark: an event takes a few µs locally, but a shared CI runner
    // measured 70-86 µs and failed a 50 µs budget. Warmed up first, timed in
    // batches of 100 and judged on the median batch, so JIT and scheduling
    // hiccups do not decide the result.
    const { t } = setup({ maxBuffer: 20_000 });
    const emit = () =>
      t.emit('tool.completed', { tool_call_id: 'toolu_1', tool_name: 'Bash', capability: 'exec', duration_ms: 12, data: { is_error: false } });
    for (let i = 0; i < 1_000; i++) emit();
    const batches: number[] = [];
    for (let b = 0; b < 100; b++) {
      const s = performance.now();
      for (let i = 0; i < 100; i++) emit();
      batches.push((performance.now() - s) / 100);
    }
    batches.sort((a, b) => a - b);
    expect(batches[50] * 1000).toBeLessThan(500);
  });
});
