// Webhook verification for Durable Agent Sessions destinations.
//
// Deliveries are signed with the Standard Webhooks scheme (https://www.standardwebhooks.com):
// headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, where
//   webhook-signature = "v1,<base64(HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`))>"
// and the secret is the destination's `whsec_…` value. The header may carry several
// space-separated signatures (key rotation); any match passes.
//
// Implemented with Web Crypto (no Node-only deps) so it runs in Cloudflare Workers,
// browsers, Deno, and Node 16+ — the same places the SDK runs. Verify against the RAW
// request body, BEFORE JSON-parsing it.

import type { Event } from "./types.js";

/** The envelope OpenComputer POSTs to a destination (see the Webhooks docs). */
export interface WebhookDelivery<E = Event> {
  /** The event type — route on this (e.g. `turn.completed`). */
  type: string;
  sessionId: string;
  /** Equals the `webhook-id` header — dedupe on it. */
  eventId: string;
  /** The session's opaque routing state, verbatim (`null` when unset). */
  metadata: Record<string, unknown> | null;
  /** The full event — the same shape the SSE stream emits. */
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
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sigHeader = header(headers, "webhook-signature");
  if (!id || !ts || !sigHeader) {
    throw new WebhookVerificationError("missing webhook-id / webhook-timestamp / webhook-signature header");
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
    return JSON.parse(rawBody) as WebhookDelivery<E>;
  } catch {
    throw new WebhookVerificationError("signature valid but body is not JSON");
  }
}
