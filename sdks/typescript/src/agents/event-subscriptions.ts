// Event subscription types — the shapes of the management API documented at
// docs/agents/api.mdx ("Event subscriptions") and the input an agent reads
// through `useInput()` when a subscribed outcome is delivered to it.
// `oc.projects.eventSubscriptions` sends and returns them.

import type { MemoryEnvironment } from "./memory.js";
import type { SessionLabels, SessionQuestion, TurnOutcome } from "./types.js";

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
  /**
   * Label pairs the source session must carry, every one of them, read when
   * the source turn is accepted; omitted selects regardless of labels. 1–8
   * pairs under the same key and value rules as session labels.
   */
  sourceLabels?: SessionLabels;
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
  /** Label pairs the source session must carry; absent selects regardless of labels. */
  sourceLabels?: SessionLabels;
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
  /**
   * The last message of a completed turn that wrote text, bounded to 16 KB;
   * `truncated` when it was cut to fit.
   */
  result?: { text: string; truncated?: boolean };
  /** `question` when a completed turn ended by asking; `question` then names what it asked. */
  outcome?: TurnOutcome;
  question?: Omit<SessionQuestion, "askedAt">;
  /** The source session's labels when the outcome was delivered; absent when it has none. */
  labels?: SessionLabels;
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
