// Org's directory (spec 36.1, 37.2, 40.1): the only creator of a session, and the session API's
// get, patch and list over Org's rows. Pure functions over `Sql`; a refusal is a value.

import type { Origin } from "../computer/api-types.js";
import { isSessionId, mintId } from "../computer/session-ids.js";
import type { Access, CreateSession, ListQuery, PlaceRow, Reply, Refusal, SessionPage, SessionPatch, SessionRow } from "../actor/contracts.js";
import { cursor } from "../actor/cursor.js";
import { byOf, type Principal } from "../actor/principal.js";
import type { Sql } from "../actor/sql.js";
import { runMutation } from "./mutations/index.js";
import { fullName, storedRepository } from "./repository.js";
import {
  AGENT_THREADS_MAX,
  accessOf,
  audienceOf,
  emptySummary,
  forClient,
  holdsTrack,
  isMember,
  ownsTrack,
  parse,
  placeRow,
  readPlace,
  readSession,
  readTrack,
  seesSession,
  sessionRow,
  titleFrom,
  transact,
  visible,
  type SessionRec,
  type Tx,
} from "./tx.js";

export const refusal = (code: string, status: number, message?: string, more: Record<string, unknown> = {}): Refusal => ({ ...more, ok: false, code, status, ...(message ? { message } : {}) });
const notFound = (): Refusal => refusal("session_not_found", 404, "No such session.");

/** The API's `Session` of a stored row: the feed's row less what only the feed carries. */
export function apiSession(sql: Sql, s: SessionRec): SessionRow {
  const { kind: _kind, version: _version, audience: _audience, ...session } = sessionRow(sql, s);
  return session as unknown as SessionRow;
}

const apiPlace = (sql: Sql, sessionId: string): PlaceRow | null => {
  const place = readPlace(sql, sessionId);
  return place ? forClient(placeRow(place)) : null;
};

/** Keep `meta.org` and `meta.admins` as last seen (spec 36.1). */
export function seen(sql: Sql, p: Principal): void {
  const meta = sql.exec<{ org: string | null; admins: string }>("SELECT org, admins FROM meta WHERE k = 1")[0]!;
  if (meta.org === null && p.org) sql.exec("UPDATE meta SET org = ? WHERE k = 1", p.org);
  if (p.kind !== "member" || !p.subject.startsWith("usr_")) return;
  const admins = parse<string[]>(meta.admins, []);
  if (p.admin === admins.includes(p.subject)) return;
  const next = p.admin ? [...admins, p.subject] : admins.filter((a) => a !== p.subject);
  sql.exec("UPDATE meta SET admins = ? WHERE k = 1", JSON.stringify(next));
}

export const adminsOf = (sql: Sql): string[] => parse<string[]>(sql.exec<{ admins: string }>("SELECT admins FROM meta WHERE k = 1")[0]!.admins, []);

// ------------------------------------------------------------------ create (spec 40.1)

export function createSession(
  sql: Sql,
  now: number,
  p: Principal,
  body: CreateSession,
  hash: string,
  machine: string,
): Reply<{ session: SessionRow; place: PlaceRow | null; duplicate: boolean }> {
  if (body.id !== undefined && !isSessionId(body.id)) return refusal("invalid_request", 400, "id must be cs_ and 16 lowercase Crockford base32 characters.", { field: "id" });
  if (p.kind === "platform") return refusal("forbidden", 403);
  const id = body.id ?? mintId("cs");
  return transact(sql, now, (tx) => {
    const by = byOf(p);
    let owner = p.subject;
    let person = body.person ?? { name: null, email: null };
    let origin: Origin = body.origin ?? { type: p.via, client: null, slack: null };
    let parent: SessionRec | null = null;
    if (p.kind === "agent") {
      parent = readSession(sql, body.parent ?? p.session ?? "");
      if (!parent) return notFound();
      owner = parent.owner;
      person = { name: parent.owner_name, email: parent.owner_email };
      const from = parse<Origin>(parent.origin, { type: "api", client: null, slack: null });
      origin = { type: from.type, client: from.client, slack: null };
    }

    const existing = readSession(sql, id);
    if (existing) {
      // The same owner and body: the first call's answer. Anything else: taken, seen or not (spec 19.2).
      if (existing.owner === owner && existing.create_hash === hash) return { ok: true, session: apiSession(sql, existing), place: apiPlace(sql, id), duplicate: true };
      return refusal("taken", 409, "A session with this id exists.");
    }

    if (body.role !== undefined && (body.role !== "start" || !isMember(p))) return refusal("invalid_request", 400, "role is start, from a member.", { field: "role" });
    const track = body.trackId !== undefined ? readTrack(sql, body.trackId) : null;
    if (body.trackId !== undefined && !(track && (ownsTrack(p, track) || holdsTrack(p, track)))) return refusal("not_found", 404, "No such track.");
    if (parent) {
      const started = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM place WHERE parent_session = ? AND done_at IS NULL", parent.id)[0]!.c;
      if (started >= AGENT_THREADS_MAX) return refusal("refused", 409, "This agent has too many open threads.", { reason: "too_many_threads" });
    }

    const role = body.role ?? null;
    const summary = emptySummary({ model: body.model, effort: body.effort, mode: body.mode, speed: body.speed }, body.title === undefined && body.input ? titleFrom(body.input) : null);
    const session = tx.addSession({
      id,
      owner,
      ownerName: person.name,
      ownerEmail: person.email,
      origin,
      slackThreadKey: body.slackThread ?? null,
      machine,
      role,
      createdBy: by,
      title: body.title || null,
      titleBy: body.title ? by : null,
      writers: body.writers ?? "members",
      metadata: body.metadata,
      summary,
      createHash: hash,
      audience: audienceOf(owner, origin, role),
    });
    tx.addPlace({ sessionId: id, trackId: track?.id ?? null, placedBy: by, parentSession: parent?.id ?? null, audience: session.audience });

    tx.start(id, { harness: body.harness });
    tx.sendAccess(id);
    tx.owe({ group: id, call: "usage.created", body: { sessionId: id, createdAt: now } });
    // The track's agent may now be told by this thread (spec 40.7 step 4).
    if (track) tx.sendAccess(track.agent_session);
    if (parent?.slack_thread_key) tx.owe({ group: id, call: "Slack.announce", body: { sessionId: id, parent: parent.id, brief: (body.input ?? "").slice(0, 280) } });
    return { ok: true, session: apiSession(sql, readSession(sql, id)!), place: apiPlace(sql, id), duplicate: false };
  });
}

/** `Slack.announce` answered: the child's thread key (spec 40.1). */
export function setSlackThread(sql: Sql, sessionId: string, key: string): void {
  sql.exec("UPDATE session SET slack_thread_key = ? WHERE id = ?", key, sessionId);
}

// ------------------------------------------------------------------ get, patch

export function getSession(sql: Sql, p: Principal, id: string): Reply<{ session: SessionRow }> {
  const s = readSession(sql, id);
  if (!s || !seesSession(sql, p, s)) return notFound();
  return { ok: true, session: apiSession(sql, s) };
}

const STATUS_OF: Record<string, number> = { not_found: 404, invalid_request: 400, forbidden: 403 };

/** A mutation run for the session API (spec 37.2): its refusal as the API's. */
function mutation(tx: Tx, p: Principal, name: string, args: Record<string, unknown>): Refusal | null {
  const out = runMutation(tx, p, name, args);
  if (out.ok) return null;
  if (out.code === "not_found") return notFound();
  const { ok: _ok, code, reason, ...more } = out;
  return refusal(code, STATUS_OF[code] ?? 409, undefined, { ...more, reason });
}

export function patchSession(sql: Sql, now: number, p: Principal, id: string, patch: SessionPatch): Reply<{ session: SessionRow }> {
  return transact(sql, now, (tx) => {
    const s = readSession(sql, id);
    if (!s || !seesSession(sql, p, s)) return notFound();
    const done = readPlace(sql, id)?.done_at ?? null;
    let refused: Refusal | null = null;
    // All or nothing: one refused part undoes the parts before it.
    tx.attempt(() => {
      if (patch.title !== undefined && patch.title !== s.title) refused = mutation(tx, p, "thread.rename", { sid: id, title: patch.title });
      if (!refused && patch.archived === true && done === null) refused = mutation(tx, p, "thread.done", { sid: id });
      if (!refused && patch.archived === false && done !== null) refused = mutation(tx, p, "thread.reopen", { sid: id });
      if (!refused && patch.metadata !== undefined) {
        const metadata = parse<Record<string, string>>(s.metadata, {});
        for (const [key, value] of Object.entries(patch.metadata)) {
          if (value === null) delete metadata[key];
          else metadata[key] = value;
        }
        if (Object.keys(metadata).length > 20) refused = refusal("invalid_request", 400, "At most 20 metadata keys.", { field: "metadata" });
        else {
          sql.exec("UPDATE session SET metadata = ? WHERE id = ?", JSON.stringify(metadata), id);
          tx.stamp("session", id);
        }
      }
      if (!refused && patch.aside !== undefined) {
        if (!(isMember(p) && s.owner === p.subject)) refused = refusal("forbidden", 403, "Only the session's owner sets it aside.", { reason: "aside_owner_only" });
        else if (patch.aside !== null && !/^[\x21-\x7e]{1,255}$/.test(patch.aside)) refused = refusal("invalid_request", 400, "ref is 1 to 255 printable characters.", { field: "ref" });
        else {
          sql.exec("UPDATE session SET aside = ? WHERE id = ?", patch.aside, id);
          tx.stamp("session", id);
        }
      }
      return { ok: refused === null };
    });
    return refused ?? { ok: true, session: apiSession(sql, readSession(sql, id)!) };
  });
}

// ------------------------------------------------------------------ list

const STATUSES = ["starting", "running", "waiting", "idle", "suspended"];
const invalid = (field: string, message: string): Refusal => refusal("invalid_request", 400, message, { field });

/** 32-bit FNV-1a, hex: a filter set's fingerprint in a cursor (not a security boundary). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** A Slack thread's key, or the `LIKE` pattern of one from its link (`…/archives/<channel>/p<ts>`). */
function slackThreadMatch(text: string): { sql: string; arg: string } {
  const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(text);
  if (link) return { sql: "slack_thread_key LIKE ?", arg: `%:${link[1]}:${link[2]}.${link[3]}` };
  return { sql: "slack_thread_key = ?", arg: text };
}

/** `GET /sessions` as today (filters, order, cursor), over Org's rows; plus `slackThread`. A track's agent is not listed. */
export function listSessions(sql: Sql, p: Principal, q: ListQuery): Reply<SessionPage> {
  const where = ["(role IS NULL OR role != 'track')"];
  const args: unknown[] = [];
  const owner = q.owner ?? (p.kind === "agent" || p.kind === "platform" ? "anyone" : "me");
  if (p.kind === "agent") {
    where.push("(id = ? OR id IN (SELECT session_id FROM place WHERE parent_session = ? OR track_id IN (SELECT id FROM track WHERE agent_session = ?)))");
    args.push(p.session ?? "", p.session ?? "", p.session ?? "");
  } else if (p.kind !== "platform") {
    where.push("(audience = 'org' OR owner = ?)");
    args.push(p.subject);
  }
  if (owner === "me") {
    where.push("owner = ?");
    args.push(p.subject);
  } else if (owner !== "anyone") {
    if (!/^usr_[0-9a-z]{1,64}$/.test(owner)) return invalid("owner", "owner is me, anyone or a member id.");
    where.push("owner = ?");
    args.push(owner);
  }
  const statuses = q.status ?? [];
  if (statuses.some((s) => !STATUSES.includes(s))) return invalid("status", `status must be among ${STATUSES.join(", ")}.`);
  if (statuses.length) {
    where.push(`COALESCE(json_extract(summary, '$.status'), 'starting') IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  const origins = q.origin ?? [];
  if (origins.length) {
    where.push(`json_extract(origin, '$.type') IN (${origins.map(() => "?").join(",")})`);
    args.push(...origins);
  }
  const archived = q.archived ?? false;
  if (archived !== "all") where.push(`(SELECT done_at FROM place WHERE session_id = session.id) IS ${archived ? "NOT NULL" : "NULL"}`);
  const metadata = Object.entries(q.metadata ?? {});
  for (const [k, value] of metadata) {
    where.push("json_extract(metadata, ?) = ?");
    args.push(`$."${k.replace(/["\\]/g, "")}"`, value);
  }
  if (q.q) {
    where.push("COALESCE(title, json_extract(summary, '$.agentTitle'), json_extract(summary, '$.title'), 'Untitled') LIKE ? ESCAPE '\\'");
    args.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (q.slackThread) {
    const match = slackThreadMatch(q.slackThread);
    where.push(match.sql);
    args.push(match.arg);
  }
  const order = q.order ?? "active";
  if (order !== "active" && order !== "created") return invalid("order", "order is active or created.");
  const column = order === "active" ? "COALESCE(last_active_at, created_at)" : "created_at";
  const limit = q.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return invalid("limit", "limit is 1 to 100.");
  // The cursor binds the filters it was made under: another set is invalid_cursor.
  const filter = fnv1a(JSON.stringify([owner, [...statuses].sort(), [...origins].sort(), archived, [...metadata].sort(), q.q ?? "", q.slackThread ?? ""]));
  if (q.cursor) {
    const c = cursor.read("p", q.cursor);
    if (!c || c[0] !== order || c[3] !== filter || typeof c[1] !== "number" || !isSessionId(c[2])) {
      return refusal("invalid_cursor", 400, "The cursor is not valid for this list.");
    }
    where.push(`(${column} < ? OR (${column} = ? AND id < ?))`);
    args.push(c[1], c[1], c[2]);
  }
  const rows = sql.exec<SessionRec>(`SELECT * FROM session WHERE ${where.join(" AND ")} ORDER BY ${column} DESC, id DESC LIMIT ?`, ...args, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? cursor.encode("p", [order, order === "active" ? (last.last_active_at ?? last.created_at) : last.created_at, last.id, filter]) : null;
  return { ok: true, sessions: page.map((s) => apiSession(sql, s)), nextCursor };
}

// ------------------------------------------------------------------ access

export const access = (sql: Sql, sessionId: string): Access | null => accessOf(sql, sessionId);

export function forHost(sql: Sql, machine: string): { sessions: { sessionId: string; access: Access }[]; admins: string[]; knowledge: string | null } {
  const sessions = sql
    .exec<{ id: string }>("SELECT id FROM session WHERE machine = ? ORDER BY id", machine)
    .map((row) => ({ sessionId: row.id, access: accessOf(sql, row.id)! }));
  return { sessions, admins: adminsOf(sql), knowledge: fullName(storedRepository(sql)) };
}

export { visible };
