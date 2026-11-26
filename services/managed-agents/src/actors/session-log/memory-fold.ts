// The fold over a whole log in memory (tests, the Computer DO, a rebuild), and its in-memory FoldStore.

import type { ApiEvent, Ask, LogSummary, Subagent, Turn } from "../../api-objects/objects.js";
import { applyEvent } from "./fold.js";
import { initialFoldState, type AskRecord, type FoldState, type FoldStore, type OpenToolCall, type SubagentRecord, type TurnRecord } from "./fold-state.js";
import { summarize, type LogPosition } from "./summary.js";
import { publicTurn } from "./turns.js";

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
