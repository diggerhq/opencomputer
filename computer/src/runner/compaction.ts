// Claude Code compacting the conversation (work 068 §1): what it is told to
// keep, the card that names the pause in the thread, and the fact reported.
//
// Measured on Claude Code 2.1.295 in SDK mode: an auto-compaction runs when a
// request would cross the window (context-window.ts), which is usually right
// after a push, so the turn waits for the summary (22–36 s in tests). The
// stream says `system/status: compacting` (repeated every 30 s), then a
// `system/compact_boundary` with `pre_tokens`, and the next request's
// `message_start` carries the compacted context. `precomputeCompactionEnabled`
// (harness/claude/process.ts) is gated by a server-side flag and did nothing observable.
//
// Invariants: Session feeds every harness record to `observe` and nothing
// else here reads the stream; the card goes only into a turn that is running
// (an idle compaction gets the fact, not a message); one compaction at a time.
// What the harness is told to keep is its own (harness/claude/hooks.ts).

import { randomUUID } from 'node:crypto';
import type { DataOf } from '../telemetry/catalog.js';
import { fmtDuration } from './format.js';
import type { HarnessEvent } from './harness/types.js';
import type { TaskSink } from './thinking.js';

export type CompactionFact = DataOf<'context.compacted'> & {
  duration_ms: number;
  /** Ran between turns (a fork): never stamped with a turn that may have begun since. */
  between_turns?: true;
};

/** Where the card goes (the session's timeline); its run is closed on both sides, so it stands as its own card. */
export interface CompactionSink extends TaskSink {
  closeRun(): void;
}

interface Active {
  id: string;
  started: number;
  /** A turn was running (or a message waiting) when it started: the person waited. */
  paused: boolean;
  trigger?: string;
  before?: number;
  summaryChars?: number;
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export class Compaction {
  private active?: Active;

  constructor(
    private sink: CompactionSink,
    private report: (f: CompactionFact) => void,
    /** Session's turn is running: the card has a message to go into. */
    private busy: () => boolean,
    private now: () => number = Date.now,
  ) {}

  /** Every harness record, before Session handles it. */
  observe(e: HarnessEvent) {
    if (e.t === 'compaction') {
      if (e.phase === 'start') return this.start();
      if (e.phase === 'end') return this.boundary(e);
      if (this.active) this.active.summaryChars = e.summaryChars;
      return;
    }
    if (e.t === 'request' && e.phase === 'first_token') {
      const u = e.usage ?? { input: 0 };
      return this.finish(u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
    }
    if (e.t === 'turn_ended') this.finish();
  }

  private start() {
    if (this.active) return; // the status repeats while it runs
    const a: Active = { id: `compact-${randomUUID().slice(0, 8)}`, started: this.now(), paused: this.busy() };
    this.active = a;
    if (!a.paused) return;
    this.sink.closeRun(); // its own card, not a step of the tool calls before it
    this.sink.setTask({ id: a.id, title: 'Compacting the conversation…', status: 'in_progress' });
  }

  private boundary(end: { trigger?: string; before?: number; durationMs?: number }) {
    // No start seen (an older Claude Code): it started `durationMs` ago.
    if (!this.active) this.start(), (this.active!.started -= end.durationMs ?? 0);
    const a = this.active!;
    a.trigger = end.trigger;
    a.before = end.before;
  }

  /** The next request started (`after`: its context), or the turn ended without one. */
  private finish(after?: number) {
    const a = this.active;
    if (!a) return;
    this.active = undefined;
    if (a.before === undefined) {
      // It never reached the boundary (failed, or interrupted): the turn's end marks a running card.
      return;
    }
    const ms = this.now() - a.started;
    if (a.paused) {
      const tokens = after ? `${kTokens(a.before)} → ${kTokens(after)}` : kTokens(a.before);
      // Replaced whole: the running timer goes; a closed card shows its title, so the time is in it.
      this.sink.setTask({ id: a.id, title: `Compacted ${tokens} tokens in ${fmtDuration(ms)}`, status: 'complete' });
      this.sink.closeRun();
    }
    this.report({
      trigger: a.trigger ?? 'auto',
      before_tokens: a.before,
      ...(after ? { after_tokens: after } : {}),
      ...(a.summaryChars !== undefined ? { summary_chars: a.summaryChars } : {}),
      paused_turn: a.paused,
      duration_ms: ms,
    });
  }
}
