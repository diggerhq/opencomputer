// Who may use a session started from the dashboard, opc or the API (CTO-37), and who may change that.
// Slack sessions keep their own roles (access.ts, `!access`); here they are only their linked owner's.
//
//   owner   only the owner (also a row with no stored mode: from before this, or unknown)
//   org     every member of the organization
//   people  the owner and the listed members (`usr_…`)
//
// Owner first: the owner controls the session. Using it is reading or driving it: get, list, history, writes,
// attach and workspace files (terminals have their own rule, computer's `mayOpenTerminal`). Only the owner
// manages it: changes its access, renames, archives or changes its settings. Being an org admin gives nothing
// here: an admin uses a session only when its access names them or is `org`, and asks the owner to share it.
// The owner's secrets and subscription stay with the session whoever drives it (Q6).
//
// Pure: no I/O, no SQL. sessions-api.ts stores the mode and list in `sessions.access_mode` and
// `sessions.access_people` and pushes `membersOf` to the host as `SessionAccess.members`.

export type AccessMode = "owner" | "org" | "people";
export const ACCESS_MODES: readonly AccessMode[] = ["owner", "org", "people"];

/** The API's `Session.access`: `people` empty unless the mode is `people`; the owner is never listed. */
export interface SessionAccessView {
  mode: AccessMode;
  people: string[];
}

/** What a create or patch asks for; `people` as given (member ids, WorkOS user ids or emails), resolved by the caller. */
export interface AccessInput {
  mode: AccessMode;
  people?: string[];
}

/** The organization's default for sessions from the dashboard, opc and the API (settings key; Slack's is `accessDefault`). */
export const API_ACCESS_DEFAULT_SETTING = "apiAccessDefault";
export type ApiAccessDefault = "owner" | "org";
/** The most people one session may list; a longer list is refused, never cut. */
export const MAX_ACCESS_PEOPLE = 50;
/** Shown wherever sharing is set (Q6). */
export const SHARING_WARNING = "People with access drive this session with the owner's secrets and subscription.";

export interface AccessRow {
  originType: string;
  ownerUserId: string | null;
  accessMode: string | null;
  accessPeople: string | null;
}

export interface AccessCaller {
  member: string;
}

/** An unknown or missing value is `owner`: a new organization's sessions are private. */
export function readApiAccessDefault(value: string | undefined | null): ApiAccessDefault {
  return value === "org" ? "org" : "owner";
}

function people(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The session's access as the API shows it. A Slack session is its owner's here (its drivers live in Slack). Only
 * a stored `org` or `people` shares it: no mode (a row from before access modes) or an unknown one is `owner`.
 */
export function accessOf(row: AccessRow): SessionAccessView {
  if (row.originType === "slack") return { mode: "owner", people: [] };
  if (row.accessMode === "org") return { mode: "org", people: [] };
  if (row.accessMode === "people") return { mode: "people", people: people(row.accessPeople) };
  return { mode: "owner", people: [] };
}

/** Whether the caller is the session's owner. */
export function isOwner(row: Pick<AccessRow, "ownerUserId">, who: AccessCaller): boolean {
  return row.ownerUserId !== null && row.ownerUserId === who.member;
}

/** Whether the caller may read or drive the session at all. */
export function mayUse(row: AccessRow, who: AccessCaller): boolean {
  if (isOwner(row, who)) return true;
  const a = accessOf(row);
  if (row.originType === "slack") return false;
  return a.mode === "org" || (a.mode === "people" && a.people.includes(who.member));
}

/** Whether the caller may change the session's access (`canManageAccess`): its owner only; an admin is no exception. */
export function mayManage(row: AccessRow, who: AccessCaller): boolean {
  return row.originType !== "slack" && isOwner(row, who);
}

/** Whether the caller may rename, archive, unarchive, relabel or change the settings of the session: its owner only. */
export function mayChangeSession(row: AccessRow, who: AccessCaller): boolean {
  return isOwner(row, who);
}

/** `SessionAccess.members` for the host: null is every member; the owner is implicit. Slack sessions stay `[owner]`. */
export function membersOf(row: AccessRow): string[] | null {
  if (row.originType === "slack") return row.ownerUserId ? [row.ownerUserId] : [];
  const a = accessOf(row);
  return a.mode === "org" ? null : a.people;
}

/** The stored columns for a mode and resolved list: duplicates and the owner dropped, sorted. */
export function storedAccess(owner: string, mode: AccessMode, list: readonly string[] = []): { mode: AccessMode; people: string | null } {
  if (mode !== "people") return { mode, people: null };
  return { mode, people: JSON.stringify([...new Set(list)].filter((m) => m !== owner).sort()) };
}

/** Validates `access` in a create or patch body; the error names the field. */
export function parseAccessInput(value: unknown): { value: AccessInput } | { field: string; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { field: "access", message: "access must be an object: { mode, people? }." };
  const input = value as Record<string, unknown>;
  for (const k of Object.keys(input)) if (k !== "mode" && k !== "people") return { field: `access.${k}`, message: `Unknown field access.${k}.` };
  if (typeof input.mode !== "string" || !ACCESS_MODES.includes(input.mode as AccessMode)) {
    return { field: "access.mode", message: "access.mode is owner, org or people." };
  }
  const mode = input.mode as AccessMode;
  if (input.people === undefined) return { value: { mode } };
  if (!Array.isArray(input.people) || input.people.some((p) => typeof p !== "string" || p.length < 1 || p.length > 320)) {
    return { field: "access.people", message: "access.people is a list of member ids or emails." };
  }
  if (mode !== "people" && input.people.length) return { field: "access.people", message: "access.people is only for mode people." };
  if (input.people.length > MAX_ACCESS_PEOPLE) return { field: "access.people", message: `At most ${MAX_ACCESS_PEOPLE} people.` };
  return { value: { mode, people: input.people as string[] } };
}
