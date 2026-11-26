// Org's mutations (spec 19.2, 39): one function per name, in `MUTATIONS`.
//
// The shape: `(tx, p, args) => MutationOutcome`.
// - `tx` is the transaction (`../tx.ts`): read through `tx.sql` and the readers there, write and
//   then `tx.stamp(table, ...key)`, `tx.remove`, `tx.op` (the undo row, when section 39 gives an
//   inverse), `tx.occur` / `tx.occurFor`, and the owed calls (`tx.sendAccess`, `tx.interrupt`, …).
// - `p` is the caller. The function's first act is its authorization (19.2's table): a row the
//   caller cannot see, or may not change, is `refuse("not_found")`; a rule's no is
//   `refuse("refused", reason)`; arguments of the wrong shape are `refuse("invalid_request", why)`.
// - `args` is the request's body plus the ids of its path (`sid`, `tid`, …), unchecked.
// - It answers `applied(value?)` or a refusal. `runMutation` undoes whatever a refused function
//   wrote, so a mutation may call another through `runMutation` and pass its refusal on.
// The envelope (the `Idempotency-Key`, the publish) is `Org.mutate`'s, not a mutation's.
//
// Files: thread.ts, track.ts (40.7), doc.ts (doc.save, read.set, pref.set), result.ts, proposal.ts,
// undo.ts; common.ts holds the argument checks and `Changes`, which writes field changes with their
// effects and makes every op's `fields` and `inverse` (undo.ts replays them); outcome.ts the shapes.

import { byOf, type Principal } from "../../actor/principal.js";
import { agentArranges, isPerson, ownsSession, parse, readPlace, readSession, seesSession, type Tx } from "../tx.js";
import { applied, keeps, refuse, type MutationFn, type MutationOutcome } from "./outcome.js";
import { THREAD_MUTATIONS } from "./thread.js";
import { TRACK_MUTATIONS } from "./track.js";
import { DOC_MUTATIONS } from "./doc.js";
import { RESULT_MUTATIONS } from "./result.js";
import { PROPOSAL_MUTATIONS } from "./proposal.js";
import { UNDO_MUTATIONS } from "./undo.js";

export { applied, refuse, refuseKeeping, type MutationFn, type MutationOutcome, type MutationRefusal } from "./outcome.js";

/** `thread.rename { sid, title }`: sets `title`, `title_by`; the old title joins `former_titles`. Inverse: the old two. */
const threadRename: MutationFn = (tx, p, args) => {
  const { sid, title } = args;
  if (typeof sid !== "string" || typeof title !== "string" || title.trim() === "" || title.length > 200) return refuse("invalid_request", "title");
  const session = readSession(tx.sql, sid);
  if (!session || session.role === "track" || !seesSession(tx.sql, p, session)) return refuse("not_found");
  if (p.kind === "agent") {
    if (!agentArranges(tx.sql, p, readPlace(tx.sql, sid))) return refuse("not_found");
    if (isPerson(session.title_by)) return refuse("refused", "user_set");
  } else if (p.kind !== "platform" && !ownsSession(p, session)) return refuse("not_found");

  const by = byOf(p);
  const next = title.trim();
  const former = parse<string[]>(session.former_titles, []);
  if (session.title !== null) former.push(session.title);
  tx.sql.exec("UPDATE session SET title = ?, title_by = ?, former_titles = ? WHERE id = ?", next, by, JSON.stringify(former.slice(-20)), sid);
  tx.stamp("session", sid);
  const op = tx.op({
    by,
    name: "thread.rename",
    args: { sid, title: next },
    inverse: { title: session.title, titleBy: session.title_by },
    fields: { title: next, title_by: by },
    sessionId: sid,
    trackId: readPlace(tx.sql, sid)?.track_id ?? null,
    audience: session.audience,
  });
  return applied({ op });
};

export const MUTATIONS: Record<string, MutationFn> = {
  "thread.rename": threadRename,
  ...THREAD_MUTATIONS,
  ...TRACK_MUTATIONS,
  ...DOC_MUTATIONS,
  ...RESULT_MUTATIONS,
  ...PROPOSAL_MUTATIONS,
  ...UNDO_MUTATIONS,
};

/** Run one mutation by name. A refusal leaves no write behind. */
export function runMutation(tx: Tx, p: Principal, name: string, args: unknown): MutationOutcome {
  const fn = MUTATIONS[name];
  if (!fn) return refuse("invalid_request", "unknown_mutation");
  const input = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const out = tx.attempt(() => fn(tx, p, input));
  const keep = out.ok ? undefined : keeps.get(out);
  if (keep) {
    keeps.delete(out as never);
    tx.attempt(() => {
      keep(tx);
      return { ok: true };
    });
  }
  return out;
}
