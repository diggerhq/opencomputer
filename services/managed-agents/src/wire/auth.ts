// X-Wire-Auth (work 084): how the relay on a computer knows a `/connect` or
// `/files` request came through the wire Worker and not straight to the
// tunnel hostname. The format is calvin's src/signed-header.ts, reproduced
// byte for byte (test/fixtures/calvin/wire-auth-vectors.json):
//
//   X-Wire-Member  usr_…
//   X-Wire-Key     the API key's id
//   X-Wire-Client  e.g. opc/0.1.0, "" when unknown
//   X-Wire-Scope   b64u of canonical JSON {scopes?, sessionIds?, readOnly?, until?}
//   X-Wire-Auth    <exp ms>.<b64u HMAC-SHA256(key, "wire|<member>|<keyId>|<client>|<scope>|<exp>")>
//
// The key is the computer's, the same value as its preview key:
// b64u(HMAC-SHA256(PREVIEW_PLATFORM_KEY, tunnelId)), applied as decoded bytes.

import { base64UrlString, fromBase64Url, hmacBase64Url, hmacKey, utf8 } from "./crypto.js";

/** How long a signature is good for; the relay allows clock skew beyond it. */
export const WIRE_SIGNATURE_TTL_MS = 30_000;

/** What a connection may do. Absent fields: no limit. Serialized in this key order. */
export interface WireScope {
  scopes?: string[];
  sessionIds?: string[];
  readOnly?: boolean;
  /** ms epoch at which the relay closes the connection with 4001. */
  until?: number;
}

export interface WireAuthClaims {
  member: string;
  keyId: string;
  client: string;
  scope: WireScope;
  /** The signature's expiry, ms: signing time + WIRE_SIGNATURE_TTL_MS. */
  exp: number;
}

export const WIRE_HEADERS = {
  member: "x-wire-member",
  keyId: "x-wire-key",
  client: "x-wire-client",
  scope: "x-wire-scope",
  auth: "x-wire-auth",
} as const;

/** Printable ASCII, at most 64, without `|` (it delimits the signed message). */
export const WIRE_CLIENT = /^[\x20-\x7b\x7d\x7e]{0,64}$/;
const FIELD = /^[\x21-\x7b\x7d\x7e]{1,128}$/;

/** base64url of the canonical JSON: keys in WireScope's order, absent ones omitted (`{}` → `e30`). */
export function encodeWireScope(scope: WireScope): string {
  const canonical: WireScope = {};
  if (scope.scopes) canonical.scopes = scope.scopes;
  if (scope.sessionIds) canonical.sessionIds = scope.sessionIds;
  if (scope.readOnly !== undefined) canonical.readOnly = scope.readOnly;
  if (scope.until !== undefined) canonical.until = scope.until;
  return base64UrlString(JSON.stringify(canonical));
}

/** A computer's wire (= preview) key from the platform key and its tunnel id; base64url, 32 bytes. */
export async function computerKey(platformKey: string, tunnelId: string): Promise<string> {
  const key = await hmacKey(`platform:${platformKey}`, () => utf8(platformKey));
  return hmacBase64Url(key, tunnelId);
}

/** The five X-Wire-* request headers (lowercase names) for one forwarded request. */
export async function signWireAuth(keyB64u: string, claims: WireAuthClaims): Promise<Record<string, string>> {
  const { member, keyId, client, exp } = claims;
  if (!FIELD.test(member) || !FIELD.test(keyId) || !WIRE_CLIENT.test(client) || !Number.isSafeInteger(exp)) {
    throw new Error("unsignable wire claims");
  }
  const scope = encodeWireScope(claims.scope);
  const key = await hmacKey(`computer:${keyB64u}`, () => fromBase64Url(keyB64u));
  const mac = await hmacBase64Url(key, `wire|${member}|${keyId}|${client}|${scope}|${exp}`);
  return {
    [WIRE_HEADERS.member]: member,
    [WIRE_HEADERS.keyId]: keyId,
    [WIRE_HEADERS.client]: client,
    [WIRE_HEADERS.scope]: scope,
    [WIRE_HEADERS.auth]: `${exp}.${mac}`,
  };
}
