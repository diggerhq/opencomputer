// The tap (work 084): what a Session does, as the API's journal records it.
// Session calls it at the four places a turn's story is decided (a message
// sent, a turn begun, a turn ended, every harness record); the tap turns that
// into `message.*`, `turn.*`, `tool.*`, `message.completed`,
// `reasoning.completed`, `usage.recorded`, `subagent.*`, `session.*` events and
// the deltas, through the session's log (src/api/session-log.ts).
//
// Invariants:
// - a turn opens where Session's opens (beginTurn: a message, or the first
//   output of a turn the harness started on its own) and ends where Session's
//   ends: exactly one `turn.started` and one ending per turn, in that order;
// - every call a turn started is settled before its ending (`tool.failed`
//   with `settledBy` the ending's type);
// - the tap never throws into the session: a failure to record is logged, and
//   Slack renders exactly as it would without it;
// - nothing here touches Slack.

import path from 'node:path';
import { log as logger, log } from '../../log.js';
import type { Actor, TurnError } from '../../api/schema-objects.js';
import type { SessionLog } from '../../api/session-log.js';
import { mintId } from '../../session-ids.js';
import { toolTitle } from '../format.js';
import type { HarnessEvent } from '../harness/types.js';
import { SILENT } from '../system-prompt.js';
import { Asks } from './asks.js';
import { PreparingCalls } from './preparing.js';
import { Subagents } from './subagents.js';

export type IfBusy = 'queue' | 'steer' | 'interrupt';

/** A message that came through the API, as Session.send passes it on. */
export interface SentFrom {
  actor: Actor;
  turnId?: string;
  ifBusy?: IfBusy;
  /** Its `message.received` is in the log already (queued, or recorded by the host's writer). */
  recorded?: boolean;
  /** The turn it interrupts, as it was when the interrupt began (the harness may end it before the message is recorded). */
  interrupts?: string;
}

/** What the tap needs from the runner. */
export interface TapHost {
  cwd(): string;
  settings(): { model: string | null; effort: string | null; mode: string; speed: string | null };
  /** A Slack user as the API names people. */
  actorOf(slackUserId: string | undefined): Actor;
  /** A turn ended (called off Session.endTurn): the api delivers what waits. */
  idle(): void;
  now?: () => number;
}

/** SessionHooks.api: what Session calls. */
export interface SessionTap {
  event(e: HarnessEvent): void;
  sent(text: string, slackUser: string | undefined, steer: boolean, from?: SentFrom): void;
  /** A message sent while prompts are open (prompts.ts replyToPrompts), declining the asks named: its `message.received` seq. */
  replied(text: string, slackUser: string | undefined, declined: string[], from?: SentFrom): number;
  began(): void;
  ended(failure?: string): void;
  readonly asks: Asks;
}

/** Inline limit of a tool's input or output in an event. */
export const TOOL_JSON_MAX = 64 * 1024;
const LAUNCHERS = new Set(['Task', 'Agent']);

interface Call {
  toolName: string;
  callId: string;
  parentCallId: string | null;
  subagentId: string | null;
  title: string;
  started: number;
  turnId: string;
}

interface OpenTurn {
  id: string;
  started: number;
  texts: string[];
  firstTokenMs: number | null;
  silent?: boolean; // the agent chose not to reply (SILENT)
  error?: Extract<HarnessEvent, { t: 'error' }>; context?: boolean;
}

const clip = (v: unknown): { value: unknown; truncated: boolean } => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length <= TOOL_JSON_MAX ? { value: v ?? null, truncated: false } : { value: s.slice(0, TOOL_JSON_MAX), truncated: true };
};
const count = (n: number | undefined) => Math.max(0, Math.round(n ?? 0));

export class Tap implements SessionTap {
  readonly asks: Asks;
  readonly subagents: Subagents;
  /** The turn running now, as the journal knows it. */
  cur?: OpenTurn;
  /** The turn the next `began` opens: a message sent while none ran, or one that interrupts the running one. */
  private next?: string;
  private calls = new Map<string, Call>();
  private blocks = new Map<string, number>(); // thinking block → its start
  private lastBlock: { text?: string; thinking?: string } = {};
  private preparing: PreparingCalls;
  private costTotal = 0;
  private usedTokens: number | null = null;
  private rateAttempt = 0;
  /** A background subagent that ended while no turn ran: the harness may start one for it. */
  private woke?: string;
  private status: string;
  private settingsNow: Record<string, string | null>;
  /** Why the running turn is being stopped, where the api asked. */
  cancelling?: 'interrupted' | 'withdrawn';
  private steers: { actor: Actor; seq: number }[] = []; // delivered to the running turn, not yet taken: `turn.steered` waits for the next request

  constructor(
    readonly log: SessionLog,
    private h: TapHost,
  ) {
    this.status = log.fold.status;
    this.settingsNow = { ...log.fold.session().settings };
    this.asks = new Asks({
      sessionId: log.sessionId,
      turnId: () => this.turnId(),
      record: (type, ask, actor) => this.append(type, { ask }, ask.turnId, actor),
      actorOf: (u) => h.actorOf(u),
      changed: (open) => this.setStatus(open ? 'waiting' : this.cur ? 'running' : 'idle'),
      now: () => this.now(),
    });
    this.subagents = new Subagents({
      sessionId: log.sessionId,
      record: (type, subagent) => {
        this.append(type, { subagent }, subagent.turnId);
        // Claude Code starts a turn of its own when a background subagent ends
        // (/tmp/build084/claude-subagent-selfstart.ndjson): that turn is the subagent's.
        if (type === 'subagent.ended' && subagent.background) this.woke = subagent.id;
      },
      keep: (id, result) => {
        try {
          this.log.journal.keepResult(id, result);
        } catch (e) {
          logger.warn(`subagent ${id}: its whole result was not kept:`, (e as Error).message);
        }
      },
      progress: (s) => this.log.delta({ type: 'subagent.progress', turnId: s.turnId, data: { subagentId: s.id, activity: s.activity, toolCalls: s.toolCalls, tokens: s.tokens } }),
      launcher: () => {
        const turnId = this.turnId();
        const call = [...this.calls.values()].reverse().find((c) => LAUNCHERS.has(c.toolName) && !this.subagents.linked(c.callId));
        return { turnId, callId: call?.callId ?? null };
      },
      now: () => this.now(),
    });
    this.preparing = new PreparingCalls(
      (data) => this.log.delta({ type: 'tool.preparing', turnId: this.cur?.id ?? null, data }),
      () => this.now(),
      (p) => (path.isAbsolute(p) ? path.relative(h.cwd(), p) || p : p),
    );
  }

  private now() {
    return this.h.now?.() ?? Date.now();
  }

  /** Append one event; returns its seq (0 when the log refused it). */
  append(type: string, data: unknown, turnId: string | null = this.cur?.id ?? null, actor: Actor | null = null): number {
    try {
      return this.log.append(type, data, { turnId, actor }).seq;
    } catch (e) {
      log.error(`journal ${type}`, e);
      return 0;
    }
  }

  setStatus(to: string) {
    if (to === this.status) return;
    this.append('session.status_changed', { from: this.status, to }, null);
    this.status = to;
  }

  /** `session.updated` for what changed since the journal last said (a Slack `!model`, or an API update). */
  syncSettings(actor: Actor | null = null): number {
    const now: Record<string, string | null> = this.h.settings();
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const k of ['model', 'effort', 'mode', 'speed']) if (now[k] !== this.settingsNow[k]) changes[k] = { from: this.settingsNow[k] ?? null, to: now[k] };
    this.settingsNow = now;
    return Object.keys(changes).length ? this.append('session.updated', { changes }, null, actor) : 0;
  }

  /** The running turn's id, opening one if none runs (an ask always belongs to a turn). */
  turnId(): string {
    if (!this.cur) this.began();
    return this.cur!.id;
  }

  // ---------------------------------------------------------------- Session's calls

  sent(text: string, slackUser: string | undefined, steer: boolean, from?: SentFrom) {
    const actor = from?.actor ?? this.h.actorOf(slackUser);
    if (steer && this.cur) {
      if (from?.recorded) return;
      const seq = this.append('message.received', { input: text, ifBusy: 'steer', delivery: 'steered', interruptedTurnIds: [], declinedAskIds: [] }, this.cur.id, actor);
      this.steers.push({ actor, seq });
      return;
    }
    const id = from?.turnId ?? mintId('tn');
    const stopping = from?.interrupts ?? this.cur?.id;
    const interrupted = stopping ? [stopping] : [];
    if (this.cur) this.cancelling ??= 'interrupted';
    if (!from?.recorded) {
      const ifBusy = from?.ifBusy ?? (interrupted.length ? 'interrupt' : 'steer');
      this.append('message.received', { input: text, ifBusy, delivery: 'started', interruptedTurnIds: interrupted, declinedAskIds: [] }, id, actor);
    }
    this.next = id;
  }

  replied(text: string, slackUser: string | undefined, declined: string[], from?: SentFrom): number {
    const actor = from?.actor ?? this.h.actorOf(slackUser);
    const data = { input: text, ifBusy: from?.ifBusy ?? 'steer', delivery: 'steered', interruptedTurnIds: [], declinedAskIds: declined };
    const seq = this.append('message.received', data, this.turnId(), actor);
    this.steers.push({ actor, seq });
    return seq;
  }

  began() {
    if (this.cur) return;
    const id = this.next ?? mintId('tn');
    const by = this.next ? undefined : this.woke;
    this.next = this.woke = undefined;
    this.syncSettings();
    this.cur = { id, started: this.now(), texts: [], firstTokenMs: null };
    const { model, effort, mode } = this.h.settings(); // speed is the session's only (session.updated), not a turn's
    this.append('turn.started', { model, effort, mode, trigger: by ? 'subagent' : 'message', subagentId: by ?? null }, id);
    this.setStatus(this.asks.openIds().length ? 'waiting' : 'running');
  }

  ended(failure?: string) {
    const t = this.cur;
    if (!t) return;
    const reason = this.cancelling;
    const cancelled = failure === 'interrupted' || (failure === 'error_during_execution' && (reason || !t.error));
    const ending = !failure ? 'turn.completed' : cancelled ? 'turn.cancelled' : 'turn.failed';
    this.settle(t.id, ending);
    if (ending === 'turn.completed')
      this.append('turn.completed', { text: t.texts.join('\n\n') || null, durationMs: count(this.now() - t.started), silent: !!t.silent }, t.id);
    else if (ending === 'turn.cancelled') this.append('turn.cancelled', { reason: reason ?? 'interrupted', forced: false, input: null }, t.id);
    else this.append('turn.failed', { error: this.failure(failure!, t) }, t.id);
    this.closeTurn();
  }

  /** The api gave up waiting for the harness to stop (10 s): the turn ends now, `forced`. */
  forceCancel(): boolean {
    const t = this.cur;
    if (!t) return false;
    this.settle(t.id, 'turn.cancelled');
    this.append('turn.cancelled', { reason: this.cancelling ?? 'interrupted', forced: true, input: null }, t.id);
    this.closeTurn();
    return true;
  }

  private closeTurn() {
    this.cur = this.cancelling = undefined;
    this.steers = []; // not taken before the turn ended: the harness starts the next turn with them
    this.preparing.clear();
    if (!this.next) this.setStatus(this.asks.openIds().length ? 'waiting' : 'idle');
    queueMicrotask(() => this.h.idle());
  }

  /** Every call the turn left open fails, settled by its ending. */
  private settle(turnId: string, ending: string) {
    for (const c of [...this.calls.values()]) {
      if (c.turnId !== turnId || (c.subagentId && this.subagents.get(c.subagentId)?.background)) continue;
      this.calls.delete(c.callId);
      this.append('tool.failed', { ...this.callData(c), message: 'the turn ended before the call did', settledBy: ending }, turnId);
    }
  }

  private failure(detail: string, t: OpenTurn): TurnError {
    if (detail === 'crashed') return { code: 'runtime_failed', message: 'the agent process ended during the turn' };
    const e = t.error;
    const message = e?.message ?? `the turn ended: ${detail}`;
    if (t.context) return { code: 'context_too_long', message };
    if (e?.kind === 'network') return { code: 'model_stream_failed', message };
    if (e?.kind === 'model') return { code: /not.?found|unavailable|overloaded/i.test(`${e.code} ${e.message}`) ? 'model_unavailable' : 'model_rejected', message };
    if (e?.kind === 'auth') return { code: 'model_rejected', message };
    return { code: 'agent_failed', message };
  }

  event(e: HarnessEvent) {
    try {
      this.record(e);
    } catch (err) {
      log.error('tap', err);
    }
  }

  private callData(c: Call) {
    return { subagentId: c.subagentId, toolName: c.toolName, callId: c.callId, parentCallId: c.parentCallId, title: c.title };
  }

  private record(e: HarnessEvent) {
    // Where Session's output() begins a turn, so does the tap (before Session's own beginTurn runs).
    if ((e.t === 'request' && e.phase !== 'start') || e.t === 'block' || e.t === 'live' || e.t === 'message') this.began();
    const t = this.cur;
    const turnId = t?.id ?? null;
    switch (e.t) {
      case 'request':
        if (e.usage) this.usedTokens = count(e.usage.input + (e.usage.cacheRead ?? 0) + (e.usage.cacheWrite ?? 0));
        if (e.phase === 'first_token' && t && t.firstTokenMs === null) t.firstTokenMs = count(this.now() - t.started);
        // Claude Code says nothing when it takes a steer in (/tmp/build084/claude-steer-signal-noreplay.ndjson): its next request carries it.
        if (e.phase === 'start' && t) for (const s of this.steers.splice(0)) this.append('turn.steered', { messageSeq: s.seq }, t.id, s.actor);
        return;
      case 'block':
        if (e.kind === 'thinking' && e.phase === 'start') this.blocks.set(e.id, this.now());
        if (e.kind === 'tool' && e.phase === 'start' && e.name) this.preparing.start(e.id, e.name);
        if (e.phase === 'end' && (e.kind === 'text' || e.kind === 'thinking')) this.lastBlock[e.kind] = e.id;
        return;
      case 'live':
        return this.log.delta({ type: e.kind === 'text' ? 'message.delta' : 'reasoning.delta', turnId, data: { blockId: e.id, parentCallId: null, text: e.delta } });
      case 'tool_input':
        return this.preparing.input(e.id, e.delta);
      case 'text': {
        const silent = e.delta.trimStart().startsWith(SILENT);
        const text = silent ? e.delta.trimStart().slice(SILENT.length).trimStart() : e.delta;
        if (t && silent && !t.texts.length) t.silent = true;
        if (!t || !text) return;
        t.silent = false;
        t.texts.push(text);
        this.append('message.completed', { blockId: this.lastBlock.text ?? mintId('ev'), parentCallId: null, text }, turnId);
        return;
      }
      case 'thinking': {
        if (!t) return;
        const id = this.lastBlock.thinking ?? mintId('ev');
        const at = this.blocks.get(id);
        this.blocks.delete(id);
        this.append('reasoning.completed', { blockId: id, parentCallId: null, text: e.delta, redacted: !e.delta, durationMs: at === undefined ? null : count(this.now() - at) }, turnId);
        return;
      }
      case 'tool': {
        this.preparing.end(e.id);
        const subagentId = this.subagents.ofCall(e.parent);
        const owner = subagentId ? this.subagents.get(subagentId)?.turnId : turnId;
        if (!owner) return;
        // A subagent's calls never report results: the one before ends when the next starts.
        if (e.parent) for (const c of this.calls.values()) if (c.parentCallId === e.parent) this.completed(c, null);
        const c: Call = { toolName: e.name, callId: e.id, parentCallId: e.parent ?? null, subagentId, title: toolTitle(e.name, e.input, this.h.cwd()), started: this.now(), turnId: owner };
        this.calls.set(e.id, c);
        const input = clip(e.input);
        this.append('tool.started', { ...this.callData(c), input: input.value, inputTruncated: input.truncated }, owner);
        return;
      }
      case 'tool_result': {
        const c = this.calls.get(e.id);
        if (!c) return;
        if (e.ok) return this.completed(c, e.output);
        this.calls.delete(c.callId);
        this.append('tool.failed', { ...this.callData(c), message: e.output.slice(0, TOOL_JSON_MAX), settledBy: null }, c.turnId);
        return;
      }
      case 'task':
        // Its open calls complete before the subagent ends.
        if (e.state !== 'started' && e.state !== 'progress') {
          const sa = [...this.calls.values()].find((c) => c.subagentId && this.subagents.taskOf(c.subagentId) === e.id);
          if (sa) for (const c of [...this.calls.values()]) if (c.subagentId === sa.subagentId) this.completed(c, null);
        }
        this.subagents.onTask(e);
        return;
      case 'limit':
        if (e.kind === 'context' && t) t.context = true;
        if (e.kind === 'rate')
          this.append('model.rate_limited', { model: this.h.settings().model, retryAfterMs: e.resetAt ? count(e.resetAt - this.now()) : null, attempt: ++this.rateAttempt }, turnId);
        return;
      case 'error':
        if (t) t.error = e;
        return;
      case 'compaction':
        if (e.phase === 'start') this.log.delta({ type: 'session.compacting', turnId, data: {} });
        if (e.phase === 'end') this.append('session.compacted', { beforeTokens: e.before ?? null, afterTokens: null, auto: e.trigger !== 'manual' }, turnId);
        return;
      case 'turn_ended': {
        this.rateAttempt = 0;
        if (!t) return;
        const u = e.usage;
        const total = e.costTotalUsd;
        const cost = total === undefined ? null : total >= this.costTotal ? total - this.costTotal : total;
        if (total !== undefined) this.costTotal = total;
        this.append('usage.recorded', {
          model: this.h.settings().model,
          inputTokens: count(u?.input),
          outputTokens: count(u?.output),
          reasoningTokens: 0,
          cachedTokens: count(u?.cacheRead),
          cacheWriteTokens: count(u?.cacheWrite),
          costUsd: cost === null ? null : String(Number(cost.toFixed(6))),
          firstTokenMs: t.firstTokenMs,
          durationMs: e.apiMs === undefined ? null : count(e.apiMs),
          usedTokens: this.usedTokens,
          windowTokens: null,
        }, t.id);
        return;
      }
    }
  }

  private completed(c: Call, output: string | null) {
    this.calls.delete(c.callId);
    const out = clip(output);
    this.append('tool.completed', { ...this.callData(c), output: out.value, outputTruncated: out.truncated, fileChanges: null, durationMs: count(this.now() - c.started) }, c.turnId);
  }
}
