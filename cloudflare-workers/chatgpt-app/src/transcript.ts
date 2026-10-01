import type { Session, SessionEvent, Turn } from "@opencomputer/sdk/agents";

const TERMINAL_TURN = new Set(["completed", "failed", "cancelled"]);
const MAX_TEXT = 8000;

export interface TranscriptTurn {
  id: string;
  input: string;
  status: string;
  reply: string;
  tools: string[];
  error?: string;
}

export interface SessionView {
  session: {
    id: string;
    agentId: string;
    environment: string | null;
    status: string;
    result: unknown;
  };
  turns: TranscriptTurn[];
  /** True while any turn is still queued or running. */
  running: boolean;
  /** Turns before the ones shown. */
  omittedTurns: number;
}

export const isTerminalTurn = (turn: Pick<Turn, "status">): boolean => TERMINAL_TURN.has(turn.status);

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

export function buildSessionView(session: Session, events: SessionEvent[], maxTurns = 10): SessionView {
  const byTurn = new Map<string, { replies: string[]; tools: string[]; error?: string }>();
  const entry = (turnId: string) => {
    let value = byTurn.get(turnId);
    if (!value) byTurn.set(turnId, (value = { replies: [], tools: [] }));
    return value;
  };
  const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
  for (const event of events) {
    if (!event.turnId) continue;
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "message.completed") {
      const reply = text(data.text);
      if (reply) entry(event.turnId).replies.push(reply);
    } else if (event.type === "tool.started") {
      const tool = text(data.title) ?? text(data.tool);
      if (tool) entry(event.turnId).tools.push(tool);
    } else if (event.type === "turn.failed") {
      entry(event.turnId).error = text(data.message) ?? "The turn failed.";
    }
  }
  const turns = session.turns ?? [];
  const shown = turns.slice(-maxTurns);
  return {
    session: {
      id: session.id,
      agentId: session.agentId,
      environment: session.environment ?? null,
      status: session.status,
      result: session.result?.data ?? null,
    },
    turns: shown.map((turn) => {
      const details = byTurn.get(turn.id);
      return {
        id: turn.id,
        input: clip(turn.input),
        status: turn.status,
        reply: clip((details?.replies ?? []).join("\n\n")),
        tools: [...new Set(details?.tools ?? [])],
        ...(details?.error ? { error: details.error } : {}),
      };
    }),
    running: turns.some((turn) => !isTerminalTurn(turn)),
    omittedTurns: turns.length - shown.length,
  };
}

/** A plain-text rendering for the model, alongside the structured view. */
export function describeSessionView(view: SessionView): string {
  const lines = [`Session ${view.session.id} (agent ${view.session.agentId}) is ${view.session.status}.`];
  const last = view.turns.at(-1);
  if (last) {
    if (last.reply) lines.push(`Agent reply:\n${last.reply}`);
    if (last.error) lines.push(`The turn failed: ${last.error}`);
    if (!isTerminalTurn(last)) {
      lines.push(`The latest turn is still ${last.status}; call get_session with this session id to read the reply when it finishes.`);
    }
  }
  if (view.session.result !== null) lines.push(`Session result: ${clip(JSON.stringify(view.session.result))}`);
  return lines.join("\n\n");
}
