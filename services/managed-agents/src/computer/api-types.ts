// The Computer session API's public objects (work 084; opc docs/api/reference/objects.mdx,
// events.mdx, errors.mdx). The source of truth is calvin's src/api/schema.ts, published as
// schema/computer-api.v1.json; these are the shapes blue builds and the schema checks in tests.
// Every documented field is always present, `null` rather than absent. Tests validate bodies
// against the vendored schema (test/fixtures/calvin/computer-api.v1.json).

import type { CalvinApiActor, CalvinJournalEvent } from "./protocol.js";

export type Actor = CalvinApiActor;
export type ApiEvent = CalvinJournalEvent;

export type SessionStatus = "starting" | "running" | "waiting" | "idle" | "suspended";
export type TurnStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type AskStatus = "open" | "answered" | "dismissed" | "declined" | "interrupted";
export type AskKind = "approval" | "question" | "secret";
export type IfBusy = "queue" | "steer" | "interrupt";
export type OriginType = "slack" | "opc" | "dashboard" | "api";

export interface Person {
  id: string;
  name: string;
  email: string | null;
}

export interface SlackOrigin {
  teamId: string | null;
  channelId: string;
  channelName: string | null;
  threadTs: string | null;
  url: string | null;
}

export interface Origin {
  type: OriginType | string;
  client: string | null;
  slack: SlackOrigin | null;
}

export interface SessionSettings {
  model: string | null;
  effort: string | null;
  mode: string;
  /** `fast` | `standard`; null = the default (fast). */
  speed: string | null;
}

export interface TurnError {
  code: string;
  message: string;
  [field: string]: unknown;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
}

export interface Steering {
  input: string;
  author: Actor;
  createdAt: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  status: TurnStatus;
  /** `message`, or `subagent` for a turn the harness started when a background subagent ended (open enum). */
  trigger: string;
  /** With `trigger: "subagent"`: the subagent whose end started it. */
  subagentId: string | null;
  ifBusy: IfBusy;
  /** null when the turn was not started by a message. */
  input: string | null;
  /** null when no one sent it (`trigger: "subagent"`, or a turn the writer started on its own). */
  author: Actor | null;
  steering: Steering[];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  text: string | null;
  error: TurnError | null;
  reason: string | null;
  forced: boolean | null;
  usage: TurnUsage | null;
}

export interface TurnSummary {
  id: string;
  status: "completed" | "failed" | "cancelled";
  endedAt: string;
  text: string | null;
  error: TurnError | null;
  reason: string | null;
  forced: boolean | null;
}

export interface Ask {
  id: string;
  sessionId: string;
  turnId: string;
  kind: AskKind;
  status: AskStatus;
  createdAt: string;
  closedAt: string | null;
  closedBy: Actor | null;
  answer: unknown;
  approval: Record<string, unknown> | null;
  question: Record<string, unknown> | null;
  secret: Record<string, unknown> | null;
}

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

/**
 * A subagent the session's agent launched (subagents.md, 2026-10-26; id `sa_`). Started and ended
 * are journaled (`subagent.started`/`subagent.ended {subagent}`); `subagent.progress` is a delta
 * whose latest `activity`/`toolCalls`/`tokens` fold in on every read. `result` is inline up to
 * 8 KiB (`resultTruncated`); `GET …/subagents/{id}` has it whole.
 */
export interface Subagent {
  id: string;
  sessionId: string;
  /** The turn that launched it (a background subagent outlives it). */
  turnId: string;
  callId: string | null;
  name: string;
  agentType: string | null;
  background: boolean;
  status: SubagentStatus;
  activity: string | null;
  toolCalls: number;
  tokens: number;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  result: string | null;
  resultTruncated: boolean;
  error: TurnError | null;
  /** The member (`usr_…`) who stopped it, or null. */
  /** Who stopped it through the API (an Actor), else null. */
  stoppedBy: Actor | null;
}

/** A `subagent.progress` delta's values, as the host sends them folded (latest per subagent). */
export interface SubagentProgress {
  subagentId: string;
  activity: string | null;
  toolCalls: number;
  tokens: number;
}

export interface SessionContext {
  usedTokens: number | null;
  windowTokens: number | null;
}

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  archived: boolean;
  owner: Person;
  origin: Origin;
  settings: SessionSettings;
  metadata: Record<string, string>;
  activeTurnId: string | null;
  queued: Turn[];
  asks: Ask[];
  /** The running subagents, oldest first (subagents.md). */
  subagents: Subagent[];
  lastTurn: TurnSummary | null;
  lastText: string | null;
  context: SessionContext;
  lastSeq: number;
  logEpoch: number;
  epochStartSeq: number;
  createdAt: string;
  lastActiveAt: string;
  syncedAt: string | null;
  urls: { dashboard: string | null };
}

/**
 * What the SessionLog derives from the log and hands the Computer DO after every append,
 * so the row (and so `GET /sessions`) never reads the log. Status here is the log's view;
 * the row combines it with the runner's (a lost host is `suspended`).
 */
export interface LogSummary {
  lastSeq: number;
  logEpoch: number;
  epochStartSeq: number;
  /** From the newest `session.status_changed`, or null before any. */
  status: SessionStatus | null;
  /** From `session.created` / `session.updated`, when the log has them. */
  title: string | null;
  settings: SessionSettings | null;
  activeTurnId: string | null;
  queued: Turn[];
  asks: Ask[];
  /** The running subagents, oldest first; results inline-truncated (8 KiB). Progress is not in it (the row never shows it). */
  subagents: Subagent[];
  lastTurn: TurnSummary | null;
  lastText: string | null;
  context: SessionContext;
  /** `createdAt` of the newest event, or null with none. */
  lastActiveAt: string | null;
  /** When the SessionLog last heard from the writer (any append, even a duplicate). */
  syncedAt: string | null;
}

/** The HTTP error body. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    [field: string]: unknown;
  };
}

/** The API key scopes (authentication.mdx#scopes). */
export const API_SCOPES = ["sessions:read", "sessions:write", "asks:answer", "secrets:write", "terminals"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
