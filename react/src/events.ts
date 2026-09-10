// The durable session event log as the hook reads it, and the pure reduction
// of that log into what a chat renders. No React and no network here: the
// same function replays history and applies live events, so a reconnect that
// resumes from a cursor produces the same messages as an uninterrupted stream.

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

export interface SessionTimeline {
  messages: AgentMessage[];
  memorySaves: MemorySave[];
  /** The highest `seq` applied so far. */
  cursor: number;
  isRunning: boolean;
  ended: boolean;
}

export function emptyTimeline(): SessionTimeline {
  return {
    messages: [],
    memorySaves: [],
    cursor: 0,
    isRunning: false,
    ended: false,
  };
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

/** The save a `memory.saved` event reports; undefined for any other event. */
export function memorySaveFromEvent(event: AgentEvent): MemorySave | undefined {
  if (event.type !== "memory.saved") return undefined;
  const data = event.data ?? {};
  return {
    seq: event.seq,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    resource: text(data.resource),
    documentId: text(data.documentId),
    revision: text(data.revision),
    bytes: typeof data.bytes === "number" ? data.bytes : 0,
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

/**
 * Applies one event. Events at or below the cursor are ignored, so a page
 * that overlaps an earlier one is harmless.
 */
export function applyEvent(
  timeline: SessionTimeline,
  event: AgentEvent,
): SessionTimeline {
  if (event.seq <= timeline.cursor) return timeline;
  const next: SessionTimeline = { ...timeline, cursor: event.seq };
  const data = event.data ?? {};
  switch (event.type) {
    case "message.received": {
      next.messages = upsert(timeline.messages, {
        id: event.turnId ? inputMessageId(event.turnId) : `event:${String(event.seq)}`,
        role: "user",
        text: text(data.input),
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
        text: (existing?.text ?? "") + text(data.text),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        streaming: true,
      });
      return next;
    }
    case "message.completed": {
      next.messages = upsert(timeline.messages, {
        id: replyMessageId(event),
        role: "assistant",
        text: text(data.text),
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
  const data = event.data ?? {};
  const message = text(data.message) || text(data.reason);
  return message || `${event.type.replace(".", " ")}`;
}
