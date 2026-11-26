// Turns: a new one, its usage sum, its summary and its public form.

import type { Actor, Turn, TurnStatus, TurnSummary, TurnUsage } from "../../api-objects/objects.js";
import { addDecimal } from "./decimal.js";
import { int, str, type Data } from "./event-data.js";
import type { TurnRecord } from "./fold-state.js";

export const TURN_ENDINGS = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
export const ENDED_TURN_STATUSES = new Set<TurnStatus>(["completed", "failed", "cancelled"]);

export function newTurn(sessionId: string, id: string, createdAt: string, input: string | null, ifBusy: string, author: Actor | null): Turn {
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

export function addUsage(sum: TurnUsage | null, data: Data): TurnUsage {
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
