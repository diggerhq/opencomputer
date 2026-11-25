// Ticket v1 (work 084): how a browser, which cannot set headers on an
// upgrade, opens the wire. blue mints (`POST /tickets`, src/computer/tickets.ts);
// only the wire Worker verifies. The format is calvin's src/signed-header.ts,
// reproduced byte for byte (test/fixtures/calvin/wire-auth-vectors.json):
//
//   tk_<b64u(payload JSON)>.<b64u HMAC-SHA256(K, "tk_" + b64u(payload JSON))>
//   K = HKDF-SHA256(ikm = utf8(WIRE_TICKET_KEY), salt = empty, info = "opc-wire-v1\0"), 32 bytes
//   payload {"v":1,"org","member","computer","tunnelId","keyId","client","scope":{"sessionIds"?,"readOnly"?,"terminal"?},"exp"}
//
// 10 minutes to present, at most 1024 characters, at most 20 sessionIds. The
// key's scopes are not carried: the wire Worker reads the key's record by
// `keyId` on every use (that is also how a revoked key stops its tickets).
//
// A login ticket (work 113) is minted for a dashboard login, which has no
// key: `"login":true` stands where `"keyId"` does, and exactly one of the two
// is present. It has no record to read, so the Worker grants it a fixed,
// read-only scope (worker.ts). A login's terminal ticket (web terminal MVP)
// adds `"terminal":true` and names exactly one session the member may drive
// (blue checks at minting); the Worker then grants that session's terminals.

import { base64UrlString, equalStrings, fromBase64Url, hmacBase64Url, hmacKey, utf8 } from "./crypto.js";

export const TICKET_TTL_MS = 10 * 60_000;
export const TICKET_MAX_LENGTH = 1024;
export const TICKET_MAX_SESSIONS = 20;
export const TICKET_HKDF_INFO = "opc-wire-v1\0";
/** Between the minting Worker's clock and the verifying one's. */
const CLOCK_SKEW_MS = 60_000;
export const SESSION_ID = /^cs_[0-9a-hjkmnp-tv-z]{16}$/;

export interface TicketScope {
  sessionIds?: string[];
  readOnly?: boolean;
  /** A login's terminal ticket: the one session in `sessionIds`, writable for its terminals. */
  terminal?: true;
}

/** Whose ticket it is: an API key's, or a dashboard login's. Exactly one. */
export type TicketPrincipal = { keyId: string; login?: undefined } | { login: true; keyId?: undefined };

interface TicketBody {
  org: string;
  member: string;
  computer: string;
  tunnelId: string;
  client: string;
  scope: TicketScope;
}

export type TicketClaims = TicketBody & TicketPrincipal & {
  v: 1;
  /** Present-by time, ms since the epoch. */
  exp: number;
};

export type TicketInput = TicketBody & TicketPrincipal;

/** K, the ticket MAC key's raw bytes (exported for the vector test). */
export async function ticketMacKeyBytes(wireTicketKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const ikm = await crypto.subtle.importKey("raw", utf8(wireTicketKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(TICKET_HKDF_INFO) }, ikm, 256);
  return new Uint8Array(bits);
}

function macKey(wireTicketKey: string): Promise<CryptoKey> {
  return hmacKey(`ticket:${wireTicketKey}`, () => ticketMacKeyBytes(wireTicketKey));
}

export class TicketTooLongError extends Error {
  constructor(readonly length: number) {
    super(`ticket would be ${length} characters, over ${TICKET_MAX_LENGTH}`);
  }
}

/** A signed ticket good for TICKET_TTL_MS from `now`. Throws TicketTooLongError past TICKET_MAX_LENGTH. */
export async function mintTicket(wireTicketKey: string, input: TicketInput, now = Date.now()): Promise<string> {
  const { org, member, computer, tunnelId, client } = input;
  const principal = input.login ? ({ login: true } as const) : { keyId: input.keyId };
  const scope: TicketScope = {};
  if (input.scope.sessionIds) scope.sessionIds = input.scope.sessionIds;
  if (input.scope.readOnly !== undefined) scope.readOnly = input.scope.readOnly;
  if (input.scope.terminal) scope.terminal = true;
  const claims: TicketClaims = { v: 1, org, member, computer, tunnelId, ...principal, client, scope, exp: now + TICKET_TTL_MS };
  const body = `tk_${base64UrlString(JSON.stringify(claims))}`;
  const token = `${body}.${await hmacBase64Url(await macKey(wireTicketKey), body)}`;
  if (token.length > TICKET_MAX_LENGTH) throw new TicketTooLongError(token.length);
  return token;
}

/** The claims of a valid, unexpired ticket, or undefined. Claims are parsed only after the MAC checks out. */
export async function verifyTicket(wireTicketKey: string, token: string | null | undefined, now = Date.now()): Promise<TicketClaims | undefined> {
  if (!token || token.length > TICKET_MAX_LENGTH) return undefined;
  const match = /^(tk_[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return undefined;
  const expected = await hmacBase64Url(await macKey(wireTicketKey), match[1]!);
  if (!equalStrings(expected, match[2]!)) return undefined;
  let claims: Partial<TicketBody> & { v?: unknown; exp?: unknown; keyId?: unknown; login?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(match[1]!.slice(3)))) as typeof claims;
  } catch {
    return undefined;
  }
  if (!claims || typeof claims !== "object" || claims.v !== 1) return undefined;
  if (typeof claims.exp !== "number" || claims.exp <= now || claims.exp > now + TICKET_TTL_MS + CLOCK_SKEW_MS) return undefined;
  for (const field of ["org", "member", "computer", "tunnelId", "client"] as const) {
    if (typeof claims[field] !== "string") return undefined;
  }
  // A key's ticket or a login's, never both and never neither.
  if (claims.login === undefined ? typeof claims.keyId !== "string" : claims.login !== true || claims.keyId !== undefined) return undefined;
  const scope = claims.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
  if (scope.readOnly !== undefined && typeof scope.readOnly !== "boolean") return undefined;
  // A terminal ticket is a login's, for exactly one session.
  if (scope.terminal !== undefined && (scope.terminal !== true || claims.login !== true || scope.sessionIds?.length !== 1)) return undefined;
  if (scope.sessionIds !== undefined) {
    if (!Array.isArray(scope.sessionIds) || scope.sessionIds.length > TICKET_MAX_SESSIONS) return undefined;
    if (!scope.sessionIds.every((id) => typeof id === "string" && SESSION_ID.test(id))) return undefined;
  }
  return claims as TicketClaims;
}
