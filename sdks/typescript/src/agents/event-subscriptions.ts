// Event subscription types — the shapes of the management API documented at
// docs/agents/api.mdx ("Event subscriptions") and the input an agent reads
// through `useInput()` when a subscribed outcome is delivered to it.
// `oc.projects.eventSubscriptions` sends and returns them.

import type { MemoryEnvironment } from "./memory.js";
import type { EventSubscriptionStatus, HttpsDestination } from "./event-delivery.js";

/** The turn outcomes a subscription can select. Turn outcomes, not session ends. */
export type OutcomeEventType = "turn.completed" | "turn.failed" | "turn.cancelled";

/** Where a subscription delivers: a session of an agent in the same project. */
export interface SessionDestination {
  type: "session";
  sessionId: string;
}

/** A session of the same project, or an HTTPS receiver you operate (signed deliveries). */
export type EventSubscriptionDestination = SessionDestination | HttpsDestination;

/** Body of `POST /projects/<id>/event-subscriptions`. */
export interface CreateEventSubscriptionBody {
  /** Exact source agent id; omitted selects every agent in the project. */
  agentId?: string;
  /** At least one outcome type. */
  events: OutcomeEventType[];
  destination: EventSubscriptionDestination;
  /**
   * The environment whose outcomes are delivered; the destination session
   * runs in it. Required for an HTTPS destination: each environment's
   * subscriptions and secrets are its own.
   */
  environment?: MemoryEnvironment;
}

/** A subscription as the routes return it. Immutable once created, except its `status`. */
export interface EventSubscription {
  id: string;
  projectId: string;
  agentId?: string;
  environment?: MemoryEnvironment;
  events: OutcomeEventType[];
  destination: EventSubscriptionDestination;
  /** HTTPS destinations: `active` or `paused`. */
  status?: EventSubscriptionStatus;
  /** HTTPS destinations: when the signing secret was last rotated. */
  secretRotatedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

/** What `create` and `rotateSecret` return: the subscription and, for an HTTPS destination, its signing secret. */
export type EventSubscriptionWithSecret = EventSubscription & {
  /** Shown on this response only; absent for a session destination. Store it. */
  signingSecret?: string;
};

/**
 * A source turn's recorded outcome as the receiving agent reads it from
 * `useInput().event` when `source` is `"event"`. Identifiers and outcome
 * only; the included agent output is data, not instructions.
 */
export interface OutcomeEvent {
  /** The source session's own event id for the terminal `turn.*` event. */
  id: string;
  type: OutcomeEventType;
  sessionId: string;
  turnId: string;
  agentId: string;
  occurredAt: string;
  /** Why the turn failed or was cancelled, when the source recorded a reason. */
  reason?: string;
  /** The failure message, bounded, when the turn failed. */
  error?: string;
  /** The final assistant message of a completed turn; `truncated` when it was cut to fit. */
  result?: { text: string; truncated?: boolean };
}

/** The input of a turn an event subscription started, as the agent's `useInput()` returns it. */
export interface EventInput {
  source: "event";
  /** Not set on a delivered outcome; the event is the input. */
  text?: string;
  event: OutcomeEvent;
}

/**
 * One outcome's delivery to one subscription, as `GET /sessions/<id>`
 * lists it under the source turn's `deliveries`.
 */
export interface TurnOutcomeDelivery {
  /** `<subscriptionId>:<eventId>`, also the idempotency key of the turn it starts. */
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: OutcomeEventType;
  destination: EventSubscriptionDestination;
  status: "pending" | "delivered" | "failed";
  attempt: number;
  /** The turn the destination admitted; the same for a retried delivery. Session destinations only. */
  receipt?: { sessionId: string; turnId: string };
  /** The delivery record tracked under the subscription's `deliveries`. HTTPS destinations only. */
  deliveryId?: string;
  nextAttemptAt?: string;
  /**
   * `subscription_unavailable` (deleted before delivery), `target_missing`,
   * `target_ended`, or `delivery_failed` for any other failure.
   */
  error?: "subscription_unavailable" | "target_missing" | "target_ended" | "delivery_failed";
  updatedAt: string;
}

/** Error codes the subscription routes return in `{ error: { code, message } }`. */
export type EventSubscriptionErrorCode =
  | "invalid_event_subscription"
  | "project_scope_violation"
  | "destination_session_not_found"
  | "destination_session_ended"
  | "event_subscription_not_found"
  | "event_subscription_not_https"
  | "event_delivery_not_found"
  | "invalid_deliveries_query"
  | "invalid_replay";
