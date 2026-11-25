// Who may drive a session (attach, write, open a terminal), as the access
// list blue sends the host (`access` frames, computer's protocol-api.ts
// SessionAccess) and as the dashboard's terminal ticket is checked at minting.
//
// Invariants: an API session is driven by every member of the organization
// (`members: null`); a Slack session only by its owner once they linked the
// dashboard, and a Slack session with no linked owner has no list at all.
// Being an organization admin adds nothing (web terminal MVP, Mohamed's
// decision): admins may change who drives a session, not drive one that does
// not name them.

import type { CalvinSessionAccess } from "./protocol.js";

export interface AccessRow {
  sessionId: string;
  originType: string;
  ownerUserId: string | null;
}

/** The session's access list, or null when no member may drive it. */
export function accessOf(row: AccessRow): CalvinSessionAccess | null {
  if (row.originType !== "slack") return { sessionId: row.sessionId, owner: row.ownerUserId ?? "", members: null };
  return row.ownerUserId ? { sessionId: row.sessionId, owner: row.ownerUserId, members: [row.ownerUserId] } : null;
}

/** Whether `member` (`usr_…`) may drive the session: its owner, a member it names, or anyone when it names none. */
export function mayDrive(row: AccessRow, member: string): boolean {
  const access = accessOf(row);
  return !!access && (access.owner === member || access.members === null || access.members.includes(member));
}
