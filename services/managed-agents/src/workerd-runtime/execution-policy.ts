export type ToolExecution = "sandbox" | "edge";

export interface ToolExecutionHandlers<Result> {
  edge(): Result | Promise<Result>;
  sandbox(): Result | Promise<Result>;
}

/**
 * Artifact admission validates authored values. Runtime resolution still
 * fails closed so an older or malformed artifact cannot run tool code in the
 * session Durable Object by accident.
 */
export function resolveToolExecution(value: unknown): ToolExecution {
  return value === "edge" ? "edge" : "sandbox";
}

/** All tool calls, including calls made by another tool, enter this seam. */
export function dispatchToolExecution<Result>(
  execution: unknown,
  handlers: ToolExecutionHandlers<Result>,
): Promise<Result> {
  return Promise.resolve(
    resolveToolExecution(execution) === "edge"
      ? handlers.edge()
      : handlers.sandbox(),
  );
}

