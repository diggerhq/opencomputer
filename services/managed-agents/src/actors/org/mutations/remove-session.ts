// Removing a session and every row that names it.

import { owed } from "../../../durable/outbox.js";
import { removeForSession } from "../attachments.js";
import type { SessionRec } from "../records.js";
import type { Tx } from "../tx.js";

/**
 * Remove a session and every row that names it (spec 39, `thread.delete`): its place, results and
 * their reviews, proposals on it, read marks, ops; stop its runner and destroy its log, as owed
 * calls. Does not dissolve its track; the caller does (through `Changes`).
 */
export function removeSession(tx: Tx, s: SessionRec): void {
  for (const r of tx.sql.exec<{ id: string }>("SELECT id FROM result WHERE session_id = ?", s.id)) {
    tx.sql.exec("DELETE FROM review WHERE result_id = ?", r.id);
    tx.remove("result", r.id);
  }
  for (const r of tx.sql.exec<{ id: string }>("SELECT id FROM proposal WHERE target = ?", s.id)) tx.remove("proposal", r.id);
  for (const r of tx.sql.exec<{ id: string }>("SELECT id FROM op WHERE session_id = ?", s.id)) tx.remove("op", r.id);
  for (const r of tx.sql.exec<{ member: string }>("SELECT member FROM read WHERE session_id = ?", s.id)) tx.remove("read", r.member, s.id);
  tx.remove("place", s.id);
  tx.remove("session", s.id);
  owed.drop(tx.sql, { key: `access:log:${s.id}` });
  owed.drop(tx.sql, { key: `access:host:${s.id}` });
  owed.drop(tx.sql, { key: `start:${s.id}` });
  tx.stop(s.id, s.machine);
  tx.destroy(s.id);
  // Its attachments go with it: the objects as one owed call (work 126).
  removeForSession(tx.sql, tx.now, s.id);
}
