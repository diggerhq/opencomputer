// Domain types for the Durable Agent Sessions API (v3). Field names are camelCase —
// the client normalizes the API's snake_case at the boundary.

export type SessionStatus = "queued" | "running" | "awaiting_input" | "idle" | "failed" | "archived";
export type Level = "user" | "progress" | "internal";
export type YieldReason =
  | "completed" | "needs_input" | "error"
  | "budget_exceeded" | "deadline_exceeded" | "max_turns" | "canceled";

export interface Limits { tokens?: number; turnSeconds?: number; turns?: number; }

export interface Actor {
  id?: string;
  type?: "human" | "agent" | "system" | (string & {});
  display?: string;
}

export interface Agent {
  id: string;
  name: string;
  promptHash?: string;
  model: string;
  runtime: string;
  revision?: number;
  credentialId?: string | null;
  limits?: Limits;
  createdAt?: string;
  updatedAt?: string;
}

export interface LastTurn {
  /** The turn id (the API/SSE field is `last_turn.id`). */
  id?: string;
  state?: "queued" | "accepted" | "running" | "ok" | "error";
  yieldReason?: YieldReason;
  startedAt?: string;
  completedAt?: string;
  resultEventId?: string;
  error?: unknown;
}

export interface Turn {
  id: string;
  state?: "queued" | "accepted" | "running" | "ok" | "error";
  yieldReason?: YieldReason;
  resultEventId?: string;
  error?: unknown;
  startedAt?: string;
  completedAt?: string;
}

export interface SessionData {
  id: string;
  status: SessionStatus;
  head?: number;
  inputCursor?: number;
  agentSnapshot?: { promptHash?: string; model?: string; runtime?: string; revision?: number };
  agentId?: string;
  credentialId?: string;
  lastTurn?: LastTurn;
  limits?: Limits;
  /** Opaque app routing state set at create (`null` when unset). See {@link CreateSessionParams.metadata}. */
  metadata?: Record<string, unknown> | null;
  key?: string;
  createdAt?: string;
}

export interface Credential {
  id: string;
  provider: string;
  name?: string;
  last4?: string;
  isDefault?: boolean;
  createdAt?: string;
}

export interface Destination {
  id: string;
  session: string;
  kind: string;
  url: string;
  level: Level;
  types?: string[] | null;
  includeRaw: boolean;
  enabled: boolean;
  hasSecret: boolean;
  createdAfterSeq?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed" | "dead_letter";

export interface Delivery {
  id: string;
  session: string;
  destination: string;
  eventId: string;
  eventSeq?: number;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  responseCode?: number;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── Events ─────────────────────────────────────────────────────────────────────
// Discriminated on `type`. Switch on it; don't parse prose. Unknown types fall through
// the open member and still carry `body.text`/`summary`, so new types are non-breaking.

export interface EventBase {
  id: string;
  seq: number;
  ts: string;
  session: string;
  actor: Actor;
  level: Level;
  turnId?: string;
  contentRef?: string;
  bodyTruncated?: boolean;
  bodyBytes?: number;
  refs: Record<string, unknown>;
}

export type Event =
  | (EventBase & { type: "user.message";   body: { text: string } })
  | (EventBase & { type: "agent.message";  body: { text: string } })
  | (EventBase & { type: "turn.started";   body: { turnId: string; inputFromSeq?: number; inputToSeq?: number } })
  | (EventBase & { type: "turn.completed"; body: { turnId: string; yieldReason: YieldReason; resultEventId?: string } })
  | (EventBase & { type: "tool.call";      body: { tool: string; argsSummary?: string } })
  | (EventBase & { type: "exec.completed"; body: { command: string; exitCode: number; summary?: string; contentRef?: string; bytes?: number } })
  | (EventBase & { type: "preview.url";    body: { url: string; port?: number } })
  | (EventBase & { type: string;           body: Record<string, any> }); // forward-compat catch-all
