// The internal contract between the Linear agent build's streams (work 037,
// Phase 1). Lead-owned: a stream that needs a change here records it in work
// 037's seams first. Each interface names the stream that implements it; the
// others code against it and test with fakes until integration.

import type {
  LinearConnection,
  ProjectEnvironmentName,
  QuestionOption,
} from "../protocol.js";

/**
 * The owner of a session started from Linear: the connection, not the person
 * who wrote the message. The managed services proxy keys on it, so an agent
 * in such a session that calls `callService({ service: "linear" })` acts with
 * the connection's app token, and no person's grant resolves there.
 */
const LINEAR_PRINCIPAL_PREFIX = "channel:linear:";

export function linearConnectionPrincipal(connectionId: string): string {
  return `${LINEAR_PRINCIPAL_PREFIX}${connectionId}`;
}

export function parseLinearConnectionPrincipal(
  userId: string,
): { connectionId: string } | null {
  if (!userId.startsWith(LINEAR_PRINCIPAL_PREFIX)) return null;
  const connectionId = userId.slice(LINEAR_PRINCIPAL_PREFIX.length);
  return connectionId ? { connectionId } : null;
}

export interface LinearGraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
}

/** Why a connection cannot act now. Never retried by the caller. */
export type LinearUnavailableReason =
  | "not_found"
  | "pending"
  | "disconnected"
  | "revoked";

export type LinearGraphqlResult =
  /** Linear answered. GraphQL `errors` arrive with HTTP 200; the caller interprets them. */
  | {
      outcome: "ok";
      data: unknown;
      errors?: Array<{ message: string; extensions?: unknown }>;
    }
  | { outcome: "unavailable"; reason: LinearUnavailableReason }
  /** Transport failure, a 5xx or a rate limit: retry with backoff. */
  | {
      outcome: "transient";
      status?: number;
      message: string;
      retryAfterSeconds?: number;
    }
  /** A 4xx that is not a rate limit, after the one refresh-and-retry on 401. */
  | { outcome: "permanent"; status: number; message: string };

export type LinearTokenResult =
  | { outcome: "token"; token: string; expiresAt: string }
  | { outcome: "unavailable"; reason: LinearUnavailableReason }
  | {
      outcome: "transient";
      message: string;
      retryAfterSeconds?: number;
    };

/**
 * S1 implements. Lives inside the Account object as
 * `this.linearConnections`; S2, S3 and S4 call it there. Tokens never leave
 * the Account object except through `accessToken`, whose only caller is the
 * managed services proxy serving `callService({ service: "linear" })` in a
 * connection-owned session.
 */
export interface LinearConnectionStore {
  get(connectionId: string): LinearConnection | null;
  /** The connection bound to this project environment and agent, if any. */
  forAgent(
    projectId: string,
    environment: ProjectEnvironmentName,
    agentId: string,
  ): LinearConnection | null;
  /** The webhook signing secret, for verification inside the Account object. */
  signingSecret(connectionId: string): Promise<string | null>;
  /**
   * `POST https://api.linear.app/graphql` as the app user. Attaches the
   * token, refreshes it when within five minutes of expiry and once on a
   * 401, and discards a refresh whose connection revision moved meanwhile.
   */
  graphql(
    connectionId: string,
    request: LinearGraphqlRequest,
  ): Promise<LinearGraphqlResult>;
  /** The current token, refreshed by the same rules; for the managed services proxy only. */
  accessToken(connectionId: string): Promise<LinearTokenResult>;
  /** Health facts from verified ingress. */
  recordEvent(connectionId: string, at: string): void;
  markRevoked(connectionId: string, at: string): void;
  updateTeams(
    connectionId: string,
    teams: { allPublic: boolean; teamIds: string[] },
  ): void;
}

/** What the Account object holds until S1 integrates. */
export function unavailableLinearConnectionStore(): LinearConnectionStore {
  return {
    get: () => null,
    forAgent: () => null,
    signingSecret: async () => null,
    graphql: async () => ({ outcome: "unavailable", reason: "not_found" }),
    accessToken: async () => ({ outcome: "unavailable", reason: "not_found" }),
    recordEvent: () => undefined,
    markRevoked: () => undefined,
    updateTeams: () => undefined,
  };
}

// ── Activities (S3) ───────────────────────────────────────────────────────────

export type LinearActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "elicitation"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/** One `agentActivityCreate`. `id` is a UUIDv4 generated once and persisted. */
export interface LinearActivityPost {
  id: string;
  agentSessionId: string;
  content: LinearActivityContent;
  ephemeral?: boolean;
  signal?: "select";
  signalMetadata?: { options: QuestionOption[] };
}

/**
 * S3 implements as the Account RPC `postLinearActivity(connectionId, post)`,
 * on `LinearConnectionStore.graphql`. A `conflict on insert of AgentActivity`
 * is `posted` with `duplicate: true`, reconciled by querying the id.
 */
export type LinearActivityPostResult =
  | { outcome: "posted"; createdAt: string; duplicate: boolean }
  | { outcome: "transient"; message: string; retryAfterSeconds?: number }
  | { outcome: "permanent"; message: string }
  | { outcome: "unavailable"; reason: LinearUnavailableReason };

/**
 * What the Session object's turn and question code hands the activity
 * queue. S3 implements `enqueueLinearActivity` in `linear-activities.ts`;
 * it is a no-op for a session that no Linear input reached, and it must be
 * synchronous so a caller can enqueue inside its own `transactionSync`.
 */
export interface LinearActivityEnqueue {
  kind: "progress" | "terminal";
  content: LinearActivityContent;
  turnId?: string;
  /** Set on an elicitation: the question it asks. */
  questionId?: string;
  ephemeral?: boolean;
  signal?: "select";
  signalMetadata?: { options: QuestionOption[] };
}

// ── Questions and controls (S4) ───────────────────────────────────────────────

/**
 * A control delivery applied to a session (design 018, Stop). S4 implements
 * the Session RPC `applyControl`; S2 calls it. Idempotent on `deliveryId`:
 * a repeat returns the recorded result and never acts on later work.
 */
export interface SessionControlInput {
  deliveryId: string;
  kind: "stop";
  /** The stop prompt's provider `createdAt`. */
  providerTime: string;
}

export interface SessionControlResult {
  deliveryId: string;
  duplicate: boolean;
  appliedAt: string;
  interruptedTurnId?: string;
  discardedTurnKeys: string[];
  closedQuestionId?: string;
}
