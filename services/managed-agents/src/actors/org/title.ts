// A session's title from its first input.

/** The first 80 characters of an input's first line, as today's `POST /sessions` titles a session. */
export function titleFrom(input: string): string {
  const line = input.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Untitled";
}
