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


import type { Origin } from "../../api-objects/objects.js";
import type { Row } from "./contract.js";
import type { Summary } from "../session-log/contract.js";
import { byOf, type Principal } from "../../auth/principal.js";
import { crockfordId } from "../../ids/crockford.js";
import { firstTurnId } from "../../ids/session-ids.js";
import type { Sql } from "../../durable/sql.js";
import { owed, type Owed } from "../../durable/outbox.js";
import { FEED_TABLES, type FeedTable } from "./schema.js";
import { NOTICE_RETRY_MS, WAKE_DEBOUNCE_MS } from "./limits.js";
import { readPlace, readSession, readTrack, type PlaceRec, type Raw, type SessionRec } from "./records.js";
import { audienceOf } from "./audience.js";
import { summaryOf } from "./summary.js";
import { rowOf } from "./feed-rows.js";

/** The occurrence kinds that wake a track's agent or a parent session, and those the Slack echo posts (spec 40.6). */
const WAKE_KINDS = new Set(["turn.completed", "turn.failed", "ask.opened", "result.changed", "thread.done", "thread.placed", "track.quiet"]);
const ECHO_KINDS = new Set(["turn.refused", "machine.changed"]);
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
    const id = crockfordId("op");
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

  /**
   * `Computer.start` for a session, its spec built from the rows when sent. `firstInput`: a turn accepted
   * before it (spec 40.7 step 3), as `turnId` (else the session's first turn id) from `as` (else the platform).
   */
  start(sessionId: string, extra: { harness?: string; trace?: string; firstInput?: string; turnId?: string; as?: Principal } = {}): void {
    if (extra.firstInput !== undefined) {
      const turn = { input: extra.firstInput, ifBusy: "queue" };
      this.accept(sessionId, { id: extra.turnId ?? firstTurnId(sessionId), kind: "turn", body: turn, trace: extra.trace }, extra.as);
    }
    this.owe({ group: sessionId, key: `start:${sessionId}`, call: "Computer.start", body: { sessionId, harness: extra.harness, trace: extra.trace } });
  }

  /** An entry to a session's inbox, from `as` (else the platform): `SessionLog.accept`, owed. */
  accept(sessionId: string, entry: { id: string; kind: string; body: unknown; trace?: string }, as?: Principal): void {
    this.owe({ group: sessionId, call: "SessionLog.accept", body: { sessionId, id: entry.id, kind: entry.kind, body: entry.body, ...(entry.trace ? { trace: entry.trace } : {}), ...(as ? { principal: as } : {}) } });
  }

  /** An `interrupt` entry to a session's inbox, as the platform (spec 39, `thread.done`). */
  interrupt(sessionId: string): void {
    this.accept(sessionId, { id: `int_${this.version()}_${sessionId}`, kind: "interrupt", body: {} });
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
          { group: `wake:${target}`, call: "SessionLog.wake", body: { sessionId: target, id: crockfordId("tn", 12), fromN: n, toN: n }, at: this.now + WAKE_DEBOUNCE_MS, schedule: NOTICE_RETRY_MS },
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
