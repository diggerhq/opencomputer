// What the relay lets a request do (work 084): the wire Worker's signature on
// every upgrade and /files request (X-Wire-Auth, src/signed-header.ts), and
// the scope it carries: the key's API scopes, a ticket's sessions and
// read-only flag, and when the connection must close.
//
// Invariants: a request whose X-Wire-Auth is missing, malformed or outside the
// signature window is refused 401 first, key or no key (so an unsigned local
// caller never gets a handshake); no key from the host yet → nothing else
// passes (503); a request without a valid, unexpired signature is refused 403
// before anything else happens,
// loopback included (the relay listens on 127.0.0.1, so any local process can
// dial it; only the Worker holds the key); scopes are checked per method, and
// an absent `scopes` list means every scope.

import type { IncomingHttpHeaders } from 'node:http';
import { CLOCK_SKEW_MS, WIRE_HEADERS, WIRE_SIGNATURE_TTL_MS, type WireClaims, type WireScope, verifyWire } from '../signed-header.js';
import type { Method } from '../api/schema.js';
import type { SessionAccess } from '../protocol.js';

/** Whether the request carries an X-Wire-Auth of the Worker's shape (`<13-digit exp>.<43 base64url>`) with exp in the window; no key needed. */
export function signedShape(headers: IncomingHttpHeaders, now = Date.now()): boolean {
  const auth = headers[WIRE_HEADERS.auth];
  const match = typeof auth === 'string' ? auth.match(/^(\d{13})\.[A-Za-z0-9_-]{43}$/) : null;
  if (!match) return false;
  const exp = Number(match[1]);
  return exp > now && exp <= now + WIRE_SIGNATURE_TTL_MS + CLOCK_SKEW_MS;
}

/** The verified claims of a request, or why it is refused (an HTTP status before any upgrade). */
export function authenticate(key: string | null, headers: IncomingHttpHeaders, now = Date.now()): { claims: WireClaims } | { status: 401 | 403 | 503; reason: string } {
  if (!signedShape(headers, now)) return { status: 401, reason: 'missing or malformed edge signature' };
  if (!key) return { status: 503, reason: 'the computer has no wire key yet' };
  const claims = verifyWire(key, headers as Record<string, string | string[] | undefined>, now);
  if (!claims) return { status: 403, reason: 'bad or expired edge signature' };
  if (claims.scope.until !== undefined && claims.scope.until <= now) return { status: 403, reason: 'credential expired' };
  return { claims };
}

/** The API scope a method needs (authentication.mdx "Scopes"); undefined: none. */
export function scopeFor(method: Method | 'files.get' | 'files.put'): string | undefined {
  switch (method) {
    case 'ping':
      return undefined;
    case 'terminals.open':
    case 'terminals.resize':
    case 'terminals.eof':
    case 'terminals.close':
      return 'terminals';
    case 'asks.answer':
    case 'asks.dismiss':
      return 'asks:answer';
    case 'sessions.update':
    case 'sessions.interrupt':
    case 'sessions.compact':
    case 'sessions.suspend':
    case 'sessions.resume':
    case 'turns.send':
    case 'turns.cancel':
    case 'files.put':
      return 'sessions:write';
    default:
      return 'sessions:read';
  }
}

export const hasScope = (scope: WireScope, needed: string | undefined) => needed === undefined || !scope.scopes || scope.scopes.includes(needed);

/** Whether the credential may name this session at all (a ticket's `sessionIds`). */
export const inTicket = (scope: WireScope, sessionId: string) => !scope.sessionIds || scope.sessionIds.includes(sessionId);

/** Whether `member` may see the session, by its access list. */
export const mayAttach = (access: SessionAccess, member: string) => access.owner === member || access.members === null || access.members.includes(member);

/** Whether `member` may open a terminal: the owner, or an admin of the organization (the host's list or the access frame's). */
export const mayOpenTerminal = (access: SessionAccess, member: string, admins: ReadonlySet<string>) =>
  access.owner === member || admins.has(member) || !!access.admins?.includes(member);

/** The actor the relay stamps on a member's calls (API `Actor`): `via` from the client label. */
export function actorFor(claims: WireClaims): { id: string; name: null; via: string; client: string | null } {
  const client = claims.client || null;
  const via = client?.startsWith('opc/') ? 'opc' : client?.startsWith('dashboard') ? 'dashboard' : 'api';
  return { id: claims.member, name: null, via, client };
}
