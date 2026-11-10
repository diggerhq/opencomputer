// Fork compaction (work 068 1c): a long conversation is compacted between
// turns, in a copy, so no turn waits for a summary. After a turn whose last
// request carried more than `compactAt` tokens (or after 40 min idle above
// 60k), a second harness starts on a fork of the conversation
// (`resume` + `forkSession` under an id chosen here), is sent `/compact`, and
// runs under its own small loop here, never Session's `onEvent`. When it
// finishes and nothing arrived meanwhile, Session adopts it: the fork's
// harness and inbox become the session's and its id is persisted, so a
// resume lands on the compacted conversation. If anything arrives first, the
// fork is dropped and deleted and the live harness answers as if nothing ran.
//
// Measured (Claude Code 2.1.295): the live transcript is untouched by the
// fork; the fork file exists from the first moment, so a discarded fork is
// deleted by its id; `/compact` through streaming input compacts.
//
// Invariants:
// - the swap guard is JavaScript's single thread: every way into the session
//   (a message, a command, stop, a credential renewal, a permission request,
//   a turn beginning, the harness starting a request) calls `cancel()`
//   synchronously before it awaits anything, and the swap itself is
//   synchronous, so the two never interleave;
// - a turn that took a message mid-way arms no settle trigger: the harness may
//   hold that message over and start the next turn by itself, unseen until
//   its first token (measured: no echo of the held-over message, only
//   `system/status: requesting`, then 3 s to `message_start`);
// - a swap resets what the session knows (count, timers): the compacted
//   conversation is never forked again on the old count;
// - never adopted while a turn runs or a prompt is open, never more than one
//   fork, at most `perHour` attempts per hour and one per `cooldownMs`;
// - the fork's permission requests are denied until the swap (process.ts `deny`).

import { randomUUID } from 'node:crypto';
import { deleteSession, type Query } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../../log.js';
import { panels } from '../../agents.js';
import type { CompactionFact } from '../../compaction.js';
import { applyContextWindow } from '../../context-window.js';
import type { SessionStatus } from '../../thread.js';
import { Inbox } from './inbox.js';
import type { HarnessSpec } from './process.js';

export interface ShadowConfig {
  /** After a turn whose last request carried more than this, compact (0: never). */
  compactAt: number;
  /** …or after `idleMs` without a turn, above this. */
  idleAt: number;
  idleMs: number;
  /** No new attempt within this of the last one, and at most `perHour` an hour. */
  cooldownMs: number;
  perHour: number;
  /** Wait this long after a turn ends, so its end-of-turn work goes first. */
  settleMs: number;
  /** A dropped fork's transcript is deleted this long after its process was told to go, and once more after its kill deadline. */
  deleteAfterMs: [number, number];
}

export const DEFAULT_SHADOW: ShadowConfig = {
  compactAt: 120_000,
  idleAt: 60_000,
  idleMs: 40 * 60_000,
  cooldownMs: 2 * 60_000,
  perHour: 3,
  settleMs: 1_500,
  // Agent SDK close(): abort, SIGTERM 2 s later, SIGKILL 5 s after that; Claude Code flushing on SIGTERM can rewrite the file.
  deleteAfterMs: [500, 8_000],
};

/** The config for a process: SP_COMPACT_AT overrides the threshold (0 turns fork compaction off). */
export function shadowConfig(env: NodeJS.ProcessEnv): ShadowConfig {
  const at = (env.SP_COMPACT_AT ?? '').trim();
  return /^\d+$/.test(at) ? { ...DEFAULT_SHADOW, compactAt: Number(at), idleAt: Math.min(DEFAULT_SHADOW.idleAt, Number(at)) } : DEFAULT_SHADOW;
}

let config = DEFAULT_SHADOW;
/** Set where the process starts (runner/main.ts, src/main.ts, fake-run). */
export function configureShadow(c: ShadowConfig) {
  config = c;
}

/** Both compactions from the process's environment: this one (SP_COMPACT_AT) and Claude Code's backstop (SP_CONTEXT_WINDOW). */
export function configureCompaction(env: NodeJS.ProcessEnv) {
  applyContextWindow(env);
  configureShadow(shadowConfig(env));
}

export interface ShadowState {
  kind: 'turn' | 'idle';
  /** The last request's context. */
  ctxTokens: number;
  busy: boolean;
  promptOpen: boolean;
  /** Background subagents are running. */
  background: boolean;
  /** Start times of earlier attempts. */
  attempts: number[];
  now: number;
}

/** Whether to start a fork now; otherwise why not. */
export function shadowDue(c: ShadowConfig, s: ShadowState): { start: true } | { start: false; why: string } {
  if (!c.compactAt) return { start: false, why: 'off' };
  if (s.ctxTokens <= (s.kind === 'turn' ? c.compactAt : c.idleAt)) return { start: false, why: 'small' };
  if (s.busy) return { start: false, why: 'busy' };
  if (s.promptOpen) return { start: false, why: 'prompt' };
  if (s.background) return { start: false, why: 'background' };
  const recent = s.attempts.filter((t) => s.now - t < 60 * 60_000);
  if (recent.some((t) => s.now - t < c.cooldownMs)) return { start: false, why: 'cooldown' };
  if (recent.length >= c.perHour) return { start: false, why: 'hourly' };
  return { start: true };
}

/** What a fork needs from the session (Session implements it). */
export interface ShadowHost {
  readonly info: { cwd: string; sdkSessionId?: string };
  readonly isBusy: boolean;
  readonly openPrompt?: string;
  readonly hooks: { turns?: { compacted(f: CompactionFact): void } };
  /** A harness with the session's options, plus `extra`. */
  harness(inbox: Inbox, extra: Partial<HarnessSpec>): Query;
  /** Continue on `q`: its harness and inbox replace the session's, `sdkSessionId` persisted; `ctxTokens` is Claude Code's count of what is left. */
  adopt(q: Query, inbox: Inbox, sdkSessionId: string, ctxTokens: number): void;
  setStatus(s: SessionStatus): unknown;
}

interface Attempt {
  id: string;
  q: Query;
  inbox: Inbox;
  started: number;
  kind: 'turn' | 'idle';
  before: number;
  cancelled: boolean;
  deny: boolean;
}

interface Fields {
  type: string;
  subtype?: string;
  message?: { content?: unknown };
  compact_metadata?: { pre_tokens?: number; post_tokens?: number };
}

const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

export class ShadowCompaction {
  private attempts: number[] = [];
  private run?: Attempt;
  private ctx = 0;
  private settle?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;

  constructor(
    private s: ShadowHost,
    private cfg: () => ShadowConfig = () => config,
    private now: () => number = Date.now,
  ) {}

  get running() {
    return !!this.run;
  }

  /**
   * A turn is ending; `ctx` is its last request's context. Not `settle`: a
   * message went into the turn and may be held over, so the harness could be
   * starting the next turn right now, unseen until its first token (the idle
   * trigger stays, and `cancel` drops a fork the moment that turn shows).
   */
  turnEnded(ctx: number, settle = true) {
    this.ctx = ctx;
    this.clearTimers();
    const c = this.cfg();
    if (settle) this.settle = setTimeout(() => this.consider('turn'), c.settleMs);
    this.idle = setTimeout(() => this.consider('idle'), c.idleMs);
    this.settle?.unref?.();
    this.idle.unref?.();
  }

  /** Something arrived for the session: drop a running fork at once. Synchronous (the swap guard). */
  cancel() {
    this.clearTimers();
    const a = this.run;
    if (!a || a.cancelled) return;
    a.cancelled = true;
    this.run = undefined;
    log.info(`fork compaction ${a.id}: discarded`);
    void a.q.interrupt().catch(() => {});
    a.q.close();
  }

  private clearTimers() {
    clearTimeout(this.settle);
    clearTimeout(this.idle);
  }

  private consider(kind: 'turn' | 'idle') {
    if (this.run || !this.s.info.sdkSessionId) return;
    const now = this.now();
    const due = shadowDue(this.cfg(), {
      kind,
      ctxTokens: this.ctx,
      busy: this.s.isBusy,
      promptOpen: !!this.s.openPrompt,
      background: [...panels.values()].some((p) => p.running),
      attempts: this.attempts,
      now,
    });
    if (!due.start) return void (due.why !== 'small' && log.info(`fork compaction not started: ${due.why}`));
    this.attempts = [...this.attempts.filter((t) => now - t < 60 * 60_000), now];
    if (kind === 'idle') this.clearTimers();
    const inbox = new Inbox();
    const id = randomUUID();
    const a: Attempt = { id, inbox, started: now, kind, before: this.ctx, cancelled: false, deny: true, q: undefined as unknown as Query };
    a.q = this.s.harness(inbox, { forkTo: id, deny: () => a.deny });
    this.run = a;
    log.info(`fork compaction ${id}: started at ${this.ctx} tokens (${kind})`);
    void this.s.setStatus('processing'); // housekeeping: the thread shows it is working
    inbox.push({ type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null } as never);
    void this.loop(a);
  }

  /** The fork's own loop: reads up to its `/compact` result, then swaps or drops it. Never reads past the result. */
  private async loop(a: Attempt) {
    let pre: number | undefined;
    let post: number | undefined;
    let summary: number | undefined;
    try {
      for (;;) {
        const r = await a.q.next();
        if (r.done || a.cancelled) break;
        const m = r.value as unknown as Fields;
        if (m.type === 'system' && m.subtype === 'compact_boundary') (pre = m.compact_metadata?.pre_tokens), (post = m.compact_metadata?.post_tokens);
        else if (m.type === 'user' && summary === undefined) {
          const text = textOf(m.message?.content);
          if (text.startsWith(SUMMARY_PREFIX)) summary = text.length;
        } else if (m.type === 'result') {
          if (m.subtype === 'success' && pre !== undefined && !a.cancelled) return this.swap(a, pre, post, summary);
          break;
        }
      }
    } catch (e) {
      if (!a.cancelled) log.warn(`fork compaction ${a.id}:`, (e as Error)?.message ?? e);
    }
    this.drop(a, a.cancelled ? 'discarded' : 'failed', pre, post);
  }

  private swap(a: Attempt, pre: number, post?: number, summary?: number) {
    // Synchronous from here: nothing can arrive between the check and the adoption.
    if (a.cancelled || this.s.isBusy || this.s.openPrompt) {
      if (!a.cancelled) this.cancel();
      return this.drop(a, 'discarded', pre, post);
    }
    this.run = undefined;
    a.deny = false;
    // The compacted conversation is what the session has now: no idle trigger left over from the long one.
    this.clearTimers();
    this.ctx = post ?? 0;
    this.s.adopt(a.q, a.inbox, a.id, this.ctx);
    log.info(`fork compaction ${a.id}: swapped in (${pre} → ${post} tokens)`);
    void this.s.setStatus('active');
    this.report(a, 'swapped', pre, post, summary);
  }

  private drop(a: Attempt, outcome: 'discarded' | 'failed', pre?: number, post?: number) {
    if (this.run === a) this.run = undefined;
    if (!a.cancelled) {
      a.cancelled = true;
      a.q.close();
      void this.s.setStatus('active');
    }
    // The fork's process is going; its transcript goes with it, deleted again once the process is surely gone.
    for (const ms of this.cfg().deleteAfterMs) setTimeout(() => this.deleteFork(a.id, ms), ms).unref?.();
    this.report(a, outcome, pre, post);
  }

  private deleteFork(id: string, after: number) {
    deleteSession(id, { dir: this.s.info.cwd }).then(
      () => void (after > 1000 && log.info(`fork compaction ${id}: transcript rewritten after its first delete; deleted again`)),
      (e: Error) => void (!/not found/i.test(e?.message ?? '') && log.warn(`fork compaction ${id}: delete failed:`, e?.message ?? e)),
    );
  }

  private report(a: Attempt, outcome: string, pre?: number, post?: number, summary?: number) {
    this.s.hooks.turns?.compacted({
      trigger: 'shadow',
      outcome,
      reason: a.kind,
      before_tokens: pre ?? a.before,
      ...(post !== undefined ? { post_tokens: post } : {}),
      ...(summary !== undefined ? { summary_chars: summary } : {}),
      paused_turn: false,
      duration_ms: this.now() - a.started,
      between_turns: true,
    });
  }
}

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('');
  return '';
}
