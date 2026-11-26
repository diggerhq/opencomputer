// Org's mutations (spec 19.2, 39): one function per name, in `MUTATIONS`.
//
// The shape: `(tx, p, args) => MutationOutcome`.
// - `tx` is the transaction (`../tx.ts`): read through `tx.sql` and the readers (`../records.ts`), write and
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
// undo.ts; table.ts the names, routes and argument shapes clients send by; outcome.ts the shapes.
// Shared by them: args.ts (argument checks, `byFor`), changes.ts (`Changes`, which writes field
// changes with their effects and makes every op's `fields` and `inverse`; undo.ts replays them),
// done.ts, places.ts, anchor.ts, remove-session.ts, track-agent.ts.

import type { Principal } from "../../../auth/principal.js";
import type { Tx } from "../tx.js";
import { keeps, refuse, type MutationFn, type MutationOutcome } from "./outcome.js";
import { THREAD_MUTATIONS } from "./thread.js";
import { TRACK_MUTATIONS } from "./track.js";
import { DOC_MUTATIONS } from "./doc.js";
import { RESULT_MUTATIONS } from "./result.js";
import { PROPOSAL_MUTATIONS } from "./proposal.js";
import { UNDO_MUTATIONS } from "./undo.js";
import type { MutationName } from "./table.js";

export { applied, refuse, refuseKeeping, type MutationFn, type MutationOutcome, type MutationRefusal } from "./outcome.js";

/** One per name in the table (table.ts). */
export const MUTATIONS: Record<MutationName, MutationFn> = {
  ...THREAD_MUTATIONS,
  ...TRACK_MUTATIONS,
  ...DOC_MUTATIONS,
  ...RESULT_MUTATIONS,
  ...PROPOSAL_MUTATIONS,
  ...UNDO_MUTATIONS,
};

/** Run one mutation by name. A refusal leaves no write behind. */
export function runMutation(tx: Tx, p: Principal, name: string, args: unknown): MutationOutcome {
  const fn = Object.hasOwn(MUTATIONS, name) ? MUTATIONS[name as MutationName] : undefined;
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
