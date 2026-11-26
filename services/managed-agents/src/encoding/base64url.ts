// The one base64url (spec 36.7): without padding, on the platform's Buffer (nodejs_compat).

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
