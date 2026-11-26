// A session's stored summary (spec 40.1) and what is read from it.

import type { Ask, LogSummary, SessionSettings, SessionStatus } from "../../api-objects/objects.js";
import { DEFAULT_MODE, MODELS } from "../../api-objects/capabilities.js";
import type { Summary } from "../session-log/contract.js";
import type { SessionRec } from "./records.js";
import { parse } from "./parse-json.js";

/** The oldest open ask's id: what `aside` is compared with (as in `session-drain.ts`). */
export function attentionRef(asks: readonly Ask[]): string | null {
  let oldest: Ask | null = null;
  for (const a of asks) if (a.status === "open" && (!oldest || a.createdAt < oldest.createdAt)) oldest = a;
  return oldest?.id ?? null;
}

/** The summary of a session whose log has nothing yet (spec 40.1): `status` null reads as `starting`. */
export function emptySummary(settings: Partial<SessionSettings>, agentTitle: string | null): Summary {
  return {
    lastSeq: 0,
    logEpoch: 1,
    epochStartSeq: 0,
    status: null,
    title: null,
    settings: { model: settings.model ?? MODELS[0]!.id, effort: settings.effort ?? null, mode: settings.mode ?? DEFAULT_MODE, speed: settings.speed ?? null },
    activeTurnId: null,
    queued: [],
    asks: [],
    subagents: [],
    lastTurn: null,
    lastText: null,
    context: { usedTokens: null, windowTokens: null },
    lastActiveAt: null,
    syncedAt: null,
    revision: 0,
    lastAgentSeq: 0,
    agentTitle,
    inbox: [],
  };
}

export const summaryOf = (s: Pick<SessionRec, "summary">): Summary => parse<Summary>(s.summary, emptySummary({}, null));
/** A session is working: a turn is active or it has not answered its first yet. */
export const working = (summary: LogSummary): boolean => summary.status === "running" || summary.status === "starting" || summary.activeTurnId !== null;

/** A session's status; one whose log has not reported yet is starting only while a turn waits. */
export const statusOf = (summary: Summary): SessionStatus => (summary.status as SessionStatus | null) ?? (summary.activeTurnId !== null || (summary.queued?.length ?? 0) > 0 ? "starting" : "idle");
