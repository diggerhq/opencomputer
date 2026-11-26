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
 * The socket upgrade, which the edge passes to the stub `liveOf` names as `fetch(liveRequest(...))`:
 * a request built afresh, carrying the principal the edge verified in `PRINCIPAL_HEADER` and only
 * the request's WebSocket headers. The hop is private (only a Worker bound to the class reaches the
 * stub), so the header needs no signature; it is a header and not an RPC argument because an RPC
 * reply cannot carry a WebSocket.
 */
export interface LiveUpgrade {
  fetch(request: Request): Promise<Response>;
}

export const PRINCIPAL_HEADER = "x-oc-live-principal";
const UPGRADE_HEADERS = ["upgrade", "connection", "sec-websocket-protocol", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"];

/** The edge's side: the upgrade it passes to `liveOf(org)`, with nothing of the client's but the WebSocket headers. */
export function liveRequest(request: Request, p: Principal): Request {
  const headers = new Headers();
  for (const name of UPGRADE_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set(PRINCIPAL_HEADER, JSON.stringify(p));
  return new Request(request.url, { method: "GET", headers });
}

/** Live's side: the principal of a `liveRequest`, null when it is missing or not one. */
export function upgradePrincipal(request: Request): Principal | null {
  try {
    const p = JSON.parse(request.headers.get(PRINCIPAL_HEADER) ?? "null") as Principal | null;
    if (!p || typeof p.org !== "string" || typeof p.subject !== "string" || !Array.isArray(p.audiences) || !Array.isArray(p.scopes)) return null;
    return p;
  } catch {
    return null;
  }
}

export const feedStream = "feed";
export const eventsStream = (sessionId: string): string => `events:${sessionId}`;
export const deltasStream = (sessionId: string): string => `deltas:${sessionId}`;

// ---------------------------------------------------------------- what Live calls

/** `SessionLog.watch` (section 36.2). `machine` names the Computer that serves the session (its `Access.machine`). */
export interface SessionLogWatch {
  watch(p: Principal, until: number): Promise<{ head: string; machine: string } | null>;
}

export interface ComputerWatch {
  watch(sessionId: string, until: number): Promise<void>;
  block(sessionId: string, blockId: string): Promise<void>;
}

/**
 * The edge's credential check: api-edge's `LiveCredentials` entrypoint, over the `EDGE` service
 * binding. `revoked` answers the ids that no longer verify; `principal` an `auth` frame's token's
 * principal, null when the token does not verify.
 */
export interface LiveCredentials {
  revoked(ids: string[]): Promise<string[]>;
  principal(token: string): Promise<Principal | null>;
}
/** The most ids one `revoked` call takes. */
export const LIVE_CHECK_MAX = 500;

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
