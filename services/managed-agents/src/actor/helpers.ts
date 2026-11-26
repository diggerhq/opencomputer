// Helpers each written once (spec 36.7).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** base64url without padding, on the platform's Buffer (nodejs_compat). */
export const base64url = {
  encode: (input: string | Uint8Array): string => Buffer.from(input).toString("base64url"),
  /** The bytes, or null when `text` is not base64url. */
  decode(text: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
    return new Uint8Array(Buffer.from(text, "base64url"));
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

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** `<prefix>_` and `length` lowercase Crockford base32 characters of `bytes` (5 bits of each), random by default (spec 34.1). */
export function crockfordId(prefix: string, length = 16, bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(length))): string {
  let id = `${prefix}_`;
  for (let i = 0; i < length; i++) id += CROCKFORD[bytes[i]! & 31];
  return id;
}

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
