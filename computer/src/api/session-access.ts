// Who may use a session and open a terminal in it, from the access list the backend pushes (protocol.ts
// `SessionAccess`). The relay checks both (wire/edge-auth.ts re-exports them); the host checks terminals again.
//
// CTO-37 Q4: being an admin lets no one into a session. An admin opens a terminal only in a session they may
// attach to anyway, which for someone not named is a session open to the whole organization.

import type { SessionAccess } from '../protocol.js';

/** Whether `member` may attach to (read, drive) the session: its owner, everyone (`members` null), or a listed member. */
export const mayAttach = (access: SessionAccess, member: string) => access.owner === member || access.members === null || access.members.includes(member);

/**
 * Whether `member` may open a terminal: only someone who may attach, and then the owner, a person the session is
 * shared with by name, or an admin of the organization (the host's list or the access frame's).
 */
export const mayOpenTerminal = (access: SessionAccess, member: string, admins: ReadonlySet<string>) =>
  mayAttach(access, member) &&
  (access.owner === member || (access.members !== null && access.members.includes(member)) || admins.has(member) || !!access.admins?.includes(member));
