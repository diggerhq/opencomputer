// Signed HTTPS event delivery: the types of an HTTPS event subscription's
// deliveries (docs/agents/event-delivery.mdx) and the receiver's check of a
// delivery's signature. Web Crypto only, so a receiver on any runtime the
// management client supports can verify with the same code.

import type { MemoryEnvironment } from "./memory.js";
import type { OutcomeEventType } from "./event-subscriptions.js";

/** Where an HTTPS subscription delivers: an absolute `https://` URL you operate. */
export interface HttpsDestination {
  type: "https";
  url: string;
}

/** `active` delivers; `paused` records deliveries as pending without attempting them. */
export type EventSubscriptionStatus = "active" | "paused";

/** The state of one event's delivery to one HTTPS destination. */
export type EventDeliveryStatus = "pending" | "delivered" | "failed";

/** The allowlisted outcome fields a delivery carries; never prompts, reasoning or tool output. */
export interface EventDeliveryData {
  status: "completed" | "failed" | "cancelled";
  /** Why the turn failed or was cancelled, when the source recorded a reason. */
  reason?: string;
  /** The failure message, bounded, when the turn failed. */
  error?: string;
  /** The final assistant message of a completed turn; `truncated` when it was cut to fit. */
  result?: { text: string; truncated: boolean };
}

export const EVENT_DELIVERY_SCHEMA = "opencomputer.event-delivery/v1";

/** The JSON body of every delivery attempt. `eventId` and `deliveryId` are the same on every attempt and replay. */
export interface EventDeliveryEnvelope {
  schema: typeof EVENT_DELIVERY_SCHEMA;
  deliveryId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
  projectId: string;
  environment: MemoryEnvironment;
  agentId: string;
  deploymentId: string;
  sessionId: string;
  turnId: string;
  type: OutcomeEventType;
  data: EventDeliveryData;
  /** The delivery this one replays; the event is the same. */
  replayOf?: string;
}

/** One event's delivery to one HTTPS destination, across its attempts. */
export interface EventDelivery {
  id: string;
  subscriptionId: string;
  projectId: string;
  environment: MemoryEnvironment;
  agentId: string;
  sessionId: string;
  turnId: string;
  eventId: string;
  eventType: OutcomeEventType;
  sequence: number;
  occurredAt: string;
  status: EventDeliveryStatus;
  /** HTTP attempts made so far; each attempt's id is `<id>:<attempt>`. */
  attempt: number;
  /** When the next attempt is due; absent once delivered, failed or while an attempt is in flight. */
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  /** The status your receiver last answered with; absent when the request did not complete. */
  responseStatus?: number;
  /**
   * `http_<status>`, `transport`, `timeout`, `redirect`, `subscription_deleted`
   * or `retry_exhausted`; never your receiver's response body.
   */
  error?: string;
  deliveredAt?: string;
  replayOf?: string;
  createdAt: string;
  updatedAt: string;
}

/** A page of `GET .../deliveries`, oldest first. */
export interface EventDeliveryPage {
  deliveries: EventDelivery[];
  /** Pass as `after` for the next page; absent on the last page. */
  nextCursor?: string;
}

export interface ListEventDeliveriesQuery {
  status?: EventDeliveryStatus;
  sessionId?: string;
  /** The `nextCursor` of the previous page. */
  after?: string;
  /** At most 200; default 50. */
  limit?: number;
}

/**
 * What `POST .../replay` re-delivers: named deliveries, a session's events
 * (optionally a sequence range), or a window of event times. At most 100
 * deliveries per call; every replay keeps the original `eventId`.
 */
export type ReplayEventDeliveriesSelection =
  | { deliveryIds: string[] }
  | {
      sessionId: string;
      fromSequence?: number;
      toSequence?: number;
      since?: string;
      until?: string;
      limit?: number;
    }
  | { sessionId?: string; since?: string; until?: string; limit?: number };

/** The headers of every delivery attempt. */
export const EVENT_DELIVERY_HEADERS = {
  timestamp: "x-oc-timestamp",
  signature: "x-oc-signature",
  deliveryId: "x-oc-delivery-id",
  attemptId: "x-oc-delivery-attempt",
  eventId: "x-oc-event-id",
  eventType: "x-oc-event-type",
} as const;

export const EVENT_SIGNATURE_VERSION = "v1";

/** Reject attempts whose timestamp is further from now than this. */
export const EVENT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1_000;

/** The string a delivery's signature covers: `<timestamp>.<METHOD>.<path+query>.<body>`. */
export function eventSigningInput(timestamp: string, method: string, path: string, body: string): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** One `v1=<hex>` entry of the signature header. */
export async function signEventDelivery(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): Promise<string> {
  return `${EVENT_SIGNATURE_VERSION}=${await hmacSha256Hex(secret, eventSigningInput(timestamp, method, path, body))}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

export interface VerifyEventDeliveryInput {
  /** The subscription's signing secret(s); pass both during a rotation. */
  secret: string | readonly string[];
  /** The request's headers, or the two signature headers by name. */
  headers: Headers | Record<string, string | undefined>;
  /** The request method; deliveries are `POST`. */
  method: string;
  /** The request's pathname plus query string, e.g. `new URL(request.url)` → `pathname + search`. */
  path: string;
  /** The raw request body, exactly as received. */
  body: string;
  /** For tests; default `Date.now()`. */
  nowMs?: number;
  toleranceMs?: number;
}

function header(headers: VerifyEventDeliveryInput["headers"], name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? null;
}

/**
 * Whether a delivery attempt is authentic: its timestamp is within tolerance
 * of now and one `v1=` entry of its signature header is the HMAC-SHA-256 of
 * the signing input under one of your secrets. Verify before parsing the
 * body; deduplicate on the body's `eventId` afterwards.
 */
export async function verifyEventDelivery(input: VerifyEventDeliveryInput): Promise<boolean> {
  const timestamp = header(input.headers, EVENT_DELIVERY_HEADERS.timestamp);
  const signature = header(input.headers, EVENT_DELIVERY_HEADERS.signature);
  if (!timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - seconds * 1_000) > (input.toleranceMs ?? EVENT_SIGNATURE_TOLERANCE_MS)) return false;
  const presented = signature
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${EVENT_SIGNATURE_VERSION}=`));
  if (!presented.length) return false;
  const secrets = typeof input.secret === "string" ? [input.secret] : input.secret;
  for (const secret of secrets) {
    const expected = await signEventDelivery(secret, timestamp, input.method, input.path, input.body);
    if (presented.some((entry) => timingSafeEqual(entry, expected))) return true;
  }
  return false;
}

/**
 * The parsed envelope of a verified delivery, or `null` when the body is not
 * one. Call after {@link verifyEventDelivery}; this checks shape, not authenticity.
 */
export function parseEventDelivery(body: string): EventDeliveryEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.schema !== EVENT_DELIVERY_SCHEMA) return null;
  for (const key of ["deliveryId", "eventId", "occurredAt", "projectId", "environment", "agentId", "deploymentId", "sessionId", "turnId", "type"]) {
    if (typeof envelope[key] !== "string") return null;
  }
  if (typeof envelope.sequence !== "number") return null;
  if (typeof envelope.data !== "object" || envelope.data === null) return null;
  return envelope as unknown as EventDeliveryEnvelope;
}
