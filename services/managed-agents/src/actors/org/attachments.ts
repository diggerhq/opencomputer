// Attachments (work 126): the rows of what people upload for a message, over Org's `attachment`
// table. Pure functions over `Sql`; a refusal is a value. The bytes are the store's
// (attachments/store.ts); Org owes `Attachments.delete` and `Attachments.removeAll` to it.
//
// A row's life (section 3): `uploading` (the row made, the uploader holds a signed URL) → `ready`
// (the object is stored, `etag` set) → `attached` (a turn named it; more may) ; any of the first
// two → `deleted` (kept ATTACHMENT_DELETED_KEEP_MS so a late reference answers 410).
// The quota is taken at create, from the declared size, so parallel uploads cannot overshoot.
//
// `by` is the uploader's spec 34.1 string (`user:usr_…`), as `created_by` of a session is.

import { byOf, mayWrite, type Access, type Principal } from "../../auth/principal.js";
import { alarms } from "../../durable/alarms.js";
import { owed } from "../../durable/outbox.js";
import type { Refusal, Reply } from "../../durable/rpc-reply.js";
import type { Sql } from "../../durable/sql.js";
import { isId } from "../../ids/session-ids.js";
import { accessOf } from "./access.js";
import { sharedWith } from "./audience.js";
import { ATTACHMENT_DELETED_KEEP_MS, ATTACHMENT_ORG_BYTES_MAX, ATTACHMENT_ORPHAN_TTL_MS, ATTACHMENT_SESSION_BYTES_MAX, ATTACHMENT_UPLOADING_TTL_MS } from "./limits.js";
import { readSession, type SessionRec } from "./records.js";
import { isMember, seesSession } from "./who-may.js";

// As sessions.ts's `refusal`; its own so remove-session.ts → here → sessions.ts → the mutations is no cycle.
const refusal = (code: string, status: number, message?: string, more: Record<string, unknown> = {}): Refusal => ({ ...more, ok: false, code, status, ...(message ? { message } : {}) });

export type AttachmentState = "uploading" | "ready" | "attached" | "deleted";

export interface AttachmentRec {
  id: string;
  session_id: string;
  by: string;
  name: string;
  mimetype: string;
  bytes: number;
  state: AttachmentState;
  etag: string | null;
  turn_id: string | null;
  message_id: string | null;
  created_at: number;
  state_at: number;
}

/** The API's object (section 4). */
export interface Attachment {
  id: string;
  sessionId: string;
  by: string;
  name: string;
  mimetype: string;
  bytes: number;
  state: AttachmentState;
  etag: string | null;
  createdAt: string;
  attachedTo: { turnId: string; messageId: string | null } | null;
}

/** What a turn carries of each attachment (`message.received.attachments`). */
export interface AttachmentMeta {
  id: string;
  name: string;
  mimetype: string;
  bytes: number;
}

export interface AttachmentSpec {
  name: string;
  mimetype: string;
  bytes: number;
}

/** The alarm purpose of the sweep (section 3): armed for the next row that falls due. */
export const SWEEP_PURPOSE = "attachments";

export const readAttachment = (sql: Sql, id: string): AttachmentRec | null => sql.exec<AttachmentRec>("SELECT * FROM attachment WHERE id = ?", id)[0] ?? null;

export function apiAttachment(r: AttachmentRec): Attachment {
  return {
    id: r.id,
    sessionId: r.session_id,
    by: r.by,
    name: r.name,
    mimetype: r.mimetype,
    bytes: r.bytes,
    state: r.state,
    etag: r.etag,
    createdAt: new Date(r.created_at).toISOString(),
    attachedTo: r.turn_id ? { turnId: r.turn_id, messageId: r.message_id } : null,
  };
}

const metaOf = (r: AttachmentRec): AttachmentMeta => ({ id: r.id, name: r.name, mimetype: r.mimetype, bytes: r.bytes });

const notFound = (id?: string) => refusal("attachment_not_found", 404, "No such attachment.", id ? { attachmentId: id } : {});
const deleted = (id?: string) => refusal("attachment_deleted", 410, "The attachment was deleted.", id ? { attachmentId: id } : {});
const inUse = (id?: string) => refusal("attachment_in_use", 409, "The attachment is attached to a message.", id ? { attachmentId: id } : {});

// ------------------------------------------------------------------ who may (section 6)

/** Whether `p` may read the session, as Org's one rule says; false when Org has no such session. */
function readsSession(sql: Sql, p: Principal, sessionId: string): boolean {
  const s = readSession(sql, sessionId);
  return s !== null && seesSession(sql, p, s);
}

/** Whether `p` may read this attachment: its uploader, or one who may read its session. */
const visibleTo = (sql: Sql, p: Principal, r: AttachmentRec): boolean => r.by === byOf(p) || readsSession(sql, p, r.session_id);

/**
 * Whether `p` may write to the session (a `turn`), when Org holds it: `ok`; not seen: `not_found`;
 * seen but not a writer: `forbidden`. Absent from Org (a draft's session, not yet created): `none`.
 */
function writesSession(sql: Sql, p: Principal, sessionId: string): "ok" | "not_found" | "forbidden" | "none" {
  const s = readSession(sql, sessionId);
  if (!s) return "none";
  if (!seesSession(sql, p, s)) return "not_found";
  const access = accessOf(sql, sessionId);
  return access && mayWrite(p, "turn", access, sessionId) ? "ok" : "forbidden";
}

/** Whether the uploader (a `by` string) is a writer of the session, by its rows. */
function uploaderWrites(s: SessionRec, access: Access, by: string): boolean {
  if (access.writers !== "members") return access.writers.includes(by);
  return by === `user:${access.owner}` || s.audience === "org" || sharedWith(s).includes(by) || access.readers.includes(by);
}

// ------------------------------------------------------------------ the sweep's alarm

/** When the next row falls due to the sweep, or null. */
function nextDue(sql: Sql): number | null {
  return (
    sql.exec<{ at: number | null }>(
      `SELECT MIN(CASE state
         WHEN 'uploading' THEN state_at + ?
         WHEN 'deleted' THEN state_at + ?
         ELSE (CASE WHEN EXISTS (SELECT 1 FROM session WHERE id = attachment.session_id) THEN NULL ELSE state_at + ? END)
       END) AS at FROM attachment`,
      ATTACHMENT_UPLOADING_TTL_MS,
      ATTACHMENT_DELETED_KEEP_MS,
      ATTACHMENT_ORPHAN_TTL_MS,
    )[0]?.at ?? null
  );
}

function arm(sql: Sql): void {
  const at = nextDue(sql);
  if (at === null) alarms.clear(sql, SWEEP_PURPOSE);
  else alarms.set(sql, SWEEP_PURPOSE, at);
}

function oweDelete(sql: Sql, r: Pick<AttachmentRec, "id" | "session_id">): void {
  owed.add(sql, { group: `attachments:${r.session_id}`, key: `attachment:${r.id}`, call: "Attachments.delete", body: { sessionId: r.session_id, id: r.id } });
}

// ------------------------------------------------------------------ create, ready (PUT, POST …/complete)

/**
 * The row of an upload, before any byte is sent (section 4). A member or a member's key, of a
 * session Org does not hold yet or one they may write to. Idempotent by id: the same uploader's
 * same row answers `created: false`; another's, or another name, type or size, is refused. The
 * quota is taken now.
 */
export function create(sql: Sql, now: number, p: Principal, sessionId: string, id: string, spec: AttachmentSpec): Reply<{ attachment: Attachment; created: boolean }> {
  if (!isMember(p)) return refusal("forbidden", 403, "Only a member uploads attachments.");
  if (!isId("at", id)) return refusal("invalid_request", 400, "id must be at_ and 16 lowercase Crockford base32 characters.", { field: "attachmentId" });
  switch (writesSession(sql, p, sessionId)) {
    case "not_found":
      return refusal("session_not_found", 404, "No such session.");
    case "forbidden":
      return refusal("forbidden", 403, "You may not write to this session.", { reason: "not_a_writer" });
  }
  return sql.transaction(() => {
    const existing = readAttachment(sql, id);
    if (existing) {
      if (existing.state === "deleted") return deleted();
      if (existing.by !== byOf(p)) return refusal("forbidden", 403, "Another member uploaded this attachment.");
      if (existing.session_id !== sessionId || existing.name !== spec.name || existing.mimetype !== spec.mimetype || existing.bytes !== spec.bytes) {
        return refusal("content_mismatch", 400, "The attachment was created with another name, type, size or session.");
      }
      return { ok: true, attachment: apiAttachment(existing), created: false };
    }
    const sessionBytes = sql.exec<{ b: number | null }>("SELECT SUM(bytes) AS b FROM attachment WHERE session_id = ? AND state != 'deleted'", sessionId)[0]?.b ?? 0;
    if (sessionBytes + spec.bytes > ATTACHMENT_SESSION_BYTES_MAX) return refusal("attachment_quota", 429, "The session's attachments are at their limit.", { limit: "session", max: ATTACHMENT_SESSION_BYTES_MAX });
    const orgBytes = sql.exec<{ b: number | null }>("SELECT SUM(bytes) AS b FROM attachment WHERE state != 'deleted'")[0]?.b ?? 0;
    if (orgBytes + spec.bytes > ATTACHMENT_ORG_BYTES_MAX) return refusal("attachment_quota", 429, "The organization's attachments are at their limit.", { limit: "organization", max: ATTACHMENT_ORG_BYTES_MAX });
    sql.exec(
      "INSERT INTO attachment (id, session_id, by, name, mimetype, bytes, state, etag, turn_id, message_id, created_at, state_at) VALUES (?, ?, ?, ?, ?, ?, 'uploading', NULL, NULL, NULL, ?, ?)",
      id,
      sessionId,
      byOf(p),
      spec.name,
      spec.mimetype,
      spec.bytes,
      now,
      now,
    );
    arm(sql);
    return { ok: true, attachment: apiAttachment(readAttachment(sql, id)!), created: true };
  });
}

/** The object is stored: an `uploading` row is `ready` with its etag. One already `ready` or `attached` stays as it is (a retry). */
export function ready(sql: Sql, now: number, id: string, etag: string): Reply<{ attachment: Attachment }> {
  const r = readAttachment(sql, id);
  if (!r) return notFound();
  if (r.state === "deleted") return deleted();
  if (r.state !== "uploading") return { ok: true, attachment: apiAttachment(r) };
  sql.exec("UPDATE attachment SET state = 'ready', etag = ?, state_at = ? WHERE id = ?", etag, now, id);
  arm(sql);
  return { ok: true, attachment: apiAttachment(readAttachment(sql, id)!) };
}

// ------------------------------------------------------------------ read, list, delete

/** One attachment of the session, to its uploader or one who may read the session; anyone else gets `attachment_not_found`. */
export function read(sql: Sql, p: Principal, sessionId: string, id: string): Reply<{ attachment: Attachment }> {
  const r = readAttachment(sql, id);
  if (!r || r.session_id !== sessionId || !visibleTo(sql, p, r)) return notFound();
  if (r.state === "deleted") return deleted();
  return { ok: true, attachment: apiAttachment(r) };
}

/** The session's attachments, newest first: all of them to one who may read the session, else the caller's own uploads. */
export function list(sql: Sql, p: Principal, sessionId: string): Reply<{ attachments: Attachment[] }> {
  const all = readsSession(sql, p, sessionId);
  const rows = all
    ? sql.exec<AttachmentRec>("SELECT * FROM attachment WHERE session_id = ? AND state != 'deleted' ORDER BY created_at DESC, id DESC", sessionId)
    : sql.exec<AttachmentRec>("SELECT * FROM attachment WHERE session_id = ? AND by = ? AND state != 'deleted' ORDER BY created_at DESC, id DESC", sessionId, byOf(p));
  return { ok: true, attachments: rows.map(apiAttachment) };
}

/** Delete: its uploader, or a writer of the session. An attached one is refused; the object's delete is owed. */
export function remove(sql: Sql, now: number, p: Principal, sessionId: string, id: string): Reply<Record<never, never>> {
  const r = readAttachment(sql, id);
  if (!r || r.session_id !== sessionId || !visibleTo(sql, p, r)) return notFound();
  if (r.state === "deleted") return deleted();
  if (r.by !== byOf(p) && writesSession(sql, p, sessionId) !== "ok") return refusal("forbidden", 403, "Only its uploader or a writer of the session deletes an attachment.", { reason: "not_a_writer" });
  if (r.state === "attached") return inUse();
  return sql.transaction(() => {
    sql.exec("UPDATE attachment SET state = 'deleted', state_at = ? WHERE id = ?", now, id);
    oweDelete(sql, r);
    arm(sql);
    return { ok: true };
  });
}

// ------------------------------------------------------------------ reserve (a turn's attachments)

/**
 * A turn names these attachments (section 6, D5): each must be stored, of this session, uploaded by
 * the caller or by a writer of the session; `p` must write to the session when Org holds it. A
 * `ready` one becomes `attached` to this turn; one already attached stays with its first turn, and
 * this turn carries it as well. So a turn that is then not accepted leaves nothing to undo: its
 * attachments can be sent again, and those of a session that never comes to be are swept.
 * Answers what the turn carries, in the order given.
 */
export function reserve(sql: Sql, now: number, p: Principal, sessionId: string, turnId: string, messageId: string | null, ids: string[]): Reply<{ attachments: AttachmentMeta[] }> {
  if (p.kind === "platform") return refusal("forbidden", 403);
  const s = readSession(sql, sessionId);
  const access = s ? accessOf(sql, sessionId) : null;
  switch (writesSession(sql, p, sessionId)) {
    case "none":
      if (!isMember(p)) return refusal("session_not_found", 404, "No such session.");
      break;
    case "not_found":
      return refusal("session_not_found", 404, "No such session.");
    case "forbidden":
      return refusal("forbidden", 403, "You may not write to this session.", { reason: "not_a_writer" });
  }
  // Every row is judged before any is written: a refusal returned from the transaction would not undo it.
  const rows: AttachmentRec[] = [];
  for (const id of new Set(ids)) {
    const r = readAttachment(sql, id);
    if (!r || r.session_id !== sessionId || !visibleTo(sql, p, r)) return notFound(id);
    if (r.state === "deleted") return deleted(id);
    if (r.state === "uploading") return refusal("attachment_not_ready", 409, "The attachment is still uploading.", { attachmentId: id });
    if (r.by !== byOf(p) && !(s && access && uploaderWrites(s, access, r.by))) return notFound(id);
    rows.push(r);
  }
  return sql.transaction(() => {
    for (const r of rows) {
      if (r.state === "ready") sql.exec("UPDATE attachment SET state = 'attached', turn_id = ?, message_id = ?, state_at = ? WHERE id = ?", turnId, messageId, now, r.id);
    }
    arm(sql);
    return { ok: true, attachments: rows.map(metaOf) };
  });
}

// ------------------------------------------------------------------ the sweep, a session's removal

/**
 * The sweep (section 3, 8): an `uploading` row older than a day, and a `ready` or `attached` row
 * of a session Org never came to hold older than a day, are deleted (their objects' deletes owed);
 * a `deleted` row past its keep is dropped. Re-arms itself for the next row due.
 */
export function sweep(sql: Sql, now: number): { swept: number; dropped: number } {
  return sql.transaction(() => {
    const due = sql.exec<AttachmentRec>(
      `SELECT * FROM attachment WHERE (state = 'uploading' AND state_at <= ?)
         OR (state IN ('ready', 'attached') AND state_at <= ? AND NOT EXISTS (SELECT 1 FROM session WHERE id = attachment.session_id))`,
      now - ATTACHMENT_UPLOADING_TTL_MS,
      now - ATTACHMENT_ORPHAN_TTL_MS,
    );
    for (const r of due) {
      sql.exec("UPDATE attachment SET state = 'deleted', state_at = ?, turn_id = NULL, message_id = NULL WHERE id = ?", now, r.id);
      oweDelete(sql, r);
    }
    const dropped = sql.exec<{ id: string }>("DELETE FROM attachment WHERE state = 'deleted' AND state_at <= ? RETURNING id", now - ATTACHMENT_DELETED_KEEP_MS).length;
    arm(sql);
    return { swept: due.length, dropped };
  });
}

/** The session is being removed: its rows go with it (a later reference is `attachment_not_found`, as the session is), its objects as one owed call. */
export function removeForSession(sql: Sql, sessionId: string): void {
  const rows = sql.exec<{ id: string }>("DELETE FROM attachment WHERE session_id = ? RETURNING id", sessionId);
  for (const r of rows) owed.drop(sql, { key: `attachment:${r.id}` });
  if (rows.length) owed.add(sql, { group: `attachments:${sessionId}`, key: `attachments:${sessionId}`, call: "Attachments.removeAll", body: { sessionId } });
}

/** The sum of a session's live attachments' bytes (tests, the quota). */
export const bytesOf = (sql: Sql, sessionId: string): number => sql.exec<{ b: number | null }>("SELECT SUM(bytes) AS b FROM attachment WHERE session_id = ? AND state != 'deleted'", sessionId)[0]?.b ?? 0;
