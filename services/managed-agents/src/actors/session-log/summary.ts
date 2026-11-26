// The LogSummary of a fold, and where the log is.

import type { Ask, LogSummary, Subagent, Turn } from "../../api-objects/objects.js";
import type { FoldState } from "./fold-state.js";

export interface LogPosition {
  lastSeq: number;
  logEpoch: number;
  epochStartSeq: number;
  syncedAt: string | null;
}

/** A LogSummary, and what the summary Org receives adds from the fold (spec 35.2). */
export type FoldSummary = LogSummary & { lastAgentSeq: number };

/** The LogSummary from the fold state, the queued turns (run order), the open asks and running subagents (oldest first). */
export function summarize(state: FoldState, queued: Turn[], openAsks: Ask[], subagents: Subagent[], position: LogPosition): FoldSummary {
  return {
    lastAgentSeq: state.lastAgentSeq ?? 0,
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
