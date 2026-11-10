// The Computer API's objects (work 084; opc/docs/api/reference/objects.mdx):
// Session, Turn, TurnSummary, Ask, Actor, Person, Capabilities, Secret, Result,
// and the error body. The source of truth for their shapes: decoded at the
// socket edge, emitted as JSON Schema by scripts/api-schema.mjs.
//
// Invariants: every field is present (`null`, never absent); enums the server
// emits are open (`open(...)`: a string whose known values are listed), enums a
// client sends are closed (literals), and objects accept unknown fields on the
// way out (readers ignore them) while params refuse them (schema-methods.ts).

import { Schema } from 'effect';

/** A string with known values that may gain more (the docs' "enums are open"). */
export const open = <const V extends readonly string[]>(values: V, description?: string) =>
  Schema.String.annotate({ description: `${description ? `${description}. ` : ''}One of ${values.map((v) => `\`${v}\``).join(', ')}; may gain values.`, examples: [values[0]] });

export const Id = (prefix: string, length: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{${length}}$`, 'u'))).annotate({
    description: `\`${prefix}_\` + ${length} lowercase Crockford base32`,
  });

export const SessionId = Id('cs', 16).annotate({ identifier: 'SessionId' });
export const TurnId = Id('tn', 12);
export const AskId = Id('ak', 12);
export const TerminalId = Id('tm', 12);
export const SubagentId = Id('sa', 12);
export const EventId = Id('ev', 16);
export const Time = Schema.String.annotate({ description: 'ISO 8601, UTC, milliseconds', format: 'date-time' } as never);
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Json = Schema.Unknown.annotate({ description: 'Any JSON value' });
const NullString = Schema.NullOr(Schema.String);

export const Person = Schema.Struct({ id: Schema.String, name: Schema.String, email: NullString }).annotate({ identifier: 'Person' });

export const Actor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  via: open(['slack', 'opc', 'dashboard', 'api']),
  client: NullString,
}).annotate({ identifier: 'Actor' });

/** A turn failure (errors.mdx "Turn failures"). */
export const TurnError = Schema.Struct({
  code: open(['model_rejected', 'model_unavailable', 'model_stream_failed', 'context_too_long', 'runtime_lost', 'runtime_failed', 'tool_failed', 'agent_failed']),
  message: Schema.String,
}).annotate({ identifier: 'TurnError' });

export const Usage = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  reasoningTokens: Count,
  cachedTokens: Count,
  cacheWriteTokens: Count,
  costUsd: NullString.annotate({ description: 'A decimal string, such as "0.41"; null on the organization\'s own model account' }),
}).annotate({ identifier: 'Usage' });

export const IfBusy = Schema.Literals(['queue', 'steer', 'interrupt']);
/** A session's output speed as a create or update sets it (protocol.ts `Speed`). */
export const Speed = Schema.Literals(['fast', 'standard']);
export const TurnStatus = open(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled']);
export const CancelReason = open(['interrupted', 'withdrawn']);

export const Turn = Schema.Struct({
  id: TurnId,
  sessionId: SessionId,
  status: TurnStatus,
  /** `message`: a person's input; `subagent`: the harness started it on its own when a background subagent ended. */
  trigger: open(['message', 'subagent']),
  /** Set when `trigger` is `subagent`. */
  subagentId: Schema.NullOr(SubagentId),
  ifBusy: open(['queue', 'steer', 'interrupt']),
  input: NullString.annotate({ description: 'null when the turn was not started by a message (`trigger` other than `message`)' }),
  author: Schema.NullOr(Actor).annotate({ description: 'null when `trigger` is `subagent`' }),
  steering: Schema.Array(Schema.Struct({ input: Schema.String, author: Actor, createdAt: Time })),
  createdAt: Time,
  startedAt: Schema.NullOr(Time),
  endedAt: Schema.NullOr(Time),
  text: NullString,
  error: Schema.NullOr(TurnError),
  reason: Schema.NullOr(CancelReason),
  forced: Schema.NullOr(Schema.Boolean),
  usage: Schema.NullOr(Usage),
}).annotate({ identifier: 'Turn' });

export const TurnSummary = Schema.Struct({
  id: TurnId,
  status: open(['completed', 'failed', 'cancelled']),
  endedAt: Time,
  text: NullString,
  error: Schema.NullOr(TurnError),
  reason: Schema.NullOr(CancelReason),
  forced: Schema.NullOr(Schema.Boolean),
}).annotate({ identifier: 'TurnSummary' });

export const Approval = Schema.Struct({
  toolName: Schema.String,
  callId: Schema.String,
  input: Json,
  title: Schema.String,
  alwaysAllows: NullString,
}).annotate({ identifier: 'Approval' });

export const Question = Schema.Struct({
  questions: Schema.Array(Schema.Struct({
    id: Schema.String,
    header: Schema.String,
    text: Schema.String,
    multiSelect: Schema.Boolean,
    options: Schema.Array(Schema.Struct({ label: Schema.String, description: NullString })),
  })),
}).annotate({ identifier: 'Question' });

export const SecretRequest = Schema.Struct({ name: Schema.String, purpose: Schema.String, file: Schema.Boolean }).annotate({ identifier: 'SecretRequest' });

export const ApprovalAnswer = Schema.Struct({
  decision: Schema.Literals(['allow', 'deny', 'always']),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  /** A plan approval only (`approval.toolName` ExitPlanMode), with `allow`: the mode the session continues in, one of Capabilities.modes other than `plan`. */
  mode: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'ApprovalAnswer' });

export const QuestionAnswer = Schema.Struct({
  answers: Schema.Array(Schema.Struct({ questionId: Schema.String, choices: Schema.Array(Schema.String), text: NullString })),
}).annotate({ identifier: 'QuestionAnswer' });

/** How a message sent while the ask was open closed it: the message, and the seq of its `message.received`. */
export const DeclineAnswer = Schema.Struct({ message: Schema.String, messageSeq: Count }).annotate({ identifier: 'DeclineAnswer' });

export const Ask = Schema.Struct({
  id: AskId,
  sessionId: SessionId,
  turnId: TurnId,
  kind: open(['approval', 'question', 'secret']),
  /** Asks never expire. `declined`: a message sent while it was open closed it and reached the agent as instructions (`answer` names it). */
  status: open(['open', 'answered', 'dismissed', 'declined', 'interrupted']),
  createdAt: Time,
  closedAt: Schema.NullOr(Time),
  closedBy: Schema.NullOr(Actor),
  answer: Schema.NullOr(Json).annotate({
    description: 'ApprovalAnswer, QuestionAnswer, `{ scope }` for a secret ask, or DeclineAnswer when status is `declined`',
  }),
  approval: Schema.NullOr(Approval),
  question: Schema.NullOr(Question),
  secret: Schema.NullOr(SecretRequest),
}).annotate({ identifier: 'Ask' });

/** A subagent the session's agent launched (Claude Code's Task tool, Codex's agents). Background ones outlive their turn. */
export const Subagent = Schema.Struct({
  id: SubagentId,
  sessionId: SessionId,
  /** The turn that launched it (kept on its events after that turn ended). */
  turnId: TurnId,
  /** The tool call that launched it; null when the harness does not say. */
  callId: NullString,
  /** Its description. */
  name: Schema.String,
  agentType: NullString,
  background: Schema.Boolean,
  status: open(['running', 'completed', 'failed', 'stopped']),
  /** What it is doing now; null once ended or before it reports. */
  activity: NullString,
  toolCalls: Count,
  tokens: Count,
  createdAt: Time,
  endedAt: Schema.NullOr(Time),
  durationMs: Schema.NullOr(Count),
  /** Its final answer: null until it ends; inline up to 8 KiB (`resultTruncated`), in full from `subagents.get`. */
  result: NullString,
  resultTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  /** `usr_…` of who stopped it; null otherwise. */
  stoppedBy: Schema.NullOr(Actor).annotate({ description: 'who stopped it, when it was stopped through the API' }),
}).annotate({ identifier: 'Subagent' });

/** A subagent as the Result lists it. */
export const SubagentSummary = Schema.Struct({
  id: SubagentId,
  name: Schema.String,
  status: open(['running', 'completed', 'failed', 'stopped']),
  background: Schema.Boolean,
}).annotate({ identifier: 'SubagentSummary' });

export const SessionStatus = open(['starting', 'running', 'waiting', 'idle', 'suspended']);

/** `speed`: `fast` | `standard`, null = fast (a session that never set one). */
export const Settings = Schema.Struct({ model: NullString, effort: NullString, mode: Schema.String, speed: NullString }).annotate({ identifier: 'Settings' });

export const Origin = Schema.Struct({
  type: open(['slack', 'opc', 'dashboard', 'api']),
  client: NullString,
  slack: Schema.NullOr(Schema.Struct({ teamId: NullString, channelId: Schema.String, channelName: NullString, threadTs: NullString, url: NullString })),
}).annotate({ identifier: 'Origin' });

export const Session = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  status: SessionStatus,
  archived: Schema.Boolean,
  owner: Person,
  origin: Origin,
  settings: Settings,
  metadata: Schema.Record(Schema.String, Schema.String),
  activeTurnId: Schema.NullOr(TurnId),
  queued: Schema.Array(Turn),
  asks: Schema.Array(Ask),
  /** The running subagents, oldest first. `idle` with any here: background work is going on (never idle-suspended). */
  subagents: Schema.Array(Subagent),
  lastTurn: Schema.NullOr(TurnSummary),
  lastText: NullString,
  context: Schema.Struct({ usedTokens: Schema.NullOr(Count), windowTokens: Schema.NullOr(Count) }),
  lastSeq: Seq,
  logEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  epochStartSeq: Seq,
  createdAt: Time,
  lastActiveAt: Time,
  syncedAt: Schema.NullOr(Time),
  urls: Schema.Struct({ dashboard: NullString }),
}).annotate({ identifier: 'Session' });

export const Capabilities = Schema.Struct({
  models: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    efforts: Schema.Array(Schema.String),
    contextWindow: Schema.NullOr(Count),
    default: Schema.Boolean,
  })),
  modes: Schema.Array(Schema.String),
  features: Schema.Struct({
    steer: Schema.Boolean,
    compact: Schema.Boolean,
    terminal: Schema.Boolean,
    workspace: Schema.Boolean,
    reasoning: Schema.Boolean,
    subagents: Schema.Boolean,
  }),
}).annotate({ identifier: 'Capabilities' });

export const Secret = Schema.Struct({
  name: Schema.String,
  scope: open(['session', 'me', 'organization']),
  sessionId: Schema.NullOr(SessionId),
  file: Schema.Boolean,
  effective: Schema.NullOr(Schema.Boolean),
  setBy: Actor,
  updatedAt: Time,
}).annotate({ identifier: 'Secret' });

export const Result = Schema.Struct({
  type: Schema.Literal('result'),
  subtype: open(['success', 'error', 'cancelled', 'waiting']),
  isError: Schema.Boolean,
  sessionId: SessionId,
  turnId: TurnId,
  status: open(['completed', 'failed', 'cancelled', 'waiting']),
  result: NullString,
  error: Schema.NullOr(TurnError),
  reason: Schema.NullOr(CancelReason),
  ask: Schema.NullOr(Ask),
  url: Schema.String,
  durationMs: Count,
  usage: Schema.NullOr(Usage),
  /** Subagents the turn launched; background ones may still be `running` when it completes. */
  subagents: Schema.Array(SubagentSummary),
  turn: Turn,
}).annotate({ identifier: 'Result' });

/** The `error` of every failed response (errors.mdx); code-specific fields beside these. */
export const ApiError = Schema.Struct({
  code: open([
    'invalid_request', 'unsupported_model', 'unsupported_effort', 'unsupported_mode', 'invalid_answer', 'answer_with_secret',
    'invalid_path', 'invalid_archive', 'invalid_cursor', 'unauthenticated', 'insufficient_credits', 'forbidden',
    'admin_required', 'not_found', 'session_not_found', 'turn_not_found', 'ask_not_found', 'path_not_found',
    'secret_not_found', 'id_conflict', 'idempotency_conflict', 'ask_closed', 'session_busy', 'turn_not_cancellable',
    'queue_full', 'cursor_ahead', 'path_exists', 'feature_unavailable', 'computer_not_set_up', 'too_large',
    'upgrade_required', 'rate_limited', 'internal', 'computer_unavailable', 'unavailable', 'terminal_not_found',
    'too_far_behind', 'too_many_attached', 'too_many_terminals', 'subagent_not_found', 'subagent_ended',
  ]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  retryable: Schema.optionalKey(Schema.Boolean),
  requestId: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  retryAfterMs: Schema.optionalKey(Count),
}).annotate({ identifier: 'Error' });

export type Session = typeof Session.Type;
export type Turn = typeof Turn.Type;
export type TurnSummary = typeof TurnSummary.Type;
export type Ask = typeof Ask.Type;
export type Actor = typeof Actor.Type;
export type Capabilities = typeof Capabilities.Type;
export type Usage = typeof Usage.Type;
export type TurnError = typeof TurnError.Type;
export type Result = typeof Result.Type;
export type Subagent = typeof Subagent.Type;
