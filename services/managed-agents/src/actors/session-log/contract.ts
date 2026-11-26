// The SessionLog Durable Object's contract (work 084, spec 36.2): one object per session, named by its
// `cs_` id (`logOf(env, sessionId)`). The Computer DO stores the host's journal into it and drains its
// inbox; every write to a session (Org, the Slack actor, the HTTP API) enters through `accept`; the
// HTTP API and Live read it. Implemented in durable-object.ts. Types only; nothing here runs.

import type { Access, Principal } from "../../auth/principal.js";
import type { ApiEvent, Ask, LogSummary, Subagent, SubagentProgress, Turn, TurnStatus } from "../../api-objects/objects.js";

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

/**
 * A read refused (besides `reset`): `unavailable` (`minSeq` not reached; answered at once), or `not_found` (the
 * principal may not read the session).
 */
export type LogReadRefusal =
  | { ok: false; error: "not_found" }
  | { ok: false; error: "unavailable"; lastSeq: number; retryAfterMs: number }
  | { ok: false; error: "turn_not_found" | "ask_not_found" | "subagent_not_found" | "invalid_cursor" };

export interface EventsQuery {
  /** An events cursor (spec 37.1). */
  after?: string;
  limit?: number;
  turnId?: string;
  /** Exact types, or a prefix with a trailing `*` (`tool.*`). */
  types?: string[];
  minSeq?: number;
  tailTurns?: number;
}

export type EventsPage =
  /** `cursor`: after the last event returned, or the one given when there is none. */
  | { ok: true; events: ApiEvent[]; cursor: string; lastSeq: number; hasMore: boolean; earlierTurns?: Turn[]; syncedAt: string | null }
  | EventsReset
  | LogReadRefusal;

export interface TurnsQuery {
  status?: TurnStatus[];
  limit?: number;
  cursor?: string;
  minSeq?: number;
}

export type TurnsPage = { ok: true; turns: Turn[]; nextCursor: string | null; lastSeq: number } | LogReadRefusal;

export interface TurnQuery {
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

// ------------------------------------------------------------------ SessionLog (36.2)

/** What an inbox entry asks of the session's writer; every write reaches a host this way (spec 36.3). */
export type InboxKind = "turn" | "answer" | "dismiss" | "interrupt" | "settings" | "compact" | "suspend" | "resume" | "cancel" | "stop";
export interface InboxEntry {
  id: string;
  kind: InboxKind;
  body: unknown;
  /** `by` of who sent it (spec 34.1). */
  by: string;
  /** The principal it was accepted from, less its credential: what the host records as the actor. */
  actor: { subject: string; kind: Principal["kind"]; via: Principal["via"]; admin: boolean };
  trace: string | null;
  at: number;
}
export type Inbox = { entries: InboxEntry[]; epoch: number; lastSeq: number };
export type AcceptResult =
  /** `outcome`: the entry's as `accept` returned (`waiting` unless it waited and the drain was done). */
  | { ok: true; id: string; duplicate: boolean; outcome: EntryOutcome }
  | { ok: false; code: "not_found" | "forbidden" | "idempotency_conflict" | "inbox_full" | "agent_turns" };
/** A refused entry's error as the host (or the drain) gave it: its HTTP `status` when it has one, and its other fields (`turn`, `feature`, …). */
export type EntryError = { code: string; message: string; status?: number; [field: string]: unknown };
export type DeliveredOutcome = { ok: true; result?: unknown } | ({ ok: false } & EntryError);
/** One inbox entry's outcome, whichever drain delivered it (spec 40.2 steps 4 to 6). */
export type EntryOutcome = { state: "waiting" } | { state: "delivered"; result: unknown } | { state: "refused"; error: EntryError };
/** What SessionLog publishes to Live on `events:<cs_…>` (spec 40.4). */
export type EventPush = { from: string; to: string; events: ApiEvent[] };
/** The events read's answers (spec 37.1): a page with the cursor after its last event, or `reset`. */
export type EventsReset = { ok: false; error: "reset"; cursor: string | null; seq?: number };

/** Every method of SessionLog, grouped by its caller. */
export interface SessionLogRpc {
  // ---------------------------------------------------------------- the Computer: the journal and the drain
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
  /**
   * The latest `subagent.progress` values (never journaled): kept per running subagent, not
   * persisted past an eviction (a read then shows the started/ended values), ignored for an epoch
   * other than the log's or a subagent that is not running.
   */
  progress(identity: SessionLogIdentity, epoch: number, progress: SubagentProgress[]): Promise<void>;
  /** The entries that are `waiting`, in order. */
  inbox(): Promise<Inbox>;
  delivered(id: string, outcome: DeliveredOutcome): Promise<void>;

  // ---------------------------------------------------------------- every writer (Org, the Slack actor, the HTTP API)
  /** `wait`: the drain is awaited (bounded) and `outcome` is the entry's after it; the API's writes. */
  accept(p: Principal, entry: { id: string; kind: InboxKind; body: unknown; trace?: string }, opts?: { wait?: boolean }): Promise<AcceptResult>;

  // ---------------------------------------------------------------- Org
  /** Kept only if `access.revision` is newer. */
  setAccess(access: Access): Promise<void>;
  destroy(): Promise<void>;

  // ---------------------------------------------------------------- readers (the HTTP API, Live)
  /**
   * Every read takes the reader's principal last: it answers only one that may read the session (else
   * `not_found`), and never waits (`minSeq` not reached is `unavailable` at once, with `retryAfterMs`).
   */
  summary(minSeq: number | undefined, p: Principal): Promise<{ ok: true; summary: Summary } | LogReadRefusal>;
  events(query: EventsQuery, p: Principal): Promise<EventsPage>;
  turns(query: TurnsQuery, p: Principal): Promise<TurnsPage>;
  turn(turnId: string, query: TurnQuery, p: Principal): Promise<TurnResult>;
  asks(query: AsksQuery, p: Principal): Promise<AsksPage>;
  ask(askId: string, minSeq: number | undefined, p: Principal): Promise<AskResult>;
  /**
   * Subagents (subagents.md): folded from `subagent.started`/`subagent.ended`, with the latest
   * progress (`progress`) merged in for a running one. Running first by createdAt, then ended newest first.
   */
  subagents(query: SubagentsQuery, p: Principal): Promise<SubagentsPage>;
  subagent(subagentId: string, minSeq: number | undefined, p: Principal): Promise<SubagentResult>;
  /** Live: the events cursor of the log's end; null when `p` may not read. */
  watch(p: Principal, until: number): Promise<{ head: string; machine: string } | null>;
}

/** What SessionLog hands Org (spec 35.2): today's summary and four fields. */
export interface Summary extends LogSummary {
  /** Counts changes to this summary; never reused, also across epochs. */
  revision: number;
  /** seq of the newest message.completed, ask.opened, turn.completed or turn.failed. */
  lastAgentSeq: number;
  agentTitle: string | null;
  /** The entries that are `waiting` or `refused`. `text` is the first 280 characters of a turn's input. */
  inbox: { id: string; kind: string; by: string; at: string; text: string | null; error: string | null }[];
}
