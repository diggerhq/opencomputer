// Small WebCrypto helpers for the wire Worker (work 084). Copied in spirit
// from src/previews/auth.ts rather than imported, so the wire Worker's bundle
// shares nothing with the previews Worker. Imported HMAC keys are cached per
// isolate: importKey is the costliest step of a signature.

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value) as Uint8Array<ArrayBuffer>;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on input that is not base64url. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function base64UrlString(value: string): string {
  return base64Url(utf8(value));
}

const KEY_CACHE_LIMIT = 1_000;
const hmacKeys = new Map<string, Promise<CryptoKey>>();

/** An HMAC-SHA256 signing key, imported once per isolate per `cacheId`. */
export function hmacKey(cacheId: string, raw: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>): Promise<CryptoKey> {
  let key = hmacKeys.get(cacheId);
  if (!key) {
    key = Promise.resolve(raw()).then((bytes) => crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
    hmacKeys.set(cacheId, key);
    if (hmacKeys.size > KEY_CACHE_LIMIT) hmacKeys.delete(hmacKeys.keys().next().value as string);
    key.catch(() => hmacKeys.delete(cacheId));
  }
  return key;
}

export async function hmacBase64Url(key: CryptoKey, message: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(message))));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Constant time in the contents for strings of equal length. */
export function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
