// Who may do what in a session by its access list (protocol-api.ts
// SessionAccess), shared by the relay (wire/edge-auth.ts) and the host
// (host/wire-link.ts), which check terminals twice.
//
// Invariant: driving a session (writing, opening a terminal) needs what
// attaching needs: the owner, a member the list names, or everyone when the
// list is null. Being an organization admin adds nothing (Mohamed, web
// terminal MVP): an admin may change who drives, not drive a session that
// does not name them. The frame's `admins` is ignored.

import type { SessionAccess } from '../protocol.js';

/** Whether `member` may see (and drive) the session, by its access list. */
export const mayAttach = (access: SessionAccess, member: string) => access.owner === member || access.members === null || access.members.includes(member);

/** Whether `member` may open a terminal: whoever may drive the session. */
export const mayOpenTerminal = (access: SessionAccess, member: string) => mayAttach(access, member);
