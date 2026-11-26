// Delivery's contract (tracks and threads, spec sections 35.3, 36.5 and 40.6): what the edge's
// webhook routes and Delivery's own callers pass. `poke` and `status` are in ../actor/contracts.ts.

import type { DeliveryRpc, Occurrence, OrgRpc, Principal, Reply } from "../actor/contracts.js";

export const DELIVERY_KINDS = ["wake", "webhook", "slack"] as const;

/** The kinds of occurrence that wake a track's agent or a parent session (section 40.6). */
export const WAKE_KINDS = ["turn.completed", "turn.failed", "ask.opened", "result.changed", "thread.done", "thread.placed", "track.quiet"];
/** The kinds the Slack echo acts on; every other is passed over. */
export const SLACK_KINDS = ["turn.refused", "machine.changed"];

export const PAGE = 100;
export const POLL_MS = 60_000;
export const WAKE_DEBOUNCE_MS = 20_000;
/**
 * A wake's or a Slack echo's waits between tries; past the last it goes to the dead list (section
 * 18.6). Short, so one that keeps failing holds its group minutes, not hours. A webhook has none:
 * handing it to Svix is retried without limit, and Svix retries the endpoint.
 */
export const RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000];
export const MAX_ENDPOINTS = 20;
/** The Svix application of an organization's webhooks. */
export const svixApp = (org: string): string => `work-${org}`;

/** `PUT /webhooks/{id}`'s body. */
export interface EndpointInput {
  /** `https:`. */
  url: string;
  /** The occurrence kinds delivered; absent or empty, all of them. */
  kinds?: string[];
  enabled?: boolean;
}

export interface Endpoint {
  id: string;
  url: string;
  kinds: string[];
  enabled: boolean;
  createdBy: string;
  /** The signing secret, on the answer that created the endpoint and never again. */
  secret?: string;
}

/** What a webhook's `POST` carries: the occurrence, as `GET /occurrences` shows it, signed and sent by Svix. */
export type WebhookBody = Occurrence;

export interface DeliveryRpcFull extends DeliveryRpc {
  // webhook only; a member or a key with `work:write`, never an agent
  setEndpoint(p: Principal, id: string, e: EndpointInput): Promise<Reply<{ endpoint: Endpoint }>>;
  listEndpoints(p: Principal): Promise<Reply<{ endpoints: Endpoint[] }>>;
  removeEndpoint(p: Principal, id: string): Promise<Reply<{ removed: boolean }>>;
}

/**
 * What Delivery(wake) asks of Org beyond ../actor/contracts.ts: the sessions occurrence `n` wakes,
 * its thread's track's agent and its parent, before the rule that an agent is not woken by its own act.
 */
export interface OrgForDelivery extends OrgRpc {
  wakeTargets(n: number): Promise<string[]>;
}
