// The preview signature (work 074): how the host proxy on a computer knows a
// request came through the previews Worker and not straight to the tunnel
// hostname.
//
// Each computer has its own key, HMAC-SHA256(platformKey, tunnelId). The
// previews Worker and the gateway both hold the platform key and derive it;
// the host receives only its own key, in `welcome`. Every proxied request
// carries
//
//   X-Preview-Auth: <expiry ms>.<base64url HMAC-SHA256(key, "<port>|<expiry ms>")>
//
// and the host refuses it unless the port matches X-Preview-Port, the
// signature verifies and the expiry is in the future (60 s from signing).

export const PREVIEW_SIGNATURE_TTL_MS = 60_000;

const encoder = new TextEncoder();

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A computer's preview key, from the platform key and its tunnel id; base64url. */
export async function previewKey(platformKey: string, tunnelId: string): Promise<string> {
  return base64Url(await hmac(encoder.encode(platformKey), tunnelId));
}

function keyBytes(key: string): Uint8Array {
  const binary = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The X-Preview-Auth value for one request to `port`. */
export async function signPreview(key: string, port: number, now = Date.now()): Promise<string> {
  const expiry = now + PREVIEW_SIGNATURE_TTL_MS;
  return `${expiry}.${base64Url(await hmac(keyBytes(key), `${port}|${expiry}`))}`;
}

/** The host's check, here so both sides are tested against one definition. */
export async function verifyPreview(key: string, port: number, header: string | null, now = Date.now()): Promise<boolean> {
  const match = header?.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return false;
  const expiry = Number(match[1]);
  if (expiry <= now || expiry > now + PREVIEW_SIGNATURE_TTL_MS) return false;
  const expected = base64Url(await hmac(keyBytes(key), `${port}|${expiry}`));
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ match[2]!.charCodeAt(i);
  return diff === 0;
}
