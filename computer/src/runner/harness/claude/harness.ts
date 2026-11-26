// Claude Code behind the seam (../types.ts): one Agent SDK query per harness,
// its messages translated to records (translate.ts), its controls as effects.
// A spare runner's parked process (work 069) and the fork compaction
// (shadow.ts) are Claude's own and stay in this folder.
//
// Invariants:
// - the process lives exactly as long as its scope: the scope's one
//   finalizer closes the query, and nothing else here does;
// - a harness and its hooks share one Translator, so what a hook reports
//   (the compaction summary) is a record in the same stream, in order;
// - Calvin's modes and efforts are Claude Code's names (protocol.ts), which
//   the assertions below keep true; Codex's `ultra` reaches Claude Code as `max`.

import type { EffortLevel as SdkEffort, PermissionMode as SdkMode, Query, SDKUserMessage, SpareProcess } from '@anthropic-ai/claude-agent-sdk';
import { Effect, Scope, Stream } from 'effect';
import { log } from '../../../log.js';
import { userContent } from '../../attachments.js';
import { ensureSkills } from '../../skills.js';
import { calvinServer } from './mcp.js';
import {
  type Admission,
  type CalvinTools,
  type Capabilities,
  type CompactorHost,
  type Effort,
  type Gate,
  type Harness,
  type HarnessEvent,
  HarnessFailed,
  type HarnessKind,
  type Input,
  type Mode,
  type ModelInfo,
  type Running,
  type Speed,
  type StartSpec,
} from '../types.js';
import { claudeGate } from './gate.js';
import { compactionHooks } from './hooks.js';
import { Inbox } from './inbox.js';
import { type ClaimSpec, claimHarness, type HarnessSpec, prewarmHarness, startHarness } from './process.js';
import { ShadowCompaction, type ShadowHost } from './shadow.js';
import { Translator } from './translate.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ModesAreClaudes = Assert<Same<Mode, SdkMode>>;
export type EffortsAreClaudes = Assert<Same<Exclude<Effort, 'ultra'>, SdkEffort>>;
/** Calvin's effort as Claude Code's: `ultra` (Codex's) is Claude's `max`. */
const claudeEffort = (e: Effort): SdkEffort => (e === 'ultra' ? 'max' : e);

export const CLAUDE_CAPS: Capabilities = {
  prewarm: true,
  steer: true,
  compact: true,
  subagents: true,
  stopTask: true,
  thinking: true,
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  modes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
  costUsd: true,
  hooks: true,
};

const asError = (e: unknown) => e as Error;

class ClaudeHarness implements Harness {
  readonly id = 'claude' as const;
  readonly caps = CLAUDE_CAPS;
  readonly events: Stream.Stream<HarnessEvent, HarnessFailed>;
  readonly ready: Effect.Effect<void, HarnessFailed>;
  readonly interrupt: Effect.Effect<void>;
  readonly models: Effect.Effect<ModelInfo[], Error>;

  constructor(
    private q: Query,
    private inbox: Inbox,
    t: Translator,
  ) {
    this.events = Stream.fromAsyncIterable(q, (e) => new HarnessFailed({ reason: 'exit', message: (e as Error)?.message ?? String(e) })).pipe(
      Stream.map((m) => t.translate(m)),
      Stream.flattenIterable,
    );
    this.ready = Effect.tryPromise({
      try: () => q.initializationResult(),
      catch: (e) => new HarnessFailed({ reason: 'exit', message: (e as Error)?.message ?? String(e) }),
    }).pipe(Effect.asVoid);
    this.interrupt = Effect.promise(() => q.interrupt().catch((e) => log.warn('interrupt', e)));
    this.models = Effect.tryPromise({ try: () => q.supportedModels(), catch: asError }).pipe(
      Effect.map((ms) => ms.map((m) => ({ id: m.value, label: m.displayName }))),
    );
  }

  send(input: Input, how: Admission): Effect.Effect<void> {
    return Effect.sync(() =>
      this.inbox.push({
        type: 'user',
        message: { role: 'user', content: userContent(input.text, input.attachments) },
        parent_tool_use_id: null,
        // A steer lands at the next tool boundary, like Claude Code's queue.
        ...(how === 'steer' ? { priority: 'next' as const } : {}),
      } as SDKUserMessage),
    );
  }

  setModel(model: string) {
    return Effect.tryPromise({ try: () => this.q.setModel(model), catch: asError });
  }

  setMode(mode: Mode) {
    return Effect.tryPromise({ try: () => this.q.setPermissionMode(mode), catch: asError });
  }

  setEffort(effort: Effort) {
    return Effect.tryPromise({ try: () => this.q.applyFlagSettings({ effortLevel: claudeEffort(effort) }), catch: asError });
  }

  setSpeed(speed: Speed) {
    return Effect.tryPromise({ try: () => this.q.applyFlagSettings({ fastMode: speed !== 'standard' }), catch: asError });
  }

  stopTask(id: string) {
    return Effect.tryPromise({ try: () => this.q.stopTask(id), catch: asError });
  }
}

/** `q` as a running harness: closing its scope closes the query. */
function running(q: Query, inbox: Inbox, t: Translator): Running {
  const scope = Effect.runSync(Scope.make());
  Effect.runSync(Scope.addFinalizer(scope, Effect.sync(() => q.close())));
  return { harness: new ClaudeHarness(q, inbox, t), scope };
}

/** The process options for `spec`, with the hooks reporting through `t`. */
function processSpec(spec: StartSpec, t: Translator): HarnessSpec {
  ensureSkills(spec.cwd); // project skills must be on disk before the harness scans them
  return {
    cwd: spec.cwd,
    sdkSessionId: spec.resume,
    mode: spec.mode,
    model: spec.model,
    effort: claudeEffort(spec.effort),
    fast: spec.speed !== 'standard',
    canUseTool: claudeGate(spec.gate),
    calvin: calvinServer(spec.tools),
    hooks: compactionHooks((chars) => t.summarized(chars)),
  };
}

/** The fork compaction's view of a session: forks start with the session's options and are adopted as running harnesses. */
function shadowHost(host: CompactorHost): ShadowHost {
  const forks = new WeakMap<Query, Translator>();
  return {
    get info() {
      return host.info;
    },
    get isBusy() {
      return host.isBusy;
    },
    get openPrompt() {
      return host.openPrompt;
    },
    get hooks() {
      return host.hooks;
    },
    harness(inbox, extra) {
      const t = new Translator();
      const q = startHarness(inbox, { ...processSpec(host.spec(), t), ...extra });
      forks.set(q, t);
      return q;
    },
    adopt: (q, inbox, id, ctx) => {
      const t = forks.get(q) ?? new Translator();
      t.dropHeld();
      host.adopt(running(q, inbox, t), id, ctx);
    },
    setStatus: (s) => host.setStatus(s),
  };
}

export const claude: HarnessKind = {
  id: 'claude',
  caps: CLAUDE_CAPS,
  start(spec) {
    const t = new Translator();
    const inbox = new Inbox();
    return running(startHarness(inbox, processSpec(spec, t)), inbox, t);
  },
  compactor: (host) => new ShadowCompaction(shadowHost(host)),
};

/**
 * A spare runner's Claude Code (work 069): parked with what a session's would
 * start with, every per-session part reaching the session late-bound through
 * `late`, then claimed as that session's harness.
 */
export function claudeSpare(late: { gate: Gate; tools: CalvinTools }) {
  const t = new Translator();
  return {
    prewarm: () =>
      prewarmHarness({
        canUseTool: claudeGate(late.gate),
        calvin: calvinServer(late.tools),
        hooks: compactionHooks((chars) => t.summarized(chars)),
      }),
    /** The parked process as the session's harness; `p.claimed` says whether it took. */
    claim(p: SpareProcess, c: Omit<ClaimSpec, 'effort' | 'fast'> & { effort: Effort; speed: Speed }): Running {
      const inbox = new Inbox();
      const { speed, ...rest } = c;
      return running(claimHarness(p, inbox, { ...rest, effort: claudeEffort(c.effort), fast: speed !== 'standard' }), inbox, t);
    },
  };
}
