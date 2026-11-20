// The Computer object's half of the Work API's composition (work tracking 3.10): for the sessions
// linked to the items on a page, a brief of each the caller may see; the members behind owner and
// author emails; and the caller's own emails, for `mine`. The Worker joins this with the Work
// index's items; neither object calls the other.
//
// One call (`work.context`) where the design names two (`briefs`, `people`): the page needs both,
// and one round trip to the Computer object is cheaper than two.
//
// `work.stamp` is the open list's ETag part from this object: a counter that SQLite triggers move
// on every write to `sessions` or `people` (the two tables a brief or a person is read from), so no
// write path can change a brief without moving it, whether or not it touches `updated_at`. The
// Worker reads it before composing a page; a match answers 304 without `work.context`.

import type { Session, SessionStatus } from "../api-types.js";
import type { ApiCaller, ApiReply, ApiRow } from "../sessions-api.js";

/** At most this many linked sessions and emails per call. */
export const CONTEXT_MAX = 2000;

export interface WorkContextOp {
  op: "work.context";
  /** The ids in `Session:` trailers: a session id, or a Slack session's key. */
  sessionIds: string[];
  /** Owner and author emails to resolve to members. */
  emails: string[];
}

export interface WorkStampOp {
  op: "work.stamp";
}

/** A session's references, as a `Session:` trailer may name it: its public id and its key. */
export interface WorkRefsOp {
  op: "work.refs";
  sessionId: string;
}

/**
 * The stamp's counter and triggers, and the indexes the context's email lookups use. Run once the
 * `sessions` table has its API columns and `people` exists.
 */
export function workStampSetup(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS work_stamp (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
    INSERT OR IGNORE INTO work_stamp (id, n) VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS work_stamp_sessions_insert AFTER INSERT ON sessions BEGIN UPDATE work_stamp SET n = n + 1 WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS work_stamp_sessions_update AFTER UPDATE ON sessions BEGIN UPDATE work_stamp SET n = n + 1 WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS work_stamp_sessions_delete AFTER DELETE ON sessions BEGIN UPDATE work_stamp SET n = n + 1 WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS work_stamp_people_insert AFTER INSERT ON people BEGIN UPDATE work_stamp SET n = n + 1 WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS work_stamp_people_update AFTER UPDATE ON people BEGIN UPDATE work_stamp SET n = n + 1 WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS work_stamp_people_delete AFTER DELETE ON people BEGIN UPDATE work_stamp SET n = n + 1 WHERE id = 1; END;
    CREATE INDEX IF NOT EXISTS sessions_owner_email_lower ON sessions (lower(owner_email));
    CREATE INDEX IF NOT EXISTS sessions_owner_user ON sessions (owner_user_id);
    CREATE INDEX IF NOT EXISTS sessions_owner_slack ON sessions (owner_id);
    CREATE INDEX IF NOT EXISTS people_git_email_lower ON people (lower(git_email));
  `);
}

/** The counter: moves whenever a session or a person changes. */
export function workStamp(sql: SqlStorage): ApiReply {
  const row = sql.exec<{ n: number }>("SELECT n FROM work_stamp WHERE id = 1").toArray()[0];
  return { status: 200, body: { stamp: row?.n ?? 0 } };
}

export interface SessionBrief {
  /** The session's public id. */
  id: string;
  title: string | null;
  ownerId: string | null;
  ownerName: string | null;
  status: SessionStatus;
  /** The oldest open ask's time; null when nothing is asked. */
  openAskAt: string | null;
  lastActiveAt: string;
}

export interface WorkContext {
  /** By the id the trailer named; sessions the caller may not see are absent. */
  sessions: Record<string, SessionBrief>;
  /** By lowercased email: the member it belongs to, when one is known. */
  people: Record<string, { id: string | null; name: string | null }>;
  /** The caller's emails, lowercased: the one the edge asserted and the git emails of their sessions. */
  callerEmails: string[];
}

/** What `workContext` needs of the Computer object. */
export interface WorkContextDeps {
  sql: SqlStorage;
  api: {
    row(sessionId: string): ApiRow | undefined;
    rowByKey(key: string): ApiRow | undefined;
    visible(caller: ApiCaller, sessionId: string): ApiRow | undefined;
    compose(row: ApiRow): Session;
  };
}

const NO_REPLY = /noreply/i;

/**
 * What a commit's `Session:` trailer may name for the session: its public id, and the key a host
 * before the public ids wrote (the hook writes `SP_SESSION_ID`, which is either). 404 for a session
 * the caller may not see, as the sessions routes answer.
 */
export function workRefs(deps: Pick<WorkContextDeps, "api">, caller: ApiCaller, op: WorkRefsOp): ApiReply {
  const row = typeof op.sessionId === "string" ? deps.api.visible(caller, op.sessionId) : undefined;
  if (!row?.sessionId) return { status: 404, error: { code: "session_not_found", message: "No such session." } };
  return { status: 200, body: { refs: [...new Set([row.sessionId, row.key].filter((r) => !!r))] } };
}

export function workContext(deps: WorkContextDeps, caller: ApiCaller, op: WorkContextOp): ApiReply {
  const sessions: Record<string, SessionBrief> = {};
  for (const ref of op.sessionIds.slice(0, CONTEXT_MAX)) {
    const row = deps.api.row(ref) ?? deps.api.rowByKey(ref);
    if (!row?.sessionId || !deps.api.visible(caller, row.sessionId)) continue;
    const s = deps.api.compose(row);
    const open = s.asks.filter((a) => a.status === "open").map((a) => a.createdAt).sort();
    sessions[ref] = {
      id: s.id,
      title: s.title || null,
      ownerId: row.ownerUserId,
      ownerName: row.ownerName,
      status: s.status,
      openAskAt: open[0] ?? null,
      lastActiveAt: s.lastActiveAt,
    };
  }

  const people: WorkContext["people"] = {};
  for (const raw of op.emails.slice(0, CONTEXT_MAX)) {
    const email = raw.toLowerCase();
    if (people[email]) continue;
    const owner = deps.sql
      .exec<{ id: string | null; name: string | null }>(
        "SELECT owner_user_id AS id, owner_name AS name FROM sessions WHERE lower(owner_email) = ? AND owner_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
        email,
      )
      .toArray()[0];
    if (owner) {
      people[email] = { id: owner.id, name: owner.name };
      continue;
    }
    const person = deps.sql
      .exec<{ name: string; id: string | null }>(
        `SELECT p.git_name AS name, (SELECT s.owner_user_id FROM sessions s WHERE s.owner_id = p.slack_user_id AND s.owner_user_id IS NOT NULL LIMIT 1) AS id
         FROM people p WHERE lower(p.git_email) = ? LIMIT 1`,
        email,
      )
      .toArray()[0];
    if (person) people[email] = { id: person.id, name: person.name };
  }

  const mine = new Set<string>();
  if (caller.email) mine.add(caller.email.toLowerCase());
  for (const r of deps.sql
    .exec<{ email: string }>(
      `SELECT owner_email AS email FROM sessions WHERE owner_user_id = ? AND owner_email IS NOT NULL
       UNION SELECT git_email AS email FROM people WHERE slack_user_id IN (SELECT owner_id FROM sessions WHERE owner_user_id = ?)`,
      caller.member,
      caller.member,
    )
    .toArray()) {
    if (r.email && !NO_REPLY.test(r.email)) mine.add(r.email.toLowerCase());
  }

  const body: WorkContext = { sessions, people, callerEmails: [...mine] };
  return { status: 200, body };
}
