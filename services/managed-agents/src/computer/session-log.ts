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
// - Every read takes the reader's principal, and `minSeq` answers `unavailable` at once when `ack` has
//   not reached it. Nothing waits: a client follows over Live (spec 37.1).

import { TelemetryBatch } from "./telemetry/batch.js";
import { gatewayTelemetry, type TelemetryEnv } from "./telemetry/gateway.js";
import { DurableObject } from "cloudflare:workers";

import {
  alarms,
  byOf,
  computerOf,
  emitter,
  cursor,
  hashOf,
  liveOf,
  mayRead,
  migrate,
  orgOf,
  owed,
  OWED_PURPOSE,
  sqlOf,
  type AcceptResult,
  type Access,
  type ActorEnv,
  type ComputerRpcAdded,
  type DeliveredOutcome,
  type EntryError,
  type EntryOutcome,
  type EventPush,
  type EventsReset,
  type Inbox,
  type InboxEntry,
  type InboxKind,
  type LiveRpc,
  type OrgRpc,
  type Principal,
  type SessionLogRpcAdded,
  type Summary,
  type SummaryPub,
  type Sql,
} from "../actor/index.js";
import type { FoldSummary } from "./session-fold.js";
import { decodeCursor, encodeCursor } from "./list-cursor.js";
import { crockfordId } from "../actor/helpers.js";
import type { ApiEvent, Ask, Subagent, SubagentProgress, Turn } from "./api-types.js";
import {
  applyEvent,
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

export interface SessionLogEnv extends TelemetryEnv, ActorEnv {
  SESSION_LOG_BLOBS?: R2Bucket;
}

/** The actors a log calls (spec 36.2). A seam: tests put fakes here. */
export interface SessionLogPeers {
  org(org: string): Pick<OrgRpc, "access" | "acceptSummary">;
  computer(machine: string): Pick<ComputerRpcAdded, "drain">;
  live(org: string): Pick<LiveRpc, "publish">;
}

/** Where big event data lives outside the object (spec 17.9): the only R2 access of the log. */
export interface Blobs {
  put(key: string, json: string): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Delete every blob under the prefix. */
  removeAll(prefix: string): Promise<void>;
}

export function r2Blobs(bucket: R2Bucket): Blobs {
  return {
    put: async (key, json) => void (await bucket.put(key, json, { httpMetadata: { contentType: "application/json" } })),
    get: async (key) => (await bucket.get(key))?.text() ?? null,
    removeAll: async (prefix) => {
      for (let cursor: string | undefined; ; ) {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
        if (!page.truncated) return;
        cursor = page.cursor;
      }
    },
  };
}

/** The prefix of a session's blobs. */
export function blobPrefix(organizationId: string, sessionId: string): string {
  return `sessions/${organizationId}/${sessionId}/`;
}

/** The inbox holds at most this many waiting entries (the host's `QUEUE_MAX`). */
export const INBOX_MAX_WAITING = 20;
/** A turn by an agent or the platform is refused once the session accepted this many since its last turn by a person. */
export const AGENT_TURNS_MAX = 30;
/** A delivered or refused entry is kept this long (idempotency; "not sent" in the list), then removed. */
export const INBOX_KEEP_MS = 24 * 60 * 60 * 1_000;
/**
 * An `accept` with `wait` answers by then: past one delivery's bound (the host's answer, HOST_CALL_HELD_TIMEOUT_MS),
 * the entry is still waiting and the write answers 202.
 */
export const ACCEPT_WAIT_MS = 45_000;
/** `inbox[].text` in the summary: this many characters of a turn's input. */
export const INBOX_TEXT_CHARS = 280;
/** An append during a running turn writes the summary slot when it was last written longer ago than this. */
export const SLOT_REFRESH_MS = 30_000;
/** The events that count as occurrences when appended (spec 35.2). */
const OCCURRENCES = new Set(["message.received", "ask.opened", "ask.closed", "turn.completed", "turn.failed", "turn.cancelled"]);
const SWEEP_PURPOSE = "sweep";

/** The `by` of an event's actor (spec 34.1), or null without one. */
function byOfActor(actor: ApiEvent["actor"]): string | null {
  if (!actor) return null;
  if (actor.id === "platform" || actor.id === "system" || (actor.via as string) === "platform" || actor.via === "system") return "platform";
  return actor.id.startsWith("cs_") ? `agent:${actor.id}` : `user:${actor.id}`;
}

/** Event `data` whose JSON is longer than this many bytes goes to R2. */
export const INLINE_DATA_BYTES = 8 * 1024;
/** Data that may exceed this many UTF-8 bytes is put to R2 before its transaction, not spilled after. */
const SYNC_SPILL_BYTES = 1024 * 1024;
export const UNAVAILABLE_RETRY_AFTER_MS = 500;
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
  summary: FoldSummary;
  /** Counts changes to the summary Org holds (spec 35.2); never reused. */
  revision: number;
  /** Until when Live holds a lease on this log's events (spec 40.4). */
  watchedUntil: number;
  /** When the summary slot was last written (the 30 s rule, spec 40.3). */
  slotAt: number;
  /** Turns accepted from agents or the platform since the last turn by a person. */
  agentTurns: number;
}

type InboxRow = {
  n: number;
  id: string;
  kind: InboxKind;
  body: string;
  hash: string;
  by: string;
  actor: string;
  trace: string | null;
  at: number;
  state: "waiting" | "delivered" | "refused";
  result: string | null;
  error: string | null;
  done_at: number | null;
};

/** The tables of spec 35.2, after the existing ones (`SCHEMA`, as before). Never edit a step; add one. */
const MIGRATIONS: ((sql: Sql) => void)[] = [
  (sql) => {
    sql.exec(`CREATE TABLE inbox (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      body TEXT NOT NULL, hash TEXT NOT NULL, "by" TEXT NOT NULL, actor TEXT NOT NULL, trace TEXT, at INTEGER NOT NULL,
      state TEXT NOT NULL, result TEXT, error TEXT, done_at INTEGER)`);
    sql.exec("CREATE INDEX inbox_state ON inbox (state, n)");
    sql.exec(`CREATE TABLE access (k INTEGER PRIMARY KEY CHECK (k = 1), owner TEXT NOT NULL, audience TEXT NOT NULL,
      writers TEXT NOT NULL, readers TEXT NOT NULL, machine TEXT NOT NULL, revision INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE occ_pending (epoch INTEGER, seq INTEGER, kind TEXT NOT NULL, "by" TEXT, at INTEGER NOT NULL, PRIMARY KEY (epoch, seq))`);
    for (const column of ["revision", "watched_until", "slot_at", "agent_turns"]) sql.exec(`ALTER TABLE meta ADD COLUMN ${column} INTEGER`);
  },
  // Access's `agents` (spec 40.7): NULL in a row stored before it, which is read from Org again.
  (sql) => sql.exec("ALTER TABLE access ADD COLUMN agents TEXT"),
];

const isPerson = (p: Principal) => p.kind === "member" || p.kind === "key";

/**
 * Whether a person knows of the session: they read it, or they speak in its Slack thread (the Slack
 * actor admitted them). Anyone else is answered `not_found`, as the session API answers (spec 36.2).
 */
const knows = (p: Principal, access: Access, sessionId: string) => p.via === "slack" || mayRead(p, access, sessionId);

/** Who may put an entry of this kind in the inbox (spec 36.2). */
function mayWrite(p: Principal, kind: InboxKind, access: Access, sessionId: string): boolean {
  const by = byOf(p);
  // `agents` (the session that started it, its track's agent) write whatever `writers` says (spec 40.7).
  const listed = (access.writers !== "members" && access.writers.includes(by)) || (p.kind === "agent" && !!access.agents?.includes(by));
  const members = access.writers === "members" && isPerson(p) && knows(p, access, sessionId);
  // The model and its settings: a person who may write, or its owner.
  if (kind === "settings") return isPerson(p) && (members || listed || access.owner === p.subject);
  // Stopping work (an interrupt, a turn's cancel, a subagent's stop, a suspend): any person who may read it.
  if (kind === "interrupt" || kind === "cancel" || kind === "stop" || kind === "suspend") return p.kind === "platform" || members || listed || (isPerson(p) && mayRead(p, access, sessionId));
  return p.kind === "platform" || members || listed;
}

const entryOfRow = (row: InboxRow): InboxEntry => ({
  id: row.id,
  kind: row.kind,
  body: JSON.parse(row.body),
  by: row.by,
  actor: JSON.parse(row.actor) as InboxEntry["actor"],
  trace: row.trace,
  at: row.at,
});

/** The refused entry a `dismiss` names (spec 40.2 step 6): `body.entryId`, or the id under the names an ask's dismiss uses. */
function namedEntry(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const b = body as Record<string, unknown>;
  return [b.entryId, b.id, b.turnId, b.askId].filter((v): v is string => typeof v === "string");
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

/** A summary saved before a field existed. */
const withSubagents = (summary: FoldSummary): FoldSummary => ({ ...summary, subagents: summary.subagents ?? [], lastAgentSeq: summary.lastAgentSeq ?? 0 });

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

export class SessionLogDurableObject extends DurableObject<SessionLogEnv> implements SessionLogRpc, SessionLogRpcAdded {
  /** The actors this log calls; tests replace it. */
  peers: SessionLogPeers = {
    org: (org) => orgOf(this.env, org),
    computer: (machine) => computerOf(this.env, machine),
    live: (org) => liveOf(this.env, org),
  };
  /** Null where no bucket is bound: event data stays inline. */
  blobs: Blobs | null = this.env.SESSION_LOG_BLOBS ? r2Blobs(this.env.SESSION_LOG_BLOBS) : null;
  private readonly db: Sql;
  private readonly emit = emitter("sessionlog", () => ({ org: this.meta?.organizationId, session: this.meta?.sessionId }));
  /** The copy of Org's access row, or null while the log holds none. */
  private access: Access | null = null;

  private readonly sql: SqlStorage;
  private meta!: Meta;
  private writing: Promise<unknown> = Promise.resolve();
  /** Spills in flight (tests await it). */
  spilling: Promise<unknown> = Promise.resolve();
  /** The latest `subagent.progress` per running subagent: in memory only (never journaled). */
  private readonly progressById = new Map<string, Progress>();
  /** Spills after the commit that finished since the last append result (work 084 instrumentation). */

  constructor(ctx: DurableObjectState, env: SessionLogEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.db = sqlOf(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => this.open());
  }

  private open() {
    this.sql.exec(SCHEMA);
    migrate(this.db, MIGRATIONS);
    this.meta = this.loadMeta();
    this.access = this.loadAccess();
  }

  // ---- the one alarm, and the calls owed after a transaction (spec 36.7) ------------------------

  override async alarm(): Promise<void> {
    await alarms.run(this.db, Date.now(), {
      [OWED_PURPOSE]: () => owed.run(this.db, this.send, Date.now(), this.emit),
      [SWEEP_PURPOSE]: () => this.sweep(),
    });
  }

  /** Send what is owed and due at `now`; resolves when the pass is over. Never throws. Tests await it. */
  flush(now = Date.now()): Promise<void> {
    return owed.run(this.db, this.send, now, this.emit).catch(() => undefined);
  }

  /** After a transaction that added an owed call: send it at once, without making the caller wait. */
  private kick() {
    this.ctx.waitUntil(this.flush());
  }

  private readonly send = async (call: string, _body: unknown): Promise<void> => {
    if (call === "drain") return this.sendDrain();
    if (call === "summary") return this.sendSummary();
    if (call === "live") return this.sendLive();
  };

  /** The push of the append that owes the `live:events` call, until its first try takes it. */
  private push: EventPush | null = null;

  /**
   * `Live.publish` on `events:<id>` (spec 40.4): the append's events on the first try, `{ head }` on a
   * retry (or when a newer append replaced the call), nothing once the lease has passed.
   */
  private async sendLive(): Promise<void> {
    const frame = this.push ?? { head: this.head() };
    this.push = null;
    const org = this.meta.organizationId;
    if (!org || this.meta.watchedUntil <= Date.now()) return;
    await this.peers.live(org).publish(`events:${this.sessionId()}`, frame);
  }

  /**
   * `Computer.drain` (spec 36.3): the machine that serves the session owes its drain from then on, and
   * resolves once it delivered or waits for its host. The only call of it.
   */
  private async sendDrain(): Promise<void> {
    if (this.waiting() === 0) return;
    const sessionId = this.sessionId();
    if (!this.access || !sessionId) throw new Error("drain: the log holds no access");
    await this.peers.computer(this.access.machine).drain(sessionId);
  }

  // ---- access (spec 36.2) -----------------------------------------------------------------------

  async setAccess(access: Access): Promise<void> {
    this.putAccess(access);
  }

  /** Kept only if its revision is newer than the one held. */
  private putAccess(access: Access) {
    if (this.access?.agents && access.revision <= this.access.revision) return;
    const agents = access.agents ?? [];
    this.sql.exec(
      "INSERT OR REPLACE INTO access (k, owner, audience, writers, readers, machine, revision, agents) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      access.owner,
      access.audience,
      JSON.stringify(access.writers),
      JSON.stringify(access.readers),
      access.machine,
      access.revision,
      JSON.stringify(agents),
    );
    this.access = { owner: access.owner, audience: access.audience, writers: access.writers, agents, readers: access.readers, machine: access.machine, revision: access.revision };
  }

  private loadAccess(): Access | null {
    const row = this.sql
      .exec<{ owner: string; audience: string; writers: string; readers: string; machine: string; revision: number; agents: string | null }>("SELECT * FROM access WHERE k = 1")
      .toArray()[0];
    if (!row) return null;
    return {
      owner: row.owner,
      audience: row.audience,
      writers: JSON.parse(row.writers),
      // Absent in a row stored before `agents`: `accessFor` reads Org again.
      ...(row.agents !== null ? { agents: JSON.parse(row.agents) as string[] } : {}),
      readers: JSON.parse(row.readers),
      machine: row.machine,
      revision: row.revision,
    };
  }

  /** The session this log is: the object's name, or what its writer said. */
  private sessionId(): string | null {
    return this.ctx.id.name ?? this.meta.sessionId;
  }

  /**
   * The access a principal's call is judged by, or null (`not_found`): a principal of another
   * organization, or a session Org does not have. A log that holds no access row, or does not know
   * its organization yet, reads `Org.access` first and learns both from the answer.
   */
  private async accessFor(p: Principal): Promise<Access | null> {
    const sessionId = this.sessionId();
    if (!sessionId) return null;
    if (this.meta.organizationId !== null && this.meta.organizationId !== p.org) return null;
    if (this.access?.agents && this.meta.organizationId !== null) return this.access;
    const got = await this.peers.org(p.org).access(sessionId);
    if (!got) return null;
    if (this.meta.organizationId === null) {
      const next = { ...this.meta, organizationId: p.org, sessionId };
      this.saveMeta(next);
      this.meta = next;
    } else if (this.meta.organizationId !== p.org) return null;
    this.putAccess(got);
    return this.access;
  }

  /** Live's lease on this log's events (spec 40.4): the head cursor and the machine that serves the session, or null when `p` may not read. */
  async watch(p: Principal, until: number): Promise<{ head: string; machine: string } | null> {
    const access = await this.accessFor(p);
    if (!access || !mayRead(p, access, this.sessionId()!)) return null;
    if (until > this.meta.watchedUntil) {
      const next = { ...this.meta, watchedUntil: until };
      this.saveMeta(next);
      this.meta = next;
    }
    return { head: this.head(), machine: access.machine };
  }

  /** The events cursor of the log's end. */
  private head(): string {
    return cursor.encode("e", [this.meta.logEpoch, this.meta.ack]);
  }

  /** The session is deleted: its storage and its spilled blobs. */
  async destroy(): Promise<void> {
    await this.exclusive(async () => {
      await this.spilling.catch(() => undefined);
      const { organizationId } = this.meta;
      const sessionId = this.sessionId();
      if (this.blobs && organizationId && sessionId) await this.blobs.removeAll(blobPrefix(organizationId, sessionId));
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.progressById.clear();
      this.push = null;
      this.open();
    });
  }

  // ---- the inbox (spec 36.2, 40.2) --------------------------------------------------------------

  /**
   * `wait`: the caller answers with the entry's outcome (the API's writes, spec 40.2): the drain is
   * awaited, ACCEPT_WAIT_MS at most, and the outcome is the entry's as it then is.
   */
  async accept(p: Principal, entry: { id: string; kind: InboxKind; body: unknown; trace?: string }, opts: { wait?: boolean } = {}): Promise<AcceptResult> {
    const access = await this.accessFor(p);
    if (!access) return { ok: false, code: "not_found" };
    const sessionId = this.sessionId()!;
    if (!mayWrite(p, entry.kind, access, sessionId)) return { ok: false, code: isPerson(p) && !knows(p, access, sessionId) ? "not_found" : "forbidden" };
    const body = entry.body ?? null;
    const hash = await hashOf({ kind: entry.kind, body });
    const now = Date.now();
    const by = byOf(p);
    const actor = JSON.stringify({ subject: p.subject, kind: p.kind, via: p.via, admin: p.admin });
    const taken = this.db.transaction((): { ok: true; duplicate: boolean } | Extract<AcceptResult, { ok: false }> => {
      const existing = this.sql.exec<InboxRow>("SELECT * FROM inbox WHERE id = ?", entry.id).toArray()[0];
      if (existing) {
        if (existing.hash !== hash) return { ok: false, code: "idempotency_conflict" };
        return { ok: true, duplicate: true };
      }
      const insert = (state: "waiting" | "delivered") =>
        this.sql.exec(
          `INSERT INTO inbox (id, kind, body, hash, "by", actor, trace, at, state, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          entry.id,
          entry.kind,
          JSON.stringify(body),
          hash,
          by,
          actor,
          entry.trace ?? null,
          now,
          state,
          state === "waiting" ? null : now,
        );
      if (entry.kind === "dismiss") {
        // A dismiss naming a refused entry removes it, and is itself done: nothing goes to the host.
        for (const id of namedEntry(body)) {
          if (this.sql.exec("DELETE FROM inbox WHERE id = ? AND state = 'refused' RETURNING n", id).toArray().length === 0) continue;
          insert("delivered");
          alarms.set(this.db, SWEEP_PURPOSE, now + INBOX_KEEP_MS);
          this.bump(this.meta, now);
          return { ok: true, duplicate: false };
        }
      }
      if (this.waiting() >= INBOX_MAX_WAITING) return { ok: false, code: "inbox_full" };
      let agentTurns = this.meta.agentTurns;
      if (entry.kind === "turn") {
        if (isPerson(p)) agentTurns = 0;
        else if (agentTurns >= AGENT_TURNS_MAX) return { ok: false, code: "agent_turns" };
        else agentTurns += 1;
      }
      insert("waiting");
      owed.add(this.db, { group: "drain", key: "drain", call: "drain" });
      this.bump({ ...this.meta, agentTurns }, now);
      return { ok: true, duplicate: false };
    });
    if (!taken.ok) return taken;
    if (!taken.duplicate) this.kick();
    if (opts.wait && this.outcome(entry.id).state === "waiting") await this.drained(ACCEPT_WAIT_MS);
    return { ok: true, id: entry.id, duplicate: taken.duplicate, outcome: this.outcome(entry.id) };
  }

  /** The owed drain's run, `ms` at most. */
  private async drained(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
    await Promise.race([owed.run(this.db, this.send, Date.now(), this.emit, "drain").catch(() => undefined), late]);
    clearTimeout(timer);
  }

  async inbox(): Promise<Inbox> {
    const entries = this.sql.exec<InboxRow>("SELECT * FROM inbox WHERE state = 'waiting' ORDER BY n").toArray().map(entryOfRow);
    return { entries, epoch: this.meta.logEpoch, lastSeq: this.meta.ack };
  }

  /** One entry's outcome, whichever drain delivered it (a refused or swept one: as it was, or delivered). */
  private outcome(id: string): EntryOutcome {
    const row = this.sql.exec<InboxRow>("SELECT * FROM inbox WHERE id = ?", id).toArray()[0];
    if (!row || row.state === "delivered") return { state: "delivered", result: row?.result ? (JSON.parse(row.result) as unknown) : null };
    if (row.state === "refused") return { state: "refused", error: JSON.parse(row.error ?? "{}") as EntryError };
    return { state: "waiting" };
  }

  async delivered(id: string, outcome: DeliveredOutcome): Promise<void> {
    const now = Date.now();
    this.db.transaction(() => {
      // Only a waiting entry: a repeated report changes nothing.
      const { ok, ...error } = outcome;
      const changed = ok
        ? this.sql.exec("UPDATE inbox SET state = 'delivered', result = ?, done_at = ? WHERE id = ? AND state = 'waiting' RETURNING n", JSON.stringify(outcome.result ?? null), now, id)
        : this.sql.exec(
            "UPDATE inbox SET state = 'refused', error = ?, done_at = ? WHERE id = ? AND state = 'waiting' RETURNING n",
            JSON.stringify(error), // the host's code with its status and fields: a later `entry` answers as the drain did
            now,
            id,
          );
      if (changed.toArray().length === 0) return;
      alarms.set(this.db, SWEEP_PURPOSE, now + INBOX_KEEP_MS);
      this.bump(this.meta, now);
    });
    this.kick();
  }

  /** Delivered and refused entries leave after 24 h. */
  private sweep() {
    const now = Date.now();
    this.db.transaction(() => {
      const gone = this.sql.exec<{ state: string }>("DELETE FROM inbox WHERE state != 'waiting' AND done_at <= ? RETURNING state", now - INBOX_KEEP_MS).toArray();
      // A refused entry was in the summary's inbox.
      if (gone.some((row) => row.state === "refused")) this.bump(this.meta, now);
      const next = this.sql.exec<{ at: number | null }>("SELECT MIN(done_at) AS at FROM inbox WHERE state != 'waiting'").toArray()[0]?.at;
      if (next !== null && next !== undefined) alarms.set(this.db, SWEEP_PURPOSE, next + INBOX_KEEP_MS);
    });
    this.kick();
  }

  private waiting(): number {
    return this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM inbox WHERE state = 'waiting'").toArray()[0]!.c;
  }

  /** In the caller's transaction: the summary changed (spec 40.3 step 1). Saves `m` with the next revision. */
  private bump(m: Meta, now: number) {
    const next: Meta = { ...m, revision: m.revision + 1, slotAt: now };
    this.saveMeta(next);
    this.meta = next;
    owed.add(this.db, { group: "summary", key: "summary", call: "summary" });
  }

  /** The summary Org receives (spec 35.2): the log's, its revision, and the inbox entries that wait or were refused. */
  private orgSummary(): Summary {
    const inbox = this.sql
      .exec<InboxRow>("SELECT * FROM inbox WHERE state IN ('waiting', 'refused') ORDER BY n")
      .toArray()
      .map((row) => {
        const input = row.kind === "turn" ? (JSON.parse(row.body) as { input?: unknown } | null)?.input : null;
        const error = row.error === null ? null : (JSON.parse(row.error) as { code: string }).code;
        return { id: row.id, kind: row.kind, by: row.by, at: new Date(row.at).toISOString(), text: typeof input === "string" ? input.slice(0, INBOX_TEXT_CHARS) : null, error };
      });
    return { ...this.meta.summary, revision: this.meta.revision, agentTitle: this.meta.summary.title, inbox };
  }

  /**
   * The summary slot (spec 40.3): the body is built now, so it carries the latest. Org answering this
   * revision or a later one clears the occurrences sent; the owed row goes with this call's return,
   * and one written meanwhile (a newer revision) is another row, sent next.
   */
  private async sendSummary(): Promise<void> {
    const sessionId = this.sessionId();
    const org = this.meta.organizationId;
    if (!sessionId || !org) throw new Error("summary: the log does not know its organization");
    const occurrences = this.sql
      .exec<{ epoch: number; seq: number; kind: string; by: string | null; at: number }>(`SELECT epoch, seq, kind, "by", at FROM occ_pending ORDER BY epoch, seq`)
      .toArray();
    const pub: SummaryPub = { sessionId, revision: this.meta.revision, summary: this.orgSummary(), occurrences };
    const answer = await this.peers.org(org).acceptSummary(pub);
    if (answer.revision < pub.revision) throw new Error(`summary: Org holds revision ${answer.revision}, sent ${pub.revision}`);
    this.db.transaction(() => {
      for (const o of occurrences) this.sql.exec("DELETE FROM occ_pending WHERE epoch = ? AND seq = ?", o.epoch, o.seq);
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
      // Only the log's epoch + 1 (spec 36.2, 40.10): the caller read it from `epochTail` just before; one
      // that lost a race, or guessed, is refused and reads again.
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
      out.push({ id: crockfordId("ev"), seq: ++seq, createdAt: input.at, sessionId: input.sessionId, turnId, type, actor: SYSTEM_ACTOR, data });
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
    const now = Date.now();
    const syncedAt = new Date(now).toISOString();

    let push: EventPush | null = null;
    let owes = false;
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
      // The inbox's transactions ran while this one's rows were prepared: their counters are the object's, not `m`'s.
      const { revision, watchedUntil, slotAt, agentTurns } = this.meta;
      const next: Meta = { ...m, revision, watchedUntil, slotAt, agentTurns, logEpoch, epochStartSeq, ack, syncedAt, state, summary };
      let occurred = false;
      for (const r of rows) {
        if (!OCCURRENCES.has(r.event.type)) continue;
        occurred = true;
        this.sql.exec(
          `INSERT OR REPLACE INTO occ_pending (epoch, seq, kind, "by", at) VALUES (?, ?, ?, ?, ?)`,
          epoch,
          r.event.seq,
          r.event.type,
          byOfActor(r.event.actor),
          Date.parse(r.event.createdAt) || now,
        );
      }
      // Spec 40.3 step 1. Any other append's lastSeq, lastText and lastActiveAt go with the next revision.
      const was = m.summary;
      const changed = newEpoch || was.status !== summary.status || was.title !== summary.title || JSON.stringify(was.asks) !== JSON.stringify(summary.asks);
      const running = summary.activeTurnId !== null && now - slotAt > SLOT_REFRESH_MS;
      if (occurred || changed || running) this.bump(next, now);
      else {
        this.saveMeta(next);
        this.meta = next;
      }
      // Spec 40.4: Live holds a lease on these events. Spilled data does not travel: `{ head }`, and the client reads.
      if ((rows.length > 0 || newEpoch) && watchedUntil > now) {
        owed.add(this.db, { group: "live", key: "live:events", call: "live" });
        const inline = rows.every((r) => r.spill === null && r.blob === null);
        push = inline ? { from: cursor.encode("e", [m.logEpoch, m.ack]), to: cursor.encode("e", [logEpoch, ack]), events: rows.map((r) => r.event) } : null;
        owes = true;
      }
      if (subagentsTouched) this.pruneProgress();
    });
    if (owes) this.push = push;
    this.kick();
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
      spillsDue: this.blobs ? rows.filter((r) => r.spill !== null).length : 0,
      storageBytes,
    };
    return { ok: true, ack: this.meta.ack, summary: this.meta.summary, stats };
  }

  /** After the commit: big inline data to R2, then the row points at it (unless it was replaced meanwhile). */
  private spill(epoch: number, rows: PreparedRow[]) {
    const bucket = this.blobs;
    const due = bucket ? rows.filter((r) => r.spill !== null) : [];
    if (due.length === 0) return;
    // One `sessionlog.spill` per batch's spills (work 084, Q2), into the object's telemetry batch after them.
    const fact = { began: performance.now(), spills: 0, bytes: 0, failed: 0, msMax: 0 };
    const run = Promise.all(
      due.map(async (r) => {
        const began = performance.now();
        try {
          await bucket!.put(r.spill!, r.data!);
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
    const bucket = this.blobs;
    const puts: Promise<unknown>[] = [];
    const rows = events.map((event): PreparedRow => {
      const json = JSON.stringify(event.data ?? null);
      const actor = event.actor ? JSON.stringify(event.actor) : null;
      if (bucket && byteLength(json) > INLINE_DATA_BYTES) {
        const key = blobKey(this.meta.organizationId!, this.meta.sessionId!, epoch, event.seq);
        // ≤ 3 UTF-8 bytes per UTF-16 unit: below the bound it fits a SQLite value.
        if (json.length * 3 <= SYNC_SPILL_BYTES) return { event, actor, data: json, blob: null, spill: key };
        puts.push(bucket.put(key, json));
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

  async summary(minSeq: number | undefined, p: Principal): Promise<{ ok: true; summary: Summary } | LogReadRefusal> {
    const refused = await this.admit(minSeq, p);
    if (refused) return refused;
    const summary = this.orgSummary();
    if (this.progressById.size === 0 || summary.subagents.length === 0) return { ok: true, summary };
    return { ok: true, summary: { ...summary, subagents: summary.subagents.map((s) => this.withProgress(s)) } };
  }

  async events(query: EventsQuery, p: Principal): Promise<EventsPage> {
    const refused = await this.admit(query.minSeq, p);
    if (refused) return refused;
    let after: number;
    /** The cursor answered when the page is empty: the one given. */
    let given: string;
    if (query.after !== undefined) {
      // An opaque cursor (spec 37.1).
      const read = this.afterCursor(query.after);
      if (read === null) return { ok: false, error: "reset", cursor: null };
      if (typeof read !== "number") return read;
      after = read;
      given = query.after;
    } else {
      after = 0;
      given = cursor.encode("e", [this.meta.logEpoch, 0]);
    }
    const limit = clamp(query.limit, EVENTS_DEFAULT_LIMIT, 1, EVENTS_MAX_LIMIT);
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

    let rows = this.sql.exec<EventRow>(statement, ...params).toArray();
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    const page: EventsPage = {
      ok: true,
      events: await this.inflate(rows),
      lastSeq: this.meta.ack,
      hasMore,
      syncedAt: this.meta.syncedAt,
      cursor: rows.length ? cursor.encode("e", [this.meta.logEpoch, rows.at(-1)!.seq]) : given,
    };
    if (earlierTurns) page.earlierTurns = earlierTurns;
    return page;
  }

  async turns(query: TurnsQuery, p: Principal): Promise<TurnsPage> {
    const refused = await this.admit(query.minSeq, p);
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

  async turn(turnId: string, query: TurnQuery, p: Principal): Promise<TurnResult> {
    const refused = await this.admit(query.minSeq, p);
    if (refused) return refused;
    const turn = this.readTurn(turnId);
    if (!turn) return { ok: false, error: "turn_not_found" };
    return { ok: true, turn, lastSeq: this.meta.ack };
  }

  async asks(query: AsksQuery, p: Principal): Promise<AsksPage> {
    const refused = await this.admit(query.minSeq, p);
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

  async ask(askId: string, minSeq: number | undefined, p: Principal): Promise<AskResult> {
    const refused = await this.admit(minSeq, p);
    if (refused) return refused;
    const row = this.sql.exec<AskRow>("SELECT seq, data FROM asks WHERE id = ?", askId).toArray()[0];
    if (!row) return { ok: false, error: "ask_not_found" };
    return { ok: true, ask: JSON.parse(row.data) as Ask, lastSeq: this.meta.ack };
  }

  /** Newest first (by start), like asks; `running` (default) or `all`. */
  async subagents(query: SubagentsQuery, p: Principal): Promise<SubagentsPage> {
    const refused = await this.admit(query.minSeq, p);
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

  async subagent(subagentId: string, minSeq: number | undefined, p: Principal): Promise<SubagentResult> {
    const refused = await this.admit(minSeq, p);
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
        const text = await this.blobs?.get(row.blob);
        if (text === null || text === undefined) throw new Error(`session log blob missing: ${row.blob}`);
        return text;
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

  /**
   * Where a reader holding this events cursor reads on from (a seq), a `reset`, or null for text that
   * is no events cursor (a bare integer too). Spec 37.1, 40.10 step 5.
   */
  private afterCursor(text: string): number | EventsReset | null {
    const parts = cursor.read("e", text);
    if (!parts) return null;
    const [epoch, seq] = parts as [number, number];
    const m = this.meta;
    if (epoch > m.logEpoch) return null;
    // Past the log's end: back to its end.
    if (epoch === m.logEpoch) return seq > m.ack ? { ok: false, error: "reset", cursor: this.head(), seq: m.ack } : seq;
    // An older epoch's: the same events below the first seq a later epoch wrote (the lowest, across several epochs).
    const rewritten = this.sql.exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events WHERE epoch > ?", epoch).toArray()[0]?.seq;
    const first = Math.min(rewritten ?? m.epochStartSeq, m.epochStartSeq);
    if (seq < first) return seq;
    return { ok: false, error: "reset", cursor: cursor.encode("e", [m.logEpoch, first - 1]), seq: first - 1 };
  }

  /** A read's gate: `not_found` to a principal that may not read, then `minSeq`, at once (the client retries). */
  private async admit(minSeq: number | undefined, p: Principal): Promise<LogReadRefusal | null> {
    const access = await this.accessFor(p);
    if (!access || !mayRead(p, access, this.sessionId()!)) return { ok: false, error: "not_found" };
    if (minSeq !== undefined && this.meta.ack < minSeq) return { ok: false, error: "unavailable", lastSeq: this.meta.ack, retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS };
    return null;
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
        revision: number | null;
        watched_until: number | null;
        slot_at: number | null;
        agent_turns: number | null;
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
        revision: 0,
        watchedUntil: 0,
        slotAt: 0,
        agentTurns: 0,
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
      summary: withSubagents(JSON.parse(row.summary) as FoldSummary),
      revision: row.revision ?? 0,
      watchedUntil: row.watched_until ?? 0,
      slotAt: row.slot_at ?? 0,
      agentTurns: row.agent_turns ?? 0,
    };
  }

  private saveMeta(m: Meta) {
    this.sql.exec(
      `INSERT OR REPLACE INTO meta (k, organization_id, session_id, log_epoch, epoch_start_seq, ack, synced_at, state, summary,
         revision, watched_until, slot_at, agent_turns)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.organizationId,
      m.sessionId,
      m.logEpoch,
      m.epochStartSeq,
      m.ack,
      m.syncedAt,
      JSON.stringify(m.state),
      JSON.stringify(m.summary),
      m.revision,
      m.watchedUntil,
      m.slotAt,
      m.agentTurns,
    );
  }
}
