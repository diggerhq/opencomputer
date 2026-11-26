// Reports a runner's turns as facts (work 054, "Runner"): what happened, when,
// and which turn and trace it belongs to. It measures nothing: no durations it
// derives, no counters, no turn row. Every interval, offset and KPI is SQL
// over `calvin_events` (telemetry/tinybird `turns`), so a formula is fixed
// once, in one place, and applies to history.
//
// The one thing only this process can know is identity, so that is all it
// keeps:
// - every turn gets its own `turn_id`; `turn_seq` restarts with the process;
// - pushed messages wait in a FIFO; a turn takes the oldest, so a turn started
//   by a queued message (after `!!`, or a steer left over at the end of a turn)
//   carries that message's trace;
// - a steer joins the running turn under its own trace; one still waiting
//   when the turn ends (no tool result carried it back) starts the next turn;
// - a delivery whose trace was already seen is a duplicate (the gateway
//   re-flushes dispatches after a reconnect) and is dropped and counted.
//
// Spans are kept only where a single operation is timed around itself (names,
// intro, attachments, a Slack call): the operation's own duration is a fact.

import type { TraceContext } from '../protocol.js';
import type { Telemetry } from '../telemetry/emitter.js';
import { type Capability, type ErrorType, tbTime, type TurnOutcome, uuidv7 } from '../telemetry/envelope.js';
import { type CommandKind, commandKinds } from './command-kinds.js';
import { HIDDEN_TOOLS } from './format.js';
import type { SurfaceCall } from './surface-meter.js';
import type { CompactionFact } from './compaction.js';
import type { HarnessEvent, HarnessStartup } from './harness/types.js';
import type { LoopLag } from './loop-lag.js';

export interface TurnEventsContext {
  /** The model id in effect (it changes with `!model` and at init). */
  model(): string | undefined;
  tierOf(model: string): string | undefined;
  /** The route's profile name; undefined before the host sent one. */
  provider(): string | undefined;
  /** While this runner writes the session's journal (work 084): the API clients attached now, the host's mirror excluded. */
  apiClients?(): number | undefined;
}

export type Part = 'names' | 'intro' | 'attachments';

interface Turn {
  id: string;
  seq: number;
  trace?: TraceContext;
  sentAt: number;
}

const SEEN_TRACES = 500;
const PART_EVENT = { names: 'names.resolved', intro: 'intro.posted', attachments: 'attachments.fetched' } as const;

export class TurnEvents {
  private seen = new Set<string>();
  /** The delivery being handled, until it is pushed. */
  private current?: TraceContext;
  private queue: (TraceContext | undefined)[] = [];
  /** Steers pushed into the running turn and not yet carried back to the model with a tool result. */
  private steers: (TraceContext | undefined)[] = [];
  /** Bash calls awaiting their result: what each command was for (command-kinds.ts); comma-joined on `tool.completed`. */
  private kinds = new Map<string, CommandKind[]>();
  /** Tool calls started and not yet completed, so a file a script posts can name the call it ran in. */
  private open = new Set<string>();
  private turn?: Turn;
  private seq = 0;
  private ending?: 'cancelled' | 'interrupted';
  private crashed = false;
  /** The harness process is up: Claude Code repeats its `session` record every turn, but it starts once. */
  private harnessUp = false;
  private result?: Extract<HarnessEvent, { t: 'turn_ended' }>;
  /** The last ended turn, until Session reports its end-of-turn work done. */
  /** Turns whose message is still closing, oldest first: closes land in turn order (turn-close.ts). */
  private closing: (Turn | undefined)[] = [];

  constructor(
    private t: Telemetry,
    private ctx: TurnEventsContext,
    private wall: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- what Session and the runner report

  /** A delivery arrived. False: a duplicate of one already handled; ignore it. */
  delivered(trace?: TraceContext): boolean {
    if (trace) {
      if (this.seen.has(trace.id)) {
        this.t.emit('telemetry.dropped', { trace_id: trace.id, data: { reason: 'duplicate_delivery', count: 1 } });
        return false;
      }
      this.seen.add(trace.id);
      if (this.seen.size > SEEN_TRACES) this.seen.delete(this.seen.values().next().value!);
    }
    this.current = trace;
    this.t.emit('delivery.received', traceFields(trace));
    return true;
  }

  /** Time one part of handling the current delivery before its push. */
  async timed<T>(part: Part, p: Promise<T>, data?: { count?: number }): Promise<T> {
    const trace = this.current;
    const started = performance.now();
    try {
      return await p;
    } finally {
      this.t.emit(PART_EVENT[part], { ...traceFields(trace), duration_ms: performance.now() - started, data: data ?? {} });
    }
  }

  /** The current delivery went into the inbox: a steer joins the running turn, anything else waits for one. */
  pushed(steer: boolean) {
    const trace = this.current;
    this.current = undefined;
    const joins = steer && this.turn ? this.turn : undefined;
    this.t.emit('prompt.pushed', { ...traceFields(trace), ...(joins ? { turn_id: joins.id } : {}), data: { steer: !!joins } });
    if (joins) return void this.steers.push(trace);
    this.queue.push(trace);
    if (!this.turn) this.begin();
  }

  /** Session is about to interrupt the running turn: the stop button / `!stop`, or `!!`. */
  interrupting(why: 'cancelled' | 'interrupted') {
    this.ending = why;
  }

  /** The harness process died; the next push starts a new one. */
  harnessDied() {
    this.crashed = true;
    this.harnessUp = false;
  }

  /**
   * The harness process is up (its initialize handshake answered). A harness
   * started ahead of the first message reports this with no turn: the turn
   * finds it already up; so does a claimed spare's (work 069), with `parkedMs`. A harness that
   * measures its own start-up (Codex) says how long each step took.
   */
  harnessStarted(start?: { parkedMs?: number } & HarnessStartup) {
    if (this.harnessUp) return;
    this.harnessUp = true;
    const data = {
      ...(start && 'parkedMs' in start ? { claimed: true, parked_ms: start.parkedMs } : {}),
      ...(start?.version ? { harness_version: start.version } : {}),
      ...(start?.spawnMs !== undefined ? { spawn_ms: start.spawnMs, initialize_ms: start.initializeMs, thread_ms: start.threadMs, resume: start.resumed } : {}),
    };
    this.t.emit('harness.started', { ...(this.turn ? this.fields(this.turn) : {}), data });
  }

  /** A JSON-RPC request to the harness failed (Codex): which, and its code. */
  rpcFailed(method: string, code: number) {
    this.t.emit('harness.rpc_failed', { ...(this.turn ? this.fields(this.turn) : {}), data: { method, error_code: code } });
  }

  /** Codex's loopback refused a peer, or took over 5 ms to attest one (loopback.ts). */
  peerChecked({ ms, ...c }: { ok: boolean; code?: string; ms: number; pids?: number; fds?: number }) {
    this.t.emit('harness.peer_check', { ...(this.turn ? this.fields(this.turn) : {}), duration_ms: ms, data: c });
  }

  /** A "Thinking…" card was shown (thinking.ts): the turn has something to render. */
  thinkingShown() {
    if (this.turn) this.t.emit('thinking.shown', this.fields(this.turn));
  }

  /** The harness process went away; the next one reports its start again. */
  harnessEnded() {
    this.harnessUp = false;
  }

  /** Session's endTurn: `silent` is the stayed-silent branch, `failure` the result subtype. */
  ended(silent: boolean, failure?: string) {
    const turn = this.turn;
    if (!turn) return void this.closing.push(undefined); // each ended() is paired with one closed()
    let outcome: TurnOutcome = 'completed';
    let error: ErrorType | undefined;
    if (silent) outcome = 'silent';
    else if (this.crashed) (outcome = 'failed'), (error = 'harness_crash');
    // Claude Code ends a stopped turn and some failed ones alike: it was stopped if this runner stopped it.
    else if (failure === 'error_during_execution' && this.ending) outcome = this.ending;
    else if (failure === 'interrupted') outcome = this.ending ?? 'interrupted';
    else if (failure) (outcome = 'failed'), (error = 'harness_error');
    const r = this.result;
    const u = r?.usage;
    this.t.emit('turn.ended', {
      ...this.fields(turn),
      outcome,
      error_type: error,
      error_code: failure,
      data: {
        input_tokens: u?.input ?? 0,
        output_tokens: u?.output ?? 0,
        cache_read_tokens: u?.cacheRead ?? 0,
        cache_creation_tokens: u?.cacheWrite ?? 0,
        ...(r?.apiMs !== undefined ? { api_ms: r.apiMs } : {}),
        // The harness's running total for this process; `turn_seq` 1 marks a new process.
        ...(r?.costTotalUsd !== undefined ? { cost_total_usd: r.costTotalUsd } : {}),
      },
    });
    this.closing.push(turn);
    this.turn = undefined;
    this.kinds.clear(); // results that never came (an interrupted turn)
    this.open.clear();
    this.ending = undefined;
    this.crashed = false;
    this.result = undefined;
    this.queue.unshift(...this.steers.splice(0));
    if (this.queue.length) this.begin();
  }

  /** Claude Code compacted the conversation (compaction.ts): the turn it paused, if any; a fork's (shadow.ts) belongs to none. */
  compacted({ duration_ms, between_turns, ...data }: CompactionFact) {
    const turn = between_turns ? undefined : this.turn;
    this.t.emit('context.compacted', { ...(turn ? this.fields(turn) : {}), duration_ms, data });
  }

  /** Session finished one turn's end-of-turn work (final flush, footer, status), in the order the turns ended. */
  closed() {
    const turn = this.closing.shift();
    if (turn) this.t.emit('turn.closed', this.fields(turn));
  }

  // ---------------------------------------------------------------- what the harness and Slack say

  /** Every harness record (a subagent's tool calls carry `parent`; its stream and results never arrive). */
  event(e: HarnessEvent) {
    switch (e.t) {
      // Claude Code repeats its `session` record every turn; the first one stands in when the handshake wasn't reported.
      case 'session':
        return this.harnessStarted(e.startup);
      case 'turn_ended':
        this.result = e;
        return;
      case 'request':
        if (e.phase !== 'start') this.onStream(e);
        return;
      case 'block':
      case 'live':
        return this.onStream(e);
      case 'tool':
        // What each Bash call was for (command-kinds.ts), reported with its result.
        if (!e.parent && e.name === 'Bash') this.kinds.set(e.id, commandKinds((e.input as { command?: unknown } | undefined)?.command));
        return;
      case 'tool_result':
        return this.onToolResult(e.id, e.ok);
    }
  }

  /**
   * A file landed in the thread (send_file, or a script's `calvin-send-file`).
   * With exactly one tool call running, the file names it: the call that
   * rendered and posted. The `visuals` pipe ends an episode here (work 063).
   */
  filePosted(p: { kind: string; bytes: number; source: string }) {
    const turn = this.turn ?? this.closing[0];
    if (!turn) return;
    const [call, second] = this.open;
    this.t.emit('file.posted', {
      ...this.fields(turn),
      ...(call && !second ? { tool_call_id: call } : {}),
      data: { kind: p.kind, bytes: p.bytes, source: p.source },
    });
  }

  /** A copy of Calvin's own prompt was withheld (prompt-guard.ts): how many words, and where it was caught. */
  promptWithheld(words: number, where: 'stream' | 'slack') {
    const turn = this.turn ?? this.closing[0];
    this.t.emit('prompt.withheld', { ...(turn ? this.fields(turn) : {}), data: { words, where } });
  }

  /** Every frontend call, with its own duration: visible writes are what the person saw and when. */
  surfaceCall(c: SurfaceCall) {
    const turn = this.turn ?? this.closing[0];
    this.t.emit('surface.call', {
      ...(turn ? this.fields(turn) : {}),
      duration_ms: c.ms,
      outcome: c.ok ? 'completed' : 'failed',
      error_type: c.ok ? undefined : c.rateLimited ? 'surface_rate_limited' : 'surface_error',
      error_code: c.error,
      data: {
        method: c.method,
        status: c.ok ? 'ok' : 'error',
        rate_limited: !!c.rateLimited,
        ...(c.placeholder ? { placeholder: true } : {}),
        ...(c.queuedMs !== undefined ? { queued_ms: c.queuedMs } : {}),
        ...(c.retryAfterS ? { retry_after_s: c.retryAfterS } : {}),
      },
    });
  }

  /** A window of the runner's event-loop delay (loop-lag.ts); only while a turn is open or closing, when a late loop is a late reply. */
  loopLag(l: LoopLag) {
    const turn = this.turn ?? this.closing[0];
    if (!turn) return;
    this.t.emit('loop.lag', { ...this.fields(turn), data: { max_ms: l.maxMs, mean_ms: l.meanMs, window_ms: l.windowMs } });
  }

  // ---------------------------------------------------------------- internals

  private begin() {
    const trace = this.queue.shift();
    const now = this.wall();
    const turn: Turn = { id: uuidv7(now), seq: ++this.seq, trace, sentAt: trace?.sentAt ?? now };
    this.turn = turn;
    const clients = this.ctx.apiClients?.();
    const api = clients !== undefined; // splits K1-K6 by protocol and attached clients (Q1)
    this.t.emit('turn.started', { ...this.fields(turn), data: { turn_seq: turn.seq, host_protocol: api ? 4 : 3, api, api_clients: clients ?? 0 } });
  }

  /** Model output: a turn is open from here on. */
  private onStream(e: Extract<HarnessEvent, { t: 'request' | 'block' | 'live' }>) {
    // Output with no turn open: the harness started one on its own; report it without a trace.
    if (!this.turn) (this.queue.unshift(undefined), this.begin());
    const turn = this.turn!;
    if (e.t === 'request') {
      const u = e.usage;
      // Usage known only at a response's end (Codex) comes with its end.
      if (e.phase === 'end')
        return this.t.emit('model.response_ended', {
          ...this.fields(turn),
          data: u ? { input_tokens: u.input, output_tokens: u.output ?? 0, cache_read_tokens: u.cacheRead ?? 0, cache_creation_tokens: u.cacheWrite ?? 0 } : {},
        });
      this.t.emit('model.response_started', {
        ...this.fields(turn),
        data: { input_tokens: u?.input ?? 0, cache_read_tokens: u?.cacheRead ?? 0, cache_creation_tokens: u?.cacheWrite ?? 0 },
      });
      return;
    }
    if (e.t !== 'block') return;
    // `index` where the provider numbers its blocks (Anthropic); a Codex item has only its id.
    const at = e.index !== undefined ? { index: e.index } : {};
    if (e.phase === 'end') return this.t.emit('model.block_stopped', { ...this.fields(turn), data: at });
    const tool = e.kind === 'tool';
    if (tool) this.open.add(e.id);
    this.t.emit('model.block_started', {
      ...this.fields(turn),
      ...(tool && e.name ? { tool_call_id: e.id, tool_name: e.name, capability: capabilityOf(e.name) } : {}),
      // A block that is neither a tool call nor thinking has always been reported as text.
      data: { ...at, kind: tool ? 'tool' : e.kind === 'thinking' ? 'thinking' : 'text', hidden: tool && !!e.name && HIDDEN_TOOLS.has(e.name) },
    });
  }

  /** A tool result went back to the model, and with it every steer waiting for one. */
  private onToolResult(id: string, ok: boolean) {
    const turn = this.turn;
    if (!turn) return;
    this.steers = [];
    const kinds = this.kinds.get(id);
    this.kinds.delete(id);
    this.open.delete(id);
    this.t.emit('tool.completed', {
      ...this.fields(turn),
      tool_call_id: id,
      outcome: ok ? 'completed' : 'failed',
      data: { is_error: !ok, ...(kinds && { command_kinds: kinds.join(',') }) },
    });
  }

  /** Identity plus the model dimensions in effect. */
  private fields(turn: Turn) {
    const model = this.ctx.model();
    return {
      ...traceFields(turn.trace),
      trace_id: turn.trace?.id ?? turn.id,
      turn_id: turn.id,
      sent_at: tbTime(turn.sentAt),
      ...(this.ctx.provider() ? { provider: this.ctx.provider() } : {}),
      ...(model ? { model, tier: this.ctx.tierOf(model) ?? 'custom' } : {}),
    };
  }
}

export function capabilityOf(tool: string): Capability {
  if (tool.startsWith('mcp__')) return 'mcp';
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell') return 'exec';
  if (tool === 'Read' || tool === 'NotebookRead') return 'read';
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return 'edit';
  if (tool === 'Grep' || tool === 'Glob' || tool === 'WebSearch' || tool === 'WebFetch' || tool === 'ToolSearch') return 'search';
  if (tool === 'Task' || tool === 'Agent') return 'agent';
  return 'other';
}

function traceFields(trace?: TraceContext) {
  if (!trace) return {};
  return {
    trace_id: trace.id,
    synthetic: !!trace.synthetic,
    sent_at: tbTime(trace.sentAt),
    surface: trace.surface,
    surface_workspace_id: trace.surfaceWorkspaceId,
    conversation_id: trace.conversationId,
    person_id: trace.personId,
    ...(trace.gatewaySessionId ? { gateway_session_id: trace.gatewaySessionId } : {}),
    ...(trace.path ? { path: trace.path } : {}),
  };
}
