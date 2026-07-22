// Domain types for the Durable Agent Sessions API (v3). Field names are camelCase —
// the client normalizes the API's snake_case at the boundary.

export type SessionStatus = "queued" | "running" | "awaiting_input" | "idle" | "failed" | "archived";
export type Level = "user" | "progress" | "internal";
export type YieldReason =
  | "completed" | "needs_input" | "error"
  | "budget_exceeded" | "deadline_exceeded" | "max_turns" | "canceled";

export interface Limits { tokens?: number; turnSeconds?: number; turns?: number; }

export type UsageAttribution = "exact" | "best_effort";

/** A terminal turn with at least one trustworthy normalized usage observation. */
export interface ReportedTurnUsage {
  reported: true;
  /** False means the token/cost values present are lower bounds. */
  complete?: false;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  tokens: number;
  /** Runtime/provider-reported visibility; absent means unknown, not zero. */
  totalCostUsd?: number;
  attribution?: UsageAttribution;
}

/** A terminal turn for which no trustworthy usage observation was available. */
export interface UnreportedTurnUsage {
  reported: false;
  attribution?: UsageAttribution;
}

/** Historical rows created before usage rollups were populated remain empty. */
export type HistoricalUsage = { [key: string]: never };
export type TurnUsage = ReportedTurnUsage | UnreportedTurnUsage | HistoricalUsage;

export interface SessionUsageSummary {
  activeSeconds: number;
  reportedTurns: number;
  unreportedTurns: number;
  /** False means any token/cost totals present are lower bounds. */
  complete: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  tokens?: number;
  /** Runtime/provider-reported visibility; absent means unknown, not zero. */
  totalCostUsd?: number;
  attribution?: UsageAttribution;
}

export type SessionUsage = SessionUsageSummary | HistoricalUsage;

// The runtime an agent runs on. `claude` and `pi` run `anthropic/…` models today and
// `codex` runs `openai/…`. `pi` is built provider-agnostic (the provider comes from the
// model's `provider/` prefix, not the runtime) — more providers land next. The union
// keeps known values discoverable while still accepting future ones.
export type Runtime = "claude" | "codex" | "pi" | (string & {});

// A credential id (`newId("cred")` → `cred_…`). The template keeps the shape
// checkable while still accepting any concrete id.
export type CredentialId = `cred_${string}`;
// How an agent picks its model source: the reserved "managed" sentinel (run via
// OpenComputer, no provider key) or a specific BYO credential id. Omit/null to
// inherit the org default.
export type CredentialRef = "managed" | CredentialId;

export interface Actor {
  id?: string;
  type?: "human" | "agent" | "system" | (string & {});
  display?: string;
}

export interface Agent {
  id: string;
  name: string;
  /** Canonical application URL for trusted-backend JSON invocation. */
  invokeUrl: string;
  promptHash?: string;
  model: string;
  runtime: Runtime;
  revision?: number;
  /** The agent's active revision (what new sessions run); `prompt`/`model` are served from it. */
  activeRevision?: { id: string; number: number; digest: string } | null;
  credentialId?: CredentialRef | null;
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
  activeSeconds?: number;
  usage?: TurnUsage | null;
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
  usage?: SessionUsage | null;
  limits?: Limits;
  /** Opaque app routing state set at create (`null` when unset). See {@link CreateSessionParams.metadata}. */
  metadata?: Record<string, unknown> | null;
  key?: string;
  createdAt?: string;
}

export interface Credential {
  id: CredentialId;
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
