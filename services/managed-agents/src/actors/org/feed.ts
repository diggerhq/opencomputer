// Org's feed, occurrence stream, mutation envelope and summary slot (spec 37.1, 37.3, 40.3, 40.4).
// Pure functions over `Sql`.

import type { FeedFrame, FeedPush, MutateReply, MutateRequest, Occurrence, Row, SummaryPub } from "./contract.js";
import type { Summary } from "../session-log/contract.js";
import { cursor } from "../../durable/cursor.js";
import { platformPrincipal, type Principal } from "../../auth/principal.js";
import type { Sql } from "../../durable/sql.js";
import { idem } from "../../durable/idempotency.js";
import { runMutation } from "./mutations/run.js";
import { FEED_KINDS, FEED_TABLES, type FeedTable } from "./schema.js";
import { isPerson } from "./audience.js";
import { forClient, rowOf } from "./feed-rows.js";
import { iso } from "./iso.js";
import { DAY_MS, FEED_ROWS_MAX, IDEM_TTL_MS, PUSH_BYTES_MAX } from "./limits.js";
import { readPlace, readSession, readTrack } from "./records.js";
import { summaryOf } from "./summary.js";
import { changesAt, transact, type PublishOwed, type Tx } from "./tx.js";
import { audiencesOf, readsWork } from "./who-may.js";

type Meta = { version: number; occ: number; floor: number; org: string | null };
export const metaOf = (sql: Sql): Meta => sql.exec<Meta>("SELECT version, occ, floor, org FROM meta WHERE k = 1")[0]!;

/** The kinds a key without `work:read` reads (`readsWork`): the session API's, of every audience it reads. */
const CORE_KINDS: FeedTable[] = ["session", "machine"];

// ------------------------------------------------------------------ the feed read (spec 37.1)

export type FeedRead = FeedFrame | { reset: true; cursor: null };

/** The WHERE of the rows a snapshot leaves out for a table: those of a thread in Earlier, and old ops. */
function snapshotWhere(table: FeedTable, now: number): { sql: string; args: unknown[] } {
  const earlier = "(SELECT session_id FROM place WHERE earlier_at IS NOT NULL)";
  switch (table) {
    case "session":
      return { sql: `id NOT IN ${earlier}`, args: [] };
    case "place":
      return { sql: "earlier_at IS NULL", args: [] };
    case "result":
      return { sql: `session_id NOT IN ${earlier}`, args: [] };
    case "proposal":
      return { sql: `target NOT IN ${earlier}`, args: [] };
    case "op":
      return { sql: `(session_id IS NULL OR session_id NOT IN ${earlier}) AND at > ?`, args: [now - DAY_MS] };
    default:
      return { sql: "1", args: [] };
  }
}

export function feed(sql: Sql, now: number, p: Principal, q: { after?: string; kinds?: string[] }): FeedRead {
  return sql.transaction(() => {
    const meta = metaOf(sql);
    let after = 0;
    const snapshot = q.after === undefined;
    if (q.after !== undefined) {
      const parts = cursor.read("f", q.after);
      if (!parts || (parts[0] as number) < meta.floor || (parts[0] as number) > meta.version) return { reset: true, cursor: null };
      after = parts[0] as number;
    }
    const audiences = audiencesOf(p);
    const work = readsWork(p);
    const kinds = FEED_KINDS.filter((k) => (q.kinds === undefined || q.kinds.includes(k)) && (work || CORE_KINDS.includes(k)));
    const marks = audiences.map(() => "?").join(",");
    const scoped = (table: FeedTable) => {
      const extra = snapshot ? snapshotWhere(table, now) : { sql: "1", args: [] };
      return { where: `version > ? AND audience IN (${marks}) AND ${extra.sql}`, args: [after, ...audiences, ...extra.args] };
    };

    // The version to stop at: the one holding the 2,000th row, whole (a version is never split).
    let to = meta.version;
    if (audiences.length > 0 && kinds.length > 0) {
      // Counted a table at a time: SQLite here allows few terms in a compound SELECT.
      const counts = new Map<number, number>();
      for (const table of kinds) {
        const s = scoped(table);
        for (const row of sql.exec<{ version: number; c: number }>(`SELECT version, COUNT(*) AS c FROM ${table} WHERE ${s.where} GROUP BY version ORDER BY version LIMIT ?`, ...s.args, FEED_ROWS_MAX)) {
          counts.set(row.version, (counts.get(row.version) ?? 0) + row.c);
        }
      }
      let total = 0;
      for (const version of [...counts.keys()].sort((x, y) => x - y)) {
        total += counts.get(version)!;
        if (total >= FEED_ROWS_MAX) {
          to = Math.min(to, version);
          break;
        }
      }
    }

    const rows: Row[] = [];
    if (audiences.length > 0) {
      for (const table of kinds) {
        const s = scoped(table);
        const keys = (FEED_TABLES[table] as readonly string[]).join(", ");
        for (const raw of sql.exec<Record<string, unknown> & { version: number; audience: string }>(`SELECT * FROM ${table} WHERE ${s.where} AND version <= ? ORDER BY version, ${keys}`, ...s.args, to)) {
          rows.push(forClient(rowOf(sql, table, raw)));
        }
      }
    }
    const gone =
      snapshot || audiences.length === 0
        ? []
        : sql
            .exec<{ kind: string; id: string }>(`SELECT kind, id FROM gone WHERE version > ? AND version <= ? AND audience IN (${marks}) ORDER BY version`, after, to, ...audiences)
            .filter((g) => kinds.includes(g.kind as FeedTable));

    const frame: FeedFrame = {
      protocol: 1,
      org: meta.org ?? p.org,
      subject: p.subject,
      from: snapshot ? null : cursor.encode("f", [after]),
      to: cursor.encode("f", [to]),
      more: to < meta.version,
      rows,
      gone,
      version: to,
    };

    // Earlier's counts are of places, Work proper.
    if (snapshot && audiences.length > 0 && work) {
      const earlier = sql.exec<{ track_id: string | null; c: number }>(`SELECT track_id, COUNT(*) AS c FROM place WHERE earlier_at IS NOT NULL AND audience IN (${marks}) GROUP BY track_id`, ...audiences);
      const trackEarlier: Record<string, number> = {};
      for (const row of earlier) if (row.track_id !== null) trackEarlier[row.track_id] = row.c;
      frame.counts = { earlier: earlier.reduce((sum, row) => sum + row.c, 0), trackEarlier };
    } else if (snapshot) frame.counts = { earlier: 0, trackEarlier: {} };

    return frame;
  });
}

// ------------------------------------------------------------------ publishing (spec 40.4)

/** What to send Live for an owed publish: the range's rows when it is still the head and fits, else the head alone. */
export function publishFrame(sql: Sql, body: PublishOwed, whole: boolean): FeedPush | { head: string } {
  const head = metaOf(sql).version;
  if (!whole || body.to !== head) return { head: cursor.encode("f", [head]) };
  const push: FeedPush = { from: cursor.encode("f", [body.from]), to: cursor.encode("f", [body.to]), ...changesAt(sql, body.to), version: body.to };
  return JSON.stringify(push).length > PUSH_BYTES_MAX ? { head: push.to } : push;
}

// ------------------------------------------------------------------ occurrences (spec 37.1, 40.6)

type OccRec = { n: number; key: string; kind: string; session_id: string | null; track_id: string | null; by: string | null; at: number; audience: string };

export function occurrences(sql: Sql, p: Principal, q: { after?: string; limit?: number }): { entries: Occurrence[]; to: string } | { reset: true; cursor: null } {
  let after = 0;
  if (q.after !== undefined) {
    const parts = cursor.read("o", q.after);
    if (!parts || (parts[0] as number) > metaOf(sql).occ) return { reset: true, cursor: null };
    after = parts[0] as number;
  }
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 1_000);
  let rows: OccRec[];
  if (p.kind === "platform") rows = sql.exec<OccRec>("SELECT * FROM occurrence WHERE n > ? ORDER BY n LIMIT ?", after, limit);
  else {
    const audiences = audiencesOf(p);
    if (audiences.length === 0) return { entries: [], to: cursor.encode("o", [after]) };
    // A key without `work:read` reads its sessions' occurrences, not a track's own (`track.quiet`).
    const work = readsWork(p) ? "" : " AND (session_id IS NOT NULL OR audience = 'org')";
    rows = sql.exec<OccRec>(`SELECT * FROM occurrence WHERE n > ? AND audience IN (${audiences.map(() => "?").join(",")})${work} ORDER BY n LIMIT ?`, after, ...audiences, limit);
  }
  const entries = rows.map((r): Occurrence => ({ n: String(r.n), key: r.key, kind: r.kind, sessionId: r.session_id, trackId: r.track_id, by: r.by, at: iso(r.at) }));
  // A short page reached the head: the next read starts there, past entries of other audiences.
  const to = rows.length === limit ? rows[rows.length - 1]!.n : metaOf(sql).occ;
  return { entries, to: cursor.encode("o", [Math.max(to, after)]) };
}

// ------------------------------------------------------------------ mutate (spec 37.3)

type MutateError = Extract<MutateReply, { error: unknown }>["error"];

function apply(tx: Tx, p: Principal, m: MutateRequest): { protocol: 1; value?: unknown } | { error: MutateError } {
  // `person` is the edge's, never the body's: a body's is replaced.
  const args = typeof m.args === "object" && m.args !== null && !Array.isArray(m.args) ? { ...(m.args as Record<string, unknown>), person: m.person } : m.args;
  const out = runMutation(tx, p, m.name, args);
  if (out.ok) return { protocol: 1, ...(out.value !== undefined ? { value: out.value } : {}) };
  const { ok: _ok, ...error } = out;
  return { error: error as MutateError };
}

/** The key of a mutation's `Idempotency-Key`: a member's is the person's, since signing in again changes the credential. */
function idemKey(p: Principal, key: string): string | null {
  if (p.kind === "agent") return `tool:${p.session ?? p.subject}:${key}`;
  if (p.kind === "member") return `member:${p.subject}:${key}`;
  if (p.kind === "key") return `key:${p.credential.id}:${key}`;
  return null;
}

/** `hash`: the request's (name and args). With an `Idempotency-Key`, a retry gets the first reply, `version` included. */
export function mutate(sql: Sql, now: number, p: Principal, m: MutateRequest, hash: string): MutateReply {
  return transact(sql, now, (tx) => {
    const run = (): MutateReply => {
      const reply = apply(tx, p, m);
      return "error" in reply ? reply : { ...reply, version: tx.changed ? tx.version() : metaOf(sql).version };
    };
    const key = m.idem !== undefined ? idemKey(p, m.idem) : null;
    if (key === null) return run();
    const stored = idem.get(sql, key, hash);
    if (stored && "conflict" in stored) return { error: { code: "idempotency_conflict" } };
    if (stored) return stored.result as MutateReply;
    const reply = run();
    idem.put(sql, key, hash, reply, IDEM_TTL_MS);
    return reply;
  });
}

// ------------------------------------------------------------------ the summary slot (spec 40.3, 39)

/** Reopen a done thread, and its track if done, because a person replied (spec 39, `rule:reply`). */
function reopen(tx: Tx, sessionId: string): void {
  const place = readPlace(tx.sql, sessionId);
  if (!place) return;
  const platform = platformPrincipal(metaOf(tx.sql).org ?? "");
  runMutation(tx, platform, "thread.reopen", { sid: sessionId, by: "rule:reply" });
  if (place.track_id !== null && readTrack(tx.sql, place.track_id)?.done_at != null) runMutation(tx, platform, "track.reopen", { tid: place.track_id, by: "rule:reply" });
}

export function acceptSummary(sql: Sql, now: number, pub: SummaryPub): { accepted: boolean; revision: number } {
  return transact(sql, now, (tx) => {
    const s = readSession(sql, pub.sessionId);
    // A session Org does not hold (deleted): answered as taken, so its log stops sending.
    if (!s) return { accepted: false, revision: pub.revision };
    if (pub.revision <= s.revision) return { accepted: false, revision: s.revision };
    const before = summaryOf(s);
    // What Org gave the session at its creation holds until the log says otherwise.
    const next: Summary = { ...pub.summary, agentTitle: pub.summary.agentTitle ?? before.agentTitle ?? null, settings: pub.summary.settings ?? before.settings, revision: pub.revision };
    const active = next.lastActiveAt ? Date.parse(next.lastActiveAt) : NaN;
    sql.exec("UPDATE session SET summary = ?, revision = ?, last_active_at = ? WHERE id = ?", JSON.stringify(next), pub.revision, Number.isFinite(active) ? active : (s.last_active_at ?? s.created_at), s.id);
    tx.stamp("session", s.id);

    const place = readPlace(sql, s.id);
    const track = place?.track_id ?? null;
    let any = false;
    let reply = false;
    for (const o of pub.occurrences) {
      const written = tx.occur({ key: `${s.id}:${o.epoch}:${o.seq}`, kind: o.kind, sessionId: s.id, trackId: track, by: o.by, audience: s.audience, at: o.at });
      any ||= written;
      reply ||= written && o.kind === "message.received" && isPerson(o.by);
    }
    // A refused entry not seen before (spec 39): `turn.refused`, idempotent by its key.
    for (const entry of next.inbox ?? []) {
      if (entry.error !== null) tx.occur({ key: `${s.id}:inbox:${entry.id}`, kind: "turn.refused", sessionId: s.id, trackId: track, by: "platform", audience: s.audience });
    }
    if (place) {
      if (reply) {
        // rule:reply
        if (place.attention !== null) {
          sql.exec("UPDATE place SET attention = NULL WHERE session_id = ?", s.id);
          tx.stamp("place", s.id);
        }
        if (place.done_at !== null) reopen(tx, s.id);
      }
      // rule:activity
      if (any && readPlace(sql, s.id)!.earlier_at !== null) {
        sql.exec("UPDATE place SET earlier_at = NULL WHERE session_id = ?", s.id);
        tx.stamp("place", s.id);
      }
    }
    tx.reblock(s.id);
    return { accepted: true, revision: pub.revision };
  });
}
