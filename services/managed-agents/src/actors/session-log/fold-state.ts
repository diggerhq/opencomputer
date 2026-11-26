// What the fold keeps: its scalar state, and the records it reads and writes through a FoldStore.

import type { Actor, Ask, SessionContext, SessionSettings, SessionStatus, Subagent, Turn, TurnSummary, TurnUsage } from "../../api-objects/objects.js";

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
  /** seq of the newest top-level `message.completed`, `ask.opened`, `turn.completed` or `turn.failed` (absent in state folded before it). */
  lastAgentSeq?: number;
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
