// The seam between a session and the agent harness that runs its model (work
// 082): one stream of normalised records out, a few commands in. A session
// never sees a harness's own messages; Claude Code's SDK is imported only under
// harness/claude/ (scripts/boundaries.mjs), and Codex will sit beside it.
//
// Invariants:
// - `events` carries every record in the order the harness produced it, and
//   fails at most once, on the failure that ends the harness; what the model
//   or a tool did wrong is a record, never a failure; it is read once, by
//   whoever holds the harness (a second reader would split the records);
// - a harness lives exactly as long as the scope it was started in: closing
//   the scope ends the process, and `Harness` has no `close` of its own
//   (`close(run)` below is that scope's close);
// - `Live` deltas are what streams to the person and are never kept; the
//   block they belong to arrives whole as a `text` or `thinking` record at
//   its end, which is what a journal keeps.

import { Data, Effect, Exit, Scope, type Stream } from 'effect';
import type { Attachment } from '../attachments.js';
import type { CardSender } from '../post-card.js';
import type { FileSender } from '../send-file.js';
import type { SessionHooks } from '../session.js';
import type { SessionStatus } from '../thread.js';
import type { EffortLevel, HarnessName, PermissionMode, Speed } from '../../protocol.js';
import type { Naming } from './title.js';

export type HarnessId = HarnessName;

/** Calvin's permission modes, under the names sessions persist (Claude Code's); a harness maps them to its own. */
export type Mode = PermissionMode;
/** A reasoning effort, from the list in `Capabilities.effort`. */
export type Effort = EffortLevel;
export type { Speed };

export interface HarnessSessionRef {
  harness: HarnessId;
  /** Claude Code's session id; Codex's thread id. */
  id: string;
}

export interface Usage {
  input: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
}

export interface Capabilities {
  prewarm: boolean;
  steer: boolean;
  compact: boolean;
  subagents: boolean;
  stopTask: boolean;
  thinking: boolean;
  effort: Effort[];
  modes: Mode[];
  costUsd: boolean;
  hooks: boolean;
}

/** What a person sent: the text and the files fetched for it. */
export interface Input {
  text: string;
  attachments: Attachment[];
}

/**
 * How an input joins the session (design 014): after the turn, or into the
 * running turn at its next tool boundary. Replacing the turn is `interrupt`
 * and then `queue`, as Session does: `send` is synchronous (Session runs it
 * with `runSync`), and an interrupt is not.
 */
export type Admission = 'queue' | 'steer';

/** A streaming delta: shown as it comes, never kept. `id` is the block it belongs to (its `block` record's). */
export interface Live {
  t: 'live';
  kind: 'text' | 'thinking';
  id: string;
  delta: string;
}

export type BlockKind = 'text' | 'thinking' | 'tool' | 'other';

/** What a subagent (Claude's Task tool, Codex's spawned agents) is doing. */
export interface TaskRecord {
  t: 'task';
  id: string;
  state: 'started' | 'progress' | 'done' | 'failed' | 'stopped';
  title?: string;
  agentType?: string;
  background?: boolean;
  /** What it is doing now. */
  doing?: string;
  tools?: number;
  tokens?: number;
  /** Its final answer; `error` is kept only when no answer comes. */
  result?: string;
  error?: string;
  durationMs?: number;
}

/** What the model and its harness did. */
export type HarnessBody =
  /**
   * `startup`: what a harness that reports its own start-up measured (Codex), so whichever reports the start first carries it.
   * `note`: a line for the person about how the session runs (Codex: the model it runs instead of the one asked for).
   */
  | { t: 'session'; ref: HarnessSessionRef; model: string; startup?: HarnessStartup; note?: string }
  /**
   * `start`: a request went out (a harness that cannot see its own requests
   * says it when a turn starts: Session takes it as a held-over steer starting
   * one); `first_token`: its response began, with the context it carried when
   * the harness knows it then; `end`: it finished, with its usage when it is
   * known only now.
   */
  | { t: 'request'; phase: 'start' | 'first_token' | 'end'; usage?: Usage }
  /**
   * One block of output: a tool call's `id` is the call's; any other block's
   * is unique among the blocks open at once. `index` is the provider's own
   * position, where it has one (Anthropic's content-block index).
   */
  | { t: 'block'; phase: 'start' | 'end'; id: string; index?: number; kind: BlockKind; name?: string }
  | { t: 'text' | 'thinking'; delta: string }
  /** One message of the model's ended (a step); `parent` is the subagent call it belongs to. */
  | { t: 'message'; parent?: string }
  | { t: 'tool'; id: string; name: string; input: unknown; parent?: string }
  /** A tool call's input while the model writes it (partial JSON, in order), before its `tool` record; `id` is the call's. */
  | { t: 'tool_input'; id: string; delta: string }
  | { t: 'tool_result'; id: string; ok: boolean; output: string }
  | TaskRecord
  /** `start` once a compaction begins; `summary` when its summary is written; `end` at its boundary, with what it compacted. */
  | { t: 'compaction'; phase: 'start' | 'summary' | 'end'; trigger?: string; before?: number; durationMs?: number; summaryChars?: number }
  | { t: 'limit'; kind: 'rate' | 'credits' | 'context'; resetAt?: number }
  | { t: 'error'; kind: 'auth' | 'network' | 'model'; code?: string; message: string }
  /**
   * `detail` is the harness's own word for a turn that did not end `done`
   * (shown in the footer). `interrupted` only where the harness knows the
   * turn was stopped; Claude Code's `error_during_execution` is either, and
   * comes as `error` (Session and TurnEvents tell a stop by their own state).
   */
  | {
      t: 'turn_ended';
      reason: 'done' | 'interrupted' | 'error';
      detail?: string;
      usage?: Usage;
      apiMs?: number;
      /** The harness process's running total, where it reports one. */
      costTotalUsd?: number;
    };

export type HarnessEvent = HarnessBody | Live;

/** The harness's own failure: it ends `events`, exactly once. */
export class HarnessFailed extends Data.TaggedError('HarnessFailed')<{ reason: 'exit' | 'protocol'; message: string }> {}

/** How a harness process came up, for telemetry (`harness.started`); known once `ready` succeeds. */
export interface HarnessStartup {
  /** The harness's own version (Codex's, from its user agent). */
  version?: string;
  spawnMs?: number;
  initializeMs?: number;
  /** Starting or resuming its conversation. */
  threadMs?: number;
  resumed?: boolean;
}

export interface Harness {
  readonly id: HarnessId;
  readonly caps: Capabilities;
  /** Facts about its start-up, where the harness measures them (Codex); Claude Code's are in its own telemetry. */
  readonly startup?: HarnessStartup;
  /** Single-use: run it once (see the invariants). */
  readonly events: Stream.Stream<HarnessEvent, HarnessFailed>;
  /** The harness answered its start-up handshake. */
  readonly ready: Effect.Effect<void, HarnessFailed>;
  send(input: Input, how: Admission): Effect.Effect<void>;
  /** Stops the open turn; never fails (a dead harness is already interrupted). */
  readonly interrupt: Effect.Effect<void>;
  setModel(model: string): Effect.Effect<void, Error>;
  readonly models: Effect.Effect<ModelInfo[], Error>;
  setMode(mode: Mode): Effect.Effect<void, Error>;
  setEffort(effort: Effort): Effect.Effect<void, Error>;
  /** From the next request; a harness without a fast tier for the model runs at its one speed. */
  setSpeed(speed: Speed): Effect.Effect<void, Error>;
  stopTask(id: string): Effect.Effect<void, Error>;
  /** The session's title after a turn (work 093), where the harness names its own sessions (Codex). */
  name?(): Promise<Naming | undefined>;
}

/**
 * What a gated call is, so the person is asked the right way whatever the
 * harness names it: a shell command, a file edit, a plan to approve, a
 * question for the person, or any other tool.
 */
export type GateKind = 'command' | 'edit' | 'plan' | 'question' | 'tool';

/**
 * A tool call waiting on the gate. Its name and input are in the seam's tool
 * vocabulary, as `tool` records are: Claude Code's names (`Bash`, `Edit`,
 * `mcp__calvin__send_file`) and input shapes; a harness that names them
 * otherwise maps them (Codex: harness/codex/translate.ts).
 */
export interface GateAsk {
  /** The call's id, as in its `tool` record. */
  id: string;
  kind: GateKind;
  /** Aborted when the harness no longer waits for the answer. */
  signal: AbortSignal;
  /** The harness's own sentence for the ask, and a line under it. */
  title?: string;
  description?: string;
  /** Why the model wants it, where the harness says (Codex's approval `reason`). */
  reason?: string;
  /** The harness can remember an allow for the rest of the session. */
  canRemember: boolean;
}

/**
 * The gate's answer: run the call (with `updatedInput`), or not, saying why.
 * A harness that cannot rewrite a call's input (Codex) reads `updatedInput`
 * only for a question's `answers`.
 */
export type GateDecision =
  | {
      behavior: 'allow';
      updatedInput: Record<string, unknown>;
      /** Allow calls like it for the rest of the session (when `canRemember`). */
      remember?: boolean;
      /** Switch the session to this mode from here on. */
      mode?: Mode;
    }
  /** `interrupt`: and stop the turn. */
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/** May this tool call run: the person's answer, or the mode's. */
export type Gate = (name: string, input: Record<string, unknown>, ask: GateAsk) => Promise<GateDecision>;

/** A harness bound to the scope it lives in: closing `scope` ends it. */
export interface Running {
  harness: Harness;
  scope: Scope.Closeable;
}

/** End a harness: close its scope, synchronously (every harness's finalizer is). */
export function close(run: Running) {
  Effect.runSync(Scope.close(run.scope, Exit.void));
}

/** Calvin's own tools, served to the harness: what they act on and through. */
export interface CalvinTools {
  cwd: () => string;
  hooks: SessionHooks;
  sendFile: FileSender;
  postCard: CardSender;
}

/** Everything a harness is started with for one session. */
export interface StartSpec {
  cwd: string;
  /** The harness's own conversation to continue; a new one without. */
  resume?: string;
  mode: Mode;
  model: string;
  effort: Effort;
  speed: Speed;
  /** May this call run: the person's answer, or the mode's. */
  gate: Gate;
  tools: CalvinTools;
}

/** Compacting between turns, where a harness can (Claude's fork compaction). */
export interface Compactor {
  readonly running: boolean;
  /** Something arrived for the session: drop a running compaction now, synchronously. */
  cancel(): void;
  /** A turn ended with `ctx` tokens of context; `settle`: nothing may be held over into a next turn. */
  turnEnded(ctx: number, settle: boolean): void;
}

/** What a compactor needs from its session (Session implements it). */
export interface CompactorHost {
  readonly info: { cwd: string; sdkSessionId?: string };
  readonly isBusy: boolean;
  readonly openPrompt?: string;
  readonly hooks: SessionHooks;
  spec(): StartSpec;
  /** Continue on `run`, the compacted conversation `id`, with `ctx` tokens left. */
  adopt(run: Running, id: string, ctx: number): void;
  setStatus(s: SessionStatus): unknown;
}

/** A kind of harness: how one starts, and what it can do. */
export interface HarnessKind {
  readonly id: HarnessId;
  readonly caps: Capabilities;
  start(spec: StartSpec): Running;
  compactor?(host: CompactorHost): Compactor;
}
