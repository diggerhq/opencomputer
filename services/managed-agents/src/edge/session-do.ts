import { DurableObject } from "cloudflare:workers";
import type { SessionControlInput, SessionControlResult } from "./linear-contract.js";
import { STRUCTURED_INPUT_LIMIT, turnFingerprint } from "./structured-input.js";
import { environmentOfMode, isProjectEnvironmentName } from "./project-scope.js";
import { enqueueLinearActivity, LINEAR_STOPPED_TEXT } from "./linear-activities.js";
import { isAskInput, questionIdFor } from "../ask.js";
import {
  AGENT_RUNTIME_RESOURCE_TIER,
  agentRuntimeUsageRetryAt,
  postAgentRuntimeUsage,
} from "./runtime-usage.js";
import {
  QUESTION_STALE,
  answerQuestion,
  classifyAdmission,
  closeOpenQuestion,
  commitQuestion,
  discardHeldInputs,
  ensureQuestionSchema,
  heldAnswerCandidate,
  heldEventData,
  heldInputOf,
  heldReceipt,
  holdInput,
  markHeldDelivered,
  openQuestion,
  openQuestionInput,
  outcomeEventQuestionFields,
  pendingHeld,
  questionById,
  questionInputFields,
  questionOptions,
  recordControl,
  recordedControl,
  markQuestionTextGate,
  recordQuestionChannelMessage,
  recordQuestionProviderTime,
  snapshotQuestion,
  splitSteering,
  type PendingHeld,
  type QuestionRow,
} from "./questions.js";

import {
  SlackProgress,
  truncateSlackStatus,
  type SlackProgressStream,
} from "../channels/slack-progress.js";
import { LinearActivityQueue, linearBinding, linearQueueDrained } from "./linear-activities.js";
import { channelAdapter } from "../channels/registry.js";
import {
  retryAfterFromMessage,
  type QuestionCard,
  type QuestionMode,
} from "../channels/adapter.js";
import { questionMarkdown, slackTimestampIso } from "../channels/slack-adapter.js";
import {
  AGENT_PROTOCOL_VERSION,
  type AgentEvent,
  type AgentEventType,
  type AgentInputValue,
  type BindMicrovmInput,
  type ClientConnectionAttachment,
  type ConnectionAttachment,
  type EnqueueTurnInput,
  type EnqueueTurnResult,
  type EventSubscription,
  type HeldInput,
  type HeldTurnReceipt,
  type QuestionAnswer,
  type QuestionClosedReason,
  type QuestionOption,
  type TurnReceipt,
  type InitializeSessionInput,
  type InitializeSessionOutcome,
  type InitializeSessionResult,
  type MicrovmLifecycleState,
  type OutcomeDestination,
  type OutcomeEvent,
  type OutcomeEventType,
  OUTCOME_EVENT_TYPES,
  OUTCOME_RESULT_TEXT_LIMIT,
  SESSION_RESULT_DATA_LIMIT,
  type RuntimeConnectionAttachment,
  type RuntimeBillingResourceTier,
  type RuntimeBillingSegment,
  type RuntimeEventInput,
  type SessionSnapshot,
  type JsonValue,
  type ResultCommitInput,
  type ResultCommitOutcome,
  type RuntimeGeneration,
  type SessionResult,
  type SessionExecutionMode,
  type SessionIdentity,
  type SessionResources,
  type SessionAgentRender,
  type SessionStatus,
  type SessionSource,
  type SessionPublication,
  type SessionSummary,
  type SessionToClientFrame,
  type SessionToRuntimeFrame,
  type StructuredAgentInput,
  type SlackTurnDelivery,
  type ToolInvocationIdentity,
  type TurnInputMode,
  type TurnOutcomeDelivery,
  type TurnStatus,
  type WorkspaceArtifact,
  type WorkspaceExport,
  type WorkspaceExportState,
  type MemoryAdmissionState,
  type ModelRoute,
  type WorkerdSessionLease,
  type SessionMemoryBinding,
  isRecord,
  parseJsonRecord,
  type SessionCreation,
} from "../protocol.js";
import { memoryObjectName, type MemoryDeclaration, type MemoryEnvironment } from "./memory-contract.js";
import { hostToolCallId } from "../tool-identity.js";
import { problem } from "./http.js";
import {
  consultAnswerText,
  consultSessionId,
  isConsultInput,
} from "../consult.js";
import {
  consultAnswerKey,
  consultTurnKey,
  commitConsultation,
  consultationById,
  dueConsultations,
  deferConsultationPoll,
  ensureConsultSchema,
  markConsultationDispatched,
  markConsultationDone,
  nextConsultAttemptMs,
  type ConsultationRow,
  type ConsultTurnOutcome,
} from "./consultations.js";
import { applyLabelPatch, readLabels, type LabelPatch } from "./session-labels.js";
import { deploymentPool, sessionRunsOnWorkerd, type RuntimeLaunchEnv } from "./runtime-launch.js";
import { startSandboxSessionRuntime } from "./sandbox-runtime-start.js";
import {
  AutonomousBillingAdmissionError,
  requireAutonomousBillingAdmission,
  type AutonomousBillingEnv,
} from "./billing-admission.js";
import { isModalSandboxId } from "../platform/modal-sandbox.js";
import { workerdModelConfiguration } from "./deployment-pool-do.js";
import { latencyTelemetry } from "./latency.js";
import { regionHeaders, regionPlacement } from "../deployment-region.js";
import {
  MEMORY_ADMISSION_PENDING,
  MEMORY_ADMISSION_REJECTED,
  admissionState,
  closureState,
  driveMemoryAdmission,
  driveMemoryClosure,
  ensureMemorySessionSchema,
  liveMemoryBindings,
  localMemoryBindings,
  nextMemoryAttemptMs,
  readMemoryAdmission,
  recordMemoryAdmission,
  recordMemoryClosure,
  redriveMemory,
  workerdMemoryPayload,
  type MemorySessionEnv,
} from "./memory-session.js";

interface SessionRow {
  [key: string]: SqlStorageValue;
  id: string;
  account_id: string;
  user_id: string;
  agent_id: string;
  deployment_id: string;
  execution_mode: SessionExecutionMode;
  status: SessionStatus;
  runtime_id: string | null;
  runtime_epoch: number;
  runtime_token_hash: string;
  runtime_start_state: "unclaimed" | "starting" | "bound";
  runtime_start_attempt: number;
  /** The edge origin the session's runtime calls back through; consult member sessions reuse it. */
  runtime_edge: string | null;
  environment: string | null;
  identity_environment: string | null;
  memory_object: string | null;
  project_id: string | null;
  source: string | null;
  labels_json: string;
  labels_updated_at: string | null;
  revision: number;
  creation_json: string | null;
  countable: number;
  exclusion_reason: string | null;
  outcome_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The one row that says a list publication is owed: the newest revision the
 * Account object has not acknowledged, since when, and when to try next.
 */
interface PendingPublicationRow {
  [key: string]: SqlStorageValue;
  revision: number;
  since: string;
  attempts: number;
  next_attempt_at_ms: number;
}

interface TurnRow {
  [key: string]: SqlStorageValue;
  id: string;
  input: string;
  input_json: string;
  mode: TurnInputMode;
  status: TurnStatus;
  idempotency_key: string;
  /** Of the request the key admitted; null for turns admitted before it was recorded. */
  fingerprint: string | null;
  lease_deadline_at_ms: number | null;
  subscriptions_json: string;
  /** Settlement order across the session's turns; null while queued or running. */
  settled_seq: number | null;
  /** `question` on a completed turn that ended by asking (design 018). */
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

/** An `ask` call the Workerd host reported, with its derived question id. */
interface AskedQuestion {
  id: string;
  callId: string;
  text: string;
  options: QuestionOption[];
  /** What the person needs to decide, as the `ask` call gave it; shown above the question. */
  context?: string;
  /** Set when the question is a `consult` directed at a member agent — it is answered by that agent, not a person. */
  consult?: { agent: string; prompt: string };
}

/** The statuses a settled turn rests in. */
type SettledTurnStatus = Extract<TurnStatus, "completed" | "failed" | "cancelled">;

/**
 * The durable stop intent (`workerd_pending_stop`). Written before anything
 * else in the transaction that stops a turn, it names the turn and the
 * runtime generation it was recorded against, the replacement turn when an
 * interrupt-mode admission caused it, and when it was requested; the drive
 * escalates to terminating the computer once the settlement budget has
 * passed and remembers that it did.
 */
interface WorkerdPendingStopRow {
  [key: string]: SqlStorageValue;
  turn_id: string | null;
  reason: string;
  requested_at: string;
  attempts: number;
  next_attempt_at_ms: number;
  last_error: string | null;
  runtime_generation: string | null;
  replacement_turn_id: string | null;
  requested_at_ms: number;
  terminate_requested: number;
  /** The computer generation the host reported the pending operations on; the termination fallback names it. */
  computer_generation: number | null;
  /**
   * Set when the turn ended by asking (design 018): the settlement it is
   * owed once the host has settled every operation the turn dispatched,
   * `{ question, text, finalText }`. A later stop of the same turn clears
   * it, and the turn is then cancelled as that stop says.
   */
  ask_json: string | null;
}

/** How the Workerd runtime's word settles a turn. */
type WorkerdTurnOutcome =
  | {
      status: "completed";
      text: string;
      finalText: string;
      /** Set when the turn ended by asking: it completes with outcome `question`. */
      question?: AskedQuestion;
    }
  | { status: "failed"; detail: string; reason?: string; failure?: Record<string, unknown> };

/** What a turn that asked settles with, held on the pending stop until its operations have settled. */
interface PendingAskSettlement {
  question: AskedQuestion;
  text: string;
  finalText: string;
}

function pendingAskSettlement(encoded: string | null): PendingAskSettlement | undefined {
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(encoded) as PendingAskSettlement;
    return parsed && typeof parsed.question?.id === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A terminal turn event settles every tool call of the turn that has no completion of its own. */
const TERMINAL_TURN_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
]);

/** The events of one tool call; each carries the call's host identity in its data. */
const TOOL_CALL_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
]);

/** The text of an OpenCode tool result: its text parts joined, or the string it already is. */
function openCodeContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
}

/**
 * Tool calls of a Workerd turn, translated from OpenCode's own events to
 * the public shape (design C1, one shape on every runtime): `callId`,
 * `tool`, `title`, `input` on start, `output` on completion, `message` on
 * failure; the harness's native names (`id`, `name`, `content`,
 * `assistantMessageID`) never reach the log. OpenCode names the tool on
 * `session.tool.input.started` and carries the input on
 * `session.tool.called`, so the name is kept by call id from the first and
 * joined to the second; a call whose name never arrived is reported as
 * `tool`, never left unnamed.
 */
/**
 * OpenCode names a tool call once, on `session.tool.input.started`, and then
 * refers to it by `id`. The public events name it on every frame as `tool`
 * with `callId` and `title`, `input` as the call's arguments and `output` as
 * a JSON value: the documented shape, the one the dashboard and the channel
 * status line read. A consumer never joins frames; OpenCode's own ids are
 * not public except as the call's `identity` (message and call id).
 */
class WorkerdToolCalls {
  private readonly names = new Map<string, string>();
  private readonly messages = new Map<string, string>();

  inputStarted(data: Record<string, unknown>): void {
    if (typeof data.id === "string" && typeof data.name === "string") {
      this.names.set(data.id, data.name);
    }
    this.remember(data);
  }

  private remember(data: Record<string, unknown>): string {
    const callId = typeof data.id === "string" ? data.id : "";
    const known = this.messages.get(callId);
    if (known) return known;
    const reported = typeof data.assistantMessageID === "string" ? data.assistantMessageID : "";
    if (reported) this.messages.set(callId, reported);
    return reported;
  }

  private identity(data: Record<string, unknown>): {
    callId: string;
    tool: string;
    title: string;
    messageId: string;
  } {
    const callId = typeof data.id === "string" ? data.id : "";
    const tool = this.names.get(callId) ?? (typeof data.name === "string" ? data.name : "tool");
    // The assistant message that emitted the call; `appendEvent` folds it
    // into the call's host identity, so it is never a top-level field.
    return { callId, tool, title: tool, messageId: this.remember(data) };
  }

  started(data: Record<string, unknown>): Record<string, unknown> {
    return {
      ...this.identity(data),
      input: isRecord(data.input) ? data.input : {},
    };
  }

  progress(data: Record<string, unknown>): Record<string, unknown> {
    const { callId, tool, messageId } = this.identity(data);
    return { ...(isRecord(data.metadata) ? data.metadata : {}), callId, tool, messageId };
  }

  completed(data: Record<string, unknown>): Record<string, unknown> {
    return { ...this.identity(data), output: openCodeContentText(data.content) };
  }

  failed(data: Record<string, unknown>): Record<string, unknown> {
    const error = isRecord(data.error) ? data.error : undefined;
    return {
      ...this.identity(data),
      message:
        typeof error?.message === "string"
          ? error.message
          : typeof data.message === "string"
            ? data.message
            : "The tool call failed",
    };
  }
}


/**
 * Assistant text of a Workerd turn by message and part. `session.text.delta`
 * carries `assistantMessageID` and `ordinal`; `session.text.ended` carries
 * the part's complete text. The final message is the last one that produced
 * text; its parts in ordinal order are the turn's answer.
 */
/**
 * The detail a provider failure settles the turn with, or null when the
 * error is not a provider's: the typed class OpenCode assigned, its HTTP
 * status when it has one, the resolved model, then the message. The
 * public edge classifies on the first line's class.
 */
/**
 * The model call in flight on the Workerd host: the model OpenCode named on
 * `session.step.started`, the event seq before the call began, and the retries
 * the call has had so far. The gateway may record its route before the
 * Workerd response stream delivers step.started to this object.
 * Retries are counted until a step ends, so a continuation of the same
 * call carries them, and cleared when one does.
 */
interface WorkerdModelCall {
  model: { provider: string; model: string };
  sinceSeq: number;
  retries: number;
  hostGranted: boolean;
}

/** An execution failure with the fields the session records about it. */
class WorkerdExecutionFailure extends Error {
  constructor(
    message: string,
    readonly failure: Record<string, unknown> | undefined,
  ) {
    super(message);
  }
}

/**
 * The safe fields of an execution failure, for the public classification:
 * OpenCode's typed class and subtype (`provider.transport` is class
 * `provider`, subtype `transport`), the status when the provider sent one,
 * the model of the call that failed, and the retry evidence. The provider's
 * own text stays in the failure's message and is never one of these.
 */
function workerdExecutionFailure(
  error: Record<string, unknown>,
  call: WorkerdModelCall | undefined,
  route: { provider: string; model: string } | undefined,
): Record<string, unknown> | undefined {
  if (typeof error.type !== "string" || !error.type) return undefined;
  const dot = error.type.indexOf(".");
  const model = route ?? call?.model;
  return {
    class: dot === -1 ? error.type : error.type.slice(0, dot),
    ...(dot === -1 ? {} : { subtype: error.type.slice(dot + 1) }),
    ...(typeof error.status === "number" && Number.isFinite(error.status)
      ? { status: error.status }
      : {}),
    ...(model ? { provider: model.provider, model: model.model } : {}),
    retry: { attempts: 1 + (call?.retries ?? 0), hostGranted: call?.hostGranted ?? false },
  };
}

/**
 * OpenCode's step end as the public usage event, in the fields the MicroVM
 * harness reports: `model` is the qualified `provider/model` the accounting
 * keys its route charges by. Null when the step carries no token counts.
 * The cost is what OpenCode computed from its model catalog; the Workerd
 * host registers models without prices, so it is zero there.
 */
function workerdUsageRecorded(
  data: Record<string, unknown>,
  model: { provider: string; model: string } | undefined,
): Record<string, unknown> | null {
  const tokens = isRecord(data.tokens) ? data.tokens : null;
  if (!tokens) return null;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    provider: model?.provider ?? "openrouter",
    model: model ? `${model.provider}/${model.model}` : "unknown",
    inputTokens: count(tokens.input),
    outputTokens: count(tokens.output),
    reasoningTokens: count(tokens.reasoning),
    cachedTokens: count(cache.read),
    cacheWriteTokens: count(cache.write),
    costUsd: count(data.cost),
    payer: "user",
  };
}

/**
 * What a Workerd turn said, by assistant message, so the turn's answer is
 * its last response and not everything it said (D5). OpenCode writes one
 * assistant message per model call; a message and the continuations a
 * retry wrote for it form one response (a group). A model call that only
 * calls a tool (`ask`, `consult`, or any other) is a response with no text.
 */
class WorkerdAssistantText {
  private readonly messages = new Map<string, Map<number, string>>();
  /** Messages in order, grouped: a continuation joins the message it continues. */
  private readonly groups: string[][] = [];
  private readonly groupOf = new Map<string, string[]>();
  /** The message a retry was scheduled for; the next new message continues it. */
  private continuing: string | undefined;

  delta(data: Record<string, unknown>): void {
    const { parts, part } = this.part(data);
    parts.set(part, (parts.get(part) ?? "") + String(data.delta));
  }

  ended(data: Record<string, unknown>): void {
    const { parts, part } = this.part(data);
    parts.set(part, String(data.text));
  }

  /**
   * OpenCode scheduled a retry of the model call writing this message. When
   * output had started it continues the response in a new message, so that
   * message belongs with this one: the answer is both, in order.
   */
  retrying(data: Record<string, unknown>): void {
    if (typeof data.assistantMessageID === "string") this.continuing = data.assistantMessageID;
  }

  /**
   * A model call started writing this message. Seen here even when it
   * writes no text (a tool call alone), so a continuation that only calls
   * tools takes the place after the broken message and the answer that
   * follows the tools starts a response of its own. A retry of a call
   * that had produced no output writes the same message again: nothing is
   * continued, and the marker is spent.
   */
  started(data: Record<string, unknown>): void {
    if (typeof data.assistantMessageID !== "string") return;
    if (this.continuing === data.assistantMessageID) this.continuing = undefined;
    this.register(data.assistantMessageID);
  }

  /** A model call finished its message: no continuation of it is pending. */
  stepEnded(): void {
    this.continuing = undefined;
  }

  /**
   * The turn's answer: the last response that has text (a message with the
   * fragments it continued). Responses with no text after it, such as the
   * model call that only calls `ask` or `consult`, are skipped, so the
   * question card, `message.completed`, the outcome event and the consult
   * answer all carry the text the turn last wrote. Empty when the turn
   * wrote no text in any response; undefined when no model call started.
   */
  final(): string | undefined {
    if (this.groups.length === 0) return undefined;
    for (let index = this.groups.length - 1; index >= 0; index--) {
      const text = this.groups[index]!
        .map((messageId) =>
          [...this.messages.get(messageId)!.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, part]) => part)
            .join(""),
        )
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }

  /** The message's parts; a message seen for the first time becomes the last one. */
  private part(data: Record<string, unknown>): { parts: Map<number, string>; part: number } {
    return {
      parts: this.register(
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : "",
      ),
      part: typeof data.ordinal === "number" && Number.isFinite(data.ordinal) ? data.ordinal : 0,
    };
  }

  /**
   * The message's parts, created on first sight: the message joins the
   * response a retry left unfinished, or starts a new one, and becomes the
   * last message either way.
   */
  private register(messageId: string): Map<number, string> {
    let parts = this.messages.get(messageId);
    if (parts) {
      if (this.continuing === messageId) this.continuing = undefined;
      return parts;
    }
    parts = new Map();
    this.messages.set(messageId, parts);
    const continued = this.continuing === undefined ? undefined : this.groupOf.get(this.continuing);
    this.continuing = undefined;
    const group = continued ?? [];
    if (!continued) this.groups.push(group);
    group.push(messageId);
    this.groupOf.set(messageId, group);
    return parts;
  }
}

/** The `memory.saved` payload, or null when the host frame is not one. */
function memorySavedEvent(
  data: Record<string, unknown>,
): { resource: string; documentId: string; revision: string; bytes: number } | null {
  if (
    typeof data.resource !== "string" ||
    typeof data.documentId !== "string" ||
    typeof data.revision !== "string" ||
    typeof data.bytes !== "number" ||
    !Number.isFinite(data.bytes)
  ) {
    return null;
  }
  return {
    resource: data.resource,
    documentId: data.documentId,
    revision: data.revision,
    bytes: data.bytes,
  };
}

function structuredAgentInput(
  encoded: string,
  fallbackText: string,
): StructuredAgentInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    return { source: "user", text: fallbackText };
  }
  if (!isRecord(parsed)) return { source: "user", text: fallbackText };
  const sources = new Set([
    "user",
    "channel",
    "schedule",
    "webhook",
    "subagent",
    "system",
    "event",
  ]);
  if (typeof parsed.source !== "string" || !sources.has(parsed.source)) {
    return { source: "user", text: fallbackText };
  }
  const source = parsed.source as StructuredAgentInput["source"];
  const schedule = isRecord(parsed.schedule) ? parsed.schedule : null;
  const validSchedule =
    schedule &&
    typeof schedule.id === "string" &&
    typeof schedule.runId === "string" &&
    typeof schedule.scheduledAt === "string" &&
    typeof schedule.timezone === "string" &&
    typeof schedule.attempt === "number" &&
    Number.isInteger(schedule.attempt) &&
    schedule.attempt > 0 &&
    typeof schedule.manual === "boolean";
  const webhook = isRecord(parsed.webhook) ? parsed.webhook : null;
  const validWebhook =
    webhook &&
    typeof webhook.id === "string" &&
    typeof webhook.requestId === "string" &&
    typeof webhook.receivedAt === "string";
  // This function rebuilds its result from validated pieces rather than
  // spreading what it was given, so anything not named here is dropped. A new
  // field on the write side is invisible until it is also read here.
  const channel = isRecord(parsed.channel) ? parsed.channel : null;
  const validChannel =
    channel &&
    typeof channel.provider === "string" &&
    typeof channel.connectionId === "string";
  const event = isRecord(parsed.event) ? parsed.event : null;
  const validEvent =
    event &&
    typeof event.id === "string" &&
    typeof event.type === "string" &&
    (OUTCOME_EVENT_TYPES as readonly string[]).includes(event.type) &&
    typeof event.sessionId === "string" &&
    typeof event.turnId === "string" &&
    typeof event.agentId === "string" &&
    typeof event.occurredAt === "string";
  if (source === "schedule" && !validSchedule) {
    return { source: "user", text: fallbackText };
  }
  if (source === "webhook" && !validWebhook) {
    return { source: "user", text: fallbackText };
  }
  if (source === "event" && !validEvent) {
    return { source: "user", text: fallbackText };
  }
  return {
    source,
    ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
    ...(parsed.payload !== undefined
      ? { payload: parsed.payload as AgentInputValue }
      : {}),
    ...(validSchedule
      ? {
          schedule: {
            id: schedule.id as string,
            runId: schedule.runId as string,
            scheduledAt: schedule.scheduledAt as string,
            timezone: schedule.timezone as string,
            attempt: schedule.attempt as number,
            manual: schedule.manual as boolean,
          },
        }
      : {}),
    ...(validChannel
      ? {
          channel: {
            provider: channel.provider as string,
            connectionId: channel.connectionId as string,
            ...(typeof channel.workspaceId === "string"
              ? { workspaceId: channel.workspaceId }
              : {}),
            ...(typeof channel.conversationId === "string"
              ? { conversationId: channel.conversationId }
              : {}),
            ...(typeof channel.userId === "string"
              ? { userId: channel.userId }
              : {}),
          },
        }
      : {}),
    ...(validWebhook
      ? {
          webhook: {
            id: webhook.id as string,
            requestId: webhook.requestId as string,
            receivedAt: webhook.receivedAt as string,
          },
        }
      : {}),
    ...(validEvent
      ? {
          event: {
            id: event.id as string,
            type: event.type as OutcomeEventType,
            sessionId: event.sessionId as string,
            turnId: event.turnId as string,
            agentId: event.agentId as string,
            occurredAt: event.occurredAt as string,
            ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
            ...(typeof event.error === "string" ? { error: event.error } : {}),
            ...(isRecord(event.result) && typeof event.result.text === "string"
              ? {
                  result: {
                    text: event.result.text,
                    truncated: event.result.truncated === true,
                  },
                }
              : {}),
            ...outcomeEventQuestionFields(event),
            ...(isRecord(event.labels) && Object.keys(event.labels).length
              ? {
                  labels: Object.fromEntries(
                    Object.entries(event.labels).filter(
                      (entry): entry is [string, string] => typeof entry[1] === "string",
                    ),
                  ),
                }
              : {}),
          },
        }
      : {}),
    // Top-level beside `payload` (design 018): the answer to the session's
    // question and the inputs held while it was open.
    ...questionInputFields(parsed),
  };
}

interface OutcomeDeliveryRow {
  [key: string]: SqlStorageValue;
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: OutcomeEventType;
  turn_id: string;
  destination_json: string;
  status: "pending" | "delivered" | "failed";
  attempt: number;
  next_attempt_at_ms: number | null;
  lease_until_ms: number | null;
  receipt_session_id: string | null;
  receipt_turn_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** What a turn captures at admission: enough to decide and address a delivery without another lookup. */
type CapturedSubscription = Pick<EventSubscription, "id" | "events" | "destination">;

/**
 * The turn's answer from its completion event: the final assistant message
 * when the source recorded one, otherwise everything the turn said, which is
 * what older completion events carry.
 */
/**
 * The line a channel turn's transcript header gains while a question that
 * does not hold is open (Slack): the question and its options, on one
 * line, after the `[Slack message from …]` header, or as a header of its
 * own when the text has none.
 */
function withOpenQuestionLine(
  text: string,
  question: { text: string; options: ReadonlyArray<{ label: string }> },
): string {
  const asked = question.text.replace(/\s+/g, " ").trim();
  const line = question.options.length
    ? `Open question: "${asked}" (options: ${question.options.map((option) => option.label).join(" · ")}). A button answers it; this message is not the answer unless it says so.`
    : `Open question: "${asked}". This message is not the answer unless it says so.`;
  const header = /^\[[^\n]*\]\n/.exec(text);
  return header
    ? `${header[0]}${line}\n${text.slice(header[0].length)}`
    : `${line}\n\n${text}`;
}

function completionAnswer(parsed: Record<string, unknown> | null): string {
  if (!parsed) return "";
  if (typeof parsed.finalText === "string") return parsed.finalText;
  return typeof parsed.text === "string" ? parsed.text : "";
}

function outcomeDeliveryFromRow(row: OutcomeDeliveryRow): TurnOutcomeDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    eventType: row.event_type,
    destination: JSON.parse(row.destination_json) as OutcomeDestination,
    status: row.status,
    attempt: row.attempt,
    ...(row.receipt_session_id && row.receipt_turn_id
      ? { receipt: { sessionId: row.receipt_session_id, turnId: row.receipt_turn_id } }
      : {}),
    ...(row.status === "pending" && row.next_attempt_at_ms !== null
      ? { nextAttemptAt: new Date(row.next_attempt_at_ms).toISOString() }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    updatedAt: row.updated_at,
  };
}

/** A delivery that can never succeed against this destination as it is. */
class OutcomeDeliveryTerminalError extends Error {}

function boundedText(value: string, limit: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= limit) return { text: value, truncated: false };
  let end = value.length;
  while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > limit) {
    end = Math.floor(end * 0.9);
  }
  return { text: value.slice(0, end), truncated: true };
}

/** The prompt the receiving model reads; the typed event travels beside it. */
function outcomeEventText(event: OutcomeEvent): string {
  const where = `agent ${event.agentId} (session ${event.sessionId}, turn ${event.turnId}) at ${event.occurredAt}`;
  switch (event.type) {
    case "turn.completed":
      return `Outcome event turn.completed from ${where}.\nResult${event.result?.truncated ? " (truncated)" : ""}:\n${event.result?.text ?? ""}${
        event.question
          ? `\nThe turn ended by asking (question ${event.question.id}):\n${
              event.question.context ? `${event.question.context}\n\n` : ""
            }${event.question.text}`
          : ""
      }`;
    case "turn.failed":
      return `Outcome event turn.failed from ${where}${event.reason ? ` (${event.reason})` : ""}.${event.error ? `\nError: ${event.error}` : ""}`;
    case "turn.cancelled":
      return `Outcome event turn.cancelled from ${where}${event.reason ? ` (${event.reason})` : ""}.`;
  }
}

interface EventRow {
  [key: string]: SqlStorageValue;
  seq: number;
  id: string;
  timestamp: string;
  turn_id: string | null;
  type: AgentEventType;
  data: string;
}

interface MicrovmBindingRow {
  [key: string]: SqlStorageValue;
  microvm_id: string;
  state: MicrovmLifecycleState;
  updated_at: string;
}

interface SlackDeliveryRow {
  [key: string]: SqlStorageValue;
  turn_id: string;
  connection_id: string;
  channel_id: string;
  external_user_id: string | null;
  thread_timestamp: string;
  status: string;
  attempts: number;
  provider: string | null;
  delivery_ref: string | null;
  next_attempt_at_ms: number | null;
  lease_until_ms: number | null;
  ack_due_at_ms: number | null;
}

/**
 * Where a reply goes, in the owning adapter's own terms. Slack reads
 * `{channelId, threadTimestamp}` from it and Twilio reads `{to, from}`; nothing
 * between here and `send` looks inside.
 */
type ChannelDeliveryTarget = Record<string, unknown>;

/**
 * A channel reply retries a transient failure on this schedule, five attempts
 * in all; the attempt after the last entry fails it for good. Each attempt
 * holds a lease, so the settlement that first tries to answer and an alarm
 * that fires meanwhile never send the same reply at once, in this activation
 * or the next.
 */
const CHANNEL_DELIVERY_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000];
const CHANNEL_DELIVERY_LEASE_MS = 30_000;
/**
 * How long an admitted channel turn may run before the thread hears that
 * work started. A turn that answers inside the window never gets the ack —
 * it is the acknowledgement — so short asks stay a single reply and only
 * real work announces itself with a session link.
 */
const CHANNEL_ACK_DELAY_MS = 15_000;

/**
 * How long a session nobody talks to holds its runtime after a settled turn,
 * by source. A scheduled, API or webhook run is usually done after one turn;
 * held until the 24 hour lifetime, every run left a sandbox behind. A later
 * turn resumes from the suspend snapshot. A channel declares its own hold
 * (absent means never), and a playground or computer session sets or keeps
 * its own.
 */
const DEFAULT_IDLE_SUSPEND_SECONDS: Partial<Record<string, number>> = {
  api: 300,
  schedule: 300,
  webhook: 300,
};

/**
 * How long a turn waits for a suspended runtime it woke to connect before
 * the wake is tried again, and how many wakes it gets before the queued
 * turns fail with `runtime_wake_failed`. A resume from a snapshot takes
 * about 15 seconds.
 */
const RUNTIME_WAKE_TIMEOUT_MS = 60_000;
const RUNTIME_WAKE_ATTEMPTS = 2;

/**
 * Slack errors that will never come right on their own. Retrying a message to
 * a channel the bot was never in just burns alarms until something else
 * notices.
 */
const PERMANENT_SLACK_DELIVERY_ERRORS = [
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "message_limit_exceeded",
];

function permanentDeliveryFailure(message: string): boolean {
  return PERMANENT_SLACK_DELIVERY_ERRORS.some((code) => message.includes(code));
}

/**
 * Slack refusing a question card's blocks, as opposed to the conversation:
 * the same question still posts as plain text (the text gate).
 */
const SLACK_CARD_REFUSALS = [
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_arguments",
  "msg_too_long",
  "msg_blocks_too_long",
];

function cardRefused(message: string): boolean {
  return SLACK_CARD_REFUSALS.some((code) => message.includes(code));
}

/**
 * The dashboard page for a session — where a Slack reply points for detail
 * that does not fit in a thread. Self-hosted deployments set
 * OPENCOMPUTER_APP_URL; the default is the hosted app.
 *
 * Sessions live under their project: `/projects/prj_x/sessions/id`. A session
 * whose agent belongs to no project only has the synthetic `project:{agentId}`
 * key, which is not a route — those keep the bare `/sessions/id` link.
 */
function channelSessionUrl(
  env: Env,
  session: { id: string; project_id: string | null },
): string {
  const base = (env.OPENCOMPUTER_APP_URL ?? "https://app.opencomputer.dev").replace(
    /\/$/,
    "",
  );
  const projectId = session.project_id;
  return projectId && !projectId.startsWith("project:")
    ? `${base}/projects/${projectId}/sessions/${session.id}`
    : `${base}/sessions/${session.id}`;
}

function deliveryTarget(
  row: Pick<SlackDeliveryRow, "channel_id" | "thread_timestamp" | "delivery_ref">,
): ChannelDeliveryTarget {
  if (row.delivery_ref) {
    try {
      const parsed: unknown = JSON.parse(row.delivery_ref);
      // Returned as stored. An earlier version rebuilt it as
      // `{channelId, threadTimestamp}`, which silently emptied the address for
      // every provider that does not address a channel and a thread — a Twilio
      // reply became `{channelId: "", threadTimestamp: ""}` and was refused by
      // its own adapter.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ChannelDeliveryTarget;
      }
    } catch {
      // A malformed ref must not strand a delivery; the columns still hold
      // Slack's, which is the only provider that ever wrote them.
    }
  }
  return {
    channelId: row.channel_id,
    threadTimestamp: row.thread_timestamp,
  };
}

interface RuntimeBillingLeaseRow {
  [key: string]: SqlStorageValue;
  id: string;
  microvm_id: string;
  resource_tier: RuntimeBillingResourceTier;
  opened_at_ms: number;
  last_heartbeat_at_ms: number;
  expires_at_ms: number;
}

interface RuntimeBillingSegmentRow {
  [key: string]: SqlStorageValue;
  id: string;
  microvm_id: string;
  resource_tier: RuntimeBillingResourceTier;
  started_at_ms: number;
  ended_at_ms: number;
  quantity_seconds: number;
  close_reason: RuntimeBillingSegment["closeReason"];
}

const EVENT_TYPES = new Set<AgentEventType>([
  "session.created",
  "session.status_changed",
  "runtime.connected",
  "runtime.disconnected",
  "runtime.suspended",
  "runtime.resumed",
  "turn.queued",
  "turn.steered",
  "turn.interrupted",
  "turn.started",
  "message.received",
  "message.delta",
  "message.completed",
  "reasoning.delta",
  "reasoning.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "model.route_resolved",
  "model.access_fallback",
  "usage.recorded",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.failed",
  "runtime.log",
  "session.ended",
]);

interface WorkspaceArtifactRow {
  [key: string]: SqlStorageValue;
  id: string;
  export_id: string;
  path: string;
  size: number;
  sha256: string;
  media_type: string;
  snapshot_id: string;
  receipt_json: string;
  exported_at: string;
}

const WORKSPACE_ARTIFACT_COLUMNS =
  "id, export_id, path, size, sha256, media_type, snapshot_id, receipt_json, exported_at";

interface WorkspaceExportRow {
  [key: string]: SqlStorageValue;
  id: string;
  idempotency_key: string | null;
  request_digest: string;
  path: string;
  expected_json: string | null;
  state: WorkspaceExportState;
  artifact_id: string | null;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
}

const WORKSPACE_EXPORT_COLUMNS =
  "id, idempotency_key, request_digest, path, expected_json, state, artifact_id, error_json, created_at, completed_at";

/** An export still `snapshotting` this long after it began is presumed lost with its request and expires. */
const WORKSPACE_EXPORT_IN_FLIGHT_MS = 15 * 60_000;

/** Prefix of the error `beginWorkspaceExport` throws when a key is reused for another request; the edge maps it to 409. */
export const WORKSPACE_EXPORT_CONFLICT = "export_idempotency_conflict";

function sessionIdentity(session: SessionRow): {
  sessionId: string;
  projectId: string;
  agentId: string;
  deploymentId: string;
  environment: string | null;
} {
  return {
    sessionId: session.id,
    projectId: session.project_id ?? `project:${session.agent_id}`,
    agentId: session.agent_id,
    deploymentId: session.deployment_id,
    environment: session.environment,
  };
}

function workspaceArtifactFromRow(
  session: SessionRow,
  row: WorkspaceArtifactRow,
): WorkspaceArtifact {
  return {
    id: row.id,
    exportId: row.export_id,
    ...sessionIdentity(session),
    path: row.path,
    size: row.size,
    sha256: row.sha256,
    mediaType: row.media_type,
    snapshotId: row.snapshot_id,
    receipt: JSON.parse(row.receipt_json) as WorkspaceArtifact["receipt"],
    retention: { policy: "until_deleted", expiresAt: null },
    exportedAt: row.exported_at,
  };
}

function workspaceExportFromRow(
  session: SessionRow,
  row: WorkspaceExportRow,
): WorkspaceExport {
  return {
    id: row.id,
    ...sessionIdentity(session),
    path: row.path,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    expected: row.expected_json
      ? (JSON.parse(row.expected_json) as WorkspaceExport["expected"])
      : null,
    artifactId: row.artifact_id,
    error: row.error_json
      ? (JSON.parse(row.error_json) as WorkspaceExport["error"])
      : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The events whose transaction also changes a list row (status, activity,
 * lifecycle). Appending one bumps the session revision and records a
 * pending publication in that same transaction; streaming events do not.
 */
const PUBLISHED_EVENT_TYPES = new Set<AgentEventType>([
  "session.created",
  "session.status_changed",
  "session.failed",
  "session.ended",
  "runtime.disconnected",
  "turn.queued",
  "turn.steered",
  "turn.interrupted",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
]);
const PUBLICATION_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000];

function countabilityExclusionReason(
  data: Record<string, unknown>,
): "model_credit_exhausted" | null {
  if (data.code === "model_credit_exhausted") return "model_credit_exhausted";
  const failure = isRecord(data.failure) ? data.failure : null;
  if (
    failure?.class === "provider" &&
    (failure.subtype === "quota" || failure.status === 402)
  ) {
    return "model_credit_exhausted";
  }
  return null;
}

const RUNTIME_BILLING_RESOURCE_TIER = AGENT_RUNTIME_RESOURCE_TIER;
const RUNTIME_BILLING_LEASE_TTL_MS = 60_000;

/**
 * A Workerd turn is driven from this object's memory. The lease says that the
 * driver is still alive: it is renewed on a timer while the driver waits on
 * the runtime stream and on every frame the stream yields, so quiet work keeps
 * it. Nothing renews it once the object is evicted mid-turn, and the alarm then
 * fails the turn with `runtime_lost` instead of leaving it running forever.
 */
const WORKERD_TURN_LEASE_MS = 60_000;
const WORKERD_TURN_LEASE_RENEW_MS = 15_000;

/**
 * A stop the Workerd host still has to settle (`workerd_pending_stop`). It
 * is written first in the transaction that stops a turn (interrupt,
 * interrupt-mode admission, end, lease expiry, or a host that refused a
 * prompt because an older execution is still live) and nothing dispatches
 * on the session until the host has settled it: the model loop stopped and
 * every operation the turn dispatched terminated and confirmed. One attempt
 * is bounded by the timeout (the host cancels operations in parallel, each
 * bounded by the supervisor's own waits); an unsettled or lost attempt is
 * re-driven by the alarm on this schedule, the last entry repeating. Once
 * the settlement budget has passed since the stop was requested, the drive
 * terminates the computer through the host and the platform instead, and
 * settles on the confirmed termination.
 */
const WORKERD_STOP_TIMEOUT_MS = 25_000;
const WORKERD_STOP_ATTEMPT_DEADLINE_MS = 30_000;

/** One host call's bound; the test configurations shorten it to exercise a caller that times out. */
function workerdStopTimeoutMs(env: Env): number {
  const configured = Number((env as Env & { WORKERD_STOP_TIMEOUT_MS?: string }).WORKERD_STOP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : WORKERD_STOP_TIMEOUT_MS;
}
const WORKERD_STOP_BACKOFF_MS = [1_000, 2_000, 5_000];

/**
 * The tool calls of a turn that started and never completed or failed
 * (C1, terminal settlement). Two probes of `events` by (turn_id, type),
 * in `seq` order; exported so the query-plan test measures this text.
 */
export const OPEN_TOOL_CALLS_SQL = `SELECT json_extract(data, '$.callId') AS call_id,
                json_extract(data, '$.tool') AS tool,
                json_extract(data, '$.title') AS title,
                json_extract(data, '$.identity.messageId') AS message_id
         FROM events
         WHERE turn_id = ? AND type = 'tool.started'
           AND json_extract(data, '$.callId') IS NOT NULL
           AND json_extract(data, '$.callId') NOT IN (
             SELECT json_extract(data, '$.callId')
             FROM events
             WHERE turn_id = ? AND type IN ('tool.completed', 'tool.failed')
               AND json_extract(data, '$.callId') IS NOT NULL
           )
         ORDER BY seq`;

/**
 * The most recently settled turn, for the list row's
 * `activity.lastSettledTurn`: the first entry of `turns_settled`, the
 * partial index over `settled_seq`, walked from the highest. Settlement
 * has its own order because neither column already on the row carries it:
 * `updated_at` ties whenever two turns settle in one millisecond, and
 * rowid orders admission, which is not settlement (a steered turn is
 * admitted after the active one and may settle before it). `settled_seq`
 * is stamped by `settleTurn` in the transaction that writes the terminal
 * status, one above the highest value so far, so the walk needs no
 * tiebreak. The index is named because the planner otherwise picks
 * `turns_queue` for a status filter and sorts the matches into a
 * temporary b-tree, which grows with the history.
 */
export const LAST_SETTLED_TURN_SQL = `SELECT id, status, updated_at FROM turns INDEXED BY turns_settled
         WHERE settled_seq IS NOT NULL
         ORDER BY settled_seq DESC
         LIMIT 1`;
/**
 * The next settlement order value: one above the highest stamped, read
 * as the first entry of `turns_settled`. Only settled rows carry a value,
 * nothing ever lowers one and turns are never deleted, so the sequence
 * only grows; a session whose turns were settled before the column
 * existed continues above their backfilled range.
 */
export const NEXT_SETTLED_SEQ_SQL = `SELECT COALESCE(MAX(settled_seq), 0) + 1 FROM turns INDEXED BY turns_settled
         WHERE settled_seq IS NOT NULL`;
const WORKERD_STOP_SETTLE_BUDGET_MS = 60_000;

/** How often a dispatched consultation polls its member session's turn. */
const CONSULT_POLL_MS = 5_000;
/**
 * How long a consultation may wait for dispatch or settlement before its
 * question is answered with "unavailable" — the coordinator always resumes.
 */
const CONSULT_DEADLINE_MS = 15 * 60_000;

/**
 * Outcome delivery retries transient admission failures on this schedule;
 * the attempt after the last entry fails the delivery for good. Each attempt
 * holds a lease so a second alarm firing skips a delivery already in flight.
 */
const OUTCOME_DELIVERY_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const OUTCOME_DELIVERY_LEASE_MS = 60_000;

/** Prefix of the error `enqueueTurn` throws for an ended session; the edge maps it to 409. */
export const SESSION_ENDED = "session_ended";
/** The typed reason `updateLabels` throws when the patched labels would exceed the bounds. */
export const INVALID_LABELS = "invalid_labels";
/** Prefix of the error `enqueueTurn` throws when a key is reused for another request; the edge maps it to 409. */
export const IDEMPOTENCY_CONFLICT = "idempotency_conflict";
/**
 * Prefix of the error a synchronous mutation throws when the projection did
 * not acknowledge its revision before the answer was due (C1): the change
 * is committed and the alarm keeps delivering it, but the caller must not
 * be told success while a list read could miss it. The edge maps it to a
 * retryable 503 carrying the session id.
 */
export const PUBLICATION_UNCONFIRMED = "publication_unconfirmed";

function encodeFrame(
  frame: SessionToClientFrame | SessionToRuntimeFrame,
): string {
  return JSON.stringify(frame);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * JSON with object keys sorted at every level, so two commits of the same
 * value fingerprint the same regardless of property order. The input has
 * been through JSON.stringify already, so there is nothing non-JSON left.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The question a MicroVM turn ended with: the runtime sends its `ask` call
 * on the turn's `turn.completed`. A malformed one is dropped and the turn
 * completes as an ordinary turn.
 */
async function askedQuestionOf(
  turnId: string,
  events: readonly RuntimeEventInput[],
): Promise<AskedQuestion | undefined> {
  const completed = events.find((event) => event.type === "turn.completed");
  const data = completed?.data?.question;
  if (!isRecord(data)) return undefined;
  const call = typeof data.callId === "string" && data.callId ? data.callId : undefined;
  const question = {
    text: data.text,
    ...(data.options !== undefined ? { options: data.options } : {}),
    ...(data.context !== undefined ? { context: data.context } : {}),
  };
  if (!call || !isAskInput(question)) return undefined;
  return {
    id: await questionIdFor(turnId, call),
    callId: call,
    text: question.text,
    options: question.options ?? [],
    ...(question.context?.trim() ? { context: question.context } : {}),
  };
}

function parseRuntimeEvent(value: unknown): RuntimeEventInput | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (!EVENT_TYPES.has(value.type as AgentEventType)) {
    return null;
  }
  if (value.data !== undefined && !isRecord(value.data)) {
    return null;
  }
  return {
    type: value.type as AgentEventType,
    data: value.data ?? {},
  };
}

export class SessionDurableObject extends DurableObject<Env> {
  private readonly slackProgress = new Map<string, SlackProgress>();
  /** The Linear agent session's ordered activity queue (work 037 S3); inert for other sessions. */
  private readonly linearActivities = new LinearActivityQueue({
    storage: this.ctx.storage,
    account: () => this.env.ACCOUNTS.getByName(this.requireSession().account_id),
    appendEvent: (type, turnId, data) => this.appendEvent(type, turnId, data),
    questionElicitation: (questionId, outcome) => this.questionElicitationInTransaction(questionId, outcome),
    dispatch: () => this.dispatchNextTurn(),
    broadcast: (events) => this.broadcastEvents(events),
    scheduleAlarm: () => this.scheduleAlarm(),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
  });
  private readonly initialized: Promise<void>;
  /** The admission in flight in this activation: the object admits one caller, and every other caller converges on what it admitted. */
  private initialization: Promise<InitializeSessionResult> | undefined;
  /** The in-flight stop drive of this activation, so two callers share one host call. */
  private stopDrive: Promise<void> | undefined;
  /** Tool-call settlements appendEvent wrote ahead of a terminal turn event, broadcast with it. */
  private readonly settledToolCalls: AgentEvent[] = [];
  /** The in-flight list publication of this activation, so the alarm and an eager kick share one delivery; resolves with the highest acknowledged revision. */
  private publicationDrive: Promise<number> | undefined;
  /** A delivery asked for while a drive was in flight: the drive runs once more before it ends. */
  private publicationRequested = false;
  /**
   * Set by `bumpRevision` inside a mutation's transaction; the broadcast
   * that follows the commit consumes it and starts the eager delivery.
   */
  private publicationOwed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS session (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          execution_mode TEXT NOT NULL DEFAULT 'microvm',
          status TEXT NOT NULL,
          runtime_id TEXT,
          runtime_epoch INTEGER NOT NULL DEFAULT 0,
          runtime_token_hash TEXT NOT NULL,
          runtime_start_state TEXT NOT NULL DEFAULT 'unclaimed',
          runtime_start_attempt INTEGER NOT NULL DEFAULT 0,
          countable INTEGER NOT NULL DEFAULT 1,
          exclusion_reason TEXT,
          outcome_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY,
          input TEXT NOT NULL,
          input_json TEXT NOT NULL DEFAULT '{}',
          mode TEXT NOT NULL DEFAULT 'queue',
          status TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          fingerprint TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS turns_queue
          ON turns(status, created_at);
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          timestamp TEXT NOT NULL,
          turn_id TEXT,
          type TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_turn_type
          ON events(turn_id, type, seq);
        CREATE TABLE IF NOT EXISTS runtime_frames (
          runtime_id TEXT NOT NULL,
          frame_id TEXT NOT NULL,
          received_at TEXT NOT NULL,
          PRIMARY KEY(runtime_id, frame_id)
        );
        CREATE TABLE IF NOT EXISTS session_result (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          turn_id TEXT NOT NULL,
          call_id TEXT NOT NULL,
          reported_at TEXT NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS result_receipts (
          turn_id TEXT NOT NULL,
          call_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          event_id TEXT NOT NULL,
          reported_at TEXT NOT NULL,
          PRIMARY KEY(turn_id, call_id)
        );
        CREATE TABLE IF NOT EXISTS microvm_binding (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          microvm_id TEXT NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_billing_leases (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          id TEXT NOT NULL UNIQUE,
          microvm_id TEXT NOT NULL,
          resource_tier TEXT NOT NULL,
          opened_at_ms INTEGER NOT NULL,
          last_heartbeat_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_billing_segments (
          id TEXT PRIMARY KEY,
          microvm_id TEXT NOT NULL,
          resource_tier TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL,
          ended_at_ms INTEGER NOT NULL,
          quantity_seconds INTEGER NOT NULL,
          close_reason TEXT NOT NULL,
          delivery_status TEXT NOT NULL DEFAULT 'pending',
          delivery_attempts INTEGER NOT NULL DEFAULT 0,
          next_delivery_at_ms INTEGER NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runtime_billing_segments_delivery
          ON runtime_billing_segments(delivery_status, created_at);
        CREATE TABLE IF NOT EXISTS slack_deliveries (
          turn_id TEXT PRIMARY KEY,
          connected_account_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          external_user_id TEXT,
          thread_timestamp TEXT NOT NULL,
          progress_message_timestamp TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER,
          lease_until_ms INTEGER,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shared_files (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_artifacts (
          id TEXT PRIMARY KEY,
          export_id TEXT NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          media_type TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          exported_at TEXT NOT NULL,
          UNIQUE(path, sha256)
        );
        CREATE TABLE IF NOT EXISTS workspace_exports (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT,
          request_digest TEXT NOT NULL,
          path TEXT NOT NULL,
          expected_json TEXT,
          state TEXT NOT NULL,
          artifact_id TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS workspace_exports_key
          ON workspace_exports (idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE TABLE IF NOT EXISTS session_data (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_secrets (
          name TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_renders (
          render_id TEXT PRIMARY KEY,
          response_id TEXT NOT NULL,
          provider_turn INTEGER NOT NULL,
          state_version INTEGER NOT NULL,
          instructions_hash TEXT NOT NULL,
          instructions TEXT NOT NULL DEFAULT '',
          platform_instructions_json TEXT NOT NULL DEFAULT '[]',
          enabled_tools_json TEXT NOT NULL,
          enabled_subagents_json TEXT NOT NULL,
          required_connections_json TEXT NOT NULL DEFAULT '[]',
          enabled_mcp_servers_json TEXT NOT NULL DEFAULT '[]',
          input_json TEXT NOT NULL DEFAULT '{}',
          tools_json TEXT NOT NULL DEFAULT '[]',
          model_provider TEXT,
          model_id TEXT,
          rendered_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_session (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          runtime_session_id TEXT NOT NULL,
          opencode_session_id TEXT NOT NULL,
          runtime_boot_id TEXT NOT NULL DEFAULT '',
          runtime_activation INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS outcome_deliveries (
          id TEXT PRIMARY KEY,
          subscription_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          destination_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER,
          lease_until_ms INTEGER,
          receipt_session_id TEXT,
          receipt_turn_id TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outcome_deliveries_pending
          ON outcome_deliveries(status, next_attempt_at_ms);
        CREATE INDEX IF NOT EXISTS outcome_deliveries_turn
          ON outcome_deliveries(turn_id, created_at);
        CREATE TABLE IF NOT EXISTS pending_publication (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          revision INTEGER NOT NULL,
          since TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_pending_stop (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          turn_id TEXT,
          reason TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER NOT NULL,
          last_error TEXT,
          runtime_generation TEXT,
          replacement_turn_id TEXT,
          requested_at_ms INTEGER NOT NULL DEFAULT 0,
          terminate_requested INTEGER NOT NULL DEFAULT 0,
          computer_generation INTEGER,
          ask_json TEXT
        );
      `);
      const pendingStopColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(workerd_pending_stop)")
        .toArray();
      for (const [column, definition] of [
        ["runtime_generation", "TEXT"],
        ["replacement_turn_id", "TEXT"],
        ["requested_at_ms", "INTEGER NOT NULL DEFAULT 0"],
        ["terminate_requested", "INTEGER NOT NULL DEFAULT 0"],
        ["computer_generation", "INTEGER"],
        ["ask_json", "TEXT"],
      ] as const) {
        if (!pendingStopColumns.some((candidate) => candidate.name === column)) {
          this.ctx.storage.sql.exec(
            `ALTER TABLE workerd_pending_stop ADD COLUMN ${column} ${definition}`,
          );
        }
      }
      const turnColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(turns)")
        .toArray();
      if (!turnColumns.some((column) => column.name === "mode")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE turns ADD COLUMN mode TEXT NOT NULL DEFAULT 'queue'",
        );
      }
      if (!turnColumns.some((column) => column.name === "input_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE turns ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}'",
        );
      }
      if (!turnColumns.some((column) => column.name === "lease_deadline_at_ms")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE turns ADD COLUMN lease_deadline_at_ms INTEGER",
        );
      }
      if (!turnColumns.some((column) => column.name === "subscriptions_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE turns ADD COLUMN subscriptions_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (!turnColumns.some((column) => column.name === "fingerprint")) {
        this.ctx.storage.sql.exec("ALTER TABLE turns ADD COLUMN fingerprint TEXT");
      }
      if (!turnColumns.some((column) => column.name === "outcome")) {
        this.ctx.storage.sql.exec("ALTER TABLE turns ADD COLUMN outcome TEXT");
      }
      // Settlement order (`settled_seq`) and the index that reads it, in
      // one transaction: a boot between the column and its backfill would
      // otherwise leave settled turns without an order for good. Turns
      // settled before the column existed keep the order they had, which
      // was updated_at then rowid, numbered from 1; every settlement from
      // here on takes a value above the highest, so a legacy row never
      // ties with a new one. The index used to be over updated_at under
      // the same name: an object that carries that shape rebuilds it.
      this.ctx.storage.transactionSync(() => {
        if (!turnColumns.some((column) => column.name === "settled_seq")) {
          this.ctx.storage.sql.exec("ALTER TABLE turns ADD COLUMN settled_seq INTEGER");
          this.ctx.storage.sql.exec(
            `UPDATE turns
             SET settled_seq = settled.position
             FROM (
               SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at, rowid) AS position
               FROM turns
               WHERE status IN ('completed', 'failed', 'cancelled')
             ) AS settled
             WHERE turns.id = settled.id`,
          );
        }
        const settledIndex = this.ctx.storage.sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'turns_settled'",
          )
          .toArray()[0];
        if (settledIndex && !settledIndex.sql?.includes("settled_seq")) {
          this.ctx.storage.sql.exec("DROP INDEX turns_settled");
        }
        this.ctx.storage.sql.exec(
          `CREATE INDEX IF NOT EXISTS turns_settled
           ON turns(settled_seq DESC)
           WHERE settled_seq IS NOT NULL`,
        );
      });
      const renderColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(agent_renders)")
        .toArray();
      if (!renderColumns.some((column) => column.name === "required_connections_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE agent_renders ADD COLUMN required_connections_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (!renderColumns.some((column) => column.name === "enabled_mcp_servers_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE agent_renders ADD COLUMN enabled_mcp_servers_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (!renderColumns.some((column) => column.name === "instructions")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE agent_renders ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!renderColumns.some((column) => column.name === "platform_instructions_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE agent_renders ADD COLUMN platform_instructions_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (!renderColumns.some((column) => column.name === "input_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE agent_renders ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}'",
        );
      }
      if (!renderColumns.some((column) => column.name === "tools_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE agent_renders ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      const deliveryColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(slack_deliveries)")
        .toArray();
      if (
        !deliveryColumns.some(
          (column) => column.name === "progress_message_timestamp",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE slack_deliveries ADD COLUMN progress_message_timestamp TEXT",
        );
      }
      if (!deliveryColumns.some((column) => column.name === "external_user_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE slack_deliveries ADD COLUMN external_user_id TEXT",
        );
      }
      // Deliveries are outbound addressing, and every provider addresses
      // differently: Slack needs a channel and a thread, SMS needs a number.
      // `provider` says which adapter owns the row and `delivery_ref` carries
      // whatever that adapter needs to reply, so the table stops describing
      // Slack in its column names. Continuity is not stored here — that is
      // `channel_threads` on the account, which is already provider-neutral.
      if (!deliveryColumns.some((column) => column.name === "provider")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE slack_deliveries ADD COLUMN provider TEXT",
        );
      }
      if (!deliveryColumns.some((column) => column.name === "delivery_ref")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE slack_deliveries ADD COLUMN delivery_ref TEXT",
        );
      }
      // Retry and lease bookkeeping, the same shape as outcome deliveries:
      // when the next attempt may run, and until when one is in flight.
      if (!deliveryColumns.some((column) => column.name === "next_attempt_at_ms")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE slack_deliveries ADD COLUMN next_attempt_at_ms INTEGER",
        );
        // Before this column, `failed` with attempts to spare meant "retry on
        // the next alarm"; now `failed` is final and only `pending` is looked
        // at. Rows the old code still meant to retry become pending, due now,
        // with their attempts kept. Rows it had given up on stay failed.
        this.ctx.storage.sql.exec(
          `UPDATE slack_deliveries
           SET status = 'pending', next_attempt_at_ms = ?
           WHERE status = 'failed' AND attempts < ?`,
          Date.now(),
          CHANNEL_DELIVERY_BACKOFF_MS.length + 1,
        );
      }
      if (!deliveryColumns.some((column) => column.name === "lease_until_ms")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE slack_deliveries ADD COLUMN lease_until_ms INTEGER",
        );
      }
      // When the admission ack would land: NULL once sent or moot (the turn
      // settled first). The session alarm walks rows whose time has come.
      if (!deliveryColumns.some((column) => column.name === "ack_due_at_ms")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE slack_deliveries ADD COLUMN ack_due_at_ms INTEGER",
        );
      }
      // Backfill in TypeScript rather than SQL so the JSON is escaped by the
      // same code that will later read it back.
      const unmigrated = this.ctx.storage.sql
        .exec<{
          turn_id: string;
          channel_id: string;
          thread_timestamp: string;
        }>(
          `SELECT turn_id, channel_id, thread_timestamp
           FROM slack_deliveries
           WHERE provider IS NULL OR delivery_ref IS NULL`,
        )
        .toArray();
      for (const row of unmigrated) {
        this.ctx.storage.sql.exec(
          `UPDATE slack_deliveries
           SET provider = 'slack', delivery_ref = ?
           WHERE turn_id = ?`,
          JSON.stringify({
            channelId: row.channel_id,
            threadTimestamp: row.thread_timestamp,
          }),
          row.turn_id,
        );
      }
      const sessionColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(session)")
        .toArray();
      if (!sessionColumns.some((column) => column.name === "user_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN user_id TEXT NOT NULL DEFAULT ''",
        );
      }
      if (
        !sessionColumns.some((column) => column.name === "runtime_start_state")
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN runtime_start_state TEXT NOT NULL DEFAULT 'unclaimed'",
        );
      }
      if (
        !sessionColumns.some(
          (column) => column.name === "runtime_start_attempt",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN runtime_start_attempt INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!sessionColumns.some((column) => column.name === "execution_mode")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'microvm'",
        );
      }
      if (!sessionColumns.some((column) => column.name === "environment")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN environment TEXT",
        );
      }
      if (!sessionColumns.some((column) => column.name === "identity_environment")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN identity_environment TEXT",
        );
      }
      if (!sessionColumns.some((column) => column.name === "memory_object")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN memory_object TEXT",
        );
      }
      if (!sessionColumns.some((column) => column.name === "project_id")) {
        this.ctx.storage.sql.exec("ALTER TABLE session ADD COLUMN project_id TEXT");
      }
      if (!sessionColumns.some((column) => column.name === "source")) {
        this.ctx.storage.sql.exec("ALTER TABLE session ADD COLUMN source TEXT");
      }
      if (!sessionColumns.some((column) => column.name === "labels_json")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN labels_json TEXT NOT NULL DEFAULT '{}'",
        );
      }
      if (!sessionColumns.some((column) => column.name === "labels_updated_at")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN labels_updated_at TEXT",
        );
      }
      if (!sessionColumns.some((column) => column.name === "revision")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!sessionColumns.some((column) => column.name === "creation_json")) {
        this.ctx.storage.sql.exec("ALTER TABLE session ADD COLUMN creation_json TEXT");
      }
      for (const [column, definition] of [
        ["countable", "INTEGER NOT NULL DEFAULT 1"],
        ["exclusion_reason", "TEXT"],
        ["outcome_at", "TEXT"],
        ["runtime_edge", "TEXT"],
      ] as const) {
        if (!sessionColumns.some((existing) => existing.name === column)) {
          this.ctx.storage.sql.exec(
            `ALTER TABLE session ADD COLUMN ${column} ${definition}`,
          );
        }
      }
      const workerdSessionColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(workerd_session)")
        .toArray();
      if (
        !workerdSessionColumns.some(
          (column) => column.name === "runtime_session_id",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE workerd_session ADD COLUMN runtime_session_id TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!workerdSessionColumns.some((column) => column.name === "runtime_boot_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE workerd_session ADD COLUMN runtime_boot_id TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!workerdSessionColumns.some((column) => column.name === "runtime_activation")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE workerd_session ADD COLUMN runtime_activation INTEGER NOT NULL DEFAULT 0",
        );
      }
      const resultColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(session_result)")
        .toArray();
      if (!resultColumns.some((column) => column.name === "message_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session_result ADD COLUMN message_id TEXT",
        );
      }
      const billingSegmentColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(runtime_billing_segments)")
        .toArray();
      if (
        !billingSegmentColumns.some(
          (column) => column.name === "delivery_attempts",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE runtime_billing_segments ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (
        !billingSegmentColumns.some(
          (column) => column.name === "next_delivery_at_ms",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE runtime_billing_segments ADD COLUMN next_delivery_at_ms INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!billingSegmentColumns.some((column) => column.name === "last_error")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE runtime_billing_segments ADD COLUMN last_error TEXT",
        );
      }
      ensureMemorySessionSchema(this.ctx.storage.sql);
      ensureQuestionSchema(this.ctx.storage.sql);
      ensureConsultSchema(this.ctx.storage.sql);
    });
  }

  /**
   * Admits the session once. The winner is decided here, before any side
   * effect: the object runs one event at a time, so between the check and
   * the claim no other caller runs. A caller that finds an admission in
   * flight waits for it and answers the session it produced, and a caller
   * that finds the session already admitted answers it at once; neither
   * touches the runtime, the pool or the row. If the admission in flight
   * fails, the next caller in line claims with its own input.
   */
  async initialize(
    input: InitializeSessionInput,
  ): Promise<InitializeSessionOutcome> {
    for (;;) {
      if (this.readSession()) {
        return { outcome: "existing", session: this.snapshot() };
      }
      if (!this.initialization) break;
      await this.initialization.catch(() => undefined);
    }
    const admission = this.admit(input);
    this.initialization = admission;
    try {
      return { outcome: "created", ...(await admission) };
    } finally {
      if (this.initialization === admission) this.initialization = undefined;
    }
  }

  private async admit(
    input: InitializeSessionInput,
  ): Promise<InitializeSessionResult> {
    if (input.memory?.length && (!input.memoryObject || !input.environment)) {
      throw new Error("Memory bindings need the environment and the Memory DO they are admitted against");
    }

    const latency = latencyTelemetry(this.env, "session", {
      session_key: input.id,
    });
    const resolving = latency.start("session_admit.resolved");
    // Session admission, rather than first provider dispatch, owns route
    // pinning. This closes the race where project settings change after a
    // session is created but before OpenCode makes its first model request.
    const account = this.env.ACCOUNTS.getByName(input.accountId);
    const project = await account.projectForAgent(input.agentId);
    const deployment =
      input.deployment ?? (await account.getDeployment(input.deploymentId));
    let pinnedModelRoute: ModelRoute | null = null;
    let runtimeModelRoute:
      | {
          model: string;
          protocol: "anthropic_messages" | "chat_completions" | "responses";
        }
      | undefined;
    // The environment the session's runtime configuration resolves to: the
    // request's, else the alias of the pinned deployment (the same rule the
    // edge applies per request). Frozen here so tool identity keeps it after
    // the alias moves.
    const identityEnvironment: MemoryEnvironment | undefined =
      input.environment ??
      (deployment
        ? (environmentOfMode(project?.environmentMode ?? "legacy", deployment.alias) ??
          (project?.environmentMode === "single" ? "default" : "development"))
        : undefined);
    if (project && deployment && identityEnvironment) {
      const environment = identityEnvironment;
      const routes = await account.listModelRoutes(project.id, environment);
      const route =
        routes.find((candidate: ModelRoute) => candidate.agentId === input.agentId) ??
        routes.find((candidate: ModelRoute) => !candidate.agentId) ??
        null;
      pinnedModelRoute = this.pinModelRoute(route);
      if (pinnedModelRoute) {
        const connection = await account.getModelAccessConnection(
          pinnedModelRoute.connectionId,
        );
        if (connection) {
          runtimeModelRoute = {
            model: pinnedModelRoute.model,
            protocol:
              connection.kind === "codex_subscription"
                ? "responses"
                : connection.kind === "claude_subscription"
                  ? "anthropic_messages"
                  : "chat_completions",
          };
        }
      }
    } else {
      this.pinModelRoute(null);
    }
    resolving.end();

    const runtimeToken = crypto.randomUUID();
    const runtimeTokenHash = await sha256(runtimeToken);
    const timestamp = now();
    const executionMode: SessionExecutionMode =
      input.executionMode ??
      (sessionRunsOnWorkerd(this.env, input.accountId) ? "workerd" : "microvm");
    let runtimeActivation = 0;
    let runtimeInitMs = 0;
    let runtimeBootId = "";
    let runtimeSessionId = "";
    let opencodeSessionId = "";
    let prewarmStandbyMs = 0;
    let prewarmHit = false;
    let prewarmFallback = false;

    if (executionMode === "workerd") {
      const runtimeReady = latency.start("session_admit.runtime_ready");
      await this.initialized;
      const createWorkerdSession = async (): Promise<void> => {
        const response = await this.workerdRuntime().fetch(
          "https://workerd-runtime.invalid/sessions",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...regionHeaders(input.deployment?.region),
            },
            body: JSON.stringify({
              deployment: input.deployment,
              ...(runtimeModelRoute ? { modelRoute: runtimeModelRoute } : {}),
              ...(input.runtimeEdge
                ? {
                    sandboxContext: {
                      accountId: input.accountId,
                      managedSessionId: input.id,
                      edge: input.runtimeEdge,
                      runtimeToken,
                      ...(input.sharedWorkspaceSessionId
                        ? { sharedWorkspaceSessionId: input.sharedWorkspaceSessionId }
                        : {}),
                    },
                  }
                : {}),
              ...(input.memory?.length && input.memoryObject
                ? {
                    memory: {
                      objectName: input.memoryObject,
                      sessionId: input.id,
                      bindings: input.memory,
                    },
                  }
                : {}),
            }),
          },
        );
        const body = (await response.json()) as {
          id?: unknown;
          error?: unknown;
        };
        const returnedRuntimeSessionId = response.headers.get(
          "x-opencomputer-session",
        );
        runtimeBootId =
          response.headers.get("x-opencomputer-runtime-boot") ?? "";
        runtimeActivation = Number(
          response.headers.get("x-opencomputer-runtime-activation") ?? 0,
        );
        runtimeInitMs = Number(
          response.headers.get("x-opencomputer-runtime-init-ms") ?? 0,
        );
        if (
          !response.ok ||
          !returnedRuntimeSessionId ||
          typeof body.id !== "string"
        ) {
          const detail =
            typeof body.error === "string" && body.error
              ? `: ${body.error}`
              : "";
          throw new Error(
            `The Workerd OpenCode runtime could not create a session (${response.status})${detail}`,
          );
        }
        runtimeSessionId = returnedRuntimeSessionId;
        opencodeSessionId = body.id;
      };
      if (input.workerdLease && !runtimeModelRoute) {
        runtimeSessionId = input.workerdLease.runtimeSessionId;
        opencodeSessionId = input.workerdLease.opencodeSessionId;
        runtimeBootId = input.workerdLease.runtimeBootId;
        runtimeActivation = input.workerdLease.runtimeActivation;
        runtimeInitMs = input.workerdLease.runtimeInitMs;
        prewarmStandbyMs = Math.max(
          0,
          Date.now() - new Date(input.workerdLease.createdAt).getTime(),
        );
      } else {
        await createWorkerdSession();
      }
      if (input.workerdLease && !runtimeModelRoute && input.runtimeEdge) {
        const response = await this.workerdRuntime().fetch(
          `https://workerd-runtime.invalid/sessions/${encodeURIComponent(runtimeSessionId)}/sandbox-context`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accountId: input.accountId,
              managedSessionId: input.id,
              edge: input.runtimeEdge,
              runtimeToken,
              ...(input.sharedWorkspaceSessionId
                ? { sharedWorkspaceSessionId: input.sharedWorkspaceSessionId }
                : {}),
              // A pooled Workerd was initialized before an account was
              // selected, so pin the account-resolved lazy-sandbox image at
              // claim time as well as the session credentials.
              deployment: input.deployment,
            }),
          },
        );
        if (!response.ok) {
          prewarmFallback = true;
          await createWorkerdSession();
        } else {
          prewarmHit = true;
        }
      } else if (input.workerdLease && !runtimeModelRoute) {
        prewarmHit = true;
      }
      runtimeReady.end({
        data: {
          prewarm: prewarmFallback ? "fallback" : prewarmHit ? "hit" : "miss",
        },
      });
    }
    latency.send(this.ctx);

    this.ctx.storage.transactionSync(() => {
      if (executionMode === "workerd") {
        // In the same transaction as the row: a session either has its
        // runtime slot or does not exist.
        this.ctx.storage.sql.exec(
          `INSERT INTO workerd_session (
             slot, runtime_session_id, opencode_session_id,
             runtime_boot_id, runtime_activation
          ) VALUES (1, ?, ?, ?, ?)`,
          runtimeSessionId,
          opencodeSessionId,
          runtimeBootId,
          Number.isFinite(runtimeActivation) ? runtimeActivation : 0,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO session (
           id, account_id, user_id, agent_id, deployment_id, execution_mode, status,
           runtime_epoch, runtime_token_hash, environment, identity_environment, memory_object,
           project_id, source, labels_json, labels_updated_at, revision,
           creation_json, created_at, updated_at, runtime_edge
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
        input.id,
        input.accountId,
        input.userId,
        input.agentId,
        input.deploymentId,
        executionMode,
        executionMode === "workerd" ? "idle" : "new",
        runtimeTokenHash,
        input.environment ?? null,
        identityEnvironment ?? null,
        input.memory?.length && input.memoryObject ? input.memoryObject : null,
        input.projectId ?? `project:${input.agentId}`,
        input.source ?? "api",
        JSON.stringify(input.labels ?? {}),
        input.creation ? JSON.stringify(input.creation) : null,
        timestamp,
        timestamp,
        input.runtimeEdge ?? null,
      );
      this.appendEvent(
        "session.created",
        undefined,
        {
          agentId: input.agentId,
          deploymentId: input.deploymentId,
        },
        timestamp,
      );
      if (input.memory?.length && input.memoryObject) {
        recordMemoryAdmission(this.ctx.storage.sql, input.memory, input.memoryObject, timestamp);
      }
      if (executionMode === "workerd") {
        this.appendEvent(
          "runtime.log",
          undefined,
          {
            phase: prewarmHit
              ? "workerd_prewarm_hit"
              : prewarmFallback
                ? "workerd_prewarm_fallback"
                : "workerd_prewarm_miss",
            runtime: "workerd",
            prewarmHit,
            standbyAgeMs: prewarmHit ? prewarmStandbyMs : 0,
            checkoutMs: input.workerdPoolCheckoutMs ?? 0,
            message: prewarmHit
              ? `Prewarmed agent runtime claimed · stood by ${Math.round(prewarmStandbyMs)} ms · checkout ${Math.round(input.workerdPoolCheckoutMs ?? 0)} ms`
              : prewarmFallback
                ? "Prewarmed agent runtime was stale · created a fresh runtime on demand"
                : "No prewarmed agent runtime was ready · created on demand",
          },
          timestamp,
        );
        this.appendEvent(
          "runtime.log",
          undefined,
          {
            phase: "workerd_session_ready",
            runtime: "workerd",
            activation: Number.isFinite(runtimeActivation) ? runtimeActivation : 0,
            initializationMs: Number.isFinite(runtimeInitMs) ? runtimeInitMs : 0,
            message: `Agent runtime ready in its Durable Object · activation ${Number.isFinite(runtimeActivation) ? runtimeActivation : 0} · OpenCode initialized in ${Number.isFinite(runtimeInitMs) ? Math.round(runtimeInitMs) : 0} ms`,
          },
          timestamp,
        );
        this.appendEvent(
          "runtime.connected",
          undefined,
          {
            runtimeId: runtimeSessionId,
            epoch: 0,
            runtime: "workerd",
          },
          timestamp,
        );
        this.appendEvent(
          "session.status_changed",
          undefined,
          { from: "new", to: "idle" },
          timestamp,
        );
      }
    });

    const memoryAdmission = input.memory?.length
      ? await this.driveMemoryAdmission()
      : undefined;
    // The created row is owed to the projection; the caller publishes it
    // synchronously, and the alarm delivers if the caller dies first.
    await this.scheduleAlarm();

    return {
      session: this.snapshot(),
      runtimeToken,
      ...(input.workerdLease && runtimeModelRoute
        ? { unusedWorkerdLease: true }
        : {}),
      ...(memoryAdmission ? { memoryAdmission } : {}),
    };
  }

  snapshotOrNull(): SessionSnapshot | null {
    return this.readSession() ? this.snapshot() : null;
  }

  /**
   * A retried create for a session whose admission is still pending resumes
   * the grant RPC instead of returning early. Answers the current state.
   */
  async resumeMemoryAdmission(): Promise<MemoryAdmissionState | undefined> {
    this.requireSession();
    return this.driveMemoryAdmission();
  }

  /** Bindings with `writable` as the Memory DO sees it now; for session inspection. */
  async memoryBindings(): Promise<SessionMemoryBinding[] | undefined> {
    const session = this.requireSession();
    return liveMemoryBindings(
      this.ctx.storage.sql,
      this.env as Env & MemorySessionEnv,
      session.id,
      session.status === "ended",
    );
  }

  /**
   * The alarm is armed to the RPC deadline before the grant call leaves,
   * so an object that dies with the call in flight is woken to re-drive it.
   */
  private async driveMemoryAdmission(): Promise<MemoryAdmissionState | undefined> {
    const session = this.requireSession();
    const state = await driveMemoryAdmission(
      this.ctx.storage,
      this.env as Env & MemorySessionEnv,
      session.id,
      () => this.scheduleAlarm(),
    );
    if (state?.state === "pending") await this.scheduleAlarm();
    if (state?.state === "rejected") await this.settleRejectedAdmission();
    return state;
  }

  /**
   * A refused admission is terminal: the session was never usable, so it
   * ends the way an initial refusal does (the create path ends it too; the
   * second end is a no-op), whether the refusal arrived on the first call
   * or from a deferred re-drive.
   */
  private async settleRejectedAdmission(): Promise<void> {
    const session = this.readSession();
    if (!session || session.status === "ended") return;
    if (readMemoryAdmission(this.ctx.storage.sql)?.state !== "rejected") return;
    await this.end();
  }

  /**
   * Whether a keyed turn was committed here, regardless of session status.
   * Recovery of a deferred admission decides on this answer alone; nothing
   * about the session's lifecycle proves or disproves an admission.
   */
  findTurn(idempotencyKey: string): { turnId: string; status: TurnStatus } | null {
    if (!this.readSession()) return null;
    const row = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id" | "status">>(
        "SELECT id, status FROM turns WHERE idempotency_key = ?",
        idempotencyKey,
      )
      .toArray()[0];
    return row ? { turnId: row.id, status: row.status as TurnStatus } : null;
  }

  /**
   * The receipt of a key that was held behind a question: held or
   * discarded, or the receipt of the turn that carried it as steering. The
   * same key with other content is an idempotency conflict, as for turns.
   */
  private heldTurnReceipt(key: string, fingerprint: string): TurnReceipt | undefined {
    const held = heldReceipt(this.ctx.storage.sql, key, fingerprint);
    if (!held) return undefined;
    if (held.kind === "conflict") {
      throw new Error(
        `${IDEMPOTENCY_CONFLICT}: the idempotency key was already used with different input, payload, or mode`,
      );
    }
    if (held.kind === "delivered") {
      return { turnId: held.turnId, status: held.status, duplicate: true };
    }
    return held.receipt;
  }

  async enqueueTurn(input: EnqueueTurnInput): Promise<TurnReceipt> {
    const mode = input.mode ?? "queue";
    const agentInput = input.agentInput ?? {
      source: "user" as const,
      text: input.input,
    };
    // What the key stands for. A replay of the same request answers with
    // the original receipt; the same key with another request is refused,
    // never a silent second admission and never a silent no-op.
    const fingerprint = await turnFingerprint({
      input: input.input,
      mode,
      ...(agentInput.payload !== undefined ? { payload: agentInput.payload } : {}),
      ...(input.answers !== undefined ? { answers: input.answers } : {}),
    });
    const findExisting = () =>
      this.ctx.storage.sql
        .exec<
          Pick<TurnRow, "id" | "status" | "fingerprint">
        >("SELECT id, status, fingerprint FROM turns WHERE idempotency_key = ?", input.idempotencyKey)
        .toArray()[0];
    // A keyed turn already committed answers with its original receipt no
    // matter what the session has become since; only new work is refused.
    // Turns admitted before fingerprints were recorded carry none and
    // answer as they always did.
    const receipt = (
      committed: Pick<TurnRow, "id" | "status" | "fingerprint">,
    ): EnqueueTurnResult => {
      if (committed.fingerprint !== null && committed.fingerprint !== fingerprint) {
        throw new Error(
          `${IDEMPOTENCY_CONFLICT}: the idempotency key was already used with different input, payload, or mode`,
        );
      }
      return { turnId: committed.id, status: committed.status, duplicate: true };
    };
    // A key held behind a question answers with its held receipt, or with
    // the receipt of the turn that carried it as steering. First: a turn
    // queued behind the asking turn was converted into a held input, and
    // its `cancelled` turn row is not what happened to its content.
    const held = this.heldTurnReceipt(input.idempotencyKey, fingerprint);
    if (held) return held;
    const existing = findExisting();
    if (existing) return receipt(existing);
    // Only an issued admission admits turns: pending is unconfirmed,
    // rejected is a session that was never usable (and is ended, which is
    // the less specific answer).
    const admission = readMemoryAdmission(this.ctx.storage.sql);
    if (admission?.state === "pending") {
      throw new Error(
        `${MEMORY_ADMISSION_PENDING}: memory grants are not confirmed yet; retry the session creation`,
      );
    }
    if (admission && admission.state !== "issued") {
      throw new Error(
        `${MEMORY_ADMISSION_REJECTED}: memory bindings were refused (${admission.reason ?? "rejected"}); the session is unusable`,
      );
    }
    if (this.requireSession().status === "ended") {
      throw new Error(`${SESSION_ENDED}: the session has ended and accepts no new turns`);
    }

    if (!input.input.trim()) {
      throw new Error("Turn input must not be empty");
    }

    if (mode !== "queue" && mode !== "steer" && mode !== "interrupt") {
      throw new Error("Turn mode must be queue, steer, or interrupt");
    }
    const encodedAgentInput = JSON.stringify(agentInput);
    if (encodedAgentInput.length > STRUCTURED_INPUT_LIMIT) {
      throw new Error("Structured turn input cannot exceed 256 KiB");
    }

    // Subscriptions are captured with the admission, from the project the
    // agent belongs to. Everything below is synchronous, so the duplicate
    // check is repeated after the gap.
    const subscriptions = await this.captureEventSubscriptions();
    const committedMeanwhile = findExisting();
    if (committedMeanwhile) return receipt(committedMeanwhile);
    if (this.requireSession().status === "ended") {
      throw new Error(`${SESSION_ENDED}: the session has ended and accepts no new turns`);
    }

    // The question state decides what this input is (design 018): an
    // answer, steering held until the answer, an ordinary turn beside a
    // question that does not hold (`flow`, Slack), or a reference to a
    // question that is not open. Nothing below awaits, so the decision and
    // the admission are one step.
    const heldMeanwhile = this.heldTurnReceipt(input.idempotencyKey, fingerprint);
    if (heldMeanwhile) return heldMeanwhile;
    const questionAdmission = classifyAdmission(this.ctx.storage.sql, input, (question) =>
      this.questionModeOf(question),
    );
    if (questionAdmission.kind === "stale") {
      throw new Error(
        `${QUESTION_STALE}: question ${questionAdmission.questionId} is not the session's open question`,
      );
    }
    if (questionAdmission.kind === "hold") {
      const questionId = questionAdmission.question.id;
      const timestamp = now();
      const held = this.ctx.storage.transactionSync(() => {
        const stored = holdInput(this.ctx.storage.sql, {
          key: input.idempotencyKey,
          questionId,
          input: heldInputOf(agentInput, input.input, timestamp, input.providerTime),
          fingerprint,
          inputText: input.input,
          agentInput,
          subscriptionsJson: JSON.stringify(subscriptions),
        });
        if (!stored) return undefined;
        return {
          id: stored.id,
          events: [this.appendEvent("message.held", undefined, heldEventData(stored), timestamp)],
        };
      });
      if (!held) {
        // Unreachable: the key was checked above with nothing awaited since.
        const again = this.heldTurnReceipt(input.idempotencyKey, fingerprint);
        if (again) return again;
        throw new Error("Held input was not recorded");
      }
      this.broadcastEvents(held.events);
      return { status: "held", questionId, heldId: held.id, duplicate: false } satisfies HeldTurnReceipt;
    }

    const activeTurns = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id">>(
        "SELECT id FROM turns WHERE status = 'running' ORDER BY created_at, rowid",
      )
      .toArray();
    const runtime = this.ctx
      .getWebSockets("role:runtime")
      .find((socket) => socket.readyState === WebSocket.OPEN);
    const shouldSteer = mode === "steer" && activeTurns.length > 0 && runtime;

    const turnId = crypto.randomUUID();
    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() => {
      // An answer resolves the question and carries the held inputs with it,
      // in the same transaction that admits its turn: as many as fit in
      // `steering`, the rest as ordinary turns right after it. The turn's
      // own input was bounded above; what it carries is bounded by the
      // steering limits, so an answer is never refused for what was held.
      const answered =
        questionAdmission.kind === "answer"
          ? this.answerInTransaction(
              questionAdmission.question,
              agentInput.text ?? input.input,
              turnId,
              timestamp,
            )
          : undefined;
      const admittedInput = answered
        ? JSON.stringify(answered.withAnswer(agentInput))
        : encodedAgentInput;
      this.ctx.storage.sql.exec(
        `INSERT INTO turns (
           id, input, input_json, mode, status, idempotency_key, fingerprint,
           subscriptions_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        turnId,
        input.input,
        admittedInput,
        mode,
        shouldSteer ? "running" : "queued",
        input.idempotencyKey,
        fingerprint,
        JSON.stringify(subscriptions),
        timestamp,
        timestamp,
      );
      const output = [
        this.appendEvent(
          "message.received",
          turnId,
          {
            input: input.input,
            mode,
            ...(agentInput.payload !== undefined ? { payload: agentInput.payload } : {}),
          },
          timestamp,
        ),
      ];
      if (answered) output.push(...answered.answeredEvents());
      // A delivered outcome on a session that talks in Slack answers in the
      // thread it last answered in (slack-ux P1). Event turns only: a turn
      // started from the API or the dashboard is not a reply to anyone in
      // the thread and stays where it was asked. An answering event turn
      // already holds the asking turn's row, which `ON CONFLICT` keeps.
      if (agentInput.source === "event") {
        const latest = this.latestChannelDelivery();
        if (latest?.provider === "slack") {
          this.inheritChannelDelivery(turnId, latest.turnId, timestamp);
        }
      }
      if (mode === "interrupt" && activeTurns.length > 0) {
        const session = this.requireSession();
        if (session.execution_mode === "workerd") {
          // The running turn stays running until the host has settled it;
          // its `turn.cancelled` names this turn as the replacement then.
          output.push(
            this.appendEvent(
              "turn.interrupted",
              turnId,
              { interruptedTurnIds: activeTurns.map((turn) => turn.id) },
              timestamp,
            ),
            this.recordWorkerdStop(activeTurns[0]!.id, "interrupted", timestamp, {
              replacementTurnId: turnId,
            }),
            ...this.markStopping(session, timestamp),
          );
        } else {
          for (const active of activeTurns) {
            if (!this.settleTurn(active.id, "cancelled", timestamp)) continue;
            const cancelled = this.appendEvent(
              "turn.cancelled",
              active.id,
              { reason: "interrupted", replacementTurnId: turnId },
              timestamp,
            );
            this.recordOutcomeDeliveries(active.id, cancelled);
            output.push(cancelled);
          }
          output.push(
            this.appendEvent(
              "turn.interrupted",
              turnId,
              { interruptedTurnIds: activeTurns.map((turn) => turn.id) },
              timestamp,
            ),
          );
        }
      }
      output.push(
        shouldSteer
          ? this.appendEvent(
              "turn.steered",
              turnId,
              { activeTurnId: activeTurns[0]!.id },
              timestamp,
            )
          : this.appendEvent("turn.queued", turnId, { mode }, timestamp),
      );
      if (answered) output.push(...answered.overflowTurns());
      return output;
    });

    this.broadcastEvents(events);
    // An answer retires its question's card, whoever gave it (slack-ux P2).
    this.refreshQuestionCardsFor(events);
    if (mode === "interrupt" && activeTurns.length > 0) {
      this.ctx.waitUntil(this.scheduleAlarm());
    }
    if (shouldSteer) {
      runtime.send(
        encodeFrame({
          type: "turn.steer",
          turnId,
          input: input.input,
          activeTurnId: activeTurns[0]!.id,
        }),
      );
    } else if (
      mode === "interrupt" &&
      activeTurns.length > 0 &&
      this.requireSession().execution_mode === "workerd"
    ) {
      // The cancelled turn is settled and the stop is recorded; the host is
      // told to stop and the replacement dispatches once it has answered
      // (or from the alarm, if this attempt dies), so nothing races the
      // loop it replaces.
      this.ctx.waitUntil(this.driveWorkerdStop());
    } else {
      if (mode === "interrupt" && activeTurns.length > 0 && runtime) {
        runtime.send(
          encodeFrame({ type: "turn.cancel", turnId: activeTurns[0]!.id }),
        );
      }
      this.dispatchNextTurn();
    }

    return {
      turnId,
      status: shouldSteer ? "running" : "queued",
      duplicate: false,
    };
  }

  authenticateRuntimeToken(token: string): Promise<boolean> {
    return this.verifyRuntimeToken(token);
  }

  /**
   * Applies a control delivery (design 018, Stop) in one transaction: the
   * running turn is interrupted the way `interrupt()` interrupts it (on
   * Workerd the stop is recorded and the turn settles `cancelled` with
   * reason `stopped` once the host has acknowledged), every queued turn and
   * held input is discarded, the open question is closed as `stopped`, and
   * the control is recorded with its result. Idempotent on the delivery id:
   * a repeat returns the recorded result and touches nothing admitted after
   * the first application. With no turn running, the confirming "Stopped."
   * is enqueued here; otherwise the cancelled turn's settlement produces it
   * (work 037 S3).
   */
  async applyControl(input: SessionControlInput): Promise<SessionControlResult> {
    const sql = this.ctx.storage.sql;
    const recorded = recordedControl(sql, input.deliveryId);
    if (recorded) return recorded;
    if (input.kind !== "stop") {
      throw new Error(`Unsupported session control ${String(input.kind)}`);
    }
    const session = this.requireSession();
    const timestamp = now();
    const applied = this.ctx.storage.transactionSync(() => {
      const again = recordedControl(sql, input.deliveryId);
      if (again) return { result: again, events: [] as AgentEvent[], workerdStop: false, cancelled: [] as string[] };
      const events: AgentEvent[] = [];
      const active = sql
        .exec<Pick<TurnRow, "id">>(
          "SELECT id FROM turns WHERE status = 'running' ORDER BY created_at, rowid",
        )
        .toArray();
      const cancelled: string[] = [];
      let workerdStop = false;
      if (active.length > 0) {
        if (session.execution_mode === "workerd") {
          events.push(
            this.recordWorkerdStop(active[0]!.id, "stopped", timestamp),
            ...this.markStopping(session, timestamp),
          );
          workerdStop = true;
        } else {
          for (const turn of active) {
            if (!this.settleTurn(turn.id, "cancelled", timestamp)) continue;
            const event = this.appendEvent("turn.cancelled", turn.id, { reason: "stopped" }, timestamp);
            this.recordOutcomeDeliveries(turn.id, event);
            events.push(event);
            cancelled.push(turn.id);
          }
          if (session.status === "running") {
            sql.exec(
              "UPDATE session SET status = 'idle', updated_at = ? WHERE id = ?",
              timestamp,
              session.id,
            );
            events.push(
              this.appendEvent("session.status_changed", undefined, { from: "running", to: "idle" }, timestamp),
            );
          }
        }
      }
      const discardedTurnKeys: string[] = [];
      for (const queued of sql
        .exec<Pick<TurnRow, "id" | "idempotency_key">>(
          "SELECT id, idempotency_key FROM turns WHERE status = 'queued' ORDER BY created_at, rowid",
        )
        .toArray()) {
        if (!this.settleTurn(queued.id, "cancelled", timestamp, "outstanding")) continue;
        const event = this.appendEvent(
          "turn.cancelled",
          queued.id,
          { reason: "stopped", discarded: true },
          timestamp,
        );
        this.recordOutcomeDeliveries(queued.id, event);
        events.push(event);
        discardedTurnKeys.push(queued.idempotency_key);
      }
      for (const held of discardHeldInputs(sql, timestamp)) {
        discardedTurnKeys.push(held.key);
        events.push(this.heldDiscardedEvent(held, "stopped", timestamp));
      }
      const closed = closeOpenQuestion(sql, "stopped", timestamp, (type, data) =>
        this.appendEvent(type, undefined, data, timestamp),
      );
      events.push(...closed.events);
      const result: SessionControlResult = {
        deliveryId: input.deliveryId,
        duplicate: false,
        appliedAt: timestamp,
        ...(active[0] ? { interruptedTurnId: active[0].id } : {}),
        discardedTurnKeys,
        ...(closed.questionId ? { closedQuestionId: closed.questionId } : {}),
      };
      recordControl(sql, input, result);
      if (active.length === 0) {
        // Nothing is running whose settlement could confirm the stop.
        enqueueLinearActivity(this.ctx.storage, {
          kind: "terminal",
          content: { type: "error", body: LINEAR_STOPPED_TEXT },
        });
      }
      return { result, events, workerdStop, cancelled };
    });
    this.broadcastEvents(applied.events);
    this.refreshQuestionCardsFor(applied.events);
    this.ctx.waitUntil(this.scheduleAlarm());
    if (applied.workerdStop) {
      this.ctx.waitUntil(this.driveWorkerdStop());
    } else if (applied.cancelled.length) {
      const runtime = this.ctx
        .getWebSockets("role:runtime")
        .find((socket) => socket.readyState === WebSocket.OPEN);
      for (const turnId of applied.cancelled) {
        runtime?.send(encodeFrame({ type: "turn.cancel", turnId }));
      }
      this.dispatchNextTurn();
    }
    return applied.result;
  }

  // ── Linear ingress RPCs (work 037 review D3, R3) ────────────────────────────

  /**
   * Whether the Account object may supersede this session on its Linear
   * session: its activity queue has nothing left to post, or the drain window
   * of an ended session has passed. Read-only.
   */
  linearQueueDrained(): boolean {
    return linearQueueDrained(this.ctx.storage);
  }

  /**
   * Enqueue a terminal `error` activity behind everything this session has
   * queued for its Linear session (the ingress's failure notice), once per
   * `key`. False when no Linear input reached this session, so the caller
   * posts the notice itself.
   */
  enqueueLinearTerminal(input: { key: string; body: string }): boolean {
    if (!this.readSession() || !linearBinding(this.ctx.storage)) return false;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS linear_terminal_requests (
        key TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.transactionSync(() => {
      const fresh = sql.exec(
        `INSERT INTO linear_terminal_requests (key, created_at_ms) VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING`,
        input.key,
        Date.now(),
      ).rowsWritten;
      if (fresh > 0) {
        enqueueLinearActivity(this.ctx.storage, {
          kind: "terminal",
          content: { type: "error", body: input.body },
        });
      }
    });
    this.ctx.waitUntil(this.linearActivities.afterSettlement());
    this.ctx.waitUntil(this.scheduleAlarm());
    return true;
  }

  /**
   * Queue a turn whose answer goes back on a channel. The delivery is the
   * adapter's own reply address, stored as written and handed back to it
   * unchanged when the turn completes.
   */
  async enqueueChannelTurn(
    input: EnqueueTurnInput,
    delivery: {
      provider: string;
      connectionId: string;
      externalUserId: string;
      deliveryRef: Readonly<Record<string, unknown>>;
      /** From the channel definition. Zero or absent means never suspend. */
      idleSuspendSeconds?: number;
    },
  ): Promise<TurnReceipt> {
    if (
      typeof delivery.idleSuspendSeconds === "number" &&
      delivery.idleSuspendSeconds > 0
    ) {
      void this.ctx.storage.put(
        "channelIdleSeconds",
        delivery.idleSuspendSeconds,
      );
    }
    void this.bindChannelConnection(delivery.connectionId);
    // Who this session is acting for. Ownership already pins a channel session
    // to one principal, so for a conversation this never actually changes; the
    // apply of an approved write sets it deliberately to the approver.
    void this.ctx.storage.put("actingExternalUserId", delivery.externalUserId);
    // A Slack message carries its own time. A Slack `ask` question does
    // not hold (`flow`), so the time decides nothing there. A consult's
    // question is answered by its member agent, has no card and holds on
    // every channel: a message meanwhile waits as steering, as it did
    // before Slack carried a time.
    if (input.providerTime !== undefined && delivery.provider === "slack") {
      const open = openQuestion(this.ctx.storage.sql);
      if (open && consultationById(this.ctx.storage.sql, open.id)) {
        const { providerTime: _consulted, ...withoutTime } = input;
        input = withoutTime;
      }
    }
    let turn: EnqueueTurnResult;
    try {
      const admitted = await this.enqueueTurn(input);
      // Held behind the open question: no turn of its own, so nothing to
      // reply to; the answering turn's reply covers it.
      if (!("turnId" in admitted)) return admitted;
      turn = admitted;
    } catch (error) {
      // A provider that re-delivers an edited message under the same message
      // id reuses the key with other text. The public turns route answers
      // that with 409 idempotency_conflict; a channel keeps the behaviour it
      // had before the fingerprint (work 029, O3 review point): the turn the
      // message first admitted stands, the edit is logged and not admitted.
      // Every provider adapter admits through here, so this is the one place.
      if (!(error instanceof Error && error.message.startsWith(IDEMPOTENCY_CONFLICT))) {
        throw error;
      }
      const existing = input.idempotencyKey ? this.findTurn(input.idempotencyKey) : null;
      if (!existing) throw error;
      console.log(
        JSON.stringify({
          level: "info",
          event: "channel.turn_edit_ignored",
          sessionId: this.requireSession().id,
          provider: delivery.provider,
          connectionId: delivery.connectionId,
          idempotencyKey: input.idempotencyKey,
          turnId: existing.turnId,
        }),
      );
      turn = { turnId: existing.turnId, status: existing.status, duplicate: true };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO slack_deliveries (
         turn_id, connected_account_id, channel_id, external_user_id, thread_timestamp,
         progress_message_timestamp, provider, delivery_ref, status, attempts,
         ack_due_at_ms, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(turn_id) DO NOTHING`,
      turn.turnId,
      delivery.connectionId,
      // The legacy columns are still what the fallback reads, so they are
      // filled from the reply address where the provider has an equivalent.
      String(delivery.deliveryRef.channelId ?? ""),
      delivery.externalUserId,
      String(delivery.deliveryRef.threadTimestamp ?? ""),
      null,
      delivery.provider,
      JSON.stringify(delivery.deliveryRef),
      // What the user waits on is a link they can open, not the finished
      // answer — but only once the turn is actually taking a while: a turn
      // settled inside the grace window is itself the acknowledgement, so
      // the ack is owed only for work still running when it ends. A
      // duplicate admission rewrites nothing: the conflict keeps the row
      // the first admission wrote.
      turn.duplicate ? null : Date.now() + CHANNEL_ACK_DELAY_MS,
      now(),
    );
    this.ctx.waitUntil(this.scheduleAlarm());
    const current = this.ctx.storage.sql
      .exec<
        Pick<TurnRow, "status">
      >("SELECT status FROM turns WHERE id = ?", turn.turnId)
      .toArray()[0];
    const progress = this.progressForTurn(turn.turnId);
    if (current?.status === "running") {
      progress?.runtimeReady();
    } else {
      progress?.runtimeStarting();
    }
    return turn;
  }

  /** @deprecated Use enqueueChannelTurn. */
  async enqueueSlackTurn(
    input: EnqueueTurnInput,
    delivery: SlackTurnDelivery,
  ): Promise<TurnReceipt> {
    const turn = await this.enqueueTurn(input);
    if (!("turnId" in turn)) return turn;
    this.ctx.storage.sql.exec(
      `INSERT INTO slack_deliveries (
         turn_id, connected_account_id, channel_id, external_user_id, thread_timestamp,
         progress_message_timestamp, provider, delivery_ref, status, attempts, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
       ON CONFLICT(turn_id) DO NOTHING`,
      turn.turnId,
      delivery.connectionId,
      delivery.channelId,
      delivery.externalUserId,
      delivery.threadTimestamp,
      null,
      "slack",
      JSON.stringify({
        channelId: delivery.channelId,
        threadTimestamp: delivery.threadTimestamp,
      }),
      now(),
    );
    const current = this.ctx.storage.sql
      .exec<
        Pick<TurnRow, "status">
      >("SELECT status FROM turns WHERE id = ?", turn.turnId)
      .toArray()[0];
    const progress = this.progressForTurn(turn.turnId);
    if (current?.status === "running") {
      progress?.runtimeReady();
    } else {
      progress?.runtimeStarting();
    }
    return turn;
  }

  channelPrincipal(): {
    provider: string;
    connectionId: string;
    externalUserId: string;
  } | null {
    const row = this.ctx.storage.sql
      .exec<{
        connection_id: string;
        external_user_id: string | null;
        provider: string | null;
      }>(
        `SELECT connected_account_id AS connection_id, external_user_id, provider
         FROM slack_deliveries
         WHERE external_user_id IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .toArray()[0];
    return row?.external_user_id
      ? {
          // Rows written before the column existed are Slack's by definition.
          provider: row.provider ?? "slack",
          connectionId: row.connection_id,
          externalUserId: row.external_user_id,
        }
      : null;
  }

  /**
   * Ask the runtime to run a gated tool's `apply`, because somebody approved
   * it, and return as soon as the frame is away.
   *
   * Deliberately not a turn: the arguments are the ones that were on the card
   * and no model runs in between, so what happens is what was agreed to.
   *
   * Deliberately not awaited either. The answer arrives later as a
   * `tool.applied` frame and settles the approval from there, so nothing holds
   * a request open while a write runs — the same shape as every other slow
   * thing here.
   */
  dispatchGatedTool(input: {
    approvalId: string;
    toolId: string;
    toolInput: unknown;
    decision: { id: string; decidedAt: string; decidedBy?: string };
    /** The turn that proposed the write. */
    turnId?: string;
  }): { dispatched: boolean; reason?: "runtime_not_connected" | "send_failed" } {
    const runtime = this.ctx
      .getWebSockets("role:runtime")
      .find((socket) => socket.readyState === WebSocket.OPEN);
    // A reason, not a sentence. The caller branches on this, and prose that
    // two files have to agree on letter for letter is a trap.
    if (!runtime) return { dispatched: false, reason: "runtime_not_connected" };
    try {
      runtime.send(
        encodeFrame({
          type: "tool.apply",
          applyId: input.approvalId,
          toolId: input.toolId,
          input: (input.toolInput ?? null) as never,
          decision: input.decision,
          identity: (() => {
            const session = this.sessionIdentity(this.requireSession());
            const turnId = input.turnId ?? "";
            return {
              ...session,
              turnId,
              messageId: input.approvalId,
              providerCallId: input.approvalId,
              toolCallId: hostToolCallId({
                sessionId: session.sessionId,
                turnId,
                messageId: input.approvalId,
                providerCallId: input.approvalId,
              }),
            };
          })(),
        }),
      );
    } catch {
      return { dispatched: false, reason: "send_failed" };
    }
    return { dispatched: true };
  }

  /**
   * The conversation this session is answering on, if any.
   *
   * A proposal has to be addressed to somebody. A session started from the
   * playground, a schedule or a webhook has no conversation and no one to ask,
   * which is why this can be null and the caller has to say so plainly rather
   * than invent a surface.
   */
  latestChannelDelivery(): {
    provider: string;
    connectionId: string;
    externalUserId?: string;
    deliveryRef: Readonly<Record<string, unknown>>;
    turnId: string;
  } | null {
    const row = this.ctx.storage.sql
      .exec<SlackDeliveryRow>(
        `SELECT turn_id, connected_account_id AS connection_id, channel_id,
                thread_timestamp, status, attempts, provider, delivery_ref,
                external_user_id
         FROM slack_deliveries
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      provider: row.provider ?? "slack",
      connectionId: row.connection_id,
      ...(row.external_user_id ? { externalUserId: row.external_user_id } : {}),
      deliveryRef: deliveryTarget(row) as Readonly<Record<string, unknown>>,
      turnId: row.turn_id,
    };
  }

  override async alarm(): Promise<void> {
    this.expireWorkerdTurnLeases(Date.now());
    const stop = this.pendingWorkerdStop();
    if (stop && stop.next_attempt_at_ms <= Date.now()) {
      await this.driveWorkerdStop();
    }
    this.expireRuntimeBillingLease(Date.now());
    const session = this.readSession();
    if (session) {
      await redriveMemory(
        this.ctx.storage,
        this.env as Env & MemorySessionEnv,
        session.id,
        Date.now(),
        () => this.scheduleAlarm(),
      );
      await this.settleRejectedAdmission();
    }
    await this.deliverRuntimeBillingSegments();
    await this.deliverOutcomeEvents();
    await this.deliverPublicationIfDue();
    // Replies whose turn has settled and whose attempt is due. A batch that
    // leaves work behind is followed by another: the scheduler below sees
    // what remains due and arms the alarm for it.
    const dueReplies = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `SELECT d.turn_id
         FROM slack_deliveries d
         JOIN turns t ON t.id = d.turn_id
         WHERE d.status = 'pending'
           AND t.status IN ('completed', 'failed', 'cancelled')
           AND COALESCE(d.next_attempt_at_ms, 0) <= ?
           AND COALESCE(d.lease_until_ms, 0) <= ?
         ORDER BY t.updated_at, t.rowid
         LIMIT 10`,
        Date.now(),
        Date.now(),
      )
      .toArray();
    for (const delivery of dueReplies) {
      await this.deliverSlackTurn(delivery.turn_id);
    }
    // Admission acks come due while their turns still run; a settled turn
    // has its answer on the way, which is acknowledgement enough.
    const dueAcks = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `SELECT turn_id FROM slack_deliveries
         WHERE ack_due_at_ms IS NOT NULL AND ack_due_at_ms <= ?`,
        Date.now(),
      )
      .toArray();
    for (const ack of dueAcks) {
      await this.deliverChannelAdmissionAck(ack.turn_id);
    }
    await this.linearActivities.onAlarm();
    await this.driveConsultations();
    await this.expireRuntimeWake();
    await this.suspendIfChannelIdle();
    await this.scheduleAlarm();
  }

  snapshot(): SessionSnapshot {
    const session = this.requireSession();
    const microvm = this.readMicrovmBinding();
    const memory = localMemoryBindings(this.ctx.storage.sql, session.status === "ended");
    const memoryAdmission = admissionState(readMemoryAdmission(this.ctx.storage.sql));
    const memoryClosure = closureState(this.ctx.storage.sql);
    const turns = this.ctx.storage.sql
      .exec<TurnRow>(
        `SELECT t.id, t.input, t.mode, t.status, t.outcome, t.idempotency_key,
                t.created_at, t.updated_at, h.question_id AS held_question_id
         FROM turns t
         LEFT JOIN held_inputs h
           ON h.turn_key = t.idempotency_key AND t.status = 'cancelled'
         ORDER BY t.created_at, t.rowid`,
      )
      .toArray();
    const deliveries = new Map<string, TurnOutcomeDelivery[]>();
    for (const row of this.ctx.storage.sql
      .exec<OutcomeDeliveryRow>(
        "SELECT * FROM outcome_deliveries ORDER BY created_at, rowid",
      )
      .toArray()) {
      const list = deliveries.get(row.turn_id) ?? [];
      list.push(outcomeDeliveryFromRow(row));
      deliveries.set(row.turn_id, list);
    }

    return {
      id: session.id,
      accountId: session.account_id,
      userId: session.user_id,
      agentId: session.agent_id,
      deploymentId: session.deployment_id,
      projectId: session.project_id ?? `project:${session.agent_id}`,
      executionMode: session.execution_mode,
      ...(session.source ? { source: session.source as SessionSource } : {}),
      status: session.status,
      labels: readLabels(session.labels_json),
      ...(session.labels_updated_at ? { labelsUpdatedAt: session.labels_updated_at } : {}),
      revision: Number(session.revision),
      result: this.readResult(),
      ...this.snapshotQuestionField(),
      runtimeId: session.runtime_id ?? undefined,
      runtimeEpoch: session.runtime_epoch,
      microvmId: microvm?.microvm_id,
      microvmState: microvm?.state,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      ...(isProjectEnvironmentName(session.environment)
        ? { environment: session.environment }
        : {}),
      ...(session.memory_object ? { memoryObject: session.memory_object } : {}),
      ...(memory ? { memory } : {}),
      ...(session.creation_json ? { creation: JSON.parse(session.creation_json) as SessionCreation } : {}),
      ...(memoryAdmission ? { memoryAdmission } : {}),
      ...(memoryClosure ? { memoryClosure } : {}),
      turns: turns.map((turn) => ({
        id: turn.id,
        input: turn.input,
        mode: turn.mode,
        status: turn.status,
        ...(turn.outcome === "question" ? { outcome: "question" as const } : {}),
        ...(typeof turn.held_question_id === "string"
          ? { reason: "held" as const, questionId: turn.held_question_id }
          : {}),
        createdAt: turn.created_at,
        updatedAt: turn.updated_at,
        ...(deliveries.has(turn.id) ? { deliveries: deliveries.get(turn.id) } : {}),
      })),
    };
  }

  /** `question` on the snapshot: the open question, or null (also on a session that never asked). */
  private snapshotQuestionField(): Pick<SessionSnapshot, "question"> {
    return { question: snapshotQuestion(this.ctx.storage.sql) };
  }

  resources(): SessionResources {
    const session = this.requireSession();
    return {
      files: this.ctx.storage.sql
        .exec<{
          id: string;
          name: string;
          content_type: string;
          size: number;
          created_at: string;
        }>(
          `SELECT id, name, content_type, size, created_at
           FROM shared_files ORDER BY created_at DESC`,
        )
        .toArray()
        .map((row) => ({
          id: row.id,
          name: row.name,
          contentType: row.content_type,
          size: Number(row.size),
          createdAt: row.created_at,
          sessionId: session.id,
        })),
      data: this.ctx.storage.sql
        .exec<{ key: string; value_json: string; updated_at: string }>(
          `SELECT key, value_json, updated_at
           FROM session_data
           WHERE key != 'model_route_pin'
           ORDER BY key`,
        )
        .toArray()
        .map((row) => ({
          key: row.key,
          value: JSON.parse(row.value_json) as unknown,
          updatedAt: row.updated_at,
        })),
      secrets: this.ctx.storage.sql
        .exec<{ name: string; source: string; created_at: string }>(
          "SELECT name, source, created_at FROM session_secrets ORDER BY name",
        )
        .toArray()
        .map((row) => ({
          name: row.name,
          source: row.source === "project" ? "project" : "session",
          createdAt: row.created_at,
        })),
    };
  }

  listRuntimeBillingSegments(limit = 100): RuntimeBillingSegment[] {
    const session = this.requireSession();
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    return this.ctx.storage.sql
      .exec<RuntimeBillingSegmentRow>(
        `SELECT id, microvm_id, resource_tier, started_at_ms, ended_at_ms,
                quantity_seconds, close_reason
         FROM runtime_billing_segments
         WHERE delivery_status = 'pending'
         ORDER BY created_at, id
         LIMIT ?`,
        safeLimit,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        accountId: session.account_id,
        sessionId: session.id,
        deploymentId: session.deployment_id,
        agentId: session.agent_id,
        microvmId: row.microvm_id,
        resourceTier: row.resource_tier,
        startedAt: new Date(Number(row.started_at_ms)).toISOString(),
        endedAt: new Date(Number(row.ended_at_ms)).toISOString(),
        quantitySeconds: Number(row.quantity_seconds),
        closeReason: row.close_reason,
      }));
  }

  acknowledgeRuntimeBillingSegments(ids: string[]): void {
    const uniqueIds = [...new Set(ids)].filter((id) => id.length > 0);
    if (uniqueIds.length === 0) return;
    if (uniqueIds.length > 1_000) {
      throw new Error("Cannot acknowledge more than 1,000 billing segments");
    }
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.ctx.storage.sql.exec(
      `UPDATE runtime_billing_segments
       SET delivery_status = 'delivered'
       WHERE id IN (${placeholders})`,
      ...uniqueIds,
    );
  }

  /**
   * The result tool's commit (C1), keyed by `(turnId, callId)`. The first
   * commit under a key writes the session's result, the call's receipt and
   * the call's `tool.completed` event (`data.result: true`) in one
   * transaction; the runtime streams that call's own completion later and
   * it is dropped as a duplicate. A replay with the same data returns the
   * original receipt and writes nothing, which is how a host whose
   * acknowledgement was lost learns what happened without a second event
   * and without displacing a newer result; a replay with different data is
   * a conflict. A turn that is not running, or a runtime that is not the one
   * driving the session, is refused and the previous result stands.
   *
   * The fences are evaluated on the session as read inside the transaction
   * (C1): the fingerprint is awaited first, and a runtime the object accepts
   * during that await has advanced the epoch by the time the row is read,
   * so the result of the runtime it replaced is refused. Nothing captured
   * before the await decides anything.
   */
  async commitResult(input: ResultCommitInput): Promise<ResultCommitOutcome> {
    if (!this.readSession()) throw new Error("Session has not been initialized");
    const serialized = JSON.stringify(input.data);
    if (serialized === undefined) {
      throw new Error("A result commit requires JSON data");
    }
    if (new TextEncoder().encode(serialized).byteLength > SESSION_RESULT_DATA_LIMIT) {
      return {
        status: "rejected",
        reason: "result_too_large",
        message: `The result exceeds ${SESSION_RESULT_DATA_LIMIT} bytes of JSON`,
      };
    }
    const data = JSON.parse(serialized) as JsonValue;
    const fingerprint = await sha256(canonicalJson(data));
    const timestamp = now();
    let committed: AgentEvent | undefined;
    const outcome = this.ctx.storage.transactionSync((): ResultCommitOutcome => {
      const receipt = this.ctx.storage.sql
        .exec<{ fingerprint: string; event_id: string; reported_at: string }>(
          `SELECT fingerprint, event_id, reported_at
           FROM result_receipts WHERE turn_id = ? AND call_id = ?`,
          input.turnId,
          input.callId,
        )
        .toArray()[0];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          return {
            status: "rejected",
            reason: "result_conflict",
            message: "This call already committed a different value",
          };
        }
        return {
          status: "committed",
          replayed: true,
          receipt: {
            turnId: input.turnId,
            callId: input.callId,
            reportedAt: receipt.reported_at,
            eventId: receipt.event_id,
          },
        };
      }
      // The session row as it is now, inside the transaction, after the
      // receipt lookup: this is what the turn and runtime fences read.
      const session = this.requireSession();
      const turn = this.ctx.storage.sql
        .exec<Pick<TurnRow, "status">>(
          "SELECT status FROM turns WHERE id = ?",
          input.turnId,
        )
        .toArray()[0];
      if (turn?.status !== "running") {
        return {
          status: "rejected",
          reason: "stale_turn",
          message: "The turn that produced the result is no longer running",
        };
      }
      // The durable stop (C4) is a fence on the turn: once recorded, no new
      // operation is admitted for it, and a result commit is one. The turn
      // stays `running` until the host settles it, so the status check
      // above cannot see the stop. A replay answered by its receipt above
      // is not a new operation: that commit happened before the stop.
      const stop = this.pendingWorkerdStop();
      if (stop && (stop.turn_id === null || stop.turn_id === input.turnId)) {
        return {
          status: "rejected",
          reason: "stale_turn",
          message: "The turn that produced the result is being stopped",
        };
      }
      if (!this.runtimeGenerationIsCurrent(session, input.runtime)) {
        return {
          status: "rejected",
          reason: "stale_runtime",
          message:
            "The result was reported by a runtime that no longer drives this session",
        };
      }
      // The public shape (C1): `output` is the committed value itself, the
      // same JSON `GET /sessions/<id>` returns as `result.data`, never its
      // serialized text.
      const messageId =
        (typeof input.messageId === "string" && input.messageId) ||
        this.startedCallMessageId(input.turnId, input.callId);
      const event = this.appendEvent(
        "tool.completed",
        input.turnId,
        {
          tool: input.tool,
          callId: input.callId,
          title: input.tool,
          output: data,
          result: true,
          messageId,
        },
        timestamp,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO result_receipts (turn_id, call_id, fingerprint, event_id, reported_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.turnId,
        input.callId,
        fingerprint,
        event.id,
        timestamp,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO session_result (slot, turn_id, call_id, reported_at, data_json, message_id)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           turn_id = excluded.turn_id,
           call_id = excluded.call_id,
           reported_at = excluded.reported_at,
           data_json = excluded.data_json,
           message_id = excluded.message_id`,
        input.turnId,
        input.callId,
        timestamp,
        serialized,
        messageId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET updated_at = ? WHERE id = ?",
        timestamp,
        session.id,
      );
      // A committed result is a listed mutation (C1): the row carries it,
      // so the revision moves and the publication is owed in this same
      // transaction. `tool.completed` itself is not a published event type.
      this.bumpRevision(timestamp);
      committed = event;
      return {
        status: "committed",
        replayed: false,
        receipt: {
          turnId: input.turnId,
          callId: input.callId,
          reportedAt: timestamp,
          eventId: event.id,
        },
      };
    });
    if (committed) this.broadcastEvents([committed]);
    return outcome;
  }

  /**
   * Whether the committing runtime is the one this session drives now. A
   * MicroVM runtime carries the epoch of its attachment; the Workerd host
   * carries the activation it reported when the turn started, so a loop
   * replayed by a later activation of that object is refused.
   */
  private runtimeGenerationIsCurrent(
    session: SessionRow,
    runtime: RuntimeGeneration,
  ): boolean {
    if (session.execution_mode === "workerd") {
      if (runtime.kind !== "workerd") return false;
      const workerd = this.ctx.storage.sql
        .exec<{ runtime_boot_id: string; runtime_activation: number }>(
          "SELECT runtime_boot_id, runtime_activation FROM workerd_session WHERE slot = 1",
        )
        .toArray()[0];
      return (
        !!workerd &&
        workerd.runtime_boot_id === runtime.bootId &&
        Number(workerd.runtime_activation) === runtime.activation
      );
    }
    return runtime.kind === "microvm" && runtime.epoch === session.runtime_epoch;
  }

  /**
   * The assistant message this session recorded behind a call when it
   * started, for a result whose commit did not name one (a runtime built
   * before the message travelled with the commit); empty when the call
   * never started here.
   */
  private startedCallMessageId(turnId: string, callId: string): string {
    const row = this.ctx.storage.sql
      .exec<{ message_id: string | null }>(
        `SELECT json_extract(data, '$.identity.messageId') AS message_id
         FROM events
         WHERE turn_id = ? AND type = 'tool.started'
           AND json_extract(data, '$.callId') = ?
         ORDER BY seq LIMIT 1`,
        turnId,
        callId,
      )
      .toArray()[0];
    return row?.message_id ?? "";
  }

  private readResult(): SessionResult | null {
    const row = this.ctx.storage.sql
      .exec<{
        turn_id: string;
        call_id: string;
        reported_at: string;
        data_json: string;
        message_id: string | null;
      }>(
        "SELECT turn_id, call_id, reported_at, data_json, message_id FROM session_result WHERE slot = 1",
      )
      .toArray()[0];
    if (!row) return null;
    const session = this.readSession();
    return {
      turnId: row.turn_id,
      callId: row.call_id,
      reportedAt: row.reported_at,
      data: JSON.parse(row.data_json) as JsonValue,
      // The session part comes from the session row, the turn and call from
      // the receipt, the message from the committing runtime's report; a
      // result committed before the message was recorded has no identity.
      ...(session && row.message_id !== null
        ? {
            identity: (() => {
              const identity = this.sessionIdentity(session);
              return {
                ...identity,
                turnId: row.turn_id,
                messageId: row.message_id,
                providerCallId: row.call_id,
                toolCallId: hostToolCallId({
                  sessionId: identity.sessionId,
                  turnId: row.turn_id,
                  messageId: row.message_id,
                  providerCallId: row.call_id,
                }),
              };
            })(),
          }
        : {}),
    };
  }

  /** A committed result call already has its `tool.completed` event; the runtime's own frame for it is a duplicate. */
  private resultReceiptExists(turnId: string, callId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ found: number }>(
          "SELECT 1 AS found FROM result_receipts WHERE turn_id = ? AND call_id = ?",
          turnId,
          callId,
        )
        .toArray().length > 0
    );
  }

  commitAgentRender(input: SessionAgentRender): SessionAgentRender {
    this.requireSession();
    let event: AgentEvent | undefined;
    this.ctx.storage.transactionSync(() => {
      const inserted = this.ctx.storage.sql
        .exec<{ render_id: string }>(
          `INSERT INTO agent_renders (
             render_id, response_id, provider_turn, state_version,
             instructions_hash, instructions, platform_instructions_json,
             enabled_tools_json, enabled_subagents_json,
             required_connections_json, enabled_mcp_servers_json,
             input_json, tools_json, model_provider, model_id, rendered_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(render_id) DO NOTHING
           RETURNING render_id`,
          input.renderId,
          input.responseId,
          input.providerTurn,
          input.stateVersion,
          input.instructionsHash,
          input.instructions,
          "[]",
          JSON.stringify(input.enabledTools),
          "[]",
          JSON.stringify(input.requiredConnections),
          JSON.stringify(input.enabledMcpServers),
          JSON.stringify(input.input),
          JSON.stringify(input.tools),
          input.model?.provider ?? null,
          input.model?.model ?? null,
          input.renderedAt,
        )
        .toArray()[0];
      if (!inserted) return;
      const turnId = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM turns WHERE status = 'running' ORDER BY created_at DESC LIMIT 1",
        )
        .toArray()[0]?.id;
      event = this.appendEvent(
        "agent.rendered",
        turnId,
        {
          renderId: input.renderId,
          responseId: input.responseId,
          providerTurn: input.providerTurn,
          stateVersion: input.stateVersion,
          instructionsHash: input.instructionsHash,
          instructions: input.instructions,
          enabledTools: input.enabledTools,
          requiredConnections: input.requiredConnections,
          enabledMcpServers: input.enabledMcpServers,
          input: input.input,
          tools: input.tools,
          ...(input.model ? { model: input.model } : {}),
          renderedAt: input.renderedAt,
        },
        input.renderedAt,
      );
    });
    if (event) this.broadcastEvents([event]);
    return input;
  }

  /**
   * A memory save the sandbox session runtime observed succeed, through the
   * edge memory route; the same `memory.saved` event the Workerd host sends
   * as `opencomputer.memory.saved`. Filed under the running turn, as a
   * render is. Best-effort by contract: never a turn failure.
   */
  recordMemorySaved(saved: { resource: string; documentId: string; revision: string; bytes: number }): void {
    this.requireSession();
    const turnId = this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM turns WHERE status = 'running' ORDER BY created_at DESC LIMIT 1",
      )
      .toArray()[0]?.id;
    const persisted = this.appendEvent("memory.saved", turnId, saved);
    if (turnId) this.publishTurnEvents(turnId, [persisted]);
    else this.broadcastEvents([persisted]);
  }

  listAgentRenders(): SessionAgentRender[] {
    this.requireSession();
    return this.ctx.storage.sql
      .exec<{
        render_id: string;
        response_id: string;
        provider_turn: number;
        state_version: number;
        instructions_hash: string;
        instructions: string;
        enabled_tools_json: string;
        required_connections_json: string;
        enabled_mcp_servers_json: string;
        input_json: string;
        tools_json: string;
        model_provider: string | null;
        model_id: string | null;
        rendered_at: string;
      }>(
        `SELECT render_id, response_id, provider_turn, state_version,
                instructions_hash, instructions,
                enabled_tools_json,
                required_connections_json, enabled_mcp_servers_json,
                input_json, tools_json,
                model_provider, model_id, rendered_at
         FROM agent_renders ORDER BY provider_turn, rendered_at`,
      )
      .toArray()
      .map((row) => ({
        renderId: row.render_id,
        responseId: row.response_id,
        providerTurn: Number(row.provider_turn),
        stateVersion: Number(row.state_version),
        instructionsHash: row.instructions_hash,
        instructions: row.instructions,
        enabledTools: JSON.parse(row.enabled_tools_json) as string[],
        requiredConnections: JSON.parse(row.required_connections_json) as string[],
        enabledMcpServers: JSON.parse(row.enabled_mcp_servers_json) as string[],
        input: JSON.parse(row.input_json) as { source: string; text?: string },
        tools: JSON.parse(row.tools_json) as Array<{ name: string; description: string }>,
        ...(row.model_provider && row.model_id
          ? { model: { provider: row.model_provider, model: row.model_id } }
          : {}),
        renderedAt: row.rendered_at,
      }));
  }

  putData(key: string, value: unknown): SessionResources {
    const normalized = key.trim();
    if (!normalized || normalized.length > 200) throw new Error("Invalid data key");
    this.ctx.storage.sql.exec(
      `INSERT INTO session_data (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      normalized,
      JSON.stringify(value),
      now(),
    );
    return this.resources();
  }

  shareFile(input: { id: string; name: string; contentType: string; size: number }): SessionResources {
    if (!input.name.trim() || input.size < 0) throw new Error("Invalid file metadata");
    this.ctx.storage.sql.exec(
      `INSERT INTO shared_files (id, name, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, content_type = excluded.content_type,
         size = excluded.size`,
      input.id,
      input.name.trim(),
      input.contentType || "application/octet-stream",
      input.size,
      now(),
    );
    return this.resources();
  }

  /**
   * Admits one export request. A replayed `Idempotency-Key` (same canonical
   * request) answers with the export it already produced, delivered or still
   * in flight, and re-drives one that failed with a retry-safe error; the
   * same key with another request is refused. An export left `snapshotting`
   * past its deadline expires here, terminally: the caller retries under a
   * new key. Without a key every request is a new export.
   */
  beginWorkspaceExport(input: {
    idempotencyKey: string | null;
    requestDigest: string;
    path: string;
    expected: WorkspaceExport["expected"];
  }): {
    export: WorkspaceExport;
    artifact: WorkspaceArtifact | null;
    outcome: "created" | "replayed" | "in_flight";
  } {
    const session = this.requireSession();
    const timestamp = now();
    if (input.idempotencyKey) {
      const existing = this.ctx.storage.sql
        .exec<WorkspaceExportRow>(
          `SELECT ${WORKSPACE_EXPORT_COLUMNS} FROM workspace_exports WHERE idempotency_key = ?`,
          input.idempotencyKey,
        )
        .toArray()[0];
      if (existing) {
        if (existing.request_digest !== input.requestDigest) {
          throw new Error(
            `${WORKSPACE_EXPORT_CONFLICT}: the idempotency key was already used for another path or expectation`,
          );
        }
        let record = existing;
        if (record.state === "failed" && record.error_json) {
          const error = JSON.parse(record.error_json) as { retrySafe?: boolean };
          if (error.retrySafe === true) {
            this.ctx.storage.sql.exec(
              `UPDATE workspace_exports
               SET state = 'snapshotting', error_json = NULL, completed_at = NULL, created_at = ?
               WHERE id = ? AND state = 'failed'`,
              timestamp,
              record.id,
            );
            record = { ...record, state: "snapshotting", error_json: null, completed_at: null, created_at: timestamp };
            this.broadcastEvents([
              this.appendEvent(
                "artifact.export.started",
                undefined,
                { exportId: record.id, path: record.path, retry: true },
                timestamp,
              ),
            ]);
            return { export: workspaceExportFromRow(session, record), artifact: null, outcome: "created" };
          }
        }
        if (
          record.state === "snapshotting" &&
          Date.parse(record.created_at) + WORKSPACE_EXPORT_IN_FLIGHT_MS <= Date.parse(timestamp)
        ) {
          record = this.settleWorkspaceExport(record.id, {
            state: "expired",
            error: {
              code: "export_expired",
              message: "The export did not complete; retry under a new idempotency key",
              retrySafe: false,
            },
          });
        }
        return {
          export: workspaceExportFromRow(session, record),
          artifact: record.artifact_id ? this.getWorkspaceArtifact(record.artifact_id) : null,
          outcome: record.state === "snapshotting" ? "in_flight" : "replayed",
        };
      }
    }
    const row: WorkspaceExportRow = {
      id: `wsexp_${crypto.randomUUID().replace(/-/g, "")}`,
      idempotency_key: input.idempotencyKey,
      request_digest: input.requestDigest,
      path: input.path,
      expected_json: input.expected ? JSON.stringify(input.expected) : null,
      state: "snapshotting",
      artifact_id: null,
      error_json: null,
      created_at: timestamp,
      completed_at: null,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO workspace_exports (${WORKSPACE_EXPORT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.idempotency_key,
      row.request_digest,
      row.path,
      row.expected_json,
      row.state,
      row.artifact_id,
      row.error_json,
      row.created_at,
      row.completed_at,
    );
    this.broadcastEvents([
      this.appendEvent(
        "artifact.export.started",
        undefined,
        { exportId: row.id, path: row.path },
        timestamp,
      ),
    ]);
    return { export: workspaceExportFromRow(session, row), artifact: null, outcome: "created" };
  }

  /**
   * Records what the provider retained for an export. The same path with
   * the same digest is the same artifact, so a second export of unchanged
   * bytes points at the first manifest. Artifact rows outlive the session:
   * nothing here is cleared on end.
   */
  completeWorkspaceExport(
    exportId: string,
    input: {
      path: string;
      size: number;
      sha256: string;
      mediaType: string;
      snapshotId: string;
      receipt: WorkspaceArtifact["receipt"];
    },
  ): { export: WorkspaceExport; artifact: WorkspaceArtifact } {
    const session = this.requireSession();
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || input.size < 0 || !input.path) {
      throw new Error("Invalid workspace artifact");
    }
    const timestamp = now();
    const pending = this.ctx.storage.sql
      .exec<WorkspaceExportRow>(
        `SELECT ${WORKSPACE_EXPORT_COLUMNS} FROM workspace_exports WHERE id = ?`,
        exportId,
      )
      .toArray()[0];
    if (!pending) throw new Error("Workspace export not found");
    if (pending.state !== "snapshotting") {
      const settledArtifact = pending.artifact_id
        ? this.getWorkspaceArtifact(pending.artifact_id)
        : null;
      if (!settledArtifact) throw new Error(`Workspace export already ${pending.state}`);
      return { export: workspaceExportFromRow(session, pending), artifact: settledArtifact };
    }
    let artifactRow = this.ctx.storage.sql
      .exec<WorkspaceArtifactRow>(
        `SELECT ${WORKSPACE_ARTIFACT_COLUMNS} FROM workspace_artifacts WHERE path = ? AND sha256 = ?`,
        input.path,
        input.sha256,
      )
      .toArray()[0];
    if (!artifactRow) {
      artifactRow = {
        id: `wsart_${crypto.randomUUID().replace(/-/g, "")}`,
        export_id: exportId,
        path: input.path,
        size: input.size,
        sha256: input.sha256,
        media_type: input.mediaType,
        snapshot_id: input.snapshotId,
        receipt_json: JSON.stringify(input.receipt),
        exported_at: timestamp,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO workspace_artifacts (${WORKSPACE_ARTIFACT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        artifactRow.id,
        artifactRow.export_id,
        artifactRow.path,
        artifactRow.size,
        artifactRow.sha256,
        artifactRow.media_type,
        artifactRow.snapshot_id,
        artifactRow.receipt_json,
        artifactRow.exported_at,
      );
    }
    const exportRow = this.settleWorkspaceExport(exportId, {
      state: "delivered",
      artifactId: artifactRow.id,
    });
    this.broadcastEvents([
      this.appendEvent(
        "artifact.export.delivered",
        undefined,
        {
          exportId,
          artifactId: artifactRow.id,
          path: input.path,
          bytes: input.size,
          sha256: input.sha256,
          snapshotId: input.snapshotId,
        },
        timestamp,
      ),
    ]);
    return {
      export: workspaceExportFromRow(session, exportRow),
      artifact: workspaceArtifactFromRow(session, artifactRow),
    };
  }

  failWorkspaceExport(
    exportId: string,
    error: { code: string; message: string; retrySafe: boolean },
  ): WorkspaceExport {
    const session = this.requireSession();
    const row = this.settleWorkspaceExport(exportId, { state: "failed", error });
    this.broadcastEvents([
      this.appendEvent("artifact.export.failed", undefined, {
        exportId,
        path: row.path,
        error: { code: error.code, retrySafe: error.retrySafe },
      }),
    ]);
    return workspaceExportFromRow(session, row);
  }

  /** Moves a `snapshotting` export to its one terminal state; a settled export is left as it is. */
  private settleWorkspaceExport(
    exportId: string,
    outcome:
      | { state: "delivered"; artifactId: string }
      | { state: "failed" | "expired"; error: { code: string; message: string; retrySafe: boolean } },
  ): WorkspaceExportRow {
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `UPDATE workspace_exports
       SET state = ?, artifact_id = ?, error_json = ?, completed_at = ?
       WHERE id = ? AND state = 'snapshotting'`,
      outcome.state,
      outcome.state === "delivered" ? outcome.artifactId : null,
      outcome.state === "delivered" ? null : JSON.stringify(outcome.error),
      timestamp,
      exportId,
    );
    const row = this.ctx.storage.sql
      .exec<WorkspaceExportRow>(
        `SELECT ${WORKSPACE_EXPORT_COLUMNS} FROM workspace_exports WHERE id = ?`,
        exportId,
      )
      .toArray()[0];
    if (!row) throw new Error("Workspace export not found");
    return row;
  }

  listWorkspaceExports(): WorkspaceExport[] {
    const session = this.requireSession();
    return this.ctx.storage.sql
      .exec<WorkspaceExportRow>(
        `SELECT ${WORKSPACE_EXPORT_COLUMNS} FROM workspace_exports ORDER BY created_at DESC, id ASC`,
      )
      .toArray()
      .map((row) => workspaceExportFromRow(session, row));
  }

  getWorkspaceExport(
    id: string,
  ): { export: WorkspaceExport; artifact: WorkspaceArtifact | null } | null {
    const session = this.requireSession();
    const row = this.ctx.storage.sql
      .exec<WorkspaceExportRow>(
        `SELECT ${WORKSPACE_EXPORT_COLUMNS} FROM workspace_exports WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      export: workspaceExportFromRow(session, row),
      artifact: row.artifact_id ? this.getWorkspaceArtifact(row.artifact_id) : null,
    };
  }

  listWorkspaceArtifacts(): WorkspaceArtifact[] {
    const session = this.requireSession();
    return this.ctx.storage.sql
      .exec<WorkspaceArtifactRow>(
        `SELECT ${WORKSPACE_ARTIFACT_COLUMNS}
         FROM workspace_artifacts ORDER BY exported_at DESC, path ASC`,
      )
      .toArray()
      .map((row) => workspaceArtifactFromRow(session, row));
  }

  getWorkspaceArtifact(id: string): WorkspaceArtifact | null {
    const session = this.requireSession();
    const row = this.ctx.storage.sql
      .exec<WorkspaceArtifactRow>(
        `SELECT ${WORKSPACE_ARTIFACT_COLUMNS} FROM workspace_artifacts WHERE id = ?`,
        id,
      )
      .toArray()[0];
    return row ? workspaceArtifactFromRow(session, row) : null;
  }

  shareSecretReference(
    name: string,
    source: "project" | "session" | "tenant" | "user",
  ): SessionResources {
    const normalized = name.trim();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(normalized)) {
      throw new Error("Invalid secret name");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO session_secrets (name, source, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET source = excluded.source`,
      normalized,
      source,
      now(),
    );
    return this.resources();
  }

  listEvents(after = 0, limit = 500): AgentEvent[] {
    const session = this.requireSession();
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    return this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT seq, id, timestamp, turn_id, type, data
         FROM events
         WHERE seq > ?
         ORDER BY seq
         LIMIT ?`,
        after,
        safeLimit,
      )
      .toArray()
      .map((row) => this.eventFromRow(session, row));
  }

  usageSummary(): {
    title?: string;
    modelCalls: number;
    modelProviderCostUsd: number;
    modelUsage: Array<{ timestamp: string; costUsd: number }>;
    runtimeSecondsByTier: Record<string, number>;
  } {
    this.requireSession();
    const firstTurn = this.ctx.storage.sql
      .exec<{ input: string }>(
        "SELECT input FROM turns ORDER BY created_at, id LIMIT 1",
      )
      .toArray()[0];
    const accountingRows = this.ctx.storage.sql
      .exec<{ type: string; timestamp: string; data: string }>(
        `SELECT type, timestamp, data
           FROM events
          WHERE type IN ('model.route_resolved', 'usage.recorded')
          ORDER BY seq`,
      )
      .toArray();
    let modelCalls = 0;
    let modelProviderCostUsd = 0;
    const modelUsage: Array<{ timestamp: string; costUsd: number }> = [];
    // OpenCode reports a catalog price even when the request used an external
    // subscription. The gateway's immutable route event is authoritative for
    // the amount OpenComputer charges; retain the runtime estimate only when
    // the resolved route intentionally leaves that charge unspecified.
    const resolvedChargesByModel = new Map<string, number | null>();
    for (const row of accountingRows) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        if (row.type === "model.route_resolved") {
          const effective = data.effective;
          if (!effective || typeof effective !== "object") continue;
          const model = effective as Record<string, unknown>;
          if (
            typeof model.provider !== "string" ||
            typeof model.model !== "string"
          ) {
            continue;
          }
          const charge = data.openComputerModelChargeUsd;
          resolvedChargesByModel.set(
            `${model.provider}/${model.model}`,
            typeof charge === "number" && Number.isFinite(charge) && charge >= 0
              ? charge
              : null,
          );
          continue;
        }
        const reportedCost = Number(data.costUsd ?? 0);
        const resolvedCharge =
          typeof data.model === "string"
            ? resolvedChargesByModel.get(data.model)
            : undefined;
        const cost = resolvedCharge ?? reportedCost;
        if (!Number.isFinite(cost) || cost < 0) continue;
        modelCalls += 1;
        modelProviderCostUsd += cost;
        modelUsage.push({ timestamp: row.timestamp, costUsd: cost });
      } catch {
        // Historical malformed event payloads are excluded from attribution.
      }
    }
    const runtimeSecondsByTier: Record<string, number> = {};
    for (const row of this.ctx.storage.sql
      .exec<{ resource_tier: string; quantity_seconds: number }>(
        // A MicroVM's turn segments overlap its lease's; count the lease.
        `SELECT resource_tier, SUM(quantity_seconds) AS quantity_seconds
           FROM runtime_billing_segments
          WHERE close_reason != 'turn_settled' OR microvm_id = 'workerd'
          GROUP BY resource_tier`,
      )
      .toArray()) {
      runtimeSecondsByTier[row.resource_tier] = Number(row.quantity_seconds);
    }
    return {
      ...(firstTurn?.input ? { title: firstTurn.input.slice(0, 160) } : {}),
      modelCalls,
      modelProviderCostUsd,
      modelUsage,
      runtimeSecondsByTier,
    };
  }

  recordRuntimeLog(input: {
    level: "debug" | "info" | "warn" | "error";
    stream: "stdout" | "stderr" | "system";
    message: string;
    timestamp?: string;
  }): AgentEvent {
    const message = input.message.slice(0, 16_384);
    const event = this.appendEvent(
      "runtime.log",
      undefined,
      { level: input.level, stream: input.stream, message },
      input.timestamp ?? now(),
    );
    this.broadcastEvents([event]);
    return event;
  }

  recordEgressEvent(input: {
    type: "egress.request" | "egress.response" | "egress.failed";
    connectionId: string;
    method: string;
    path: string;
    status?: number;
    durationMs?: number;
    message?: string;
  }): AgentEvent {
    const event = this.appendEvent(input.type, undefined, {
      connectionId: input.connectionId,
      method: input.method,
      path: input.path,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: input.durationMs }),
      ...(input.message ? { message: input.message.slice(0, 1_000) } : {}),
    });
    this.broadcastEvents([event]);
    return event;
  }

  // Persists the immutable effective route for one provider call. Router
  // aliases are recorded after initial upstream metadata identifies the model
  // that served the call; fixed routes are recorded before dispatch. `data`
  // carries requested/effective model, runtime, billing source, connection id,
  // fallback reason, and the stable provider-call id so retries cannot
  // duplicate attribution.
  recordModelRouteResolved(data: Record<string, unknown>): AgentEvent {
    const event = this.appendEvent("model.route_resolved", undefined, data);
    this.broadcastEvents([event]);
    return event;
  }

  /** Pins exactly one project/agent route decision for this session. */
  pinModelRoute(route: ModelRoute | null): ModelRoute | null {
    const key = "model_route_pin";
    const existing = this.ctx.storage.sql
      .exec<{ value_json: string }>(
        "SELECT value_json FROM session_data WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (existing) {
      const value = JSON.parse(existing.value_json) as ModelRoute | null;
      return value;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO session_data (key, value_json, updated_at)
       VALUES (?, ?, ?)`,
      key,
      JSON.stringify(route),
      new Date().toISOString(),
    );
    return route;
  }

  /**
   * The effective route of the most recent model call the gateway resolved
   * for this session, for events that name the model: usage and failures.
   */
  /** The seq of the last event recorded, 0 before the first. */
  private lastEventSeq(): number {
    const row = this.ctx.storage.sql
      .exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events")
      .toArray()[0];
    return typeof row?.seq === "number" ? row.seq : 0;
  }

  /**
   * The model the gateway resolved for the model call in flight: the route
   * recorded after the call's step started, if any. A route from an earlier
   * call says nothing about this one; undefined when this call recorded
   * none (it failed before reaching the gateway, or bypassed it).
   */
  private resolvedModelSince(
    sinceSeq: number | undefined,
  ): { provider: string; model: string } | undefined {
    if (sinceSeq === undefined) return undefined;
    const row = this.ctx.storage.sql
      .exec<{ data: string }>(
        `SELECT data FROM events
          WHERE type = 'model.route_resolved' AND seq > ?
          ORDER BY seq DESC LIMIT 1`,
        sinceSeq,
      )
      .toArray()[0];
    if (!row) return undefined;
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      const effective = isRecord(data.effective) ? data.effective : null;
      if (
        effective &&
        typeof effective.provider === "string" &&
        typeof effective.model === "string"
      ) {
        return { provider: effective.provider, model: effective.model };
      }
    } catch {
      // A malformed row names nothing.
    }
    return undefined;
  }

  // Persists a subscription→Managed transition before the managed request.
  recordModelAccessFallback(data: Record<string, unknown>): AgentEvent {
    const event = this.appendEvent("model.access_fallback", undefined, data);
    this.broadcastEvents([event]);
    return event;
  }

  async claimRuntimeStart(): Promise<
    | { claimed: false; attempt: number }
    | { claimed: true; attempt: number; runtimeToken: string }
  > {
    const runtimeToken = crypto.randomUUID();
    const runtimeTokenHash = await sha256(runtimeToken);
    let claimed = false;
    let attempt = 0;
    let event: AgentEvent | undefined;
    this.ctx.storage.transactionSync(() => {
      const session = this.requireSession();
      attempt = session.runtime_start_attempt;
      if (
        session.status === "ended" ||
        // A Workerd session's runtime is created at admit; the DO-first
        // start has nothing to launch for it.
        session.execution_mode === "workerd" ||
        session.runtime_start_state !== "unclaimed" ||
        this.readMicrovmBinding()
      ) {
        return;
      }
      claimed = true;
      attempt += 1;
      const timestamp = now();
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET runtime_token_hash = ?, runtime_start_state = 'starting',
             runtime_start_attempt = ?, updated_at = ?
         WHERE id = ?`,
        runtimeTokenHash,
        attempt,
        timestamp,
        session.id,
      );
      event = this.appendEvent(
        "runtime.log",
        undefined,
        { phase: "runtime_starting", attempt },
        timestamp,
      );
    });
    if (event) this.broadcastEvents([event]);
    return claimed
      ? { claimed: true, attempt, runtimeToken }
      : { claimed: false, attempt };
  }

  /**
   * Reopens the runtime start for a session whose runtime was suspended by
   * snapshot-and-terminate (a sandbox provider without in-place resume):
   * the binding goes away and the start claim returns to `unclaimed`, so
   * the next DO-first start boots a fresh runtime from the snapshot. The
   * session reads `resuming` until that runtime connects. False when there
   * is nothing suspended to restart.
   */
  /** The edge origin the session was created against (`runtimeEdge` at initialize). */
  runtimeEdgeOrigin(): string | null {
    return this.readSession()?.runtime_edge ?? null;
  }

  /**
   * Holds a Playground session's runtime for `seconds` after this call (and
   * after each later settled turn) before suspending it, so a quick next
   * turn reuses the running sandbox instead of booting one from a snapshot.
   * False for any other session source: an explicit suspend there is
   * honoured at once.
   */
  async deferIdleSuspend(seconds: number): Promise<boolean> {
    const session = this.readSession();
    if (!session || session.source !== "playground") return false;
    await this.ctx.storage.put("channelIdleSeconds", seconds);
    await this.armChannelIdleSuspend();
    return true;
  }

  /**
   * The idle sweep's question about one running Modal sandbox created for this
   * session. The idle suspend is armed only when a turn settles, so a sandbox
   * that missed that moment (a settle before the deadline existed, a lost
   * alarm) would run to its lifetime cap. `armed`: an idle deadline was set
   * now and the alarm suspends it as usual; `waiting`: one is already set;
   * `keep`: a turn or a runtime transition is in flight, or the source has no
   * idle policy; `orphan`: the session ended or runs on another sandbox, so
   * nothing here will ever let go of this one.
   */
  async sweepRuntime(
    sandboxId: string,
  ): Promise<{ verdict: "armed" | "waiting" | "keep" | "orphan"; accountId?: string }> {
    const session = this.readSession();
    // A Workerd session's sandboxes are its host's, on the host's clock.
    if (!session || session.execution_mode === "workerd") return { verdict: "keep" };
    const accountId = session.account_id;
    const microvm = this.readMicrovmBinding();
    if (
      session.status === "ended" ||
      session.status === "failed" ||
      microvm?.microvm_id !== sandboxId
    ) {
      return { verdict: "orphan", accountId };
    }
    if (session.status === "running" || microvm.state !== "running") {
      return { verdict: "keep", accountId };
    }
    const deadline = await this.ctx.storage.get<number>("channelIdleAtMs");
    if (deadline) {
      // Past due means the alarm that should have taken it was lost.
      if (deadline < Date.now()) await this.scheduleAlarm();
      return { verdict: "waiting", accountId };
    }
    await this.armChannelIdleSuspend();
    const armed = await this.ctx.storage.get<number>("channelIdleAtMs");
    return { verdict: armed ? "armed" : "keep", accountId };
  }

  releaseRuntimeForRestart(): boolean {
    let released = false;
    let event: AgentEvent | undefined;
    this.ctx.storage.transactionSync(() => {
      const session = this.requireSession();
      const binding = this.readMicrovmBinding();
      if (
        session.status === "ended" ||
        !binding ||
        (binding.state !== "suspended" &&
          binding.state !== "suspending" &&
          binding.state !== "resuming")
      ) {
        return;
      }
      released = true;
      const timestamp = now();
      this.ctx.storage.sql.exec("DELETE FROM microvm_binding WHERE slot = 1");
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET runtime_start_state = 'unclaimed', status = 'resuming', updated_at = ?
         WHERE id = ?`,
        timestamp,
        session.id,
      );
      if (session.status !== "resuming") {
        event = this.appendEvent(
          "session.status_changed",
          undefined,
          { from: session.status, to: "resuming" },
          timestamp,
        );
      }
    });
    if (event) this.broadcastEvents([event]);
    return released;
  }

  releaseRuntimeStart(attempt: number, message: string): SessionSnapshot {
    let event: AgentEvent | undefined;
    this.ctx.storage.transactionSync(() => {
      const session = this.requireSession();
      if (
        session.runtime_start_state !== "starting" ||
        session.runtime_start_attempt !== attempt ||
        this.readMicrovmBinding()
      ) {
        return;
      }
      const timestamp = now();
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET runtime_start_state = 'unclaimed', updated_at = ?
         WHERE id = ?`,
        timestamp,
        session.id,
      );
      event = this.appendEvent(
        "runtime.log",
        undefined,
        {
          phase: "runtime_start_failed",
          attempt,
          message: message.slice(0, 1_000),
        },
        timestamp,
      );
    });
    if (event) this.broadcastEvents([event]);
    return this.snapshot();
  }

  recordRuntimeStartProgress(
    attempt: number,
    phase: "configuration_loaded" | "runtime_requested" | "runtime_started",
    data: Record<string, unknown> = {},
  ): AgentEvent | null {
    const session = this.requireSession();
    if (
      session.runtime_start_state !== "starting" ||
      session.runtime_start_attempt !== attempt
    ) {
      return null;
    }
    const event = this.appendEvent("runtime.log", undefined, {
      phase,
      attempt,
      ...data,
    });
    this.broadcastEvents([event]);
    return event;
  }

  bindMicrovm(input: BindMicrovmInput): SessionSnapshot {
    if (!input.microvmId.trim()) {
      throw new Error("MicroVM ID must not be empty");
    }
    const timestamp = now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO microvm_binding (slot, microvm_id, state, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           microvm_id = excluded.microvm_id,
           state = excluded.state,
           updated_at = excluded.updated_at`,
        input.microvmId,
        input.state,
        timestamp,
      );
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET runtime_start_state = 'bound', updated_at = ?
         WHERE id = ?`,
        timestamp,
        this.requireSession().id,
      );
      if (input.state === "running") {
        this.openRuntimeBillingLease(input.microvmId, Date.now());
      }
    });
    this.ctx.waitUntil(this.scheduleAlarm());
    return this.snapshot();
  }

  updateMicrovmState(input: BindMicrovmInput): SessionSnapshot {
    const binding = this.readMicrovmBinding();
    if (!binding || binding.microvm_id !== input.microvmId) {
      throw new Error("MicroVM is not bound to this session");
    }
    if (binding.state === input.state) {
      return this.snapshot();
    }

    const timestamp = now();
    const session = this.requireSession();
    const nextSessionStatus =
      input.state === "suspending"
        ? "suspending"
        : input.state === "suspended"
          ? "suspended"
          : input.state === "resuming"
            ? "resuming"
            : input.state === "terminated"
              ? "ended"
              : undefined;
    const events = this.ctx.storage.transactionSync(() => {
      if (binding.state === "running" && input.state !== "running") {
        this.closeRuntimeBillingLease(
          input.state === "terminated" ? "terminated" : "suspended",
          Date.now(),
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE microvm_binding
         SET state = ?, updated_at = ?
         WHERE slot = 1 AND microvm_id = ?`,
        input.state,
        timestamp,
        input.microvmId,
      );
      const output: AgentEvent[] = [];
      if (input.state === "suspended") {
        output.push(
          this.appendEvent(
            "runtime.suspended",
            undefined,
            { microvmId: input.microvmId },
            timestamp,
          ),
        );
        // A decision can land in the window between a suspend starting and the
        // runtime actually stopping: the write is dispatched to a runtime that
        // is still connected, goes out to the upstream, and the answer comes
        // back to nobody. Rather than try to order those two, recover — a
        // session that suspended with a write still in flight wakes itself,
        // and `runtime.ready` redelivers whatever was waiting. A turn
        // admitted while the suspend was landing wakes it the same way.
        this.ctx.waitUntil(this.wakeRuntime());
      } else if (input.state === "running" && binding.state === "resuming") {
        output.push(
          this.appendEvent(
            "runtime.resumed",
            undefined,
            { microvmId: input.microvmId },
            timestamp,
          ),
        );
      }
      if (input.state === "running" && binding.state !== "running") {
        this.openRuntimeBillingLease(input.microvmId, Date.now());
      }
      if (nextSessionStatus && session.status !== nextSessionStatus) {
        this.ctx.storage.sql.exec(
          "UPDATE session SET status = ?, updated_at = ? WHERE id = ?",
          nextSessionStatus,
          timestamp,
          session.id,
        );
        output.push(
          this.appendEvent(
            "session.status_changed",
            undefined,
            { from: session.status, to: nextSessionStatus },
            timestamp,
          ),
        );
      }
      return output;
    });
    this.ctx.waitUntil(this.scheduleAlarm());
    this.broadcastEvents(events);
    return this.snapshot();
  }

  /**
   * Stop the running turn and nothing else: it settles cancelled here first,
   * then the runtime is told to stop, then the next queued turn (if any)
   * dispatches. A turn the runtime finishes anyway is dropped by the fence.
   */
  /**
   * Stop. On the Workerd runtime the intent is durable and covers the whole
   * turn: it is recorded first, the session shows `stopping`, and the turn
   * stays the running one until the host has settled it (loop stopped,
   * every dispatched operation terminated and confirmed, or the computer
   * terminated); only then is it cancelled, with `turn.cancelled` after the
   * last operation. Nothing dispatches meanwhile. The MicroVM runtime keeps
   * its immediate cancellation.
   */
  interrupt(): SessionSnapshot {
    const session = this.requireSession();
    const active = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id">>(
        "SELECT id FROM turns WHERE status = 'running' ORDER BY created_at, rowid",
      )
      .toArray();
    if (active.length === 0) return this.snapshot();
    const timestamp = now();
    if (session.execution_mode === "workerd") {
      const events = this.ctx.storage.transactionSync(() => {
        const output = [this.recordWorkerdStop(active[0]!.id, "interrupted", timestamp)];
        output.push(...this.markStopping(session, timestamp));
        return output;
      });
      this.broadcastEvents(events);
      this.ctx.waitUntil(this.scheduleAlarm());
      this.ctx.waitUntil(this.driveWorkerdStop());
      return this.snapshot();
    }
    const events = this.ctx.storage.transactionSync(() => {
      const output: AgentEvent[] = [];
      for (const turn of active) {
        if (!this.settleTurn(turn.id, "cancelled", timestamp)) continue;
        const cancelled = this.appendEvent(
          "turn.cancelled",
          turn.id,
          { reason: "interrupted" },
          timestamp,
        );
        this.recordOutcomeDeliveries(turn.id, cancelled);
        output.push(cancelled);
      }
      if (session.status === "running") {
        this.ctx.storage.sql.exec(
          "UPDATE session SET status = 'idle', updated_at = ? WHERE id = ?",
          timestamp,
          session.id,
        );
        output.push(
          this.appendEvent(
            "session.status_changed",
            undefined,
            { from: "running", to: "idle" },
            timestamp,
          ),
        );
      }
      return output;
    });
    this.broadcastEvents(events);
    this.ctx.waitUntil(this.scheduleAlarm());
    const runtime = this.ctx
      .getWebSockets("role:runtime")
      .find((socket) => socket.readyState === WebSocket.OPEN);
    for (const turn of active) {
      runtime?.send(encodeFrame({ type: "turn.cancel", turnId: turn.id }));
    }
    this.dispatchNextTurn();
    return this.snapshot();
  }

  /**
   * Inside a transaction that records a stop: the session shows `stopping`
   * while the settlement is pending. Returns the status event, if the
   * session was running.
   */
  private markStopping(session: SessionRow, timestamp: string): AgentEvent[] {
    if (session.status !== "running") return [];
    this.ctx.storage.sql.exec(
      "UPDATE session SET status = 'stopping', updated_at = ? WHERE id = ?",
      timestamp,
      session.id,
    );
    return [
      this.appendEvent(
        "session.status_changed",
        undefined,
        { from: "running", to: "stopping" },
        timestamp,
      ),
    ];
  }

  /**
   * Ends the session. With memory bindings, the local `ended` and a pending
   * `memory_closure` are one transaction, then the Memory DO is asked to
   * close the session. The snapshot's `memoryClosure` says whether it
   * acknowledged; `pending` is an uncertain outcome the caller must not
   * report as success, and a retried end re-drives it before answering.
   */
  async end(): Promise<SessionSnapshot> {
    const session = this.requireSession();
    if (session.status === "ended") {
      await this.confirmMemoryClosure();
      return this.snapshot();
    }
    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() => {
      this.closeRuntimeBillingLease("session_ended", Date.now());
      if (readMemoryAdmission(this.ctx.storage.sql)) {
        recordMemoryClosure(this.ctx.storage.sql, timestamp);
      }
      // Every outstanding turn is cancelled individually: each gets its own
      // `turn.cancelled`, so a subscriber to that turn's outcome hears about
      // it instead of inferring it from the session ending.
      const outstanding = this.ctx.storage.sql
        .exec<Pick<TurnRow, "id" | "status">>(
          `SELECT id, status FROM turns
           WHERE status IN ('queued', 'running')
           ORDER BY created_at, rowid`,
        )
        .toArray();
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET status = 'ended', runtime_id = NULL, updated_at = ?
         WHERE id = ?`,
        timestamp,
        session.id,
      );
      const output: AgentEvent[] = [];
      for (const turn of outstanding) {
        if (!this.settleTurn(turn.id, "cancelled", timestamp, "outstanding")) continue;
        const cancelled = this.appendEvent(
          "turn.cancelled",
          turn.id,
          { reason: "session_ended" },
          timestamp,
        );
        this.recordOutcomeDeliveries(turn.id, cancelled);
        output.push(cancelled);
      }
      const running = outstanding.find((turn) => turn.status === "running");
      if (session.execution_mode === "workerd" && running) {
        output.push(this.recordWorkerdStop(running.id, "session_ended", timestamp));
      }
      // An open question ends with the session; nothing it held runs.
      for (const held of discardHeldInputs(this.ctx.storage.sql, timestamp)) {
        output.push(this.heldDiscardedEvent(held, "ended", timestamp));
      }
      output.push(
        ...closeOpenQuestion(this.ctx.storage.sql, "ended", timestamp, (type, data) =>
          this.appendEvent(type, undefined, data, timestamp),
        ).events,
      );
      output.push(
        this.appendEvent("session.ended", undefined, {}, timestamp),
        this.appendEvent(
          "session.status_changed",
          undefined,
          { from: session.status, to: "ended" },
          timestamp,
        ),
      );
      return output;
    });
    this.ctx.waitUntil(this.scheduleAlarm());
    for (const runtime of this.ctx.getWebSockets("role:runtime")) {
      runtime.close(1000, "Session ended");
    }
    if (session.execution_mode === "workerd") {
      this.ctx.waitUntil(this.driveWorkerdStop());
    }
    this.broadcastEvents(events);
    this.refreshQuestionCardsFor(events);
    await this.confirmMemoryClosure();
    return this.snapshot();
  }

  /**
   * Drives a pending closure; the alarm is armed to the RPC deadline before
   * the call leaves, and while the Memory DO has not acknowledged it keeps
   * trying.
   */
  private async confirmMemoryClosure(): Promise<void> {
    const session = this.requireSession();
    const outcome = await driveMemoryClosure(
      this.ctx.storage,
      this.env as Env & MemorySessionEnv,
      session.id,
      () => this.scheduleAlarm(),
    );
    if (outcome === "pending") await this.scheduleAlarm();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return problem(426, "upgrade_required", "Expected a WebSocket upgrade");
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (role !== "client" && role !== "runtime") {
      return problem(400, "invalid_role", "Role must be client or runtime");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    if (role === "runtime") {
      const token = url.searchParams.get("token");
      if (!token || !(await this.verifyRuntimeToken(token))) {
        return problem(
          401,
          "invalid_runtime_token",
          "Runtime token is invalid",
        );
      }
      this.acceptRuntime(server);
    } else {
      this.acceptClient(server, url);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment;
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const frame = parseJsonRecord(text);
    if (!frame) {
      this.sendClientError(
        socket,
        "invalid_json",
        "Frame must be a JSON object",
      );
      return;
    }

    if (attachment.role === "client") {
      await this.handleClientFrame(socket, frame);
      return;
    }

    await this.handleRuntimeFrame(socket, attachment, frame);
  }

  override webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): void {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment;
    if (attachment.role === "runtime") {
      this.handleRuntimeDisconnect(attachment, code, reason);
    }
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    console.error(
      JSON.stringify({
        level: "error",
        event: "session.websocket_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    socket.close(1011, "WebSocket error");
  }

  private readSession(): SessionRow | undefined {
    return this.ctx.storage.sql
      .exec<SessionRow>(
        `SELECT id, account_id, user_id, agent_id, deployment_id, execution_mode,
                status, runtime_id,
                runtime_epoch, runtime_token_hash, runtime_start_state,
                runtime_start_attempt, environment, identity_environment, memory_object,
                project_id, source, labels_json, labels_updated_at, revision,
                creation_json, countable, exclusion_reason, outcome_at,
                created_at, updated_at, runtime_edge
         FROM session
         LIMIT 1`,
      )
      .toArray()[0];
  }

  private readMicrovmBinding(): MicrovmBindingRow | undefined {
    return this.ctx.storage.sql
      .exec<MicrovmBindingRow>(
        `SELECT microvm_id, state, updated_at
         FROM microvm_binding
         WHERE slot = 1`,
      )
      .toArray()[0];
  }

  private readRuntimeBillingLease(): RuntimeBillingLeaseRow | undefined {
    return this.ctx.storage.sql
      .exec<RuntimeBillingLeaseRow>(
        `SELECT id, microvm_id, resource_tier, opened_at_ms,
                last_heartbeat_at_ms, expires_at_ms
         FROM runtime_billing_leases
         WHERE slot = 1`,
      )
      .toArray()[0];
  }

  private openRuntimeBillingLease(microvmId: string, timestampMs: number): void {
    const active = this.readRuntimeBillingLease();
    if (active?.microvm_id === microvmId) {
      this.renewRuntimeBillingLease(timestampMs);
      return;
    }
    if (active) {
      this.closeRuntimeBillingLease("terminated", timestampMs);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_billing_leases (
         slot, id, microvm_id, resource_tier, opened_at_ms,
         last_heartbeat_at_ms, expires_at_ms
       ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      microvmId,
      RUNTIME_BILLING_RESOURCE_TIER,
      timestampMs,
      timestampMs,
      timestampMs + RUNTIME_BILLING_LEASE_TTL_MS,
    );
  }

  private renewRuntimeBillingLease(timestampMs: number): void {
    const active = this.readRuntimeBillingLease();
    if (!active) return;
    this.ctx.storage.sql.exec(
      `UPDATE runtime_billing_leases
       SET last_heartbeat_at_ms = ?, expires_at_ms = ?
       WHERE slot = 1 AND id = ?`,
      timestampMs,
      timestampMs + RUNTIME_BILLING_LEASE_TTL_MS,
      active.id,
    );
  }

  private closeRuntimeBillingLease(
    reason: RuntimeBillingSegment["closeReason"],
    requestedEndMs: number,
  ): void {
    const active = this.readRuntimeBillingLease();
    if (!active) return;
    const endMs = Math.max(
      Number(active.opened_at_ms),
      Math.min(requestedEndMs, Number(active.expires_at_ms)),
    );
    const quantitySeconds = Math.max(
      1,
      Math.ceil((endMs - Number(active.opened_at_ms)) / 1_000),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_billing_segments (
         id, microvm_id, resource_tier, started_at_ms, ended_at_ms,
         quantity_seconds, close_reason, delivery_status, delivery_attempts,
         next_delivery_at_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      `${active.id}:final`,
      active.microvm_id,
      active.resource_tier,
      active.opened_at_ms,
      endMs,
      quantitySeconds,
      reason,
      endMs,
      new Date(endMs).toISOString(),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM runtime_billing_leases WHERE slot = 1 AND id = ?",
      active.id,
    );
  }

  /**
   * A turn's working time, from `turn.started` to its settlement, as one
   * runtime segment (work 086: work minutes are turn time on
   * every runtime, not VM time). Keyed on the turn, so a settlement is billed
   * once; a turn that never started records nothing. The edge bills these
   * segments for work-minute plans and the microVM lease's for credit plans
   * (`close_reason` tells them apart).
   */
  private recordTurnRuntime(turnId: string, settledAt: string): void {
    const started = this.ctx.storage.sql
      .exec<{ timestamp: string }>(
        `SELECT timestamp FROM events
         WHERE turn_id = ? AND type = 'turn.started'
         ORDER BY seq DESC LIMIT 1`,
        turnId,
      )
      .toArray()[0];
    if (!started) return;
    const startedMs = Date.parse(started.timestamp);
    const endMs = Math.max(startedMs, Date.parse(settledAt));
    const microvmId =
      this.readSession()?.execution_mode === "workerd"
        ? "workerd"
        : (this.readMicrovmBinding()?.microvm_id ?? "none");
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_billing_segments (
         id, microvm_id, resource_tier, started_at_ms, ended_at_ms,
         quantity_seconds, close_reason, delivery_status, delivery_attempts,
         next_delivery_at_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'turn_settled', 'pending', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      `${turnId}:turn`,
      microvmId,
      RUNTIME_BILLING_RESOURCE_TIER,
      startedMs,
      endMs,
      Math.max(1, Math.ceil((endMs - startedMs) / 1_000)),
      endMs,
      settledAt,
    );
  }

  private expireRuntimeBillingLease(timestampMs: number): void {
    const active = this.readRuntimeBillingLease();
    if (!active || Number(active.expires_at_ms) > timestampMs) return;
    this.ctx.storage.transactionSync(() => {
      this.closeRuntimeBillingLease(
        "heartbeat_expired",
        Number(active.expires_at_ms),
      );
    });
  }

  /**
   * Bind this session to the installation it belongs to.
   *
   * Written once. The thread-to-session map is already keyed by connection, so
   * a second connection reaching an existing session would be a routing bug,
   * and quietly rebinding would hand one tenant's session another tenant's
   * credentials. Returns the binding in force afterwards, which is the caller's
   * signal that it got the one it asked for.
   */
  async bindChannelConnection(connectionId: string): Promise<string> {
    const existing = await this.ctx.storage.get<string>("channelConnectionId");
    if (existing === connectionId) return existing;
    if (existing) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "session.channel_connection_conflict",
          boundTo: existing,
          attempted: connectionId,
        }),
      );
      return existing;
    }
    await this.ctx.storage.put("channelConnectionId", connectionId);
    return connectionId;
  }

  /**
   * The person this session acts for.
   *
   * Per-user credentials resolve from this, so it is deliberately not derived
   * from anything the runtime sends: it is set by the edge when a turn is
   * enqueued, and by the approval dispatcher before an approved write runs.
   */
  async setActingUser(externalUserId: string): Promise<void> {
    await this.ctx.storage.put("actingExternalUserId", externalUserId);
  }

  async actingUser(): Promise<string | null> {
    return (
      (await this.ctx.storage.get<string>("actingExternalUserId")) ?? null
    );
  }

  /**
   * The channel installation this session belongs to, if it is a channel
   * session at all. Managed egress reads it to resolve per-installation
   * credentials, so `null` has to mean "no tenant" rather than "unknown":
   * callers fail closed on it.
   */
  async channelConnectionId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("channelConnectionId")) ?? null;
  }

  /**
   * A conversation spends most of its life waiting for a person, and runtime is
   * billed by wall-clock time. The channel says how long to hold the runtime
   * after the last message; an inbound message resumes it.
   */
  private async armChannelIdleSuspend(): Promise<void> {
    // The timer suspends a bound MicroVM. A Workerd session has none: the
    // host lets go of its lazy sandbox on its own clock, and a deadline here
    // would only wake this object to find nothing to do.
    const session = this.readSession();
    if (!session || session.execution_mode === "workerd") return;
    const seconds =
      (await this.ctx.storage.get<number>("channelIdleSeconds")) ??
      (session.source ? DEFAULT_IDLE_SUSPEND_SECONDS[session.source] : undefined);
    if (!seconds || seconds <= 0) return;
    await this.ctx.storage.put("channelIdleAtMs", Date.now() + seconds * 1_000);
    await this.scheduleAlarm();
  }

  /**
   * Suspend if nothing has happened since the deadline was set. Anything that
   * re-arms the deadline pushes it forward, so a session that is still being
   * talked to is never caught by an older alarm.
   */
  private async suspendIfChannelIdle(): Promise<void> {
    const deadline = await this.ctx.storage.get<number>("channelIdleAtMs");
    if (!deadline || Date.now() < deadline) return;
    const session = this.readSession();
    const microvm = this.readMicrovmBinding();
    const platform = this.env as Env & { RUNTIMES?: Fetcher };
    // An expired deadline never stays where it is: the scheduler would keep
    // re-arming that moment in the past and this object would wake in a loop
    // over it. It is either replaced by a fresh one or dropped.
    await this.ctx.storage.delete("channelIdleAtMs");
    if (!session || session.status === "ended" || session.status === "failed") {
      return;
    }
    // Not yet: a turn in flight has to finish, a runtime mid-transition has to
    // land. Look again after the channel's own interval.
    const transitioning =
      microvm !== undefined &&
      microvm.state !== "running" &&
      microvm.state !== "suspended";
    if (session.status === "running" || transitioning) {
      await this.armChannelIdleSuspend();
      return;
    }
    // Nothing to let go of: no bound runtime, one already suspended, or no
    // platform to ask. The next settled turn arms a fresh deadline.
    if (!microvm?.microvm_id || microvm.state !== "running" || !platform.RUNTIMES) {
      return;
    }

    // An approved write is not a turn, so the status check above does not see
    // it: the conversation went idle when the proposal ended, and the decision
    // arrives later. Suspending underneath one stops the runtime mid-call —
    // the request reaches the upstream and the answer comes back to nobody,
    // leaving the approval `applying` until the sweep gives up on it. Wait for
    // it instead, and look again after the next interval.
    const account = this.env.ACCOUNTS.getByName(session.account_id);
    const applying = await account
      .pendingAppliesForSession(session.id)
      .catch(() => []);
    if (applying.length) {
      await this.armChannelIdleSuspend();
      return;
    }

    const microvmId = microvm.microvm_id;
    try {
      this.updateMicrovmState({ microvmId, state: "suspending" });
      const response = await platform.RUNTIMES.fetch(
        `https://blue-runtime/v1/sessions/${encodeURIComponent(session.id)}/suspend`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: session.account_id,
            microvmId,
          }),
        },
      );
      if (!response.ok) throw new Error(`runtime returned ${String(response.status)}`);
      // Landed: the binding reads `suspended` (the explicit route does the
      // same), which is what a resume checks for.
      this.updateMicrovmState({ microvmId, state: "suspended" });
    } catch (error) {
      // Put it back the way it was; the next turn will re-arm the deadline.
      this.updateMicrovmState({ microvmId, state: "running" });
      console.error(
        JSON.stringify({
          level: "warn",
          event: "channel.idle_suspend_failed",
          sessionId: session.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * The one alarm slot, set to the earliest deadline across everything this
   * object recovers from it: the runtime billing lease and segment delivery,
   * channel idle suspension, Workerd turn leases and pending stops, outcome
   * delivery and the memory admission/closure RPCs. Every caller that creates or moves a
   * deadline calls this; it only ever pulls the alarm earlier, and the alarm
   * handler re-arms it for whatever remains.
   */
  private async scheduleAlarm(): Promise<void> {
    const active = this.readRuntimeBillingLease();
    const config = this.env as Env & {
      OPENCOMPUTER_APP_URL?: string;
      BLUE_USAGE_HMAC_SECRET?: string;
    };
    const deliveryConfigured = Boolean(
      config.OPENCOMPUTER_APP_URL && config.BLUE_USAGE_HMAC_SECRET,
    );
    const pending = deliveryConfigured
      ? this.ctx.storage.sql
          .exec<{ next_delivery_at_ms: number }>(
            `SELECT next_delivery_at_ms
             FROM runtime_billing_segments
             WHERE delivery_status = 'pending'
             ORDER BY next_delivery_at_ms
             LIMIT 1`,
          )
          .toArray()[0]
      : undefined;
    const idleAt = await this.ctx.storage.get<number>("channelIdleAtMs");
    const wakeAt = await this.ctx.storage.get<number>("runtimeWakeAtMs");
    const turnLease = this.ctx.storage.sql
      .exec<{ deadline: number | null }>(
        `SELECT MIN(lease_deadline_at_ms) AS deadline
         FROM turns
         WHERE status = 'running' AND lease_deadline_at_ms IS NOT NULL`,
      )
      .one().deadline;
    // A delivery whose attempt is still leased is not due before the lease
    // ends, or an alarm set into the past would spin on a row it must skip.
    const outcomeDelivery = this.ctx.storage.sql
      .exec<{ due: number | null }>(
        `SELECT MIN(MAX(next_attempt_at_ms, COALESCE(lease_until_ms, 0))) AS due
         FROM outcome_deliveries
         WHERE status = 'pending' AND next_attempt_at_ms IS NOT NULL`,
      )
      .one().due;
    const memory = nextMemoryAttemptMs(this.ctx.storage.sql);
    const stop = this.pendingWorkerdStop()?.next_attempt_at_ms;
    const publication = this.pendingPublication()?.next_attempt_at_ms;
    const consultation = nextConsultAttemptMs(this.ctx.storage.sql);
    // A channel reply is due once its turn has settled: at once, at its
    // backoff, or when the lease of an attempt in flight ends.
    const channelReply = this.ctx.storage.sql
      .exec<{ due: number | null }>(
        `SELECT MIN(MAX(COALESCE(d.next_attempt_at_ms, 0), COALESCE(d.lease_until_ms, 0))) AS due
         FROM slack_deliveries d
         JOIN turns t ON t.id = d.turn_id
         WHERE d.status = 'pending'
           AND t.status IN ('completed', 'failed', 'cancelled')`,
      )
      .one().due;
    // The next admission ack owed to a still-running turn.
    const admissionAck = this.ctx.storage.sql
      .exec<{ due: number | null }>(
        `SELECT MIN(ack_due_at_ms) AS due FROM slack_deliveries
         WHERE ack_due_at_ms IS NOT NULL`,
      )
      .one().due;
    const linearActivity = this.linearActivities.nextDueAtMs();
    const requested = Math.min(
      linearActivity === null ? Number.POSITIVE_INFINITY : Math.max(linearActivity, Date.now()),
      active ? Number(active.expires_at_ms) : Number.POSITIVE_INFINITY,
      pending ? Number(pending.next_delivery_at_ms) : Number.POSITIVE_INFINITY,
      idleAt ?? Number.POSITIVE_INFINITY,
      wakeAt ?? Number.POSITIVE_INFINITY,
      turnLease === null ? Number.POSITIVE_INFINITY : Number(turnLease),
      outcomeDelivery === null ? Number.POSITIVE_INFINITY : Number(outcomeDelivery),
      memory ?? Number.POSITIVE_INFINITY,
      stop === undefined ? Number.POSITIVE_INFINITY : Number(stop),
      publication === undefined ? Number.POSITIVE_INFINITY : Number(publication),
      channelReply === null
        ? Number.POSITIVE_INFINITY
        : Math.max(Number(channelReply), Date.now()),
      admissionAck === null
        ? Number.POSITIVE_INFINITY
        : Math.max(Number(admissionAck), Date.now()),
      consultation === null
        ? Number.POSITIVE_INFINITY
        : Math.max(Number(consultation), Date.now()),
    );
    if (!Number.isFinite(requested)) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || requested < existing) {
      await this.ctx.storage.setAlarm(requested);
    }
  }

  private async deliverRuntimeBillingSegments(): Promise<void> {
    const config = this.env as Env & {
      OPENCOMPUTER_APP_URL?: string;
      BLUE_USAGE_HMAC_SECRET?: string;
    };
    if (!config.OPENCOMPUTER_APP_URL || !config.BLUE_USAGE_HMAC_SECRET) return;
    const session = this.requireSession();
    const timestampMs = Date.now();
    const pending = this.ctx.storage.sql
      .exec<RuntimeBillingSegmentRow & { delivery_attempts: number }>(
        `SELECT id, microvm_id, resource_tier, started_at_ms, ended_at_ms,
                quantity_seconds, close_reason, delivery_attempts
         FROM runtime_billing_segments
         WHERE delivery_status = 'pending' AND next_delivery_at_ms <= ?
         ORDER BY created_at, id
         LIMIT 10`,
        timestampMs,
      )
      .toArray();
    for (const segment of pending) {
      try {
        await postAgentRuntimeUsage(config, {
          orgId: session.account_id,
          deploymentId: session.deployment_id,
          agentId: session.agent_id,
          sessionId: session.id,
          microvmId: segment.microvm_id,
          quantitySeconds: Number(segment.quantity_seconds),
          startedAtMs: Number(segment.started_at_ms),
          endedAtMs: Number(segment.ended_at_ms),
          closeReason: segment.close_reason,
          idempotencyKey: segment.id,
        });
        this.ctx.storage.sql.exec(
          `UPDATE runtime_billing_segments
           SET delivery_status = 'delivered', last_error = NULL
           WHERE id = ?`,
          segment.id,
        );
      } catch (error) {
        const attempts = Number(segment.delivery_attempts) + 1;
        const retryAt = agentRuntimeUsageRetryAt(attempts, Date.now());
        this.ctx.storage.sql.exec(
          `UPDATE runtime_billing_segments
           SET delivery_attempts = ?, next_delivery_at_ms = ?, last_error = ?
           WHERE id = ?`,
          attempts,
          retryAt,
          error instanceof Error ? error.message.slice(0, 500) : String(error),
          segment.id,
        );
      }
    }
  }

  private requireSession(): SessionRow {
    const session = this.readSession();
    if (!session) {
      throw new Error("Session has not been initialized");
    }
    return session;
  }

  private progressForTurn(
    turnId: string,
    create = true,
  ): SlackProgress | undefined {
    const existing = this.slackProgress.get(turnId);
    if (existing) return existing;
    if (!create) {
      const delivery = this.ctx.storage.sql
        .exec<{ found: number }>(
          `SELECT 1 AS found
           FROM slack_deliveries
           WHERE turn_id = ? AND status != 'delivered'`,
          turnId,
        )
        .toArray()[0];
      if (!delivery) return undefined;
    }
    const delivery = this.ctx.storage.sql
      .exec<SlackDeliveryRow>(
        `SELECT turn_id, connected_account_id AS connection_id, channel_id,
                external_user_id, thread_timestamp, status, attempts, provider,
                delivery_ref, progress_message_timestamp
         FROM slack_deliveries
         WHERE turn_id = ?`,
        turnId,
      )
      .toArray()[0];
    if (!delivery || delivery.status === "delivered") {
      return undefined;
    }
    // Progress is a live, editable status message. A provider that cannot take
    // a message back has no way to show one, and sending interim texts to
    // somebody's phone instead would be worse than saying nothing — so for
    // those providers there is simply no progress, rather than a second kind.
    if (!channelAdapter(delivery.provider ?? "slack")?.editableProgress) {
      return undefined;
    }
    const session = this.requireSession();
    const account = this.env.ACCOUNTS.getByName(session.account_id);
    const target = deliveryTarget(delivery);
    const streamChannelId =
      typeof target.channelId === "string" ? target.channelId : "";
    // The stream ts survives on the delivery row: this DO instance can be
    // recycled mid-turn (the runtime pool wait is a long idle gap), and the
    // next progress object must keep appending to the same stream — a fresh
    // one would strand the first plan block spinning forever.
    let streamTs =
      typeof delivery.progress_message_timestamp === "string" &&
      delivery.progress_message_timestamp
        ? delivery.progress_message_timestamp
        : undefined;
    const stream: SlackProgressStream = {
      // The stream opens lazily on the first step so a turn that produces
      // none never leaves an empty thinking-steps message behind.
      append: async (chunks) => {
        const work = (async () => {
          if (!streamTs) {
            streamTs = await account.startSlackStream(delivery.connection_id, {
              channelId: streamChannelId,
              threadTimestamp:
                typeof target.threadTimestamp === "string"
                  ? target.threadTimestamp
                  : undefined,
              recipientUserId: delivery.external_user_id ?? undefined,
              // Cards inside a plan block fold into a single "Completed"
              // header once the stream settles — loose timeline cards stay
              // expanded and read as clutter.
              taskDisplayMode: "plan",
            });
            this.ctx.storage.sql.exec(
              `UPDATE slack_deliveries
               SET progress_message_timestamp = ? WHERE turn_id = ?`,
              streamTs,
              turnId,
            );
          }
          await account.appendSlackStream(delivery.connection_id, {
            channelId: streamChannelId,
            messageTimestamp: streamTs,
            chunks,
          });
        })();
        this.ctx.waitUntil(work);
        await work;
      },
      stop: async () => {
        if (!streamTs) return;
        const ts = streamTs;
        streamTs = undefined;
        const work = (async () => {
          await account.stopSlackStream(delivery.connection_id, {
            channelId: streamChannelId,
            messageTimestamp: ts,
          });
          this.ctx.storage.sql.exec(
            `UPDATE slack_deliveries
             SET progress_message_timestamp = NULL WHERE turn_id = ?`,
            turnId,
          );
        })();
        this.ctx.waitUntil(work);
        await work;
      },
    };
    const progress = new SlackProgress(async (status) => {
      const update = account
        .setSlackStatus(delivery.connection_id, {
          ...target,
          status,
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: "warn",
              event: "slack.progress_update_failed",
              turnId,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      this.ctx.waitUntil(update);
      await update;
    }, stream);
    this.slackProgress.set(turnId, progress);
    return progress;
  }

  /**
   * Finishes a turn's visible progress: completes the open task card, drains
   * queued chunks, and stops the thinking-steps stream so no plan block is
   * left spinning. The status line belongs to the thread, not to this turn —
   * a queued or running successor is already writing to it and will clear it
   * when its own answer goes out; clearing here would blank its line.
   */
  private async stopSlackProgress(turnId: string): Promise<void> {
    const progress = this.progressForTurn(turnId, false);
    if (!progress) return;
    const successor = this.ctx.storage.sql
      .exec<{ found: number }>(
        `SELECT 1 AS found FROM turns
         WHERE status IN ('queued', 'running') AND id != ?
         LIMIT 1`,
        turnId,
      )
      .toArray()[0];
    await progress.stop({ clear: !successor }).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "slack.progress_clear_failed",
          turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  /**
   * The one write that moves a turn to a terminal status, and with it the
   * one place settlement order is assigned: `settled_seq` takes the value
   * above the highest stamped so far (`NEXT_SETTLED_SEQ_SQL`, one index
   * step), in the same statement as the status, so a settlement without an
   * order cannot exist. `from` names what the turn may leave: a running
   * turn for every settlement but the session end, which cancels queued
   * turns too. Answers whether the row was this call's to settle; the
   * caller writes the terminal event only then, and a turn settled by
   * someone else is left alone.
   */
  private settleTurn(
    turnId: string,
    status: SettledTurnStatus,
    timestamp: string,
    from: "running" | "outstanding" = "running",
  ): boolean {
    // rowsWritten counts index entries too; any write means the row was ours.
    const settled =
      this.ctx.storage.sql.exec(
        `UPDATE turns
         SET status = ?, lease_deadline_at_ms = NULL, updated_at = ?,
             settled_seq = (${NEXT_SETTLED_SEQ_SQL})
         WHERE id = ?
           AND status IN (${from === "outstanding" ? "'queued', 'running'" : "'running'"})`,
        status,
        timestamp,
        turnId,
      ).rowsWritten > 0;
    if (settled) this.recordTurnRuntime(turnId, timestamp);
    return settled;
  }

  private appendEvent(
    type: AgentEventType,
    turnId: string | undefined,
    input: Record<string, unknown>,
    timestamp = now(),
  ): AgentEvent {
    const session = this.requireSession();
    if (turnId && TERMINAL_TURN_EVENT_TYPES.has(type)) {
      // The turn's word is final: every tool call it started and never
      // completed or failed on its own is settled here, ahead of the
      // terminal event, so no row is left running in a consumer's view.
      this.settledToolCalls.push(...this.settleOpenToolCalls(turnId, type, timestamp));
    }
    const data = TOOL_CALL_EVENT_TYPES.has(type)
      ? this.toolEventData(session, turnId ?? "", input)
      : input;
    const restoresCountability =
      type === "turn.completed" ||
      (type === "usage.recorded" && Number(session.countable) === 0);
    if (restoresCountability) {
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET countable = 1, exclusion_reason = NULL, outcome_at = ?
         WHERE id = ?`,
        timestamp,
        session.id,
      );
    } else if (type === "turn.failed") {
      // Ship the raw failure cause to Axiom. This DO drains its console output
      // through `tail_consumers` (opencomputer-log-tail-prod → dataset
      // oc-platform-edge), and the public API redacts turn.failed down to a
      // generic `agent_failed` — so this single line is the only queryable
      // record of *why* a cell actually died. Fires once, on first append (not
      // on replay), carrying the full session context to group by.
      const failure = data as Record<string, unknown>;
      console.error(
        "managed-agent turn.failed",
        JSON.stringify({
          event: "managed_agent_turn_failed",
          sessionId: session.id,
          turnId: turnId ?? null,
          accountId: session.account_id,
          userId: session.user_id,
          projectId: session.project_id,
          agentId: session.agent_id,
          deploymentId: session.deployment_id,
          executionMode: session.execution_mode,
          environment: session.environment,
          code: typeof failure.code === "string" ? failure.code : null,
          message:
            typeof failure.message === "string"
              ? failure.message.slice(0, 16_384)
              : String(failure.message ?? ""),
        }),
      );
      const exclusionReason = countabilityExclusionReason(data);
      const usefulWork = this.ctx.storage.sql
        .exec<{ found: number }>(
          `SELECT 1 AS found FROM events
           WHERE type IN ('usage.recorded', 'turn.completed') LIMIT 1`,
        )
        .toArray()[0];
      if (exclusionReason && !usefulWork) {
        this.ctx.storage.sql.exec(
          `UPDATE session
           SET countable = 0, exclusion_reason = ?, outcome_at = ?
           WHERE id = ?`,
          exclusionReason,
          timestamp,
          session.id,
        );
      }
    }
    const eventId = crypto.randomUUID();
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `INSERT INTO events (id, timestamp, turn_id, type, data)
         VALUES (?, ?, ?, ?, ?)
         RETURNING seq`,
        eventId,
        timestamp,
        turnId ?? null,
        type,
        JSON.stringify(data),
      )
      .toArray()[0];
    if (!row) {
      throw new Error("Failed to persist session event");
    }
    if (PUBLISHED_EVENT_TYPES.has(type) || restoresCountability) {
      this.bumpRevision(timestamp);
    }
    return {
      id: eventId,
      seq: row.seq,
      timestamp,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      accountId: session.account_id,
      agentId: session.agent_id,
      deploymentId: session.deployment_id,
      sessionId: session.id,
      turnId,
      type,
      data,
    };
  }

  /**
   * Inside the transaction that ends a turn: a `tool.failed` for each
   * `tool.started` of the turn with no `tool.completed` or `tool.failed`
   * under the same call id, carrying the call's identity and which terminal
   * event settled it. Returned for broadcast, appended before the caller's
   * terminal event.
   */
  private settleOpenToolCalls(
    turnId: string,
    settledBy: AgentEventType,
    timestamp: string,
  ): AgentEvent[] {
    const open = this.ctx.storage.sql
      .exec<{
        call_id: string | null;
        tool: string | null;
        title: string | null;
        message_id: string | null;
      }>(OPEN_TOOL_CALLS_SQL, turnId, turnId)
      .toArray();
    return open.flatMap((call) =>
      call.call_id
        ? [
            this.appendEvent(
              "tool.failed",
              turnId,
              {
                callId: call.call_id,
                tool: call.tool ?? "tool",
                title: call.title ?? call.tool ?? "tool",
                message: `The turn ended (${settledBy}) before this tool call completed`,
                settledBy,
                messageId: call.message_id ?? "",
              },
              timestamp,
            ),
          ]
        : [],
    );
  }

  /**
   * The session's part of every tool call's host identity, from the row
   * admission wrote. The environment is the one admission resolved (the
   * request's, else the pinned deployment's alias at that moment); a row
   * admitted before that was recorded falls back to its own environment.
   */
  private sessionIdentity(session: SessionRow): SessionIdentity {
    const environment = session.identity_environment ?? session.environment;
    return {
      projectId: session.project_id ?? `project:${session.agent_id}`,
      environment: isProjectEnvironmentName(environment) ? environment : "development",
      agentId: session.agent_id,
      deploymentId: session.deployment_id,
      sessionId: session.id,
    };
  }

  /**
   * A `tool.*` event's data with the call's host identity on it. The turn is
   * the one the event is appended under, the call is the event's `callId`,
   * and the message is what the runtime host reported for the call (carried
   * in as `messageId`, consumed here). Written last, so nothing a tool put
   * in its progress metadata or a runtime put in a frame can stand in for
   * it.
   */
  private toolEventData(
    session: SessionRow,
    turnId: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const { messageId, identity: _ignored, ...rest } = data;
    const sessionIdentity = this.sessionIdentity(session);
    const providerCallId = typeof rest.callId === "string" ? rest.callId : "";
    const resolvedMessageId = typeof messageId === "string" ? messageId : "";
    const identity: ToolInvocationIdentity = {
      ...sessionIdentity,
      turnId,
      messageId: resolvedMessageId,
      providerCallId,
      toolCallId: hostToolCallId({
        sessionId: sessionIdentity.sessionId,
        turnId,
        messageId: resolvedMessageId,
        providerCallId,
      }),
    };
    return { ...rest, identity };
  }

  // List projection (design C1, "Projection protocol").
  //
  // The session keeps a monotonic revision. Every listed mutation runs in a
  // transaction that bumps it and upserts the single pending_publication row:
  // appending one of PUBLISHED_EVENT_TYPES bumps, and so do the mutations
  // that publish without such an event (a labels patch, a result commit, a
  // stop recorded or settled). Delivery hands `{ sessionId, revision, row }` to
  // the Account object, which keeps a row only when the revision is newer
  // than the one it holds, so a delayed or duplicated delivery cannot
  // regress a row. The alarm retries with backoff until acknowledged; an
  // eager attempt after each commit keeps the row fresh without waiting for
  // it. Creation publishes synchronously from the create request and leaves
  // the pending row as the durable fallback.

  /** Inside a mutation's transaction: the next revision, and the publication it owes. */
  private bumpRevision(timestamp: string): number {
    const bumped = this.ctx.storage.sql
      .exec<{ revision: number }>(
        "UPDATE session SET revision = revision + 1 RETURNING revision",
      )
      .toArray()[0];
    if (!bumped) throw new Error("Session has not been initialized");
    const revision = Number(bumped.revision);
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_publication (slot, revision, since, attempts, next_attempt_at_ms)
       VALUES (1, ?, ?, 0, ?)
       ON CONFLICT(slot) DO UPDATE SET
         revision = excluded.revision,
         next_attempt_at_ms = excluded.next_attempt_at_ms`,
      revision,
      timestamp,
      Date.now(),
    );
    this.publicationOwed = true;
    return revision;
  }

  /** The publication still owed, or null once the Account object has acknowledged every revision. */
  pendingPublication(): PendingPublicationRow | null {
    return (
      this.ctx.storage.sql
        .exec<PendingPublicationRow>(
          "SELECT revision, since, attempts, next_attempt_at_ms FROM pending_publication WHERE slot = 1",
        )
        .toArray()[0] ?? null
    );
  }

  /** The list row for this session at its current revision. */
  summary(): SessionSummary {
    const session = this.requireSession();
    const active = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id">>(
        "SELECT id FROM turns WHERE status = 'running' ORDER BY created_at, rowid LIMIT 1",
      )
      .toArray()[0];
    const queued = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM turns WHERE status = 'queued'",
      )
      .one().count;
    const settled = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id" | "status" | "updated_at">>(LAST_SETTLED_TURN_SQL)
      .toArray()[0];
    return {
      id: session.id,
      projectId: session.project_id ?? `project:${session.agent_id}`,
      agentId: session.agent_id,
      deploymentId: session.deployment_id,
      environment: isProjectEnvironmentName(session.environment)
        ? session.environment
        : null,
      source: (session.source ?? "api") as SessionSource,
      status: session.status,
      labels: readLabels(session.labels_json),
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      revision: Number(session.revision),
      activity: {
        activeTurnId: active?.id ?? null,
        queued: Number(queued),
        lastSettledTurn: settled
          ? { id: settled.id, status: settled.status, at: settled.updated_at }
          : null,
      },
      result: this.readResult(),
    };
  }

  /**
   * Publishes the current row and answers whether the projection now holds
   * this session at least at that revision (`acknowledged`): written by
   * this call or already held, either way a list read sees it. The pending
   * row stays: this is the synchronous publication of the create request,
   * and the alarm-driven delivery remains the durable path that
   * acknowledges and clears it. A failure to reach the Account object
   * throws; the caller decides what its own answer must be, and the alarm
   * retries regardless.
   */
  async publishSummary(): Promise<{ revision: number; acknowledged: boolean; held: number }> {
    // The alarm is armed before the attempt: if this delivery is lost, the
    // pending row has a driver.
    await this.scheduleAlarm();
    const row = this.summary();
    const outcome = await this.env.ACCOUNTS.getByName(
      this.requireSession().account_id,
    ).acceptSessionPublication({
      sessionId: row.id,
      revision: row.revision,
      row,
      countability: this.countability(),
    });
    return {
      revision: row.revision,
      acknowledged: outcome.revision >= row.revision,
      held: outcome.revision,
    };
  }

  /**
   * Re-delivers a publication that has been owed for longer than the
   * threshold: the reconciliation path's probe. Delivery here also
   * acknowledges, so a session whose alarm was lost is repaired by one call.
   */
  async reconcilePublication(
    olderThanMs: number,
  ): Promise<{ pending: boolean; delivered: boolean }> {
    if (!this.readSession()) return { pending: false, delivered: false };
    const pending = this.pendingPublication();
    if (!pending) return { pending: false, delivered: false };
    if (new Date(pending.since).getTime() > Date.now() - olderThanMs) {
      return { pending: true, delivered: false };
    }
    await this.deliverPublication();
    return { pending: true, delivered: this.pendingPublication() === null };
  }

  /**
   * Delivery of the owed publication, shared by every caller of this
   * activation. Acknowledged revisions (accepted, or already held) clear the
   * pending row up to the delivered revision; a newer bump that landed
   * meanwhile keeps its own row, and a delivery asked for while a drive was
   * in flight makes that drive run once more, so the promise a caller awaits
   * resolves with the newest revision delivered rather than leaving it to
   * the alarm. A failure backs off and re-arms the alarm.
   *
   * Resolves with the highest revision the projection acknowledged during
   * the drive (0 when none was). A caller that must answer for its own
   * mutation compares that with the revision it wrote: joining a drive that
   * was already in flight is not an acknowledgement of anything, only a
   * delivered revision at or above the caller's is.
   */
  private deliverPublication(): Promise<number> {
    this.publicationOwed = false;
    if (this.publicationDrive) {
      this.publicationRequested = true;
      return this.publicationDrive;
    }
    this.publicationDrive = (async () => {
      let acknowledged = 0;
      do {
        this.publicationRequested = false;
        acknowledged = Math.max(acknowledged, await this.deliverPublicationOnce());
      } while (this.publicationRequested && this.pendingPublication() !== null);
      return acknowledged;
    })().finally(() => {
      this.publicationDrive = undefined;
    });
    return this.publicationDrive;
  }

  /** One delivery attempt; the revision the projection then holds, or 0 when it could not be reached. */
  private async deliverPublicationOnce(): Promise<number> {
    const session = this.readSession();
    const pending = session ? this.pendingPublication() : null;
    if (!session || !pending) return 0;
    const row = this.summary();
    try {
      const outcome = await this.env.ACCOUNTS.getByName(session.account_id).acceptSessionPublication({
        sessionId: row.id,
        revision: row.revision,
        row,
        countability: this.countability(),
      });
      this.ctx.storage.sql.exec(
        "DELETE FROM pending_publication WHERE slot = 1 AND revision <= ?",
        row.revision,
      );
      await this.scheduleAlarm();
      return Math.max(outcome.revision, row.revision);
    } catch (error) {
      const attempts = Number(pending.attempts) + 1;
      const backoff =
        PUBLICATION_BACKOFF_MS[Math.min(attempts, PUBLICATION_BACKOFF_MS.length) - 1]!;
      this.ctx.storage.sql.exec(
        `UPDATE pending_publication
         SET attempts = ?, next_attempt_at_ms = ?
         WHERE slot = 1`,
        attempts,
        Date.now() + backoff,
      );
      console.error(
        JSON.stringify({
          level: attempts >= PUBLICATION_BACKOFF_MS.length ? "error" : "warn",
          event: "session.publication_failed",
          sessionId: session.id,
          revision: row.revision,
          attempts,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.scheduleAlarm();
      return 0;
    }
  }

  private countability(): NonNullable<SessionPublication["countability"]> {
    const session = this.requireSession();
    return {
      countable: Number(session.countable) !== 0,
      exclusionReason:
        session.exclusion_reason === "model_credit_exhausted"
          ? session.exclusion_reason
          : null,
      outcomeAt: session.outcome_at ?? null,
    };
  }

  /** Called from the alarm: deliver when the owed publication is due. */
  private async deliverPublicationIfDue(): Promise<void> {
    const pending = this.pendingPublication();
    if (pending && Number(pending.next_attempt_at_ms) <= Date.now()) {
      await this.deliverPublication();
    }
  }

  /**
   * Applies a label patch (per-key last-write-wins) and publishes the row
   * before answering, so a list read after the response reflects it. The
   * bounds are re-checked here: the object is the last line, whatever the
   * caller validated. Allowed on an ended session.
   *
   * The answer is success only once the projection has acknowledged this
   * patch's revision (C1). Otherwise the patch is committed and the alarm
   * keeps delivering it, but the call throws PUBLICATION_UNCONFIRMED: a
   * caller told 200 would read a list that still shows the old labels. A
   * retry of the same patch is idempotent per key and publishes again.
   */
  async updateLabels(patch: LabelPatch): Promise<SessionSnapshot> {
    const session = this.requireSession();
    const applied = applyLabelPatch(readLabels(session.labels_json), patch);
    if ("error" in applied) throw new Error(`${INVALID_LABELS}: ${applied.error}`);
    const timestamp = now();
    const revision = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE session SET labels_json = ?, labels_updated_at = ? WHERE id = ?",
        JSON.stringify(applied.labels),
        timestamp,
        session.id,
      );
      return this.bumpRevision(timestamp);
    });
    const acknowledged = await this.deliverPublication();
    if (acknowledged < revision) {
      throw new Error(
        `${PUBLICATION_UNCONFIRMED}: the labels are recorded at revision ${String(revision)} but the list row is not confirmed; retry the patch`,
      );
    }
    return this.snapshot();
  }

  private eventFromRow(session: SessionRow, row: EventRow): AgentEvent {
    const parsed: unknown = JSON.parse(row.data);
    return {
      id: row.id,
      seq: row.seq,
      timestamp: row.timestamp,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      accountId: session.account_id,
      agentId: session.agent_id,
      deploymentId: session.deployment_id,
      sessionId: session.id,
      turnId: row.turn_id ?? undefined,
      type: row.type,
      data: isRecord(parsed) ? parsed : {},
    };
  }

  /**
   * A running turn's events reach the clients and, on a channel whose
   * provider can edit a message, the status line under the person's message.
   */
  private publishTurnEvents(turnId: string, events: AgentEvent[]): void {
    this.broadcastEvents(events);
    this.linearActivities.onTurnEvents(turnId, events);
    const progress = this.progressForTurn(turnId, false);
    if (!progress) return;
    for (const event of events) {
      if (event.turnId === turnId) progress.handle(event);
    }
  }

  private broadcastEvents(events: AgentEvent[]): void {
    if (this.settledToolCalls.length > 0) {
      // Settlements written ahead of a terminal turn event by appendEvent:
      // broadcast in log order, before the event that caused them.
      events = [...this.settledToolCalls.splice(0), ...events];
    }
    if (this.publicationOwed) {
      // The transaction that bumped the revision has committed; deliver its
      // row now rather than at the alarm. The alarm still owns the retry.
      // The bump, not the event type, is the signal: a result commit or a
      // stop record bumps without appending a published event.
      this.ctx.waitUntil(this.deliverPublication());
    }
    for (const event of events) {
      const frame: SessionToClientFrame = { type: "event", event };
      const encoded = encodeFrame(frame);
      for (const socket of this.ctx.getWebSockets("role:client")) {
        try {
          socket.send(encoded);
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "session.client_broadcast_failed",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }
  }

  private acceptClient(server: WebSocket, url: URL): void {
    const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
    const safeCursor = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    const attachment: ClientConnectionAttachment = {
      role: "client",
      connectionId: crypto.randomUUID(),
    };
    this.ctx.acceptWebSocket(server, ["role:client"]);
    server.serializeAttachment(attachment);
    server.send(
      encodeFrame({
        type: "ready",
        sessionId: this.requireSession().id,
        cursor: safeCursor,
      }),
    );
    for (const event of this.listEvents(safeCursor)) {
      server.send(encodeFrame({ type: "event", event }));
    }
  }

  private acceptRuntime(server: WebSocket): void {
    for (const existing of this.ctx.getWebSockets("role:runtime")) {
      existing.close(4001, "Runtime replaced");
    }

    const runtimeId = crypto.randomUUID();
    const timestamp = now();
    const session = this.requireSession();
    const epoch = session.runtime_epoch + 1;
    const statusEvent = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET runtime_id = ?, runtime_epoch = ?, status = 'connecting',
             updated_at = ?
         WHERE id = ?`,
        runtimeId,
        epoch,
        timestamp,
        session.id,
      );
      return this.appendEvent(
        "session.status_changed",
        undefined,
        { from: session.status, to: "connecting" },
        timestamp,
      );
    });

    const attachment: RuntimeConnectionAttachment = {
      role: "runtime",
      runtimeId,
      epoch,
    };
    this.ctx.acceptWebSocket(server, ["role:runtime"]);
    server.serializeAttachment(attachment);
    server.send(
      encodeFrame({
        type: "runtime.welcome",
        protocolVersion: AGENT_PROTOCOL_VERSION,
        sessionId: session.id,
        runtimeId,
        epoch,
      }),
    );
    this.broadcastEvents([statusEvent]);
  }

  private async verifyRuntimeToken(token: string): Promise<boolean> {
    const candidate = await sha256(token);
    return constantTimeEqual(
      candidate,
      this.requireSession().runtime_token_hash,
    );
  }

  private async handleClientFrame(
    socket: WebSocket,
    frame: Record<string, unknown>,
  ): Promise<void> {
    if (frame.type === "ping") {
      socket.send(encodeFrame({ type: "pong" }));
      return;
    }
    if (
      frame.type === "turn.create" &&
      typeof frame.input === "string" &&
      typeof frame.idempotencyKey === "string" &&
      (frame.mode === undefined ||
        frame.mode === "queue" ||
        frame.mode === "steer" ||
        frame.mode === "interrupt")
    ) {
      try {
        await this.enqueueTurn({
          input: frame.input,
          idempotencyKey: frame.idempotencyKey,
          mode: frame.mode,
        });
      } catch (error) {
        this.sendClientError(
          socket,
          "turn_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    this.sendClientError(socket, "invalid_frame", "Unsupported client frame");
  }

  private sendClientError(
    socket: WebSocket,
    code: string,
    message: string,
  ): void {
    const frame: SessionToClientFrame = {
      type: "error",
      code,
      message,
    };
    socket.send(encodeFrame(frame));
  }

  private async handleRuntimeFrame(
    socket: WebSocket,
    attachment: RuntimeConnectionAttachment,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const current = this.requireSession();
    if (
      attachment.epoch !== current.runtime_epoch ||
      attachment.runtimeId !== current.runtime_id ||
      frame.epoch !== attachment.epoch
    ) {
      return;
    }

    if (frame.type === "runtime.heartbeat") {
      this.renewRuntimeBillingLease(Date.now());
      this.ctx.waitUntil(this.scheduleAlarm());
      return;
    }

    if (frame.type === "model.configuration.request") {
      const session = this.requireSession();
      const deployment = await this.env.ACCOUNTS.getByName(
        session.account_id,
      ).getDeployment(session.deployment_id);
      const selected =
        deployment?.models?.length === 1
          ? deployment.models[0]
          : deployment?.defaultModel;
      const model = selected
        ? `${selected.provider}/${selected.model}`
        : (this.env as Env & { BLUE_DEFAULT_MODEL?: string }).BLUE_DEFAULT_MODEL ??
          "openrouter/anthropic/claude-sonnet-4.6";
      socket.send(
        encodeFrame({
          type: "model.configuration",
          provider: "openrouter",
          model,
        }),
      );
      return;
    }

    if (frame.type === "tool.applied" && typeof frame.applyId === "string") {
      const session = this.requireSession();
      const account = this.env.ACCOUNTS.getByName(session.account_id);
      const applyId = frame.applyId;
      const ok = frame.ok === true;
      const result = frame.result;
      const message = typeof frame.message === "string" ? frame.message : undefined;
      this.ctx.waitUntil(
        account
          .completeApproval(applyId, {
            ok,
            ...(result !== undefined ? { result } : {}),
            ...(message ? { message } : {}),
          })
          .catch(() => undefined),
      );
      return;
    }

    if (frame.type === "runtime.ready") {
      // A decision can arrive while this session is cold. The write is recorded
      // against this session and waits here until there is a runtime to send it
      // to, which is now.
      const readySession = this.requireSession();
      this.ctx.waitUntil(
        (async () => {
          const account = this.env.ACCOUNTS.getByName(readySession.account_id);
          const waiting = await account.pendingAppliesForSession(
            readySession.id,
          );
          for (const approval of waiting) {
            this.dispatchGatedTool({
              approvalId: approval.id,
              toolId: approval.toolId,
              toolInput: approval.input,
              ...(approval.turnId ? { turnId: approval.turnId } : {}),
              decision: {
                id: approval.id,
                decidedAt: approval.decidedAt ?? new Date().toISOString(),
                ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {}),
              },
            });
          }
        })().catch(() => undefined),
      );
    }

    if (frame.type === "runtime.ready") {
      if (current.status !== "connecting") {
        return;
      }
      const timestamp = now();
      const events = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE session SET status = 'idle', updated_at = ? WHERE id = ?",
          timestamp,
          current.id,
        );
        return [
          this.appendEvent(
            "runtime.connected",
            undefined,
            {
              runtimeId: attachment.runtimeId,
              epoch: attachment.epoch,
            },
            timestamp,
          ),
          this.appendEvent(
            "session.status_changed",
            undefined,
            { from: current.status, to: "idle" },
            timestamp,
          ),
        ];
      });
      this.broadcastEvents(events);
      this.dispatchNextTurn();
      return;
    }

    if (
      frame.type === "event.batch" &&
      typeof frame.frameId === "string" &&
      typeof frame.turnId === "string" &&
      Array.isArray(frame.events)
    ) {
      const runtimeEvents = frame.events
        .map(parseRuntimeEvent)
        .filter((event): event is RuntimeEventInput => event !== null);
      if (runtimeEvents.length !== frame.events.length) {
        return;
      }
      const asked = await askedQuestionOf(frame.turnId, runtimeEvents);
      this.persistRuntimeEvents(
        attachment,
        frame.frameId,
        frame.turnId,
        runtimeEvents,
        asked,
      );
    }
  }

  private persistRuntimeEvents(
    attachment: RuntimeConnectionAttachment,
    frameId: string,
    turnId: string,
    runtimeEvents: RuntimeEventInput[],
    asked?: AskedQuestion,
  ): void {
    const turn = this.ctx.storage.sql
      .exec<
        Pick<TurnRow, "status">
      >("SELECT status FROM turns WHERE id = ?", turnId)
      .toArray()[0];
    if (turn?.status !== "running") {
      return;
    }

    const duplicate = this.ctx.storage.sql
      .exec<{ found: number }>(
        `SELECT 1 AS found
         FROM runtime_frames
         WHERE runtime_id = ? AND frame_id = ?`,
        attachment.runtimeId,
        frameId,
      )
      .toArray()[0];
    if (duplicate) {
      return;
    }
    // A result tool call's completion was written by its commit; the
    // harness's own `tool.completed` for that call is a duplicate.
    runtimeEvents = runtimeEvents.filter(
      (event) =>
        !(
          event.type === "tool.completed" &&
          typeof event.data?.callId === "string" &&
          this.resultReceiptExists(turnId, event.data.callId)
        ),
    );

    let terminalStatus: SettledTurnStatus | undefined;
    for (const event of runtimeEvents) {
      if (event.type === "turn.completed") terminalStatus = "completed";
      if (event.type === "turn.failed") {
        terminalStatus = "failed";
        console.error(
          JSON.stringify({
            level: "error",
            event: "runtime.turn_failed",
            sessionId: this.requireSession().id,
            turnId,
            message:
              typeof event.data?.message === "string"
                ? event.data.message
                : "Runtime turn failed without an error message",
          }),
        );
      }
      if (event.type === "turn.cancelled") terminalStatus = "cancelled";
    }

    const timestamp = now();
    const persisted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO runtime_frames (runtime_id, frame_id, received_at)
         VALUES (?, ?, ?)`,
        attachment.runtimeId,
        frameId,
        timestamp,
      );
      const events: AgentEvent[] = [];
      for (const event of runtimeEvents) {
        if (event.type !== "turn.completed") {
          events.push(this.appendEvent(event.type, turnId, event.data ?? {}, timestamp));
          continue;
        }
        // As on the Workerd path: a reply that moves past an open `flow`
        // question retires it, then this turn's own question (from an
        // `ask` call, carried on the completion) commits with the turn.
        events.push(
          ...this.supersedeQuestionInTransaction(
            turnId,
            { asked: Boolean(asked), finalText: this.finalTextOfTurn(turnId) },
            timestamp,
          ),
          ...(asked ? this.commitAskedQuestion(turnId, asked, timestamp) : []),
          this.appendEvent(
            "turn.completed",
            turnId,
            asked ? { outcome: "question", questionId: asked.id } : {},
            timestamp,
          ),
        );
      }
      if (terminalStatus) {
        const session = this.requireSession();
        this.settleTurn(turnId, terminalStatus, timestamp);
        for (const event of events) {
          if ((OUTCOME_EVENT_TYPES as readonly string[]).includes(event.type)) {
            this.recordOutcomeDeliveries(turnId, event);
          }
        }
        if (asked && terminalStatus === "completed") {
          events.push(...this.afterQuestionCommittedInTransaction(turnId, asked, timestamp));
        }
        const pendingWork = this.ctx.storage.sql
          .exec<{ found: number }>(
            "SELECT 1 AS found FROM turns WHERE status IN ('queued', 'running') LIMIT 1",
          )
          .toArray()[0];
        if (!pendingWork) {
          this.ctx.storage.sql.exec(
            "UPDATE session SET status = 'idle', updated_at = ? WHERE id = ?",
            timestamp,
            session.id,
          );
          events.push(
            this.appendEvent(
              "session.status_changed",
              undefined,
              { from: session.status, to: "idle" },
              timestamp,
            ),
          );
        }
      }
      return events;
    });

    this.publishTurnEvents(turnId, persisted);
    if (terminalStatus) {
      // A question this settlement superseded loses its buttons.
      this.refreshQuestionCardsFor(persisted);
      this.ctx.waitUntil(this.deliverSlackTurn(turnId));
      this.ctx.waitUntil(this.linearActivities.afterSettlement());
      this.ctx.waitUntil(this.armChannelIdleSuspend());
      this.ctx.waitUntil(this.scheduleAlarm());
      this.dispatchNextTurn();
    }
  }

  /**
   * Write an attempt's outcome, if the row is still that attempt's: pending
   * and at the attempt number it took. Returns whether it was.
   */
  private settleChannelAttempt(
    turnId: string,
    attempt: number,
    status: "delivered" | "pending" | "failed",
    nextAttemptAtMs: number | null,
  ): boolean {
    return (
      this.ctx.storage.sql.exec(
        `UPDATE slack_deliveries
         SET status = ?, next_attempt_at_ms = ?, lease_until_ms = NULL, updated_at = ?
         WHERE turn_id = ? AND status = 'pending' AND attempts = ?`,
        status,
        nextAttemptAtMs,
        now(),
        turnId,
        attempt,
      ).rowsWritten > 0
    );
  }

  /**
   * The admission ack, when its grace window ended and the turn still runs.
   * Sent at most once per delivery: clearing ack_due_at_ms first is what a
   * racing alarm or a retried call checks — a lost post afterwards just
   * means no ack, which the nicety can afford.
   */
  private async deliverChannelAdmissionAck(turnId: string): Promise<void> {
    const claimed =
      this.ctx.storage.sql.exec(
        `UPDATE slack_deliveries
         SET ack_due_at_ms = NULL, updated_at = ?
         WHERE turn_id = ? AND ack_due_at_ms IS NOT NULL`,
        now(),
        turnId,
      ).rowsWritten > 0;
    if (!claimed) return;
    const delivery = this.ctx.storage.sql
      .exec<SlackDeliveryRow>(
        `SELECT turn_id, connected_account_id AS connection_id, channel_id,
                thread_timestamp, status, attempts, provider, delivery_ref,
                next_attempt_at_ms, lease_until_ms, ack_due_at_ms
         FROM slack_deliveries
         WHERE turn_id = ?`,
        turnId,
      )
      .toArray()[0];
    const turn = this.ctx.storage.sql
      .exec<Pick<TurnRow, "status">>("SELECT status FROM turns WHERE id = ?", turnId)
      .toArray()[0];
    // A turn already settled has its answer on the way — that is the
    // acknowledgement, and the ack would only be noise behind it.
    if (
      !delivery ||
      !delivery.provider ||
      !delivery.delivery_ref ||
      !turn ||
      (turn.status !== "queued" && turn.status !== "running")
    ) {
      return;
    }
    const session = this.requireSession();
    const url = channelSessionUrl(this.env, session);
    const text =
      delivery.provider === "slack"
        ? `On it — working in [this session](${url})`
        : `On it — working in ${url}`;
    try {
      await this.env.ACCOUNTS.getByName(session.account_id).sendChannelReply(
        delivery.provider,
        delivery.connection_id,
        JSON.parse(delivery.delivery_ref),
        text,
      );
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "channel.ack_failed",
          sessionId: session.id,
          turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private logChannelAttemptSuperseded(turnId: string, attempt: number, at: string): void {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "channel.reply_attempt_superseded",
        sessionId: this.requireSession().id,
        turnId,
        attempt,
        at,
      }),
    );
  }

  /**
   * Answer the conversation a settled turn belongs to. At least once: the
   * provider has no idempotency key, so a reply it accepted just before this
   * object died is sent again by the next attempt. The settlement tries first;
   * a pending reply whose turn is settled is due for the alarm from then on,
   * so a settlement whose attempt was lost with its activation is retried
   * rather than stranded. Each attempt holds a lease; a caller that finds one
   * leaves, whichever activation took it.
   */
  private async deliverSlackTurn(turnId: string): Promise<void> {
    const delivery = this.ctx.storage.sql
      .exec<SlackDeliveryRow>(
        `SELECT turn_id, connected_account_id AS connection_id, channel_id,
                thread_timestamp, status, attempts, provider, delivery_ref,
                next_attempt_at_ms, lease_until_ms
         FROM slack_deliveries
         WHERE turn_id = ?`,
        turnId,
      )
      .toArray()[0];
    if (!delivery || delivery.status !== "pending") return;
    const turn = this.ctx.storage.sql
      .exec<
        Pick<TurnRow, "status" | "updated_at">
      >("SELECT status, updated_at FROM turns WHERE id = ?", turnId)
      .toArray()[0];
    if (!turn || !["completed", "failed", "cancelled"].includes(turn.status)) {
      return;
    }
    // The lease, before any await: whoever else arrives finds it and leaves.
    const attempt = delivery.attempts + 1;
    const leased = this.ctx.storage.sql.exec(
      `UPDATE slack_deliveries
       SET attempts = ?, lease_until_ms = ?, updated_at = ?
       WHERE turn_id = ? AND status = 'pending' AND attempts = ?
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
      attempt,
      Date.now() + CHANNEL_DELIVERY_LEASE_MS,
      now(),
      turnId,
      delivery.attempts,
      Date.now(),
    ).rowsWritten;
    if (!leased) return;
    const platform = this.env as Env & { RUNTIMES?: Fetcher };
    const session = this.requireSession();
    const account = this.env.ACCOUNTS.getByName(session.account_id);
    const completed = this.ctx.storage.sql
      .exec<{ data: string }>(
        `SELECT data FROM events
         WHERE turn_id = ? AND type = 'message.completed'
         ORDER BY seq DESC LIMIT 1`,
        turnId,
      )
      .toArray()[0];
    const parsed = completed ? parseJsonRecord(completed.data) : null;
    const answered = completionAnswer(parsed).trim();
    // A turn that asked a person answers with the question itself (slack-ux
    // P2): its text and one button per option, posted as the turn's only
    // reply, whatever text the model wrote before asking.
    const question =
      turn.status === "completed" && (delivery.provider ?? "slack") === "slack"
        ? this.channelQuestionOfTurn(turnId)
        : undefined;
    // A completed turn that said nothing sends nothing. Silence is a real
    // answer on a channel — someone texted STOP, a human picked up the thread,
    // the message needed no reply — and an agent has no other way to express
    // it, because everything it writes is delivered. Filling the gap with
    // "Done." texts a customer who asked to be left alone.
    if (turn.status === "completed" && !answered && !question) {
      // Silence still finalizes the thinking-steps stream — dropping the
      // progress without stop() would strand its plan block spinning.
      await this.stopSlackProgress(turnId);
      this.slackProgress.delete(turnId);
      this.settleChannelAttempt(turnId, attempt, "delivered", null);
      return;
    }
    // A failure still speaks: the person is owed an answer, and silence there
    // reads as being ignored rather than as a considered decision.
    const text =
      turn.status === "completed"
        ? answered
        : "OpenComputer could not complete this request. Please try again.";
    // A Slack answer ends with the arrow link to its session for the detail
    // the message cannot hold; a text message stays just text.
    const body =
      (delivery.provider ?? "slack") === "slack"
        ? `${text} [↗](${channelSessionUrl(this.env, session)})`
        : text;
    try {
      await this.stopSlackProgress(turnId);
      // Clearing the line may have used most of the lease. Renew it for the
      // send, and if the lease has meanwhile passed to a later attempt, send
      // nothing: that attempt is answering, and a second post would be a
      // duplicate the person can see.
      const renewed = this.ctx.storage.sql.exec(
        `UPDATE slack_deliveries
         SET lease_until_ms = ?
         WHERE turn_id = ? AND status = 'pending' AND attempts = ?`,
        Date.now() + CHANNEL_DELIVERY_LEASE_MS,
        turnId,
        attempt,
      ).rowsWritten;
      if (!renewed) {
        this.logChannelAttemptSuperseded(turnId, attempt, "before_send");
        return;
      }
      if (question) {
        await this.postQuestionMessage(account, delivery, question);
      } else {
        await account.sendChannelReply(
          delivery.provider ?? "slack",
          delivery.connection_id,
          deliveryTarget(delivery),
          body,
        );
      }
      this.slackProgress.delete(turnId);
      // The row is this attempt's only while it still holds it. A later
      // attempt that took over after this one's lease expired has already
      // written its own outcome, and this one's word is late, not final.
      if (!this.settleChannelAttempt(turnId, attempt, "delivered", null)) {
        this.logChannelAttemptSuperseded(turnId, attempt, "after_send");
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A permanent failure is retired immediately rather than retried: the
      // bot is not in that channel and will not be by the next attempt. A
      // provider that named its own wait is not asked again before it.
      const backoff = CHANNEL_DELIVERY_BACKOFF_MS[attempt - 1];
      const exhausted = permanentDeliveryFailure(message) || backoff === undefined;
      const wait = Math.max(backoff ?? 0, retryAfterFromMessage(message) ?? 0);
      const settled = this.settleChannelAttempt(
        turnId,
        attempt,
        exhausted ? "failed" : "pending",
        exhausted ? null : Date.now() + wait,
      );
      if (!settled) {
        this.logChannelAttemptSuperseded(turnId, attempt, "after_failure");
        return;
      }
      // A question whose card can never be posted closes `undeliverable`,
      // and what it held runs as ordinary turns (design 018).
      if (exhausted && question) this.questionCardUndeliverable(question.id);
      console.error(
        JSON.stringify({
          level: exhausted ? "error" : "warn",
          event: "slack.delivery_failed",
          sessionId: session.id,
          turnId,
          attempt,
          exhausted,
          message,
        }),
      );
      await account
        .recordChannelDelivery(
          delivery.provider ?? "slack",
          delivery.connection_id,
          "failed",
          "turn_delivery_failed",
        )
        .catch(() => undefined);
      if (!exhausted) await this.scheduleAlarm();
      return;
    }
    // The reply is out. Two timestamps and the ids, so the time from a turn
    // settling to its answer leaving can be read off the logs.
    console.log(
      JSON.stringify({
        level: "info",
        event: "channel.reply_delivered",
        sessionId: session.id,
        turnId,
        provider: delivery.provider ?? "slack",
        turnStatus: turn.status,
        settledAt: turn.updated_at,
        deliveredAt: now(),
      }),
    );
    // Bookkeeping on the connection's health is not the delivery: a failure
    // here is logged, never a reason to send the answer again.
    await account
      .recordChannelDelivery(
        delivery.provider ?? "slack",
        delivery.connection_id,
        "delivered",
      )
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: "warn",
            event: "channel.delivery_bookkeeping_failed",
            sessionId: session.id,
            turnId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    try {
      await this.suspendAfterChannelTurn(platform);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "slack.runtime_suspend_failed",
          turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Wake a suspended runtime that has work waiting: a queued turn, or an
   * approved write still applying. Every input reaches the runtime through a
   * queued turn, so this is the one place a session wakes; nothing has to
   * call resume first. A sandbox suspended by snapshot-and-terminate boots a
   * fresh runtime from its snapshot (the DO-first start); a runtime that
   * resumes in place is asked to. A woken turn has `RUNTIME_WAKE_TIMEOUT_MS`
   * to see the runtime connect before the alarm wakes it again, and fails
   * after `RUNTIME_WAKE_ATTEMPTS` (`expireRuntimeWake`).
   *
   * Idempotent: it acts only on a `suspended` runtime, and moves it out of
   * that state before its first await. `retry` also restarts a sandbox
   * whose start failed and re-asks a resume that never landed.
   */
  private async wakeRuntime(retry = false): Promise<void> {
    const session = this.readSession();
    const platform = this.env as Env & { RUNTIMES?: Fetcher; DO_FIRST_SESSION_SPIKE?: string };
    if (!session || session.status === "ended" || session.execution_mode === "workerd") return;
    const wakeable = () => {
      const binding = this.readMicrovmBinding();
      if (binding?.state === "suspended") return true;
      if (!retry) return false;
      return binding
        ? binding.state === "resuming"
        : this.requireSession().runtime_start_state === "unclaimed";
    };
    if (!wakeable()) return;
    const queued = this.hasQueuedTurn();
    if (!queued) {
      const applying = await this.env.ACCOUNTS.getByName(session.account_id)
        .pendingAppliesForSession(session.id)
        .catch(() => []);
      if (!applying.length) return;
    } else {
      // The turn was admitted, but the organization may have halted since:
      // a halted organization's runtime is not woken. An unavailable billing
      // service does not hold up a turn that was already admitted.
      try {
        await requireAutonomousBillingAdmission(platform as AutonomousBillingEnv, session.account_id);
      } catch (error) {
        if (
          error instanceof AutonomousBillingAdmissionError &&
          error.code === "insufficient_credits"
        ) {
          this.failQueuedTurns("insufficient_credits", "Insufficient prepaid credits");
          return;
        }
      }
    }
    // Re-read after the awaits: a concurrent wake may have taken it.
    if (!wakeable()) return;
    const binding = this.readMicrovmBinding();
    const microvmId = binding?.microvm_id;
    if (queued) await this.armRuntimeWake();
    try {
      if (
        platform.DO_FIRST_SESSION_SPIKE === "true" &&
        (!microvmId || isModalSandboxId(microvmId))
      ) {
        // No runtime to resume in place: let go of the suspended one and
        // boot a fresh one from its snapshot, as the resume route does.
        if (microvmId && !this.releaseRuntimeForRestart()) return;
        await this.startSandboxRuntime(session);
        return;
      }
      if (!microvmId || !platform.RUNTIMES) return;
      this.updateMicrovmState({ microvmId, state: "resuming" });
      const response = await platform.RUNTIMES.fetch(
        `https://blue-runtime/v1/sessions/${encodeURIComponent(session.id)}/resume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: session.account_id,
            microvmId,
          }),
        },
      );
      if (!response.ok) {
        this.updateMicrovmState({ microvmId, state: "suspended" });
        throw new Error(`runtime returned ${String(response.status)}`);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "runtime.wake_failed",
          sessionId: session.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** Boot this session's sandbox runtime through the DO-first start, as the HTTP routes do. */
  private async startSandboxRuntime(session: SessionRow): Promise<void> {
    if (!session.runtime_edge) throw new Error("The session has no runtime edge");
    await startSandboxSessionRuntime(this.env as Env & RuntimeLaunchEnv, {
      accountId: session.account_id,
      session: this.env.SESSIONS.get(this.ctx.id),
      edge: session.runtime_edge,
      configuration: async (snapshot) => {
        const deployment = await this.env.ACCOUNTS.getByName(
          session.account_id,
        ).sessionRuntimeDeployment(session.account_id, snapshot.deploymentId);
        if (!deployment) {
          throw new Error("The pinned deployment configuration is unavailable");
        }
        return { projectId: snapshot.projectId, deployment };
      },
    });
  }

  private hasQueuedTurn(): boolean {
    return Boolean(
      this.ctx.storage.sql
        .exec<{ found: number }>("SELECT 1 AS found FROM turns WHERE status = 'queued' LIMIT 1")
        .toArray()[0],
    );
  }

  private runtimeConnected(): boolean {
    return this.ctx
      .getWebSockets("role:runtime")
      .some((socket) => socket.readyState === WebSocket.OPEN);
  }

  private async armRuntimeWake(): Promise<void> {
    const attempts = (await this.ctx.storage.get<number>("runtimeWakeAttempts")) ?? 0;
    await this.ctx.storage.put({
      runtimeWakeAttempts: attempts + 1,
      runtimeWakeAtMs: Date.now() + RUNTIME_WAKE_TIMEOUT_MS,
    });
    await this.scheduleAlarm();
  }

  /**
   * At a wake's deadline: done if the runtime connected or nothing is
   * queued any more; otherwise wake again, or, out of attempts, fail the
   * queued turns rather than leave them waiting for a runtime that is not
   * coming (a session stuck there also counts as a schedule's overlap).
   */
  private async expireRuntimeWake(): Promise<void> {
    const deadline = await this.ctx.storage.get<number>("runtimeWakeAtMs");
    if (!deadline || Date.now() < deadline) return;
    const attempts = (await this.ctx.storage.get<number>("runtimeWakeAttempts")) ?? 0;
    await this.ctx.storage.delete("runtimeWakeAtMs");
    if (this.runtimeConnected() || !this.hasQueuedTurn()) {
      await this.ctx.storage.delete("runtimeWakeAttempts");
      return;
    }
    if (attempts < RUNTIME_WAKE_ATTEMPTS) {
      await this.wakeRuntime(true);
      // Nothing to wake (a runtime that started and never connected): the
      // attempt still counts, so the next deadline settles it.
      if (!(await this.ctx.storage.get<number>("runtimeWakeAtMs"))) {
        await this.armRuntimeWake();
      }
      return;
    }
    await this.ctx.storage.delete("runtimeWakeAttempts");
    const session = this.readSession();
    console.error(
      JSON.stringify({
        level: "error",
        event: "runtime.wake_exhausted",
        sessionId: session?.id,
        attempts,
        microvmState: this.readMicrovmBinding()?.state ?? null,
      }),
    );
    this.failQueuedTurns(
      "runtime_wake_failed",
      `The agent runtime did not come back from suspend after ${String(attempts)} attempts`,
    );
  }

  /** Fail every queued turn with `code`, settling the session as a runtime's `turn.failed` does. */
  private failQueuedTurns(code: string, message: string): void {
    const timestamp = now();
    const failed: string[] = [];
    const events = this.ctx.storage.transactionSync(() => {
      const session = this.requireSession();
      const output: AgentEvent[] = [];
      const queued = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM turns WHERE status = 'queued' ORDER BY created_at, rowid",
        )
        .toArray();
      for (const turn of queued) {
        if (!this.settleTurn(turn.id, "failed", timestamp, "outstanding")) continue;
        const event = this.appendEvent("turn.failed", turn.id, { code, message }, timestamp);
        if ((OUTCOME_EVENT_TYPES as readonly string[]).includes(event.type)) {
          this.recordOutcomeDeliveries(turn.id, event);
        }
        output.push(event);
        failed.push(turn.id);
      }
      const pendingWork = this.ctx.storage.sql
        .exec<{ found: number }>(
          "SELECT 1 AS found FROM turns WHERE status IN ('queued', 'running') LIMIT 1",
        )
        .toArray()[0];
      if (failed.length && !pendingWork && session.status !== "idle") {
        this.ctx.storage.sql.exec(
          "UPDATE session SET status = 'idle', updated_at = ? WHERE id = ?",
          timestamp,
          session.id,
        );
        output.push(
          this.appendEvent(
            "session.status_changed",
            undefined,
            { from: session.status, to: "idle" },
            timestamp,
          ),
        );
      }
      return output;
    });
    for (const turnId of failed) {
      this.publishTurnEvents(
        turnId,
        events.filter((event) => event.turnId === turnId),
      );
      this.ctx.waitUntil(this.deliverSlackTurn(turnId));
    }
    this.broadcastEvents(events.filter((event) => !event.turnId));
    if (failed.length) {
      this.ctx.waitUntil(this.linearActivities.afterSettlement());
      this.ctx.waitUntil(this.scheduleAlarm());
    }
  }

  private async suspendAfterChannelTurn(platform: {
    RUNTIMES?: Fetcher;
  }): Promise<void> {
    const session = this.requireSession();
    const microvm = this.readMicrovmBinding();
    if (!platform.RUNTIMES || !microvm || microvm.state !== "running") return;
    const active = this.ctx.storage.sql
      .exec<{ found: number }>(
        `SELECT 1 AS found FROM turns
         WHERE status IN ('queued', 'running')
         LIMIT 1`,
      )
      .toArray()[0];
    if (active) return;
    this.updateMicrovmState({
      microvmId: microvm.microvm_id,
      state: "suspending",
    });
    const response = await platform.RUNTIMES.fetch(
      `https://blue-runtime/v1/sessions/${encodeURIComponent(session.id)}/suspend`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: session.account_id,
          microvmId: microvm.microvm_id,
        }),
      },
    );
    this.updateMicrovmState({
      microvmId: microvm.microvm_id,
      state: response.ok ? "suspended" : "running",
    });
  }

  private dispatchNextTurn(): void {
    const active = this.ctx.storage.sql
      .exec<{
        id: string;
      }>("SELECT id FROM turns WHERE status = 'running' LIMIT 1")
      .toArray()[0];
    if (active) {
      return;
    }
    if (this.pendingWorkerdStop()) {
      // The host has not acknowledged the last stop: whatever it is still
      // executing owns the session until it has. Driving the stop
      // dispatches on acknowledgement; the alarm re-drives a lost attempt.
      this.ctx.waitUntil(this.driveWorkerdStop());
      return;
    }

    const queued = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id" | "input" | "input_json">>(
        `SELECT id, input, input_json
         FROM turns
         WHERE status = 'queued'
         ORDER BY CASE WHEN mode = 'interrupt' THEN 0 ELSE 1 END,
                  created_at, rowid
         LIMIT 1`,
      )
      .toArray()[0];
    if (!queued) {
      return;
    }

    const session = this.requireSession();
    if (session.execution_mode === "workerd") {
      const timestamp = now();
      const events = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE turns
           SET status = 'running', lease_deadline_at_ms = ?, updated_at = ?
           WHERE id = ?`,
          Date.now() + WORKERD_TURN_LEASE_MS,
          timestamp,
          queued.id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE session SET status = 'running', updated_at = ? WHERE id = ?",
          timestamp,
          session.id,
        );
        return [
          this.appendEvent("turn.started", queued.id, {}, timestamp),
          this.appendEvent(
            "session.status_changed",
            undefined,
            { from: session.status, to: "running" },
            timestamp,
          ),
        ];
      });
      this.broadcastEvents(events);
      this.progressForTurn(queued.id, false)?.runtimeReady();
      this.ctx.waitUntil(this.scheduleAlarm());
      const dispatched = this.dispatchedTurn(queued.input_json, queued.input);
      this.ctx.waitUntil(
        this.executeWorkerdTurn(queued.id, dispatched.text, dispatched.agentInput),
      );
      return;
    }

    const runtime = this.ctx
      .getWebSockets("role:runtime")
      .find((socket) => socket.readyState === WebSocket.OPEN);
    if (!runtime) {
      this.transitionSession("waiting_runtime");
      // A runtime the idle timer suspended comes back for the turn.
      this.ctx.waitUntil(this.wakeRuntime());
      return;
    }

    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE turns SET status = 'running', updated_at = ? WHERE id = ?",
        timestamp,
        queued.id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET status = 'running', updated_at = ? WHERE id = ?",
        timestamp,
        session.id,
      );
      return [
        this.appendEvent("turn.started", queued.id, {}, timestamp),
        this.appendEvent(
          "session.status_changed",
          undefined,
          { from: session.status, to: "running" },
          timestamp,
        ),
      ];
    });
    this.broadcastEvents(events);
    this.progressForTurn(queued.id, false)?.runtimeReady();

    const dispatched = this.dispatchedTurn(queued.input_json, queued.input);
    try {
      runtime.send(
        encodeFrame({
          type: "turn.start",
          turnId: queued.id,
          input: dispatched.text,
          agentInput: dispatched.agentInput,
          identity: this.sessionIdentity(session),
        }),
      );
    } catch {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE turns SET status = 'queued', updated_at = ? WHERE id = ?",
          now(),
          queued.id,
        );
      });
      this.transitionSession("waiting_runtime");
    }
  }

  private workerdRuntime(): Fetcher {
    const runtime = (this.env as Env & { WORKERD_RUNTIME?: Fetcher })
      .WORKERD_RUNTIME;
    if (!runtime) {
      throw new Error("The Workerd OpenCode runtime service is not configured");
    }
    return runtime;
  }

  private pendingWorkerdStop(): WorkerdPendingStopRow | undefined {
    return this.ctx.storage.sql
      .exec<WorkerdPendingStopRow>("SELECT * FROM workerd_pending_stop WHERE slot = 1")
      .toArray()[0];
  }

  /**
   * Inside the transaction that stops a Workerd turn: the durable stop
   * intent, due now, recorded against the runtime generation the session
   * knows (host boot and activation). A stop already pending keeps its
   * attempt count, its request time (the settlement budget's clock) and its
   * escalation, and takes the newer reason and replacement. The turn's lease
   * deadline is cleared: the stop drive owns the turn from here, and lease
   * expiry must not fail it underneath. Returns the event that makes the
   * wait visible on the session.
   */
  private recordWorkerdStop(
    turnId: string | null,
    reason: string,
    timestamp: string,
    options: { replacementTurnId?: string; ask?: PendingAskSettlement } = {},
  ): AgentEvent {
    const workerdSession = this.ctx.storage.sql
      .exec<{ runtime_boot_id: string; runtime_activation: number }>(
        "SELECT runtime_boot_id, runtime_activation FROM workerd_session WHERE slot = 1",
      )
      .toArray()[0];
    const runtimeGeneration = workerdSession
      ? `${workerdSession.runtime_boot_id}:${String(workerdSession.runtime_activation)}`
      : null;
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_pending_stop (
         slot, turn_id, reason, requested_at, attempts, next_attempt_at_ms, last_error,
         runtime_generation, replacement_turn_id, requested_at_ms, terminate_requested, ask_json
       ) VALUES (1, ?, ?, ?, 0, ?, NULL, ?, ?, ?, 0, ?)
       ON CONFLICT(slot) DO UPDATE SET
         turn_id = COALESCE(excluded.turn_id, workerd_pending_stop.turn_id),
         reason = excluded.reason,
         requested_at = excluded.requested_at,
         next_attempt_at_ms = excluded.next_attempt_at_ms,
         runtime_generation = COALESCE(excluded.runtime_generation, workerd_pending_stop.runtime_generation),
         replacement_turn_id = COALESCE(excluded.replacement_turn_id, workerd_pending_stop.replacement_turn_id),
         requested_at_ms = CASE WHEN workerd_pending_stop.requested_at_ms > 0
                                THEN workerd_pending_stop.requested_at_ms
                                ELSE excluded.requested_at_ms END,
         ask_json = excluded.ask_json`,
      turnId,
      reason,
      timestamp,
      Date.now(),
      runtimeGeneration,
      options.replacementTurnId ?? null,
      Date.now(),
      options.ask ? JSON.stringify(options.ask) : null,
    );
    if (turnId) {
      this.ctx.storage.sql.exec(
        "UPDATE turns SET lease_deadline_at_ms = NULL WHERE id = ? AND status = 'running'",
        turnId,
      );
    }
    // The stop is part of what the row's reader sees (`stopping`, the turn
    // still active). The bump lives here rather than in each caller so no
    // caller can record a stop without republishing; a caller that also
    // changes the status bumps again, which the projection tolerates.
    this.bumpRevision(timestamp);
    return this.appendEvent(
      "runtime.log",
      turnId ?? undefined,
      {
        phase: "workerd_stop_requested",
        runtime: "workerd",
        reason,
        ...(runtimeGeneration ? { runtimeGeneration } : {}),
        ...(options.replacementTurnId ? { replacementTurnId: options.replacementTurnId } : {}),
        message: options.ask
          ? "The turn asked a question; it settles once every command it dispatched has settled"
          : "Stopping the running turn on the agent runtime; the next turn starts once its work has settled",
      },
      timestamp,
    );
  }

  /**
   * Drives the pending stop: one bounded `/interrupt` call to the Workerd
   * host, the outcome recorded on the session. A 2xx answer acknowledges
   * that nothing is executing there any more; the row is cleared and the
   * next queued turn dispatches. Anything else (transport failure, timeout,
   * a host that still reports the loop running) keeps the row, backs off
   * and lets the alarm re-drive it; the session stays fenced meanwhile.
   * The row's next attempt is moved to the call deadline and the alarm
   * armed before the call leaves, so an object that dies mid-call is woken.
   *
   * Interrupting the model loop does not cancel a computer command it has
   * already dispatched to the sandbox, nor undo that command's effects.
   */
  private async driveWorkerdStop(): Promise<void> {
    if (this.stopDrive) return this.stopDrive;
    this.stopDrive = this.driveWorkerdStopOnce().finally(() => {
      this.stopDrive = undefined;
    });
    return this.stopDrive;
  }

  private async driveWorkerdStopOnce(): Promise<void> {
    const stop = this.pendingWorkerdStop();
    if (!stop) return;
    const workerdSession = this.ctx.storage.sql
      .exec<{ runtime_session_id: string; opencode_session_id: string }>(
        "SELECT runtime_session_id, opencode_session_id FROM workerd_session WHERE slot = 1",
      )
      .toArray()[0];
    if (!workerdSession) {
      // Nothing was ever started on a host for this session.
      this.settleWorkerdStop(stop, {
        interrupted: false,
        hostTurnId: null,
        generation: null,
        operations: { total: 0, settled: 0 },
        computerTerminated: false,
        attempt: stop.attempts + 1,
      });
      return;
    }
    const attempt = stop.attempts + 1;
    this.ctx.storage.sql.exec(
      "UPDATE workerd_pending_stop SET next_attempt_at_ms = ? WHERE slot = 1",
      Date.now() + WORKERD_STOP_ATTEMPT_DEADLINE_MS,
    );
    await this.scheduleAlarm();
    const requestedAtMs =
      Number(stop.requested_at_ms) > 0
        ? Number(stop.requested_at_ms)
        : Date.parse(stop.requested_at);
    const escalate =
      Number(stop.terminate_requested) === 1 ||
      Date.now() - requestedAtMs >= WORKERD_STOP_SETTLE_BUDGET_MS;
    if (escalate && Number(stop.terminate_requested) !== 1) {
      this.ctx.storage.sql.exec(
        "UPDATE workerd_pending_stop SET terminate_requested = 1 WHERE slot = 1",
      );
    }
    const runtimeBase = `https://workerd-runtime.invalid/sessions/${encodeURIComponent(workerdSession.runtime_session_id)}`;
    const hostStop = async (): Promise<{
      settled: boolean;
      interrupted: boolean;
      active: boolean;
      turnId: string | null;
      generation: number | null;
      operations: { total: number; settled: number; pending: string[]; unverified: string[] };
    }> => {
      // The stop's identity travels with every request: the turn the
      // stop was recorded for, and the runtime generation it was recorded
      // against. A late handler on the host settles only that turn.
      const response = await this.workerdRuntime().fetch(`${runtimeBase}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: workerdSession.opencode_session_id,
          turnId: stop.turn_id,
          runtimeGeneration: stop.runtime_generation,
          reason: stop.reason,
        }),
        signal: AbortSignal.timeout(workerdStopTimeoutMs(this.env)),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok && response.status !== 409) {
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `Workerd runtime stop failed (${String(response.status)})`,
        );
      }
      const operations = isRecord(body.operations) ? body.operations : {};
      return {
        settled: body.settled === true,
        interrupted: body.interrupted === true,
        active: body.active === true,
        turnId: typeof body.turnId === "string" ? body.turnId : null,
        generation: typeof body.generation === "number" ? body.generation : null,
        operations: {
          total: typeof operations.total === "number" ? operations.total : 0,
          settled: typeof operations.settled === "number" ? operations.settled : 0,
          pending: Array.isArray(operations.pending)
            ? operations.pending.filter((id): id is string => typeof id === "string")
            : [],
          unverified: Array.isArray(operations.unverified)
            ? operations.unverified.filter((id): id is string => typeof id === "string")
            : [],
        },
      };
    };
    let outcome:
      | {
          settled: true;
          interrupted: boolean;
          hostTurnId: string | null;
          generation: number | null;
          operations: { total: number; settled: number };
          computerTerminated: boolean;
        }
      | {
          settled: false;
          error: string;
          pending: string[];
          escalated: boolean;
          /** The computer generation the host saw the pending operations on, when it said. */
          computerGeneration: number | null;
        };
    try {
      let computerTerminated = false;
      let terminatedGeneration: number | null = null;
      if (escalate) {
        // The settlement budget has passed: the computer is terminated
        // through the host and the platform, and the termination confirmed,
        // before anything else may mount the workspace.
        // Conditioned on the stop's identity: the turn, and the computer
        // generation the host reported the pending operations on. A
        // computer a newer turn acquired since is never the one terminated.
        const response = await this.workerdRuntime().fetch(`${runtimeBase}/terminate-computer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: workerdSession.opencode_session_id,
            reason: `${stop.reason}_unsettled`,
            turnId: stop.turn_id,
            runtimeGeneration: stop.runtime_generation,
            ...(stop.computer_generation !== null ? { generation: Number(stop.computer_generation) } : {}),
          }),
          signal: AbortSignal.timeout(workerdStopTimeoutMs(this.env)),
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok || body.terminated !== true) {
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : `Workerd runtime could not terminate the computer (${String(response.status)})`,
          );
        }
        computerTerminated = true;
        terminatedGeneration = typeof body.generation === "number" ? body.generation : null;
      }
      // With the computer gone, the host's stop settles every operation
      // as lost; the loop itself must still be reported stopped.
      const stopped = await hostStop();
      if (stopped.settled) {
        outcome = {
          settled: true,
          interrupted: stopped.interrupted,
          hostTurnId: stopped.turnId,
          generation: terminatedGeneration ?? stopped.generation,
          operations: { total: stopped.operations.total, settled: stopped.operations.settled },
          computerTerminated,
        };
      } else {
        const unverifiable =
          !stopped.active &&
          stopped.operations.pending.length > 0 &&
          stopped.operations.pending.every((id) => stopped.operations.unverified.includes(id));
        if (unverifiable && Number(stop.terminate_requested) !== 1) {
          // Every pending operation is one the supervisor cannot verify
          // settled: terminated without verified containment (a process
          // group only, or a cgroup wait that expired), a supervisor with
          // no cancel route, a row from before the ownership ledger.
          // Asking again cannot verify it, so the next attempt terminates
          // the computer instead of waiting out the settlement budget.
          this.ctx.storage.sql.exec(
            "UPDATE workerd_pending_stop SET terminate_requested = 1 WHERE slot = 1",
          );
        }
        outcome = {
          settled: false,
          error: stopped.active
            ? "the agent runtime still reports the turn running after the interrupt"
            : unverifiable
              ? `${String(stopped.operations.pending.length)} operation(s) cannot be verified settled (terminated without verified containment, or a supervisor that cannot be asked); the computer will be terminated`
              : `${String(stopped.operations.pending.length)} operation(s) not yet settled on the computer`,
          pending: stopped.operations.pending,
          escalated: escalate,
          computerGeneration: stopped.generation,
        };
      }
    } catch (error) {
      outcome = {
        settled: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        pending: [],
        escalated: escalate,
        computerGeneration: null,
      };
    }
    if (!this.readSession()) return;
    if (!outcome.settled) {
      const delay =
        WORKERD_STOP_BACKOFF_MS[Math.min(attempt, WORKERD_STOP_BACKOFF_MS.length) - 1]!;
      const retryAtMs = Date.now() + delay;
      this.ctx.storage.sql.exec(
        `UPDATE workerd_pending_stop
         SET attempts = ?, next_attempt_at_ms = ?, last_error = ?,
             computer_generation = COALESCE(?, computer_generation)
         WHERE slot = 1`,
        attempt,
        retryAtMs,
        outcome.error,
        outcome.computerGeneration,
      );
      const event = this.appendEvent("runtime.log", stop.turn_id ?? undefined, {
        phase: "workerd_interrupt",
        runtime: "workerd",
        interrupted: false,
        acknowledged: false,
        reason: stop.reason,
        attempt,
        error: outcome.error,
        ...(outcome.pending.length > 0 ? { pendingOperations: outcome.pending } : {}),
        escalated: outcome.escalated,
        retryAt: new Date(retryAtMs).toISOString(),
        message: outcome.escalated
          ? `The computer could not be terminated yet (attempt ${String(attempt)}): ${outcome.error}; the next turn waits`
          : `The turn has not settled yet (attempt ${String(attempt)}): ${outcome.error}; the next turn waits`,
      });
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "workerd_stop_attempt_unsettled",
          sessionId: this.requireSession().id,
          turnId: stop.turn_id,
          reason: stop.reason,
          attempt,
          escalated: outcome.escalated,
          error: outcome.error,
        }),
      );
      this.broadcastEvents([event]);
      await this.scheduleAlarm();
      return;
    }
    this.settleWorkerdStop(stop, { ...outcome, attempt });
  }

  /**
   * The stop is settled: the turn it named is cancelled if it is still the
   * running one (`turn.cancelled` after the last operation, with the
   * settlement), the intent is cleared, the session leaves `stopping`, and
   * the next turn dispatches.
   */
  private settleWorkerdStop(
    stop: WorkerdPendingStopRow,
    settlement: {
      interrupted: boolean;
      hostTurnId: string | null;
      generation: number | null;
      operations: { total: number; settled: number };
      computerTerminated: boolean;
      attempt: number;
    },
  ): void {
    const timestamp = now();
    const requestedAtMs =
      Number(stop.requested_at_ms) > 0
        ? Number(stop.requested_at_ms)
        : Date.parse(stop.requested_at);
    let askedTurnId: string | undefined;
    const events = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM workerd_pending_stop WHERE slot = 1");
      const output = [
        this.appendEvent(
          "runtime.log",
          stop.turn_id ?? undefined,
          {
            phase: "workerd_interrupt",
            runtime: "workerd",
            interrupted: settlement.interrupted,
            acknowledged: true,
            reason: stop.reason,
            attempt: settlement.attempt,
            ...(settlement.hostTurnId ? { hostTurnId: settlement.hostTurnId } : {}),
            operations: settlement.operations,
            computerTerminated: settlement.computerTerminated,
            ...(settlement.generation !== null ? { generation: settlement.generation } : {}),
            settledAfterMs: Math.max(0, Date.now() - requestedAtMs),
            message: settlement.computerTerminated
              ? "The computer was terminated and confirmed; the next turn runs on a new one with the workspace intact"
              : stop.ask_json
                ? `The asking turn's ${String(settlement.operations.settled)} of ${String(settlement.operations.total)} dispatched command(s) settled; it ends with its question`
                : settlement.interrupted || settlement.operations.total > 0
                ? `Agent runtime stopped the running turn; ${String(settlement.operations.settled)} of ${String(settlement.operations.total)} dispatched command(s) terminated and settled`
                : "Agent runtime had no running turn to stop",
          },
          timestamp,
        ),
      ];
      const ask = stop.turn_id ? pendingAskSettlement(stop.ask_json) : undefined;
      if (stop.turn_id && ask) {
        // The turn asked (D4): every operation it dispatched has settled,
        // so it completes with outcome `question` now, and its question,
        // events and elicitation commit with this settlement.
        const settled = this.settleWorkerdTurnInTransaction(
          stop.turn_id,
          { status: "completed", text: ask.text, finalText: ask.finalText, question: ask.question },
          timestamp,
        );
        if (settled) {
          askedTurnId = stop.turn_id;
          output.push(...settled);
        }
      } else if (stop.turn_id) {
        if (this.settleTurn(stop.turn_id, "cancelled", timestamp)) {
          const event = this.appendEvent(
            "turn.cancelled",
            stop.turn_id,
            {
              reason: stop.reason,
              ...(stop.replacement_turn_id ? { replacementTurnId: stop.replacement_turn_id } : {}),
              settledAfterMs: Math.max(0, Date.now() - requestedAtMs),
              operationsSettled: settlement.operations.total,
              computerTerminated: settlement.computerTerminated,
            },
            timestamp,
          );
          this.recordOutcomeDeliveries(stop.turn_id, event);
          output.push(event);
        }
      }
      const session = this.requireSession();
      if (session.status === "stopping") {
        this.ctx.storage.sql.exec(
          "UPDATE session SET status = 'idle', updated_at = ? WHERE id = ?",
          timestamp,
          session.id,
        );
        output.push(
          this.appendEvent(
            "session.status_changed",
            undefined,
            { from: "stopping", to: "idle" },
            timestamp,
          ),
        );
      }
      // Settled: the row no longer shows a stop in progress, whichever of
      // the events above fired.
      this.bumpRevision(timestamp);
      return output;
    });
    this.broadcastEvents(events);
    if (askedTurnId) {
      this.refreshQuestionCardsFor(events);
      this.afterWorkerdTurnSettled(askedTurnId);
    }
    this.ctx.waitUntil(this.scheduleAlarm());
    this.dispatchNextTurn();
  }
  private async executeWorkerdTurn(
    turnId: string,
    input: string,
    agentInput: StructuredAgentInput,
  ): Promise<void> {
    let responseText = "";
    // Text by assistant message and part, so the final answer is the last
    // response that wrote text and not everything the turn said (D5). A
    // turn whose last model call only called a tool (`ask`, `consult`)
    // still answers with the text it wrote before that call.
    const assistantText = new WorkerdAssistantText();
    // Tool calls in the public shape, named from OpenCode's input.started.
    const toolCalls = new WorkerdToolCalls();
    // The model call in flight, from OpenCode's step.started: the model the
    // usage and a failure are attributed to, and the retries it has had.
    let modelCall: WorkerdModelCall | undefined;
    // The route boundary starts before asking Workerd to run. Its handler may
    // reach the model gateway before it returns the response stream that
    // carries session.step.started back to this object.
    let nextModelRouteSinceSeq = this.lastEventSeq();
    // The `ask` call the host reported (design 018), and whether its tool
    // call completed: then the host interrupts the loop and the turn settles
    // as completed with outcome `question`.
    let asked: AskedQuestion | undefined;
    let askCompleted = false;
    const leaseRenewal = setInterval(
      () => this.renewWorkerdTurnLease(turnId),
      WORKERD_TURN_LEASE_RENEW_MS,
    );
    const latency = latencyTelemetry(this.env, "session", {
      session_key: this.requireSession().id,
      turn_id: turnId,
    });
    // `first_output` and `completed` run from the turn's creation: what the
    // client waited, queueing and dispatch included.
    const sinceCreated = () => {
      const created = this.ctx.storage.sql
        .exec<{ created_at: string }>(
          "SELECT created_at FROM turns WHERE id = ?",
          turnId,
        )
        .toArray()[0]?.created_at;
      const ms = created ? Date.now() - Date.parse(created) : NaN;
      return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
    };
    let firstOutput = false;
    try {
      const workerdSession = this.ctx.storage.sql
        .exec<{
          runtime_session_id: string;
          opencode_session_id: string;
          runtime_boot_id: string;
          runtime_activation: number;
        }>(
          `SELECT runtime_session_id, opencode_session_id,
                  runtime_boot_id, runtime_activation
           FROM workerd_session WHERE slot = 1`,
        )
        .one();

      const session = this.requireSession();
      const memory = workerdMemoryPayload(this.ctx.storage.sql, session.id);
      const runtimeRequestStartedAt = performance.now();
      const dispatched = latency.start("session_turn.dispatched");
      const response = await this.workerdRuntime().fetch(
        `https://workerd-runtime.invalid/sessions/${encodeURIComponent(workerdSession.runtime_session_id)}/turn`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: workerdSession.opencode_session_id,
            text: input,
            turnId,
            agentInput,
            identity: this.sessionIdentity(session),
            ...(memory ? { memory } : {}),
          }),
        },
      );
      const runtimeRequestMs =
        Math.round((performance.now() - runtimeRequestStartedAt) * 100) / 100;
      if (response.status === 409) {
        const refusal = (await response.json().catch(() => ({}))) as {
          error?: unknown;
          turnId?: unknown;
        };
        if (refusal.error === "turn_in_progress") {
          // The host still executes an older turn (a driver this object
          // lost, or a loop it replayed after its own eviction). This is
          // not an admission of anything: the turn goes back to queued, the
          // stop is recorded, and the turn dispatches again once the host
          // has acknowledged.
          this.deferWorkerdTurn(
            turnId,
            typeof refusal.turnId === "string" ? refusal.turnId : null,
          );
          return;
        }
      }
      const runtimeBootId = response.headers.get("x-opencomputer-runtime-boot") ?? "";
      const runtimeActivation = Number(
        response.headers.get("x-opencomputer-runtime-activation") ?? 0,
      );
      const runtimeAgeMs = Number(
        response.headers.get("x-opencomputer-runtime-age-ms") ?? 0,
      );
      const reactivated =
        Boolean(workerdSession.runtime_boot_id) &&
        Boolean(runtimeBootId) &&
        workerdSession.runtime_boot_id !== runtimeBootId;
      dispatched.end({
        data: {
          status: response.status,
          activation: Number.isFinite(runtimeActivation) ? runtimeActivation : 0,
          init_ms: Number(
            response.headers.get("x-opencomputer-runtime-init-ms") ?? 0,
          ),
          reused: !reactivated,
        },
      });
      this.ctx.storage.sql.exec(
        `UPDATE workerd_session
         SET runtime_boot_id = ?, runtime_activation = ?
         WHERE slot = 1`,
        runtimeBootId,
        Number.isFinite(runtimeActivation) ? runtimeActivation : 0,
      );
      const runtimeEvent = this.appendEvent("runtime.log", turnId, {
        phase: reactivated ? "workerd_reactivated" : "workerd_reused",
        runtime: "workerd",
        activation: Number.isFinite(runtimeActivation) ? runtimeActivation : 0,
        requestReadyMs: runtimeRequestMs,
        activationAgeMs: Number.isFinite(runtimeAgeMs) ? runtimeAgeMs : 0,
        message: `Agent runtime ${reactivated ? "reactivated" : "reused"} · activation ${Number.isFinite(runtimeActivation) ? runtimeActivation : 0} · turn ready in ${Math.round(runtimeRequestMs)} ms`,
      });
      this.broadcastEvents([runtimeEvent]);
      if (!response.ok || !response.body) {
        throw new Error(`Workerd runtime turn failed (${response.status})`);
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let completed = false;
      while (!completed) {
        const item = await reader.read();
        if (!this.turnIsRunning(turnId)) {
          // Interrupted, expired or ended while the runtime was still
          // streaming. Whoever settled the turn wrote its terminal state;
          // nothing from this stream may overwrite it.
          await reader.cancel().catch(() => undefined);
          this.logWorkerdTurnSettlementIgnored(turnId, "stream");
          return;
        }
        this.renewWorkerdTurnLease(turnId);
        buffer += item.value ?? "";
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(6)) as {
            type: string;
            data?: unknown;
          };
          if (!isRecord(event.data)) continue;
        const data = event.data;
        if (event.type === "opencomputer.agent.rendered") {
          this.commitAgentRender(data as unknown as SessionAgentRender);
          continue;
        }
        if (
          event.type === "session.text.delta" &&
          typeof data.delta === "string"
        ) {
          responseText += data.delta;
          assistantText.delta(data);
          if (!firstOutput) {
            firstOutput = true;
            latency.emit("session_turn.first_output", {
              duration_ms: sinceCreated(),
            });
          }
          const persisted = this.appendEvent("message.delta", turnId, {
            text: data.delta,
          });
          this.publishTurnEvents(turnId, [persisted]);
          continue;
        }
        if (event.type === "session.text.ended" && typeof data.text === "string") {
          assistantText.ended(data);
          continue;
        }
        if (
          event.type === "session.reasoning.delta" &&
          typeof data.delta === "string"
        ) {
          const persisted = this.appendEvent("reasoning.delta", turnId, {
            text: data.delta,
          });
          this.publishTurnEvents(turnId, [persisted]);
          continue;
        }
        if (event.type === "session.tool.input.started") {
          // OpenCode names the tool here; the public start event is the
          // call itself, below, once the input is complete.
          toolCalls.inputStarted(data);
          continue;
        }
        if (event.type === "session.tool.called") {
          const persisted = this.appendEvent("tool.started", turnId, toolCalls.started(data));
          this.publishTurnEvents(turnId, [persisted]);
          continue;
        }
        if (event.type === "session.tool.progress") {
          const persisted = this.appendEvent("tool.progress", turnId, toolCalls.progress(data));
          this.publishTurnEvents(turnId, [persisted]);
          continue;
        }
        if (event.type === "session.tool.success") {
          if (asked && data.id === asked.callId) askCompleted = true;
          if (typeof data.id === "string" && this.resultReceiptExists(turnId, data.id)) {
            // The result tool's completion was written by its commit,
            // before the model saw success; the loop's own frame for the
            // call would be a second event.
            continue;
          }
          const persisted = this.appendEvent("tool.completed", turnId, toolCalls.completed(data));
          this.publishTurnEvents(turnId, [persisted]);
          continue;
        }
        if (event.type === "session.tool.failed") {
          const persisted = this.appendEvent("tool.failed", turnId, toolCalls.failed(data));
          this.publishTurnEvents(turnId, [persisted]);
          continue;
        }
        if (event.type === "opencomputer.question.asked") {
          // The host's record of an `ask` call, emitted before the call's own
          // completion. A malformed frame is dropped: the call then settles
          // as an ordinary tool call and the turn as an ordinary turn.
          const call = typeof data.callId === "string" && data.callId ? data.callId : undefined;
          const question = {
            text: data.text,
            ...(data.options !== undefined ? { options: data.options } : {}),
            ...(data.context !== undefined ? { context: data.context } : {}),
          };
          if (call && isAskInput(question)) {
            asked = {
              id: await questionIdFor(turnId, call),
              callId: call,
              text: question.text,
              options: question.options ?? [],
              ...(question.context?.trim() ? { context: question.context } : {}),
            };
            askCompleted = false;
          }
          continue;
        }
        if (event.type === "opencomputer.agent.consulted") {
          // The host's record of a `consult` call (project sessions): a
          // question directed at a member agent rather than a person. It
          // commits as the same question an `ask` commits — held inputs,
          // steering and `answers:` all apply — with the member agent, not
          // a channel, on the answering side (see driveConsultations).
          const call = typeof data.callId === "string" && data.callId ? data.callId : undefined;
          const consult = { agent: data.agent, prompt: data.prompt };
          if (call && isConsultInput(consult)) {
            asked = {
              id: await questionIdFor(turnId, call),
              callId: call,
              text: consult.prompt,
              options: [],
              consult: { agent: consult.agent, prompt: consult.prompt },
            };
            askCompleted = false;
          }
          continue;
        }
        if (event.type === "opencomputer.memory.saved") {
          // C7: a save the host observed succeed. Best-effort by contract,
          // so a malformed frame is dropped, never a turn failure.
          const saved = memorySavedEvent(data);
          if (saved) {
            const persisted = this.appendEvent("memory.saved", turnId, saved);
            this.publishTurnEvents(turnId, [persisted]);
          }
          continue;
        }
        if (event.type === "session.step.started") {
          assistantText.started(data);
          const model = isRecord(data.model) ? data.model : null;
          if (model && typeof model.id === "string" && model.id) {
            modelCall = {
              model: { provider: "openrouter", model: model.id },
              sinceSeq: nextModelRouteSinceSeq,
              retries: modelCall?.retries ?? 0,
              hostGranted: modelCall?.hostGranted ?? false,
            };
          }
          continue;
        }
        if (event.type === "session.retry.scheduled") {
          // OpenCode retries the model call inside the turn, on its own
          // schedule or on the host's one grant (the Workerd runtime's
          // model-retry.ts); the log shows the wait as a milestone, with the
          // failure's typed class and never the provider's own text.
          assistantText.retrying(data);
          if (modelCall) {
            modelCall.retries += 1;
            if (data.hostGranted === true) modelCall.hostGranted = true;
          }
          const retryError = isRecord(data.error) ? data.error : {};
          const errorType = typeof retryError.type === "string" ? retryError.type : "unknown";
          const attempt = typeof data.attempt === "number" && Number.isFinite(data.attempt) ? data.attempt : 0;
          const delayMs =
            typeof data.at === "number" && Number.isFinite(data.at) ? Math.max(0, Math.round(data.at - Date.now())) : 0;
          const persisted = this.appendEvent("runtime.log", turnId, {
            phase: "model_retry",
            runtime: "workerd",
            attempt,
            delayMs,
            errorType,
            hostGranted: data.hostGranted === true,
            message: `Model call failed (${errorType}) · retrying, attempt ${String(attempt)} in ${String(delayMs)} ms`,
          });
          this.publishTurnEvents(turnId, [persisted]);
          continue;
        }
        if (event.type === "session.step.ended") {
          // One model call finished: its tokens and cost, attributed to the
          // route the gateway recorded for this call, or the model OpenCode
          // named when the call recorded no route. A call that failed
          // records no usage; its retries are over with the step.
          const usage = workerdUsageRecorded(
            data,
            this.resolvedModelSince(modelCall?.sinceSeq) ?? modelCall?.model,
          );
          assistantText.stepEnded();
          if (modelCall) {
            modelCall.retries = 0;
            modelCall.hostGranted = false;
          }
          if (usage) {
            const persisted = this.appendEvent("usage.recorded", turnId, usage);
            this.publishTurnEvents(turnId, [persisted]);
          }
          nextModelRouteSinceSeq = this.lastEventSeq();
          continue;
        }
        if (event.type === "session.execution.succeeded") {
          // The final text, here and in the asked settlement below, is the
          // last response that wrote text (`WorkerdAssistantText.final()`):
          // a trailing model call that only called `ask` or a tool does
          // not blank it. Empty only when the turn wrote no text at all;
          // `responseText` stands in only when no model call started.
          if (asked && askCompleted) {
            // The loop finished on its own after asking (the host's
            // interrupt did not land first): the same settlement as below.
            this.settleAskedTurnAfterOperations(turnId, {
              question: asked,
              text: responseText,
              finalText: assistantText.final() ?? responseText,
            });
          } else {
            this.settleWorkerdTurn(turnId, {
              status: "completed",
              text: responseText,
              finalText: assistantText.final() ?? responseText,
            });
          }
          completed = true;
          break;
        }
        if (
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted"
        ) {
          const structuredError = isRecord(data.error) ? data.error : null;
          const detail =
            typeof data.message === "string"
              ? data.message
              : structuredError && typeof structuredError.message === "string"
                ? structuredError.message
                : event.type === "session.execution.interrupted"
                  ? "OpenCode execution was interrupted"
                  : "OpenCode execution failed";
          if (event.type === "session.execution.interrupted") {
            if (this.pendingWorkerdStop()?.turn_id === turnId) {
              // The runtime stopped on this session's request; the stop
              // drive settles the turn once its operations have.
              completed = true;
              break;
            }
            if (asked && askCompleted) {
              // The host ended the loop after the turn's `ask` completed:
              // the turn is over, and it ended by asking. It settles once
              // every operation it dispatched has (D4). Its final text is
              // the text written before the `ask` (the question card's
              // snapshot), even when `ask` was its own model call.
              this.settleAskedTurnAfterOperations(turnId, {
                question: asked,
                text: responseText,
                finalText: assistantText.final() ?? responseText,
              });
              completed = true;
              break;
            }
            // An interrupt nobody here asked for is a visible failure with
            // its own reason.
            this.settleWorkerdTurn(turnId, {
              status: "failed",
              detail,
              reason: "runtime_interrupted",
            });
            completed = true;
            break;
          }
          // The failure's typed fields travel with it; the public
          // classification reads them and never the provider's text.
          throw new WorkerdExecutionFailure(
            detail,
            structuredError
              ? workerdExecutionFailure(
                  structuredError,
                  modelCall,
                  this.resolvedModelSince(modelCall?.sinceSeq),
                )
              : undefined,
          );
        }
        if (event.type === "stream.error") {
          throw new Error(
            typeof data.message === "string"
              ? data.message
              : "The Workerd runtime stream failed",
          );
        }
        }
        if (item.done && !completed) {
          throw new Error("The Workerd runtime stream ended before the turn did");
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (this.pendingWorkerdStop()?.turn_id === turnId) {
        // The stream ended while this session is stopping the turn: the
        // stop drive owns its settlement, whatever the stream said last.
        this.logWorkerdTurnSettlementIgnored(turnId, "stream_while_stopping");
        return;
      }
      console.error(
        JSON.stringify({
          level: "error",
          event: "workerd_turn_failed",
          sessionId: this.requireSession().id,
          turnId,
          message: detail.slice(0, 1_000),
        }),
      );
      this.settleWorkerdTurn(turnId, {
        status: "failed",
        detail,
        ...(error instanceof WorkerdExecutionFailure && error.failure
          ? { failure: error.failure }
          : {}),
      });
    } finally {
      clearInterval(leaseRenewal);
      const status = this.ctx.storage.sql
        .exec<{ status: string }>("SELECT status FROM turns WHERE id = ?", turnId)
        .toArray()[0]?.status;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        latency.emit("session_turn.completed", {
          duration_ms: sinceCreated(),
          data: { status },
        });
      }
      latency.send(this.ctx);
    }
  }

  /**
   * The host refused the prompt because an older execution is still live
   * there: revert the turn to queued (it never ran) and record the stop, in
   * one transaction. A turn already settled by someone else is left alone.
   */
  private deferWorkerdTurn(turnId: string, hostTurnId: string | null): void {
    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() => {
      const reverted = this.ctx.storage.sql.exec(
        `UPDATE turns
         SET status = 'queued', lease_deadline_at_ms = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
        timestamp,
        turnId,
      ).rowsWritten;
      if (reverted === 0) return null;
      const session = this.requireSession();
      const output = [
        this.appendEvent(
          "runtime.log",
          turnId,
          {
            phase: "workerd_turn_deferred",
            runtime: "workerd",
            ...(hostTurnId ? { hostTurnId } : {}),
            message:
              "Agent runtime is still executing an earlier turn; this turn waits until that execution is stopped",
          },
          timestamp,
        ),
        this.recordWorkerdStop(hostTurnId, "turn_in_progress", timestamp),
        ...this.markStopping(session, timestamp),
      ];
      return output;
    });
    if (!events) {
      this.logWorkerdTurnSettlementIgnored(turnId, "turn_in_progress");
      return;
    }
    this.broadcastEvents(events);
    this.ctx.waitUntil(this.driveWorkerdStop());
  }

  private turnIsRunning(turnId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ status: string }>("SELECT status FROM turns WHERE id = ?", turnId)
        .toArray()[0]?.status === "running"
    );
  }

  /**
   * Push the lease forward, at most once per renewal interval. Only a running
   * turn has a lease to renew; the write is skipped while the stored deadline
   * is still fresh so a busy stream does not turn every delta into a write.
   */
  private renewWorkerdTurnLease(turnId: string): void {
    const deadline = Date.now() + WORKERD_TURN_LEASE_MS;
    // A turn being stopped has no lease to renew: the stop drive owns it.
    this.ctx.storage.sql.exec(
      `UPDATE turns
       SET lease_deadline_at_ms = ?
       WHERE id = ? AND status = 'running'
         AND (lease_deadline_at_ms IS NULL OR lease_deadline_at_ms <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM workerd_pending_stop WHERE turn_id = turns.id
         )`,
      deadline,
      turnId,
      deadline - WORKERD_TURN_LEASE_RENEW_MS,
    );
  }

  /**
   * Fail every running Workerd turn whose lease nobody renewed. The driver
   * that owned it lived in a previous activation of this object; its stream
   * is gone and the turn would otherwise block the session for good.
   */
  private expireWorkerdTurnLeases(nowMs: number): void {
    const expired = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id">>(
        `SELECT id FROM turns
         WHERE status = 'running'
           AND lease_deadline_at_ms IS NOT NULL
           AND lease_deadline_at_ms <= ?
         ORDER BY created_at, rowid`,
        nowMs,
      )
      .toArray();
    for (const turn of expired) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "workerd_turn_lease_expired",
          sessionId: this.requireSession().id,
          turnId: turn.id,
        }),
      );
      this.settleWorkerdTurn(
        turn.id,
        {
          status: "failed",
          detail:
            "The agent runtime stopped reporting on this turn and its lease expired",
          reason: "runtime_lost",
        },
        // The driver is gone; the host may still be executing the turn.
        // Nothing dispatches until it has been told to stop.
        { stop: "runtime_lost" },
      );
    }
  }

  /**
   * The Workerd runtime's terminal word on a turn applies only while the turn
   * is still the running one. An interrupt, an end or a lease expiry settles
   * the turn first and wins; a completion that arrives afterwards is logged
   * and dropped, so a cancelled turn never turns into a completed one and an
   * ended session never wakes back to idle.
   */
  private settleWorkerdTurn(
    turnId: string,
    outcome: WorkerdTurnOutcome,
    options: { stop?: string } = {},
  ): void {
    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() =>
      this.settleWorkerdTurnInTransaction(turnId, outcome, timestamp, options),
    );
    if (!events) {
      this.logWorkerdTurnSettlementIgnored(turnId, outcome.status);
      return;
    }
    this.broadcastEvents(events);
    // A question this settlement superseded loses its buttons.
    this.refreshQuestionCardsFor(events);
    this.afterWorkerdTurnSettled(turnId);
    this.dispatchNextTurn();
  }

  /**
   * The settlement's writes, inside the caller's transaction: the turn's
   * status, its terminal events and outcome deliveries, the question of a
   * turn that asked (with its held turns and elicitation), and the session's
   * status. Null when the turn was no longer running.
   */
  private settleWorkerdTurnInTransaction(
    turnId: string,
    outcome: WorkerdTurnOutcome,
    timestamp: string,
    options: { stop?: string } = {},
  ): AgentEvent[] | null {
    if (!this.settleTurn(turnId, outcome.status, timestamp)) return null;
    const stopRequested = options.stop
      ? [this.recordWorkerdStop(turnId, options.stop, timestamp)]
      : [];
    const asked = outcome.status === "completed" ? outcome.question : undefined;
    const output =
      outcome.status === "completed"
        ? [
            this.appendEvent(
              "message.completed",
              turnId,
              {
                text: outcome.text,
                finalText: outcome.finalText,
                source: "opencode-workerd",
              },
              timestamp,
            ),
            // A question that does not hold is retired by the reply that
            // moved past it, before this turn's own question opens.
            ...this.supersedeQuestionInTransaction(
              turnId,
              { asked: Boolean(asked), finalText: outcome.finalText },
              timestamp,
            ),
            // The question, its events and the turn's outcome commit with
            // the settlement (design 018): one transaction.
            ...(asked ? this.commitAskedQuestion(turnId, asked, timestamp) : []),
            this.appendEvent(
              "turn.completed",
              turnId,
              asked ? { outcome: "question", questionId: asked.id } : {},
              timestamp,
            ),
          ]
        : [
            this.appendEvent(
              "turn.failed",
              turnId,
              {
                message: outcome.detail,
                ...(outcome.reason ? { reason: outcome.reason } : {}),
                ...(outcome.failure ? { failure: outcome.failure } : {}),
              },
              timestamp,
            ),
          ];
    this.recordOutcomeDeliveries(turnId, output[output.length - 1]!);
    if (asked) output.push(...this.afterQuestionCommittedInTransaction(turnId, asked, timestamp));
    output.push(...stopRequested);
    const session = this.requireSession();
    // With a stop recorded (runtime loss), the session is stopping until
    // the host has settled or the computer is terminated; otherwise idle.
    const next = options.stop ? "stopping" : "idle";
    if (session.status === "running" || (session.status === "stopping" && next === "idle")) {
      this.ctx.storage.sql.exec(
        "UPDATE session SET status = ?, updated_at = ? WHERE id = ?",
        next,
        timestamp,
        session.id,
      );
      output.push(
        this.appendEvent(
          "session.status_changed",
          undefined,
          { from: session.status, to: next },
          timestamp,
        ),
      );
    }
    return output;
  }

  /**
   * What follows every settled Workerd turn: the conversation is answered
   * (as on the runtime-stream path; left to the alarm, the reply went out
   * when the turn lease armed at dispatch expired, a minute after an answer
   * that took seconds), the Linear queue drains, and the alarm is armed.
   */
  private afterWorkerdTurnSettled(turnId: string): void {
    this.ctx.waitUntil(this.deliverSlackTurn(turnId));
    this.ctx.waitUntil(this.linearActivities.afterSettlement());
    this.ctx.waitUntil(this.armChannelIdleSuspend());
    this.ctx.waitUntil(this.driveConsultations());
    this.ctx.waitUntil(this.scheduleAlarm());
  }

  /**
   * A turn that asked settles only after every operation it dispatched has
   * terminated (D4): the same durable stop `driveWorkerdStop` settles, with
   * the turn's settlement as `completed` with outcome `question` held on it.
   * The turn stays running meanwhile (no `stopping`: nobody stopped it); the
   * question, its events and the elicitation commit with the settlement,
   * once the host reports nothing left running. A stop of the same turn
   * before then replaces the held settlement and cancels the turn instead.
   */
  private settleAskedTurnAfterOperations(turnId: string, ask: PendingAskSettlement): void {
    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() => {
      if (!this.turnIsRunning(turnId)) return null;
      return [this.recordWorkerdStop(turnId, "asked", timestamp, { ask })];
    });
    if (!events) {
      this.logWorkerdTurnSettlementIgnored(turnId, "asked");
      return;
    }
    this.broadcastEvents(events);
    this.ctx.waitUntil(this.driveWorkerdStop());
  }

  /**
   * What an open question does to the session's other inputs: a consult
   * holds on every channel (its answer must land as one turn); an `ask`
   * question follows the channel its asking turn replies on, which posted
   * it (Slack: `flow`); a question with no channel reply, and every
   * provider that does not say otherwise, holds (Linear, the API).
   */
  private questionModeOf(question: QuestionRow): QuestionMode {
    if (consultationById(this.ctx.storage.sql, question.id)) return "hold";
    const delivery = this.ctx.storage.sql
      .exec<{ provider: string | null }>(
        "SELECT provider FROM slack_deliveries WHERE turn_id = ?",
        question.turn_id,
      )
      .toArray()[0];
    if (!delivery) return "hold";
    return channelAdapter(delivery.provider ?? "slack")?.questionMode ?? "hold";
  }

  /**
   * A queued turn as it is dispatched: the text the model reads and the
   * typed input the render reads. A channel input that runs while a
   * question that does not hold is open carries that question twice: as
   * `openQuestion` on the typed input, and as one line in the text's
   * transcript header (`openQuestionLine`), so an agent with no render of
   * its own still knows a gate is pending. Read at dispatch, not
   * admission, so a message queued before the question was asked carries
   * it too, and one queued behind a click does not. The stored turn is
   * unchanged.
   */
  private dispatchedTurn(
    inputJson: string,
    input: string,
  ): { text: string; agentInput: StructuredAgentInput } {
    const agentInput = structuredAgentInput(inputJson, input);
    if (agentInput.source !== "channel" || agentInput.answer) return { text: input, agentInput };
    const open = openQuestion(this.ctx.storage.sql);
    if (!open || this.questionModeOf(open) !== "flow") return { text: input, agentInput };
    const pending = openQuestionInput(open);
    return {
      text: withOpenQuestionLine(input, pending),
      agentInput: { ...agentInput, openQuestion: pending },
    };
  }

  /**
   * Inside the settlement of a completed turn: a question that does not
   * hold (`flow`) and is still open closes `superseded` when this turn
   * asked a question of its own (which must be the only open one), or when
   * it is a channel-sourced turn that replied with text after it. A silent
   * reply posts nothing in the thread, so the question stays open with its
   * buttons; an event turn or a consult answer that does not ask leaves it
   * open too: the person has not moved on. A held question is never
   * superseded.
   */
  private supersedeQuestionInTransaction(
    turnId: string,
    outcome: { asked: boolean; finalText: string },
    timestamp: string,
  ): AgentEvent[] {
    const sql = this.ctx.storage.sql;
    const open = openQuestion(sql);
    if (!open || open.turn_id === turnId || this.questionModeOf(open) !== "flow") return [];
    if (!outcome.asked) {
      if (!outcome.finalText.trim()) return [];
      const turn = sql
        .exec<Pick<TurnRow, "input" | "input_json">>(
          "SELECT input, input_json FROM turns WHERE id = ?",
          turnId,
        )
        .toArray()[0];
      if (!turn || structuredAgentInput(turn.input_json, turn.input).source !== "channel") {
        return [];
      }
    }
    return closeOpenQuestion(
      sql,
      "superseded",
      timestamp,
      (type, data) => this.appendEvent(type, turnId, data, timestamp),
      open.id,
    ).events;
  }

  /**
   * Inside the settlement of a turn that asked, after its question and
   * terminal event: the turns queued behind it are held, and Linear gets
   * the elicitation. Returns the held turns' events.
   */
  private afterQuestionCommittedInTransaction(
    turnId: string,
    asked: AskedQuestion,
    timestamp: string,
  ): AgentEvent[] {
    // Turns queued behind the asking turn were written before the
    // question existed: they cannot answer it and wait as steering. A
    // question that does not hold (`flow`) leaves them queued: they run
    // as ordinary turns, beside it.
    const question = questionById(this.ctx.storage.sql, asked.id);
    const held =
      question && this.questionModeOf(question) === "flow"
        ? []
        : this.holdQueuedTurns(asked.id, timestamp);
    if (held.length > 0) {
      // The asking turn stays the last settled one (the list row's
      // `lastSettledTurn`): held turns did not end the work, the question did.
      this.ctx.storage.sql.exec(
        `UPDATE turns SET settled_seq = (${NEXT_SETTLED_SEQ_SQL}) WHERE id = ?`,
        turnId,
      );
    }
    enqueueLinearActivity(this.ctx.storage, {
      kind: "terminal",
      content: { type: "elicitation", body: asked.text },
      turnId,
      questionId: asked.id,
      ...(asked.options.length
        ? { signal: "select" as const, signalMetadata: { options: asked.options } }
        : {}),
    });
    return held;
  }

  /**
   * Inside the settlement of a turn that asked: the question row,
   * `question.asked`, and the turn's outcome.
   */
  private commitAskedQuestion(
    turnId: string,
    asked: AskedQuestion,
    timestamp: string,
  ): AgentEvent[] {
    const committed = commitQuestion(
      this.ctx.storage.sql,
      {
        id: asked.id,
        turnId,
        toolCallId: asked.callId,
        text: asked.text,
        options: asked.options,
        ...(asked.context ? { context: asked.context } : {}),
        askedAt: timestamp,
      },
      (type, data) => this.appendEvent(type, turnId, data, timestamp),
    );
    this.ctx.storage.sql.exec("UPDATE turns SET outcome = 'question' WHERE id = ?", turnId);
    if (asked.consult) {
      // A consult's question is answered by a member agent: the
      // consultation row the drive dispatches commits with the question.
      commitConsultation(
        this.ctx.storage.sql,
        { questionId: asked.id, memberRef: asked.consult.agent, prompt: asked.consult.prompt },
        timestamp,
      );
      committed.events.push(
        this.appendEvent(
          "agent.consult.requested",
          turnId,
          { questionId: asked.id, agent: asked.consult.agent },
          timestamp,
        ),
      );
    }
    return committed.events;
  }

  /**
   * Inside the settlement of a turn that asked: every queued turn becomes a
   * held input behind the new question, in its order, and its turn settles
   * `cancelled` with reason `held`; its key then answers with the held
   * receipt. No outcome is delivered for it: its content is not cancelled,
   * it travels with the answer.
   */
  private holdQueuedTurns(questionId: string, timestamp: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const queued of this.ctx.storage.sql
      .exec<
        Pick<TurnRow, "id" | "input" | "input_json" | "idempotency_key" | "fingerprint" | "created_at" | "subscriptions_json">
      >(
        `SELECT id, input, input_json, idempotency_key, fingerprint, created_at, subscriptions_json
         FROM turns WHERE status = 'queued' ORDER BY created_at, rowid`,
      )
      .toArray()) {
      if (!this.settleTurn(queued.id, "cancelled", timestamp, "outstanding")) continue;
      // Admitted once as a turn, so within the turn input bound already.
      const agentInput = structuredAgentInput(queued.input_json, queued.input);
      const held = holdInput(this.ctx.storage.sql, {
        key: queued.idempotency_key,
        questionId,
        input: heldInputOf(agentInput, queued.input, queued.created_at),
        fingerprint: queued.fingerprint,
        inputText: queued.input,
        agentInput,
        subscriptionsJson: queued.subscriptions_json ?? "[]",
        sourceTurnId: queued.id,
      });
      // A channel reply owed to the turn is settled without a word: its
      // text travels with the answer, and a failure notice would tell the
      // person their message was lost.
      this.ctx.storage.sql.exec(
        `UPDATE slack_deliveries
         SET status = 'delivered', next_attempt_at_ms = NULL, lease_until_ms = NULL, updated_at = ?
         WHERE turn_id = ? AND status = 'pending'`,
        timestamp,
        queued.id,
      );
      events.push(
        this.appendEvent("turn.cancelled", queued.id, { reason: "held", questionId }, timestamp),
      );
      if (held) {
        events.push(this.appendEvent("message.held", undefined, heldEventData(held), timestamp));
      }
    }
    return events;
  }

  // ── Consultations (project sessions: a question a member agent answers) ──

  /**
   * The drive a consultation is owed, called after every settled turn and
   * from the alarm: pending ones dispatch their prompt to the member
   * agent's inner session; dispatched ones poll that turn and deliver its
   * outcome as the question's answer. Every step is re-entrant — the row
   * records where the drive got to, and a repeated dispatch finds the
   * member turn under the consultation's key.
   */
  private async driveConsultations(): Promise<void> {
    if (!this.readSession()) return;
    for (const row of dueConsultations(this.ctx.storage.sql, Date.now())) {
      try {
        if (row.status === "pending") {
          await this.dispatchConsultation(row);
        } else if (row.status === "dispatched") {
          await this.pollConsultation(row);
        }
      } catch (error) {
        // A failed attempt defers the row to the next alarm rather than
        // losing it; a condition that never clears ends the consultation
        // at CONSULT_DEADLINE_MS.
        const detail = error instanceof Error ? error.message : String(error);
        console.log(
          JSON.stringify({
            event: "consult.drive_error",
            sessionId: this.readSession()?.id,
            questionId: row.question_id,
            error: detail,
          }),
        );
        if (Date.parse(row.created_at) + CONSULT_DEADLINE_MS <= Date.now()) {
          await this.failConsultation(row, detail);
        } else {
          deferConsultationPoll(
            this.ctx.storage.sql,
            row.question_id,
            Date.now() + CONSULT_POLL_MS,
            now(),
          );
        }
      }
    }
  }

  /**
   * Dispatch a pending consultation: resolve the member inside the
   * session's project and environment, open (or resume) the deterministic
   * inner session, and admit the prompt as a turn keyed under the
   * consultation, so a repeated dispatch is the member's own replay.
   */
  private async dispatchConsultation(row: ConsultationRow): Promise<void> {
    const session = this.requireSession();
    const timestamp = now();
    const question = questionById(this.ctx.storage.sql, row.question_id);
    if (!question || question.answered_at !== null || question.closed_reason !== null) {
      // The question resolved before dispatch (a person answered it, or a
      // stop closed it): there is nothing left for the member to answer.
      markConsultationDone(this.ctx.storage.sql, row.question_id, "delivered", null, timestamp);
      return;
    }
    if (Date.parse(row.created_at) + CONSULT_DEADLINE_MS <= Date.now()) {
      await this.failConsultation(row, `agent ${row.member_ref} could not be reached`);
      return;
    }
    const environment = session.environment;
    const projectId = session.project_id;
    if (
      !projectId ||
      projectId.startsWith("project:") ||
      !isProjectEnvironmentName(environment)
    ) {
      await this.failConsultation(
        row,
        "the session is not bound to a project and an environment",
      );
      return;
    }
    const account = this.env.ACCOUNTS.getByName(session.account_id);
    const target = await account.consultDeployment(
      session.agent_id,
      row.member_ref,
      environment,
    );
    if (!target) {
      await this.failConsultation(
        row,
        `no agent '${row.member_ref}' in this project is deployed to ${environment}`,
      );
      return;
    }
    const memberSessionId = consultSessionId(session.id, target.agentId);
    const member = this.env.SESSIONS.getByName(
      memberSessionId,
      regionPlacement(target.deployment.region),
    );
    // Mirror the session-create path: claim a prewarmed Workerd lease for the
    // member's deployment so its runtime binds a model gateway, and reuse the
    // host session's recorded edge origin for the sandbox context — both run
    // behind the same edge.
    let workerdLease: WorkerdSessionLease | null = null;
    const pools = (this.env as Env & { POOLS?: DurableObjectNamespace }).POOLS;
    const useWorkerd = sessionRunsOnWorkerd(this.env, session.account_id);
    if (useWorkerd && pools) {
      try {
        workerdLease = await deploymentPool(
          this.env as Parameters<typeof deploymentPool>[0],
          session.account_id,
          target.deployment,
        ).claimWorkerd(memberSessionId, workerdModelConfiguration(target.deployment));
      } catch {
        workerdLease = null;
      }
    }
    // The member reads the project's memory like every other session on it:
    // one collection-read binding per document resource its deployment
    // declares, admitted against the same Memory DO (account + project +
    // environment).
    const memberMemory = (this.env as MemorySessionEnv).MEMORY
      ? (target.deployment.memory ?? [])
          .filter((declaration: MemoryDeclaration) => declaration.provider.kind === "document")
          .map((declaration: MemoryDeclaration) => ({
            resource: declaration.id,
            scope: "collection" as const,
            access: "read" as const,
          }))
      : [];
    let initialized: InitializeSessionOutcome;
    try {
      initialized = await member.initialize({
        id: memberSessionId,
        accountId: session.account_id,
        userId: session.user_id,
        agentId: target.agentId,
        deploymentId: target.deployment.id,
        deployment: target.deployment,
        executionMode: useWorkerd ? "workerd" : "microvm",
        ...(session.runtime_edge ? { runtimeEdge: session.runtime_edge } : {}),
        ...(workerdLease ? { workerdLease } : {}),
        // The member's computers mount the host session's /workspace: a
        // consult about shared files (a tool's code, an artifact the host
        // produced) sees the same filesystem.
        sharedWorkspaceSessionId: session.id,
        environment,
        ...(memberMemory.length
          ? {
              memory: memberMemory,
              memoryObject: memoryObjectName(session.account_id, projectId, environment),
            }
          : {}),
        projectId,
        source: "api",
        labels: { kind: "consult", host: session.id },
      });
    } catch (error) {
      if (workerdLease) {
        try {
          await deploymentPool(
            this.env as Parameters<typeof deploymentPool>[0],
            session.account_id,
            target.deployment,
          ).releaseWorkerd(workerdLease, workerdModelConfiguration(target.deployment));
        } catch {}
      }
      throw error;
    }
    if (
      workerdLease &&
      (initialized.outcome === "existing" ||
        (initialized.outcome === "created" && initialized.unusedWorkerdLease))
    ) {
      // The inner session already existed or deliberately did not bind this
      // claim — hand the slot back to the pool.
      try {
        await deploymentPool(
          this.env as Parameters<typeof deploymentPool>[0],
          session.account_id,
          target.deployment,
        ).releaseWorkerd(workerdLease, workerdModelConfiguration(target.deployment));
      } catch {}
    }
    const receipt = await member.enqueueTurn({
      input: row.prompt,
      idempotencyKey: consultTurnKey(row.question_id),
      mode: "queue",
      agentInput: {
        source: "subagent",
        text: row.prompt,
        payload: {
          kind: "consult",
          hostSessionId: session.id,
          questionId: row.question_id,
        },
      },
    });
    // A held receipt means the member had a question of its own open: the
    // consult waits behind it as a held input, and the poll finds the turn
    // when the member's question resolves and its input delivers.
    const memberTurnId = "turnId" in receipt ? receipt.turnId : null;
    markConsultationDispatched(
      this.ctx.storage.sql,
      row.question_id,
      { agentId: target.agentId, sessionId: memberSessionId, turnId: memberTurnId },
      Date.now() + CONSULT_POLL_MS,
      timestamp,
    );
    // The asking turn's progress stopped when it settled with outcome
    // question, but its status line is the thread's — keep it accurate for
    // the gap until the answering turn's own progress takes it over.
    await this.announceConsult(question.turn_id, row.member_ref);
  }

  /**
   * Point the thread's status line at the member while its answer is in
   * flight. Cosmetic by design: every failure is logged and swallowed — a
   * status write must never hold up or fail a dispatch.
   */
  private async announceConsult(turnId: string, memberName: string): Promise<void> {
    try {
      const delivery = this.ctx.storage.sql
        .exec<SlackDeliveryRow>(
          `SELECT turn_id, connected_account_id AS connection_id, channel_id,
                  external_user_id, thread_timestamp, status, attempts, provider,
                  delivery_ref, progress_message_timestamp
           FROM slack_deliveries
           WHERE turn_id = ?`,
          turnId,
        )
        .toArray()[0];
      if (!delivery) return;
      if (!channelAdapter(delivery.provider ?? "slack")?.editableProgress) {
        return;
      }
      const session = this.requireSession();
      const account = this.env.ACCOUNTS.getByName(session.account_id);
      const target = deliveryTarget(delivery);
      if (
        typeof target.channelId !== "string" ||
        typeof target.threadTimestamp !== "string"
      ) {
        return;
      }
      await account.setSlackStatus(delivery.connection_id, {
        channelId: target.channelId,
        threadTimestamp: target.threadTimestamp,
        status: { status: truncateSlackStatus(`Consulting ${memberName}...`) },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "consult.announce_failed",
          turnId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Poll a dispatched consultation: the member turn's terminal outcome
   * becomes the question's answer; a still-running one defers to the next
   * alarm. A member turn the deadline outlives fails the consultation.
   */
  private async pollConsultation(row: ConsultationRow): Promise<void> {
    if (!row.member_session_id) {
      // Dispatched rows always carry it, but a row written before the
      // dispatch committed may not: back to pending for a redispatch.
      this.ctx.storage.sql.exec(
        `UPDATE agent_consultations
         SET status = 'pending', member_session_id = NULL, updated_at = ?
         WHERE question_id = ?`,
        now(),
        row.question_id,
      );
      return;
    }
    const member = this.env.SESSIONS.getByName(row.member_session_id);
    const outcome = await member.consultTurnOutcome(consultTurnKey(row.question_id));
    if (outcome === null || outcome.kind === "pending") {
      if (Date.parse(row.created_at) + CONSULT_DEADLINE_MS <= Date.now()) {
        await this.failConsultation(row, "the member agent did not settle the turn in time");
        return;
      }
      deferConsultationPoll(this.ctx.storage.sql, row.question_id, Date.now() + CONSULT_POLL_MS, now());
      return;
    }
    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() => {
      markConsultationDone(this.ctx.storage.sql, row.question_id, "delivered", null, timestamp);
      return [
        this.appendEvent(
          "agent.consult.answered",
          undefined,
          {
            questionId: row.question_id,
            memberAgentId: row.member_agent_id,
            memberSessionId: row.member_session_id,
            memberTurnId: row.member_turn_id,
            outcome: outcome.kind,
          },
          timestamp,
        ),
      ];
    });
    this.broadcastEvents(events);
    await this.deliverConsultAnswer(row, outcome);
  }

  /** The member settled in a way that produces no answer: record the failure and answer the question with it. */
  private async failConsultation(row: ConsultationRow, error: string): Promise<void> {
    const timestamp = now();
    const events = this.ctx.storage.transactionSync(() => {
      markConsultationDone(this.ctx.storage.sql, row.question_id, "failed", error, timestamp);
      return [
        this.appendEvent(
          "agent.consult.failed",
          undefined,
          { questionId: row.question_id, agent: row.member_ref, error },
          timestamp,
        ),
      ];
    });
    this.broadcastEvents(events);
    await this.deliverConsultAnswer(row, { kind: "unavailable", detail: error });
  }

  /**
   * Admit the member's outcome as the question's answer: `answers:` names it
   * when it is still the open one; once it resolved (a person answered it, a
   * stop closed it) the answer lands as an ordinary turn rather than
   * silently dropping. A replayed delivery is the answer key's own replay.
   */
  private async deliverConsultAnswer(
    row: ConsultationRow,
    outcome: Exclude<ConsultTurnOutcome, { kind: "pending" }>,
  ): Promise<void> {
    const memberAgentId = row.member_agent_id ?? row.member_ref;
    const text = consultAnswerText(memberAgentId, outcome);
    const open = openQuestion(this.ctx.storage.sql);
    try {
      await this.enqueueTurn({
        input: text,
        ...(open && open.id === row.question_id ? { answers: row.question_id } : {}),
        idempotencyKey: consultAnswerKey(row.question_id),
        mode: "queue",
        agentInput: {
          source: "subagent",
          text,
          payload: {
            kind: "consult_answer",
            memberAgentId,
            memberSessionId: row.member_session_id,
            memberTurnId: row.member_turn_id,
            outcome: outcome.kind,
          },
        },
      });
    } catch (error) {
      // The answer could not be admitted (a session that ended, a key
      // conflicted by an earlier shape): leave the row terminal and the
      // failure visible rather than polling forever.
      const detail = error instanceof Error ? error.message : String(error);
      console.log(
        JSON.stringify({
          event: "consult.answer_failed",
          sessionId: this.readSession()?.id,
          questionId: row.question_id,
          error: detail,
        }),
      );
      markConsultationDone(this.ctx.storage.sql, row.question_id, "failed", detail, now());
    }
  }

  /**
   * RPC for a session that consulted an agent here: the outcome of the turn
   * admitted under `idempotencyKey` — its final answer on completion, its
   * failure or cancellation detail, or the question it ended by asking.
   * `pending` while the turn is queued or running; null when no such turn
   * exists.
   */
  consultTurnOutcome(idempotencyKey: string): ConsultTurnOutcome | null {
    if (!this.readSession()) return null;
    const turn = this.ctx.storage.sql
      .exec<Pick<TurnRow, "id" | "status" | "outcome">>(
        "SELECT id, status, outcome FROM turns WHERE idempotency_key = ?",
        idempotencyKey,
      )
      .toArray()[0];
    if (!turn) return null;
    if (turn.status === "queued" || turn.status === "running") {
      return { kind: "pending" };
    }
    if (turn.status === "cancelled") {
      const event = this.ctx.storage.sql
        .exec<{ data: string }>(
          `SELECT data FROM events WHERE turn_id = ? AND type = 'turn.cancelled'
           ORDER BY seq DESC LIMIT 1`,
          turn.id,
        )
        .toArray()[0];
      const parsed = event ? (parseJsonRecord(event.data) ?? null) : null;
      return {
        kind: "cancelled",
        reason: parsed && typeof parsed.reason === "string" ? parsed.reason : null,
      };
    }
    if (turn.status === "failed") {
      const event = this.ctx.storage.sql
        .exec<{ data: string }>(
          `SELECT data FROM events WHERE turn_id = ? AND type = 'turn.failed'
           ORDER BY seq DESC LIMIT 1`,
          turn.id,
        )
        .toArray()[0];
      const parsed = event ? (parseJsonRecord(event.data) ?? null) : null;
      return {
        kind: "failed",
        error: parsed && typeof parsed.message === "string" ? parsed.message : "the turn failed",
      };
    }
    if (turn.outcome === "question") {
      const question = this.ctx.storage.sql
        .exec<{ text: string }>(
          "SELECT text FROM questions WHERE turn_id = ? ORDER BY asked_at DESC LIMIT 1",
          turn.id,
        )
        .toArray()[0];
      return { kind: "question", text: question?.text ?? "" };
    }
    const event = this.ctx.storage.sql
      .exec<{ data: string }>(
        `SELECT data FROM events WHERE turn_id = ? AND type = 'message.completed'
         ORDER BY seq DESC LIMIT 1`,
        turn.id,
      )
      .toArray()[0];
    const parsed = event ? (parseJsonRecord(event.data) ?? null) : null;
    return { kind: "completed", finalText: completionAnswer(parsed) };
  }

  // ── Held inputs (design 018: answer, steering, dismiss, undeliverable) ──────

  /**
   * Inside the transaction that admits the answering turn `turnId`: resolves
   * the question and delivers what it held. Held inputs go into `steering`
   * up to the steering bounds; the rest, and `asTurns` (inputs written after
   * the elicitation, which would have arrived with no question open), run as
   * ordinary turns after the answering turn, in order. `answerHeld` is the
   * held input that is itself the answer (reclassification).
   */
  private answerInTransaction(
    question: QuestionRow,
    text: string,
    turnId: string,
    timestamp: string,
    options: { answerHeld?: PendingHeld; asTurns?: PendingHeld[] } = {},
  ): {
    answer: QuestionAnswer;
    withAnswer(agentInput: StructuredAgentInput): StructuredAgentInput;
    answeredEvents(): AgentEvent[];
    overflowTurns(): AgentEvent[];
  } {
    const sql = this.ctx.storage.sql;
    const answer = answerQuestion(sql, question, text, turnId, timestamp);
    this.inheritChannelDelivery(turnId, question.turn_id, timestamp);
    const skip = new Set([options.answerHeld?.id, ...(options.asTurns ?? []).map((held) => held.id)]);
    const { steering, overflow } = splitSteering(
      pendingHeld(sql, question.id).filter((held) => !skip.has(held.id)),
    );
    const steeringInputs: HeldInput[] = steering.map((held) => held.input);
    return {
      answer,
      withAnswer: (agentInput) => ({
        ...agentInput,
        answer,
        ...(steeringInputs.length ? { steering: steeringInputs } : {}),
      }),
      // After the answering turn's `message.received`.
      answeredEvents: () => {
        const output = [
          this.appendEvent("question.answered", turnId, { questionId: question.id, answer }, timestamp),
        ];
        if (options.answerHeld) {
          markHeldDelivered(sql, options.answerHeld.id, turnId);
          output.push(this.heldDeliveredEvent(options.answerHeld, turnId, "answer", timestamp));
        }
        for (const held of steering) {
          markHeldDelivered(sql, held.id, turnId);
          output.push(this.heldDeliveredEvent(held, turnId, "steering", timestamp));
        }
        return output;
      },
      // After the answering turn is queued: its turns come after it.
      overflowTurns: () =>
        [...overflow, ...(options.asTurns ?? [])].flatMap((held) => this.heldAsTurnInTransaction(held, timestamp)),
    };
  }

  /**
   * Inside a transaction: a held input becomes an ordinary queued turn, after
   * every turn queued so far, with the subscriptions captured when it was
   * admitted. Its key answers with that turn's receipt from then on.
   */
  private heldAsTurnInTransaction(held: PendingHeld, timestamp: string, inputJson?: string): AgentEvent[] {
    const turnId = crypto.randomUUID();
    this.insertHeldTurn(held, turnId, inputJson ?? JSON.stringify(held.agentInput), timestamp);
    markHeldDelivered(this.ctx.storage.sql, held.id, turnId);
    return [
      this.heldReceivedEvent(held, turnId, timestamp),
      this.heldDeliveredEvent(held, turnId, "turn", timestamp),
      this.appendEvent("turn.queued", turnId, { mode: "queue" }, timestamp),
    ];
  }

  /**
   * A turn admitted internally in place of a channel input answers in the
   * channel that input came from: an answering turn inherits the delivery
   * of the turn that asked, and a held input that becomes a turn inherits
   * its own. `ON CONFLICT` leaves a channel-admitted turn the row its
   * enqueue already wrote. An input with no channel origin has no row to
   * copy and inherits none.
   */
  private inheritChannelDelivery(
    turnId: string,
    sourceTurnId: string | null | undefined,
    timestamp: string,
  ): void {
    if (!sourceTurnId) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO slack_deliveries (
         turn_id, connected_account_id, channel_id, external_user_id, thread_timestamp,
         provider, delivery_ref, status, attempts, updated_at
       )
       SELECT ?, connected_account_id, channel_id, external_user_id, thread_timestamp,
              provider, delivery_ref, 'pending', 0, ?
       FROM slack_deliveries
       WHERE turn_id = ?
       ON CONFLICT(turn_id) DO NOTHING`,
      turnId,
      timestamp,
      sourceTurnId,
    );
  }

  /** The turn row of a held input's own turn; its key is derived from the held input, never reused. */
  private insertHeldTurn(held: PendingHeld, turnId: string, inputJson: string, timestamp: string): void {
    this.inheritChannelDelivery(turnId, held.sourceTurnId, timestamp);
    this.ctx.storage.sql.exec(
      `INSERT INTO turns (
         id, input, input_json, mode, status, idempotency_key, fingerprint,
         subscriptions_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'queue', 'queued', ?, NULL, ?, ?, ?)`,
      turnId,
      held.inputText,
      inputJson,
      `held:${held.id}`,
      held.subscriptionsJson,
      timestamp,
      timestamp,
    );
  }

  private heldReceivedEvent(held: PendingHeld, turnId: string, timestamp: string): AgentEvent {
    return this.appendEvent(
      "message.received",
      turnId,
      {
        input: held.inputText,
        mode: "queue",
        ...(held.agentInput.payload !== undefined ? { payload: held.agentInput.payload } : {}),
      },
      timestamp,
    );
  }

  private heldDeliveredEvent(
    held: PendingHeld,
    turnId: string,
    as: "steering" | "answer" | "turn",
    timestamp: string,
  ): AgentEvent {
    return this.appendEvent(
      "message.delivered",
      undefined,
      {
        heldId: held.id,
        questionId: held.questionId,
        answerTurnId: turnId,
        turnId,
        as,
      },
      timestamp,
    );
  }

  private heldDiscardedEvent(held: PendingHeld, reason: "stopped" | "ended", timestamp: string): AgentEvent {
    return this.appendEvent(
      "message.discarded",
      undefined,
      { heldId: held.id, questionId: held.questionId, reason },
      timestamp,
    );
  }

  /** Inside a transaction: every held input of `questionId` runs as an ordinary turn, in arrival order. */
  private releaseHeldAsTurnsInTransaction(questionId: string, timestamp: string): AgentEvent[] {
    return pendingHeld(this.ctx.storage.sql, questionId).flatMap((held) =>
      this.heldAsTurnInTransaction(held, timestamp),
    );
  }

  /**
   * The Linear activity queue's hook, inside its transaction, when a
   * question's elicitation posted or can never post. Posted: Linear's time
   * for it is recorded and what is held is classified again, so a reply
   * written after the elicitation that arrived before its time was known
   * becomes the answer (the earliest by provider time), with the rest
   * delivered as an answer would deliver them. Undeliverable: the question
   * closes `undeliverable` and its held inputs run as ordinary turns.
   * Returns the appended events; the queue broadcasts them after commit and
   * then asks for a dispatch.
   */
  private questionElicitationInTransaction(
    questionId: string,
    outcome: { kind: "posted"; providerTime: string } | { kind: "undeliverable" },
  ): AgentEvent[] {
    const sql = this.ctx.storage.sql;
    if (!this.readSession() || this.requireSession().status === "ended") return [];
    const timestamp = now();
    if (outcome.kind === "undeliverable") {
      const closed = closeOpenQuestion(
        sql,
        "undeliverable",
        timestamp,
        (type, data) => this.appendEvent(type, undefined, data, timestamp),
        questionId,
      );
      if (!closed.questionId) return [];
      return [...closed.events, ...this.releaseHeldAsTurnsInTransaction(questionId, timestamp)];
    }
    if (!recordQuestionProviderTime(sql, questionId, outcome.providerTime)) return [];
    const question = questionById(sql, questionId)!;
    const candidate = heldAnswerCandidate(sql, question);
    if (!candidate) return [];
    const turnId = crypto.randomUUID();
    const held = candidate.answer;
    const answered = this.answerInTransaction(question, held.agentInput.text ?? held.inputText, turnId, timestamp, {
      answerHeld: held,
      asTurns: candidate.later,
    });
    this.insertHeldTurn(held, turnId, JSON.stringify(answered.withAnswer(held.agentInput)), timestamp);
    return [
      this.heldReceivedEvent(held, turnId, timestamp),
      ...answered.answeredEvents(),
      this.appendEvent("turn.queued", turnId, { mode: "queue" }, timestamp),
      ...answered.overflowTurns(),
    ];
  }

  /**
   * `POST /sessions/{id}/questions/{questionId}/dismiss`: closes the open
   * question as `dismissed` and runs what it held as ordinary turns, in
   * order; answers with the snapshot. A repeat for a question already
   * dismissed answers the same way and changes nothing; any other question
   * is `question_stale`.
   */
  dismissQuestion(questionId: string): SessionSnapshot {
    const sql = this.ctx.storage.sql;
    const session = this.requireSession();
    if (questionById(sql, questionId)?.closed_reason === "dismissed") return this.snapshot();
    const timestamp = now();
    const events =
      session.status === "ended"
        ? null
        : this.ctx.storage.transactionSync(() => {
            const closed = closeOpenQuestion(
              sql,
              "dismissed",
              timestamp,
              (type, data) => this.appendEvent(type, undefined, data, timestamp),
              questionId,
            );
            if (!closed.questionId) return null;
            return [...closed.events, ...this.releaseHeldAsTurnsInTransaction(questionId, timestamp)];
          });
    if (!events) {
      throw new Error(`${QUESTION_STALE}: question ${questionId} is not the session's open question`);
    }
    this.broadcastEvents(events);
    this.refreshQuestionCardsFor(events);
    this.dispatchNextTurn();
    this.ctx.waitUntil(this.scheduleAlarm());
    return this.snapshot();
  }

  // ── Questions in Slack (slack-ux P2: question card, click, rewrite) ─────────

  /**
   * The question a settled turn asked a person, if it asked one: a consult
   * is answered by a member agent, so its turn replies with its text as
   * before and posts no card.
   */
  private channelQuestionOfTurn(turnId: string): QuestionRow | undefined {
    return this.ctx.storage.sql
      .exec<QuestionRow>(
        `SELECT q.* FROM questions q
         WHERE q.turn_id = ?
           AND NOT EXISTS (SELECT 1 FROM agent_consultations c WHERE c.question_id = q.id)
         ORDER BY q.rowid DESC LIMIT 1`,
        turnId,
      )
      .toArray()[0];
  }

  /**
   * Posts a question in its thread: the card, or, once Slack has refused
   * the card for good, the plain-text gate with the options listed. Either
   * message's `ts` becomes the question's provider time. A typed reply to
   * either runs as an ordinary turn that carries the question
   * (`openQuestion`; Slack does not hold). Throws what the last post threw,
   * for the caller's retry and `undeliverable` handling.
   */
  private async postQuestionMessage(
    account: ReturnType<Env["ACCOUNTS"]["getByName"]>,
    delivery: SlackDeliveryRow,
    question: QuestionRow,
  ): Promise<void> {
    const target = deliveryTarget(delivery);
    if (question.channel_message_kind !== "text") {
      try {
        const messageId = await account.sendChannelQuestion(
          "slack",
          delivery.connection_id,
          target,
          this.questionCardOf(question),
        );
        // Recorded even if a later attempt has meanwhile taken the row:
        // the card is out, and the first recorded message stands.
        this.questionCardPosted(question.id, messageId, "card");
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!permanentDeliveryFailure(message) && !cardRefused(message)) throw error;
        // Degrade to a text gate, never to silence: the gate stays a gate.
        markQuestionTextGate(this.ctx.storage.sql, question.id);
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "slack.question_card_refused",
            sessionId: this.requireSession().id,
            questionId: question.id,
            message,
          }),
        );
      }
    }
    const messageId = await account.sendChannelQuestion(
      "slack",
      delivery.connection_id,
      target,
      this.questionCardOf(question, { textGate: true }),
    );
    this.questionCardPosted(question.id, messageId, "text");
  }

  /** The final text a settled turn wrote, trimmed; empty when it wrote none. */
  private finalTextOfTurn(turnId: string): string {
    const completed = this.ctx.storage.sql
      .exec<{ data: string }>(
        `SELECT data FROM events
         WHERE turn_id = ? AND type = 'message.completed'
         ORDER BY seq DESC LIMIT 1`,
        turnId,
      )
      .toArray()[0];
    return completionAnswer(completed ? parseJsonRecord(completed.data) : null).trim();
  }

  /**
   * The card for a question as it stands: open with its options, or
   * resolved (the answer and who gave it, or how it closed). Its text is
   * the snapshot, a blank line, and the question, ending with the arrow
   * link to the session, as every Slack answer does. The snapshot is the
   * question's `context` when the agent gave one, else the asking turn's
   * final text; rewrites keep it. As a text gate the options are listed in
   * the text instead of shown as buttons.
   */
  private questionCardOf(question: QuestionRow, mode: { textGate?: boolean } = {}): QuestionCard {
    const session = this.requireSession();
    const options = questionOptions(question);
    const link = ` [↗](${channelSessionUrl(this.env, session)})`;
    const optionsLine =
      mode.textGate && options.length
        ? `\n\nReply with one of: ${options.map((option) => option.label).join(" · ")}`
        : "";
    const card: QuestionCard = {
      questionId: question.id,
      text: questionMarkdown({
        snapshot: question.context?.trim() || this.finalTextOfTurn(question.turn_id),
        question: question.text,
        suffix: `${optionsLine}${link}`,
      }),
      options: options.map((option) => ({ label: option.label })),
      ...(mode.textGate ? { textGate: true } : {}),
    };
    if (question.answered_at !== null) {
      const answer = question.answer_json
        ? (parseJsonRecord(question.answer_json) as Partial<QuestionAnswer> | null)
        : null;
      const choice =
        options.find((option) => answer?.value !== undefined && option.value === answer.value)?.label ??
        (typeof answer?.text === "string" ? answer.text : "");
      const by = question.answered_by_turn_id
        ? this.slackUserOfTurn(question.answered_by_turn_id)
        : undefined;
      return { ...card, resolved: { kind: "chosen", choice, ...(by ? { by } : {}) } };
    }
    if (question.closed_reason !== null) {
      return {
        ...card,
        resolved: {
          kind: "closed",
          reason: question.closed_reason as QuestionClosedReason,
        },
      };
    }
    return card;
  }

  /** The Slack user a turn's input came from, when it came from Slack. */
  private slackUserOfTurn(turnId: string): string | undefined {
    const row = this.ctx.storage.sql
      .exec<Pick<TurnRow, "input" | "input_json">>(
        "SELECT input, input_json FROM turns WHERE id = ?",
        turnId,
      )
      .toArray()[0];
    if (!row) return undefined;
    const channel = structuredAgentInput(row.input_json, row.input).channel;
    return channel?.provider === "slack" && typeof channel.userId === "string"
      ? channel.userId
      : undefined;
  }

  /**
   * The card is out: its message is recorded, and its `ts` becomes the
   * question's provider time, which classifies what was held under it
   * again, as Linear's elicitation does. A Slack `ask` question holds
   * nothing (`flow`), so for it the time is a record only.
   */
  private questionCardPosted(questionId: string, messageId: string, kind: "card" | "text"): void {
    const providerTime = slackTimestampIso(messageId);
    const events = this.ctx.storage.transactionSync(() => {
      recordQuestionChannelMessage(this.ctx.storage.sql, questionId, messageId, kind);
      return providerTime
        ? this.questionElicitationInTransaction(questionId, { kind: "posted", providerTime })
        : [];
    });
    if (!events.length) return;
    this.broadcastEvents(events);
    this.refreshQuestionCardsFor(events);
    this.dispatchNextTurn();
  }

  /** The card could never be posted: the question closes `undeliverable`. */
  private questionCardUndeliverable(questionId: string): void {
    const events = this.ctx.storage.transactionSync(() =>
      this.questionElicitationInTransaction(questionId, { kind: "undeliverable" }),
    );
    if (!events.length) return;
    this.broadcastEvents(events);
    this.dispatchNextTurn();
  }

  /** Rewrites the card of every question these events answered or closed. */
  private refreshQuestionCardsFor(events: readonly AgentEvent[]): void {
    const resolved = new Set<string>();
    for (const event of events) {
      if (event.type !== "question.answered" && event.type !== "question.closed") continue;
      const questionId = (event.data as { questionId?: unknown }).questionId;
      if (typeof questionId === "string") resolved.add(questionId);
    }
    for (const questionId of resolved) {
      this.ctx.waitUntil(this.refreshQuestionCard(questionId));
    }
  }

  /**
   * Rewrites a posted question card to its resolved state: the choice and
   * who made it, or how it closed, with no buttons left. Best effort, like
   * an approval card's rewrite: a failure is logged, and a later click on
   * the stale card rewrites it again.
   */
  private async refreshQuestionCard(questionId: string): Promise<void> {
    const question = questionById(this.ctx.storage.sql, questionId);
    // A text gate has no card to rewrite.
    if (!question?.channel_message_id || question.channel_message_kind === "text") return;
    const card = this.questionCardOf(question);
    if (!card.resolved) return;
    const delivery = this.ctx.storage.sql
      .exec<Pick<SlackDeliveryRow, "connection_id" | "channel_id" | "thread_timestamp" | "delivery_ref" | "provider">>(
        `SELECT connected_account_id AS connection_id, channel_id, thread_timestamp, delivery_ref, provider
         FROM slack_deliveries WHERE turn_id = ?`,
        question.turn_id,
      )
      .toArray()[0];
    if (!delivery || (delivery.provider ?? "slack") !== "slack") return;
    const session = this.requireSession();
    try {
      await this.env.ACCOUNTS.getByName(session.account_id).updateChannelQuestion(
        "slack",
        delivery.connection_id,
        deliveryTarget(delivery),
        question.channel_message_id,
        card,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "slack.question_card_update_failed",
          sessionId: session.id,
          questionId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * A click on a question card's option (slack-ux P2): an answer turn with
   * `answers`, attributed to the clicker, keyed by question and click time
   * so Slack's retries admit it once. Only the person the session talks to
   * in Slack may answer: anyone else's click is logged and changes nothing.
   * A click on a question that is no longer open rewrites the card to what
   * happened instead.
   */
  async answerQuestionFromChannel(input: {
    questionId: string;
    optionIndex: number;
    externalUserId: string;
    actionTimestamp: string;
    connectionId: string;
    workspaceId?: string;
    conversationId?: string;
  }): Promise<
    | { outcome: "admitted"; turnId: string; duplicate: boolean }
    | { outcome: "stale" }
    | { outcome: "ignored"; reason: string }
  > {
    const ignored = (reason: string) => {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "slack.question_answer_ignored",
          sessionId: this.readSession()?.id,
          questionId: input.questionId,
          externalUserId: input.externalUserId,
          reason,
        }),
      );
      return { outcome: "ignored" as const, reason };
    };
    if (!this.readSession()) return ignored("no_session");
    const sql = this.ctx.storage.sql;
    const question = questionById(sql, input.questionId);
    if (!question) return ignored("unknown_question");
    const asking = sql
      .exec<Pick<SlackDeliveryRow, "connection_id" | "external_user_id" | "delivery_ref" | "provider">>(
        `SELECT connected_account_id AS connection_id, external_user_id, delivery_ref, provider
         FROM slack_deliveries WHERE turn_id = ?`,
        question.turn_id,
      )
      .toArray()[0];
    if (!asking || (asking.provider ?? "slack") !== "slack" || !asking.delivery_ref) {
      return ignored("not_a_channel_question");
    }
    if (
      asking.connection_id !== input.connectionId ||
      asking.external_user_id !== input.externalUserId
    ) {
      return ignored("not_owner");
    }
    const option = questionOptions(question)[input.optionIndex];
    if (!option) return ignored("unknown_option");
    try {
      const receipt = await this.enqueueChannelTurn(
        {
          input: option.label,
          answers: question.id,
          idempotencyKey: `slack-answer:${question.id}:${input.actionTimestamp}`,
          agentInput: {
            source: "channel",
            text: option.label,
            channel: {
              provider: "slack",
              connectionId: input.connectionId,
              ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
              ...(input.conversationId ? { conversationId: input.conversationId } : {}),
              userId: input.externalUserId,
            },
          },
        },
        {
          provider: "slack",
          connectionId: input.connectionId,
          externalUserId: input.externalUserId,
          deliveryRef: JSON.parse(asking.delivery_ref) as Record<string, unknown>,
        },
      );
      if (!("turnId" in receipt)) return ignored("held");
      return { outcome: "admitted", turnId: receipt.turnId, duplicate: receipt.duplicate };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(QUESTION_STALE) || message.startsWith(SESSION_ENDED)) {
        await this.refreshQuestionCard(question.id);
        return { outcome: "stale" };
      }
      throw error;
    }
  }

  private logWorkerdTurnSettlementIgnored(turnId: string, source: string): void {
    const current = this.ctx.storage.sql
      .exec<{ status: string }>("SELECT status FROM turns WHERE id = ?", turnId)
      .toArray()[0];
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "workerd_turn_settlement_ignored",
        sessionId: this.requireSession().id,
        turnId,
        source,
        turnStatus: current?.status ?? "missing",
        sessionStatus: this.requireSession().status,
      }),
    );
  }

  // Outcome delivery (work 025, session destinations).
  //
  // A turn captures the project's matching subscriptions when it is admitted.
  // The transaction that makes the turn terminal also writes one outbox row
  // per subscription that selected that outcome, so the intent survives with
  // the outcome itself. The alarm then admits a queued turn on the target
  // under a key derived from subscription and event, records the target turn
  // as the receipt, and retries transient failures with backoff under a
  // lease. Ended or missing targets and deleted subscriptions fail visibly.

  private async captureEventSubscriptions(): Promise<CapturedSubscription[]> {
    const session = this.requireSession();
    // Subscriptions are scoped to an environment; a session without a
    // recorded one (created before environments were session identity, or
    // outside any project) matches nothing. The deployment alias is not
    // consulted: it moves, the session's environment does not.
    if (!isProjectEnvironmentName(session.environment)) {
      return [];
    }
    const account = this.env.ACCOUNTS.getByName(session.account_id);
    // The labels as they stand at admission select `sourceLabels`
    // subscriptions; a later label change does not alter what this turn
    // captured.
    const matched: EventSubscription[] = await account.matchEventSubscriptions(
      session.agent_id,
      session.environment,
      readLabels(session.labels_json),
    );
    return (
      matched
        // A session never notifies itself: that turn would complete, notify,
        // and never stop.
        .filter((subscription) => subscription.destination.sessionId !== session.id)
        .map(({ id, events, destination }) => ({ id, events, destination }))
    );
  }

  /** Inside the terminal transaction: one outbox row per subscription that wants this event. */
  private recordOutcomeDeliveries(turnId: string, event: AgentEvent): void {
    const row = this.ctx.storage.sql
      .exec<Pick<TurnRow, "subscriptions_json">>(
        "SELECT subscriptions_json FROM turns WHERE id = ?",
        turnId,
      )
      .toArray()[0];
    if (!row) return;
    let captured: CapturedSubscription[];
    try {
      captured = JSON.parse(row.subscriptions_json) as CapturedSubscription[];
    } catch {
      return;
    }
    const nowMs = Date.now();
    for (const subscription of captured) {
      if (!subscription.events.includes(event.type as OutcomeEventType)) continue;
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO outcome_deliveries (
           id, subscription_id, event_id, event_type, turn_id, destination_json,
           status, attempt, next_attempt_at_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        `${subscription.id}:${event.id}`,
        subscription.id,
        event.id,
        event.type,
        turnId,
        JSON.stringify(subscription.destination),
        nowMs,
        event.timestamp,
        event.timestamp,
      );
    }
  }

  private async deliverOutcomeEvents(): Promise<void> {
    const nowMs = Date.now();
    const due = this.ctx.storage.sql
      .exec<OutcomeDeliveryRow>(
        `SELECT * FROM outcome_deliveries
         WHERE status = 'pending'
           AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?
           AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
         ORDER BY next_attempt_at_ms, rowid
         LIMIT 10`,
        nowMs,
        nowMs,
      )
      .toArray();
    for (const row of due) {
      await this.deliverOutcomeEvent(row);
    }
  }

  private async deliverOutcomeEvent(row: OutcomeDeliveryRow): Promise<void> {
    const attempt = row.attempt + 1;
    // Take the lease before any await so a second alarm firing skips this row.
    const leased = this.ctx.storage.sql.exec(
      `UPDATE outcome_deliveries
       SET attempt = ?, lease_until_ms = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND attempt = ?`,
      attempt,
      Date.now() + OUTCOME_DELIVERY_LEASE_MS,
      now(),
      row.id,
      row.attempt,
    ).rowsWritten;
    if (!leased) return;

    const session = this.requireSession();
    const destination = JSON.parse(row.destination_json) as OutcomeDestination;
    try {
      const target = this.env.SESSIONS.getByName(destination.sessionId);
      // The target's receipt first: a lost reply from an earlier attempt
      // means the target already holds the keyed turn and answers with the
      // same receipt, ended or not, and a subscription deleted since then
      // cannot undo or conceal that admission. Deletion only prohibits a
      // new one.
      const committed = await target.findTurn(row.id);
      // `turnId` is null when the target held the input behind its open
      // question (design 018): admitted, with no turn of its own yet.
      let receipt: { sessionId: string; turnId: string | null };
      if (committed) {
        receipt = { sessionId: destination.sessionId, turnId: committed.turnId };
      } else {
        const account = this.env.ACCOUNTS.getByName(session.account_id);
        if (!(await account.getEventSubscription(row.subscription_id))) {
          throw new OutcomeDeliveryTerminalError("subscription_unavailable");
        }
        const snapshot = await target.snapshotOrNull();
        if (!snapshot) throw new OutcomeDeliveryTerminalError("target_missing");
        if (snapshot.status === "ended") {
          throw new OutcomeDeliveryTerminalError("target_ended");
        }
        const event = this.outcomeEvent(row);
        const admitted = await target.enqueueTurn({
          input: outcomeEventText(event),
          idempotencyKey: row.id,
          mode: "queue",
          agentInput: { source: "event", event },
        });
        receipt = {
          sessionId: destination.sessionId,
          turnId: "turnId" in admitted ? admitted.turnId : null,
        };
      }
      this.ctx.storage.sql.exec(
        `UPDATE outcome_deliveries
         SET status = 'delivered', receipt_session_id = ?, receipt_turn_id = ?,
             next_attempt_at_ms = NULL, lease_until_ms = NULL, error = NULL, updated_at = ?
         WHERE id = ?`,
        receipt.sessionId,
        receipt.turnId,
        now(),
        row.id,
      );
      console.log(
        JSON.stringify({
          level: "info",
          event: "outcome_delivery.delivered",
          sessionId: session.id,
          deliveryId: row.id,
          eventType: row.event_type,
          targetSessionId: receipt.sessionId,
          targetTurnId: receipt.turnId,
          attempt,
          recovered: Boolean(committed),
        }),
      );
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      const terminal = error instanceof OutcomeDeliveryTerminalError;
      const backoff = OUTCOME_DELIVERY_BACKOFF_MS[attempt - 1];
      const exhausted = terminal || backoff === undefined;
      this.ctx.storage.sql.exec(
        `UPDATE outcome_deliveries
         SET status = ?, next_attempt_at_ms = ?, lease_until_ms = NULL, error = ?, updated_at = ?
         WHERE id = ?`,
        exhausted ? "failed" : "pending",
        exhausted ? null : Date.now() + backoff,
        terminal ? message : exhausted ? `retry_exhausted: ${message}` : message,
        now(),
        row.id,
      );
      console.log(
        JSON.stringify({
          level: exhausted ? "error" : "warn",
          event: "outcome_delivery.attempt_failed",
          sessionId: session.id,
          deliveryId: row.id,
          eventType: row.event_type,
          targetSessionId: destination.sessionId,
          attempt,
          exhausted,
          terminal,
          error: message,
        }),
      );
    }
  }

  /** The event as delivered: identifiers, outcome, and for a completed turn its bounded final message. */
  private outcomeEvent(row: OutcomeDeliveryRow): OutcomeEvent {
    const session = this.requireSession();
    const terminal = this.ctx.storage.sql
      .exec<Pick<EventRow, "timestamp" | "data">>(
        "SELECT timestamp, data FROM events WHERE id = ?",
        row.event_id,
      )
      .toArray()[0];
    const data: unknown = terminal ? JSON.parse(terminal.data) : {};
    const detail = isRecord(data) ? data : {};
    const event: OutcomeEvent = {
      id: row.event_id,
      type: row.event_type,
      sessionId: session.id,
      turnId: row.turn_id,
      agentId: session.agent_id,
      occurredAt: terminal?.timestamp ?? row.created_at,
      ...(typeof detail.reason === "string" ? { reason: detail.reason } : {}),
      ...(row.event_type === "turn.failed" && typeof detail.message === "string"
        ? { error: boundedText(detail.message, 1_024).text }
        : {}),
    };
    // The source's labels as they stand now, so a subscriber can also
    // filter on its side.
    const labels = readLabels(session.labels_json);
    if (Object.keys(labels).length) event.labels = labels;
    if (row.event_type === "turn.completed") {
      const final = this.ctx.storage.sql
        .exec<Pick<EventRow, "data">>(
          `SELECT data FROM events
           WHERE turn_id = ? AND type = 'message.completed'
           ORDER BY seq DESC LIMIT 1`,
          row.turn_id,
        )
        .toArray()[0];
      const parsed: unknown = final ? JSON.parse(final.data) : null;
      // The bound applies to the answer, never to progress text before it.
      event.result = boundedText(
        completionAnswer(isRecord(parsed) ? parsed : null),
        OUTCOME_RESULT_TEXT_LIMIT,
      );
      // A turn that asked (design 018): the subscriber reads what it asked.
      const question =
        detail.outcome === "question" && typeof detail.questionId === "string"
          ? questionById(this.ctx.storage.sql, detail.questionId)
          : undefined;
      if (question) {
        event.outcome = "question";
        event.question = {
          id: question.id,
          text: question.text,
          options: questionOptions(question),
          ...(question.context ? { context: question.context } : {}),
        };
      }
    }
    return event;
  }

  private transitionSession(next: SessionStatus): void {
    const session = this.requireSession();
    if (session.status === next) {
      return;
    }
    const timestamp = now();
    const event = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE session SET status = ?, updated_at = ? WHERE id = ?",
        next,
        timestamp,
        session.id,
      );
      return this.appendEvent(
        "session.status_changed",
        undefined,
        { from: session.status, to: next },
        timestamp,
      );
    });
    this.broadcastEvents([event]);
  }

  private handleRuntimeDisconnect(
    attachment: RuntimeConnectionAttachment,
    code: number,
    reason: string,
  ): void {
    const session = this.requireSession();
    if (
      session.runtime_epoch !== attachment.epoch ||
      session.runtime_id !== attachment.runtimeId
    ) {
      return;
    }

    const timestamp = now();
    const microvm = this.readMicrovmBinding();
    const hasActiveTurn =
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM turns WHERE status IN ('queued', 'running')",
        )
        .one().count > 0;
    const nextStatus =
      microvm?.state === "suspending" || microvm?.state === "suspended"
        ? "suspended"
        : microvm?.state === "terminated"
          ? "ended"
          : hasActiveTurn
            ? "waiting_runtime"
            : session.status;
    const events = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE turns
         SET status = 'queued', updated_at = ?
         WHERE status = 'running'`,
        timestamp,
      );
      this.ctx.storage.sql.exec(
        `UPDATE session
         SET status = ?, runtime_id = NULL, updated_at = ?
         WHERE id = ?`,
        nextStatus,
        timestamp,
        session.id,
      );
      const disconnected = this.appendEvent(
        "runtime.disconnected",
        undefined,
        {
          runtimeId: attachment.runtimeId,
          epoch: attachment.epoch,
          code,
          reason,
        },
        timestamp,
      );
      return session.status === nextStatus
        ? [disconnected]
        : [
            disconnected,
            this.appendEvent(
              "session.status_changed",
              undefined,
              { from: session.status, to: nextStatus },
              timestamp,
            ),
          ];
    });
    this.broadcastEvents(events);
  }
}
