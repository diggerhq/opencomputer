// Who may use a session and open a terminal in it, from the access list the backend pushes (protocol.ts
// `SessionAccess`). The relay checks both (wire/edge-auth.ts re-exports them); the host checks terminals again.
//
// Owner first: being an admin lets no one into a session and opens no terminal. A terminal is a shell on the
// computer, so it takes being named: the owner, or someone the session is shared with by name. Everyone in an
// organization-wide session may attach (read, drive), but not open a terminal.

import type { SessionAccess } from '../protocol.js';

/** Whether `member` may attach to (read, drive) the session: its owner, everyone (`members` null), or a listed member. */
export const mayAttach = (access: SessionAccess, member: string) => access.owner === member || access.members === null || access.members.includes(member);

/** Whether `member` may open a terminal: the owner, or a person the session is shared with by name. Never by role. */
export const mayOpenTerminal = (access: SessionAccess, member: string) =>
  access.owner === member || !!access.members?.includes(member);
