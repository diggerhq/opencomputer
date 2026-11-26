// Marking a thread done, and accepting the open proposals a change answers.

import type { PlaceRec } from "../records.js";
import type { Tx } from "../tx.js";
import type { Changes } from "./changes.js";

/** The thread-done fields of spec 39 (`thread.done`), and the open `done` proposal on it accepted. */
export function markDone(ch: Changes, place: PlaceRec, outcome: string | null): void {
  ch.set("place", place.session_id, { done_at: ch.tx.now, outcome, done_by: ch.by, earlier_at: place.keep === 1 ? null : ch.tx.now });
  acceptOpenProposals(ch.tx, place.session_id, "done");
}

export function acceptOpenProposals(tx: Tx, target: string, kind: string): void {
  for (const r of tx.sql.exec<{ id: string }>("SELECT id FROM proposal WHERE target = ? AND kind = ? AND state = 'open'", target, kind)) {
    tx.sql.exec("UPDATE proposal SET state = 'accepted' WHERE id = ?", r.id);
    tx.stamp("proposal", r.id);
  }
}
