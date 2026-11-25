// Live's contract (tracks and threads, spec sections 18.8, 35.4, 36.4 and 38): what a publisher,
// the edge and a client know of the fan-out actor. Nothing here imports `cloudflare:workers`, so
// `managed-agents` can import it without pulling the class into its bundle.

import type { DeltaPush, EventPush, FeedPush, LiveRpc, Principal } from "../actor/contracts.js";

export type { DeltaPush, EventPush, FeedPush, LiveRpc, Principal };

// ---------------------------------------------------------------- constants (section 44)

export const LIVE_PROTOCOL = 1;
export const LIVE_SUBPROTOCOL = "oc.live.v1";
export const LEASE_MS = 30_000;
export const LEASE_RENEW_MS = 20_000;
export const MAX_WATCHED_SESSIONS = 32;
export const MAX_ATTACHMENT_BYTES = 2_048;
export const MAX_FRAME_BYTES = 64_000;
export const REVALIDATE_MS = 5 * 60_000;
export const MAX_WAIT_MS = 60_000;
/** Feed kinds a principal without `work:read` may subscribe to (section 18.4). */
export const CORE_KINDS = ["session", "machine"];

export const CLOSE_UNAUTHENTICATED = 4001;
export const CLOSE_FORBIDDEN = 4003;
export const CLOSE_BEHIND = 4008;
export const CLOSE_PROTOCOL = 4400;

// ---------------------------------------------------------------- publishers

// The push shapes and `LiveRpc` are in ../actor/contracts.ts; a publisher names a Live with
// `liveOf` of ../actor/stubs.ts, the only place its key is read (section 18.8).

/** "The head is now N": what a publish too large to send, or a retried one, carries. */
export interface HeadPush {
  head: string;
}

export type Push = FeedPush | EventPush | DeltaPush | HeadPush;

/**
 * The socket upgrade, which the edge passes to the stub `liveOf` names: `fetch` with the request's
 * own `Upgrade` and `Sec-WebSocket-Protocol` headers and the principal in `PRINCIPAL_HEADER`,
 * signed by `signPrincipal`.
 */
export interface LiveUpgrade {
  fetch(request: Request): Promise<Response>;
}

export const feedStream = "feed";
export const eventsStream = (sessionId: string): string => `events:${sessionId}`;
export const deltasStream = (sessionId: string): string => `deltas:${sessionId}`;

// ---------------------------------------------------------------- what Live calls

/** `SessionLog.watch` (section 36.2). `machine` names the Computer that serves the session (its `Access.machine`); absent, the organization's first. */
export interface SessionLogWatch {
  watch(p: Principal, until: number): Promise<{ head: string; machine?: string } | null>;
}

export interface ComputerWatch {
  watch(sessionId: string, until: number): Promise<void>;
  block(sessionId: string, blockId: string): Promise<void>;
}

/**
 * The edge's credential check, a `POST` on the `EDGE` service binding with `Authorization: Bearer
 * <LIVE_KEY>`. `{ check: [credential ids] }` answers `{ revoked: [ids] }`; `{ token }` (an `auth`
 * frame's) answers `{ principal }`, null when the token does not verify.
 */
export const EDGE_CREDENTIALS_URL = "https://api-edge/internal/live/credentials";

// ---------------------------------------------------------------- the socket (section 38)

export type ClientFrame =
  | { t: "hello"; protocol: number; clientId: string }
  | { t: "sub"; stream: string; after?: string; kinds?: string[] }
  | { t: "unsub"; stream: string }
  | { t: "block"; session: string; blockId: string }
  | { t: "auth"; token: string }
  | { t: "ping" };

export type ServerFrame =
  | {
      t: "ready";
      connectionId: string;
      protocol: number;
      org: string;
      subject: string;
      expiresAt: string | null;
      limits: { sessions: number; frameBytes: number };
    }
  | { t: "subd"; stream: string; head: string | null }
  | {
      t: "feed";
      from: string;
      to: string;
      rows: unknown[];
      gone: { kind: string; id: string }[];
      lastMutation?: number;
      errors?: { n: number; code: string; reason: string }[];
    }
  | { t: "events"; session: string; from: string; to: string; events: unknown[] }
  | { t: "delta"; session: string; type: string; turnId: string | null; data: unknown; offset: number; whole?: boolean }
  | { t: "behind"; stream: string; head: string }
  | { t: "reset"; stream: string; cursor: string | null; seq?: number }
  | { t: "detached"; stream: string; reason: "forbidden" | "gone" | "unavailable" }
  | { t: "error"; code: string; message: string }
  | { t: "pong" };

/** A socket's attachment (section 35.4): who it is and what it watches, never a position. */
export interface LiveAttachment {
  c: string;
  p: { org: string; subject: string; kind: Principal["kind"]; read: boolean; aud: string[]; cred: string; exp: number };
  cl: string;
  k?: string[];
  f: boolean;
  w: Record<string, 1 | 2 | 3>;
  /** When the edge last confirmed the credential, in seconds: kept here because Live's memory does not outlive hibernation. */
  v: number;
}

// ---------------------------------------------------------------- the signed principal

export const PRINCIPAL_HEADER = "x-oc-live-principal";
/** An upgrade is passed on at once; a header older than this is refused. */
export const PRINCIPAL_MAX_AGE_MS = 60_000;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hmacKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The edge's side: the value of `PRINCIPAL_HEADER` on the upgrade it passes to `liveOf(org)`. */
export async function signPrincipal(key: string, principal: Principal, now = Date.now()): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ p: principal, t: now })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(key), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyPrincipal(key: string, header: string | null, now = Date.now()): Promise<Principal | null> {
  if (!key || !header) return null;
  const [payload, signature, ...rest] = header.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(key), fromBase64url(signature), encoder.encode(payload)))) return null;
    const body = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { p?: Principal; t?: number };
    if (!body.p || typeof body.t !== "number" || Math.abs(now - body.t) > PRINCIPAL_MAX_AGE_MS) return null;
    if (typeof body.p.org !== "string" || typeof body.p.subject !== "string" || !Array.isArray(body.p.audiences)) return null;
    return body.p;
  } catch {
    return null;
  }
}
