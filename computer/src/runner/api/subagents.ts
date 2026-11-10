// A session's subagents as the API sees them (work 084, /tmp/build084/subagents.md):
// the harness's `task` records become Subagent objects, recorded when one
// starts and when it ends (`subagent.started`, `subagent.ended`), with what it
// is doing in between as `subagent.progress` deltas (frequent, never kept).
//
// Invariants:
// - a subagent keeps the turn that launched it on every event, also after that
//   turn ended (a background subagent outlives it);
// - its launching call is the newest Task/Agent call of the turn with no
//   subagent yet (Claude Code's task records do not name the call): the call's
//   nested tool calls (`parent`) carry the subagent's id;
// - it ends once: a later record for an ended subagent changes nothing;
// - a stop from the API names who stopped it; the harness's `stopped` record
//   ends it, as a stop from Slack's panel does;
// - a result over 8 KiB is kept whole on disk (`keep`, api/subagent-results.ts)
//   before its end is recorded; memory holds only what the events carry.

import { mintId } from '../../session-ids.js';
import type { Actor, Subagent } from '../../api/schema-objects.js';
import type { TaskRecord } from '../harness/types.js';

const RESULT_INLINE = 8 * 1024;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface SubagentHost {
  sessionId: string;
  /** Record a subagent event under its launching turn. */
  record(type: 'subagent.started' | 'subagent.ended', subagent: Subagent): void;
  progress(subagent: Subagent): void;
  /** Keep a result longer than the events carry, whole, before its `subagent.ended` (best effort). */
  keep(subagentId: string, result: string): void;
  /** The current turn (opened if none is) and the call that launched the subagent, if one is open. */
  launcher(): { turnId: string; callId: string | null };
  now(): number;
}

export class Subagents {
  private byTask = new Map<string, Mutable<Subagent>>();
  private byCall = new Map<string, string>();
  private stoppedBy = new Map<string, Actor>();

  constructor(private h: SubagentHost) {}

  /** The subagent a call launched, or the one a nested call (`parent`) runs in. */
  ofCall(callId: string | undefined): string | null {
    return (callId && this.byCall.get(callId)) || null;
  }

  linked(callId: string) {
    return this.byCall.has(callId);
  }

  /** The subagent as its events carry it (8 KiB of its result). */
  get(id: string): Subagent | undefined {
    for (const s of this.byTask.values()) if (s.id === id) return { ...s };
    return undefined;
  }

  /** The harness's id of a subagent (what `stopTask` takes). */
  taskOf(id: string): string | undefined {
    for (const [task, s] of this.byTask) if (s.id === id) return task;
    return undefined;
  }

  running(): Subagent[] {
    return [...this.byTask.values()].filter((s) => s.status === 'running').map((s) => ({ ...s }));
  }

  /** An API stop: who asked, for the `subagent.ended` that follows. */
  stopping(id: string, by: Actor) {
    this.stoppedBy.set(id, by);
  }

  onTask(e: TaskRecord) {
    const iso = new Date(this.h.now()).toISOString();
    let s = this.byTask.get(e.id);
    if (!s) {
      if (e.state !== 'started') return;
      const { turnId, callId } = this.h.launcher();
      s = {
        id: mintId('sa'),
        sessionId: this.h.sessionId,
        turnId,
        callId,
        name: e.title ?? 'Agent',
        agentType: e.agentType ?? null,
        background: !!e.background,
        status: 'running',
        activity: null,
        toolCalls: 0,
        tokens: 0,
        createdAt: iso,
        endedAt: null,
        durationMs: null,
        result: null,
        resultTruncated: false,
        error: null,
        stoppedBy: null,
      };
      this.byTask.set(e.id, s);
      if (callId) this.byCall.set(callId, s.id);
      return this.h.record('subagent.started', { ...s });
    }
    if (s.status !== 'running') return;
    if (e.background) s.background = true;
    if (e.tools !== undefined) s.toolCalls = Math.max(0, Math.round(e.tools));
    if (e.tokens !== undefined) s.tokens = Math.max(0, Math.round(e.tokens));
    if (e.state === 'progress' || e.state === 'started') {
      if (e.doing) s.activity = e.doing;
      return this.h.progress({ ...s });
    }
    s.status = e.state === 'done' ? 'completed' : e.state;
    s.activity = null;
    s.endedAt = iso;
    s.durationMs = Math.max(0, Math.round(e.durationMs ?? this.h.now() - Date.parse(s.createdAt)));
    const result = e.result ?? null;
    s.result = result && result.length > RESULT_INLINE ? result.slice(0, RESULT_INLINE) : result;
    s.resultTruncated = !!result && result.length > RESULT_INLINE;
    if (result && s.resultTruncated) this.h.keep(s.id, result);
    if (e.state === 'failed') s.error = { code: 'subagent_failed', message: e.error ?? 'the subagent failed' };
    if (e.state === 'stopped') s.stoppedBy = this.stoppedBy.get(s.id) ?? null;
    this.h.record('subagent.ended', { ...s });
  }
}
