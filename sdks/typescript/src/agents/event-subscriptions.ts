// Event subscription types — the shapes of the management API documented at
// docs/agents/api.mdx ("Event subscriptions") and the input an agent reads
// through `useInput()` when a subscribed outcome is delivered to it.
//
// These are types only. The subscription routes live on the project-scoped
// Serverless Agents surface (`/api/managed-agents/projects/<id>/event-subscriptions`),
// which this package does not call. Use them to type the bodies you send
// with your own HTTP client and the objects it returns.

import type { MemoryEnvironment } from "./memory.js";

/** The turn outcomes a subscription can select. Turn outcomes, not session ends. */
export type OutcomeEventType = "turn.completed" | "turn.failed" | "turn.cancelled";

/** Where a subscription delivers: a session of an agent in the same project. */
export interface SessionDestination {
  type: "session";
  sessionId: string;
}

/** Body of `POST /projects/<id>/event-subscriptions`. */
export interface CreateEventSubscriptionBody {
  /** Exact source agent id; omitted selects every agent in the project. */
  agentId?: string;
  /** At least one outcome type. */
  events: OutcomeEventType[];
  destination: SessionDestination;
  /** The environment whose outcomes are delivered; the destination session runs in it. */
  environment?: MemoryEnvironment;
}

/** A subscription as the routes return it. Immutable once created. */
export interface EventSubscription {
  id: string;
  projectId: string;
  agentId?: string;
  environment?: MemoryEnvironment;
  events: OutcomeEventType[];
  destination: SessionDestination;
  createdAt: string;
}

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
  destination: SessionDestination;
  status: "pending" | "delivered" | "failed";
  attempt: number;
  /** The turn the destination admitted; the same for a retried delivery. */
  receipt?: { sessionId: string; turnId: string };
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
  | "event_subscription_not_found";
