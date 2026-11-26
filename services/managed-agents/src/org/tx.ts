// What every write in Org shares (spec 35.1, 37.3, 40.4, 40.6). One `Tx` per transaction:
//
//   const out = transact(sql, Date.now(), (tx) => { …reads and writes through tx… });
//
// `transact` runs `fn` in one `sql.transaction` and, at its end, writes the owed calls that follow
// from it: `Live.publish` (keyed `live:feed`) when a version was allocated, and a wake for each
// session an occurrence wakes (spec 40.6). The caller then runs `owed.run` (the Durable Object does,
// after every method).
//
// Rules of use:
// - Every changed feed row is stamped: `tx.stamp(table, ...key)` after the write, or write
//   `version = tx.version()` yourself. All rows of one transaction share the one version.
// - A row that leaves the feed is removed with `tx.remove(table, ...key)` (deletes, and writes the
//   `gone` row), or `tx.gone(kind, id, audiences)` when the caller deleted it.
// - Calls to other actors are owed calls: `tx.sendAccess`, `tx.start`, `tx.stop`, `tx.destroy`,
//   `tx.interrupt`, or `tx.owe` for another one. Org's Durable Object knows how to send each `call`.

import type { Ask, LogSummary, Origin, Person, SessionSettings, SessionStatus } from "../computer/api-types.js";
import { DEFAULT_MODE, MODELS } from "../computer/capabilities.js";
import { CROCKFORD } from "../computer/session-ids.js";
import type { Access, PlaceRow, Row, SessionRow, Summary } from "../actor/contracts.js";
import { byOf, type Principal } from "../actor/principal.js";
import type { Sql } from "../actor/sql.js";
import { owed, type Owed } from "../actor/store.js";
import { FEED_TABLES, type FeedTable } from "./schema.js";

// ------------------------------------------------------------------ constants (spec 44)

export const FEED_ROWS_MAX = 2_000;
export const PUSH_BYTES_MAX = 256 * 1024;
export const DAY_MS = 24 * 60 * 60 * 1_000;
export const RETAIN_MS = 30 * DAY_MS;
export const IDEM_TTL_MS = DAY_MS;
export const AGENT_THREADS_MAX = 10;

/** The occurrence kinds that wake a track's agent or a parent session, and those the Slack echo posts (spec 40.6). */
const WAKE_KINDS = new Set(["turn.completed", "turn.failed", "ask.opened", "result.changed", "thread.done", "thread.placed", "track.quiet"]);
const ECHO_KINDS = new Set(["turn.refused", "machine.changed"]);
/** A wake waits this long for more of the same target's occurrences, then goes as one turn. */
export const WAKE_DEBOUNCE_MS = 20_000;
/**
 * A wake's or a Slack echo's waits between tries; past the last it goes to the dead list. Short, so
 * one that keeps failing holds its group minutes, not hours.
 */
export const NOTICE_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000];

// ------------------------------------------------------------------ the tables' rows, as stored

export interface SessionRec {
  id: string;
  owner: string;
  owner_name: string | null;
  owner_email: string | null;
  origin: string;
  slack_thread_key: string | null;
  machine: string;
  role: "track" | "start" | null;
  created_at: number;
  created_by: string;
  title: string | null;
  title_by: string | null;
  former_titles: string;
  writers: string;
  aside: string | null;
  metadata: string | null;
  blocked: number;
  revision: number;
  summary: string;
  create_hash: string | null;
  last_active_at: number | null;
  version: number;
  audience: string;
}

export interface PlaceRec {
  session_id: string;
  track_id: string | null;
  position: number;
  placed_by: string;
  parent_session: string | null;
  done_at: number | null;
  outcome: string | null;
  done_by: string | null;
  keep: number;
  brought_back_at: number | null;
  earlier_at: number | null;
  ready_seq: number | null;
  ready_what: string | null;
  ready_result: string | null;
  attention: string | null;
  version: number;
  audience: string;
}

export interface TrackRec {
  id: string;
  owner: string;
  name: string | null;
  name_by: string | null;
  former_names: string;
  stand: string | null;
  stand_at: number | null;
  agent_session: string;
  position: number;
  keep: number;
  done_at: number | null;
  outcome: string | null;
  created_by: string;
  version: number;
  audience: string;
}

type Raw = Record<string, unknown> & { version: number; audience: string };

// ------------------------------------------------------------------ small helpers

export const iso = (ms: number): string => new Date(ms).toISOString();
export const isoOrNull = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : iso(ms));
export const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/** A fresh id: `<prefix>_` + 16 Crockford characters (spec 34.1: `op_`, `res_`, `prp_`). */
export function mint(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = `${prefix}_`;
  for (const byte of bytes) out += CROCKFORD[byte & 31];
  return out;
}

/** `by` is a person's: `user:<usr_…>` or `user:slack:<team>:<user>` (spec 34.1). */
export const isPerson = (by: string | null | undefined): boolean => typeof by === "string" && by.startsWith("user:");
/** The audience of a session's rows (spec 35.1): `member:<owner>` from Slack and for a role session, else `org`. */
export const audienceOf = (owner: string, origin: Origin, role: string | null): string => (origin.type === "slack" || role !== null ? `member:${owner}` : "org");

/** The first 80 characters of an input's first line, as today's `POST /sessions` titles a session. */
export function titleFrom(input: string): string {
  const line = input.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Untitled";
}

/** The oldest open ask's id: what `aside` is compared with (as `sessions-api.ts`). */
export function attentionRef(asks: readonly Ask[]): string | null {
  let oldest: Ask | null = null;
  for (const a of asks) if (a.status === "open" && (!oldest || a.createdAt < oldest.createdAt)) oldest = a;
  return oldest?.id ?? null;
}

/** The summary of a session whose log has nothing yet (spec 40.1): `status` null reads as `starting`. */
export function emptySummary(settings: Partial<SessionSettings>, agentTitle: string | null): Summary {
  return {
    lastSeq: 0,
    logEpoch: 1,
    epochStartSeq: 0,
    status: null,
    title: null,
    settings: { model: settings.model ?? MODELS[0]!.id, effort: settings.effort ?? null, mode: settings.mode ?? DEFAULT_MODE, speed: settings.speed ?? null },
    activeTurnId: null,
    queued: [],
    asks: [],
    subagents: [],
    lastTurn: null,
    lastText: null,
    context: { usedTokens: null, windowTokens: null },
    lastActiveAt: null,
    syncedAt: null,
    revision: 0,
    lastAgentSeq: 0,
    agentTitle,
    inbox: [],
  };
}

export const summaryOf = (s: Pick<SessionRec, "summary">): Summary => parse<Summary>(s.summary, emptySummary({}, null));
/** A session is working: a turn is active or it has not answered its first yet. */
export const working = (summary: LogSummary): boolean => summary.status === "running" || summary.status === "starting" || summary.activeTurnId !== null;

/** A session's status; one whose log has not reported yet is starting only while a turn waits. */
export const statusOf = (summary: Summary): SessionStatus => (summary.status as SessionStatus | null) ?? (summary.activeTurnId !== null || (summary.queued?.length ?? 0) > 0 ? "starting" : "idle");

// ------------------------------------------------------------------ reads

export const readSession = (sql: Sql, id: string): SessionRec | null => sql.exec<SessionRec>("SELECT * FROM session WHERE id = ?", id)[0] ?? null;
export const readPlace = (sql: Sql, sessionId: string): PlaceRec | null => sql.exec<PlaceRec>("SELECT * FROM place WHERE session_id = ?", sessionId)[0] ?? null;
export const readTrack = (sql: Sql, id: string): TrackRec | null => sql.exec<TrackRec>("SELECT * FROM track WHERE id = ?", id)[0] ?? null;
/** The track whose agent is this session, if it holds a track role. */
export const trackOfAgent = (sql: Sql, sessionId: string): TrackRec | null => sql.exec<TrackRec>("SELECT * FROM track WHERE agent_session = ?", sessionId)[0] ?? null;

// ------------------------------------------------------------------ feed rows

const TIMES = new Set(["done_at", "brought_back_at", "earlier_at", "stand_at", "state_at", "at", "created_at"]);
const BOOLS = new Set(["keep", "blocked"]);
const JSONS: Partial<Record<FeedTable, string[]>> = {
  track: ["former_names"],
  result: ["meta"],
  proposal: ["args"],
  doc: ["spans"],
  pref: ["value"],
  op: ["args", "inverse", "fields"],
};
const camel = (column: string): string => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * A table's row as the feed sends it: `{ kind, id, version, audience, …fields in camelCase }`.
 * `kind` is the table; `id` the last key column; times are ISO strings; JSON columns are parsed;
 * `result`'s and `proposal`'s own `kind` column is sent as `type`. For `session` use `sessionRow`.
 */
export function feedRow(table: Exclude<FeedTable, "session">, raw: Raw): Row & { audience: string } {
  const keys = FEED_TABLES[table] as readonly string[];
  const out: Row & { audience: string } = { kind: table, id: String(raw[keys[keys.length - 1]!]), version: raw.version, audience: raw.audience };
  const jsons = JSONS[table] ?? [];
  for (const [column, value] of Object.entries(raw)) {
    if (column === "version" || column === "audience" || column === "id") continue;
    const name = column === "kind" ? "type" : camel(column);
    if (TIMES.has(column)) out[name] = isoOrNull(value as number | null);
    else if (BOOLS.has(column)) out[name] = value === 1;
    else if (jsons.includes(column)) out[name] = parse<unknown>(value as string | null, null);
    else out[name] = value;
  }
  return out;
}

export const placeRow = (rec: PlaceRec): PlaceRow & { audience: string } => feedRow("place", rec as unknown as Raw) as PlaceRow & { audience: string };

/** The `session` feed row and the API's object (spec 35.1, "A feed row"): Org's columns and the stored summary. */
export function sessionRow(sql: Sql, s: SessionRec): SessionRow & Row & { audience: string } {
  const summary = summaryOf(s);
  const place = sql.exec<{ done_at: number | null }>("SELECT done_at FROM place WHERE session_id = ?", s.id)[0];
  const owner: Person = { id: s.owner, name: s.owner_name ?? "", email: s.owner_email };
  const created = iso(s.created_at);
  return {
    kind: "session",
    version: s.version,
    audience: s.audience,
    id: s.id,
    title: s.title ?? summary.agentTitle ?? summary.title ?? "Untitled",
    status: statusOf(summary),
    archived: place !== undefined && place.done_at !== null,
    aside: s.aside !== null && s.aside === attentionRef(summary.asks),
    owner,
    origin: parse<Origin>(s.origin, { type: "api", client: null, slack: null }),
    settings: summary.settings ?? emptySummary({}, null).settings!,
    metadata: parse<Record<string, string>>(s.metadata, {}),
    activeTurnId: summary.activeTurnId,
    queued: summary.queued,
    asks: summary.asks,
    subagents: summary.subagents,
    lastTurn: summary.lastTurn,
    lastText: summary.lastText,
    context: summary.context,
    lastSeq: summary.lastSeq,
    logEpoch: summary.logEpoch,
    epochStartSeq: summary.epochStartSeq,
    createdAt: created,
    lastActiveAt: summary.lastActiveAt ?? created,
    syncedAt: summary.syncedAt,
    urls: { dashboard: null },
    titleBy: s.title_by,
    agentTitle: summary.agentTitle ?? null,
    lastAgentSeq: summary.lastAgentSeq ?? 0,
    blocked: s.blocked === 1,
    inbox: summary.inbox ?? [],
    machine: s.machine,
    role: s.role,
  };
}

/** The row of any feed table, by its stored record. */
export function rowOf(sql: Sql, table: FeedTable, raw: Raw): Row & { audience: string } {
  return table === "session" ? sessionRow(sql, raw as unknown as SessionRec) : feedRow(table, raw);
}

/** A row for a client: without `audience` (spec 35.1). */
export function forClient<T extends Row>(row: T): T {
  const { audience: _audience, ...rest } = row;
  return rest as T;
}

// ------------------------------------------------------------------ who may (spec 19.2, 34.3)

/** Whether `p` reads rows of this audience. An agent has no audience: it reads by `seesSession`. */
export function visible(p: Principal, audience: string): boolean {
  if (p.kind === "platform") return true;
  if (p.kind === "agent") return false;
  if (audience.startsWith("member:") && p.kind === "key" && !p.scopes.includes("work:read" as never)) return false;
  return p.audiences.includes(audience) || audience === `member:${p.subject}`;
}

/** The audiences `p` reads the feed for. */
export function audiencesOf(p: Principal): string[] {
  if (p.kind === "agent" || p.kind === "platform") return [];
  const own = `member:${p.subject}`;
  const all = p.audiences.includes(own) ? p.audiences : [...p.audiences, own];
  return p.kind === "key" && !p.scopes.includes("work:read" as never) ? all.filter((a) => !a.startsWith("member:")) : all;
}

export const isMember = (p: Principal): boolean => p.kind === "member" || p.kind === "key";
export const ownsSession = (p: Principal, s: Pick<SessionRec, "owner">): boolean => isMember(p) && s.owner === p.subject;
export const ownsTrack = (p: Principal, t: Pick<TrackRec, "owner">): boolean => isMember(p) && t.owner === p.subject;
/** The agent holds the track role for this track. */
export const holdsTrack = (p: Principal, t: Pick<TrackRec, "agent_session"> | null): boolean => p.kind === "agent" && t !== null && t.agent_session === p.session;
export const isOwnSession = (p: Principal, sessionId: string): boolean => p.kind === "agent" && p.session === sessionId;

/**
 * 19.2's agent clause for `thread.rename` and `thread.place`: it holds the track role for the
 * thread's track, and the thread was placed there by a person or started by that agent.
 */
export function agentArranges(sql: Sql, p: Principal, place: PlaceRec | null): boolean {
  if (p.kind !== "agent" || !place || place.track_id === null) return false;
  if (!holdsTrack(p, readTrack(sql, place.track_id))) return false;
  return isPerson(place.placed_by) || place.parent_session === p.session;
}

/**
 * Whether `p` may see a session at all; a mutation answers `not_found` when not (spec 39). A
 * member by audience; an agent its own session, one it started, its track's threads, and its
 * track's agent.
 */
export function seesSession(sql: Sql, p: Principal, s: SessionRec): boolean {
  if (p.kind !== "agent") return visible(p, s.audience);
  if (p.session === s.id) return true;
  const place = readPlace(sql, s.id);
  if (place?.parent_session === p.session) return true;
  if (place?.track_id) {
    const track = readTrack(sql, place.track_id);
    if (track && track.agent_session === p.session) return true;
  }
  if (s.role === "track" && p.session) {
    const own = readPlace(sql, p.session);
    const track = trackOfAgent(sql, s.id);
    if (own?.track_id && track && own.track_id === track.id) return true;
  }
  return false;
}

export function seesTrack(sql: Sql, p: Principal, t: TrackRec): boolean {
  if (p.kind !== "agent") return visible(p, t.audience);
  if (t.agent_session === p.session) return true;
  return p.session !== undefined && readPlace(sql, p.session)?.track_id === t.id;
}

// ------------------------------------------------------------------ access (spec 36.2, 40.7)

/**
 * A session's access as its SessionLog and its machine hold it, from the rows as they are now.
 * `agents`: the track's agent and the session that started it may write and read; a track's agent
 * may be written to by its threads.
 */
export function accessOf(sql: Sql, sessionId: string): Access | null {
  const s = readSession(sql, sessionId);
  if (!s) return null;
  const agents = new Set<string>();
  const place = readPlace(sql, sessionId);
  if (place?.parent_session) agents.add(`agent:${place.parent_session}`);
  if (place?.track_id) {
    const track = readTrack(sql, place.track_id);
    if (track) agents.add(`agent:${track.agent_session}`);
  }
  const readers = [...agents];
  if (s.role === "track") {
    const track = trackOfAgent(sql, sessionId);
    if (track) for (const row of sql.exec<{ session_id: string }>("SELECT session_id FROM place WHERE track_id = ?", track.id)) agents.add(`agent:${row.session_id}`);
  }
  const writers = parse<"members" | string[]>(s.writers, "members");
  const version = sql.exec<{ version: number }>("SELECT version FROM meta WHERE k = 1")[0]!.version;
  return {
    owner: s.owner,
    audience: s.audience,
    writers: writers === "members" ? "members" : [...new Set([...writers, ...agents])],
    agents: [...agents],
    readers,
    machine: s.machine,
    revision: version,
  };
}

// ------------------------------------------------------------------ the transaction

export interface OccurInput {
  key: string;
  kind: string;
  sessionId?: string | null;
  trackId?: string | null;
  by: string | null;
  audience: string;
  at?: number;
}

export interface OpInput {
  by: string;
  name: string;
  args: unknown;
  /** What `undo` applies; null for none. */
  inverse: unknown;
  /** The fields this operation set, with the values it gave them: `undo` applies only if they still hold. */
  fields: Record<string, unknown>;
  sessionId?: string | null;
  trackId?: string | null;
  audience: string;
}

export interface NewSession {
  id: string;
  owner: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  origin: Origin;
  slackThreadKey?: string | null;
  machine: string;
  role?: "track" | "start" | null;
  createdBy: string;
  title?: string | null;
  titleBy?: string | null;
  writers?: "members" | string[];
  metadata?: Record<string, string>;
  summary: Summary;
  createHash?: string | null;
  createdAt?: number;
  revision?: number;
  aside?: string | null;
  /** Default: `audienceOf(owner, origin, role)`. */
  audience?: string;
}

export interface NewPlace {
  sessionId: string;
  trackId?: string | null;
  placedBy: string;
  parentSession?: string | null;
  position?: number;
  doneAt?: number | null;
  audience: string;
}

/** The body of the owed `Live.publish`: the range of feed versions. */
export type PublishOwed = { from: number; to: number };

export class Tx {
  private v: number | null = null;
  private woke: number[] = [];

  constructor(
    readonly sql: Sql,
    readonly now: number,
  ) {}

  /** The one new `meta.version` of this transaction, allocated on first use. */
  version(): number {
    if (this.v === null) this.v = this.sql.exec<{ version: number }>("UPDATE meta SET version = version + 1 WHERE k = 1 RETURNING version")[0]!.version;
    return this.v;
  }

  /** Whether this transaction changed the feed. */
  get changed(): boolean {
    return this.v !== null;
  }

  /** Set a row's `version` to this transaction's. A `place` takes its `session` row with it (`archived` is derived from it). */
  stamp(table: FeedTable, ...key: string[]): void {
    const columns = FEED_TABLES[table] as readonly string[];
    if (key.length !== columns.length) throw new Error(`stamp ${table}: ${columns.length} key value(s)`);
    this.sql.exec(`UPDATE ${table} SET version = ? WHERE ${columns.map((c) => `${c} = ?`).join(" AND ")}`, this.version(), ...key);
    if (table === "place") this.sql.exec("UPDATE session SET version = ? WHERE id = ?", this.version(), key[0]);
  }

  /** A row left the feed for these audiences (spec 35.1, "Removing a row"). */
  gone(kind: FeedTable, id: string, audiences: string[]): void {
    for (const audience of new Set(audiences)) {
      this.sql.exec("INSERT OR REPLACE INTO gone (kind, id, audience, version, at) VALUES (?, ?, ?, ?, ?)", kind, id, audience, this.version(), this.now);
    }
  }

  /** Delete a feed row and write its `gone` row. False when there was none. */
  remove(table: FeedTable, ...key: string[]): boolean {
    const columns = FEED_TABLES[table] as readonly string[];
    const where = columns.map((c) => `${c} = ?`).join(" AND ");
    const row = this.sql.exec<{ audience: string }>(`DELETE FROM ${table} WHERE ${where} RETURNING audience`, ...key)[0];
    if (!row) return false;
    this.gone(table, key[key.length - 1]!, [row.audience]);
    return true;
  }

  /** Write an occurrence with a new `meta.occ`; idempotent by `key`. True when it was written. */
  occur(o: OccurInput): boolean {
    if (this.sql.exec("SELECT 1 FROM occurrence WHERE key = ?", o.key).length > 0) return false;
    const n = this.sql.exec<{ occ: number }>("UPDATE meta SET occ = occ + 1 WHERE k = 1 RETURNING occ")[0]!.occ;
    this.sql.exec(
      "INSERT INTO occurrence (n, key, kind, session_id, track_id, by, at, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      n,
      o.key,
      o.kind,
      o.sessionId ?? null,
      o.trackId ?? null,
      o.by,
      o.at ?? this.now,
      o.audience,
    );
    if (WAKE_KINDS.has(o.kind)) this.woke.push(n);
    if (ECHO_KINDS.has(o.kind)) owed.add(this.sql, { group: `slack:${o.sessionId ?? "machine"}`, call: "Slack.notify", body: { n }, schedule: NOTICE_RETRY_MS });
    return true;
  }

  /** An occurrence Org itself causes, of a session: keyed by this transaction's version, so one per kind, session and transaction. */
  occurFor(kind: string, s: Pick<SessionRec, "id" | "audience">, by: string | null, trackId?: string | null): boolean {
    const track = trackId === undefined ? (readPlace(this.sql, s.id)?.track_id ?? null) : trackId;
    return this.occur({ key: `${s.id}:org:${this.version()}:${kind}`, kind, sessionId: s.id, trackId: track, by, audience: s.audience });
  }

  /** The operation's row (spec 19.3): in the feed, with the session's `lastSeq` when it was applied. Its id. */
  op(o: OpInput): string {
    const id = mint("op");
    const session = o.sessionId ? readSession(this.sql, o.sessionId) : null;
    this.sql.exec(
      "INSERT INTO op (id, at, by, name, args, inverse, fields, session_id, track_id, at_seq, version, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      this.now,
      o.by,
      o.name,
      JSON.stringify(o.args ?? null),
      o.inverse === null || o.inverse === undefined ? null : JSON.stringify(o.inverse),
      JSON.stringify(o.fields),
      o.sessionId ?? null,
      o.trackId ?? null,
      session ? summaryOf(session).lastSeq : null,
      this.version(),
      o.audience,
    );
    return id;
  }

  /** Insert a session (spec 40.1, 40.7). The caller inserts its `place` (none for a track's agent) and owes `start`. */
  addSession(n: NewSession): SessionRec {
    const audience = n.audience ?? audienceOf(n.owner, n.origin, n.role ?? null);
    const active = n.summary.lastActiveAt ? Date.parse(n.summary.lastActiveAt) : NaN;
    this.sql.exec(
      `INSERT INTO session (id, owner, owner_name, owner_email, origin, slack_thread_key, machine, role, created_at, created_by, title, title_by,
         writers, aside, metadata, blocked, revision, summary, create_hash, last_active_at, version, audience)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      n.id,
      n.owner,
      n.ownerName ?? null,
      n.ownerEmail ?? null,
      JSON.stringify(n.origin),
      n.slackThreadKey ?? null,
      n.machine,
      n.role ?? null,
      n.createdAt ?? this.now,
      n.createdBy,
      n.title ?? null,
      n.titleBy ?? null,
      JSON.stringify(n.writers ?? "members"),
      n.aside ?? null,
      n.metadata ? JSON.stringify(n.metadata) : null,
      n.revision ?? 0,
      JSON.stringify(n.summary),
      n.createHash ?? null,
      Number.isFinite(active) ? active : (n.createdAt ?? this.now),
      this.version(),
      audience,
    );
    return readSession(this.sql, n.id)!;
  }

  addPlace(n: NewPlace): PlaceRec {
    this.sql.exec(
      "INSERT INTO place (session_id, track_id, position, placed_by, parent_session, done_at, version, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      n.sessionId,
      n.trackId ?? null,
      n.position ?? this.now,
      n.placedBy,
      n.parentSession ?? null,
      n.doneAt ?? null,
      this.version(),
      n.audience,
    );
    return readPlace(this.sql, n.sessionId)!;
  }

  /** Recompute a session's `blocked` (spec 35.1): an open ask, a failed last turn, or `place.attention`. Stamps when it changed. */
  reblock(sessionId: string): boolean {
    const s = readSession(this.sql, sessionId);
    if (!s) return false;
    const summary = summaryOf(s);
    const attention = readPlace(this.sql, sessionId)?.attention ?? null;
    const blocked = summary.asks.some((a) => a.status === "open") || summary.lastTurn?.status === "failed" || attention !== null ? 1 : 0;
    if (blocked === s.blocked) return false;
    this.sql.exec("UPDATE session SET blocked = ?, version = ? WHERE id = ?", blocked, this.version(), sessionId);
    return true;
  }

  // ---------------------------------------------------------------- owed calls (spec 35.1)

  /** A call Org owes another actor because of this transaction. The Durable Object's `send` must know `call`. */
  owe(o: Owed): void {
    owed.add(this.sql, o);
  }

  /** `SessionLog.setAccess` and `Computer.setAccess` for a session, computed from the rows when sent. */
  sendAccess(sessionId: string): void {
    this.owe({ group: sessionId, key: `access:log:${sessionId}`, call: "SessionLog.setAccess", body: { sessionId } });
    this.owe({ group: sessionId, key: `access:host:${sessionId}`, call: "Computer.setAccess", body: { sessionId } });
  }

  /** `Computer.start` for a session, its spec built from the rows when sent. `firstInput`: a platform turn accepted before it (spec 40.7 step 3). */
  start(sessionId: string, extra: { harness?: string; trace?: string; firstInput?: string } = {}): void {
    if (extra.firstInput !== undefined) {
      this.owe({ group: sessionId, call: "SessionLog.accept", body: { sessionId, id: `tn_${sessionId.slice(3, 15)}`, kind: "turn", body: { input: extra.firstInput, ifBusy: "queue" } } });
    }
    this.owe({ group: sessionId, key: `start:${sessionId}`, call: "Computer.start", body: { sessionId, harness: extra.harness, trace: extra.trace } });
  }

  /** An `interrupt` entry to a session's inbox, as the platform (spec 39, `thread.done`). */
  interrupt(sessionId: string): void {
    this.owe({ group: sessionId, call: "SessionLog.accept", body: { sessionId, id: `int_${this.version()}_${sessionId}`, kind: "interrupt", body: {} } });
  }

  /** `Computer.stop`: the runner of a session that is being removed. */
  stop(sessionId: string, machine: string): void {
    this.owe({ group: sessionId, call: "Computer.stop", body: { sessionId, machine } });
  }

  /** `SessionLog.destroy`: the log of a session that was removed. */
  destroy(sessionId: string): void {
    this.owe({ group: sessionId, call: "SessionLog.destroy", body: { sessionId } });
  }

  /**
   * Run `fn` so that its writes are undone if it answers a refusal (`ok: false`) or throws: a
   * refused mutation changes no row (spec 37.3 step 4), whatever it wrote before it refused.
   */
  attempt<T extends { ok: boolean }>(fn: () => T): T {
    const before = { v: this.v, woke: this.woke.length };
    let out: T | undefined;
    try {
      this.sql.transaction(() => {
        out = fn();
        if (!out.ok) throw ROLLBACK;
      });
    } catch (error) {
      this.v = before.v;
      this.woke.length = before.woke;
      if (error !== ROLLBACK) throw error;
    }
    return out as T;
  }

  /**
   * The transaction's end: the owed publish and wakes. `transact` calls it. A target's wakes within
   * WAKE_DEBOUNCE_MS of its first go as one turn, its digest built from the rows when it is sent.
   */
  end(): void {
    if (this.v !== null) owed.add(this.sql, { group: "live", key: "live:feed", call: "Live.publish", body: { from: this.v - 1, to: this.v } satisfies PublishOwed });
    for (const n of this.woke) {
      for (const target of wakeTargets(this.sql, n)) {
        owed.debounce(
          this.sql,
          { group: `wake:${target}`, call: "SessionLog.wake", body: { sessionId: target, id: mint("tn").slice(0, 15), fromN: n, toN: n }, at: this.now + WAKE_DEBOUNCE_MS, schedule: NOTICE_RETRY_MS },
          (pending) => ({ ...(pending as object), toN: n }),
        );
      }
    }
  }
}

const ROLLBACK = Symbol("rollback");

/**
 * The sessions occurrence `n` wakes: its thread's track's agent and its parent (a track's own
 * occurrence: its agent). Never the session it is of, and never an agent by its own act.
 */
function wakeTargets(sql: Sql, n: number): string[] {
  const o = sql.exec<{ session_id: string | null; track_id: string | null; by: string | null }>("SELECT session_id, track_id, by FROM occurrence WHERE n = ?", n)[0];
  if (!o) return [];
  const place = o.session_id ? readPlace(sql, o.session_id) : null;
  const trackId = place?.track_id ?? o.track_id;
  const targets = [trackId ? (readTrack(sql, trackId)?.agent_session ?? null) : null, place?.parent_session ?? null];
  return [...new Set(targets.filter((t): t is string => t !== null && t !== o.session_id && o.by !== `agent:${t}`))];
}

/** One Org transaction: `fn` over a `Tx`, then the owed publish and wakes, all or nothing. */
export function transact<T>(sql: Sql, now: number, fn: (tx: Tx) => T): T {
  return sql.transaction(() => {
    const tx = new Tx(sql, now);
    const out = fn(tx);
    tx.end();
    return out;
  });
}

/** The rows and gone entries of one version, with audiences: what `Live.publish('feed', …)` carries (spec 40.4). */
export function changesAt(sql: Sql, version: number): { rows: (Row & { audience: string })[]; gone: { kind: string; id: string; audience: string }[] } {
  const rows: (Row & { audience: string })[] = [];
  for (const table of Object.keys(FEED_TABLES) as FeedTable[]) {
    for (const raw of sql.exec<Raw>(`SELECT * FROM ${table} WHERE version = ?`, version)) rows.push(rowOf(sql, table, raw));
  }
  const gone = sql.exec<{ kind: string; id: string; audience: string }>("SELECT kind, id, audience FROM gone WHERE version = ?", version);
  return { rows, gone };
}

export { byOf };
