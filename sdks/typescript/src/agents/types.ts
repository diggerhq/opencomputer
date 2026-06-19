// Domain types for the Durable Agent Sessions API (v3). Field names are camelCase —
// the client normalizes the API's snake_case at the boundary.

export type SessionStatus = "queued" | "running" | "idle" | "failed" | "archived";
export type Level = "user" | "progress" | "internal";
export type YieldReason =
  | "completed" | "needs_input" | "error"
  | "budget_exceeded" | "deadline_exceeded" | "max_turns" | "canceled";

export interface Limits { tokens?: number; turnSeconds?: number; turns?: number; }

export interface Actor {
  id?: string;
  kind?: "human" | "agent" | "system" | (string & {});
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
  state?: "queued" | "running" | "ok" | "error";
  yieldReason?: YieldReason;
  turnId?: string;
  startedAt?: string;
  completedAt?: string;
  resultEventId?: string;
  error?: unknown;
}

export interface Turn {
  id: string;
  state?: "queued" | "running" | "ok" | "error";
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
  credentialId?: string;
  lastTurn?: LastTurn;
  limits?: Limits;
  key?: string;
  createdAt?: string;
}

export interface Credential {
  id: string;
  provider: string;
  name?: string;
  last4?: string;
  createdAt?: string;
}

export interface Destination {
  id: string;
  url: string;
  level: Level;
  types?: string[];
  includeRaw: boolean;
  enabled: boolean;
  createdAt?: string;
}

export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed" | "dead_letter";

export interface Delivery {
  id: string;
  destinationId: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  responseCode?: number;
  error?: string;
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
