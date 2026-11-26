// Argument checks the mutations share, and the `by` a mutation records.

import { byOf, type Principal } from "../../../auth/principal.js";

export const isStr = (v: unknown, max = 10_000): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
export const isSid = (v: unknown): v is string => typeof v === "string" && /^cs_[0-9A-Za-z]{4,40}$/.test(v);
export const isTid = (v: unknown): v is string => typeof v === "string" && /^trk_[0-9A-Za-z]{4,40}$/.test(v);
export const optStr = (v: unknown, max = 10_000): v is string | undefined | null => v === undefined || v === null || (typeof v === "string" && v.length <= max);
export const isBy = (v: unknown): v is string => typeof v === "string" && /^(user|agent|rule):.+$|^platform$/.test(v);

/**
 * The `by` a mutation records. A platform caller (a rule of section 39's second table) may name
 * its rule in `args.by` (`rule:<name>`); everyone else is who they are.
 */
export function byFor(p: Principal, args: Record<string, unknown>): string {
  if (p.kind === "platform" && typeof args.by === "string" && args.by.startsWith("rule:")) return args.by;
  return byOf(p);
}
