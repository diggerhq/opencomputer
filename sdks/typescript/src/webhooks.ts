// Sandbox lifecycle webhooks — the account-level control surface.
//
// PREVIEW: newly available functionality; the surface may change.
//
// Register a destination and OpenComputer delivers sandbox lifecycle events to it as a small,
// signed envelope — at-least-once, retried with managed backoff, and redeliverable (delivery is
// handled by Svix). This is the management client (org API key, server-side); to VERIFY an
// incoming delivery in your handler use `verifyWebhook` (exported from the package root, shared
// with session webhooks).
//
//   import { Webhooks } from "@opencomputer/sdk";
//   const webhooks = new Webhooks({ apiKey: process.env.OPENCOMPUTER_API_KEY });
//   const { id, secret } = await webhooks.create({ url: "https://app.example.com/oc" });
//   // `secret` verifies deliveries; it's returned here and re-fetchable via webhooks.getSecret(id).

import type { WebhookDelivery } from "./agents/webhooks.js";

function resolveApiUrl(url: string): string {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}

// ---- the delivered envelope (what your endpoint receives; verify with `verifyWebhook`) ----

export type SandboxWebhookEventType =
  | "sandbox.created"
  | "sandbox.ready"
  | "sandbox.hibernated"
  | "sandbox.resumed"
  | "sandbox.stopped"
  | "sandbox.migrated"
  | "sandbox.checkpoint.created"
  | "sandbox.forked"
  | "sandbox.scaled"
  | "sandbox.preview_url.changed"
  | "sandbox.test";

/** Why a sandbox stopped (`sandbox.stopped` → `event.data.reason`). */
export type SandboxStopReason = "user_requested" | "expired" | "crash";

/** Fields common to every lifecycle event (nested under `event` in a delivery). */
export interface SandboxLifecycleEventBase {
  id: string;
  ts: string;
  orgId: string;
  sandboxId: string;
}

/**
 * The lifecycle event nested under `event` in a delivery — a discriminated union
 * on `type`, so `event.data` is typed per event (e.g. narrow on
 * `event.type === "sandbox.stopped"` to get `event.data.reason`).
 */
export type SandboxLifecycleEvent = SandboxLifecycleEventBase &
  (
    | { type: "sandbox.created"; data: { template?: string } }
    | { type: "sandbox.ready"; data: Record<string, never> }
    | { type: "sandbox.hibernated"; data: Record<string, never> }
    | { type: "sandbox.resumed"; data: Record<string, never> }
    | { type: "sandbox.stopped"; data: { reason: SandboxStopReason } }
    | { type: "sandbox.migrated"; data: Record<string, never> }
    | { type: "sandbox.checkpoint.created"; data: { checkpointId: string } }
    | { type: "sandbox.forked"; data: { parentId: string } }
    | { type: "sandbox.scaled"; data: { cpuCount: number; memoryMB: number } }
    | { type: "sandbox.preview_url.changed"; data: { port: number; url: string | null } }
    | { type: "sandbox.test"; data: Record<string, unknown> }
  );

/**
 * The delivered envelope for sandbox webhooks: the shared {@link WebhookDelivery} carrying a
 * {@link SandboxLifecycleEvent} under `event`. Delivered by Svix; `sandboxId`, `deliveryId`, and
 * `dedupeId` are always set, and all equal the `svix-id` header (stable across retries — dedupe on
 * `dedupeId`). Per-destination registration metadata arrives as custom HTTP headers, not in the body.
 *
 * Verify an incoming request with: `verifyWebhook<SandboxLifecycleEvent>(rawBody, headers, secret)`.
 */
export type SandboxWebhookDelivery = WebhookDelivery<SandboxLifecycleEvent>;

// ---- destinations ----

export interface WebhookDestination {
  id: string;
  name: string | null;
  url: string;
  /** Event-type allow-list (exact or `prefix.*`); empty = all. */
  eventTypes: string[];
  /** Scoped to one sandbox, or `null` for all of the org's sandboxes. */
  sandboxId: string | null;
  enabled: boolean;
  /** Whether a signing secret is set; fetch the value any time with {@link Webhooks.getSecret}. */
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebhookParams {
  url: string;
  /** Optional display name for the destination. */
  name?: string;
  /** Signing secret. Omit and OpenComputer generates a `whsec_…` one (re-fetchable via {@link Webhooks.getSecret}). */
  secret?: string;
  /** Event-type allow-list (exact, e.g. `sandbox.stopped`, or `prefix.*`); default all. Unknown types are rejected. */
  eventTypes?: string[];
  /** Scope to one sandbox; omit for all of the org's sandboxes. */
  sandboxId?: string;
  enabled?: boolean;
}

/** The create response — includes the signing `secret` (also re-fetchable later via {@link Webhooks.getSecret}). */
export interface CreateWebhookResult extends WebhookDestination {
  /** The signing secret (`whsec_…`). Returned here on create, and re-fetchable any time via {@link Webhooks.getSecret}. */
  secret?: string;
}

export interface UpdateWebhookParams {
  url?: string;
  /** Pass `null` to clear the allow-list (deliver all types). Unknown types are rejected. */
  eventTypes?: string[] | null;
  enabled?: boolean;
  /**
   * Rotate to a NEW Svix-generated signing secret — returned on the response (see
   * {@link CreateWebhookResult}). The previous secret stays valid for a short rollover window so
   * in-flight deliveries still verify. (To set a specific secret, create a new destination.)
   */
  rotateSecret?: boolean;
  name?: string;
}

/** Scope (`sandboxId`) is immutable — set it at create; it can't be changed by update. */

// ---- deliveries (the control surface behind a deliveries dashboard) ----

export type WebhookDeliveryStatus = "success" | "pending" | "failed";

/** One Svix delivery attempt to the endpoint (from `deliveries.list`). */
export interface WebhookDeliveryRecord {
  /** The message id — the key for `get` / `redeliver`; equals the `svix-id` header. */
  id: string;
  status: WebhookDeliveryStatus;
  /** The consumer's HTTP response code, when the attempt reached it. */
  responseStatusCode?: number;
  timestamp?: string;
}

/** A delivered message (from `deliveries.get`). */
export interface WebhookMessage {
  id: string;
  eventType?: string;
  eventId?: string;
  payload?: unknown;
  timestamp?: string;
}

export interface WebhookTestResult {
  /** The test message was accepted by Svix for delivery (delivery itself is async). */
  ok: boolean;
  /** The event type sent — a type the destination is subscribed to. */
  eventType?: string;
  /** The Svix message id; find its attempt under `deliveries`. */
  messageId?: string;
}

export interface ListPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface WebhooksOptions {
  /** Defaults to `process.env.OPENCOMPUTER_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.OPENCOMPUTER_API_URL` or `https://app.opencomputer.dev`. */
  apiUrl?: string;
}

async function fail(resp: Response, what: string): Promise<never> {
  let detail = "";
  try {
    const body = (await resp.json()) as { error?: { message?: string } | string };
    detail = typeof body.error === "string" ? body.error : body.error?.message ?? "";
  } catch {
    /* no JSON body */
  }
  throw new Error(`${what}: HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`);
}

/** Delivery records for the org's webhook destinations. Reached via `webhooks.deliveries`. */
export class WebhookDeliveries {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  /** List recent delivery attempts for a destination. */
  async list(destinationId: string): Promise<WebhookDeliveryRecord[]> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${destinationId}/deliveries`, {
      headers: this.headers,
    });
    if (!resp.ok) return fail(resp, "list deliveries");
    const body = (await resp.json()) as { data?: WebhookDeliveryRecord[] };
    return body.data ?? [];
  }

  /** Fetch one delivered message by id. */
  async get(destinationId: string, deliveryId: string): Promise<WebhookMessage> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${destinationId}/deliveries/${deliveryId}`, {
      headers: this.headers,
    });
    if (!resp.ok) return fail(resp, "get delivery");
    return resp.json();
  }

  /**
   * Re-send a message to the endpoint. The redelivery carries the **same** `svix-id`, so a
   * receiver that dedupes treats it as the same message — for when the original never landed.
   */
  async redeliver(destinationId: string, deliveryId: string): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${destinationId}/deliveries/${deliveryId}/redeliver`, {
      method: "POST",
      headers: this.headers,
    });
    if (!resp.ok) return fail(resp, "redeliver");
    return resp.json();
  }
}

/**
 * Manage webhook destinations for sandbox lifecycle events. Server-side only — uses the org
 * API key. To verify an incoming delivery, use `verifyWebhook` (package root).
 *
 * **Preview:** newly available; the surface may change.
 */
export class Webhooks {
  readonly deliveries: WebhookDeliveries;
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(opts: WebhooksOptions = {}) {
    this.apiUrl = resolveApiUrl(opts.apiUrl ?? process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev");
    this.apiKey = opts.apiKey ?? process.env.OPENCOMPUTER_API_KEY ?? "";
    this.deliveries = new WebhookDeliveries(this.apiUrl, this.apiKey);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  /**
   * Register a destination (HTTP 201). Each call creates a new destination — there is no
   * get-or-create. The response includes the signing `secret` (also re-fetchable later via
   * {@link getSecret}). Unknown `eventTypes` are rejected with a 400.
   */
  async create(params: CreateWebhookParams): Promise<CreateWebhookResult> {
    const resp = await fetch(`${this.apiUrl}/webhooks`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params),
    });
    if (!resp.ok) return fail(resp, "create webhook");
    return resp.json();
  }

  async list(): Promise<WebhookDestination[]> {
    const resp = await fetch(`${this.apiUrl}/webhooks`, { headers: this.headers() });
    if (!resp.ok) return fail(resp, "list webhooks");
    const body = (await resp.json()) as { data?: WebhookDestination[] } | WebhookDestination[];
    return Array.isArray(body) ? body : body.data ?? [];
  }

  async get(id: string): Promise<WebhookDestination> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${id}`, { headers: this.headers() });
    if (!resp.ok) return fail(resp, "get webhook");
    return resp.json();
  }

  /**
   * Fetch the destination's current signing secret (`whsec_…`). Re-fetchable any time by the
   * owner (API key) — use it to verify deliveries. Rotate with `update(id, { rotateSecret: true })`.
   */
  async getSecret(id: string): Promise<string> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${id}/secret`, { headers: this.headers() });
    if (!resp.ok) return fail(resp, "get webhook secret");
    const body = (await resp.json()) as { secret: string };
    return body.secret;
  }

  /** Update a destination — pause/resume (`enabled`), retune `eventTypes`, change `url`, or rotate `secret`. */
  async update(id: string, params: UpdateWebhookParams): Promise<CreateWebhookResult> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${id}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(params),
    });
    if (!resp.ok) return fail(resp, "update webhook");
    return resp.json();
  }

  /** Delete a destination (removes its Svix endpoint). Delivery history for a deleted destination is no longer queryable. */
  async delete(id: string): Promise<void> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${id}`, { method: "DELETE", headers: this.headers() });
    if (!resp.ok) return fail(resp, "delete webhook");
  }

  /**
   * Send a sample event (of a type the destination is subscribed to) to exercise the endpoint.
   * Returns the queued Svix message; delivery is asynchronous — check `deliveries` for the result.
   */
  async test(id: string): Promise<WebhookTestResult> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${id}/test`, { method: "POST", headers: this.headers() });
    if (!resp.ok) return fail(resp, "test webhook");
    return resp.json();
  }
}
