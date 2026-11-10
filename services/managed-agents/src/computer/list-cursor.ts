// List cursors (work 084): base64url of `<kind>:<seq>:<filter>`, kind `t` turns, `a` asks, `s` subagents; seq is
// the item's first event's seq (lists are newest first, a page continues below it); filter is the filter set the
// cursor was made under. calvin's socket lists (calvin src/api/list-cursor.ts) use the same format, so one cursor
// works on both transports; test/computer-calvin-contract.test.ts cross-checks the two.

/** A list cursor: its list, its position and the filters it was made under (another filter set is `invalid_cursor`). */
export const encodeCursor = (kind: string, seq: number, filter: string) =>
  btoa(`${kind}:${seq}:${filter}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeCursor(kind: string, cursor: string, filter: string): number | null {
  try {
    const text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const match = /^([a-z]):(\d+):(.*)$/.exec(text);
    return match && match[1] === kind && match[3] === filter ? Number(match[2]) : null;
  } catch {
    return null;
  }
}
