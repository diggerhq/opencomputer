// Who a session's rows are for and shared with (spec 35.1, 36.2).

import type { Origin, SessionAccess } from "../../api-objects/objects.js";
import type { SessionRec } from "./records.js";
import { parse } from "./parse-json.js";

/** `by` is a person's: `user:<usr_…>` or `user:slack:<team>:<user>` (spec 34.1). */
export const isPerson = (by: string | null | undefined): boolean => typeof by === "string" && by.startsWith("user:");
/** The audience of a session's rows (spec 35.1): `member:<owner>` from Slack and for a role session, else `org`. */
export const audienceOf = (owner: string, origin: Origin, role: string | null): string => (origin.type === "slack" || role !== null ? `member:${owner}` : "org");

/** The people a session is shared with beyond its audience: the persons in its `writers` list, the owner aside (spec 36.2). */
export function sharedWith(s: Pick<SessionRec, "owner" | "writers">): string[] {
  const writers = parse<"members" | string[]>(s.writers, "members");
  return writers === "members" ? [] : writers.filter((by) => isPerson(by) && by !== `user:${s.owner}`);
}

/**
 * The API's `Session.access`, read from the rows (spec 36.2): `org` is the `org` audience; otherwise
 * the owner's audience, and `people` are the members in `writers` besides the owner. A Slack session
 * is its owner's here: who drives it is set in Slack (`!access`).
 */
export function accessView(s: Pick<SessionRec, "owner" | "origin" | "audience" | "writers">): SessionAccess {
  if (s.audience === "org") return { mode: "org", people: [] };
  if (parse<Origin>(s.origin, { type: "api", client: null, slack: null }).type === "slack") return { mode: "owner", people: [] };
  const people = sharedWith(s).filter((by) => by.startsWith("user:usr_")).map((by) => by.slice(5));
  return people.length ? { mode: "people", people } : { mode: "owner", people: [] };
}

/** The rows of an access: `org` is the `org` audience and any member writes; else the owner's audience, written by the owner and the people. */
export const accessRows = (owner: string, a: SessionAccess): { audience: string; writers: "members" | string[] } =>
  a.mode === "org" ? { audience: "org", writers: "members" } : { audience: `member:${owner}`, writers: [`user:${owner}`, ...(a.mode === "people" ? a.people : []).map((m) => `user:${m}`)] };
