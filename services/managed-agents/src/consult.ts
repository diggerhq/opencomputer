// The `consult` harness tool's contract (project sessions): shared by the
// Workerd host, which validates and records a call, and the Session object,
// which commits the consultation, dispatches it to the member agent's own
// session and admits its answer. Pure: nothing here touches storage.

import {
  CONSULT_AGENT_LIMIT,
  CONSULT_PROMPT_LIMIT,
  CONSULT_TOOL,
  type ConsultInput,
} from "./protocol.js";

export { CONSULT_TOOL };

/** What the model reads about the tool. */
export const CONSULT_TOOL_DESCRIPTION = [
  "Ask another agent of this project a question and end this turn. Use it for what a sibling agent owns: its data, its tools, its ongoing work.",
  "The turn ends as soon as the call returns: do not call other tools after it and do not write a final answer.",
  "The agent's answer arrives as the next input, with any messages the person wrote meanwhile. The agent keeps its own session inside this project, so a later consult continues where it left off.",
].join(" ");

export const CONSULT_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      minLength: 1,
      maxLength: CONSULT_AGENT_LIMIT,
      description:
        "The project agent to consult: its local name within the project or its full agent id.",
    },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: CONSULT_PROMPT_LIMIT,
      description: "The question or task for that agent, as it should read it.",
    },
  },
  required: ["agent", "prompt"],
  additionalProperties: false,
};

/** The consult call after validation: what is persisted and dispatched. */
export interface ValidatedConsult {
  agent: string;
  prompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

/**
 * Validates a `consult` call against the bounds: `agent` 1–120 characters,
 * `prompt` 1–8000. The message of a refusal is written for the model, which
 * may call again.
 */
export function parseConsultInput(
  value: unknown,
): { ok: true; input: ValidatedConsult } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "consult expects an object with agent and prompt" };
  }
  const extra = Object.keys(value).filter((key) => key !== "agent" && key !== "prompt");
  if (extra.length) {
    return {
      ok: false,
      message: `consult does not accept ${extra.map((key) => JSON.stringify(key)).join(", ")}`,
    };
  }
  if (!boundedString(value.agent, CONSULT_AGENT_LIMIT)) {
    return {
      ok: false,
      message: `consult agent must be 1 to ${String(CONSULT_AGENT_LIMIT)} characters`,
    };
  }
  if (!boundedString(value.prompt, CONSULT_PROMPT_LIMIT)) {
    return {
      ok: false,
      message: `consult prompt must be 1 to ${String(CONSULT_PROMPT_LIMIT)} characters`,
    };
  }
  return { ok: true, input: { agent: value.agent, prompt: value.prompt } };
}

/** The same check for a value already persisted (host event, stored row). */
export function isConsultInput(value: unknown): value is ConsultInput {
  return parseConsultInput(value).ok;
}

/**
 * The deterministic id of the inner session a consultation runs on: one per
 * (host session, member agent), so a second consult of the same agent
 * continues the same context.
 */
export function consultSessionId(hostSessionId: string, memberAgentId: string): string {
  return `consult:${hostSessionId}:${memberAgentId}`;
}

/**
 * The text of the consult answer the host session admits — the coordinator
 * reads this as its question's answer. `finalText` is the member turn's last
 * assistant message; a member that failed, was cancelled or asked reports
 * that outcome instead.
 */
export function consultAnswerText(
  memberAgentId: string,
  outcome:
    | { kind: "completed"; finalText: string }
    | { kind: "failed"; error: string }
    | { kind: "cancelled"; reason: string | null }
    | { kind: "question"; text: string }
    | { kind: "unavailable"; detail: string },
): string {
  switch (outcome.kind) {
    case "completed":
      return `Agent ${memberAgentId} answered:\n${outcome.finalText}`;
    case "failed":
      return `Agent ${memberAgentId} could not answer: the turn failed (${outcome.error}).`;
    case "cancelled":
      return `Agent ${memberAgentId} could not answer: the turn was cancelled${
        outcome.reason ? ` (${outcome.reason})` : ""
      }.`;
    case "question":
      return `Agent ${memberAgentId} ended its turn by asking a question of its own:\n${outcome.text}`;
    case "unavailable":
      return `Agent ${memberAgentId} could not be consulted: ${outcome.detail}.`;
  }
}
