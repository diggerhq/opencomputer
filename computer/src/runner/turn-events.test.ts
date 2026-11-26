import { describe, expect, it } from 'vitest';
import type { TraceContext } from '../protocol.js';
import { type Batch, createTelemetry } from '../telemetry/emitter.js';
import type { TelemetryEvent } from '../telemetry/envelope.js';
import { Translator } from './harness/claude/translate.js';
import { capabilityOf, TurnEvents } from './turn-events.js';

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

/** TurnEvents on a fixed clock, with everything it emits collected. */
function setup(apiClients?: () => number | undefined) {
  const batches: Batch[] = [];
  const telemetry = createTelemetry({
    service: 'runner',
    version: 'r1',
    region: 'westus2',
    send: (b) => void batches.push(b),
    now: () => T0,
    base: { session_key: 'T1:C1:1.2', harness: 'claude-agent-sdk' },
  });
  const te = new TurnEvents(telemetry, { model: () => 'claude-opus-5-5', tierOf: () => 'default', provider: () => 'anthropic', apiClients }, () => T0);
  // SDK fixtures, as Claude's harness turns them into records.
  const tr = new Translator();
  const feed = (m: unknown) => {
    for (const e of tr.translate(m as never)) te.event(e);
  };
  const stream = (event: object) => feed({ type: 'stream_event', event } as never);
  const sdk = {
    init: () => feed({ type: 'system', subtype: 'init' } as never),
    start: () => stream({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 7 } } }),
    block: (index: number, content_block: object) => stream({ type: 'content_block_start', index, content_block }),
    stop: (index: number) => stream({ type: 'content_block_stop', index }),
    result: (id: string) => feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } } as never),
    done: () =>
      feed({ type: 'result', duration_api_ms: 900, total_cost_usd: 0.05, usage: { input_tokens: 10, output_tokens: 20 } } as never),
  };
  const out = async () => {
    await telemetry.flush();
    expect(telemetry.dropped).toEqual({});
    return batches.flatMap((b) => b.events) as TelemetryEvent[];
  };
  return { te, sdk, feed, out };
}

const trace = (n: number): TraceContext => ({
  id: `019a3b4c-0000-7000-8000-00000000000${n}`,
  sentAt: T0 - 300,
  receivedAt: T0 - 150,
  surface: 'slack',
  surfaceWorkspaceId: 'T1',
  conversationId: 'C1',
  personId: 'U1',
  path: 'warm',
});
const named = (events: TelemetryEvent[], name: string) => events.filter((e) => e.event_name === name);

describe('TurnEvents', () => {
  it('reports a turn as facts under one turn and trace, with no derived durations', async () => {
    const { te, sdk, feed, out } = setup();
    te.delivered(trace(1));
    te.pushed(false);
    sdk.init();
    sdk.start();
    sdk.block(0, { type: 'thinking' });
    sdk.stop(0);
    sdk.block(1, { type: 'tool_use', id: 'toolu_1', name: 'Bash' });
    sdk.stop(1);
    feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node shot.mjs && calvin-send-file a.png' } }] } } as never);
    te.filePosted({ kind: 'image', bytes: 1234, source: 'script' }); // the script posts while its call runs
    sdk.result('toolu_1');
    sdk.start();
    sdk.block(0, { type: 'text' });
    sdk.stop(0);
    te.surfaceCall({ method: 'chat.startStream', ms: 80, ok: true });
    sdk.done();
    te.ended(false);
    te.surfaceCall({ method: 'chat.stopStream', ms: 60, ok: true });
    te.closed();
    te.closed();
    const events = await out();
    const turnId = named(events, 'turn.started')[0].turn_id;
    expect(events.map((e) => e.event_name)).toEqual([
      'delivery.received',
      'prompt.pushed',
      'turn.started',
      'harness.started',
      'model.response_started',
      'model.block_started',
      'model.block_stopped',
      'model.block_started',
      'model.block_stopped',
      'file.posted',
      'tool.completed',
      'model.response_started',
      'model.block_started',
      'model.block_stopped',
      'surface.call',
      'turn.ended',
      'surface.call',
      'turn.closed',
    ]);
    for (const e of events.slice(2)) expect(e).toMatchObject({ turn_id: turnId, trace_id: trace(1).id, path: 'warm' });
    expect(named(events, 'model.block_started').map((e) => e.data.kind)).toEqual(['thinking', 'tool', 'text']);
    expect(named(events, 'model.block_started')[1]).toMatchObject({ tool_call_id: 'toolu_1', tool_name: 'Bash', capability: 'exec' });
    // What the command was for, never the command; the file names the call it was posted from.
    expect(named(events, 'tool.completed')[0].data).toEqual({ is_error: false, command_kinds: 'post' });
    expect(named(events, 'file.posted')[0]).toMatchObject({ tool_call_id: 'toolu_1', data: { kind: 'image', bytes: 1234, source: 'script' } });
    expect(named(events, 'model.response_started')[0]).toMatchObject({ model: 'claude-opus-5-5', tier: 'default', provider: 'anthropic' });
    expect(named(events, 'turn.ended')[0]).toMatchObject({
      outcome: 'completed',
      data: { input_tokens: 10, output_tokens: 20, api_ms: 900, cost_total_usd: 0.05 },
    });
    // Only operations timed around themselves carry a duration.
    expect(events.filter((e) => e.duration_ms !== undefined).map((e) => e.event_name)).toEqual(['surface.call', 'surface.call']);
  });

  it('reports the harness starting once, though the SDK repeats init every turn', async () => {
    const { te, sdk, out } = setup();
    for (const n of [1, 2]) {
      te.delivered(trace(n));
      te.pushed(false);
      sdk.init();
      te.ended(false);
    }
    te.harnessDied();
    te.delivered(trace(3));
    te.pushed(false);
    sdk.init();
    expect(named(await out(), 'harness.started')).toHaveLength(2);
  });

  it('reports a harness started ahead of the first message with no turn, and once', async () => {
    const { te, sdk, out } = setup();
    te.harnessStarted();
    te.delivered(trace(1));
    te.pushed(false);
    sdk.init();
    te.ended(false);
    te.harnessEnded();
    te.harnessStarted();
    const started = named(await out(), 'harness.started');
    expect(started).toHaveLength(2);
    expect(started[0].turn_id).toBeUndefined();
  });

  it('splits `!!` into an interrupted turn and a new turn carrying the `!!` message', async () => {
    const { te, out } = setup();
    te.delivered(trace(1));
    te.pushed(false);
    te.delivered(trace(2));
    te.interrupting('interrupted');
    te.pushed(false);
    te.ended(false, 'error_during_execution');
    te.ended(false);
    const events = await out();
    expect(named(events, 'turn.started').map((e) => e.trace_id)).toEqual([trace(1).id, trace(2).id]);
    expect(named(events, 'turn.ended').map((e) => e.outcome)).toEqual(['interrupted', 'completed']);
  });

  it('overlapping closes: each turn gets its own turn.closed, in order; a late write is the oldest closing turn\'s', async () => {
    const { te, out } = setup();
    te.delivered(trace(1));
    te.pushed(false);
    te.ended(false);
    te.delivered(trace(2));
    te.pushed(false);
    te.ended(true);
    te.surfaceCall({ method: 'chat.stopStream', ms: 60, ok: true, placeholder: true });
    te.closed();
    te.closed();
    const events = await out();
    const [t1, t2] = named(events, 'turn.started').map((e) => e.turn_id);
    expect(named(events, 'turn.closed').map((e) => e.turn_id)).toEqual([t1, t2]);
    expect(named(events, 'surface.call')[0]).toMatchObject({ turn_id: t1, data: { placeholder: true } });
  });

  it('classifies cancelled, silent, crashed and failed turns', async () => {
    const { te, out } = setup();
    const turn = (n: number, end: () => void) => {
      te.delivered(trace(n));
      te.pushed(false);
      end();
    };
    turn(1, () => (te.interrupting('cancelled'), te.ended(false, 'error_during_execution')));
    turn(2, () => te.ended(true));
    turn(3, () => (te.harnessDied(), te.ended(false)));
    turn(4, () => te.ended(false, 'error_max_turns'));
    const ended = named(await out(), 'turn.ended');
    expect(ended.map((e) => [e.outcome, e.error_type ?? ''])).toEqual([
      ['cancelled', ''],
      ['silent', ''],
      ['failed', 'harness_crash'],
      ['failed', 'harness_error'],
    ]);
  });

  it('joins a steer to the running turn under its own trace', async () => {
    const { te, sdk, out } = setup();
    te.delivered(trace(1));
    te.pushed(false);
    te.delivered(trace(2));
    te.pushed(true);
    sdk.result('toolu_1');
    te.ended(false);
    const events = await out();
    const [steer] = named(events, 'prompt.pushed').filter((e) => e.data.steer);
    expect(steer).toMatchObject({ trace_id: trace(2).id, turn_id: named(events, 'turn.started')[0].turn_id });
    expect(named(events, 'turn.started')).toHaveLength(1);
  });

  it('starts the next turn with a steer the running turn never carried back', async () => {
    const { te, out } = setup();
    te.delivered(trace(1));
    te.pushed(false);
    te.delivered(trace(2));
    te.pushed(true);
    te.ended(false);
    const started = named(await out(), 'turn.started');
    expect(started.map((e) => e.trace_id)).toEqual([trace(1).id, trace(2).id]);
    expect(started.map((e) => e.data.turn_seq)).toEqual([1, 2]);
  });

  it('ignores a duplicate delivery and counts it', async () => {
    const { te, out } = setup();
    expect(te.delivered(trace(1))).toBe(true);
    expect(te.delivered(trace(1))).toBe(false);
    expect(named(await out(), 'telemetry.dropped')[0]).toMatchObject({ data: { reason: 'duplicate_delivery', count: 1 } });
  });

  it('reports output the SDK produced on its own as an untraced turn', async () => {
    const { sdk, out } = setup();
    sdk.start();
    const [started] = named(await out(), 'turn.started');
    expect(started.trace_id).toBe(started.turn_id);
  });

  it('reports a compaction under the turn it paused, and one between turns without a turn', async () => {
    const { te, sdk, out } = setup();
    te.compacted({ trigger: 'auto', before_tokens: 130_000, paused_turn: false, duration_ms: 20_000 });
    te.delivered(trace(1));
    te.pushed(false);
    te.compacted({ trigger: 'auto', before_tokens: 152_000, after_tokens: 24_000, summary_chars: 3751, paused_turn: true, duration_ms: 31_400 });
    sdk.start();
    const [idle, paused] = named(await out(), 'context.compacted');
    expect(idle.turn_id).toBeUndefined();
    expect(paused).toMatchObject({ turn_id: named(await out(), 'turn.started')[0].turn_id, duration_ms: 31_400 });
    expect(paused.data).toEqual({ trigger: 'auto', before_tokens: 152_000, after_tokens: 24_000, summary_chars: 3751, paused_turn: true });
  });

  it('a fork compaction dropped by an arriving message is not stamped with that message’s turn', async () => {
    const { te, sdk, out } = setup();
    te.delivered(trace(1));
    te.pushed(false); // the message that cancelled the fork; its turn is open when the fork reports
    te.compacted({ trigger: 'shadow', outcome: 'discarded', before_tokens: 130_000, paused_turn: false, duration_ms: 4_000, between_turns: true });
    sdk.start();
    const [fact] = named(await out(), 'context.compacted');
    expect(fact.turn_id).toBeUndefined();
    expect(fact.data).toEqual({ trigger: 'shadow', outcome: 'discarded', before_tokens: 130_000, paused_turn: false });
  });

  it('carries how long a write waited in the queue, when the segment stamped it', async () => {
    const { te, out } = setup();
    te.delivered(trace(1));
    te.pushed(false);
    te.surfaceCall({ method: 'chat.appendStream', ms: 40, ok: true, queuedMs: 120 });
    te.surfaceCall({ method: 'chat.appendStream', ms: 40, ok: true });
    const [stamped, unstamped] = named(await out(), 'surface.call');
    expect(stamped.data).toEqual({ method: 'chat.appendStream', status: 'ok', rate_limited: false, queued_ms: 120 });
    expect(unstamped.data).not.toHaveProperty('queued_ms');
  });

  it('reports loop lag only while a turn is open or closing', async () => {
    const { te, out } = setup();
    te.loopLag({ maxMs: 9, meanMs: 1, windowMs: 5000 });
    te.delivered(trace(1));
    te.pushed(false);
    te.loopLag({ maxMs: 42, meanMs: 3, windowMs: 5000 });
    te.ended(false);
    te.loopLag({ maxMs: 15, meanMs: 2, windowMs: 5000 }); // the final flush is still the turn's
    te.closed();
    te.loopLag({ maxMs: 7, meanMs: 1, windowMs: 5000 });
    const events = await out();
    const lag = named(events, 'loop.lag');
    const turnId = named(events, 'turn.started')[0].turn_id;
    expect(lag.map((e) => [e.turn_id, e.data.max_ms])).toEqual([
      [turnId, 42],
      [turnId, 15],
    ]);
    expect(lag[0].data).toEqual({ max_ms: 42, mean_ms: 3, window_ms: 5000 });
  });

  it('marks each turn.started with the protocol and attached API clients (Q1: did Slack get slower)', async () => {
    let clients: number | undefined;
    const { te, sdk, out } = setup(() => clients);
    te.delivered(trace(1));
    te.pushed(false);
    sdk.done();
    te.ended(false);
    te.closed();
    clients = 2;
    te.delivered(trace(2));
    te.pushed(false);
    const started = named(await out(), 'turn.started').map((e) => e.data);
    expect(started).toEqual([
      { turn_seq: 1, host_protocol: 3, api: false, api_clients: 0 },
      { turn_seq: 2, host_protocol: 4, api: true, api_clients: 2 },
    ]);
  });

  it('maps tool names to capabilities', () => {
    expect(['Bash', 'Read', 'Edit', 'Grep', 'Agent', 'mcp__calvin__send_file', 'Other'].map(capabilityOf)).toEqual([
      'exec',
      'read',
      'edit',
      'search',
      'agent',
      'mcp',
      'other',
    ]);
  });
});
