// The durable session event log as the hook reads it, and the pure reduction
// of that log into what a chat renders: messages, and turns with their tool
// activity and result. No React and no network here: the same function
// replays history and applies live events, so a reconnect that resumes from
// a cursor produces the same messages and turns as an uninterrupted stream.
// Every id is derived from the log (turn ids, tool call ids), never minted,
// which is what makes replay and live agree.

/** One entry of `GET /sessions/<id>/events`. */
export interface AgentEvent {
  id?: string;
  /** Position in the session log; `after=<seq>` resumes past it. */
  seq: number;
  timestamp?: string;
  turnId?: string;
  type: string;
  data: Record<string, unknown>;
}

/** A JSON value: what a turn payload, a tool input or output, and a result carry. */
export type DataValue = string | number | boolean | null | DataValue[] | { [key: string]: DataValue };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** The turn that carried the message; absent on messages the hook created locally. */
  turnId?: string;
  /** Set on an assistant message while its turn is still producing text. */
  streaming?: boolean;
}

/** A `memory.saved` event: a save the session observed succeeding. */
export interface MemorySave {
  seq: number;
  turnId?: string;
  timestamp?: string;
  resource: string;
  documentId: string;
  revision: string;
  bytes: number;
}

export type TurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolCallStatus = "running" | "completed" | "failed";

/** One tool call of a turn, keyed on the runtime's `callId`. */
export interface ToolCall {
  callId: string;
  tool: string;
  title: string;
  input?: DataValue;
  output?: DataValue;
  status: ToolCallStatus;
}

/** The public failure a `turn.failed` event carries. */
export interface TurnFailure {
  code: string;
  message: string;
}

/** A turn as the log has recorded it so far. */
export interface Turn {
  id: string;
  status: TurnStatus;
  /** The user text the turn was admitted with; `""` until `message.received` is seen. */
  input: string;
  /** The turn's messages, in log order. */
  messages: AgentMessage[];
  /** Tool calls in the order they started. */
  toolCalls: ToolCall[];
  /** The output of the result tool's call, from `tool.completed` with `data.result`. */
  result?: DataValue;
  failure?: TurnFailure;
}

/** What the timeline keeps per turn; `Turn` adds the messages. */
export interface TurnRecord {
  id: string;
  status: TurnStatus;
  input: string;
  toolCalls: ToolCall[];
  result?: DataValue;
  failure?: TurnFailure;
  /** The `seq` of the first event that named the turn; orders the turns. */
  seq: number;
}

export interface SessionTimeline {
  messages: AgentMessage[];
  memorySaves: MemorySave[];
  /** The highest `seq` applied so far. */
  cursor: number;
  /** Every turn the log has recorded, by id, as of the cursor. */
  turns: Record<string, TurnRecord>;
  isRunning: boolean;
  ended: boolean;
}

export function emptyTimeline(): SessionTimeline {
  return {
    messages: [],
    memorySaves: [],
    cursor: 0,
    turns: {},
    isRunning: false,
    ended: false,
  };
}

/** Whether the log has settled the turn: completed, failed or cancelled. */
export function isSettledTurn(
  timeline: SessionTimeline,
  turnId: string,
): boolean {
  const status = timeline.turns[turnId]?.status;
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** The turns of a timeline in log order, each with its messages. */
export function turnsOf(timeline: SessionTimeline): Turn[] {
  return Object.values(timeline.turns)
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq: _seq, ...record }) => ({
      ...record,
      messages: timeline.messages.filter((message) => message.turnId === record.id),
    }));
}

/** The id of the user message that starts a turn; `send` uses the same id, so the event upserts it. */
export function inputMessageId(turnId: string): string {
  return `turn:${turnId}:input`;
}

function replyMessageId(event: AgentEvent): string {
  return event.turnId ? `turn:${event.turnId}:reply` : `event:${String(event.seq)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function data(value: unknown): DataValue | undefined {
  return value === undefined ? undefined : (value as DataValue);
}

/** The save a `memory.saved` event reports; undefined for any other event. */
export function memorySaveFromEvent(event: AgentEvent): MemorySave | undefined {
  if (event.type !== "memory.saved") return undefined;
  const fields = event.data ?? {};
  return {
    seq: event.seq,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    resource: text(fields.resource),
    documentId: text(fields.documentId),
    revision: text(fields.revision),
    bytes: typeof fields.bytes === "number" ? fields.bytes : 0,
  };
}

function upsert(
  messages: AgentMessage[],
  message: AgentMessage,
): AgentMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = { ...next[index], ...message };
  return next;
}

function upsertToolCall(calls: ToolCall[], call: ToolCall): ToolCall[] {
  const index = calls.findIndex((candidate) => candidate.callId === call.callId);
  if (index < 0) return [...calls, call];
  const next = [...calls];
  next[index] = { ...next[index], ...call };
  return next;
}

function toolCallId(event: AgentEvent): string {
  const callId = event.data?.callId;
  return typeof callId === "string" && callId ? callId : `event:${String(event.seq)}`;
}

/**
 * Applies one event to the turn records: the turn it names is created on
 * first sight and moved along its lifecycle; tool events attach to it. Pure,
 * and shared by attach mode (through `applyEvent`) and create mode.
 */
export function applyTurnEvent(
  turns: Record<string, TurnRecord>,
  event: AgentEvent,
): Record<string, TurnRecord> {
  const turnId = event.turnId;
  if (!turnId) return turns;
  const fields = event.data ?? {};
  const current: TurnRecord = turns[turnId] ?? {
    id: turnId,
    status: "queued",
    input: "",
    toolCalls: [],
    seq: event.seq,
  };
  let next: TurnRecord;
  switch (event.type) {
    case "message.received":
      next = { ...current, input: text(fields.input) };
      break;
    case "turn.queued":
      next = { ...current, status: "queued" };
      break;
    case "turn.started":
      next = { ...current, status: "running" };
      break;
    case "turn.completed":
      next = { ...current, status: "completed" };
      break;
    case "turn.failed":
      next = {
        ...current,
        status: "failed",
        failure: { code: text(fields.code) || "agent_failed", message: text(fields.message) },
      };
      break;
    case "turn.cancelled":
      next = { ...current, status: "cancelled" };
      break;
    case "tool.started": {
      const tool = text(fields.tool);
      next = {
        ...current,
        toolCalls: upsertToolCall(current.toolCalls, {
          callId: toolCallId(event),
          tool,
          title: text(fields.title) || tool,
          ...(fields.input !== undefined ? { input: data(fields.input) } : {}),
          status: "running",
        }),
      };
      break;
    }
    case "tool.completed": {
      const tool = text(fields.tool);
      const callId = toolCallId(event);
      const started = current.toolCalls.find((call) => call.callId === callId);
      next = {
        ...current,
        toolCalls: upsertToolCall(current.toolCalls, {
          callId,
          tool: tool || started?.tool || "",
          title: text(fields.title) || started?.title || tool,
          ...(fields.output !== undefined ? { output: data(fields.output) } : {}),
          status: "completed",
        }),
        ...(fields.result === true ? { result: data(fields.output) ?? null } : {}),
      };
      break;
    }
    case "tool.failed": {
      const tool = text(fields.tool);
      const callId = toolCallId(event);
      const started = current.toolCalls.find((call) => call.callId === callId);
      next = {
        ...current,
        toolCalls: upsertToolCall(current.toolCalls, {
          callId,
          tool: tool || started?.tool || "",
          title: text(fields.title) || started?.title || tool,
          status: "failed",
        }),
      };
      break;
    }
    default:
      if (turns[turnId]) return turns;
      next = current;
  }
  return { ...turns, [turnId]: next };
}

/**
 * Applies one event. Events at or below the cursor are ignored, so a page
 * that overlaps an earlier one is harmless.
 */
export function applyEvent(
  timeline: SessionTimeline,
  event: AgentEvent,
): SessionTimeline {
  if (event.seq <= timeline.cursor) return timeline;
  const next: SessionTimeline = {
    ...timeline,
    cursor: event.seq,
    turns: applyTurnEvent(timeline.turns, event),
  };
  const fields = event.data ?? {};
  switch (event.type) {
    case "message.received": {
      next.messages = upsert(timeline.messages, {
        id: event.turnId ? inputMessageId(event.turnId) : `event:${String(event.seq)}`,
        role: "user",
        text: text(fields.input),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      });
      return next;
    }
    case "turn.started":
      next.isRunning = true;
      return next;
    case "message.delta": {
      const id = replyMessageId(event);
      const existing = timeline.messages.find((message) => message.id === id);
      next.messages = upsert(timeline.messages, {
        id,
        role: "assistant",
        text: (existing?.text ?? "") + text(fields.text),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        streaming: true,
      });
      return next;
    }
    case "message.completed": {
      next.messages = upsert(timeline.messages, {
        id: replyMessageId(event),
        role: "assistant",
        text: text(fields.text),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        streaming: false,
      });
      return next;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled":
      next.isRunning = false;
      next.messages = timeline.messages.map((message) =>
        message.streaming && message.turnId === event.turnId
          ? { ...message, streaming: false }
          : message,
      );
      return next;
    case "memory.saved": {
      const save = memorySaveFromEvent(event);
      if (save) next.memorySaves = [...timeline.memorySaves, save];
      return next;
    }
    case "session.ended":
      next.isRunning = false;
      next.ended = true;
      return next;
    case "session.failed":
    case "runtime.disconnected":
      next.isRunning = false;
      return next;
    default:
      return next;
  }
}

export function applyEvents(
  timeline: SessionTimeline,
  events: readonly AgentEvent[],
): SessionTimeline {
  return events.reduce(applyEvent, timeline);
}

/** The message a failed turn or a lost runtime reports, if the event carries one. */
export function failureMessage(event: AgentEvent): string | undefined {
  if (
    event.type !== "turn.failed" &&
    event.type !== "session.failed" &&
    event.type !== "runtime.disconnected"
  ) {
    return undefined;
  }
  const fields = event.data ?? {};
  const message = text(fields.message) || text(fields.reason);
  return message || `${event.type.replace(".", " ")}`;
}
