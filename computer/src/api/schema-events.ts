// The Computer API's events and deltas (work 084; opc/docs/api/reference/events.mdx):
// the envelope, and `data` for every recorded type and every delta type.
//
// Invariants: `EVENT_DATA` is the one list of recorded types; a type not in it
// is still a valid `Event` (readers treat it as informational), so `Event` is
// the known types plus a catch-all. Every listed data field is present, `null`
// when it does not apply. Deltas are never journaled.

import { Schema } from 'effect';
import { Actor, Ask, AskId, Count, EventId, open, Origin, SessionId, Settings, Subagent, SubagentId, Time, TurnError, TurnId } from './schema-objects.js';

const NullString = Schema.NullOr(Schema.String);
const Json = Schema.Unknown;
/** `parentCallId` on text and reasoning is always null with Claude Code, which does not stream a subagent's text. */
const Block = { blockId: Schema.String, parentCallId: NullString, text: Schema.String };
/** The subagent a tool call ran inside (its launching call is `parentCallId`); null for the session's own agent. */
const TurnTrigger = open(['message', 'subagent']);
const InSubagent = { subagentId: Schema.NullOr(SubagentId) };

export const FileChange = Schema.Struct({
  path: Schema.String,
  status: open(['added', 'modified', 'deleted']),
  added: Schema.NullOr(Count),
  removed: Schema.NullOr(Count),
}).annotate({ identifier: 'FileChange' });

/** `data` of every recorded event type. */
export const EVENT_DATA = {
  'session.created': Schema.Struct({ title: Schema.String, origin: Origin, settings: Settings }),
  'session.status_changed': Schema.Struct({ from: NullString, to: Schema.String }),
  'session.updated': Schema.Struct({ changes: Schema.Record(Schema.String, Schema.Struct({ from: Json, to: Json })) }),
  'session.compacted': Schema.Struct({ beforeTokens: Schema.NullOr(Count), afterTokens: Schema.NullOr(Count), auto: Schema.Boolean }),
  'message.received': Schema.Struct({
    input: Schema.String,
    ifBusy: open(['queue', 'steer', 'interrupt']),
    delivery: open(['started', 'queued', 'steered']),
    interruptedTurnIds: Schema.Array(TurnId),
    /** The open asks a steer declined (each closes `declined`, its answer naming this event's seq); empty otherwise. */
    declinedAskIds: Schema.Array(AskId),
  }),
  /** `trigger` as on the Turn; `subagentId`: the background subagent whose end started the turn (`trigger` `subagent`), else null. */
  'turn.queued': Schema.Struct({ position: Count, trigger: TurnTrigger, subagentId: Schema.NullOr(SubagentId) }),
  /**
   * The agent took the steering message in (the harness consumed it), not when the server received it.
   * `messageSeq`: the seq of that message's `message.received`.
   */
  'turn.steered': Schema.Struct({ messageSeq: Count }),
  'turn.started': Schema.Struct({ model: NullString, effort: NullString, mode: NullString, trigger: TurnTrigger, subagentId: Schema.NullOr(SubagentId) }),
  'turn.status_changed': Schema.Struct({ from: Schema.String, to: Schema.String }),
  /** `silent`: the agent chose not to reply (no text is shown for the turn, not even an end line). */
  'turn.completed': Schema.Struct({ text: NullString, durationMs: Count, silent: Schema.Boolean }),
  'turn.failed': Schema.Struct({ error: TurnError }),
  'turn.cancelled': Schema.Struct({ reason: open(['interrupted', 'withdrawn']), forced: Schema.Boolean, input: NullString }),
  'message.completed': Schema.Struct(Block),
  'reasoning.completed': Schema.Struct({ ...Block, redacted: Schema.Boolean, durationMs: Schema.NullOr(Count) }),
  'tool.started': Schema.Struct({
    ...InSubagent, toolName: Schema.String, callId: Schema.String, parentCallId: NullString, title: Schema.String, input: Json, inputTruncated: Schema.Boolean,
  }),
  'tool.completed': Schema.Struct({
    ...InSubagent, toolName: Schema.String, callId: Schema.String, parentCallId: NullString, title: Schema.String, output: Json, outputTruncated: Schema.Boolean,
    fileChanges: Schema.NullOr(Schema.Array(FileChange)), durationMs: Schema.NullOr(Count),
  }),
  'tool.failed': Schema.Struct({
    ...InSubagent, toolName: Schema.String, callId: Schema.String, parentCallId: NullString, title: Schema.String, message: Schema.String,
    settledBy: NullString.annotate({ description: 'The turn-ending event type that settled a call still open, else null' }),
  }),
  'subagent.started': Schema.Struct({ subagent: Subagent }),
  /** status `completed|failed|stopped`, with `result` (≤ 8 KiB inline) and `error`. */
  'subagent.ended': Schema.Struct({ subagent: Subagent }),
  'ask.opened': Schema.Struct({ ask: Ask }),
  'ask.closed': Schema.Struct({ ask: Ask }),
  'usage.recorded': Schema.Struct({
    model: NullString, inputTokens: Count, outputTokens: Count, reasoningTokens: Count, cachedTokens: Count, cacheWriteTokens: Count,
    costUsd: NullString, firstTokenMs: Schema.NullOr(Count), durationMs: Schema.NullOr(Count), usedTokens: Schema.NullOr(Count), windowTokens: Schema.NullOr(Count),
  }),
  'model.rate_limited': Schema.Struct({ model: NullString, retryAfterMs: Schema.NullOr(Count), attempt: Count }),
  'runtime.starting': Schema.Struct({ phase: open(['computer', 'agent']) }),
  'runtime.connected': Schema.Struct({ warm: Schema.Boolean, resumed: Schema.Boolean, durationMs: Schema.NullOr(Count) }),
  'runtime.suspended': Schema.Struct({ reason: open(['idle', 'requested', 'lost']) }),
  'files.pushed': Schema.Struct({ path: Schema.String, files: Count, bytes: Count, replaced: Schema.Boolean }),
  'terminal.opened': Schema.Struct({ terminalId: Schema.String, command: NullString }),
  'terminal.closed': Schema.Struct({ terminalId: Schema.String, exitCode: Schema.NullOr(Schema.Int) }),
} as const;

export type EventType = keyof typeof EVENT_DATA;
export type EventDataOf<T extends EventType> = (typeof EVENT_DATA)[T]['Type'];
export const EVENT_TYPES = Object.keys(EVENT_DATA) as EventType[];

/** Types that end a turn: exactly one, last, per turn. */
export const TURN_ENDINGS = ['turn.completed', 'turn.failed', 'turn.cancelled'] as const;

const envelope = {
  id: EventId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdAt: Time,
  sessionId: SessionId,
  turnId: Schema.NullOr(TurnId),
  actor: Schema.NullOr(Actor),
};

const known = EVENT_TYPES.map((type) =>
  Schema.Struct({ ...envelope, type: Schema.Literal(type), data: EVENT_DATA[type] }).annotate({ identifier: `Event.${type}` }));

/** A type this version does not know: informational. */
const Unknown = Schema.Struct({ ...envelope, type: Schema.String, data: Schema.Record(Schema.String, Json) }).annotate({ identifier: 'Event.other' });

export const Event = Schema.Union([...known, Unknown]).annotate({ identifier: 'Event' });

/** `data` of every delta type. */
export const DELTA_DATA = {
  'message.delta': Schema.Struct(Block),
  'reasoning.delta': Schema.Struct(Block),
  /**
   * The model is writing a tool call's input (from the call's first streamed byte to `tool.started`), at most 4 a second:
   * `path` and `description` once their strings are complete, `lines` of the content being written (Write, Edit) so far.
   */
  'tool.preparing': Schema.Struct({
    ...InSubagent, callId: Schema.String, toolName: Schema.String, path: NullString, description: NullString, lines: Schema.NullOr(Count),
  }),
  /** Live output of a running call, for harnesses that stream it. Claude Code does not: its output comes with `tool.completed`. */
  'tool.delta': Schema.Struct({ callId: Schema.String, text: Schema.String }),
  /** Compaction began (Claude Code's `status: compacting`); `session.compacted` is its recorded end. */
  'session.compacting': Schema.Struct({}),
  /** Frequent, so not recorded: the latest values fold into the Subagent on every read. */
  'subagent.progress': Schema.Struct({ subagentId: SubagentId, activity: NullString, toolCalls: Count, tokens: Count }),
} as const;
export type DeltaType = keyof typeof DELTA_DATA;

export const Delta = Schema.Union(
  (Object.keys(DELTA_DATA) as DeltaType[]).map((type) =>
    Schema.Struct({ type: Schema.Literal(type), sessionId: SessionId, turnId: Schema.NullOr(TurnId), data: DELTA_DATA[type] }).annotate({ identifier: `Delta.${type}` })),
).annotate({ identifier: 'Delta' });

/** A recorded event as the writer builds it, typed by its `type`. */
export type ApiEvent<T extends EventType = EventType> = {
  [K in T]: { id: string; seq: number; createdAt: string; sessionId: string; turnId: string | null; type: K; actor: typeof Actor.Type | null; data: EventDataOf<K> };
}[T];
export type ApiDelta = typeof Delta.Type;
