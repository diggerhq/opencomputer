import { readFileSync } from "node:fs";

/** The platform's limit for a turn payload and for session data: 32 KiB of JSON. */
export const STRUCTURED_INPUT_LIMIT = 32 * 1024;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SessionData = { [key: string]: JsonValue };

/**
 * Takes `<flag> <path>` or `<flag>=<path>` out of `args` and returns the
 * path; `undefined` when the flag is absent.
 */
export function takeValueOption(args: string[], flag: string): string | undefined {
  const equalsIndex = args.findIndex((argument) => argument.startsWith(`${flag}=`));
  if (equalsIndex >= 0) {
    const value = args[equalsIndex]!.slice(flag.length + 1);
    if (!value) throw new Error(`${flag} requires a value`);
    args.splice(equalsIndex, 1);
    return value;
  }
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

function parseJson(text: string, flag: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${flag} must name a file holding JSON: ${(error as Error).message}`);
  }
  if (value === undefined) throw new Error(`${flag} must name a file holding JSON`);
  return value as JsonValue;
}

function readBounded(path: string, flag: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${flag}: cannot read ${path}: ${(error as Error).message}`);
  }
  if (Buffer.byteLength(text, "utf8") > STRUCTURED_INPUT_LIMIT) {
    throw new Error(`${flag}: ${path} exceeds ${STRUCTURED_INPUT_LIMIT / 1024} KiB of JSON`);
  }
  return text;
}

/**
 * The turn payload from `--payload-file`: any JSON value, at most 32 KiB.
 * `null` and empty objects or arrays are refused because the platform does
 * not admit a payload-only turn with an empty payload.
 */
export function readPayloadFile(path: string): JsonValue {
  const flag = "--payload-file";
  const value = parseJson(readBounded(path, flag), flag);
  if (
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  ) {
    throw new Error(`${flag}: the payload must not be empty`);
  }
  return value;
}

/** The session data from `--session-data-file`: a JSON object, at most 32 KiB. */
export function readSessionDataFile(path: string): SessionData {
  const flag = "--session-data-file";
  const value = parseJson(readBounded(path, flag), flag);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${flag}: session data must be a JSON object`);
  }
  if (Object.keys(value).length === 0) {
    throw new Error(`${flag}: session data must not be empty`);
  }
  return value;
}

export type ResultsCommand =
  | { action: "list"; sessionId: string; turnId?: string; cursor?: string; limit?: number }
  | { action: "get"; sessionId: string; resultId: string };

/**
 * `results list <session-id> [--turn <turn-id>] [--cursor <cursor>] [--limit <n>]`
 * and `results get <session-id> <result-id>`.
 */
export function parseResultsCommand(rawArgs: string[]): ResultsCommand {
  const args = [...rawArgs];
  const action = args.shift();
  if (action === "list") {
    const turnId = takeValueOption(args, "--turn");
    const cursor = takeValueOption(args, "--cursor");
    const limitValue = takeValueOption(args, "--limit");
    const sessionId = args.shift();
    if (!sessionId) throw new Error("A session ID is required.");
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    let limit: number | undefined;
    if (limitValue !== undefined) {
      limit = Number.parseInt(limitValue, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new Error("--limit must be an integer from 1 to 200");
      }
    }
    return {
      action,
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }
  if (action === "get") {
    const sessionId = args.shift();
    const resultId = args.shift();
    if (!sessionId || !resultId) {
      throw new Error("Usage: opencomputer results get <session-id> <result-id>");
    }
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    return { action, sessionId, resultId };
  }
  throw new Error(
    "Usage: opencomputer results list <session-id> [--turn <turn-id>] [--cursor <cursor>] [--limit <n>] | results get <session-id> <result-id>",
  );
}
