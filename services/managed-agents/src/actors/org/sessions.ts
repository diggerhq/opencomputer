// Org's directory (spec 36.1, 37.2, 40.1): the only creator of a session, and the session API's
// get, patch and list over Org's rows. Pure functions over `Sql`; a refusal is a value.

import type { Origin, SessionAccess } from "../../api-objects/objects.js";
import { isId, isSessionId, mintId } from "../../ids/session-ids.js";
import type { Access } from "../../auth/principal.js";
import type { CreateSession, ListQuery, OrgSettings, OutsideAccess, PlaceRow, SessionPage, SessionPatch, SessionRow, SlackAccessDefault } from "./contract.js";
import type { Reply, Refusal } from "../../durable/rpc-reply.js";
import { cursor } from "../../durable/cursor.js";
import { byOf, mayWrite, type Principal } from "../../auth/principal.js";
import type { Sql } from "../../durable/sql.js";
import { runMutation } from "./mutations/run.js";
import { fullName, storedRepository } from "./repository.js";
import { FEED_TABLES, type FeedTable } from "./schema.js";
import { accessOf } from "./access.js";
import { accessRows, accessView, audienceOf, sharedWith } from "./audience.js";
import { forClient, placeRow, sessionRow } from "./feed-rows.js";
import { AGENT_THREADS_MAX } from "./limits.js";
import { parse } from "./parse-json.js";
import { readPlace, readSession, readTrack, type SessionRec } from "./records.js";
import { emptySummary } from "./summary.js";
import { titleFrom } from "./title.js";
import { transact, type Tx } from "./tx.js";
import { holdsTrack, isMember, ownsTrack, seesSession, visible } from "./who-may.js";

export const refusal = (code: string, status: number, message?: string, more: Record<string, unknown> = {}): Refusal => ({ ...more, ok: false, code, status, ...(message ? { message } : {}) });
const notFound = (): Refusal => refusal("session_not_found", 404, "No such session.");

/** The API's `Session` of a stored row: the feed's row less what only the feed carries; with `p`, whether it may change `access`. */
export function apiSession(sql: Sql, s: SessionRec, p?: Principal): SessionRow {
  const { kind: _kind, version: _version, audience: _audience, ...session } = sessionRow(sql, s);
  return (p ? { ...session, canManageAccess: managesAccess(p, s) } : session) as unknown as SessionRow;
}

const apiPlace = (sql: Sql, sessionId: string): PlaceRow | null => {
  const place = readPlace(sql, sessionId);
  return place ? forClient(placeRow(place)) : null;
};

/** Keep `meta.org` and `meta.admins` as last seen (spec 36.1). */
export function seen(sql: Sql, p: Principal): void {
  const meta = sql.exec<{ org: string | null; admins: string }>("SELECT org, admins FROM meta WHERE k = 1")[0]!;
  if (meta.org === null && p.org) sql.exec("UPDATE meta SET org = ? WHERE k = 1", p.org);
  // A Slack principal never says whether its member is an admin: it neither makes nor unmakes one.
  if (p.kind !== "member" || !p.subject.startsWith("usr_") || p.via === "slack") return;
  const admins = parse<string[]>(meta.admins, []);
  if (p.admin === admins.includes(p.subject)) return;
  const next = p.admin ? [...admins, p.subject] : admins.filter((a) => a !== p.subject);
  sql.exec("UPDATE meta SET admins = ? WHERE k = 1", JSON.stringify(next));
}

export const adminsOf = (sql: Sql): string[] => parse<string[]>(sql.exec<{ admins: string }>("SELECT admins FROM meta WHERE k = 1")[0]!.admins, []);

// ------------------------------------------------------------------ access (spec 36.2)

export const ACCESS_PEOPLE_MAX = 50;
const MEMBER_ID = /^usr_[0-9a-z]{1,64}$/;
const MODES: SessionAccess["mode"][] = ["owner", "org", "people"];

/** Whether `p` may change a session's access: its owner, a person it is shared with, or an admin; never a Slack or role session's. */
export function managesAccess(p: Principal, s: SessionRec): boolean {
  if (!isMember(p) || s.role !== null || parse<Origin>(s.origin, { type: "api", client: null, slack: null }).type === "slack") return false;
  return s.owner === p.subject || p.admin || sharedWith(s).includes(byOf(p));
}

/** `access` of a create or patch, checked; `people` as member ids or emails (the Durable Object turned WorkOS ids into member ids). */
export function parseAccess(sql: Sql, value: unknown): SessionAccess | Refusal {
  const bad = (field: string, message: string, more: Record<string, unknown> = {}) => refusal("invalid_request", 400, message, { field, ...more });
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("access", "access must be an object: { mode, people? }.");
  const input = value as Record<string, unknown>;
  for (const k of Object.keys(input)) if (k !== "mode" && k !== "people") return bad(`access.${k}`, `Unknown field access.${k}.`);
  const mode = input.mode as SessionAccess["mode"];
  if (!MODES.includes(mode)) return bad("access.mode", "access.mode is owner, org or people.");
  const given = input.people ?? [];
  if (!Array.isArray(given) || given.some((e) => typeof e !== "string" || e.length < 1 || e.length > 320)) return bad("access.people", "access.people is a list of member ids or emails.");
  if (mode !== "people" && given.length) return bad("access.people", "access.people is only for mode people.");
  if (given.length > ACCESS_PEOPLE_MAX) return bad("access.people", `At most ${ACCESS_PEOPLE_MAX} people.`);
  const people: string[] = [];
  for (const entry of given as string[]) {
    // An email names the member who owns a session with it; a member id is taken as given (one who is not a member is refused by the edge).
    const id = MEMBER_ID.test(entry)
      ? entry
      : entry.includes("@")
        ? sql.exec<{ owner: string }>("SELECT owner FROM session WHERE lower(owner_email) = ? AND owner LIKE 'usr\\_%' ESCAPE '\\' ORDER BY created_at DESC LIMIT 1", entry.toLowerCase())[0]?.owner
        : undefined;
    if (!id) return bad("access.people", `${entry} is not a member of this organization (or has never started a session).`, { reason: "unknown_member" });
    people.push(id);
  }
  return { mode, people: [...new Set(people)].sort() };
}

/** Change a session's access: its `writers`, and when the audience changes, its rows under the new one with `gone` to the old (spec 18.7). */
function setAccess(tx: Tx, s: SessionRec, wanted: SessionAccess): void {
  const rows = accessRows(s.owner, { mode: wanted.mode, people: wanted.people.filter((m) => m !== s.owner) });
  tx.sql.exec("UPDATE session SET writers = ? WHERE id = ?", JSON.stringify(rows.writers), s.id);
  tx.stamp("session", s.id);
  if (rows.audience !== s.audience) {
    const moves: [FeedTable, string][] = [["session", "id"], ["place", "session_id"], ["result", "session_id"], ["op", "session_id"], ["proposal", "target"]];
    for (const [table, column] of moves) {
      const keys = FEED_TABLES[table] as readonly string[];
      const key = keys[keys.length - 1]!;
      const moved = tx.sql.exec<{ id: string }>(`UPDATE ${table} SET audience = ?, version = ? WHERE ${column} = ? AND audience = ? RETURNING ${key} AS id`, rows.audience, tx.version(), s.id, s.audience);
      for (const row of moved) tx.gone(table, row.id, [s.audience]);
    }
    tx.sql.exec("UPDATE occurrence SET audience = ? WHERE session_id = ? AND audience = ?", rows.audience, s.id, s.audience);
  }
  tx.sendAccess(s.id);
}

const outside = (p: Principal, s: SessionRec): OutsideAccess => ({ session: null, access: accessView(s), canManageAccess: managesAccess(p, s) });

/** An admin outside a session reads its access and nothing else (spec 36.2). */
export function sessionAccess(sql: Sql, p: Principal, id: string): Reply<OutsideAccess> {
  const s = readSession(sql, id);
  if (!s || seesSession(sql, p, s) || !managesAccess(p, s)) return notFound();
  return { ok: true, ...outside(p, s) };
}

const DEFAULTS: OrgSettings = { apiAccessDefault: "owner" };

/** The organization's settings for the session API; any member reads them. */
export function settings(sql: Sql): OrgSettings {
  const row = sql.exec<{ api_access_default: string | null }>("SELECT api_access_default FROM meta WHERE k = 1")[0]!;
  return { apiAccessDefault: row.api_access_default === "org" ? "org" : DEFAULTS.apiAccessDefault };
}

export function slackAccessDefault(sql: Sql): SlackAccessDefault {
  return sql.exec<{ v: string | null }>("SELECT slack_access_default AS v FROM meta WHERE k = 1")[0]!.v === "owner" ? "owner" : "open";
}

/** `!access default open|owner` in Slack: admins only, as Org knows them (a Slack principal is never `admin` itself). */
export function setSlackAccessDefault(sql: Sql, p: Principal, value: SlackAccessDefault): Reply<{ value: SlackAccessDefault }> {
  if (!(isMember(p) && (p.admin || adminsOf(sql).includes(p.subject)))) return refusal("admin_required", 403, "Only an organization admin can change the default.");
  if (value !== "open" && value !== "owner") return refusal("invalid_request", 400, "The default is open or owner.", { field: "value" });
  sql.exec("UPDATE meta SET slack_access_default = ? WHERE k = 1", value);
  return { ok: true, value };
}

/** The one-time carry-over of the defaults the Computer held: each only where Org has none yet. */
export function carryAccessDefaults(sql: Sql, carry: { accessDefault: string | null; apiAccessDefault: string | null }): void {
  if (carry.accessDefault === "open" || carry.accessDefault === "owner") sql.exec("UPDATE meta SET slack_access_default = ? WHERE k = 1 AND slack_access_default IS NULL", carry.accessDefault);
  if (carry.apiAccessDefault === "owner" || carry.apiAccessDefault === "org") sql.exec("UPDATE meta SET api_access_default = ? WHERE k = 1 AND api_access_default IS NULL", carry.apiAccessDefault);
}

export function setSettings(sql: Sql, p: Principal, patch: Partial<OrgSettings>): Reply<{ settings: OrgSettings }> {
  if (!(isMember(p) && p.admin)) return refusal("admin_required", 403, "Only an organization admin can change these settings.");
  const fields = patch && typeof patch === "object" && !Array.isArray(patch) ? Object.keys(patch) : null;
  if (!fields?.length) return refusal("invalid_request", 400, "The body names nothing to change.", { field: "" });
  for (const field of fields) if (field !== "apiAccessDefault") return refusal("invalid_request", 400, `Unknown field ${field}.`, { field });
  if (patch.apiAccessDefault !== "owner" && patch.apiAccessDefault !== "org") return refusal("invalid_request", 400, "apiAccessDefault is owner or org.", { field: "apiAccessDefault" });
  sql.exec("UPDATE meta SET api_access_default = ? WHERE k = 1", patch.apiAccessDefault);
  return { ok: true, settings: settings(sql) };
}

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
  if (body.turnId !== undefined && !(isId("tn", body.turnId) && body.input !== undefined)) return refusal("invalid_request", 400, "turnId is tn_ and 12 lowercase Crockford base32 characters, sent only with input.", { field: "turnId" });
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
      if (existing.owner === owner && existing.create_hash === hash) return { ok: true, session: apiSession(sql, existing, p), place: apiPlace(sql, id), duplicate: true };
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
    // Who may use it (spec 36.2): an agent's thread its parent's; else as asked, else the organization's
    // default; a Slack or role session is its owner's, driven by `writers` (a Slack one's by the organization's Slack default).
    const writers = body.writers ?? (origin.type === "slack" && slackAccessDefault(sql) === "owner" ? [`user:${owner}`] : ("members" as const));
    let rows = { audience: audienceOf(owner, origin, role), writers: writers as "members" | string[] };
    if (body.access !== undefined && (!isMember(p) || origin.type === "slack" || role !== null)) return refusal("invalid_request", 400, "access is a member's, for a session not from Slack and without a role.", { field: "access" });
    if (parent) rows = { audience: parent.audience, writers: parse<"members" | string[]>(parent.writers, "members") };
    else if (origin.type !== "slack" && role === null) {
      const wanted = body.access !== undefined ? parseAccess(sql, body.access) : { mode: settings(sql).apiAccessDefault, people: [] };
      if ("ok" in wanted) return wanted;
      rows = accessRows(owner, { mode: wanted.mode, people: wanted.people.filter((m) => m !== owner) });
    }
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
      writers: rows.writers,
      metadata: body.metadata,
      summary,
      createHash: hash,
      audience: rows.audience,
    });
    tx.addPlace({ sessionId: id, trackId: track?.id ?? null, placedBy: by, parentSession: parent?.id ?? null, audience: session.audience });

    // The first turn, owed with the session and from its creator: one turn whoever retries (spec 40.1).
    tx.start(id, { harness: body.harness, trace: body.trace, firstInput: body.input, turnId: body.turnId, as: p });
    tx.sendAccess(id);
    tx.owe({ group: id, call: "usage.created", body: { sessionId: id, createdAt: now } });
    // The track's agent may now be told by this thread (spec 40.7 step 4).
    if (track) tx.sendAccess(track.agent_session);
    if (parent?.slack_thread_key) tx.owe({ group: id, call: "Slack.announce", body: { sessionId: id, parent: parent.id, brief: (body.input ?? "").slice(0, 280) } });
    return { ok: true, session: apiSession(sql, readSession(sql, id)!, p), place: apiPlace(sql, id), duplicate: false };
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
  return { ok: true, session: apiSession(sql, s, p) };
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

export function patchSession(sql: Sql, now: number, p: Principal, id: string, patch: SessionPatch): Reply<{ session: SessionRow } | OutsideAccess> {
  return transact(sql, now, (tx) => {
    const s = readSession(sql, id);
    if (!s) return notFound();
    // An admin outside the session may change its access and nothing else (spec 36.2).
    const uses = seesSession(sql, p, s);
    const onlyAccess = Object.keys(patch).every((k) => k === "access");
    if (!uses && !(patch.access !== undefined && onlyAccess && managesAccess(p, s))) return notFound();
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
      if (!refused && patch.access !== undefined) {
        const slack = parse<Origin>(s.origin, { type: "api", client: null, slack: null }).type === "slack";
        if (slack) refused = refusal("forbidden", 403, "A Slack session's access is set in its thread (`!access`).", { reason: "access_in_slack" });
        else if (s.role !== null) refused = refusal("forbidden", 403, "A track's or start session's access is its owner's.", { reason: "role_session" });
        else if (!managesAccess(p, s)) refused = refusal("forbidden", 403, "Only the session's owner, people it is shared with, or an admin can change its access.", { reason: "not_member" });
        else {
          const wanted = parseAccess(sql, patch.access);
          if ("ok" in wanted) refused = wanted;
          else setAccess(tx, s, wanted);
        }
      }
      if (!refused && patch.settings !== undefined) {
        // Checked as SessionLog will check it, so a write the log would refuse is not owed with the rest.
        const access = accessOf(sql, id);
        if (!access || !mayWrite(p, "settings", access, id)) refused = refusal("forbidden", 403, "Only a person who may write to the session changes its settings.", { reason: "settings_writer_only" });
        else tx.accept(id, { id: patch.settings.id, kind: "settings", body: patch.settings.body, trace: patch.settings.trace }, p);
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
    if (refused) return refused;
    const after = readSession(sql, id)!;
    return seesSession(sql, p, after) ? { ok: true, session: apiSession(sql, after, p) } : { ok: true, ...outside(p, after) };
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
    where.push("(audience = 'org' OR owner = ? OR EXISTS (SELECT 1 FROM json_each(session.writers) WHERE value = ?))");
    args.push(p.subject, byOf(p));
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
    where.push(`COALESCE(json_extract(summary, '$.status'), CASE WHEN json_extract(summary, '$.activeTurnId') IS NOT NULL OR json_array_length(COALESCE(json_extract(summary, '$.queued'), '[]')) > 0 THEN 'starting' ELSE 'idle' END) IN (${statuses.map(() => "?").join(",")})`);
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
  return { ok: true, sessions: page.map((s) => apiSession(sql, s, p)), nextCursor };
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
