import { Validator, type Schema } from "@cfworker/json-schema";

import {
  SESSION_RESULT_DATA_LIMIT,
  type JsonValue,
  type ResultCommitInput,
  type ResultCommitOutcome,
  type ResultCommitReceipt,
  type ResultCommitRejection,
  type RuntimeGeneration,
} from "../protocol.js";

/**
 * The typed session result, host side (C1). Shared by the two places a
 * code-defined tool runs for a managed session: the Workerd host, which
 * escalates the tool to its sandbox and returns the content to the model,
 * and the MicroVM runtime, where the tool runs inside OpenCode's process.
 * Both do the same thing for the agent's result tool: validate the value
 * against the output schema the deployment pinned, commit it to the
 * Session object under `(turnId, callId)`, and tell the model success only
 * once the commit is acknowledged. Everything here is platform-neutral:
 * `fetch`, the validator and nothing from Node.
 */

/** The result tool as the deployment manifest records it: its id and the pinned output schema. */
export interface ResultToolManifest {
  id: string;
  output: Record<string, unknown>;
}

/**
 * A definite refusal. The tool call fails with this message, which the
 * model sees, and the session's previous result stands.
 */
export class ResultRejectedError extends Error {
  constructor(
    readonly reason: ResultCommitRejection | "invalid_output",
    message: string,
  ) {
    super(message);
    this.name = "ResultRejectedError";
  }
}

/**
 * The commit request did not get an answer: the network failed or the
 * edge answered 5xx. Whether the Session object applied it is unknown, so
 * the caller retries under the same key; the receipt resolves it.
 */
export class ResultCommitTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultCommitTransportError";
  }
}

/** Every retry failed: the tool call fails and the outcome of the commit is unknown to the model. */
export class ResultCommitUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultCommitUnconfirmedError";
  }
}

export type ResultCommitter = (
  input: ResultCommitInput,
) => Promise<ResultCommitOutcome>;

const REJECTIONS: ReadonlySet<string> = new Set<ResultCommitRejection>([
  "stale_turn",
  "stale_runtime",
  "result_conflict",
  "result_too_large",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validates a result tool's returned value against its pinned output schema. */
export function validateResultOutput(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: true } | { valid: false; message: string } {
  const result = new Validator(schema as Schema, "2020-12", false).validate(
    value,
  );
  if (result.valid) return { valid: true };
  const detail = result.errors
    .slice(0, 3)
    .map((entry) => `${entry.instanceLocation || "#"}: ${entry.error}`)
    .join("; ");
  return { valid: false, message: detail };
}

/**
 * The committer over the runtime-authenticated session route. A 2xx with a
 * receipt is an acknowledgement, a 409 with a known reason is a definite
 * rejection, any other 4xx is a request the edge will never accept, and
 * everything else is transport uncertainty.
 */
export function sessionResultCommitter(
  edge: string,
  sessionId: string,
  runtimeToken: string,
  fetchImpl: typeof fetch = fetch,
): ResultCommitter {
  const url = `${edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/result`;
  return async (input) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    } catch (error) {
      throw new ResultCommitTransportError(
        `Result commit did not reach the session: ${describe(error)}`,
      );
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (
      response.ok &&
      isRecord(body) &&
      body.status === "committed" &&
      isRecord(body.receipt)
    ) {
      return {
        status: "committed",
        replayed: body.replayed === true,
        receipt: body.receipt as unknown as ResultCommitReceipt,
      };
    }
    const error =
      isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const code = typeof error?.code === "string" ? error.code : undefined;
    if (response.status === 409 && code && REJECTIONS.has(code)) {
      return {
        status: "rejected",
        reason: code as ResultCommitRejection,
        message: typeof error?.message === "string" ? error.message : code,
      };
    }
    if (response.status >= 400 && response.status < 500) {
      throw new Error(
        `Result commit was refused by the session (${response.status}${code ? ` ${code}` : ""})`,
      );
    }
    throw new ResultCommitTransportError(
      `Result commit returned ${response.status}`,
    );
  };
}

export interface ResultCommitRetry {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries transport failures only. The commit is idempotent under its key,
 * so a retry after a lost acknowledgement returns the receipt of the
 * commit that landed rather than committing twice.
 */
export async function commitWithRetry(
  commit: ResultCommitter,
  input: ResultCommitInput,
  retry: ResultCommitRetry = {},
): Promise<ResultCommitOutcome> {
  const attempts = retry.attempts ?? 4;
  const delayMs = retry.delayMs ?? 250;
  const sleep =
    retry.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await commit(input);
    } catch (error) {
      if (!(error instanceof ResultCommitTransportError)) throw error;
      last = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw new ResultCommitUnconfirmedError(
    `The result could not be committed after ${attempts} attempts: ${describe(last)}`,
  );
}

export interface ResultToolExecution {
  tool: ResultToolManifest;
  /** What the tool's `run` returned. */
  value: unknown;
  turnId: string;
  callId: string;
  /** The assistant message that emitted the call, as the host saw it. */
  messageId?: string;
  runtime: RuntimeGeneration;
  commit: ResultCommitter;
  retry?: ResultCommitRetry;
}

/**
 * The commit protocol for one result tool call, in order: the value must
 * be JSON, match the pinned schema and fit the size bound, or the call is
 * rejected before anything is sent; then the commit is awaited, retried
 * through transport uncertainty and refused on a definite rejection. The
 * content returned is what the model receives, and only on success.
 */
export async function commitResultToolOutput(
  input: ResultToolExecution,
): Promise<{
  content: string;
  receipt: ResultCommitReceipt;
  replayed: boolean;
}> {
  const { tool } = input;
  const serialized = JSON.stringify(input.value);
  if (serialized === undefined) {
    throw new ResultRejectedError(
      "invalid_output",
      `Result rejected: ${tool.id} returned a value that is not JSON`,
    );
  }
  // Serialise once so the validated value is the committed one: undefined
  // properties and non-JSON values are gone before validation.
  const data = JSON.parse(serialized) as JsonValue;
  const validation = validateResultOutput(tool.output, data);
  if (!validation.valid) {
    throw new ResultRejectedError(
      "invalid_output",
      `Result rejected: the output of ${tool.id} does not match its output schema (${validation.message})`,
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > SESSION_RESULT_DATA_LIMIT) {
    throw new ResultRejectedError(
      "result_too_large",
      `Result rejected: the output of ${tool.id} exceeds ${SESSION_RESULT_DATA_LIMIT} bytes of JSON`,
    );
  }
  const outcome = await commitWithRetry(
    input.commit,
    {
      turnId: input.turnId,
      callId: input.callId,
      tool: tool.id,
      runtime: input.runtime,
      data,
      ...(input.messageId ? { messageId: input.messageId } : {}),
    },
    input.retry,
  );
  if (outcome.status === "rejected") {
    throw new ResultRejectedError(
      outcome.reason,
      `Result rejected: ${outcome.message}`,
    );
  }
  return {
    content: serialized,
    receipt: outcome.receipt,
    replayed: outcome.replayed,
  };
}
