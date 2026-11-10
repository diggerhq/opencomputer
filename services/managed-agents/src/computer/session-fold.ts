// The session log's fold (work 084): recorded events → Turns, Asks and the LogSummary, with no I/O.
// The SessionLog DO runs it incrementally on every append against its SQL tables (a FoldStore);
// `foldEvents` runs it over an array against memory (tests, the Computer DO, a rebuild).
//
// Event shapes follow the public schema (opc docs/api/reference/events.mdx, the vendored
// computer-api.v1.json). Unknown types, and fields the fold does not use, are ignored.
//
// Turns:
// - `message.received` with delivery `started`/`queued` (or any other) creates its turn, `queued`
//   until `turn.started`; `steered` joins the running turn (`turnId`) as a `steering` entry (one that
//   declined open asks too: those close by their own `ask.closed` with status `declined`).
// - A steered message the turn ends without reading starts a new turn with a new id that has
//   no `message.received` of its own (`turn.queued`/`turn.started` under an unknown id): it takes the
//   oldest such message's input and author, and that message leaves the ended turn's `steering`.
// - `usage.recorded` sums into the turn; `Turn.usage` shows the sum once the turn has ended.
//
// Subagents (subagents.md): `subagent.started {subagent}` / `subagent.ended {subagent}` carry the whole
// object. The stored object's `result` is cut to 8 KiB (`resultTruncated`); the full text stays in the
// `subagent.ended` event (`resultSeq`), where `GET` one reads it. `subagent.progress` is never journaled
// (the SessionLog keeps it in memory) and is ignored here if it shows up.

import type {
  Actor,
  ApiEvent,
  Ask,
  LogSummary,
  SessionContext,
  SessionSettings,
  SessionStatus,
  Steering,
  Subagent,
  SubagentStatus,
  Turn,
  TurnError,
  TurnStatus,
  TurnSummary,
  TurnUsage,
} from "./api-types.js";

export const TURN_ENDINGS = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
export const ENDED_TURN_STATUSES = new Set<TurnStatus>(["completed", "failed", "cancelled"]);
export const LAST_TEXT_CHARS = 200;
/** A Subagent's `result` is inline up to this many UTF-8 bytes. */
export const INLINE_RESULT_BYTES = 8 * 1024;
const ENDED_SUBAGENT_STATUSES = new Set<SubagentStatus>(["completed", "failed", "stopped"]);

/** A turn as stored: the public Turn, the seq that created it (ordering, cursors) and its usage so far. */
export interface TurnRecord {
  turn: Turn;
  seq: number;
  usage: TurnUsage | null;
}

export interface AskRecord {
  ask: Ask;
  /** The seq of its `ask.opened` (ordering, cursors). */
  seq: number;
}

/** A subagent as stored: its result cut to 8 KiB, and where the whole one is. */
export interface SubagentRecord {
  subagent: Subagent;
  /** The seq of its `subagent.started` (or `.ended`, with no start): ordering, cursors. */
  seq: number;
  /** The seq of its `subagent.ended`, or null while it runs. */
  endSeq: number | null;
  /** When `resultTruncated`: the `subagent.ended` event whose data holds the whole result. */
  resultSeq: number | null;
}

/** A `tool.started` with no `tool.completed`/`tool.failed` yet: what recovery settles. */
export interface OpenToolCall {
  callId: string;
  turnId: string | null;
  toolName: string;
  title: string;
  parentCallId: string | null;
  seq: number;
}

/** A steered message not yet known to have been read by its turn. */
export interface PendingMessage {
  turnId: string;
  input: string;
  ifBusy: string;
  author: Actor;
  createdAt: string;
  /** The seq of its `message.received`, which `turn.steered.messageSeq` names (absent in state folded before it). */
  seq?: number;
}

/** The fold's scalar state, small and JSON-serializable (the DO keeps it in its meta row). */
export interface FoldState {
  status: SessionStatus | null;
  title: string | null;
  settings: SessionSettings | null;
  activeTurnId: string | null;
  lastTurn: TurnSummary | null;
  lastText: string | null;
  context: SessionContext;
  lastActiveAt: string | null;
  /** Steered messages of running turns. */
  pending: PendingMessage[];
  /** Messages of the turn that just ended unread: the next turn under an unknown id takes the oldest. */
  orphans: PendingMessage[];
}

/** Where the fold reads and writes turns, asks and open calls. */
export interface FoldStore {
  turn(id: string): TurnRecord | undefined;
  putTurn(record: TurnRecord): void;
  ask(id: string): AskRecord | undefined;
  putAsk(record: AskRecord): void;
  openTool(call: OpenToolCall): void;
  closeTool(callId: string): void;
  subagent(id: string): SubagentRecord | undefined;
  putSubagent(record: SubagentRecord): void;
}

export const SYSTEM_ACTOR: Actor = { id: "system", name: "OpenComputer", via: "system", client: null };

export function initialFoldState(): FoldState {
  return {
    status: null,
    title: null,
    settings: null,
    activeTurnId: null,
    lastTurn: null,
    lastText: null,
    context: { usedTokens: null, windowTokens: null },
    lastActiveAt: null,
    pending: [],
    orphans: [],
  };
}

type Data = Record<string, unknown>;

const obj = (value: unknown): Data => (value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {});
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const actorOf = (value: unknown): Actor | null => {
  const a = obj(value);
  return typeof a.id === "string" ? (a as unknown as Actor) : null;
};

/** A person's Actor (never the system's); a bare member id from an older writer becomes a minimal one. */
const personOf = (value: unknown): Actor | null => {
  if (typeof value === "string") return value === SYSTEM_ACTOR.id ? null : ({ id: value, name: null, via: "api", client: null } as unknown as Actor);
  const a = actorOf(value);
  return a && a.id !== SYSTEM_ACTOR.id && a.via !== "system" ? a : null;
};

function newTurn(sessionId: string, id: string, createdAt: string, input: string | null, ifBusy: string, author: Actor | null): Turn {
  return {
    id,
    sessionId,
    status: "queued",
    trigger: "message",
    subagentId: null,
    ifBusy: ifBusy as Turn["ifBusy"],
    input,
    author,
    steering: [],
    createdAt,
    startedAt: null,
    endedAt: null,
    text: null,
    error: null,
    reason: null,
    forced: null,
    usage: null,
  };
}

function addUsage(sum: TurnUsage | null, data: Data): TurnUsage {
  const base: TurnUsage = sum ?? {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  };
  const cost = str(data.costUsd);
  return {
    inputTokens: base.inputTokens + (int(data.inputTokens) ?? 0),
    outputTokens: base.outputTokens + (int(data.outputTokens) ?? 0),
    reasoningTokens: base.reasoningTokens + (int(data.reasoningTokens) ?? 0),
    cachedTokens: base.cachedTokens + (int(data.cachedTokens) ?? 0),
    cacheWriteTokens: base.cacheWriteTokens + (int(data.cacheWriteTokens) ?? 0),
    costUsd: cost === null ? base.costUsd : addDecimal(base.costUsd, cost),
  };
}

/** Exact decimal-string addition (costUsd is a decimal string; floats would drift). */
export function addDecimal(a: string | null, b: string): string {
  if (a === null) return b;
  const scale = Math.max(fraction(a), fraction(b));
  const total = toScaled(a, scale) + toScaled(b, scale);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}
const fraction = (s: string) => (s.includes(".") ? s.length - s.indexOf(".") - 1 : 0);
function toScaled(s: string, scale: number): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 0n;
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(`${whole}${frac.padEnd(scale, "0")}`);
}

/** `text` cut to at most `max` UTF-8 bytes, on a character boundary. */
export function truncateUtf8(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length * 3 <= max) return { text, truncated: false };
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // back off a continuation byte
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** Every documented Subagent field present, `null`/0 rather than absent. */
export function normalizeSubagent(raw: unknown, sessionId: string, turnId: string | null, createdAt: string): Subagent {
  const a = obj(raw);
  const e = obj(a.error);
  return {
    id: str(a.id) ?? "",
    sessionId: str(a.sessionId) ?? sessionId,
    turnId: str(a.turnId) ?? turnId ?? "",
    callId: str(a.callId),
    name: str(a.name) ?? "",
    agentType: str(a.agentType),
    background: bool(a.background) ?? false,
    status: (str(a.status) ?? "running") as SubagentStatus,
    activity: str(a.activity),
    toolCalls: int(a.toolCalls) ?? 0,
    tokens: int(a.tokens) ?? 0,
    createdAt: str(a.createdAt) ?? createdAt,
    endedAt: str(a.endedAt),
    durationMs: int(a.durationMs),
    result: str(a.result),
    resultTruncated: false,
    error: a.error && typeof a.error === "object" ? ({ ...e, code: str(e.code) ?? "agent_failed", message: str(e.message) ?? "" } as TurnError) : null,
    stoppedBy: personOf(a.stoppedBy),
  };
}

/** Every documented Ask field present, `null` rather than absent. */
export function normalizeAsk(raw: unknown, sessionId: string, turnId: string | null, createdAt: string): Ask {
  const a = obj(raw);
  const kind = (str(a.kind) ?? "question") as Ask["kind"];
  return {
    ...a,
    id: str(a.id) ?? "",
    sessionId: str(a.sessionId) ?? sessionId,
    turnId: str(a.turnId) ?? turnId ?? "",
    kind,
    status: (str(a.status) ?? "open") as Ask["status"],
    createdAt: str(a.createdAt) ?? createdAt,
    closedAt: str(a.closedAt),
    closedBy: actorOf(a.closedBy),
    answer: a.answer ?? null,
    approval: a.approval && typeof a.approval === "object" ? (a.approval as Data) : null,
    question: a.question && typeof a.question === "object" ? (a.question as Data) : null,
    secret: a.secret && typeof a.secret === "object" ? (a.secret as Data) : null,
  };
}

export function turnSummary(turn: Turn): TurnSummary | null {
  if (!ENDED_TURN_STATUSES.has(turn.status) || turn.endedAt === null) return null;
  return {
    id: turn.id,
    status: turn.status as TurnSummary["status"],
    endedAt: turn.endedAt,
    text: turn.text,
    error: turn.error,
    reason: turn.reason,
    forced: turn.forced,
  };
}

/** The public Turn of a record: usage only once it ended. */
export function publicTurn(record: TurnRecord): Turn {
  const ended = ENDED_TURN_STATUSES.has(record.turn.status);
  return ended && record.usage ? { ...record.turn, usage: record.usage } : record.turn;
}

/** Fold one recorded event into `state` and `store`. */
export function applyEvent(state: FoldState, store: FoldStore, sessionId: string, event: ApiEvent): void {
  state.lastActiveAt = event.createdAt;
  const data = obj(event.data);
  const turnId = event.turnId;
  switch (event.type) {
    case "session.created": {
      state.title = str(data.title) ?? state.title;
      const s = obj(data.settings);
      if (data.settings) state.settings = { model: str(s.model), effort: str(s.effort), mode: str(s.mode) ?? "default", speed: str(s.speed) };
      return;
    }
    case "session.updated": {
      const changes = obj(data.changes);
      for (const [field, change] of Object.entries(changes)) {
        const to = obj(change).to;
        if (field === "title") state.title = str(to) ?? state.title;
        else if (field === "settings") {
          const s = obj(to);
          state.settings = { model: str(s.model), effort: str(s.effort), mode: str(s.mode) ?? state.settings?.mode ?? "default", speed: str(s.speed) };
        } else if (field === "model" || field === "effort" || field === "mode" || field === "speed") {
          const current = state.settings ?? { model: null, effort: null, mode: "default", speed: null };
          state.settings = { ...current, [field]: field === "mode" ? (str(to) ?? current.mode) : str(to) };
        }
      }
      return;
    }
    case "session.status_changed": {
      const to = str(data.to);
      if (to) state.status = to as SessionStatus;
      return;
    }
    case "session.compacted": {
      const after = int(data.afterTokens);
      if (after !== null) state.context = { ...state.context, usedTokens: after };
      return;
    }
    case "usage.recorded": {
      state.context = { usedTokens: int(data.usedTokens), windowTokens: int(data.windowTokens) };
      if (turnId) {
        const record = store.turn(turnId);
        if (record) store.putTurn({ ...record, usage: addUsage(record.usage, data) });
      }
      return;
    }
    case "message.received": {
      state.orphans = [];
      if (!turnId) return;
      const input = str(data.input) ?? "";
      const ifBusy = str(data.ifBusy) ?? "queue";
      const author = actorOf(event.actor) ?? SYSTEM_ACTOR;
      const delivery = str(data.delivery);
      const existing = store.turn(turnId);
      if (delivery === "steered" && existing) {
        const steering: Steering = { input, author, createdAt: event.createdAt };
        store.putTurn({ ...existing, turn: { ...existing.turn, steering: [...existing.turn.steering, steering] } });
        state.pending = [...state.pending, { turnId, input, ifBusy, author, createdAt: event.createdAt, seq: event.seq }];
        return;
      }
      if (existing) return;
      store.putTurn({ turn: newTurn(sessionId, turnId, event.createdAt, input, ifBusy, author), seq: event.seq, usage: null });
      return;
    }
    case "turn.steered": {
      // The agent read a steered message: it is the turn's for good. `messageSeq` names it; a writer that predates
      // the field means the oldest one of this turn (calvin takes steering in FIFO order).
      const messageSeq = typeof data.messageSeq === "number" ? data.messageSeq : null;
      const named = messageSeq === null ? -1 : state.pending.findIndex((p) => p.turnId === turnId && p.seq === messageSeq);
      const i = named >= 0 ? named : state.pending.findIndex((p) => p.turnId === turnId);
      if (i >= 0) state.pending = state.pending.filter((_, j) => j !== i);
      return;
    }
    case "turn.queued":
    case "turn.started": {
      if (!turnId) return;
      // `trigger`/`subagentId` from the Turn calvin may send, or top-level; `message`/null when absent.
      const sent = obj(data.turn);
      const trigger = str(sent.trigger) ?? str(data.trigger);
      const subagentId = str(sent.subagentId) ?? str(data.subagentId);
      let record = store.turn(turnId);
      if (!record && trigger !== null && trigger !== "message") {
        // A turn the harness started on its own (a background subagent ended): no message, no orphan.
        record = { turn: newTurn(sessionId, turnId, event.createdAt, null, "queue", null), seq: event.seq, usage: null };
      }
      record ??= adoptOrphan(state, store, sessionId, turnId, event);
      if (trigger !== null) {
        record = {
          ...record,
          turn: {
            ...record.turn,
            trigger,
            subagentId,
            input: trigger === "message" ? record.turn.input : null,
            author: trigger === "message" ? record.turn.author : null,
          },
        };
      }
      if (event.type === "turn.started") {
        record = { ...record, turn: { ...record.turn, status: "running", startedAt: event.createdAt } };
        state.activeTurnId = turnId;
      }
      store.putTurn(record);
      return;
    }
    case "turn.status_changed": {
      const record = turnId ? store.turn(turnId) : undefined;
      const to = str(data.to);
      if (!record || !to) return;
      store.putTurn({ ...record, turn: { ...record.turn, status: to as TurnStatus } });
      return;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      if (!turnId) return;
      const record = store.turn(turnId);
      if (!record) return;
      const turn: Turn = { ...record.turn, endedAt: event.createdAt };
      if (event.type === "turn.completed") {
        turn.status = "completed";
        turn.text = str(data.text);
        if (turn.text !== null) state.lastText = turn.text.slice(0, LAST_TEXT_CHARS);
      } else if (event.type === "turn.failed") {
        turn.status = "failed";
        const e = obj(data.error);
        turn.error = { ...e, code: str(e.code) ?? "agent_failed", message: str(e.message) ?? "" } as TurnError;
      } else {
        turn.status = "cancelled";
        turn.reason = str(data.reason);
        turn.forced = bool(data.forced);
      }
      const ended: TurnRecord = { ...record, turn };
      store.putTurn(ended);
      if (state.activeTurnId === turnId) state.activeTurnId = null;
      state.lastTurn = turnSummary(publicTurn(ended));
      state.orphans = state.pending.filter((p) => p.turnId === turnId);
      state.pending = state.pending.filter((p) => p.turnId !== turnId);
      return;
    }
    case "message.completed": {
      if (data.parentCallId == null) {
        const text = str(data.text);
        if (text !== null) state.lastText = text.slice(0, LAST_TEXT_CHARS);
      }
      return;
    }
    case "tool.started": {
      const callId = str(data.callId);
      if (!callId) return;
      store.openTool({
        callId,
        turnId,
        toolName: str(data.toolName) ?? "",
        title: str(data.title) ?? "",
        parentCallId: str(data.parentCallId),
        seq: event.seq,
      });
      return;
    }
    case "tool.completed":
    case "tool.failed": {
      const callId = str(data.callId);
      if (callId) store.closeTool(callId);
      return;
    }
    case "ask.opened": {
      const ask = normalizeAsk(data.ask, sessionId, turnId, event.createdAt);
      if (!ask.id) return;
      const existing = store.ask(ask.id);
      store.putAsk({ ask, seq: existing?.seq ?? event.seq });
      return;
    }
    case "ask.closed": {
      const closed = normalizeAsk(data.ask, sessionId, turnId, event.createdAt);
      if (!closed.id) return;
      const existing = store.ask(closed.id);
      const base = existing?.ask ?? closed;
      const ask: Ask = {
        ...base,
        status: closed.status === "open" ? "dismissed" : closed.status,
        closedAt: closed.closedAt ?? event.createdAt,
        closedBy: closed.closedBy ?? (closed.status === "interrupted" ? null : actorOf(event.actor)),
        answer: closed.answer,
      };
      store.putAsk({ ask, seq: existing?.seq ?? event.seq });
      return;
    }
    case "subagent.started": {
      const started = normalizeSubagent(data.subagent, sessionId, turnId, event.createdAt);
      if (!started.id) return;
      const existing = store.subagent(started.id);
      if (existing && existing.subagent.status !== "running") return; // a late or resent start never reopens it
      store.putSubagent({ subagent: { ...started, status: "running", endedAt: null, durationMs: null, result: null, resultTruncated: false, error: null, stoppedBy: null }, seq: existing?.seq ?? event.seq, endSeq: null, resultSeq: null });
      return;
    }
    case "subagent.ended": {
      const raw = obj(data.subagent);
      const id = str(raw.id);
      if (!id) return;
      const existing = store.subagent(id);
      // Fields the ended object leaves out keep their started values.
      const ended = normalizeSubagent({ ...existing?.subagent, ...raw }, sessionId, turnId, event.createdAt);
      const base = existing?.subagent ?? ended;
      const status = ENDED_SUBAGENT_STATUSES.has(ended.status) ? ended.status : "failed";
      const endedAt = ended.endedAt ?? event.createdAt;
      const started = Date.parse(base.createdAt);
      const cut = ended.result === null ? { text: null, truncated: false } : truncateUtf8(ended.result, INLINE_RESULT_BYTES);
      const subagent: Subagent = {
        ...base,
        ...ended,
        id: base.id,
        createdAt: base.createdAt,
        turnId: base.turnId || ended.turnId,
        status,
        endedAt,
        durationMs: ended.durationMs ?? (Number.isFinite(started) ? Math.max(0, Date.parse(endedAt) - started) : null),
        result: cut.text,
        resultTruncated: cut.truncated,
        stoppedBy: ended.stoppedBy ?? (status === "stopped" ? personOf(event.actor) : null),
      };
      store.putSubagent({ subagent, seq: existing?.seq ?? event.seq, endSeq: event.seq, resultSeq: cut.truncated ? event.seq : null });
      return;
    }
    default:
      // Includes `subagent.progress`: never journaled; ignored if it is.
      return;
  }
}

function adoptOrphan(state: FoldState, store: FoldStore, sessionId: string, turnId: string, event: ApiEvent): TurnRecord {
  const orphan = state.orphans[0];
  if (!orphan) {
    // No message to adopt: no input and no author (docs: the input or null).
    return { turn: newTurn(sessionId, turnId, event.createdAt, null, "queue", null), seq: event.seq, usage: null };
  }
  state.orphans = state.orphans.slice(1);
  const from = store.turn(orphan.turnId);
  if (from) {
    const i = from.turn.steering.findIndex((s) => s.createdAt === orphan.createdAt && s.input === orphan.input);
    if (i >= 0) store.putTurn({ ...from, turn: { ...from.turn, steering: from.turn.steering.filter((_, j) => j !== i) } });
  }
  return {
    turn: newTurn(sessionId, turnId, orphan.createdAt, orphan.input, orphan.ifBusy, orphan.author),
    seq: event.seq,
    usage: null,
  };
}

export interface LogPosition {
  lastSeq: number;
  logEpoch: number;
  epochStartSeq: number;
  syncedAt: string | null;
}

/** The LogSummary from the fold state, the queued turns (run order), the open asks and running subagents (oldest first). */
export function summarize(state: FoldState, queued: Turn[], openAsks: Ask[], subagents: Subagent[], position: LogPosition): LogSummary {
  return {
    lastSeq: position.lastSeq,
    logEpoch: position.logEpoch,
    epochStartSeq: position.epochStartSeq,
    status: state.status,
    title: state.title,
    settings: state.settings,
    activeTurnId: state.activeTurnId,
    queued,
    asks: openAsks,
    subagents,
    lastTurn: state.lastTurn,
    lastText: state.lastText,
    context: state.context,
    lastActiveAt: state.lastActiveAt,
    syncedAt: position.syncedAt,
  };
}

/** A FoldStore in memory. */
export class MemoryFoldStore implements FoldStore {
  readonly turns = new Map<string, TurnRecord>();
  readonly asks = new Map<string, AskRecord>();
  readonly tools = new Map<string, OpenToolCall>();
  readonly subagents = new Map<string, SubagentRecord>();
  turn(id: string) {
    return this.turns.get(id);
  }
  putTurn(record: TurnRecord) {
    this.turns.set(record.turn.id, record);
  }
  ask(id: string) {
    return this.asks.get(id);
  }
  putAsk(record: AskRecord) {
    this.asks.set(record.ask.id, record);
  }
  openTool(call: OpenToolCall) {
    this.tools.set(call.callId, call);
  }
  closeTool(callId: string) {
    this.tools.delete(callId);
  }
  subagent(id: string) {
    return this.subagents.get(id);
  }
  putSubagent(record: SubagentRecord) {
    this.subagents.set(record.subagent.id, record);
  }
  runningSubagents(): Subagent[] {
    return [...this.subagents.values()].filter((r) => r.subagent.status === "running").sort((a, b) => a.seq - b.seq).map((r) => r.subagent);
  }
  queuedTurns(): Turn[] {
    return [...this.turns.values()].filter((r) => r.turn.status === "queued").sort((a, b) => a.seq - b.seq).map(publicTurn);
  }
  openAsks(): Ask[] {
    return [...this.asks.values()].filter((r) => r.ask.status === "open").sort((a, b) => a.seq - b.seq).map((r) => r.ask);
  }
}

export interface Folded {
  state: FoldState;
  store: MemoryFoldStore;
  summary: LogSummary;
}

/** Fold a whole log (in seq order) in memory. */
export function foldEvents(
  sessionId: string,
  events: Iterable<ApiEvent>,
  position: Partial<LogPosition> = {},
  start: { state?: FoldState; store?: MemoryFoldStore } = {},
): Folded {
  const state = start.state ?? initialFoldState();
  const store = start.store ?? new MemoryFoldStore();
  let lastSeq = position.lastSeq ?? 0;
  for (const event of events) {
    applyEvent(state, store, sessionId, event);
    lastSeq = Math.max(lastSeq, event.seq);
  }
  const summary = summarize(state, store.queuedTurns(), store.openAsks(), store.runningSubagents(), {
    lastSeq,
    logEpoch: position.logEpoch ?? 0,
    epochStartSeq: position.epochStartSeq ?? 1,
    syncedAt: position.syncedAt ?? null,
  });
  return { state, store, summary };
}
