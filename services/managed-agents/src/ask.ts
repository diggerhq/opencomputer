// The `ask` harness tool's contract (design 018, "What the agent writes"),
// shared by the Workerd host, which validates and records a call, and the
// Session object, which commits the question and admits its answer. Pure:
// nothing here touches storage.

import {
  ASK_CONTEXT_LIMIT,
  ASK_OPTION_LIMIT,
  ASK_OPTION_TEXT_LIMIT,
  ASK_TEXT_LIMIT,
  ASK_TOOL,
  type AskInput,
  type QuestionAnswer,
  type QuestionOption,
} from "./protocol.js";

export { ASK_TOOL };

/** What the model reads about the tool. */
export const ASK_TOOL_DESCRIPTION = [
  "Ask the person a question and end this turn. Use it when you need a decision or information only they can give.",
  "The turn ends as soon as the call returns: do not call other tools after it and do not write a final answer.",
  `Their answer arrives as the next input, with any messages they wrote meanwhile. Give up to ${String(ASK_OPTION_LIMIT)} options when the choices are known; they may still answer in their own words.`,
  "Put what the person needs to know to decide (what you found, the trade-offs) in context; it is shown above the question.",
].join(" ");

export const ASK_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: ASK_TEXT_LIMIT,
      description: "The question, as the person will read it.",
    },
    context: {
      type: "string",
      maxLength: ASK_CONTEXT_LIMIT,
      description: "What the person needs to decide, shown above the question (short Markdown).",
    },
    options: {
      type: "array",
      maxItems: ASK_OPTION_LIMIT,
      description: "Optional choices, shown as buttons where the conversation supports them.",
      items: {
        type: "object",
        properties: {
          label: {
            type: "string",
            minLength: 1,
            maxLength: ASK_OPTION_TEXT_LIMIT,
            description: "What the person sees.",
          },
          value: {
            type: "string",
            minLength: 1,
            maxLength: ASK_OPTION_TEXT_LIMIT,
            description: "What a selection sends back.",
          },
        },
        required: ["label", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["text"],
  additionalProperties: false,
};

/** The text of a question after validation: what is persisted and shown. */
export interface ValidatedAsk {
  text: string;
  options: QuestionOption[];
  /** Absent when the call gave none or only whitespace. */
  context?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

/**
 * Validates an `ask` call against the bounds: text 1–4000 characters, at
 * most six options, each label and value 1–80 characters, values distinct,
 * context at most 4000 characters (blank context counts as none). The
 * message of a refusal is written for the model, which may call again.
 */
export function parseAskInput(
  value: unknown,
): { ok: true; input: ValidatedAsk } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "ask expects an object with text" };
  const extra = Object.keys(value).filter(
    (key) => key !== "text" && key !== "options" && key !== "context",
  );
  if (extra.length) {
    return { ok: false, message: `ask does not accept ${extra.map((key) => JSON.stringify(key)).join(", ")}` };
  }
  if (!boundedString(value.text, ASK_TEXT_LIMIT)) {
    return {
      ok: false,
      message: `ask text must be 1 to ${String(ASK_TEXT_LIMIT)} characters`,
    };
  }
  if (
    value.context !== undefined &&
    (typeof value.context !== "string" || value.context.length > ASK_CONTEXT_LIMIT)
  ) {
    return {
      ok: false,
      message: `ask context must be text of at most ${String(ASK_CONTEXT_LIMIT)} characters`,
    };
  }
  const context =
    typeof value.context === "string" && value.context.trim() ? value.context : undefined;
  const options: QuestionOption[] = [];
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length > ASK_OPTION_LIMIT) {
      return {
        ok: false,
        message: `ask options must be a list of at most ${String(ASK_OPTION_LIMIT)}`,
      };
    }
    const values = new Set<string>();
    for (const option of value.options) {
      if (
        !isRecord(option) ||
        Object.keys(option).some((key) => key !== "label" && key !== "value") ||
        !boundedString(option.label, ASK_OPTION_TEXT_LIMIT) ||
        !boundedString(option.value, ASK_OPTION_TEXT_LIMIT)
      ) {
        return {
          ok: false,
          message: `each ask option needs a label and a value of 1 to ${String(ASK_OPTION_TEXT_LIMIT)} characters`,
        };
      }
      if (values.has(option.value)) {
        return { ok: false, message: `ask option values must be distinct (${JSON.stringify(option.value)})` };
      }
      values.add(option.value);
      options.push({ label: option.label, value: option.value });
    }
  }
  return { ok: true, input: { text: value.text, options, ...(context ? { context } : {}) } };
}

/** The same check for a value already persisted (host event, stored row). */
export function isAskInput(value: unknown): value is AskInput {
  return parseAskInput(value).ok;
}

/**
 * A question's id, derived from the turn that asked and the tool call that
 * asked it, so a replayed call names the same question and host recovery
 * cannot ask twice.
 */
export async function questionIdFor(turnId: string, callId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`question\u0000${turnId}\u0000${callId}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `question_${hex.slice(0, 32)}`;
}

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * The answer an input gives: its text, and the option's value when the text
 * matches an option by value or by label (trimmed, case-insensitive; an
 * exact value wins over a label). A selected option arrives from Linear as
 * a prompt whose body is the option's value.
 */
export function answerFor(
  question: { id: string; options: readonly QuestionOption[] },
  text: string,
): QuestionAnswer {
  const wanted = normalize(text);
  const match =
    question.options.find((option) => option.value === text.trim()) ??
    question.options.find((option) => normalize(option.value) === wanted) ??
    question.options.find((option) => normalize(option.label) === wanted);
  return {
    questionId: question.id,
    text,
    ...(match ? { value: match.value } : {}),
  };
}
