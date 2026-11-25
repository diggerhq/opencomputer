// Helpers each written once (spec 36.7).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Equal strings, in time independent of where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export const base64url = {
  encode(input: string | Uint8Array): string {
    const bytes = typeof input === "string" ? encoder.encode(input) : input;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  /** The bytes, or null when `text` is not base64url. */
  decode(text: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
    try {
      const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      return null;
    }
  },
  /** The UTF-8 text, or null. */
  text(text: string): string | null {
    const bytes = base64url.decode(text);
    if (!bytes) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return null;
    }
  },
};

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

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export const utf8 = { encode: (text: string) => encoder.encode(text), decode: (bytes: Uint8Array) => decoder.decode(bytes) };
