// Signed headers: how a process on the computer knows a request came through
// one of our Workers and not straight to the tunnel hostname. Moved from
// host/preview-auth.ts (work 074) in work 084, which adds the wire's. One key,
// the computer's (welcome.preview.key, also welcome.wire.key: base64url, 32
// bytes), one domain per use, so a signature for one is never good for another:
//
//   preview  X-Preview-Auth: <13-digit expiry ms>.<b64u HMAC(key, "<port>|<expiry>")>
//            (the domain is implicit: kept byte-compatible with what blue signs today; a
//            message starting with digits can never equal one starting with `wire|`)
//   wire     X-Wire-Member, X-Wire-Key, X-Wire-Client, X-Wire-Scope (b64u canonical JSON), and
//            X-Wire-Auth: <13-digit exp ms>.<b64u HMAC(key, "wire|<member>|<keyId>|<client>|<scope>|<exp>")>
//            signed by the wire Worker on every upgrade and /files request it forwards, good for
//            30 s; verified by the relay (src/wire/edge-auth.ts). Format: blue's (requests-calvin.md)
//   ticket   tk_<b64u JSON claims>.<b64u HMAC(HKDF(utf8(WIRE_TICKET_KEY), "opc-wire-v1\0"), "tk_<b64u claims>")>
//            minted by blue for browsers, verified by the wire Worker; never reaches the computer.
//            Here so calvin, blue and opc share one definition and one vector
//            (/tmp/build084/wire-auth-vectors.json → schema/wire-auth-vectors.json).
//
// Invariants: constant-time comparison; the claims are parsed only after the
// signature checks out; fields that enter a `|`-joined message may not contain
// `|`; times are ms since the epoch.

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------- preview (work 074)

export const PREVIEW_SIGNATURE_TTL_MS = 60_000;
/** How far behind the Worker's clock a VM's may be before every signature looks too fresh. */
export const CLOCK_SKEW_MS = 30_000;

const hmac = (key: Buffer, message: string) => createHmac('sha256', key).update(message).digest('base64url');
const keyBytes = (key: string) => Buffer.from(key, 'base64url');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The X-Preview-Auth value for one request to `port`; the Worker's side, here for tests. */
export function signPreview(key: string, port: number, now = Date.now()): string {
  const expiry = now + PREVIEW_SIGNATURE_TTL_MS;
  return `${expiry}.${hmac(keyBytes(key), `${port}|${expiry}`)}`;
}

/** Whether `header` signs `port` with `key` and has not expired; constant-time in the signature. */
export function verifyPreview(key: string, port: number, header: string | undefined, now = Date.now()): boolean {
  const match = header?.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return false;
  const expiry = Number(match[1]);
  // The upper bound catches a forged far-future expiry; the allowance is for a VM clock behind the Worker's.
  if (expiry <= now || expiry > now + PREVIEW_SIGNATURE_TTL_MS + CLOCK_SKEW_MS) return false;
  return equal(hmac(keyBytes(key), `${port}|${expiry}`), match[2]);
}

// ---------------------------------------------------------------- X-Wire-Auth (edge → relay)

/** How long the Worker's signature is good for: a replay after this is refused. */
export const WIRE_SIGNATURE_TTL_MS = 30_000;

/** What a connection may do. Absent fields: no limit. Serialized in this key order (canonical). */
export interface WireScope {
  /** The API key's scopes (`sessions:read`, `sessions:write`, `asks:answer`, `secrets:write`, `terminals`); absent: all. */
  scopes?: string[];
  /** From a ticket: only these sessions. */
  sessionIds?: string[];
  /** From a ticket: refuse writes. */
  readOnly?: boolean;
  /** When the relay closes the connection with 4001 (ticket: open + 1 h; key: its expiresAt), ms. */
  until?: number;
}

export interface WireClaims {
  /** `usr_…`: whose connection this is. */
  member: string;
  /** The API key's id (or the minting key's, for a ticket): what `revoked {keyId}` names. */
  keyId: string;
  /** e.g. `opc/0.1.0`; "" when unknown. */
  client: string;
  scope: WireScope;
  /** The signature's expiry, ms. */
  exp: number;
}

/** The request headers the wire Worker adds (lowercase, as node's `req.headers` has them). */
export const WIRE_HEADERS = { member: 'x-wire-member', keyId: 'x-wire-key', client: 'x-wire-client', scope: 'x-wire-scope', auth: 'x-wire-auth' } as const;

/** base64url of the canonical JSON: keys in WireScope's order, absent ones omitted (`{}` → `e30`). */
export function encodeScope(scope: WireScope): string {
  const canonical: WireScope = {};
  if (scope.scopes) canonical.scopes = scope.scopes;
  if (scope.sessionIds) canonical.sessionIds = scope.sessionIds;
  if (scope.readOnly !== undefined) canonical.readOnly = scope.readOnly;
  if (scope.until !== undefined) canonical.until = scope.until;
  return Buffer.from(JSON.stringify(canonical)).toString('base64url');
}

const CLIENT = /^[\x20-\x7e]{0,64}$/;
const FIELD = /^[\x21-\x7b\x7d\x7e]{1,128}$/; // printable ASCII without space and `|`
const wireMessage = (member: string, keyId: string, client: string, scope: string, exp: number) => `wire|${member}|${keyId}|${client}|${scope}|${exp}`;

/** The five headers for one request; the wire Worker's side, here for tests and the vector. */
export function signWire(key: string, claims: Omit<WireClaims, 'exp'>, now = Date.now()): Record<string, string> {
  if (!FIELD.test(claims.member) || !FIELD.test(claims.keyId) || !CLIENT.test(claims.client) || claims.client.includes('|')) {
    throw new Error('unsignable wire claims');
  }
  const exp = now + WIRE_SIGNATURE_TTL_MS;
  const scope = encodeScope(claims.scope);
  return {
    [WIRE_HEADERS.member]: claims.member,
    [WIRE_HEADERS.keyId]: claims.keyId,
    [WIRE_HEADERS.client]: claims.client,
    [WIRE_HEADERS.scope]: scope,
    [WIRE_HEADERS.auth]: `${exp}.${hmac(keyBytes(key), wireMessage(claims.member, claims.keyId, claims.client, scope, exp))}`,
  };
}

/**
 * The claims of a request whose X-Wire-* headers are valid and unexpired, or undefined. Accepts an expiry up to
 * 30 s + CLOCK_SKEW_MS ahead, for a VM clock behind the Worker's (as previews do).
 */
export function verifyWire(key: string, headers: Record<string, string | string[] | undefined>, now = Date.now()): WireClaims | undefined {
  const one = (name: string) => (typeof headers[name] === 'string' ? (headers[name] as string) : undefined);
  const [member, keyId, client = '', scope, auth] = [one(WIRE_HEADERS.member), one(WIRE_HEADERS.keyId), one(WIRE_HEADERS.client), one(WIRE_HEADERS.scope), one(WIRE_HEADERS.auth)];
  const match = auth?.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/);
  if (!match || !member || !keyId || scope === undefined || !FIELD.test(member) || !FIELD.test(keyId) || !CLIENT.test(client)) return undefined;
  if (!/^[A-Za-z0-9_-]{0,4096}$/.test(scope)) return undefined;
  const exp = Number(match[1]);
  if (!equal(hmac(keyBytes(key), wireMessage(member, keyId, client, scope, exp)), match[2])) return undefined;
  if (exp <= now || exp > now + WIRE_SIGNATURE_TTL_MS + CLOCK_SKEW_MS) return undefined;
  const parsed = parseClaims(scope);
  if (!parsed || !isScope(parsed)) return undefined;
  return { member, keyId, client, scope: parsed, exp };
}

// ---------------------------------------------------------------- ticket v1 (blue mints, the wire Worker verifies)

/** A ticket must be presented within this of its minting. */
export const TICKET_TTL_MS = 10 * 60_000;
export const TICKET_HKDF_INFO = 'opc-wire-v1\0';
export const TICKET_MAX_LENGTH = 1024;

export interface TicketClaims {
  v: 1;
  org: string;
  member: string;
  computer: string;
  tunnelId: string;
  keyId: string;
  client: string;
  scope: { sessionIds?: string[]; readOnly?: boolean };
  /** Present-by time, ms since the epoch. */
  exp: number;
}

/** The ticket MAC key: HKDF-SHA256(ikm = WIRE_TICKET_KEY's UTF-8 bytes, salt = empty, info = "opc-wire-v1\0"), 32 bytes. */
export function ticketKey(wireTicketKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(wireTicketKey, 'utf8'), Buffer.alloc(0), TICKET_HKDF_INFO, 32));
}

export function mintTicket(wireTicketKey: string, claims: Omit<TicketClaims, 'v' | 'exp'>, now = Date.now()): string {
  const { org, member, computer, tunnelId, keyId, client } = claims;
  const scope: TicketClaims['scope'] = {};
  if (claims.scope.sessionIds) scope.sessionIds = claims.scope.sessionIds;
  if (claims.scope.readOnly !== undefined) scope.readOnly = claims.scope.readOnly;
  const body = Buffer.from(JSON.stringify({ v: 1, org, member, computer, tunnelId, keyId, client, scope, exp: now + TICKET_TTL_MS })).toString('base64url');
  return `tk_${body}.${hmac(ticketKey(wireTicketKey), `tk_${body}`)}`;
}

export function verifyTicket(wireTicketKey: string, ticket: string | undefined, now = Date.now()): TicketClaims | undefined {
  if (!ticket || ticket.length > TICKET_MAX_LENGTH) return undefined;
  const match = ticket.match(/^tk_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if (!match) return undefined;
  if (!equal(hmac(ticketKey(wireTicketKey), `tk_${match[1]}`), match[2])) return undefined;
  const claims = parseClaims(match[1]) as Partial<TicketClaims> | undefined;
  if (claims?.v !== 1 || typeof claims.exp !== 'number' || claims.exp <= now) return undefined;
  for (const f of ['org', 'member', 'computer', 'tunnelId', 'keyId', 'client'] as const) if (typeof claims[f] !== 'string') return undefined;
  if (!isScope(claims.scope) || (claims.scope.sessionIds?.length ?? 0) > 20) return undefined;
  return claims as TicketClaims;
}

// ---------------------------------------------------------------- parsing

function parseClaims(b64: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((i) => typeof i === 'string'));

function isScope(s: unknown): s is WireScope {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const { scopes, sessionIds, readOnly, until } = s as WireScope;
  return strings(scopes) && strings(sessionIds) && (readOnly === undefined || typeof readOnly === 'boolean')
    && (until === undefined || typeof until === 'number');
}
