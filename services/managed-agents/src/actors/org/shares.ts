// Threads shared into a thread (sharing throughout, not only Slack links): a turn sent to a
// thread that names another thread, by its id (`cs_…`, bare or in an app link) or by the Slack
// thread it runs on, shares that thread with the one it was sent to, when the sender could see it.
// The grant is a `share` row; from then on the thread's agent reads the shared one (`accessOf`
// readers, `seesSession`, `listSessions`). It is never taken back here: the person shared it.

import { mayWrite, type Principal } from "../../auth/principal.js";
import type { Sql } from "../../durable/sql.js";
import { accessOf } from "./access.js";
import { readSession, type SessionRec } from "./records.js";
import { transact } from "./tx.js";
import { seesSession } from "./who-may.js";

/** At most this many references of one turn are looked at. */
export const MAX_REFS = 20;

const SESSION_REF = /\bcs_[0-9a-hjkmnp-tv-z]{16}\b/g;
const SLACK_REF = /https:\/\/[A-Za-z0-9.-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{16}(?:\?[^\s>)"']*)?/g;

/** The threads a turn's text names: session ids and Slack thread links, in order, each once, `MAX_REFS` at most. */
export function threadRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(SESSION_REF)) refs.add(m[0]);
  for (const m of text.matchAll(SLACK_REF)) refs.add(m[0]);
  return [...refs].slice(0, MAX_REFS);
}

/** The session a reference names: by id, or the one on a Slack thread (as `listSessions`' `slackThread` finds it). */
function sessionOfRef(sql: Sql, ref: string): SessionRec | null {
  if (ref.startsWith("cs_")) return readSession(sql, ref);
  const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(ref);
  const thread = /[?&]thread_ts=(\d{10}\.\d{6})/.exec(ref)?.[1];
  if (!link) return null;
  return sql.exec<SessionRec>("SELECT * FROM session WHERE slack_thread_key LIKE ?", `%:${link[1]}:${thread ?? `${link[2]}.${link[3]}`}`)[0] ?? null;
}

/**
 * Share the threads `refs` name into `to`, from `p`: each one `p` sees (`seesSession`) and that is not
 * `to` itself gets a `share` row, and its access is sent again so its log and machine hold the new
 * reader. `p` must be able to send `to` a turn, as the log checked. Returns the ids newly shared.
 */
export function share(sql: Sql, now: number, p: Principal, to: string, refs: string[]): { shared: string[] } {
  // The platform sees everything, so a turn it sends (a track's first input, a wake digest) carries
  // text others wrote: it shares nothing, or any id in that text would open the thread it names.
  if (p.kind === "platform") return { shared: [] };
  if (!readSession(sql, to)) return { shared: [] };
  const access = accessOf(sql, to);
  if (!access || !mayWrite(p, "turn", access, to)) return { shared: [] };
  const by = p.kind === "agent" ? `agent:${p.session ?? p.subject}` : `user:${p.subject}`;
  return transact(sql, now, (tx) => {
    const shared: string[] = [];
    for (const ref of refs.slice(0, MAX_REFS)) {
      const s = sessionOfRef(sql, ref);
      if (!s || s.id === to || shared.includes(s.id) || !seesSession(sql, p, s)) continue;
      const inserted = sql.exec("INSERT OR IGNORE INTO share (session_id, to_session, by, at) VALUES (?, ?, ?, ?) RETURNING session_id", s.id, to, by, now);
      if (inserted.length === 0) continue;
      shared.push(s.id);
      // A new revision, so the log and the machine take the access over the one they hold.
      tx.version();
      tx.sendAccess(s.id);
    }
    return { shared };
  });
}
