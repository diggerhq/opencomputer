// Webhook verification for OpenComputer destinations — shared across **session** webhooks
// (Durable Agent Sessions) and **sandbox lifecycle** webhooks. One verifier, one envelope.
//
// Deliveries are signed with the Standard Webhooks scheme (https://www.standardwebhooks.com).
// Sandbox webhooks are delivered by Svix, which uses the same scheme under `svix-`-prefixed
// headers; session webhooks use the `webhook-`-prefixed names. This verifier accepts EITHER:
//   {svix,webhook}-id, {svix,webhook}-timestamp, {svix,webhook}-signature, where
//   signature = "v1,<base64(HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`))>"
// and the secret is the destination's `whsec_…` value. The header may carry several
// space-separated signatures (key rotation); any match passes.
//
// Implemented with Web Crypto (no Node-only deps) so it runs in Cloudflare Workers,
// browsers, Deno, and Node 16+ — the same places the SDK runs. Verify against the RAW
// request body, BEFORE JSON-parsing it.

import type { Event } from "./types.js";
import { normalize } from "./normalize.js";

/**
 * The envelope OpenComputer POSTs to a destination (camelCase). One shape for both products;
 * the product-specific id is set accordingly. `E` is the nested event type — pass
 * `SandboxLifecycleEvent` for sandbox webhooks, leave it as the session `Event` otherwise.
 */
export interface WebhookDelivery<E = Event> {
  /** The event type — route on this (e.g. `turn.completed`, `sandbox.stopped`). */
  type: string;
  /** Set on **session** webhooks. */
  sessionId?: string;
  /** Set on **sandbox lifecycle** webhooks. */
  sandboxId?: string;
  /** The underlying event id — app-level correlation. */
  eventId: string;
  /**
   * The delivery id, set by {@link verifyWebhook}. **Sandbox** webhooks: the Svix message id
   * (`svix-id`). **Session** webhooks: the delivery-row id (`X-OC-Delivery-ID` header) — note the
   * session `webhook-id` header is the *eventId*, not a delivery id, so it is NOT used here.
   */
  deliveryId?: string;
  /**
   * The idempotency key to dedupe on — stable across retries and redelivery. **Sandbox**: the
   * Svix message id (`svix-id`). **Session**: the `eventId`. Prefer this over {@link deliveryId}
   * for "have I already processed this?" checks.
   */
  dedupeId?: string;
  /**
   * Opaque routing metadata. On **session** webhooks this is carried in the body. On **sandbox**
   * webhooks, per-destination metadata is delivered as custom HTTP **headers** (set at
   * registration), not in the body, so this is absent — read it from the request headers.
   */
  metadata?: Record<string, unknown> | null;
  /** The full event — the same shape the SSE stream emits (session) or the lifecycle event (sandbox). */
  event: E;
}

export interface VerifyWebhookOptions {
  /** Max allowed clock skew between now and `webhook-timestamp`, in seconds (default 300). */
  toleranceSeconds?: number;
  /** Override "now" (unix seconds) — for testing. */
  nowSeconds?: number;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag | Headers, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;   // Headers.get is case-insensitive
  }
  const bag = headers as HeaderBag;
  const v = bag[name] ?? bag[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Derive the HMAC key bytes EXACTLY as the backend does (delivery signing): strip the
 * `whsec_` prefix, use the base64-decoded bytes if the remainder round-trips as base64,
 * otherwise fall back to the raw UTF-8 bytes of the ORIGINAL secret. So a destination made
 * with a non-base64 secret (e.g. `"testsecret"`) verifies, matching what the server signed.
 */
function secretKeyBytes(secret: string): Uint8Array<ArrayBuffer> {
  const s = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    const decoded = base64ToBytes(s);
    if (decoded.length > 0 && bytesToBase64(decoded).replace(/=+$/, "") === s.replace(/=+$/, "")) return decoded;
  } catch {
    /* not base64 → raw bytes below */
  }
  return new Uint8Array(new TextEncoder().encode(secret));
}

/** Constant-time string compare (equal length → no early-exit on content). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a webhook delivery and return its parsed envelope. Throws
 * {@link WebhookVerificationError} on a missing/expired/invalid signature.
 *
 * ```ts
 * import { verifyWebhook } from "@opencomputer/sdk";
 * // in your handler — pass the RAW body string, not a parsed object:
 * const delivery = await verifyWebhook(rawBody, request.headers, process.env.OC_WEBHOOK_SECRET!);
 * if (delivery.type === "turn.completed") { /* route via delivery.metadata *\/ }
 * ```
 */
export async function verifyWebhook<E = Event>(
  rawBody: string,
  headers: HeaderBag | Headers,
  secret: string,
  opts: VerifyWebhookOptions = {},
): Promise<WebhookDelivery<E>> {
  const id = header(headers, "svix-id") ?? header(headers, "webhook-id");
  const ts = header(headers, "svix-timestamp") ?? header(headers, "webhook-timestamp");
  const sigHeader = header(headers, "svix-signature") ?? header(headers, "webhook-signature");
  if (!id || !ts || !sigHeader) {
    throw new WebhookVerificationError("missing {svix,webhook}-id / -timestamp / -signature header");
  }

  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) throw new WebhookVerificationError("invalid webhook-timestamp");
  if (Math.abs(now - tsNum) > tolerance) {
    throw new WebhookVerificationError("webhook-timestamp outside tolerance (possible replay)");
  }

  let expected: string;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", secretKeyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const msg = new Uint8Array(new TextEncoder().encode(`${id}.${ts}.${rawBody}`));
    expected = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg)));
  } catch (err) {
    throw new WebhookVerificationError(`could not compute signature: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Header is space-separated "v1,<sig>" entries (multiple during secret rotation).
  const matched = sigHeader.split(" ").some((entry) => {
    const comma = entry.indexOf(",");
    if (comma < 0) return false;
    return entry.slice(0, comma) === "v1" && timingSafeEqual(entry.slice(comma + 1), expected);
  });
  if (!matched) throw new WebhookVerificationError("no matching webhook signature");

  try {
    // Normalize so the returned envelope + nested event match the SDK's camelCase types
    // (the wire event is snake-cased, e.g. `turn_id`). The two products use different header
    // dialects + delivery-id ownership, so resolve deliveryId/dedupeId by dialect:
    //  - Sandbox (Svix): `svix-id` is BOTH the stable delivery id and the dedupe key.
    //  - Session: the signed `webhook-id` is the *eventId* (dedupe on it); the delivery-row id
    //    rides separately in `X-OC-Delivery-ID`.
    const delivery = normalize(JSON.parse(rawBody)) as WebhookDelivery<E>;
    const svixId = header(headers, "svix-id");
    if (svixId) {
      delivery.deliveryId = svixId;
      delivery.dedupeId = svixId;
    } else {
      const deliveryRowId = header(headers, "x-oc-delivery-id");
      if (deliveryRowId) delivery.deliveryId = deliveryRowId;
      // webhook-id == eventId for sessions; prefer the body's eventId, fall back to the header.
      delivery.dedupeId = delivery.eventId ?? id;
    }
    return delivery;
  } catch {
    throw new WebhookVerificationError("signature valid but body is not JSON");
  }
}
