// Reading the fields of an event's data: typed field readers, and the Subagent and Ask an event carries.

import type { Actor, Ask, Subagent, SubagentStatus, TurnError } from "../../api-objects/objects.js";
import { SYSTEM_ACTOR } from "./system-actor.js";

export type Data = Record<string, unknown>;

export const obj = (value: unknown): Data => (value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {});
export const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
export const int = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
export const actorOf = (value: unknown): Actor | null => {
  const a = obj(value);
  return typeof a.id === "string" ? (a as unknown as Actor) : null;
};

/** A person's Actor (never the system's); a bare member id from an older writer becomes a minimal one. */
export const personOf = (value: unknown): Actor | null => {
  if (typeof value === "string") return value === SYSTEM_ACTOR.id ? null : ({ id: value, name: null, via: "api", client: null } as unknown as Actor);
  const a = actorOf(value);
  return a && a.id !== SYSTEM_ACTOR.id && a.via !== "system" ? a : null;
};

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
