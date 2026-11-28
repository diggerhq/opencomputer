// The mutation function's shape and its answers (see index.ts).

import type { Principal } from "../../../auth/principal.js";
import type { EdgeFacts } from "../contract.js";
import type { Tx } from "../tx.js";

export type MutationRefusal = {
  ok: false;
  code: "refused" | "not_found" | "taken" | "conflict" | "invalid_request" | "forbidden";
  reason: string;
  /** More for the reply's `error` (a `conflict`'s current `rev` and `text`, what a forced undo would do). */
  [field: string]: unknown;
};
export type MutationOutcome = { ok: true; value?: unknown } | MutationRefusal;
/** `edge`: what the edge knows and a body cannot claim (the person's name, what GitHub did). */
export type MutationFn = (tx: Tx, p: Principal, args: Record<string, unknown>, edge: EdgeFacts) => MutationOutcome;

export const applied = (value?: unknown): MutationOutcome => (value === undefined ? { ok: true } : { ok: true, value });
export const refuse = (code: MutationRefusal["code"], reason: string = code, more: Record<string, unknown> = {}): MutationRefusal => ({ ...more, ok: false, code, reason });

/** Writes a refusal keeps: run after the refused function's writes are rolled back (spec 39: `doc.save`'s `edit` proposal, a voided proposal). */
export const keeps = new WeakMap<MutationRefusal, (tx: Tx) => void>();

/** A refusal that still writes `keep` (in the same transaction, after the mutation's own writes are undone). */
export function refuseKeeping(code: MutationRefusal["code"], reason: string, more: Record<string, unknown>, keep: (tx: Tx) => void): MutationRefusal {
  const out = refuse(code, reason, more);
  keeps.set(out, keep);
  return out;
}
