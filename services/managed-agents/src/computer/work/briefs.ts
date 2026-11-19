// The Computer object's half of the Work API's composition (work tracking 3.10): for the sessions
// linked to the items on a page, a brief of each the caller may see; the members behind owner and
// author emails; and the caller's own emails, for `mine`. The Worker joins this with the Work
// index's items; neither object calls the other.
//
// One call (`work.context`) where the design names two (`briefs`, `people`): the page needs both,
// and one round trip to the Computer object is cheaper than two.

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
