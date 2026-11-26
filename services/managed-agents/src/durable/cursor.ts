// The only maker and reader of cursors (spec 34.2, 36.7). A session's events `e1.<epoch>.<seq>`,
// the feed `f1.<version>`, the occurrence stream `o1.<n>`, a page of a list `p1.<…>`. Opaque to a
// client, which compares two only for equality; one this cannot read is answered `reset`.

import { base64url } from "../actor/helpers.js";

export type CursorKind = "e" | "f" | "o" | "p";
export type CursorParts = (number | string)[];

const COUNTS: Record<Exclude<CursorKind, "p">, number> = { e: 2, f: 1, o: 1 };

export const cursor = {
  encode(kind: CursorKind, parts: CursorParts): string {
    if (kind === "p") return `p1.${base64url.encode(JSON.stringify(parts))}`;
    if (parts.length !== COUNTS[kind] || !parts.every((part) => Number.isSafeInteger(part) && (part as number) >= 0)) {
      throw new Error(`cursor ${kind}: bad parts`);
    }
    return `${kind}1.${parts.join(".")}`;
  },
  decode(text: string): { kind: CursorKind; parts: CursorParts } | null {
    if (typeof text !== "string" || text.length > 1_024) return null;
    const match = /^([efop])1\.(.+)$/.exec(text);
    if (!match) return null;
    const kind = match[1] as CursorKind;
    if (kind === "p") {
      const json = base64url.text(match[2]!);
      if (json === null) return null;
      try {
        const parts: unknown = JSON.parse(json);
        if (!Array.isArray(parts) || !parts.every((part) => typeof part === "string" || Number.isFinite(part))) return null;
        return { kind, parts: parts as CursorParts };
      } catch {
        return null;
      }
    }
    const fields = match[2]!.split(".");
    if (fields.length !== COUNTS[kind] || !fields.every((field) => /^(0|[1-9]\d{0,15})$/.test(field))) return null;
    return { kind, parts: fields.map(Number) };
  },
  /** The parts of a cursor of this kind, or null: what a reader of one stream wants. */
  read(kind: CursorKind, text: string): CursorParts | null {
    const decoded = cursor.decode(text);
    return decoded && decoded.kind === kind ? decoded.parts : null;
  },
};
