// The SessionLog Durable Object's RPC surface (work 084): one object per session, named by its
// `cs_` id (`SESSION_LOG.getByName(sessionId)`). The Computer DO is its only writer (journal
// batches from the host, recovery); the routes read it directly. Implemented in session-log.ts.

import type { ApiEvent, Ask, LogSummary, Subagent, SubagentProgress, Turn, TurnStatus } from "./api-types.js";

export interface SessionLogIdentity {
  sessionId: string;
  organizationId: string;
}

/**
 * What one stored batch cost the log (work 084 instrumentation, Q2): the Computer DO sends it as
 * that batch's `sessionlog.append` event; never per event. Spills after the commit are the log's
 * own `sessionlog.spill` event. Optional: an older log answers without it.
 */
export interface AppendStats {
  /** `store` from its checks to the commit, ms (R2 puts and refold included). */
  storeMs: number;
  /** Events stored (new seqs, or the replaced tail of a new epoch). */
  rows: number;
  /** Resent events at or below the ack, skipped. */
  dupes: number;
  /** Same seq, different id: the writer disagreed with the log. */
  mismatches: number;
  /** UTF-16 length of the stored rows' data (≈ bytes). */
  bytes: number;
  /** Data put to R2 before the commit (too big for a row), with its bytes and the time awaited. */
  syncSpills: number;
  syncSpillBytes: number;
  syncSpillMs: number;
  /** A new epoch replaced the tail and the log refolded; how long the refold took. */
  refolded: boolean;
  refoldMs: number;
  /** Rows marked to spill to R2 after the commit (their own `sessionlog.spill`). */
  spillsDue: number;
  /** The log's SQLite size after the commit. */
  storageBytes: number;
}

export type AppendResult =
  /** `ack`: the highest seq stored contiguously from 1 (the `journal-ack`). */
  | { ok: true; ack: number; summary: LogSummary; stats?: AppendStats }
  /** The batch's epoch is older than the log's: nothing stored. */
  | { ok: false; reason: "stale_epoch"; logEpoch: number; ack: number }
  /** The batch would leave a gap (its first seq > ack + 1): nothing stored; the host resends from `ack`. */
  | { ok: false; reason: "gap"; logEpoch: number; ack: number };

/**
 * What the `epoch` frame carries (recovery-fix.md): the log's epoch, its first seq, the last seq and
 * every stored event `startSeq..lastSeq` verbatim (blobs inlined), at most EPOCH_TAIL_MAX of them.
 */
export interface EpochTail {
  epoch: number;
  startSeq: number;
  lastSeq: number;
  tail: ApiEvent[];
}

export const EPOCH_TAIL_MAX = 1_000;

/** `recover`'s answer: an append's, with the new epoch's tail when it went through. */
export type RecoverResult = { ok: true; ack: number; summary: LogSummary; tail: EpochTail; stats?: AppendStats } | Extract<AppendResult, { ok: false }>;

/** A read refused: `cursor_ahead` (`after` > lastSeq) or `unavailable` (`minSeq` not reached in 2 s). */
export type LogReadRefusal =
  | { ok: false; error: "cursor_ahead"; lastSeq: number; logEpoch: number }
  | { ok: false; error: "unavailable"; lastSeq: number; retryAfterMs: number }
  | { ok: false; error: "turn_not_found" | "ask_not_found" | "subagent_not_found" | "invalid_cursor" };

export interface EventsQuery {
  after?: number;
  limit?: number;
  turnId?: string;
  /** Exact types, or a prefix with a trailing `*` (`tool.*`). */
  types?: string[];
  minSeq?: number;
  waitMs?: number;
  tailTurns?: number;
}

export type EventsPage =
  | { ok: true; events: ApiEvent[]; lastSeq: number; hasMore: boolean; earlierTurns?: Turn[]; syncedAt: string | null }
  | LogReadRefusal;

export interface TurnsQuery {
  status?: TurnStatus[];
  limit?: number;
  cursor?: string;
  minSeq?: number;
}

export type TurnsPage = { ok: true; turns: Turn[]; nextCursor: string | null; lastSeq: number } | LogReadRefusal;

export interface TurnQuery {
  waitMs?: number;
  /** With `waitMs`: return once the turn's status differs from this. Default: once it ended. */
  status?: TurnStatus;
  minSeq?: number;
}

export type TurnResult = { ok: true; turn: Turn; lastSeq: number } | LogReadRefusal;

export interface AsksQuery {
  /** `open` (default) … or `all`. */
  status?: string;
  limit?: number;
  cursor?: string;
  minSeq?: number;
}

export type AsksPage = { ok: true; asks: Ask[]; nextCursor: string | null; lastSeq: number } | LogReadRefusal;
export type AskResult = { ok: true; ask: Ask; lastSeq: number } | LogReadRefusal;

export interface SubagentsQuery {
  /** `running` (default) or `all`. */
  status?: "running" | "all";
  limit?: number;
  cursor?: string;
  minSeq?: number;
}

export type SubagentsPage = { ok: true; subagents: Subagent[]; nextCursor: string | null; lastSeq: number } | LogReadRefusal;
/** One subagent with its whole `result` (`resultTruncated: false`). */
export type SubagentResult = { ok: true; subagent: Subagent; lastSeq: number } | LogReadRefusal;

export interface RecoverInput extends SessionLogIdentity {
  /** The new epoch (the log's + 1); the DO issues it. */
  epoch: number;
  /** ISO time to stamp the recovery events with. */
  at: string;
}

export interface SessionLogRpc {
  /**
   * Store a journal batch: upsert by seq under `epoch`. An epoch higher than the log's starts a new
   * one at the batch's first seq (`epochStartSeq`), replacing anything stored at or after it.
   */
  append(identity: SessionLogIdentity, epoch: number, events: ApiEvent[]): Promise<AppendResult>;
  /**
   * The writer was lost mid-turn: record, under `epoch`, `tool.failed {settledBy}` for every open call,
   * `turn.failed {error: {code: "runtime_lost"}}` for the running turn (queued turns stay queued and
   * run on the next start), open asks closed `interrupted`, then `runtime.suspended {reason: "lost"}`
   * and `session.status_changed` to `suspended`. Seqs continue at the stored ack + 1; `epochStartSeq`
   * becomes the first of them. A log with nothing open records only the epoch bump (no events) and
   * the suspension. Returns the new summary and ack, and the new epoch's tail for the host's `epoch` frame.
   */
  recover(input: RecoverInput): Promise<RecoverResult>;
  /** The current epoch's tail (the `epoch` frame's body); null for another organization's or session's log. */
  epochTail(identity: SessionLogIdentity): Promise<EpochTail | null>;
  /** The current summary; `minSeq` waits up to 2 s, like every read. */
  summary(minSeq?: number): Promise<{ ok: true; summary: LogSummary } | LogReadRefusal>;
  events(query: EventsQuery): Promise<EventsPage>;
  turns(query: TurnsQuery): Promise<TurnsPage>;
  turn(turnId: string, query: TurnQuery): Promise<TurnResult>;
  asks(query: AsksQuery): Promise<AsksPage>;
  ask(askId: string, minSeq?: number): Promise<AskResult>;
  /**
   * Subagents (subagents.md): folded from `subagent.started`/`subagent.ended`, with the latest
   * progress (below) merged in for a running one. Running first by createdAt, then ended newest first.
   */
  subagents(query: SubagentsQuery): Promise<SubagentsPage>;
  subagent(subagentId: string, minSeq?: number): Promise<SubagentResult>;
  /**
   * The latest `subagent.progress` values (never journaled): kept per running subagent, not
   * persisted past an eviction (a read then shows the started/ended values), ignored for an epoch
   * other than the log's or a subagent that is not running.
   */
  progress(identity: SessionLogIdentity, epoch: number, progress: SubagentProgress[]): Promise<void>;
}
