import type { MemoryBinding, MemoryDeclaration, MemoryEnvironment } from "./edge/memory-contract.js";

export const AGENT_PROTOCOL_VERSION = 2 as const;

/**
 * Every public session status, in one place: the type below and the list
 * query's validator both derive from it, so a status the session can show
 * is never one the listing refuses. `stopping`: a Stop (interrupt,
 * interrupt-mode admission, or recovery after runtime loss) has been
 * recorded and the stopped turn's work is being settled, the model loop
 * stopped and every command it dispatched terminated and confirmed, or the
 * computer terminated. Nothing dispatches meanwhile; `idle` follows.
 */
export const SESSION_STATUSES = [
  "new",
  "connecting",
  "idle",
  "running",
  "stopping",
  "waiting_runtime",
  "suspending",
  "suspended",
  "resuming",
  "failed",
  "ended",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionExecutionMode = "microvm" | "workerd";

export type DeploymentRuntimeMode = "microvm" | "workerd-lazy-sandbox";

/**
 * Where a deployment's sessions run: its tool sandboxes and the Durable
 * Objects created for it. Absent means the platform default. Work 057.
 * The values are Modal's sandbox regions, broad then narrow.
 */
export const DEPLOYMENT_REGIONS = [
  "us",
  "eu",
  "ap",
  "us-east",
  "us-central",
  "us-south",
  "us-west",
  "eu-west",
  "eu-north",
  "eu-south",
  "ap-northeast",
  "ap-southeast",
  "ap-south",
  "ap-melbourne",
  "jp",
  "au",
  "uk",
  "ca",
  "me",
  "sa",
  "af",
  "mx",
] as const;

export type DeploymentRegion = (typeof DEPLOYMENT_REGIONS)[number];

/**
 * Outbound allowlist for a deployment's tool sandboxes: domains (exact or
 * `*.` wildcard, TLS on 443) and CIDRs (any port). Absent means an open
 * network. Work 057.
 */
export interface DeploymentEgress {
  domains: string[];
  cidrs: string[];
}

export type SessionSource =
  | "api"
  | "channel"
  | "playground"
  | "schedule"
  | "webhook";

export type AgentInputValue =
  | null
  | boolean
  | number
  | string
  | AgentInputValue[]
  | { [key: string]: AgentInputValue };

/**
 * A JSON value whose shape a schema governs, not the type system: what a
 * session's result carries. Deliberately not recursive: workers-types
 * checks a Durable Object method's return type structurally, and a
 * recursive JSON type in a returned snapshot exceeds its instantiation
 * depth, while `unknown` makes the whole return type `never`.
 */
export type JsonValue = null | boolean | number | string | object;

export interface StructuredAgentInput {
  source:
    | "user"
    | "channel"
    | "schedule"
    | "webhook"
    | "subagent"
    | "system"
    | "event";
  text?: string;
  payload?: AgentInputValue;
  schedule?: {
    id: string;
    runId: string;
    scheduledAt: string;
    timezone: string;
    attempt: number;
    manual: boolean;
  };
  webhook?: {
    id: string;
    requestId: string;
    receivedAt: string;
  };
  /**
   * Who sent a channel message, in the provider's own terms. An agent behind
   * one workspace never reads it; an agent behind many cannot work without it.
   */
  channel?: {
    provider: string;
    connectionId: string;
    workspaceId?: string;
    conversationId?: string;
    userId?: string;
  };
  /** Present when `source` is `event`: a recorded turn outcome delivered by an event subscription. */
  event?: OutcomeEvent;
  /**
   * Present only when this input answers the session's open question. Beside
   * `payload`, not inside it, so an answer never collides with a caller's
   * own payload and reads the same from every source.
   */
  answer?: QuestionAnswer;
  /**
   * Inputs that arrived while the question was open without naming it, in
   * the order they arrived, up to `STEERING_ITEM_LIMIT` items and
   * `STEERING_SIZE_LIMIT` encoded. Held inputs beyond that run as ordinary
   * turns right after the answering turn, in order.
   */
  steering?: HeldInput[];
  /**
   * On a channel input that runs while the session's question is still open
   * on a channel that does not hold (Slack): the question the person was
   * shown, so the agent knows a gate is pending and can read the message as
   * its answer, as steering, or as something else. Set when the turn is
   * dispatched; a click on the question's buttons arrives as `answer`
   * instead. The question closes `superseded` when this turn completes.
   */
  openQuestion?: { id: string; text: string; options: QuestionOption[] };
}

// ── Questions (design 018, `ask`) ─────────────────────────────────────────────

/** The harness tool that ends a turn with a question. Reserved: no code tool may use the id. */
export const ASK_TOOL = "ask" as const;

/** Bounds of the `ask` input, enforced by the host before anything is persisted. */
export const ASK_TEXT_LIMIT = 4000;
export const ASK_CONTEXT_LIMIT = 4000;
export const ASK_OPTION_LIMIT = 6;
export const ASK_OPTION_TEXT_LIMIT = 80;

export interface QuestionOption {
  /** 1–80 characters, shown to the person. */
  label: string;
  /** 1–80 characters; what a selection sends back. */
  value: string;
}

/**
 * The `ask` tool's input: `text` 1–4000 characters, at most six options,
 * and `context`, at most 4000 characters of Markdown: what the person needs
 * to decide, shown above the question where the conversation supports it.
 */
export interface AskInput {
  text: string;
  options?: QuestionOption[];
  context?: string;
}

/** The harness tool that ends a turn consulting a sibling agent of the session's project. Reserved: no code tool may use the id. */
export const CONSULT_TOOL = "consult" as const;

/** Bounds of the `consult` input, enforced by the host before anything is persisted. */
export const CONSULT_AGENT_LIMIT = 120;
export const CONSULT_PROMPT_LIMIT = 8000;

/** The `consult` tool's input: `agent` names the member agent (local name or full id), `prompt` the question it runs. */
export interface ConsultInput {
  agent: string;
  prompt: string;
}

/**
 * The session's open question. Its id is derived from the turn and the tool
 * call that asked, so a replayed call resolves to the same question.
 */
export interface SessionQuestion {
  id: string;
  text: string;
  options: QuestionOption[];
  /** What the person needs to decide (Markdown), as the agent wrote it with the question; absent when it wrote none. */
  context?: string;
  askedAt: string;
}

/** How an input answered a question. `value` is set when the text matched an option by value or label. */
export interface QuestionAnswer {
  questionId: string;
  text: string;
  value?: string;
}

/** An input held while a question was open, as delivered in `steering`. */
export interface HeldInput {
  text?: string;
  payload?: AgentInputValue;
  channel?: StructuredAgentInput["channel"];
  /** When the platform received it. */
  receivedAt: string;
  /** When the provider says it was written, when the provider says (Linear's prompt `createdAt`). */
  providerTime?: string;
}

/**
 * The most held inputs an answering turn carries in `steering`, and their
 * size together (the encoded JSON length of the entries, the unit of every
 * turn input bound). What does not fit runs as ordinary turns after the
 * answering turn, in order; an answer is never refused for what was held.
 */
export const STEERING_ITEM_LIMIT = 20;
export const STEERING_SIZE_LIMIT = 64 * 1024;

/**
 * Why a question ended without an answer (design 018): `stopped` (a Linear
 * stop; held inputs are discarded), `dismissed` (the dismiss operation; held
 * inputs run as ordinary turns, in order), `ended` (the session ended; held
 * inputs are discarded), `undeliverable` (the elicitation could never be
 * posted; held inputs run as ordinary turns, in order) and `superseded` (a
 * question on a channel that does not hold, such as Slack: the agent replied
 * to a later message in the thread, or asked again, so the question is no
 * longer the one pending; nothing was held behind it). Under a holding
 * channel a later `ask` follows the answer and is a new question, never a
 * replacement.
 */
export type QuestionClosedReason =
  | "stopped"
  | "dismissed"
  | "ended"
  | "undeliverable"
  | "superseded";

/** What a settled turn came to beyond its status. `question`: the turn ended by asking. */
export type TurnOutcome = "question";

// ── Linear agent input (design 018, "What the agent receives") ────────────────

/**
 * The `payload` of a Linear-started turn: `source: "channel"` with
 * `channel.provider: "linear"`, `channel.conversationId` the Linear agent
 * session id, `channel.workspaceId` the Linear organization id, and `text`
 * Linear's prompt context on `created` or the message body on `prompted`.
 * Linear's own payload status is deliberately absent: it is a stale snapshot.
 */
export interface LinearInputPayload {
  action: "created" | "prompted";
  /** The issue as this delivery carried it. */
  issue: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
    url: string;
    team: { id: string; key: string; name: string };
  };
  /**
   * Verified with the app token when the session was created and frozen
   * there: the issue's parent then, and whether the connection's own app user
   * created the issue. The platform derives nothing from them.
   */
  origin: {
    parent?: { id: string; identifier: string };
    createdByAgent: boolean;
  };
  session: {
    id: string;
    url?: string;
    /** The responsible human; absent for automation, such as a delegation by the app itself. */
    creator?: { id: string; name: string };
  };
  /** Linear's prompt context, when the session began with a `created` event. */
  promptContext?: string;
  /** The root comment, when the session is a comment thread. */
  comment?: { id: string; body: string };
  /** Earlier comments of that thread, as Linear sent them. */
  previousComments?: AgentInputValue;
  /** Workspace and team guidance for agents, as Linear sent it. */
  guidance?: AgentInputValue;
}

/** Turn outcomes an event subscription can select. Turn outcomes, not session ends. */
export type OutcomeEventType = "turn.completed" | "turn.failed" | "turn.cancelled";

export const OUTCOME_EVENT_TYPES: readonly OutcomeEventType[] = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
];

/** The final assistant text of a completed source turn is bounded to this many bytes. */
export const OUTCOME_RESULT_TEXT_LIMIT = 16 * 1024;

/**
 * A source turn's recorded outcome as the receiving agent sees it. Identifiers
 * and outcome only: the platform attests provenance through `source: "event"`;
 * the included agent output is data, not instructions.
 */
export interface OutcomeEvent {
  /** The source session's own event id for the terminal `turn.*` event. */
  id: string;
  type: OutcomeEventType;
  sessionId: string;
  turnId: string;
  agentId: string;
  occurredAt: string;
  /** Why a turn failed or was cancelled, when the source recorded a reason. */
  reason?: string;
  /** The failure message, bounded, when the turn failed. */
  error?: string;
  /** The final assistant message of a completed turn, bounded to OUTCOME_RESULT_TEXT_LIMIT. */
  result?: { text: string; truncated: boolean };
  /** `question` when a completed turn ended by asking; `question` then names what it asked. */
  outcome?: TurnOutcome;
  question?: Omit<SessionQuestion, "askedAt">;
  /** The source session's labels when the event is delivered; absent when it has none. */
  labels?: SessionLabels;
}

export type OutcomeDestination = { type: "session"; sessionId: string };

/**
 * Where a custom tool ran, as the host knows it: the project, environment,
 * canonical agent, the deployment pinned to the session, the session, the
 * admitted turn, the assistant message that emitted the call and the host's
 * logical call id. Assigned from session, deployment and turn state, never from the
 * prompt, the session's input or the model's tool arguments; a same-named
 * field in those is data. The same tuple is on the tool's execution
 * context, on every `tool.*` event of the call and on the result record.
 */
export interface ToolInvocationIdentity {
  readonly projectId: string;
  readonly environment: MemoryEnvironment;
  readonly agentId: string;
  readonly deploymentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly messageId: string;
  /** Host-assigned logical call id. This is the durable idempotency identity. */
  readonly toolCallId: string;
  /** The provider/model's call label. This is application data, not authority. */
  readonly providerCallId: string;
}

/** The part of a tool call's identity that is fixed for the session's life. */
export type SessionIdentity = Pick<
  ToolInvocationIdentity,
  "projectId" | "environment" | "agentId" | "deploymentId" | "sessionId"
>;

/** A result tool's committed `data` is at most this many bytes of JSON. */
export const SESSION_RESULT_DATA_LIMIT = 8 * 1024;

/**
 * The session's typed result: the latest committed output of the agent's
 * result tool, with the turn and call that reported it. A later committed
 * call replaces it; a failed or cancelled turn never clears it. It says what
 * the agent reported, not that the work succeeded.
 */
export interface SessionResult {
  turnId: string;
  callId: string;
  reportedAt: string;
  data: JsonValue;
  /** The host-assigned identity of the call that committed it; absent on results committed before it was recorded. */
  identity?: ToolInvocationIdentity;
}

/**
 * Which runtime is committing, so a commit from a runtime the session no
 * longer drives (a replayed loop after an eviction, a MicroVM the session
 * has replaced) is refused. MicroVM runtimes carry the epoch of their
 * attachment; the Workerd host carries the activation it reported when the
 * turn started.
 */
export type RuntimeGeneration =
  | { kind: "microvm"; epoch: number }
  | { kind: "workerd"; bootId: string; activation: number };

export interface ResultCommitInput {
  turnId: string;
  callId: string;
  tool: string;
  runtime: RuntimeGeneration;
  data: JsonValue;
  /** The assistant message that emitted the call, as the runtime host saw it. */
  messageId?: string;
}

/** The persisted receipt for one `(turnId, callId)`; a replay returns it unchanged. */
export interface ResultCommitReceipt {
  turnId: string;
  callId: string;
  reportedAt: string;
  eventId: string;
}

export type ResultCommitRejection =
  /** The turn is not the running one: it settled, was cancelled or never existed here. */
  | "stale_turn"
  /** The committing runtime is not the one driving the session. */
  | "stale_runtime"
  /** A receipt exists for this call with different data. */
  | "result_conflict"
  /** `data` exceeds SESSION_RESULT_DATA_LIMIT. */
  | "result_too_large";

export type ResultCommitOutcome =
  | { status: "committed"; replayed: boolean; receipt: ResultCommitReceipt }
  | { status: "rejected"; reason: ResultCommitRejection; message: string };

/**
 * A project- and environment-scoped selection of turn outcomes and where
 * they are delivered. The environment is the destination session's; a
 * source session matches only in its own recorded environment.
 */
export interface EventSubscription {
  id: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  /** Exact source agent id; absent selects every agent in the project. */
  agentId?: string;
  /**
   * Label pairs the source session must carry, every one of them, read when
   * the source turn is admitted; absent selects regardless of labels.
   */
  sourceLabels?: SessionLabels;
  events: OutcomeEventType[];
  destination: OutcomeDestination;
  createdBy: string;
  createdAt: string;
}

/** One event's delivery to one subscription, as the source session records it. */
export interface TurnOutcomeDelivery {
  /** `${subscriptionId}:${eventId}`, also the target turn's idempotency key. */
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: OutcomeEventType;
  destination: OutcomeDestination;
  status: "pending" | "delivered" | "failed";
  attempt: number;
  /** The admitted target turn, recorded on the first successful admission and returned unchanged for a duplicate. */
  receipt?: { sessionId: string; turnId: string };
  nextAttemptAt?: string;
  error?: string;
  updatedAt: string;
}

export type MicrovmLifecycleState =
  | "running"
  | "suspending"
  | "suspended"
  | "resuming"
  | "terminated";

export type TurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * `interrupt` (and a session Stop) cancels the running turn and stops the
 * agent's model loop before the next turn starts. It does not cancel a
 * computer command the loop already dispatched to the sandbox and does not
 * undo that command's effects: the command runs to completion or to its
 * own timeout. The session's `runtime.log` event with phase
 * `workerd_interrupt` says the same when the runtime acknowledges.
 */
export type TurnInputMode = "queue" | "steer" | "interrupt";

export type AgentEventType =
  | "session.created"
  | "session.status_changed"
  | "runtime.connected"
  | "runtime.disconnected"
  | "runtime.suspended"
  | "runtime.resumed"
  | "turn.queued"
  | "turn.steered"
  | "turn.interrupted"
  | "turn.started"
  | "message.received"
  | "message.delta"
  | "message.completed"
  | "reasoning.delta"
  | "reasoning.completed"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"
  | "model.route_resolved"
  | "model.access_fallback"
  | "usage.recorded"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "session.failed"
  | "runtime.log"
  | "agent.rendered"
  /** A memory save the host observed succeed: `{ resource, documentId, revision, bytes }` (work 026, C7; best-effort). */
  | "memory.saved"
  | "egress.request"
  | "egress.response"
  | "egress.failed"
  /** Workspace export lifecycle: `{ exportId, path, [artifactId, bytes, sha256], [error] }`; never contents or a download capability. */
  | "artifact.export.started"
  | "artifact.export.delivered"
  | "artifact.export.failed"
  /** The turn ended by asking: `{ questionId, text, options }`. The turn's own terminal event is `turn.completed` with `{ outcome: "question", questionId }`. */
  | "question.asked"
  /**
   * The turn ended by consulting a sibling agent: `{ questionId, agent }`,
   * where `agent` is the member the model named. The question it committed
   * is the same kind `ask` commits; `agent.consult.*` events carry which
   * member answered it. The turn's own terminal event is `turn.completed`
   * with `{ outcome: "question", questionId }`.
   */
  | "agent.consult.requested"
  /** A consult's member turn settled and its answer was admitted: `{ questionId, memberAgentId, memberSessionId, memberTurnId, outcome }`. */
  | "agent.consult.answered"
  /** A consult could not reach or run the member agent: `{ questionId, agent, error }`; the failure is delivered as the answer. */
  | "agent.consult.failed"
  /** An input named the open question: `{ questionId, answer: QuestionAnswer }`, on the answering turn. */
  | "question.answered"
  /** The question ended without an answer: `{ questionId, reason: QuestionClosedReason }`. */
  | "question.closed"
  /**
   * An input was held behind the open question (no turn of its own yet):
   * `{ heldId, questionId, input, payload?, receivedAt, providerTime?, turnId? }`;
   * `turnId` names the queued turn it was converted from. Session-level (no
   * event `turnId`). A repeated key appends nothing.
   */
  | "message.held"
  /**
   * A held input was delivered: `{ questionId, heldId, answerTurnId, turnId,
   * as }`. `as` is `steering` (in the answering turn's `steering`), `answer`
   * (it was the answer, after reclassification) or `turn` (it runs as its
   * own turn: steering overflow, a dismissed or undeliverable question, or a
   * reply written after the elicitation). `answerTurnId` and `turnId` both
   * name the turn that carried it. Session-level.
   */
  | "message.delivered"
  /** A held input was dropped: `{ heldId, questionId, reason: "stopped" | "ended" }`. Session-level. */
  | "message.discarded"
  /**
   * A channel activity Linear was not told (yet): `{ channel: "linear",
   * activityId, agentSessionId, kind: "progress" | "terminal", contentType,
   * state: "failed_transient" | "failed_permanent" | "invalidated" |
   * "dropped", attempts, error, turnId?, questionId?, retrying? }`. Session-
   * level. `error` is a fixed code, never the provider's message:
   * `provider_unavailable` (not taken yet; `retrying: true` while it still
   * retries), `provider_rejected`, `connection_<not_found|pending|
   * disconnected|revoked>`, `session_superseded`. No tokens, no content.
   */
  | "delivery.failed"
  | "session.ended";

export interface AgentEvent {
  id: string;
  seq: number;
  timestamp: string;
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  accountId: string;
  agentId: string;
  deploymentId: string;
  sessionId: string;
  turnId?: string;
  type: AgentEventType;
  data: Record<string, unknown>;
}

/** A session's memory binding as inspection reports it: the binding plus whether a save can commit now. */
export type SessionMemoryBinding = MemoryBinding & { writable: boolean };

/** Where the Session DO stands with the Memory DO for its bindings (product note, grants and closure). */
export type MemoryAdmissionState =
  | { state: "issued" }
  | { state: "pending"; error?: string }
  | { state: "rejected"; reason: string; resource?: string; id?: string };

/**
 * Application metadata on a session: at most 16 keys, key
 * `^[a-z][a-z0-9_.-]{0,63}$`, value at most 256 characters, 4 KB in total.
 * Not authorization, not searched beyond equality filters, never shown to
 * the agent.
 */
export type SessionLabels = Record<string, string>;

/**
 * The turn work a list row summarizes without carrying the turns: the
 * running turn, how many wait behind it, and the most recently settled one.
 */
export interface SessionActivity {
  activeTurnId: string | null;
  queued: number;
  lastSettledTurn: { id: string; status: TurnStatus; at: string } | null;
}

/**
 * One list row, as the Account object's projection holds it. No turns and
 * no memory: `GET /sessions/<id>` keeps those.
 */
export interface SessionSummary {
  id: string;
  projectId: string;
  agentId: string;
  deploymentId: string;
  environment: MemoryEnvironment | null;
  source: SessionSource;
  status: SessionStatus;
  labels: SessionLabels;
  createdAt: string;
  updatedAt: string;
  /** Monotonic per session; the projection accepts a row only when it is newer than the one it holds. */
  revision: number;
  activity: SessionActivity;
  result: SessionResult | null;
}

/** What a Session object delivers to the Account object's projection. */
export interface SessionPublication {
  sessionId: string;
  revision: number;
  row: SessionSummary;
  /** Internal analytics projection; absent publications remain countable. */
  countability?: {
    countable: boolean;
    exclusionReason: "model_credit_exhausted" | null;
    outcomeAt: string | null;
  };
}

/**
 * What the caller asked for when the session was created: the agent target
 * as an `<agent>@<environment>` reference, or the deployment it pinned
 * explicitly. It is the immutable half of a creation's identity under an
 * `Idempotency-Key`; which deployment satisfied it is the platform's choice
 * and may differ from what the same reference resolves to later.
 */
/**
 * How a session was asked for, recorded at its first admission and compared
 * on every replay under the same idempotency key: the alias the caller
 * addressed, or the deployment it pinned. One or the other, never both.
 */
export type SessionCreation =
  | {
      /** `<agent>@<environment>` (a bare id is `production`). */
      agent: string;
      deploymentId?: never;
    }
  | {
      /** The deployment id the caller pinned explicitly. */
      deploymentId: string;
      agent?: never;
    };

export interface SessionSnapshot {
  id: string;
  accountId: string;
  userId: string;
  agentId: string;
  deploymentId: string;
  /** The project the agent belonged to at creation; `project:<agentId>` when it had none. */
  projectId: string;
  executionMode: SessionExecutionMode;
  source?: SessionSource;
  status: SessionStatus;
  labels: SessionLabels;
  labelsUpdatedAt?: string;
  revision: number;
  /** The latest committed output of the result tool, or null when no turn has reported one. */
  result: SessionResult | null;
  /** The open question, or null (also on sessions that never asked). Independent of `result`. */
  question: SessionQuestion | null;
  runtimeId?: string;
  runtimeEpoch: number;
  microvmId?: string;
  microvmState?: MicrovmLifecycleState;
  createdAt: string;
  updatedAt: string;
  /**
   * The environment the session was created in, resolved from the request
   * (the alias in `agent@alias`, or the environment named next to a pinned
   * `deploymentId`), never from the deployment row's original alias. Absent
   * when the request named neither.
   */
  environment?: MemoryEnvironment;
  /** The Memory DO name (`memoryObjectName`) the bindings were admitted against. Present only with bindings. */
  memoryObject?: string;
  /** Present only for sessions created with memory bindings. */
  memory?: SessionMemoryBinding[];
  /**
   * The caller's creation intent, recorded at first admission so a replay of
   * the same `Idempotency-Key` compares what was asked, not what the alias
   * resolves to now. Absent on sessions created before it was recorded.
   */
  creation?: SessionCreation;
  memoryAdmission?: MemoryAdmissionState;
  /** After end: whether the Memory DO acknowledged the revocation. `pending` is an uncertain outcome. */
  memoryClosure?: "pending" | "acknowledged";
  turns: Array<{
    id: string;
    input: string;
    mode: TurnInputMode;
    status: TurnStatus;
    /** `question` on a completed turn that ended by asking. */
    outcome?: TurnOutcome;
    /**
     * `held` on a cancelled turn that was queued behind a turn that asked:
     * its input was not dropped but waits as steering for the answer to
     * `questionId`, and no outcome is delivered for it.
     */
    reason?: "held";
    questionId?: string;
    createdAt: string;
    updatedAt: string;
    /** Present when the turn's outcome is subscribed to; one entry per subscription. */
    deliveries?: TurnOutcomeDelivery[];
  }>;
}

export interface InitializeSessionInput {
  id: string;
  accountId: string;
  userId: string;
  agentId: string;
  deploymentId: string;
  executionMode?: SessionExecutionMode;
  deployment?: AgentDeployment;
  runtimeEdge?: string;
  workerdLease?: WorkerdSessionLease;
  workerdPoolCheckoutMs?: number;
  /** The environment the caller resolved for the session; required with `memory`. */
  environment?: MemoryEnvironment;
  /** Normalized memory bindings, one per resource; validated against the deployment by the caller. */
  memory?: MemoryBinding[];
  /** The Memory DO name (`memoryObjectName`) the bindings are admitted against. Required with `memory`. */
  memoryObject?: string;
  /** The project the agent belongs to; the row's `projectId`. Defaults to `project:<agentId>`. */
  projectId?: string;
  /** Recorded with the session so its list row can say where it came from. */
  source?: SessionSource;
  /** Validated by the caller with `parseLabels`; applied once at creation. */
  labels?: SessionLabels;
  /** The caller's creation intent; see `SessionSnapshot.creation`. */
  creation?: SessionCreation;
  /**
   * Another session whose `/workspace` this session's computers mount,
   * instead of a workspace of their own. Set only by consult: the inner
   * session a member agent runs on works in the consulting session's
   * files. Host-authored — the runtime relays it verbatim to the platform.
   */
  sharedWorkspaceSessionId?: string;
}

export interface WorkerdSessionLease {
  runtimeSessionId: string;
  opencodeSessionId: string;
  modelGatewayCapabilityId: string;
  createdAt: string;
  runtimeBootId: string;
  runtimeActivation: number;
  runtimeInitMs: number;
}

export interface InitializeSessionResult {
  session: SessionSnapshot;
  runtimeToken: string;
  deployment?: AgentDeployment;
  memoryAdmission?: MemoryAdmissionState;
  /** A claimed prewarm the Session DO deliberately did not bind to this session. */
  unusedWorkerdLease?: boolean;
}

/**
 * What `initialize` answers: the admission this call performed, or the
 * session that already existed or that a concurrent call admitted first.
 * The Session object decides the winner before any side effect, so a
 * caller that loses has created nothing and owns nothing.
 */
export type InitializeSessionOutcome =
  | ({ outcome: "created" } & InitializeSessionResult)
  | { outcome: "existing"; session: SessionSnapshot };

export interface AgentArtifactReference {
  bucket: string;
  key: string;
  digest: string;
  size: number;
}

export interface DeploymentUpload {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  artifact: AgentArtifactReference;
}

export interface CreateDeploymentUploadInput {
  agentId: string;
  digest: string;
  size: number;
  contentType: string;
}

export interface AgentDeployment {
  id: string;
  agentId: string;
  alias: string;
  runtimeMode: DeploymentRuntimeMode;
  region?: DeploymentRegion;
  egress?: DeploymentEgress;
  /** The exit region its sandboxes leave through, from fixed IPs (work 073). */
  fixedIps?: string;
  channels: string[];
  connections: string[];
  httpConnections: HttpConnectionDefinition[];
  githubConnections?: GitHubConnectionDefinition[];
  projectDeployment?: ProjectDeploymentReference;
  /** Memory resources the artifact declares (memory-contract.ts, MemoryDeclaration). */
  memory?: MemoryDeclaration[];
  /** Exact selections admitted from the compiled deployment registry. */
  models?: Array<{ provider: string; model: string }>;
  /** Used only when a render omits useModel(); never an error fallback. */
  defaultModel?: { provider: string; model: string };
  artifact: AgentArtifactReference;
  imageArn: string;
  imageVersion: string;
  createdAt: string;
}

export interface ProjectChannelDefinition {
  id: string;
  type: "slack" | "twilio" | "email";
  displayName?: string;
  scopes: { bot: string[] };
  events: Array<"app_mention" | "message.im">;
  destinations: Record<
    string,
    { type: "conversation"; visibility: "public" | "private" }
  >;
  routing: { whenAmbiguous: "ask" };
}

export interface ProjectResourceManifest {
  version: 1;
  channels: ProjectChannelDefinition[];
  channelRegistrations: Array<{
    agentId: string;
    channelId: string;
    triggers: Array<"mention" | "direct-message" | "message">;
  }>;
  outboxes: Array<{ id: string; channelId: string; destination: string }>;
  outboxRegistrations: Array<{ agentId: string; outboxId: string }>;
  schedules: ProjectScheduleDefinition[];
  /** Ordered schema migrations for the environment's default database. */
  database?: {
    migrations: Array<{ name: string; checksum: string; sql: string }>;
  };
  /**
   * Tools whose write waits for a human. Listed here as well as in the agent's
   * own manifest because the platform authorizes a proposal before any agent
   * code is involved. Optional: deployments built before gated tools existed
   * do not carry it.
   */
  gatedTools?: Array<{ agentId: string; toolId: string }>;
}

export interface ProjectScheduleDefinition {
  id: string;
  agentId: string;
  cron: string;
  timezone: string;
  enabled: ProjectEnvironmentName[];
  overlap: "skip" | "allow";
  dispatch: {
    text?: string;
    payload?: AgentInputValue;
  };
}

export interface ProjectSchedule {
  id: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId: string;
  deploymentId: string;
  cron: string;
  timezone: string;
  overlap: "skip" | "allow";
  dispatch: { text?: string; payload?: AgentInputValue };
  nextRunAt: string;
  lastRunAt?: string;
  status: "active" | "manual" | "paused";
}

export interface ProjectScheduleRun {
  id: string;
  scheduleId: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  deploymentId: string;
  scheduledAt: string;
  manual: boolean;
  attempt: number;
  outcome: "pending" | "enacted" | "skipped" | "failed";
  sessionId?: string;
  error?: string;
  createdAt: string;
}

export interface ProjectDeploymentReference {
  id: string;
  digest: string;
  localAgentId: string;
  agents: Array<{ localId: string; agentId: string; artifactDigest: string }>;
  resources: ProjectResourceManifest;
}

export interface SecretHeaderReference {
  kind: "secret";
  name: string;
  /**
   * Where the value comes from. Absent means the project's own secret, one
   * value for the whole deployment. `"tenant"` resolves the value recorded
   * against the channel installation the session belongs to, so a deployment
   * answering many workspaces uses each workspace's own credential. `"user"`
   * narrows it again to the person being acted for.
   */
  scope?: "tenant" | "user";
  prefix?: string;
  suffix?: string;
}

export interface HttpConnectionDefinition {
  id: string;
  origin: string;
  headers: Record<string, string | SecretHeaderReference>;
  methods?: string[];
  pathPrefix?: string;
  redirectOrigins?: HttpConnectionRedirectOrigin[];
}

export interface HttpConnectionRedirectOrigin {
  origin: string;
  pathPrefix?: string;
}

/**
 * A secret belonging to one channel installation, described without its value.
 * The value is write-only: it goes in through the installation API and comes
 * out only as an egress header the runtime never sees.
 */
export interface InstallationSecretMetadata {
  name: string;
  allowedOrigins: string[];
  createdAt: string;
  updatedAt: string;
}

export type GitHubAppPermission = "read" | "write";

export interface GitHubConnectionDefinition {
  id: string;
  provider: {
    kind: "github-app";
    permissions: Record<string, GitHubAppPermission>;
  };
}

export type LinearConnectionStatus =
  | "pending"
  | "connected"
  | "disconnected"
  | "revoked";

/** A Linear agent connection as the routes return it; never its credentials. */
export interface LinearConnection {
  id: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId: string;
  /** The app's name in Linear; also the agent's name there. */
  name: string;
  status: LinearConnectionStatus;
  /** Set once the app's credentials are pasted. */
  clientId?: string;
  /** Set on authorization: the app user and the workspace. */
  appUserId?: string;
  organizationId?: string;
  /**
   * The webhook URL the app must deliver to, and Linear's prefilled
   * create-app page carrying it. Present only on views that decrypted the
   * webhook token (create and list); a view without them never shows a
   * placeholder, so no unusable URL can be copied into Linear.
   */
  webhookUrl?: string;
  createAppUrl?: string;
  verifiedAt?: string;
  verificationError?: string;
  lastEventAt?: string;
  /** Teams the app can see, from the last permission change. */
  teams?: { allPublic: boolean; teamIds: string[] };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLinearConnectionInput {
  name: string;
  environment: ProjectEnvironmentName;
  agentId: string;
}

export interface CreateLinearConnectionResult {
  connectionId: string;
  webhookUrl: string;
  createAppUrl: string;
}

export interface LinearConnectionCredentialsInput {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

export type GitHubInstallationState =
  | "active"
  | "suspended"
  | "deleted";

export interface GitHubInstallation {
  id: string;
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  state: GitHubInstallationState;
  createdAt: string;
  updatedAt: string;
}

/** A credential belonging to one person on one installation, without its value. */
export interface UserSecretMetadata {
  externalUserId: string;
  name: string;
  allowedOrigins: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GitHubConnectionStatus {
  environment: ProjectEnvironmentName;
  state: "not_connected" | GitHubInstallationState;
  installation?: GitHubInstallation;
}

/**
 * What minting an installation token for a project environment came to.
 * A value rather than a thrown error so the reason crosses the Durable
 * Object RPC boundary intact. `code` values are the GitHub client's
 * `GitHubMintErrorCode`.
 */
export type GitHubTokenMint =
  | { outcome: "minted"; token: string; expiresAt: string }
  | { outcome: "not_connected" }
  | { outcome: "app_not_configured" }
  | {
      outcome: "failed";
      code: string;
      message: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    };

export interface ManagedSecretMetadata {
  name: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId?: string;
  allowedOrigins: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuntimeVariableMetadata {
  name: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWebhook {
  id: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId: string;
  name: string;
  enabled: boolean;
  /** Delivery identity source, `header:<name>` or `body:<json-pointer>`; unset means Idempotency-Key only. */
  identity?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastInvokedAt?: string;
}

export interface CreatedProjectWebhook extends ProjectWebhook {
  /** Returned once. Only a hash is retained by the service. */
  token: string;
}

export interface ProjectWebhookRequest {
  id: string;
  webhookId: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId: string;
  deploymentId?: string;
  sessionId?: string;
  outcome: "pending" | "accepted" | "failed";
  error?: string;
  /** Enactment attempts so far; 0 while the first attempt is pending. */
  attempt?: number;
  /** A `failed` request no retry can change; a same-identity retry echoes it. */
  terminal?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentLogEntry {
  id: string;
  cursor: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId: string;
  deploymentId: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface AgentSummary {
  id: string;
  name: string;
  /** Null until the agent has been deployed at least once. */
  activeDeploymentId: string | null;
  activeAlias: string | null;
  deploymentCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The canonical scope key of an environment-scoped record. `default` is the
 * one scope of a single-mode project; `development` and `production` belong
 * to legacy dual-environment projects. Which names a project accepts is
 * decided by its `environmentMode`, never by the caller.
 */
export type ProjectEnvironmentName = "default" | "development" | "production";

/**
 * A project's immutable lifecycle mode. `legacy` projects keep Development and
 * Production; `single` projects have one active project deployment and one
 * set of scoped resources under the `default` key.
 */
export type ProjectEnvironmentMode = "single" | "legacy";

export interface ProjectEnvironment {
  name: ProjectEnvironmentName;
  activeDeploymentId?: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  agentId: string;
  environmentMode: ProjectEnvironmentMode;
  environments: ProjectEnvironment[];
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  /** Omitted: the platform's current default for new projects. */
  environmentMode?: ProjectEnvironmentMode;
}

export interface ProjectAccessToken {
  id: string;
  projectId: string;
  name: string;
  environment: ProjectEnvironmentName;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface CreatedProjectAccessToken extends ProjectAccessToken {
  /** Returned once. Only a hash is retained by the service. */
  token: string;
}

export interface SharedFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  sessionId?: string;
}

/**
 * The manifest of one workspace file the provider retained from `/workspace`.
 * It carries what a receiver needs to verify a delivery, never the bytes.
 */
export interface WorkspaceArtifact {
  id: string;
  /** The export that first retained these bytes; later exports of the same snapshot point at the same artifact. */
  exportId: string;
  sessionId: string;
  projectId: string;
  agentId: string;
  deploymentId: string;
  environment: string | null;
  path: string;
  size: number;
  sha256: string;
  /** Content type the store recorded for the source: metadata, not proof of what the bytes are. */
  mediaType: string;
  /** Identity of the source snapshot that was hashed and retained (version id, else ETag). */
  snapshotId: string;
  /** Storage identity of the retained copy; a repeated export of unchanged bytes returns the same artifact. */
  receipt: {
    bucket: string;
    key: string;
    etag: string | null;
    sourceEtag: string | null;
    sourceVersionId: string | null;
  };
  /** Manifests and bytes outlive the session and are kept until the account deletes them; no expiry is scheduled. */
  retention: { policy: "until_deleted"; expiresAt: null };
  exportedAt: string;
}

/**
 * One export request. The provider snapshots and retains synchronously, so
 * an export is `snapshotting` only while its request is in flight; every
 * other state is terminal and never changes afterwards.
 */
export type WorkspaceExportState =
  | "snapshotting"
  | "delivered"
  | "failed"
  | "expired";

export interface WorkspaceExport {
  id: string;
  sessionId: string;
  projectId: string;
  agentId: string;
  deploymentId: string;
  environment: string | null;
  path: string;
  state: WorkspaceExportState;
  /** The caller's `Idempotency-Key`, when one was sent. */
  idempotencyKey: string | null;
  /** SHA-256 of the canonical request; a reused key with another digest is a conflict. */
  requestDigest: string;
  expected: { bytes?: number; sha256?: string; mediaType?: string } | null;
  artifactId: string | null;
  /** Why a terminal export did not deliver, and whether the same key may be retried. */
  error: { code: string; message: string; retrySafe: boolean } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentSchema {
  projectId: string;
  version: number;
  agents: Array<{
    name: string;
    description?: string;
    tools: string[];
    connections: string[];
  }>;
  updatedAt: string;
}

export interface ProjectOverview {
  project: Project;
  sessions: SessionSummary[];
  deployments: AgentDeployment[];
  accessTokens: ProjectAccessToken[];
  connections: Connection[];
  channels: SlackConnection[];
  schedules: ProjectSchedule[];
  schema: AgentSchema;
}

export interface SessionDataEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface SessionSecretReference {
  name: string;
  /**
   * `tenant` means the value came from this session's channel installation;
   * `user` from the person it is acting for.
   */
  source: "project" | "session" | "tenant" | "user";
  createdAt: string;
}

export interface SessionResources {
  files: SharedFile[];
  data: SessionDataEntry[];
  secrets: SessionSecretReference[];
}

export interface SessionAgentRender {
  renderId: string;
  responseId: string;
  providerTurn: number;
  stateVersion: number;
  instructionsHash: string;
  instructions: string;
  enabledTools: string[];
  requiredConnections: string[];
  enabledMcpServers: string[];
  input: { source: string; text?: string };
  tools: Array<{ name: string; description: string }>;
  model?: { provider: string; model: string };
  renderedAt: string;
}

export interface ManagedAgentTemplate {
  id: string;
  name: string;
  description: string;
  category:
    | "Comms"
    | "Coding"
    | "Operations"
    | "Admin"
    | "Growth"
    | "Insights";
  integrations: string[];
  suggestedPrompts: string[];
}

export interface ManagedAgentIdentity {
  userId: string;
  accountId: string;
  organizationId?: string;
  role?: string;
}

export interface RegisterDeploymentInput {
  agentId: string;
  name?: string;
  alias: string;
  runtimeMode?: DeploymentRuntimeMode;
  region?: DeploymentRegion;
  egress?: DeploymentEgress;
  /** The exit region for fixed IPs (work 073); absent leaves Modal's own IPs. */
  fixedIps?: string;
  channels?: string[];
  connections?: string[];
  httpConnections?: HttpConnectionDefinition[];
  githubConnections?: GitHubConnectionDefinition[];
  projectDeployment?: ProjectDeploymentReference;
  /** Memory declarations from the artifact manifest; applied to the environment on promotion. */
  memory?: MemoryDeclaration[];
  models?: Array<{ provider: string; model: string }>;
  defaultModel?: { provider: string; model: string };
  /** The registering account; names the Memory DO a promotion configures. Absent: no memory activation. */
  accountId?: string;
  artifact: AgentArtifactReference;
  imageArn?: string;
  imageVersion?: string;
}

export type ChannelConnectionStatus =
  | "pending"
  | "connected"
  | "expired"
  | "disconnected"
  | "failed";

export interface SlackConnection {
  id: string;
  channelId: string;
  agentId: string;
  alias: string;
  appName?: string;
  appId?: string;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  verifiedAt?: string;
  verificationError?: "signing_secret_mismatch";
  lastEventAt?: string;
  lastDelivery?: { status: "delivered" | "failed"; at: string };
  lastError?: { category: string; at: string };
  status: ChannelConnectionStatus;
  createdAt: string;
  updatedAt: string;
  destinations?: Array<{
    name: string;
    conversationId: string;
    displayName: string;
    verifiedAt: string;
  }>;
}

export interface CreateSlackConnectionInput {
  agentId: string;
  channelId?: string;
  name?: string;
  reconnect?: boolean;
}

export interface CreateSlackConnectionResult {
  connection: SlackConnection;
  manifest: Record<string, unknown>;
  createUrl: string;
  steps: string[];
}

export interface CompleteSlackConnectionInput {
  botToken: string;
  appId?: string;
  signingSecret?: string;
}

/**
 * Where an automated Slack setup stands. Persisted literals; the setup is a
 * record beside the connection, not a connection status.
 */
export type SlackSetupPhase =
  | "prepared"
  | "creating"
  | "creation_uncertain"
  | "app_created"
  | "exchanging"
  | "connected"
  | "cancelled";

/** What the caller may do next with a setup in its current phase. */
export type SlackSetupAction = "create" | "authorize" | "manual" | "cancel";

export type SlackSetupErrorCode =
  | "slack_configuration_token_invalid"
  | "slack_configuration_token_expired"
  | "slack_manifest_rejected"
  | "slack_app_limit_reached"
  | "slack_rate_limited"
  | "slack_provider_unavailable"
  | "slack_creation_uncertain"
  | "slack_exchange_uncertain"
  | "slack_exchange_failed"
  | "slack_authorization_denied"
  | "slack_authorization_expired"
  | "slack_app_mismatch"
  | "slack_workspace_mismatch"
  | "slack_scope_missing"
  | "slack_enterprise_install_unsupported"
  | "slack_setup_superseded"
  | "slack_setup_cancelled";

export interface SlackSetupError {
  code: SlackSetupErrorCode;
  message: string;
  /** Whether correcting input and trying the same setup again can succeed. */
  recoverable: boolean;
  retryAfterMs?: number;
  /** JSON pointer into the submitted manifest, when Slack rejected it. */
  pointer?: string;
  at: string;
}

/**
 * The redacted view of a setup: progress, external identity and permitted
 * next actions. Never the configuration token, client secret, signing secret
 * or bot token.
 */
export interface SlackSetup {
  id: string;
  requestKey: string;
  projectId: string;
  agentId: string;
  alias: string;
  channelId: string;
  name: string;
  connectionId: string;
  phase: SlackSetupPhase;
  app?: { id: string; name: string };
  workspace?: { id: string; name?: string };
  botUserId?: string;
  error?: SlackSetupError;
  actions: SlackSetupAction[];
  createdAt: string;
  updatedAt: string;
}

/** The outcome a callback redirect carries back to the dashboard. */
export type SlackSetupResult =
  | "connected"
  | "authorization_denied"
  | "authorization_expired"
  | "exchange_failed"
  | "app_mismatch"
  | "workspace_mismatch"
  | "scope_missing"
  | "enterprise_install_unsupported"
  | "superseded"
  | "provider_unavailable";

export type ConnectionKind = "channel" | "tool";

export interface Connection {
  id: string;
  kind: ConnectionKind;
  provider: string;
  label: string;
  ownerUserId: string;
  agentId: string;
  alias: string;
  externalAccountId?: string;
  displayName?: string;
  scopes: string[];
  status: ChannelConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

/** An account-owned OAuth connection explicitly made available to a project. */
export interface ProjectServiceAttachment {
  projectId: string;
  service: string;
  provider: string;
  label: string;
  connectionId: string;
  connection: Connection;
  createdAt: string;
  updatedAt: string;
}

/**
 * Who a computer grant is for (work 080): one Slack thread
 * (`subject` = its session key), one Slack user (`subject` = their Slack user id),
 * or everyone on the organization's computer (`subject` = "").
 */
export type ComputerGrantScope = "session" | "user" | "everyone";

/** An account-owned OAuth connection granted to the organization's computer. */
export interface ComputerServiceAttachment {
  service: string;
  provider: string;
  label: string;
  connectionId: string;
  connection: Connection;
  scope: ComputerGrantScope;
  subject: string;
  /** The OpenComputer user (dashboard) or Slack user (Slack) who granted it. */
  grantedBy: string;
  createdAt: string;
  updatedAt: string;
}

// ── Model access (work 011) ─────────────────────────────────────────────────
// Organization-owned Claude/Codex subscription connections. Tokens are never
// part of these public shapes.

export type ModelAccessProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "openai_compatible";

export type ModelAccessConnectionKind =
  | "claude_subscription"
  | "codex_subscription"
  | "openrouter_api_key"
  | "openai_compatible_api";

export type ModelGatewayProtocol =
  | "anthropic_messages"
  | "chat_completions"
  | "responses";

export type ModelAccessConnectionStatus =
  | "connecting"
  | "connected"
  | "reauth_required"
  | "provider_limited"
  | "plan_ineligible"
  | "revoked"
  | "unavailable";

export interface ModelAccessConnection {
  id: string;
  organizationId: string;
  connectedByUserId: string;
  provider: ModelAccessProvider;
  kind: ModelAccessConnectionKind;
  label: string;
  baseUrl?: string;
  externalAccountHint?: string;
  status: ModelAccessConnectionStatus;
  entitlementSnapshot?: unknown;
  checkedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelAccessBinding {
  organizationId: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  provider: ModelAccessProvider;
  connectionId: string;
  enabled: boolean;
  enabledByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRoute {
  id: string;
  organizationId: string;
  projectId: string;
  environment: ProjectEnvironmentName;
  agentId?: string;
  connectionId: string;
  model: string;
  fallback: "fail" | "managed";
  revision: number;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartConnectionInput {
  provider: string;
  agentId: string;
  label?: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge: string;
}

export interface StartConnectionResult {
  connection: Connection;
  authorizationUrl: string;
  state: string;
}

export interface CompleteConnectionInput {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface ConnectionRequestInput {
  service: string;
  label?: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ConnectionRequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ManagedConnectionLink {
  connectionId: string;
  service: string;
  label: string;
  toolkit: string;
  scopes: string[];
  status: "connected" | "pending";
  connectedAccountId?: string;
  authorizationUrl?: string;
  expiresAt?: string;
}

export interface SlackTurnDelivery {
  connectionId: string;
  channelId: string;
  externalUserId: string;
  threadTimestamp: string;
}

export interface SessionConnectionRequestInput {
  service: string;
  label?: string;
  newAccount?: boolean;
}

export interface EnqueueTurnInput {
  input: string;
  agentInput?: StructuredAgentInput;
  idempotencyKey: string;
  mode?: TurnInputMode;
  /**
   * The id of the question this input answers. Naming any question but the
   * open one is `409 question_stale`. Without it, an input that arrives while
   * a question is open is held and delivered with the answer as `steering`,
   * unless the question was shown on a channel that does not hold (Slack):
   * then the input runs as an ordinary turn and the question stays open.
   * Part of the idempotency key's fingerprint.
   */
  answers?: string;
  /**
   * Internal: the provider's time for this input (Linear's prompt
   * `createdAt`). With it and without `answers`, the Session object decides
   * answer versus steering by comparing it with the provider time of the
   * question's elicitation, never by arrival order. Not consulted for a
   * question on a channel that does not hold.
   */
  providerTime?: string;
}

export interface EnqueueTurnResult {
  turnId: string;
  status: TurnStatus;
  duplicate: boolean;
}

/**
 * The receipt of an input that arrived while the session's question was
 * open and did not answer it (design 018): it runs no turn of its own yet.
 * `held` until the question is resolved; it is then delivered with the
 * answering turn as `steering`, as the answer itself, or as an ordinary
 * turn, and a replay of its key returns that turn's receipt. `discarded`
 * once a stop or the session's end discarded it.
 */
export interface HeldTurnReceipt {
  status: "held" | "discarded";
  /** The question that was open when the input arrived. */
  questionId: string;
  /** The held input, as `message.held`, `message.delivered` and `message.discarded` name it. */
  heldId: string;
  duplicate: boolean;
}

/** What turn admission answers: a turn, or an input held behind the open question. */
export type TurnReceipt = EnqueueTurnResult | HeldTurnReceipt;

export interface BindMicrovmInput {
  microvmId: string;
  state: MicrovmLifecycleState;
}

export type RuntimeBillingResourceTier = "2gb_1vcpu";

export interface RuntimeBillingSegment {
  id: string;
  accountId: string;
  sessionId: string;
  deploymentId: string;
  agentId: string;
  microvmId: string;
  resourceTier: RuntimeBillingResourceTier;
  startedAt: string;
  endedAt: string;
  quantitySeconds: number;
  closeReason:
    | "suspended"
    | "terminated"
    | "session_ended"
    | "heartbeat_expired"
    | "turn_settled";
}

export interface RuntimeEventInput {
  type: AgentEventType;
  data?: Record<string, unknown>;
}

export type RuntimeToSessionFrame =
  | {
      type: "runtime.ready";
      epoch: number;
    }
  | {
      type: "runtime.heartbeat";
      epoch: number;
    }
  | {
      type: "model.configuration.request";
      epoch: number;
    }
  | {
      type: "turn.accepted";
      epoch: number;
      turnId: string;
    }
  | {
      type: "event.batch";
      epoch: number;
      frameId: string;
      turnId: string;
      events: RuntimeEventInput[];
    }
  | {
      /** The outcome of a `tool.apply`. Not a turn: no model was involved. */
      type: "tool.applied";
      epoch: number;
      applyId: string;
      ok: boolean;
      result?: AgentInputValue;
      message?: string;
    };

export type SessionToRuntimeFrame =
  | {
      type: "runtime.welcome";
      protocolVersion: typeof AGENT_PROTOCOL_VERSION;
      sessionId: string;
      runtimeId: string;
      epoch: number;
    }
  | {
      type: "turn.start";
      turnId: string;
      input: string;
      agentInput: StructuredAgentInput;
      /** The session's host-assigned identity; the runtime completes it per tool call. */
      identity?: SessionIdentity;
    }
  | {
      type: "turn.steer";
      turnId: string;
      input: string;
      activeTurnId: string;
    }
  | {
      type: "turn.cancel";
      turnId: string;
    }
  | {
      /**
       * Run a gated tool's `apply`, because a human approved it.
       *
       * Deliberately not a turn: the arguments are the ones that were on the
       * card, and no model runs in between. A second pass through the model
       * could produce something the person never agreed to.
       */
      type: "tool.apply";
      applyId: string;
      toolId: string;
      input: AgentInputValue;
      decision: { id: string; decidedAt: string; decidedBy?: string };
      /**
       * The write's host identity: the session, the turn that proposed it and
       * the approval as both message and call (no model message stands
       * behind an approved write).
       */
      identity?: ToolInvocationIdentity;
    }
  | {
      type: "model.configuration";
      provider: "openrouter";
      model: string;
    };

export type ClientToSessionFrame =
  | {
      type: "ping";
    }
  | {
      type: "turn.create";
      input: string;
      idempotencyKey: string;
      mode?: TurnInputMode;
    };

export type SessionToClientFrame =
  | {
      type: "ready";
      sessionId: string;
      cursor: number;
    }
  | {
      type: "event";
      event: AgentEvent;
    }
  | {
      type: "pong";
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export interface RuntimeConnectionAttachment {
  role: "runtime";
  runtimeId: string;
  epoch: number;
}

export interface ClientConnectionAttachment {
  role: "client";
  connectionId: string;
}

export type ConnectionAttachment =
  | RuntimeConnectionAttachment
  | ClientConnectionAttachment;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
