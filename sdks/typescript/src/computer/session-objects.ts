// The session API's objects as a client sees them (services/managed-agents/src/api-objects/objects.ts).
// Part of the wire contract of tracks and threads (spec section 42.1); no runtime code here.

export type SessionStatus = "starting" | "running" | "waiting" | "idle" | "suspended";
export type IfBusy = "queue" | "steer" | "interrupt";
export type AskKind = "approval" | "question" | "secret";
export type AskStatus = "open" | "answered" | "dismissed" | "declined" | "interrupted";

export interface Actor {
  id: string;
  name: string | null;
  via: string;
  client: string | null;
}

export interface Person {
  id: string;
  name: string;
  email: string | null;
}

export interface Origin {
  type: string;
  client: string | null;
  slack: { teamId: string | null; channelId: string; channelName: string | null; threadTs: string | null; url: string | null } | null;
}

export interface TurnError {
  code: string;
  message: string;
  [field: string]: unknown;
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

/** A subagent the session's agent launched (Claude Code's Task tool, Codex's agents). Background ones outlive their turn. */
export interface Subagent {
  id: string;
  sessionId: string;
  /** The turn that launched it. */
  turnId: string;
  /** The tool call that launched it; null when the harness does not say. */
  callId: string | null;
  /** Its description. */
  name: string;
  agentType: string | null;
  background: boolean;
  status: "running" | "completed" | "failed" | "stopped" | (string & {});
  /** What it is doing now; null once ended or before it reports. */
  activity: string | null;
  toolCalls: number;
  tokens: number;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Its final answer: null until it ends; inline up to 8 KiB (`resultTruncated`). */
  result: string | null;
  resultTruncated: boolean;
  error: { code: string; message: string } | null;
  stoppedBy: unknown;
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
  /** `{ toolName, title, command?, … }` for an approval. */
  approval: Record<string, unknown> | null;
  /** `{ questions: [{ id, header, text, options: [{ label, description? }], multiSelect? }] }`. */
  question: Record<string, unknown> | null;
  secret: Record<string, unknown> | null;
}

export type Answer =
  | { decision: "allow" | "deny" | "always"; message?: string }
  | { answers: { questionId: string; choices: string[]; text: string | null }[] };

/** What `message.received` carries per file (work 126): metadata only; the bytes are read by `GET …/attachments/{id}/content`. */
export interface AttachmentRef {
  id: string;
  name: string;
  mimetype: string;
  bytes: number;
}

export type AttachmentState = "uploading" | "ready" | "attached" | "deleted";

/** The server's `Attachment` object (`GET /sessions/{sid}/attachments/{id}`, `PUT …/content`). */
export interface Attachment extends AttachmentRef {
  sessionId: string;
  by: Actor;
  state: AttachmentState;
  etag: string | null;
  createdAt: string;
  attachedTo: { turnId: string; messageId?: string | null } | null;
}

export interface ApiEvent {
  id: string;
  seq: number;
  createdAt: string;
  sessionId: string;
  turnId: string | null;
  type: string;
  actor: Actor | null;
  data: unknown;
}

/**
 * Who may use a session (docs/api/sessions.mdx#access): `owner` only its owner, `org` every member,
 * `people` the owner and the listed members (`usr_…`). A Slack session reads `owner`.
 */
export interface SessionAccess {
  mode: "owner" | "org" | "people";
  people: string[];
}

/** `access` of a create or `PATCH /sessions/{id}`: `people` as member ids, WorkOS user ids or emails. */
export interface AccessInput {
  mode: SessionAccess["mode"];
  people?: string[];
}

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  archived: boolean;
  aside?: boolean;
  access?: SessionAccess;
  /** Whether the caller may change `access`: its owner, someone in `people`, or an admin. Not on a feed row. */
  canManageAccess?: boolean;
  owner: Person;
  origin: Origin;
  settings: { model: string | null; effort: string | null; mode: string; speed: string | null };
  metadata: Record<string, string>;
  activeTurnId: string | null;
  queued: unknown[];
  asks: Ask[];
  /** The running subagents, oldest first. */
  subagents: Subagent[];
  lastTurn: TurnSummary | null;
  lastText: string | null;
  context: { usedTokens: number | null; windowTokens: number | null };
  lastSeq: number;
  logEpoch: number;
  epochStartSeq: number;
  createdAt: string;
  lastActiveAt: string;
  syncedAt: string | null;
  urls: { dashboard: string | null };
}
