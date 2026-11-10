// List cursors (asks.list, subagents.list), in blue's format so one cursor
// works on both transports (review r2 P2-6): base64url of
// `<kind>:<seq>:<filter>`, kind `t` turns, `a` asks, `s` subagents; seq is the
// item's first event's seq (lists are newest first, a page continues below
// it); filter is the filter set the cursor was made under, and a cursor used
// under another set is `invalid_cursor`. The same format as blue's
// src/computer/session-log.ts encodeCursor/decodeCursor.

export type CursorKind = 't' | 'a' | 's';

export const encodeCursor = (kind: CursorKind, seq: number, filter: string): string => Buffer.from(`${kind}:${seq}:${filter}`).toString('base64url');

/** The seq a cursor continues below, or null when it is not this list's under this filter. */
export function decodeCursor(kind: CursorKind, cursor: string, filter: string): number | null {
  if (!/^[A-Za-z0-9_-]*$/.test(cursor)) return null;
  const match = /^([a-z]):(\d+):(.*)$/.exec(Buffer.from(cursor, 'base64url').toString('latin1'));
  return match && match[1] === kind && match[3] === filter ? Number(match[2]) : null;
}
