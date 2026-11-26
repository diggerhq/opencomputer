// Who may use a session and open a terminal in it, from the access list the backend pushes (protocol.ts
// `SessionAccess`). The relay checks both (wire/edge-auth.ts re-exports them); the host checks terminals again.
//
// Owner first: being an admin lets no one into a session, and opens no terminal in it. A terminal is for the
// session's owner and the people it is shared with by name; a session open to the whole organization lets its
// members drive the agent, never open a shell.

import type { SessionAccess } from '../protocol.js';

/** Whether `member` may attach to (read, drive) the session: its owner, everyone (`members` null), or a listed member. */
export const mayAttach = (access: SessionAccess, member: string) => access.owner === member || access.members === null || access.members.includes(member);

/**
 * Whether `member` may open a terminal: the owner, or a person the session is shared with by name. Never every
 * member of an organization-wide session, and never an admin by role (`SessionAccess.admins` is ignored).
 */
export const mayOpenTerminal = (access: SessionAccess, member: string) =>
  access.owner === member || (access.members !== null && access.members.includes(member));
