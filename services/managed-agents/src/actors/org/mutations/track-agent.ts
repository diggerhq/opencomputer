// A track's agent session, and the machine it runs on by default.

import type { Origin } from "../../../api-objects/objects.js";
import type { SessionRec } from "../records.js";
import { emptySummary } from "../summary.js";
import type { Tx } from "../tx.js";

/** The organization's first machine: its id is the organization's (spec 34.1). */
export const firstMachine = (tx: Tx): string => tx.sql.exec<{ org: string | null }>("SELECT org FROM meta WHERE k = 1")[0]?.org ?? "";

/** A track's agent session (spec 40.7 steps 1 to 3): role `track`, written only by the owner, started with its first input. */
export function addTrackAgent(
  tx: Tx,
  a: { id: string; trackId: string; owner: string; ownerName: string | null; ownerEmail: string | null; origin: Origin; machine: string; by: string; name: string | null; firstInput: string },
): SessionRec {
  const s = tx.addSession({
    id: a.id,
    owner: a.owner,
    ownerName: a.ownerName,
    ownerEmail: a.ownerEmail,
    origin: a.origin,
    machine: a.machine,
    role: "track",
    createdBy: a.by,
    title: a.name,
    titleBy: a.name === null ? null : a.by,
    writers: [`user:${a.owner}`],
    summary: emptySummary({}, null),
  });
  tx.start(a.id, { firstInput: a.firstInput });
  tx.sendAccess(a.id);
  return s;
}
