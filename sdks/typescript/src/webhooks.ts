// Sandbox lifecycle webhooks — the account-level control surface.
//
// PREVIEW: newly available functionality; the surface may change.
//
// Register a destination and OpenComputer delivers sandbox lifecycle events to it as a
// small, signed envelope — at-least-once, retried, dead-lettered, and redeliverable. This is
// the management client (org API key, server-side); to VERIFY an incoming delivery in your
// handler use `verifyWebhook` (exported from the package root, shared with session webhooks).
//
//   import { Webhooks } from "@opencomputer/sdk";
//   const webhooks = new Webhooks({ apiKey: process.env.OPENCOMPUTER_API_KEY });
//   const { id, secret } = await webhooks.create({ url: "https://app.example.com/oc" });
//   // `secret` is shown ONCE — store it now; you'll need it to verify deliveries.

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
 * {@link SandboxLifecycleEvent} under `event`. Delivered by Svix; `sandboxId` and `deliveryId`
 * are always set, and `deliveryId` equals the `svix-id` header (stable across retries — dedupe
 * on it). Per-destination registration metadata arrives as custom HTTP headers, not in the body.
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
  /** Whether a signing secret is set (the secret itself is never returned after create). */
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebhookParams {
  url: string;
  /** Optional unique name (per org) — makes create get-or-create / idempotent. */
  name?: string;
  /** Signing secret. Omit and OpenComputer generates a `whsec_…` one, returned ONCE on create. */
  secret?: string;
  /** Event-type allow-list (exact or `prefix.*`); default all. */
  eventTypes?: string[];
  /** Scope to one sandbox; omit for all of the org's sandboxes. */
  sandboxId?: string;
  enabled?: boolean;
  /** Idempotency-Key header — a timed-out retry returns the same destination, never a duplicate. */
  idempotencyKey?: string;
}

/** The create response — the only time `secret` is ever returned (and only when generated). */
export interface CreateWebhookResult extends WebhookDestination {
  /** The signing secret (`whsec_…`). Returned ONCE, only when OpenComputer generated it. Store it now. */
  secret?: string;
}

export interface UpdateWebhookParams {
  url?: string;
  /** Pass `null` to clear the allow-list (deliver all types). */
  eventTypes?: string[] | null;
  enabled?: boolean;
  /** Set a caller-supplied signing secret (you keep it; it isn't echoed back). */
  secret?: string;
  /** Generate a NEW signing secret — returned once on the response (see {@link CreateWebhookResult}). */
  rotateSecret?: boolean;
  name?: string;
}

/** Scope (`sandboxId`) is immutable — set it at create; it can't be changed by update. */

// ---- deliveries (the control surface behind a deliveries dashboard) ----

export type WebhookDeliveryStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "failed"
  | "dead_letter"
  | "canceled";

export interface WebhookDeliveryRecord {
  id: string;
  destination: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  /** Lifetime attempt count (audit). */
  attempts: number;
  /** Retry budget consumed since the last (re)enqueue; reset by a manual redeliver. */
  retryCount: number;
  lastAttemptAt: string | null;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
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

  /** List deliveries for a destination (cursor-paginated). */
  async list(
    destinationId: string,
    params: { status?: WebhookDeliveryStatus; cursor?: string; limit?: number } = {},
  ): Promise<ListPage<WebhookDeliveryRecord>> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.limit != null) q.set("limit", String(params.limit));
    const qs = q.toString();
    const resp = await fetch(`${this.apiUrl}/webhooks/${destinationId}/deliveries${qs ? `?${qs}` : ""}`, {
      headers: this.headers,
    });
    if (!resp.ok) return fail(resp, "list deliveries");
    return resp.json();
  }

  /** Fetch one delivery in detail. */
  async get(destinationId: string, deliveryId: string): Promise<WebhookDeliveryRecord> {
    const resp = await fetch(`${this.apiUrl}/webhooks/${destinationId}/deliveries/${deliveryId}`, {
      headers: this.headers,
    });
    if (!resp.ok) return fail(resp, "get delivery");
    return resp.json();
  }

  /**
   * Re-send any delivery (not only dead-lettered ones). Gives the delivery a fresh retry
   * budget and returns the re-enqueued record; the redelivery carries the **same** `webhook-id`,
   * so a receiver that dedupes will treat it as the same message — redelivery is for cases
   * where the original never landed.
   */
  async redeliver(destinationId: string, deliveryId: string): Promise<WebhookDeliveryRecord> {
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
   * Register a destination. Returns HTTP 201 (new) or 200 (an existing destination
   * matched by `name`). The response includes `secret` once iff OpenComputer
   * generated it. With an `idempotencyKey`, a retried call returns the same
   * destination + secret; if a same-key request is concurrently in flight the
   * server replies 409 `idempotency_in_progress` (retryable) — this method
   * automatically waits (honoring `Retry-After`) and retries a few times.
   */
  async create(params: CreateWebhookParams): Promise<CreateWebhookResult> {
    const { idempotencyKey, ...body } = params;
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(`${this.apiUrl}/webhooks`, {
        method: "POST",
        headers: this.headers(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
        body: JSON.stringify(body),
      });
      if (resp.ok) return resp.json();
      if (resp.status === 409 && attempt < 5) {
        const body409 = (await resp.clone().json().catch(() => ({}))) as { code?: string };
        if (body409.code === "idempotency_in_progress") {
          const retryAfter = Number(resp.headers.get("Retry-After")) || 1;
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
      }
      return fail(resp, "create webhook");
    }
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

  /** Soft-delete a destination. Its delivery history is retained; pending deliveries are canceled. */
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
