// Org's arrows in from the machine and GitHub, the work reads, the digest, the Slack echo
// and ageing (spec 36.1, 37.1, 40.6, 40.8, 40.9). Pure functions over `Sql`.

import type { DocRev, MachinePub, Overview, PullPub, ResultRow, ReviewRow, Row, SlackEcho } from "./contract.js";
import type { Reply } from "../../durable/rpc-reply.js";
import { cursor } from "../../durable/cursor.js";
import { byOf, platformPrincipal, type Principal } from "../../auth/principal.js";
import { crockfordId } from "../../ids/crockford.js";
import type { Sql } from "../../durable/sql.js";
import { pullFor } from "./mutations/result.js";
import { runMutation } from "./mutations/run.js";
import { FEED_KINDS, FEED_TABLES } from "./schema.js";
import { feedRow, forClient, sessionRow } from "./feed-rows.js";
import { iso } from "./iso.js";
import { DAY_MS, RETAIN_MS } from "./limits.js";
import { parse } from "./parse-json.js";
import { readPlace, readSession, readTrack, type PlaceRec, type SessionRec, type TrackRec } from "./records.js";
import { statusOf, summaryOf, working } from "./summary.js";
import { transact } from "./tx.js";
import { audiencesOf, seesSession, seesTrack } from "./who-may.js";

export const EARLIER_AFTER_MS = 7 * DAY_MS;
export const TRACK_QUIET_MS = 21 * DAY_MS;

type Raw = Record<string, unknown> & { version: number; audience: string };
const orgOf = (sql: Sql): string => sql.exec<{ org: string | null }>("SELECT org FROM meta WHERE k = 1")[0]!.org ?? "";
const marks = (values: unknown[]): string => values.map(() => "?").join(",");

// ------------------------------------------------------------------ the machine (spec 36.1, rule:preview)

export function acceptMachine(sql: Sql, now: number, pub: MachinePub): { accepted: boolean } {
  return transact(sql, now, (tx) => {
    const before = sql.exec<{ state: string; revision: number }>("SELECT state, revision FROM machine WHERE id = ?", pub.machine)[0];
    if (before && pub.revision <= before.revision) return { accepted: false };
    if (!before) sql.exec("INSERT INTO machine (id, state, revision, version, audience) VALUES (?, ?, ?, ?, 'org')", pub.machine, pub.state, pub.revision, tx.version());
    else if (before.state !== pub.state) sql.exec("UPDATE machine SET state = ?, revision = ?, version = ? WHERE id = ?", pub.state, pub.revision, tx.version(), pub.machine);
    else sql.exec("UPDATE machine SET revision = ? WHERE id = ?", pub.revision, pub.machine);
    if (!before || before.state !== pub.state) tx.occur({ key: `${pub.machine}:${pub.revision}`, kind: "machine.changed", by: "platform", audience: "org" });

    // rule:preview: the machine's open previews are its sessions' `preview` results.
    const held = sql.exec<{ id: string; session_id: string; ref: string }>(
      "SELECT r.id, r.session_id, r.ref FROM result r JOIN session s ON s.id = r.session_id WHERE r.kind = 'preview' AND s.machine = ?",
      pub.machine,
    );
    const open = new Set(pub.previews.map((v) => `${v.sessionId}\n${v.url}`));
    for (const row of held) if (!open.has(`${row.session_id}\n${row.ref}`)) tx.remove("result", row.id);
    const have = new Set(held.map((row) => `${row.session_id}\n${row.ref}`));
    for (const v of pub.previews) {
      if (have.has(`${v.sessionId}\n${v.url}`)) continue;
      const s = readSession(sql, v.sessionId);
      if (!s) continue;
      sql.exec(
        "INSERT INTO result (id, session_id, kind, ref, title, state, state_at, version, audience) VALUES (?, ?, 'preview', ?, ?, 'open', ?, ?, ?) ON CONFLICT(session_id, kind, ref) DO NOTHING",
        crockfordId("res"),
        v.sessionId,
        v.url,
        v.name,
        now,
        tx.version(),
        s.audience,
      );
    }
    return { accepted: true };
  });
}

// ------------------------------------------------------------------ pull requests (spec 40.9, rule:pr-merged)

export function acceptPull(sql: Sql, now: number, pub: PullPub): void {
  transact(sql, now, (tx) => {
    const results = sql.exec<{ id: string; session_id: string; state: string | null; title: string | null; meta: string | null; audience: string }>(
      "SELECT id, session_id, state, title, meta, audience FROM result WHERE kind = 'pr' AND ref = ?",
      pub.url,
    );
    const sessions = new Set<string>();
    for (const r of results) {
      const meta = parse<Record<string, unknown>>(r.meta, {});
      // `checks: null` (a pull_request event): the checks are as they were. So too `head` and `draft`.
      const checks = pub.checks ?? meta.checks ?? null;
      const head = pub.head ?? meta.head ?? null;
      const draft = pub.draft ?? meta.draft ?? null;
      // A person's merge from the surface (`result.merge`) is not the thread's end (work 118): `rule:pr-merged` leaves it alone.
      const byPerson = meta.merge !== undefined || pub.at - ((meta.merging as { at?: number } | undefined)?.at ?? 0) < MERGING_MS;
      if (r.state === pub.state && r.title === pub.title && (meta.checks ?? null) === checks && (meta.head ?? null) === head && (meta.draft ?? null) === draft) continue;
      sql.exec("UPDATE result SET state = ?, state_at = ?, title = ?, meta = ? WHERE id = ?", pub.state, pub.at, pub.title, JSON.stringify({ ...meta, checks, head, draft }), r.id);
      tx.stamp("result", r.id);
      const place = readPlace(sql, r.session_id);
      tx.occur({ key: `${r.id}:${pub.state}`, kind: "result.changed", sessionId: r.session_id, trackId: place?.track_id ?? null, by: "platform", audience: r.audience });
      if (!byPerson) sessions.add(r.session_id);
    }
    if (pub.state !== "merged") return;
    for (const sid of sessions) {
      const s = readSession(sql, sid);
      const place = readPlace(sql, sid);
      if (!s || !place || place.done_at !== null) continue;
      const status = statusOf(summaryOf(s));
      if (status === "running" || status === "starting") continue;
      const unmerged = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM result WHERE session_id = ? AND kind = 'pr' AND COALESCE(state, '') != 'merged'", sid)[0]!.c;
      if (unmerged === 0) runMutation(tx, platformPrincipal(orgOf(sql)), "thread.done", { sid, outcome: "done", by: "rule:pr-merged" });
    }
  });
}

/** How long a begun merge (`mergeStart`) answers for the webhook of its merge. */
const MERGING_MS = 10 * 60_000;

/** Before the edge merges or reverts a result's pull request (http/api/result-merge.ts): whether `p` may, and the row. */
export function mergeStart(sql: Sql, now: number, p: Principal, id: string, what: "merge" | "revert"): Reply<{ result: ResultRow }> {
  return transact(sql, now, (tx) => {
    const found = pullFor(sql, p, id);
    if ("ok" in found) return found;
    if (what === "merge" && found.r.state !== "merged") {
      sql.exec("UPDATE result SET meta = ? WHERE id = ?", JSON.stringify({ ...parse<Record<string, unknown>>(found.r.meta, {}), merging: { by: byOf(p), at: now } }), id);
      tx.stamp("result", id);
    }
    return { ok: true, result: result(sql, p, id)! };
  });
}

// ------------------------------------------------------------------ a Slack person became a member (spec 36.1)

export function linkPerson(sql: Sql, now: number, from: string, to: string): void {
  transact(sql, now, (tx) => {
    const old = `member:${from}`;
    const next = `member:${to}`;
    const owned = sql.exec<{ id: string; writers: string | null }>("SELECT id, writers FROM session WHERE owner = ?", from);
    if (owned.length === 0) return;
    for (const table of FEED_KINDS) {
      const keys = FEED_TABLES[table] as readonly string[];
      const key = keys[keys.length - 1]!;
      const moved = sql.exec<{ id: string }>(`UPDATE ${table} SET audience = ?, version = ? WHERE audience = ? RETURNING ${key} AS id`, next, tx.version(), old);
      for (const row of moved) tx.gone(table, String(row.id), [old]);
    }
    sql.exec("UPDATE occurrence SET audience = ? WHERE audience = ?", next, old);
    // A track started from their thread is theirs too.
    sql.exec("UPDATE track SET owner = ?, version = ? WHERE owner = ?", to, tx.version(), from);
    for (const s of owned) {
      // A list of writers names the owner too (`user:<owner>`): it follows them.
      const writers = parse<"members" | string[]>(s.writers, "members");
      const moved = writers === "members" ? writers : [...new Set(writers.map((by) => (by === `user:${from}` ? `user:${to}` : by)))];
      sql.exec("UPDATE session SET owner = ?, writers = ?, version = ? WHERE id = ?", to, JSON.stringify(moved), tx.version(), s.id);
      tx.sendAccess(s.id);
    }
  });
}

// ------------------------------------------------------------------ the work reads (spec 37.1)

const rawResults = (sql: Sql, sessionIds: string[]): Raw[] =>
  sessionIds.length === 0 ? [] : sql.exec<Raw>(`SELECT * FROM result WHERE session_id IN (${marks(sessionIds)}) ORDER BY id`, ...sessionIds);

/** `session`, `place` and `result` rows of threads, newest first, a page at a time. */
export function threads(sql: Sql, p: Principal, q: { earlier?: boolean; trackId?: string; before?: string; limit?: number }): { rows: Row[]; next: string | null } {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 50), 1), 200);
  const where: string[] = [q.earlier ? "p.earlier_at IS NOT NULL" : "p.earlier_at IS NULL"];
  const args: unknown[] = [];
  if (q.trackId !== undefined) {
    where.push("p.track_id = ?");
    args.push(q.trackId);
  }
  if (q.before !== undefined) {
    const parts = cursor.read("p", q.before);
    if (!parts || typeof parts[0] !== "number" || typeof parts[1] !== "string") return { rows: [], next: null };
    where.push("(COALESCE(s.last_active_at, s.created_at) < ? OR (COALESCE(s.last_active_at, s.created_at) = ? AND s.id < ?))");
    args.push(parts[0], parts[0], parts[1]);
  }
  const audiences = audiencesOf(p);
  if (p.kind !== "agent" && p.kind !== "platform") {
    if (audiences.length === 0) return { rows: [], next: null };
    where.push(`s.audience IN (${marks(audiences)})`);
    args.push(...audiences);
  }
  const found: SessionRec[] = [];
  let more = false;
  const query = `SELECT s.* FROM session s JOIN place p ON p.session_id = s.id WHERE ${where.join(" AND ")} ORDER BY COALESCE(s.last_active_at, s.created_at) DESC, s.id DESC`;
  if (p.kind === "agent") {
    for (const s of sql.exec<SessionRec>(query, ...args)) {
      if (!seesSession(sql, p, s)) continue;
      if (found.length === limit) {
        more = true;
        break;
      }
      found.push(s);
    }
  } else {
    const page = sql.exec<SessionRec>(`${query} LIMIT ?`, ...args, limit + 1);
    more = page.length > limit;
    found.push(...page.slice(0, limit));
  }
  const rows: Row[] = [];
  for (const s of found) {
    rows.push(forClient(sessionRow(sql, s)));
    rows.push(forClient(feedRow("place", readPlace(sql, s.id) as unknown as Raw)));
  }
  for (const raw of rawResults(sql, found.map((s) => s.id))) rows.push(forClient(feedRow("result", raw)));
  const last = found[found.length - 1];
  return { rows, next: more && last ? cursor.encode("p", [last.last_active_at ?? last.created_at, last.id]) : null };
}

/** One thread's rows, as a `threads` page holds them; null when it is not a thread or `p` may not see it. */
export function thread(sql: Sql, p: Principal, sessionId: string): { rows: Row[] } | null {
  const s = readSession(sql, sessionId);
  const place = readPlace(sql, sessionId);
  if (!s || !place || !seesSession(sql, p, s)) return null;
  const rows: Row[] = [forClient(sessionRow(sql, s)), forClient(feedRow("place", place as unknown as Raw))];
  for (const raw of rawResults(sql, [sessionId])) rows.push(forClient(feedRow("result", raw)));
  return { rows };
}

const like = (word: string): string => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Rows whose title, former titles, name, former names, stand or result title contain every word of `q`. */
export function search(sql: Sql, p: Principal, q: { q: string; limit?: number }): { rows: Row[] } {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 50), 1), 50);
  const words = q.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  if (words.length === 0) return { rows: [] };
  const all = (text: string) => words.map(() => `${text} LIKE ? ESCAPE '\\'`).join(" AND ");
  const likes = words.map(like);
  const rows: Row[] = [];
  const full = () => rows.length >= limit;

  const sessionText = "lower(COALESCE(s.title, '') || ' ' || s.former_titles || ' ' || COALESCE(json_extract(s.summary, '$.agentTitle'), '') || ' ' || COALESCE(json_extract(s.summary, '$.title'), ''))";
  for (const s of sql.exec<SessionRec>(`SELECT s.* FROM session s WHERE s.role IS NOT 'track' AND ${all(sessionText)} ORDER BY COALESCE(s.last_active_at, s.created_at) DESC LIMIT 500`, ...likes)) {
    if (full()) break;
    if (!seesSession(sql, p, s)) continue;
    rows.push(forClient(sessionRow(sql, s)));
    const place = readPlace(sql, s.id);
    if (place) rows.push(forClient(feedRow("place", place as unknown as Raw)));
  }
  const trackText = "lower(COALESCE(name, '') || ' ' || former_names || ' ' || COALESCE(stand, ''))";
  for (const t of sql.exec<TrackRec & Raw>(`SELECT * FROM track WHERE ${all(trackText)} ORDER BY position DESC LIMIT 500`, ...likes)) {
    if (full()) break;
    if (seesTrack(sql, p, t)) rows.push(forClient(feedRow("track", t)));
  }
  for (const r of sql.exec<Raw & { session_id: string }>(`SELECT * FROM result WHERE ${all("lower(COALESCE(title, ''))")} ORDER BY state_at DESC LIMIT 500`, ...likes)) {
    if (full()) break;
    const s = readSession(sql, r.session_id);
    if (s && seesSession(sql, p, s)) rows.push(forClient(feedRow("result", r)));
  }
  return { rows };
}

/** A result, if `p` may see its session (the diff route's lookup). */
export function result(sql: Sql, p: Principal, id: string): ResultRow | null {
  const raw = sql.exec<Raw & { session_id: string }>("SELECT * FROM result WHERE id = ?", id)[0];
  if (!raw) return null;
  const s = readSession(sql, raw.session_id);
  if (!s || !seesSession(sql, p, s)) return null;
  return forClient(feedRow("result", raw)) as ResultRow;
}

export function review(sql: Sql, p: Principal, resultId: string): ReviewRow | null {
  if (!result(sql, p, resultId)) return null;
  const row = sql.exec<{ head: string; parts: string }>("SELECT head, parts FROM review WHERE result_id = ?", resultId)[0];
  return row ? { resultId, head: row.head, parts: parse<unknown>(row.parts, null) } : null;
}

/** doc_read (spec 41): a track's `doc` row, for whoever may see the track, its agent included (whose feed is empty). */
export function doc(sql: Sql, p: Principal, trackId: string): Row | null {
  const track = readTrack(sql, trackId);
  if (!track || !seesTrack(sql, p, track)) return null;
  const raw = sql.exec<Raw>("SELECT * FROM doc WHERE track_id = ?", trackId)[0];
  return raw ? forClient(feedRow("doc", raw)) : null;
}

export function docRevisions(sql: Sql, p: Principal, trackId: string, rev?: number): DocRev[] {
  const track = readTrack(sql, trackId);
  if (!track || !seesTrack(sql, p, track)) return [];
  const rows =
    rev === undefined
      ? sql.exec<{ rev: number; by: string; at: number; text: string }>("SELECT rev, by, at, text FROM doc_rev WHERE track_id = ? ORDER BY rev DESC LIMIT 100", trackId)
      : sql.exec<{ rev: number; by: string; at: number; text: string }>("SELECT rev, by, at, text FROM doc_rev WHERE track_id = ? AND rev = ?", trackId, rev);
  return rows.map((r) => ({ trackId, rev: r.rev, by: r.by, at: iso(r.at), text: r.text }));
}

/** tell_track: the agent session of the track the caller's thread is in. */
export function trackAgent(sql: Sql, p: Principal): string | null {
  if (p.kind !== "agent" || !p.session) return null;
  const place = readPlace(sql, p.session);
  return place?.track_id ? (readTrack(sql, place.track_id)?.agent_session ?? null) : null;
}

const markOf = (s: SessionRec, place: PlaceRec): string => {
  const summary = summaryOf(s);
  if (place.done_at !== null) return place.outcome ? `done (${place.outcome})` : "done";
  if (s.blocked === 1) return "needs you";
  if (working(summary)) return "working";
  if (place.ready_seq !== null) return "ready";
  return "idle";
};
const nameOf = (s: SessionRec): string => s.title ?? summaryOf(s).agentTitle ?? summaryOf(s).title ?? "Untitled";

/** list_work (spec 37.1): names, stands, marks and results; no conversation text. */
export function overview(sql: Sql, p: Principal): Overview {
  let trackRows: TrackRec[];
  let sessionRows: SessionRec[];
  const live = "SELECT s.* FROM session s JOIN place p ON p.session_id = s.id WHERE p.earlier_at IS NULL";
  if (p.kind === "agent") {
    const own = p.session ? readSession(sql, p.session) : null;
    if (!own) return { tracks: [], threads: [] };
    if (own.role === "start") {
      trackRows = sql.exec<TrackRec>("SELECT * FROM track WHERE owner = ? ORDER BY position", own.owner);
      sessionRows = sql.exec<SessionRec>(`${live} AND s.owner = ? ORDER BY p.position DESC LIMIT 500`, own.owner);
    } else {
      const track = own.role === "track" ? sql.exec<TrackRec>("SELECT * FROM track WHERE agent_session = ?", own.id)[0] : null;
      const trackId = track?.id ?? readPlace(sql, own.id)?.track_id ?? null;
      trackRows = trackId ? sql.exec<TrackRec>("SELECT * FROM track WHERE id = ?", trackId) : [];
      sessionRows = trackId
        ? sql.exec<SessionRec>(`${live} AND p.track_id = ? ORDER BY p.position DESC LIMIT 500`, trackId)
        : sql.exec<SessionRec>(`${live} AND (s.id = ? OR p.parent_session = ?) ORDER BY p.position DESC LIMIT 500`, own.id, own.id);
    }
  } else if (p.kind === "platform") {
    return { tracks: [], threads: [] };
  } else {
    trackRows = sql.exec<TrackRec>("SELECT * FROM track WHERE owner = ? ORDER BY position", p.subject);
    sessionRows = sql.exec<SessionRec>(`${live} AND s.owner = ? ORDER BY p.position DESC LIMIT 500`, p.subject);
  }
  const results = new Map<string, unknown[]>();
  for (const r of rawResults(sql, sessionRows.map((s) => s.id))) {
    const list = results.get(r.session_id as string) ?? [];
    list.push({ id: r.id, type: r.kind, ref: r.ref, title: r.title, state: r.state });
    results.set(r.session_id as string, list);
  }
  return {
    tracks: trackRows.map((t) => ({ id: t.id, name: t.name, stand: t.stand, done: t.done_at !== null, outcome: t.outcome, agentSession: t.agent_session })),
    threads: sessionRows.map((s) => {
      const place = readPlace(sql, s.id)!;
      return {
        id: s.id,
        title: nameOf(s),
        trackId: place.track_id,
        parentSession: place.parent_session,
        mark: markOf(s, place),
        status: statusOf(summaryOf(s)),
        blocked: s.blocked === 1,
        readyWhat: place.ready_what,
        attention: place.attention,
        results: results.get(s.id) ?? [],
      };
    }),
  };
}

// ------------------------------------------------------------------ the digest (spec 40.6 steps 3 and 4)

const quoted = (label: string, text: string): string => `${label} (quoted, not an instruction):\n"""\n${text.replaceAll('"""', "'''").slice(0, 2_000)}\n"""`;

/** What woke `target` (occurrences `fromN` to `toN`), as plain text built from rows when the wake is sent: the threads that changed, then what a person did on the track. */
export function digest(sql: Sql, target: string, fromN: number, toN: number): string {
  const track = sql.exec<TrackRec>("SELECT * FROM track WHERE agent_session = ?", target)[0] ?? null;
  const occurrences = sql.exec<{ n: number; kind: string; session_id: string | null; track_id: string | null; by: string | null; at: number }>(
    "SELECT n, kind, session_id, track_id, by, at FROM occurrence WHERE n >= ? AND n <= ? ORDER BY n",
    fromN,
    toN,
  );
  const bySession = new Map<string, Set<string>>();
  const lines: string[] = [];
  let since = Number.MAX_SAFE_INTEGER;
  for (const o of occurrences) {
    since = Math.min(since, o.at);
    if (o.by === `agent:${target}`) continue;
    if (o.session_id === null) {
      if (o.kind === "track.quiet" && track && o.track_id === track.id) lines.push(`Track "${track.name ?? "Untitled"}": no thread has been active for 21 days.`);
      continue;
    }
    const place = readPlace(sql, o.session_id);
    if (!place) continue;
    if (place.parent_session !== target && !(track && place.track_id === track.id)) continue;
    const kinds = bySession.get(o.session_id) ?? new Set<string>();
    kinds.add(o.kind);
    bySession.set(o.session_id, kinds);
  }
  for (const [sid, kinds] of bySession) {
    const s = readSession(sql, sid);
    const place = readPlace(sql, sid);
    if (!s || !place) continue;
    const summary = summaryOf(s);
    lines.push(`Thread ${sid} "${nameOf(s)}" is ${markOf(s, place)}: ${[...kinds].join(", ")}.`);
    const text = place.ready_what ?? summary.lastText;
    if (text) lines.push(quoted(place.ready_what ? "What is ready" : "Its last words", text));
  }
  if (track) {
    const ops = sql.exec<{ by: string; name: string; args: string }>("SELECT by, name, args FROM op WHERE track_id = ? AND by LIKE 'user:%' AND at >= ? ORDER BY at LIMIT 50", track.id, since === Number.MAX_SAFE_INTEGER ? 0 : since);
    for (const op of ops) lines.push(`A person did ${op.name} ${op.args.slice(0, 300)}.`);
    const prefs = sql.exec<{ key: string; value: string }>("SELECT key, value FROM pref WHERE member = ? AND key LIKE 'agent.%' ORDER BY key", track.owner);
    for (const pref of prefs) lines.push(quoted(`The person's standing preference ${pref.key}`, pref.value));
  }
  return lines.length > 0 ? lines.join("\n") : "Nothing changed.";
}

// ------------------------------------------------------------------ the Slack echo (spec 40.6 step 5)

/** What occurrence `n` means in Slack, read from the rows when the echo is sent; null when nothing. */
export function echo(sql: Sql, n: number): SlackEcho | null {
  const o = sql.exec<{ key: string; kind: string; session_id: string | null }>("SELECT key, kind, session_id FROM occurrence WHERE n = ?", n)[0];
  if (!o) return null;
  if (o.kind === "turn.refused" && o.session_id) {
    const s = readSession(sql, o.session_id);
    if (!s || s.slack_thread_key === null) return null;
    const entryId = o.key.slice(`${o.session_id}:inbox:`.length);
    const entry = summaryOf(s).inbox.find((e) => e.id === entryId);
    if (!entry || entry.error === null) return null;
    return { kind: "refused", threadKey: s.slack_thread_key, person: entry.by.replace(/^user:/, ""), code: entry.error };
  }
  if (o.kind === "machine.changed") {
    const id = o.key.slice(0, o.key.lastIndexOf(":"));
    const machine = sql.exec<{ state: string }>("SELECT state FROM machine WHERE id = ?", id)[0];
    if (!machine) return null;
    // The Slack threads waiting on the machine: those with an entry in the inbox or a turn under way.
    const threadKeys = sql
      .exec<SessionRec>("SELECT * FROM session WHERE machine = ? AND slack_thread_key IS NOT NULL", id)
      .filter((s) => {
        const summary = summaryOf(s);
        return summary.inbox.some((e) => e.error === null) || summary.activeTurnId !== null || summary.status === "running";
      })
      .map((s) => s.slack_thread_key!);
    return threadKeys.length > 0 ? { kind: "machine", state: machine.state as never, threadKeys } : null;
  }
  return null;
}

// ------------------------------------------------------------------ ageing (spec 40.8), rule:age

export function age(sql: Sql, now: number): void {
  transact(sql, now, (tx) => {
    const cutoff = now - EARLIER_AFTER_MS;
    const quiet = sql.exec<SessionRec>(
      `SELECT s.* FROM session s JOIN place p ON p.session_id = s.id
       WHERE p.earlier_at IS NULL AND p.keep = 0 AND s.blocked = 0
         AND COALESCE(s.last_active_at, s.created_at) < ? AND COALESCE(p.brought_back_at, 0) < ?
         AND NOT EXISTS (SELECT 1 FROM proposal x WHERE x.target = s.id AND x.state = 'open')`,
      cutoff,
      cutoff,
    );
    for (const s of quiet) {
      const summary = summaryOf(s);
      if (working(summary)) continue;
      const read = sql.exec<{ read_seq: number }>("SELECT read_seq FROM read WHERE member = ? AND session_id = ?", s.owner, s.id)[0]?.read_seq ?? 0;
      if (read < (summary.lastAgentSeq ?? 0)) continue;
      sql.exec("UPDATE place SET earlier_at = ? WHERE session_id = ?", now, s.id);
      tx.stamp("place", s.id);
    }

    // A track none of whose threads was active for 21 days: `track.quiet`, once for that quiet.
    const tracks = sql.exec<{ id: string; audience: string; newest: number }>(
      `SELECT t.id, t.audience, MAX(COALESCE(s.last_active_at, s.created_at)) AS newest FROM track t
       JOIN place p ON p.track_id = t.id JOIN session s ON s.id = p.session_id WHERE t.done_at IS NULL GROUP BY t.id HAVING newest < ?`,
      now - TRACK_QUIET_MS,
    );
    for (const t of tracks) tx.occur({ key: `${t.id}:quiet:${t.newest}`, kind: "track.quiet", trackId: t.id, by: "rule:age", audience: t.audience });

    const old = now - RETAIN_MS;
    const floor = sql.exec<{ v: number | null }>("SELECT MAX(version) AS v FROM gone WHERE at < ?", old)[0]!.v;
    if (floor !== null) {
      sql.exec("DELETE FROM gone WHERE at < ?", old);
      sql.exec("UPDATE meta SET floor = MAX(floor, ?) WHERE k = 1", floor);
    }
    sql.exec("DELETE FROM occurrence WHERE at < ?", old);
    sql.exec("DELETE FROM op WHERE at < ?", old);
    sql.exec("DELETE FROM _idem WHERE expires < ?", now);
  });
}
