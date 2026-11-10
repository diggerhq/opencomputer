// The SessionLog Durable Object (work 084): one per computer session, named by its `cs_` id. It holds
// the API's durable copy of the session's event log, written only by the Computer DO (journal batches
// from the host, recovery), and serves every HTTP read of events, turns and asks.
//
// Invariants:
// - Single writer, fenced by the log epoch: a batch from an older epoch stores nothing; a newer epoch
//   starts at its batch's first seq (`epochStartSeq`), which replaces the old epoch's tail from there.
// - `ack` is the highest seq stored, and every seq 1..ack is stored exactly once: no gaps, no duplicates.
// - Writes run one at a time (`exclusive`): an append may await R2 before its transaction (data too big
//   to hold inline, below), and the input gate opens across that await, so a second append must not
//   interleave.
// - `turns`, `asks` and `tools` (open calls) are derived incrementally on append by session-fold.ts;
//   reads are indexed, never a refold. Only an epoch bump that truncates stored events refolds the
//   log (a computer lost mid-flush: rare).
// - Event `data` over 8 KiB of JSON lives in R2 (`sessions/<org>/<session>/events/<epoch>-<seq>.json`),
//   inlined on read, a page's blobs fetched in parallel. It is committed inline first and spilled
//   after the ack (`spill`), so an R2 round trip is never on the append's path; only data that could
//   pass SQLite's value limit (SYNC_SPILL_BYTES) is put before the transaction. A row whose spill never
//   ran (the object evicted mid-put) stays inline: still correct, just larger.
// - `subagents` is folded the same way; `subagent.progress` (never journaled) lives in memory only,
//   per running subagent, merged into reads (not into the summary `append` returns).
// - Reads take `minSeq` (wait ≤ 2 s for `ack` to reach it, else `unavailable`); `events` and `turn`
//   long-poll with `waitMs`. Waiters are in-memory promises woken by every append.

import { TelemetryBatch } from "./telemetry/batch.js";
import { gatewayTelemetry, type TelemetryEnv } from "./telemetry/gateway.js";
import { DurableObject } from "cloudflare:workers";

import { decodeCursor, encodeCursor } from "./list-cursor.js";
import type { ApiEvent, Ask, LogSummary, Subagent, SubagentProgress, Turn, TurnStatus } from "./api-types.js";
import {
  applyEvent,
  ENDED_TURN_STATUSES,
  foldEvents,
  initialFoldState,
  publicTurn,
  summarize,
  SYSTEM_ACTOR,
  type AskRecord,
  type FoldState,
  type FoldStore,
  type MemoryFoldStore,
  type OpenToolCall,
  type SubagentRecord,
  type TurnRecord,
} from "./session-fold.js";
import {
  type AppendResult,
  type AppendStats,
  type AskResult,
  type AsksPage,
  type AsksQuery,
  EPOCH_TAIL_MAX,
  type EpochTail,
  type EventsPage,
  type EventsQuery,
  type LogReadRefusal,
  type RecoverInput,
  type RecoverResult,
  type SessionLogIdentity,
  type SessionLogRpc,
  type SubagentResult,
  type SubagentsPage,
  type SubagentsQuery,
  type TurnQuery,
  type TurnResult,
  type TurnsPage,
  type TurnsQuery,
} from "./session-log-contract.js";

export interface SessionLogEnv extends TelemetryEnv {
  SESSION_LOG_BLOBS?: R2Bucket;
}

/** Event `data` whose JSON is longer than this many bytes goes to R2. */
export const INLINE_DATA_BYTES = 8 * 1024;
/** Data that may exceed this many UTF-8 bytes is put to R2 before its transaction, not spilled after. */
const SYNC_SPILL_BYTES = 1024 * 1024;
export const MIN_SEQ_WAIT_MS = 2_000;
export const UNAVAILABLE_RETRY_AFTER_MS = 500;
const MAX_WAIT_MS = 60_000;
const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 500;
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
const MAX_TAIL_TURNS = 50;
const MAX_EARLIER_TURNS = 50;
const REFOLD_PAGE = 500;

interface Meta {
  organizationId: string | null;
  sessionId: string | null;
  logEpoch: number;
  epochStartSeq: number;
  ack: number;
  syncedAt: string | null;
  state: FoldState;
  summary: LogSummary;
}

interface EventRow {
  seq: number;
  id: string;
  epoch: number;
  turn_id: string | null;
  type: string;
  created_at: string;
  actor: string | null;
  data: string | null;
  blob: string | null;
  [key: string]: SqlStorageValue;
}

type TurnRow = { seq: number; data: string; usage: string | null; [key: string]: SqlStorageValue };
type AskRow = { seq: number; data: string; [key: string]: SqlStorageValue };
type SubagentRow = { seq: number; end_seq: number | null; result_seq: number | null; data: string; [key: string]: SqlStorageValue };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  turn_id TEXT,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT,
  data TEXT,
  blob TEXT
);
CREATE INDEX IF NOT EXISTS events_turn ON events (turn_id, seq);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  usage TEXT
);
CREATE INDEX IF NOT EXISTS turns_seq ON turns (seq);
CREATE INDEX IF NOT EXISTS turns_status ON turns (status, seq);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_seq ON asks (seq);
CREATE INDEX IF NOT EXISTS asks_status ON asks (status, seq);
CREATE TABLE IF NOT EXISTS tools (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  end_seq INTEGER,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  result_seq INTEGER,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subagents_running ON subagents (status, seq);
CREATE INDEX IF NOT EXISTS subagents_ended ON subagents (end_seq);
CREATE INDEX IF NOT EXISTS subagents_seq ON subagents (seq);
CREATE TABLE IF NOT EXISTS meta (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  organization_id TEXT,
  session_id TEXT,
  log_epoch INTEGER NOT NULL,
  epoch_start_seq INTEGER NOT NULL,
  ack INTEGER NOT NULL,
  synced_at TEXT,
  state TEXT NOT NULL,
  summary TEXT NOT NULL
);
`;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** `ev_` + 16 random lowercase Crockford base32. */
export function newEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let id = "ev_";
  for (const byte of bytes) id += CROCKFORD[byte & 31];
  return id;
}

export function blobKey(organizationId: string, sessionId: string, epoch: number, seq: number): string {
  return `sessions/${organizationId}/${sessionId}/events/${epoch}-${seq}.json`;
}

function byteLength(text: string): number {
  // UTF-8 bytes ≥ UTF-16 units, and ≤ 3 per unit.
  if (text.length > INLINE_DATA_BYTES) return text.length;
  if (text.length * 3 <= INLINE_DATA_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)));

const turnOfRow = (row: TurnRow): TurnRecord => ({
  // Rows written before `trigger` existed get its defaults.
  turn: { trigger: "message", subagentId: null, ...(JSON.parse(row.data) as Partial<Turn>) } as Turn,
  seq: row.seq,
  usage: row.usage === null ? null : JSON.parse(row.usage),
});

const withSubagents = (summary: LogSummary): LogSummary => (summary.subagents ? summary : { ...summary, subagents: [] });

const subagentOfRow = (row: SubagentRow): SubagentRecord => ({
  subagent: JSON.parse(row.data) as Subagent,
  seq: row.seq,
  endSeq: row.end_seq,
  resultSeq: row.result_seq,
});

type Progress = Omit<SubagentProgress, "subagentId">;

/** The fold's store over the SQL tables, caching what a batch touches and writing it once. */
class SqlFoldStore implements FoldStore {
  private readonly turns = new Map<string, TurnRecord | null>();
  private readonly asks = new Map<string, AskRecord | null>();
  private readonly dirtyTurns = new Set<string>();
  private readonly dirtyAsks = new Set<string>();
  private readonly subagents = new Map<string, SubagentRecord | null>();
  private readonly dirtySubagents = new Set<string>();
  private readonly opened = new Map<string, OpenToolCall>();
  private readonly closed = new Set<string>();

  constructor(private readonly sql: SqlStorage) {}

  get touchedSummary() {
    return this.dirtyTurns.size > 0 || this.dirtyAsks.size > 0;
  }
  get touchedSubagents() {
    return this.dirtySubagents.size > 0;
  }

  turn(id: string): TurnRecord | undefined {
    if (!this.turns.has(id)) {
      const row = this.sql.exec<TurnRow>("SELECT seq, data, usage FROM turns WHERE id = ?", id).toArray()[0];
      this.turns.set(id, row ? turnOfRow(row) : null);
    }
    return this.turns.get(id) ?? undefined;
  }
  putTurn(record: TurnRecord) {
    this.turns.set(record.turn.id, record);
    this.dirtyTurns.add(record.turn.id);
  }
  ask(id: string): AskRecord | undefined {
    if (!this.asks.has(id)) {
      const row = this.sql.exec<AskRow>("SELECT seq, data FROM asks WHERE id = ?", id).toArray()[0];
      this.asks.set(id, row ? { ask: JSON.parse(row.data) as Ask, seq: row.seq } : null);
    }
    return this.asks.get(id) ?? undefined;
  }
  putAsk(record: AskRecord) {
    this.asks.set(record.ask.id, record);
    this.dirtyAsks.add(record.ask.id);
  }
  subagent(id: string): SubagentRecord | undefined {
    if (!this.subagents.has(id)) {
      const row = this.sql.exec<SubagentRow>("SELECT seq, end_seq, result_seq, data FROM subagents WHERE id = ?", id).toArray()[0];
      this.subagents.set(id, row ? subagentOfRow(row) : null);
    }
    return this.subagents.get(id) ?? undefined;
  }
  putSubagent(record: SubagentRecord) {
    this.subagents.set(record.subagent.id, record);
    this.dirtySubagents.add(record.subagent.id);
  }
  openTool(call: OpenToolCall) {
    this.closed.delete(call.callId);
    this.opened.set(call.callId, call);
  }
  closeTool(callId: string) {
    this.opened.delete(callId);
    this.closed.add(callId);
  }

  flush() {
    for (const id of this.dirtyTurns) {
      const r = this.turns.get(id);
      if (!r) continue;
      this.sql.exec(
        "INSERT OR REPLACE INTO turns (id, seq, status, data, usage) VALUES (?, ?, ?, ?, ?)",
        id,
        r.seq,
        r.turn.status,
        JSON.stringify(r.turn),
        r.usage === null ? null : JSON.stringify(r.usage),
      );
    }
    for (const id of this.dirtyAsks) {
      const r = this.asks.get(id);
      if (!r) continue;
      this.sql.exec("INSERT OR REPLACE INTO asks (id, seq, status, data) VALUES (?, ?, ?, ?)", id, r.seq, r.ask.status, JSON.stringify(r.ask));
    }
    for (const id of this.dirtySubagents) {
      const r = this.subagents.get(id);
      if (!r) continue;
      this.sql.exec(
        "INSERT OR REPLACE INTO subagents (id, seq, end_seq, created_at, status, result_seq, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        r.seq,
        r.endSeq,
        r.subagent.createdAt,
        r.subagent.status,
        r.resultSeq,
        JSON.stringify(r.subagent),
      );
    }
    for (const callId of this.closed) this.sql.exec("DELETE FROM tools WHERE call_id = ?", callId);
    for (const call of this.opened.values()) {
      this.sql.exec("INSERT OR REPLACE INTO tools (call_id, turn_id, seq, data) VALUES (?, ?, ?, ?)", call.callId, call.turnId, call.seq, JSON.stringify(call));
    }
  }
}

interface PreparedRow {
  event: ApiEvent;
  actor: string | null;
  data: string | null;
  blob: string | null;
  /** Committed inline, to move to R2 at this key after the transaction. */
  spill: string | null;
}

export class SessionLogDurableObject extends DurableObject<SessionLogEnv> implements SessionLogRpc {
  /** How long a read with `minSeq` waits for the log to reach it. A knob for tests. */
  minSeqWaitMs = MIN_SEQ_WAIT_MS;

  private readonly sql: SqlStorage;
  private meta!: Meta;
  private writing: Promise<unknown> = Promise.resolve();
  /** Spills in flight (tests await it). */
  spilling: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Set<() => void>();
  /** The latest `subagent.progress` per running subagent: in memory only (never journaled). */
  private readonly progressById = new Map<string, Progress>();
  /** Spills after the commit that finished since the last append result (work 084 instrumentation). */

  constructor(ctx: DurableObjectState, env: SessionLogEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      this.meta = this.loadMeta();
    });
  }

  // ---- writes ---------------------------------------------------------------------------------

  async append(identity: SessionLogIdentity, epoch: number, events: ApiEvent[]): Promise<AppendResult> {
    return this.exclusive(() => {
      this.claim(identity);
      return this.store(epoch, events);
    });
  }

  async recover(input: RecoverInput): Promise<RecoverResult> {
    return this.exclusive(async (): Promise<RecoverResult> => {
      this.claim(input);
      const m = this.meta;
      if (input.epoch !== m.logEpoch + 1) return { ok: false, reason: "stale_epoch", logEpoch: m.logEpoch, ack: m.ack };
      const result = await this.store(input.epoch, this.recoveryEvents(input));
      return result.ok ? { ...result, tail: await this.tailOf() } : result;
    });
  }

  async epochTail(identity: SessionLogIdentity): Promise<EpochTail | null> {
    // After the writes queued before it, so the tail is never older than an ack already sent.
    return this.exclusive(async () => {
      const m = this.meta;
      if (m.organizationId !== identity.organizationId || m.sessionId !== identity.sessionId) return null;
      return this.tailOf();
    });
  }

  /** The current epoch's events, `epochStartSeq..ack`, verbatim (EPOCH_TAIL_MAX at most). */
  private async tailOf(): Promise<EpochTail> {
    const m = this.meta;
    const rows = this.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?", m.epochStartSeq, m.ack, EPOCH_TAIL_MAX)
      .toArray();
    return { epoch: m.logEpoch, startSeq: m.epochStartSeq, lastSeq: m.ack, tail: await this.inflate(rows) };
  }

  async progress(identity: SessionLogIdentity, epoch: number, progress: SubagentProgress[]): Promise<void> {
    const m = this.meta;
    if (m.organizationId !== identity.organizationId || m.sessionId !== identity.sessionId || epoch !== m.logEpoch) return;
    const running = new Set(m.summary.subagents.map((s) => s.id));
    for (const p of progress) {
      if (!running.has(p.subagentId)) continue;
      this.progressById.set(p.subagentId, { activity: p.activity, toolCalls: p.toolCalls, tokens: p.tokens });
    }
  }

  private recoveryEvents(input: RecoverInput): ApiEvent[] {
    const tools = this.sql.exec<{ data: string }>("SELECT data FROM tools ORDER BY seq").toArray().map((r) => JSON.parse(r.data) as OpenToolCall);
    const running = this.sql
      .exec<TurnRow>("SELECT seq, data, usage FROM turns WHERE status IN ('running', 'cancelling') ORDER BY seq")
      .toArray()
      .map((r) => turnOfRow(r).turn);
    const asks = this.sql.exec<AskRow>("SELECT seq, data FROM asks WHERE status = 'open' ORDER BY seq").toArray().map((r) => JSON.parse(r.data) as Ask);
    const subagents = this.runningSubagents().map((s) => this.withProgress(s));

    const out: ApiEvent[] = [];
    let seq = this.meta.ack;
    const push = (type: string, turnId: string | null, data: unknown) =>
      out.push({ id: newEventId(), seq: ++seq, createdAt: input.at, sessionId: input.sessionId, turnId, type, actor: SYSTEM_ACTOR, data });
    const failTool = (call: OpenToolCall, settledBy: string) =>
      push("tool.failed", call.turnId, {
        toolName: call.toolName,
        callId: call.callId,
        parentCallId: call.parentCallId,
        title: call.title,
        message: "The computer running this call was lost.",
        settledBy,
      });
    const closeAsk = (ask: Ask) => push("ask.closed", ask.turnId || null, { ask: { ...ask, status: "interrupted", closedAt: input.at, closedBy: null } });
    const at = Date.parse(input.at);
    const endSubagent = (sa: Subagent) =>
      push("subagent.ended", sa.turnId || null, {
        subagent: {
          ...sa,
          status: "failed",
          activity: null,
          endedAt: input.at,
          durationMs: Math.max(0, at - Date.parse(sa.createdAt)) || 0,
          result: null,
          resultTruncated: false,
          error: { code: "runtime_lost", message: "The computer running this subagent was lost." },
          stoppedBy: null,
        },
      });

    // Per turn: its open calls, its open asks, its foreground subagents, then its ending, last (nothing follows a turn's end).
    const settled = new Set<string>();
    for (const turn of running) {
      for (const call of tools) {
        if (call.turnId !== turn.id) continue;
        failTool(call, "turn.failed");
        settled.add(call.callId);
      }
      for (const ask of asks) {
        if (ask.turnId !== turn.id) continue;
        closeAsk(ask);
        settled.add(ask.id);
      }
      for (const sa of subagents) {
        if (sa.turnId !== turn.id || sa.background) continue;
        endSubagent(sa);
        settled.add(sa.id);
      }
      push("turn.failed", turn.id, { error: { code: "runtime_lost", message: "The computer running this turn was lost." } });
    }
    for (const call of tools) if (!settled.has(call.callId)) failTool(call, "runtime.suspended");
    for (const ask of asks) if (!settled.has(ask.id)) closeAsk(ask);
    for (const sa of subagents) if (!settled.has(sa.id)) endSubagent(sa);
    push("runtime.suspended", null, { reason: "lost" });
    const status = this.meta.state.status;
    if (status !== "suspended") push("session.status_changed", null, { from: status, to: "suspended" });
    return out;
  }

  /** The append core; runs inside `exclusive`. */
  private async store(epoch: number, events: ApiEvent[]): Promise<AppendResult> {
    const began = performance.now();
    const m = this.meta;
    if (epoch < m.logEpoch) return { ok: false, reason: "stale_epoch", logEpoch: m.logEpoch, ack: m.ack };
    const gap = { ok: false, reason: "gap", logEpoch: m.logEpoch, ack: m.ack } as const;
    const first = events[0]?.seq;
    for (let i = 0; i < events.length; i++) {
      const seq = events[i]!.seq;
      if (!Number.isSafeInteger(seq) || seq < 1 || seq !== first! + i) return gap;
    }
    if (first !== undefined && first > m.ack + 1) return gap;

    const newEpoch = epoch > m.logEpoch;
    let fresh = events;
    let truncateFrom: number | null = null;
    let mismatches = 0;
    if (newEpoch) {
      if (first !== undefined && first <= m.ack) truncateFrom = first;
    } else if (first !== undefined && first <= m.ack) {
      const dupes = events.filter((e) => e.seq <= m.ack);
      mismatches = this.checkDuplicates(dupes);
      fresh = events.filter((e) => e.seq > m.ack);
    }

    const prepared = performance.now();
    const sync = { spills: 0, bytes: 0 };
    const rows = await this.prepare(epoch, fresh, sync);
    const syncSpillMs = sync.spills ? performance.now() - prepared : 0;
    const refoldAt = performance.now();
    const rebuilt = truncateFrom === null ? null : await this.refold(truncateFrom - 1);
    const refoldMs = rebuilt ? performance.now() - refoldAt : 0;
    const syncedAt = new Date().toISOString();

    this.ctx.storage.transactionSync(() => {
      let state: FoldState = structuredClone(m.state);
      let touched = false;
      if (rebuilt) {
        this.sql.exec("DELETE FROM events WHERE seq >= ?", truncateFrom);
        this.writeRebuilt(rebuilt.store);
        state = rebuilt.state;
        touched = true;
      }
      for (const r of rows) {
        const e = r.event;
        this.sql.exec(
          "INSERT OR REPLACE INTO events (seq, id, epoch, turn_id, type, created_at, actor, data, blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.seq,
          e.id,
          epoch,
          e.turnId,
          e.type,
          e.createdAt,
          r.actor,
          r.data,
          r.blob,
        );
      }
      const store = new SqlFoldStore(this.sql);
      const sessionId = m.sessionId!;
      for (const r of rows) applyEvent(state, store, sessionId, r.event);
      store.flush();
      touched ||= store.touchedSummary;
      const subagentsTouched = rebuilt !== null || store.touchedSubagents;

      const last = fresh.at(-1)?.seq;
      const ack = last ?? (truncateFrom !== null ? truncateFrom - 1 : m.ack);
      const logEpoch = newEpoch ? epoch : m.logEpoch;
      const epochStartSeq = newEpoch ? (first ?? ack + 1) : m.epochStartSeq;
      const summary = summarize(
        state,
        touched ? this.queuedTurns() : m.summary.queued,
        touched ? this.openAsks() : m.summary.asks,
        subagentsTouched ? this.runningSubagents() : m.summary.subagents,
        { lastSeq: ack, logEpoch, epochStartSeq, syncedAt },
      );
      const next: Meta = { ...m, logEpoch, epochStartSeq, ack, syncedAt, state, summary };
      this.saveMeta(next);
      this.meta = next;
      if (subagentsTouched) this.pruneProgress();
    });
    this.wake();
    this.spill(epoch, rows);
    let bytes = 0;
    for (const r of rows) bytes += r.data?.length ?? 0;
    let storageBytes = 0;
    try {
      storageBytes = this.sql.databaseSize;
    } catch {
      // Not every runtime reports it; the sample leaves it at 0.
    }
    const stats: AppendStats = {
      storeMs: performance.now() - began,
      rows: rows.length,
      dupes: events.length - fresh.length,
      mismatches,
      bytes: bytes + sync.bytes,
      syncSpills: sync.spills,
      syncSpillBytes: sync.bytes,
      syncSpillMs,
      refolded: rebuilt !== null,
      refoldMs,
      spillsDue: this.env.SESSION_LOG_BLOBS ? rows.filter((r) => r.spill !== null).length : 0,
      storageBytes,
    };
    return { ok: true, ack: this.meta.ack, summary: this.meta.summary, stats };
  }

  /** After the commit: big inline data to R2, then the row points at it (unless it was replaced meanwhile). */
  private spill(epoch: number, rows: PreparedRow[]) {
    const bucket = this.env.SESSION_LOG_BLOBS;
    const due = bucket ? rows.filter((r) => r.spill !== null) : [];
    if (due.length === 0) return;
    // One `sessionlog.spill` per batch's spills (work 084, Q2), into the object's telemetry batch after them.
    const fact = { began: performance.now(), spills: 0, bytes: 0, failed: 0, msMax: 0 };
    const run = Promise.all(
      due.map(async (r) => {
        const began = performance.now();
        try {
          await bucket!.put(r.spill!, r.data!, { httpMetadata: { contentType: "application/json" } });
          this.sql.exec("UPDATE events SET data = NULL, blob = ? WHERE seq = ? AND epoch = ? AND id = ? AND blob IS NULL", r.spill, r.event.seq, epoch, r.event.id);
          fact.spills++;
          fact.bytes += r.data!.length;
          fact.msMax = Math.max(fact.msMax, performance.now() - began);
        } catch (error) {
          fact.failed++;
          console.warn(JSON.stringify({ event: "session_log.spill_failed", sessionId: this.meta.sessionId, seq: r.event.seq, message: String(error) }));
        }
      }),
    );
    const reported = run.then(() => this.spillFact(fact));
    this.spilling = Promise.all([this.spilling, reported]);
  }

  /** The batch's spills as one `sessionlog.spill` event; never throws, never awaited by an append. */
  private spillFact(f: { began: number; spills: number; bytes: number; failed: number; msMax: number }): void {
    try {
      const m = this.meta;
      this.telemetry.emit((t) => t.emit("sessionlog.spill", {
        ...(m.sessionId ? { session_key: m.sessionId } : {}),
        ...(m.organizationId ? { org_id: m.organizationId } : {}),
        duration_ms: Math.round(performance.now() - f.began),
        outcome: f.failed ? "failed" : "completed",
        ...(f.failed ? { error_type: "unknown" as const } : {}),
        data: { spills: f.spills, spill_bytes: f.bytes, spill_ms_max: Math.round(f.msMax), failed: f.failed },
      }));
    } catch {
      // Telemetry never fails the log.
    }
  }

  /** Tests: the spill event's POST goes here instead of `fetch`. */
  telemetryFetch: typeof fetch | undefined;

  /** Spill events share one POST per window (telemetry/batch.ts), not one per batch. */
  private readonly telemetry = new TelemetryBatch({
    open: () => gatewayTelemetry(this.env, this.telemetryFetch ? { fetch: this.telemetryFetch } : {}),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
  });

  /** Same seq, same epoch, below the ack: a resend, skipped. A different id there is the writer lying. */
  private checkDuplicates(dupes: ApiEvent[]): number {
    if (dupes.length === 0) return 0;
    let mismatches = 0;
    const stored = new Map(
      this.sql
        .exec<{ seq: number; id: string }>("SELECT seq, id FROM events WHERE seq BETWEEN ? AND ?", dupes[0]!.seq, dupes.at(-1)!.seq)
        .toArray()
        .map((r) => [r.seq, r.id]),
    );
    for (const e of dupes) {
      const id = stored.get(e.seq);
      if (id !== undefined && id !== e.id) {
        mismatches++;
        console.warn(
          JSON.stringify({ event: "session_log.duplicate_mismatch", sessionId: this.meta.sessionId, seq: e.seq, stored: id, received: e.id }),
        );
      }
    }
    return mismatches;
  }

  /** Serialize the rows; data over 8 KiB is marked to spill, and only data near SQLite's limit goes to R2 first. */
  private async prepare(epoch: number, events: ApiEvent[], sync: { spills: number; bytes: number }): Promise<PreparedRow[]> {
    const bucket = this.env.SESSION_LOG_BLOBS;
    const puts: Promise<unknown>[] = [];
    const rows = events.map((event): PreparedRow => {
      const json = JSON.stringify(event.data ?? null);
      const actor = event.actor ? JSON.stringify(event.actor) : null;
      if (bucket && byteLength(json) > INLINE_DATA_BYTES) {
        const key = blobKey(this.meta.organizationId!, this.meta.sessionId!, epoch, event.seq);
        // ≤ 3 UTF-8 bytes per UTF-16 unit: below the bound it fits a SQLite value.
        if (json.length * 3 <= SYNC_SPILL_BYTES) return { event, actor, data: json, blob: null, spill: key };
        puts.push(bucket.put(key, json, { httpMetadata: { contentType: "application/json" } }));
        sync.spills++;
        sync.bytes += json.length;
        return { event, actor, data: null, blob: key, spill: null };
      }
      return { event, actor, data: json, blob: null, spill: null };
    });
    await Promise.all(puts);
    return rows;
  }

  /** Fold events 1..upTo again (an epoch bump replaced the tail after them). */
  private async refold(upTo: number) {
    const sessionId = this.meta.sessionId!;
    let folded = foldEvents(sessionId, []);
    for (let after = 0; after < upTo; ) {
      const rows = this.sql
        .exec<EventRow>("SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?", after, upTo, REFOLD_PAGE)
        .toArray();
      if (rows.length === 0) break;
      const events = await this.inflate(rows);
      folded = foldEvents(sessionId, events, {}, { state: folded.state, store: folded.store });
      after = rows.at(-1)!.seq;
    }
    return folded;
  }

  private writeRebuilt(store: MemoryFoldStore) {
    this.sql.exec("DELETE FROM turns");
    this.sql.exec("DELETE FROM asks");
    this.sql.exec("DELETE FROM tools");
    this.sql.exec("DELETE FROM subagents");
    const sql = new SqlFoldStore(this.sql);
    for (const r of store.turns.values()) sql.putTurn(r);
    for (const r of store.asks.values()) sql.putAsk(r);
    for (const c of store.tools.values()) sql.openTool(c);
    for (const r of store.subagents.values()) sql.putSubagent(r);
    sql.flush();
  }

  private claim(identity: SessionLogIdentity) {
    const m = this.meta;
    if (m.organizationId === null) {
      this.meta = { ...m, organizationId: identity.organizationId, sessionId: identity.sessionId };
      return;
    }
    if (m.organizationId !== identity.organizationId || m.sessionId !== identity.sessionId) {
      throw new Error(`session log ${m.sessionId} belongs to another organization or session`);
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writing.then(fn, fn);
    this.writing = run.catch(() => undefined);
    return run;
  }

  // ---- reads ----------------------------------------------------------------------------------

  async summary(minSeq?: number): Promise<{ ok: true; summary: LogSummary } | LogReadRefusal> {
    const refused = await this.reach(minSeq);
    if (refused) return refused;
    const summary = this.meta.summary;
    if (this.progressById.size === 0 || summary.subagents.length === 0) return { ok: true, summary };
    return { ok: true, summary: { ...summary, subagents: summary.subagents.map((s) => this.withProgress(s)) } };
  }

  async events(query: EventsQuery): Promise<EventsPage> {
    const refused = await this.reach(query.minSeq);
    if (refused) return refused;
    const after = Math.max(0, Math.floor(query.after ?? 0));
    if (after > this.meta.ack) return { ok: false, error: "cursor_ahead", lastSeq: this.meta.ack, logEpoch: this.meta.logEpoch };
    const limit = clamp(query.limit, EVENTS_DEFAULT_LIMIT, 1, EVENTS_MAX_LIMIT);
    const waitMs = clamp(query.waitMs, 0, 0, MAX_WAIT_MS);
    const tailTurns = query.tailTurns && after === 0 ? clamp(query.tailTurns, 1, 1, MAX_TAIL_TURNS) : 0;

    let from = after + 1;
    let earlierTurns: Turn[] | undefined;
    if (tailTurns) {
      const start = this.sql
        .exec<{ seq: number }>("SELECT seq FROM turns WHERE status != 'queued' ORDER BY seq DESC LIMIT 1 OFFSET ?", tailTurns - 1)
        .toArray()[0]?.seq;
      earlierTurns =
        start === undefined
          ? []
          : this.sql
              .exec<TurnRow>("SELECT seq, data, usage FROM turns WHERE seq < ? ORDER BY seq DESC LIMIT ?", start, MAX_EARLIER_TURNS)
              .toArray()
              .map((r) => publicTurn(turnOfRow(r)));
      from = start ?? 1;
    }

    const where: string[] = ["seq >= ?"];
    const params: SqlStorageValue[] = [from];
    if (query.turnId) where.push("turn_id = ?"), params.push(query.turnId);
    if (query.types?.length) {
      const exact = query.types.filter((t) => !t.endsWith("*"));
      const prefixes = query.types.filter((t) => t.endsWith("*")).map((t) => t.slice(0, -1));
      const any: string[] = [];
      if (exact.length) any.push(`type IN (${exact.map(() => "?").join(", ")})`), params.push(...exact);
      for (const p of prefixes) any.push("substr(type, 1, ?) = ?"), params.push(p.length, p);
      where.push(`(${any.join(" OR ")})`);
    }
    const statement = `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`;
    params.push(limit + 1);

    const deadline = Date.now() + waitMs;
    let seen = this.meta.ack;
    let seenEpoch = this.meta.logEpoch;
    let rows = this.sql.exec<EventRow>(statement, ...params).toArray();
    while (rows.length === 0 && waitMs > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.changed(remaining);
      // Nothing up to `seen` matched: in the same epoch look only at what arrived since, and only when
      // something did. A new epoch may have rewritten seqs ≤ seen, so it reads from `from` again.
      const sameEpoch = this.meta.logEpoch === seenEpoch;
      if (sameEpoch && this.meta.ack <= seen) continue;
      params[0] = sameEpoch ? Math.max(from, seen + 1) : from;
      seen = this.meta.ack;
      seenEpoch = this.meta.logEpoch;
      rows = this.sql.exec<EventRow>(statement, ...params).toArray();
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    const page: EventsPage = {
      ok: true,
      events: await this.inflate(rows),
      lastSeq: this.meta.ack,
      hasMore,
      syncedAt: this.meta.syncedAt,
    };
    if (earlierTurns) page.earlierTurns = earlierTurns;
    return page;
  }

  async turns(query: TurnsQuery): Promise<TurnsPage> {
    const refused = await this.reach(query.minSeq);
    if (refused) return refused;
    const limit = clamp(query.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT);
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    const filter = [...new Set(query.status ?? [])].sort().join(",");
    if (query.cursor !== undefined) {
      const before = decodeCursor("t", query.cursor, filter);
      if (before === null) return { ok: false, error: "invalid_cursor" };
      where.push("seq < ?"), params.push(before);
    }
    if (query.status?.length) where.push(`status IN (${query.status.map(() => "?").join(", ")})`), params.push(...query.status);
    params.push(limit + 1);
    const rows = this.sql
      .exec<TurnRow>(`SELECT seq, data, usage FROM turns ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...params)
      .toArray();
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      turns: page.map((r) => publicTurn(turnOfRow(r))),
      nextCursor: more ? encodeCursor("t", page.at(-1)!.seq, filter) : null,
      lastSeq: this.meta.ack,
    };
  }

  async turn(turnId: string, query: TurnQuery = {}): Promise<TurnResult> {
    const refused = await this.reach(query.minSeq);
    if (refused) return refused;
    const waitMs = clamp(query.waitMs, 0, 0, MAX_WAIT_MS);
    const done = (status: TurnStatus) => (query.status ? status !== query.status : ENDED_TURN_STATUSES.has(status));
    const deadline = Date.now() + waitMs;
    let turn = this.readTurn(turnId);
    while (turn && waitMs > 0 && !done(turn.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.changed(remaining);
      turn = this.readTurn(turnId);
    }
    if (!turn) return { ok: false, error: "turn_not_found" };
    return { ok: true, turn, lastSeq: this.meta.ack };
  }

  async asks(query: AsksQuery): Promise<AsksPage> {
    const refused = await this.reach(query.minSeq);
    if (refused) return refused;
    const limit = clamp(query.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT);
    const status = query.status ?? "open";
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    if (status !== "all") where.push("status = ?"), params.push(status);
    if (query.cursor !== undefined) {
      const before = decodeCursor("a", query.cursor, status);
      if (before === null) return { ok: false, error: "invalid_cursor" };
      where.push("seq < ?"), params.push(before);
    }
    params.push(limit + 1);
    const rows = this.sql
      .exec<AskRow>(`SELECT seq, data FROM asks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...params)
      .toArray();
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      asks: page.map((r) => JSON.parse(r.data) as Ask),
      nextCursor: more ? encodeCursor("a", page.at(-1)!.seq, status) : null,
      lastSeq: this.meta.ack,
    };
  }

  async ask(askId: string, minSeq?: number): Promise<AskResult> {
    const refused = await this.reach(minSeq);
    if (refused) return refused;
    const row = this.sql.exec<AskRow>("SELECT seq, data FROM asks WHERE id = ?", askId).toArray()[0];
    if (!row) return { ok: false, error: "ask_not_found" };
    return { ok: true, ask: JSON.parse(row.data) as Ask, lastSeq: this.meta.ack };
  }

  /** Newest first (by start), like asks; `running` (default) or `all`. */
  async subagents(query: SubagentsQuery): Promise<SubagentsPage> {
    const refused = await this.reach(query.minSeq);
    if (refused) return refused;
    const limit = clamp(query.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT);
    const status = query.status === "all" ? "all" : "running";
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    if (status === "running") where.push("status = 'running'");
    if (query.cursor !== undefined) {
      const before = decodeCursor("s", query.cursor, status);
      if (before === null) return { ok: false, error: "invalid_cursor" };
      where.push("seq < ?"), params.push(before);
    }
    params.push(limit + 1);
    const rows = this.sql
      .exec<SubagentRow>(
        `SELECT seq, end_seq, result_seq, data FROM subagents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`,
        ...params,
      )
      .toArray();
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return {
      ok: true,
      subagents: page.map((r) => this.withProgress(subagentOfRow(r).subagent)),
      nextCursor: more ? encodeCursor("s", page.at(-1)!.seq, status) : null,
      lastSeq: this.meta.ack,
    };
  }

  async subagent(subagentId: string, minSeq?: number): Promise<SubagentResult> {
    const refused = await this.reach(minSeq);
    if (refused) return refused;
    const row = this.sql.exec<SubagentRow>("SELECT seq, end_seq, result_seq, data FROM subagents WHERE id = ?", subagentId).toArray()[0];
    if (!row) return { ok: false, error: "subagent_not_found" };
    const lastSeq = this.meta.ack;
    let subagent = this.withProgress(subagentOfRow(row).subagent);
    if (row.result_seq !== null) {
      const event = this.sql.exec<EventRow>("SELECT * FROM events WHERE seq = ?", row.result_seq).toArray()[0];
      const result = event ? (await this.inflate([event]))[0]?.data : undefined;
      const full = (result as { subagent?: { result?: unknown } } | undefined)?.subagent?.result;
      if (typeof full === "string") subagent = { ...subagent, result: full, resultTruncated: false };
    }
    return { ok: true, subagent, lastSeq };
  }

  // ---- helpers --------------------------------------------------------------------------------

  private readTurn(turnId: string): Turn | null {
    const row = this.sql.exec<TurnRow>("SELECT seq, data, usage FROM turns WHERE id = ?", turnId).toArray()[0];
    return row ? publicTurn(turnOfRow(row)) : null;
  }

  private queuedTurns(): Turn[] {
    return this.sql
      .exec<TurnRow>("SELECT seq, data, usage FROM turns WHERE status = 'queued' ORDER BY seq")
      .toArray()
      .map((r) => publicTurn(turnOfRow(r)));
  }

  private runningSubagents(): Subagent[] {
    return this.sql
      .exec<SubagentRow>("SELECT seq, end_seq, result_seq, data FROM subagents WHERE status = 'running' ORDER BY seq")
      .toArray()
      .map((r) => subagentOfRow(r).subagent);
  }

  /** A running subagent with its latest progress merged in. */
  private withProgress(subagent: Subagent): Subagent {
    const p = subagent.status === "running" ? this.progressById.get(subagent.id) : undefined;
    return p ? { ...subagent, ...p } : subagent;
  }

  /** Forget progress of subagents no longer running (ended, or replaced by an epoch bump). */
  private pruneProgress() {
    if (this.progressById.size === 0) return;
    const running = new Set(this.meta.summary.subagents.map((s) => s.id));
    for (const id of this.progressById.keys()) if (!running.has(id)) this.progressById.delete(id);
  }

  private openAsks(): Ask[] {
    return this.sql
      .exec<AskRow>("SELECT seq, data FROM asks WHERE status = 'open' ORDER BY seq")
      .toArray()
      .map((r) => JSON.parse(r.data) as Ask);
  }

  /** Rows to events, the page's R2 blobs fetched in parallel. */
  private async inflate(rows: EventRow[]): Promise<ApiEvent[]> {
    const sessionId = this.meta.sessionId ?? "";
    const blobs = await Promise.all(
      rows.map(async (row) => {
        if (row.blob === null) return null;
        const object = await this.env.SESSION_LOG_BLOBS?.get(row.blob);
        if (!object) throw new Error(`session log blob missing: ${row.blob}`);
        return object.text();
      }),
    );
    return rows.map((row, i) => ({
      id: row.id,
      seq: row.seq,
      createdAt: row.created_at,
      sessionId,
      turnId: row.turn_id,
      type: row.type,
      actor: row.actor === null ? null : JSON.parse(row.actor),
      data: JSON.parse(blobs[i] ?? row.data ?? "null"),
    }));
  }

  /** Wait (≤ minSeqWaitMs) for `ack` to reach `minSeq`; a refusal when it does not. */
  private async reach(minSeq: number | undefined): Promise<LogReadRefusal | null> {
    if (minSeq === undefined || this.meta.ack >= minSeq) return null;
    const deadline = Date.now() + this.minSeqWaitMs;
    while (this.meta.ack < minSeq) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: "unavailable", lastSeq: this.meta.ack, retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS };
      await this.changed(remaining);
    }
    return null;
  }

  /** Resolves on the next append, or after `ms`. */
  private changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private wake() {
    for (const waiter of [...this.waiters]) waiter();
  }

  private loadMeta(): Meta {
    const row = this.sql
      .exec<{
        organization_id: string | null;
        session_id: string | null;
        log_epoch: number;
        epoch_start_seq: number;
        ack: number;
        synced_at: string | null;
        state: string;
        summary: string;
      }>("SELECT * FROM meta WHERE k = 1")
      .toArray()[0];
    if (!row) {
      const state = initialFoldState();
      return {
        organizationId: null,
        sessionId: null,
        logEpoch: 0,
        epochStartSeq: 1,
        ack: 0,
        syncedAt: null,
        state,
        summary: summarize(state, [], [], [], { lastSeq: 0, logEpoch: 0, epochStartSeq: 1, syncedAt: null }),
      };
    }
    return {
      organizationId: row.organization_id,
      sessionId: row.session_id,
      logEpoch: row.log_epoch,
      epochStartSeq: row.epoch_start_seq,
      ack: row.ack,
      syncedAt: row.synced_at,
      state: JSON.parse(row.state) as FoldState,
      // A summary saved before subagents existed has none.
      summary: withSubagents(JSON.parse(row.summary) as LogSummary),
    };
  }

  private saveMeta(m: Meta) {
    this.sql.exec(
      `INSERT OR REPLACE INTO meta (k, organization_id, session_id, log_epoch, epoch_start_seq, ack, synced_at, state, summary)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.organizationId,
      m.sessionId,
      m.logEpoch,
      m.epochStartSeq,
      m.ack,
      m.syncedAt,
      JSON.stringify(m.state),
      JSON.stringify(m.summary),
    );
  }
}
