// JSON with sorted keys, and its hash (spec 36.7): equal values, equal text. The request hash of
// idempotency and the inbox compare.

import { base64url } from "./base64url.js";

const encoder = new TextEncoder();

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with object keys sorted at every depth and `undefined` fields left out: equal values, equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (isRecord(value)) {
    const fields = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** SHA-256 of a value's canonical JSON, base64url: the request hash `idem` and the inbox compare. */
export async function hashOf(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(value)));
  return base64url.encode(new Uint8Array(digest));
}
