import type { AgentInputValue } from "../protocol.js";

export const WEBHOOK_BODY_LIMIT = 256 * 1024;
export const WEBHOOK_TEXT_LIMIT = 64 * 1024;

export interface WebhookInput {
  text?: string;
  payload?: AgentInputValue;
}

export type NormalizedWebhookInput =
  | { ok: true; input: WebhookInput }
  | { ok: false; message: string };

/**
 * Turn a delivered JSON object into agent input. `{ text, payload }` keeps
 * its meaning; any other object is admitted whole as `payload`, so provider
 * bodies need no translation.
 */
export function normalizeWebhookInput(body: unknown): NormalizedWebhookInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Expected a JSON object" };
  }
  const record = body as Record<string, unknown>;
  const hasText = Object.hasOwn(record, "text");
  const hasPayload = Object.hasOwn(record, "payload");
  if (!hasText && !hasPayload) {
    return { ok: true, input: { payload: record as AgentInputValue } };
  }
  if (hasText && typeof record.text !== "string") {
    return { ok: false, message: "text must be a string" };
  }
  const text = hasText ? (record.text as string) : undefined;
  if (!text?.trim() && !hasPayload) {
    return { ok: false, message: "Expected text or payload in a JSON object" };
  }
  if (text && new TextEncoder().encode(text).byteLength > WEBHOOK_TEXT_LIMIT) {
    return { ok: false, message: "text cannot exceed 64 KiB" };
  }
  return {
    ok: true,
    input: {
      ...(text !== undefined ? { text } : {}),
      ...(hasPayload ? { payload: record.payload as AgentInputValue } : {}),
    },
  };
}

/**
 * Where a webhook reads a delivery's identity when the caller sends no
 * `Idempotency-Key`: a request header, or a JSON Pointer (RFC 6901) into the
 * body. Configured per webhook, so the platform holds no provider knowledge.
 *
 *   header:X-GitHub-Delivery
 *   body:/data/event/event_id
 */
export type WebhookIdentitySource =
  | { kind: "header"; name: string }
  | { kind: "body"; pointer: string };

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const JSON_POINTER = /^(\/([^/~]|~0|~1)*)+$/;
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Headers a webhook may not name as its identity: the public edge sets or
 * strips them before the backend sees a delivery, so the sender's value
 * could never be read. This list mirrors the public edge's forwarding policy
 * (`opencomputer/cloudflare-workers/api-edge/src/managed_agents.ts`); change
 * both together.
 */
const HEADERS_NOT_DELIVERED = new Set([
  "idempotency-key",
  "authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "x-request-id",
  "x-api-key",
]);
const HEADER_PREFIXES_NOT_DELIVERED = ["x-oc-", "cf-", "x-forwarded-", "x-real-"];

/** Validate and normalize a configured source; throws with a caller-facing message. */
export function parseWebhookIdentitySource(value: string): string {
  const source = value.trimStart();
  if (source.startsWith("header:")) {
    const name = source.slice("header:".length).trim().toLowerCase();
    if (!HEADER_NAME.test(name)) {
      throw new Error("identity header names may contain letters, numbers, and hyphens");
    }
    if (
      HEADERS_NOT_DELIVERED.has(name) ||
      HEADER_PREFIXES_NOT_DELIVERED.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error(`identity cannot read ${name}: the platform sets or strips that header`);
    }
    return `header:${name}`;
  }
  if (source.startsWith("body:")) {
    // The pointer is kept verbatim: whitespace is significant in a JSON key.
    const pointer = source.slice("body:".length);
    if (!JSON_POINTER.test(pointer) || pointer.length > 256) {
      throw new Error("identity body pointers must be JSON Pointers such as /data/event/event_id");
    }
    return `body:${pointer}`;
  }
  throw new Error("identity must be header:<name> or body:<json-pointer>");
}

function identitySource(value: string): WebhookIdentitySource {
  return value.startsWith("header:")
    ? { kind: "header", name: value.slice("header:".length) }
    : { kind: "body", pointer: value.slice("body:".length) };
}

/** RFC 6901 evaluation; only string and finite number values count as identities. */
function pointerValue(body: unknown, pointer: string): string | undefined {
  let current: unknown = body;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  if (typeof current === "string" && current) return current;
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  return undefined;
}

/** Longest configured-source key kept verbatim; longer ones are replaced by their hash. */
const DERIVED_KEY_LIMIT = 200;

async function boundedKey(key: string): Promise<string> {
  if (key.length <= DERIVED_KEY_LIMIT) return key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface WebhookDeliveryIdentity {
  key: string;
  /**
   * Read from the webhook's configured source rather than supplied as an
   * `Idempotency-Key`. A derived identity is authoritative: a provider may
   * reserialize the body on retry, so a body-hash mismatch under it is not
   * a conflict.
   */
  derived: boolean;
}

/**
 * The identity a delivery is deduplicated by: the caller's `Idempotency-Key`,
 * else the value at the webhook's configured source. Undefined means every
 * delivery is new.
 */
export async function webhookDeliveryIdentity(
  headers: Headers,
  body: unknown,
  configured?: string,
): Promise<WebhookDeliveryIdentity | undefined> {
  const explicit = headers.get("idempotency-key")?.trim();
  if (explicit) return { key: explicit, derived: false };
  if (!configured) return undefined;
  const source = identitySource(configured);
  const value =
    source.kind === "header"
      ? headers.get(source.name)?.trim() || undefined
      : pointerValue(body, source.pointer);
  return value ? { key: await boundedKey(`${configured}=${value}`), derived: true } : undefined;
}
