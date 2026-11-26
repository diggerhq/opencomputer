// Org's feed, occurrence stream, mutation envelope and summary slot (spec 37.1, 37.3, 40.3, 40.4).
// Pure functions over `Sql`.

import type { FeedFrame, FeedPush, MutateReply, MutateRequest, Occurrence, Row, Summary, SummaryPub } from "../actor/contracts.js";
import { cursor } from "../actor/cursor.js";
import { platformPrincipal, type Principal } from "../actor/principal.js";
import type { Sql } from "../actor/sql.js";
import { idem } from "../actor/store.js";
import { runMutation } from "./mutations/index.js";
import { FEED_KINDS, FEED_TABLES, type FeedTable } from "./schema.js";
import {
  DAY_MS,
  FEED_ROWS_MAX,
  IDEM_TTL_MS,
  PUSH_BYTES_MAX,
  audiencesOf,
  changesAt,
  forClient,
  iso,
  isPerson,
  parse,
  readPlace,
  readSession,
  readTrack,
  rowOf,
  summaryOf,
  transact,
  type PublishOwed,
  type Tx,
} from "./tx.js";

type Meta = { version: number; occ: number; floor: number; org: string | null };
export const metaOf = (sql: Sql): Meta => sql.exec<Meta>("SELECT version, occ, floor, org FROM meta WHERE k = 1")[0]!;

/** The kinds a key without `work:read` reads: the session API's. */
const CORE_KINDS: FeedTable[] = ["session", "machine"];

// ------------------------------------------------------------------ the feed read (spec 37.1)

export type FeedRead = { frame: FeedFrame; sumOver: string[] | null } | { reset: true; cursor: null };

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

export function feed(sql: Sql, now: number, p: Principal, q: { after?: string; kinds?: string[]; clientId?: string; ack?: number; sum?: boolean }): FeedRead {
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
    const work = p.kind !== "key" || p.scopes.includes("work:read" as never);
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
    };

    if (q.clientId !== undefined) {
      const client = sql.exec<{ last_mutation: number; errors: string }>("SELECT last_mutation, errors FROM client WHERE principal = ? AND client_id = ?", p.subject, q.clientId)[0];
      if (client) {
        let errors = parse<{ n: number; code: string; reason: string }[]>(client.errors, []);
        if (q.ack !== undefined) errors = errors.filter((e) => e.n > q.ack!);
        sql.exec("UPDATE client SET errors = ?, seen_at = ? WHERE principal = ? AND client_id = ?", JSON.stringify(errors), now, p.subject, q.clientId);
        frame.lastMutation = client.last_mutation;
        frame.errors = errors;
      } else {
        frame.lastMutation = 0;
        frame.errors = [];
      }
    }

    if (snapshot && audiences.length > 0) {
      const earlier = sql.exec<{ track_id: string | null; c: number }>(`SELECT track_id, COUNT(*) AS c FROM place WHERE earlier_at IS NOT NULL AND audience IN (${marks}) GROUP BY track_id`, ...audiences);
      const trackEarlier: Record<string, number> = {};
      for (const row of earlier) if (row.track_id !== null) trackEarlier[row.track_id] = row.c;
      frame.counts = { earlier: earlier.reduce((sum, row) => sum + row.c, 0), trackEarlier };
    } else if (snapshot) frame.counts = { earlier: 0, trackEarlier: {} };

    // What `sum` covers: every track, place and session row a snapshot at `to` would send.
    let sumOver: string[] | null = null;
    if (q.sum) {
      sumOver = [];
      if (audiences.length > 0) {
        for (const table of ["track", "place", "session"] as const) {
          if (!kinds.includes(table)) continue;
          const extra = snapshotWhere(table, now);
          const key = (FEED_TABLES[table] as readonly string[])[0]!;
          for (const row of sql.exec<{ id: string; version: number }>(`SELECT ${key} AS id, version FROM ${table} WHERE version <= ? AND audience IN (${marks}) AND ${extra.sql}`, to, ...audiences, ...extra.args)) {
            sumOver.push(`${table}|${row.id}|${row.version}`);
          }
        }
      }
    }
    return { frame, sumOver };
  });
}

/** The XOR of the first 8 bytes of SHA-256 of each entry, as 16 hex digits (spec 37.1, `sum`). */
export async function checksum(entries: string[]): Promise<string> {
  const acc = new Uint8Array(8);
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(entry)));
    for (let i = 0; i < 8; i += 1) acc[i]! ^= digest[i]!;
  }
  return [...acc].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ publishing (spec 40.4)

/** What to send Live for an owed publish: the range's rows when it is still the head and fits, else the head alone. */
export function publishFrame(sql: Sql, body: PublishOwed, whole: boolean): FeedPush | { head: string } {
  const head = metaOf(sql).version;
  if (!whole || body.to !== head) return { head: cursor.encode("f", [head]) };
  const push: FeedPush = { from: cursor.encode("f", [body.from]), to: cursor.encode("f", [body.to]), ...(body.from === body.to ? { rows: [], gone: [] } : changesAt(sql, body.to)), mutations: body.mutations };
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
    rows = sql.exec<OccRec>(`SELECT * FROM occurrence WHERE n > ? AND audience IN (${audiences.map(() => "?").join(",")}) ORDER BY n LIMIT ?`, after, ...audiences, limit);
  }
  const entries = rows.map((r): Occurrence => ({ n: String(r.n), key: r.key, kind: r.kind, sessionId: r.session_id, trackId: r.track_id, by: r.by, at: iso(r.at), ...(p.kind === "platform" ? { audience: r.audience } : {}) }));
  // A short page reached the head: the next read starts there, past entries of other audiences.
  const to = rows.length === limit ? rows[rows.length - 1]!.n : metaOf(sql).occ;
  return { entries, to: cursor.encode("o", [Math.max(to, after)]) };
}

// ------------------------------------------------------------------ mutate (spec 37.3)

type MutateError = Extract<MutateReply, { error: unknown }>["error"];

function apply(tx: Tx, p: Principal, m: MutateRequest): { reply: MutateReply; refused: { code: string; reason: string } | null } {
  // `person` is the edge's, never the body's: a body's is replaced.
  const args = typeof m.args === "object" && m.args !== null && !Array.isArray(m.args) ? { ...(m.args as Record<string, unknown>), person: m.person } : m.args;
  const out = runMutation(tx, p, m.name, args);
  if (out.ok) return { reply: { protocol: 1, ...(out.value !== undefined ? { value: out.value } : {}) }, refused: null };
  const { ok: _ok, ...error } = out;
  return { reply: { error: error as MutateError }, refused: { code: out.code, reason: out.reason } };
}

/** `hash`: the request's (name and args), for the `idem` path. */
export function mutate(sql: Sql, now: number, p: Principal, m: MutateRequest, hash: string): MutateReply {
  return transact(sql, now, (tx) => {
    if (m.client && (p.kind === "member" || p.kind === "key")) {
      const { id, n } = m.client;
      if (!Number.isSafeInteger(n) || n < 1) return { error: { code: "invalid_request", reason: "n" } };
      const other = sql.exec<{ principal: string }>("SELECT principal FROM client WHERE client_id = ? AND principal != ?", id, p.subject)[0];
      if (other) return { error: { code: "principal_mismatch" } };
      sql.exec("INSERT INTO client (principal, client_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(principal, client_id) DO UPDATE SET seen_at = excluded.seen_at", p.subject, id, now);
      const client = sql.exec<{ last_mutation: number; errors: string }>("SELECT last_mutation, errors FROM client WHERE principal = ? AND client_id = ?", p.subject, id)[0]!;
      if (n <= client.last_mutation) return { protocol: 1, lastMutation: client.last_mutation };
      if (n > client.last_mutation + 1) return { error: { code: "out_of_order", lastMutation: client.last_mutation } };
      const { reply, refused } = apply(tx, p, m);
      const errors = parse<{ n: number; code: string; reason: string }[]>(client.errors, []);
      if (refused) errors.push({ n, ...refused });
      sql.exec("UPDATE client SET last_mutation = ?, errors = ? WHERE principal = ? AND client_id = ?", n, JSON.stringify(errors.slice(-100)), p.subject, id);
      tx.confirms(id, n, errors);
      return "error" in reply ? { error: { ...reply.error, lastMutation: n } } : { ...reply, lastMutation: n };
    }
    if (m.idem !== undefined && p.kind !== "platform") {
      const key = p.kind === "agent" ? `tool:${p.session ?? p.subject}:${m.idem}` : `key:${p.credential.id}:${m.idem}`;
      const stored = idem.get(sql, key, hash);
      if (stored && "conflict" in stored) return { error: { code: "idempotency_conflict" } };
      if (stored) return stored.result as MutateReply;
      const { reply } = apply(tx, p, m);
      idem.put(sql, key, hash, reply, IDEM_TTL_MS);
      return reply;
    }
    return apply(tx, p, m).reply;
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
