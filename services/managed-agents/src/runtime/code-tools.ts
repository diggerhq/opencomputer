import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "@opencode-ai/plugin-v2";

import type { RuntimeGeneration, ToolInvocationIdentity } from "../protocol.js";
import { freezeToolInvocationIdentity } from "../tool-identity.js";
import {
  commitResultToolOutput,
  type ResultCommitter,
  type ResultToolManifest,
} from "./session-result.js";

export interface CodeToolExecutionContext {
  readonly input: Record<string, unknown>;
  readonly sessionId: string;
  readonly messageId: string;
  readonly agentId: string;
  /** The harness's id for this tool call; stable across a retried execution. */
  readonly toolCallId: string;
  /**
   * The host-assigned identity of this invocation. Frozen, built from what
   * the host recorded about the session and turn, and never from `input`.
   */
  readonly identity: ToolInvocationIdentity;
  readonly signal?: AbortSignal;
  reportProgress(metadata: Readonly<Record<string, unknown>>): Promise<void>;
}

/**
 * The context a tool's `run` or `apply` receives: the host identity, the
 * same ids at top level for tools written against them, and the model's
 * input last so that a field of it named like one of them stays inside
 * `input`.
 */
export function codeToolContext(
  identity: ToolInvocationIdentity,
  input: unknown,
  rest: {
    signal?: AbortSignal;
    reportProgress: CodeToolExecutionContext["reportProgress"];
  },
): CodeToolExecutionContext {
  const frozen = freezeToolInvocationIdentity(identity);
  return {
    ...rest,
    identity: frozen,
    sessionId: frozen.sessionId,
    messageId: frozen.messageId,
    agentId: frozen.agentId,
    toolCallId: frozen.toolCallId,
    input: isRecord(input) ? input : {},
  };
}

export interface CodeToolDefinition {
  /**
   * A gated tool is a tool: the model calls it the same way, and its `run`
   * records a proposal instead of writing. What makes it different is `apply`,
   * which the platform dispatches after a human decides — so this reader has
   * to admit the second kind or the model never sees the tool at all.
   */
  readonly kind: "tool" | "gated-tool";
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly output?: Readonly<Record<string, unknown>>;
  /** Set by `defineTool({ result: true })`; the manifest's `resultTool` is the pinned record. */
  readonly result?: true;
  run(context: CodeToolExecutionContext): unknown | Promise<unknown>;
  /** Present only on a gated tool. Runs once, after approval. */
  apply?(
    context: CodeToolExecutionContext & {
      readonly decision: Readonly<{
        id: string;
        decidedAt: string;
        decidedBy?: string;
      }>;
    },
  ): unknown | Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCodeTool(value: unknown): value is CodeToolDefinition {
  return (
    isRecord(value) &&
    (value.kind === "tool" || value.kind === "gated-tool") &&
    (value.kind === "tool" || typeof value.apply === "function") &&
    value.version === 1 &&
    typeof value.id === "string" &&
    !!value.id &&
    value.name === value.id &&
    typeof value.description === "string" &&
    !!value.description &&
    (value.input === undefined || isRecord(value.input)) &&
    (value.output === undefined || isRecord(value.output)) &&
    (value.result === undefined || value.result === true) &&
    typeof value.run === "function"
  );
}

/**
 * How the result tool commits in the MicroVM runtime (C1). The tool runs
 * inside OpenCode's process; the managed turn and runtime epoch it belongs
 * to are read when the call is dispatched, before `run`, from what the
 * harness recorded, travel with the call, and fence the commit that goes
 * to the Session object before the model is told success. Nothing is read
 * back after `run`: a call held past its turn commits under the turn that
 * dispatched it (which the Session object refuses as stale), never under
 * whatever turn the harness moved on to.
 */
export interface CodeToolResultOptions {
  tool: ResultToolManifest;
  /** The managed turn being executed and the runtime's attachment epoch, as recorded at dispatch. */
  turn(): Promise<{ turnId: string; runtime: RuntimeGeneration }>;
  commit: ResultCommitter;
}

/** What the runtime adds to the artifact's tools when it registers them. */
export interface CodeToolRegistration {
  /**
   * Which of the artifact's tools the manifest says are gated. Checked against
   * what each module exports; see `loadCodeTools`.
   */
  gated?: ReadonlySet<string>;
  /**
   * Tools the runtime supplies rather than the artifact. Added in this same
   * transform: a second, separate `tool.transform` did not survive, and its
   * tools never reached the model.
   */
  extra?: ReadonlyArray<Record<string, unknown>>;
  /** The result tool's commit path (C1); absent when the agent names none. */
  result?: CodeToolResultOptions;
  /**
   * The host identity of a call, resolved at dispatch from what the host
   * recorded (session, turn) and what the harness reports for the call
   * (message, call id). Refuses the call when no managed turn is recorded.
   */
  identity(call: {
    messageId: string;
    toolCallId: string;
  }): Promise<ToolInvocationIdentity>;
}

export async function loadCodeTools(
  manifestPath: string,
  entries: readonly string[],
  registered: ReadonlySet<string>,
  /**
   * Which of them the manifest says are gated. Checked against what the module
   * actually exports, so a tool that is gated in one and not the other fails
   * at load instead of quietly writing without asking.
   */
  gated?: ReadonlySet<string>,
): Promise<CodeToolDefinition[]> {
  const definitions: CodeToolDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = resolve(dirname(manifestPath), entry);
    const module = (await import(pathToFileURL(path).href)) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(module)) {
      if (!isCodeTool(value)) continue;
      if (!registered.has(value.id)) {
        throw new Error(
          `Tool module ${JSON.stringify(entry)} exported unregistered tool ${JSON.stringify(value.id)}`,
        );
      }
      if (seen.has(value.id)) {
        throw new Error(`Tool ${JSON.stringify(value.id)} is defined more than once`);
      }
      if (gated) {
        const declaredGated = gated.has(value.id);
        const isGated = value.kind === "gated-tool";
        if (declaredGated !== isGated) {
          throw new Error(
            declaredGated
              ? `Tool ${JSON.stringify(value.id)} is declared gated but does not wait for approval`
              : `Tool ${JSON.stringify(value.id)} waits for approval but is not declared gated`,
          );
        }
      }
      seen.add(value.id);
      definitions.push(value);
    }
  }
  return definitions.sort((left, right) => left.id.localeCompare(right.id));
}

export async function registerCodeTools(
  context: Plugin.Context,
  manifestPath: string,
  entries: readonly string[],
  registered: ReadonlySet<string>,
  options: CodeToolRegistration,
): Promise<void> {
  const { gated, extra = [], result, identity } = options;
  const definitions = await loadCodeTools(
    manifestPath,
    entries,
    registered,
    gated,
  );
  await context.tool.transform((tools) => {
    for (const tool of extra) {
      tools.add(tool as Parameters<typeof tools.add>[0]);
    }
    for (const definition of definitions) {
      tools.add({
        name: definition.id,
        description: definition.description,
        input: definition.input ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          // The result tool's ownership is captured at dispatch (C1): the
          // turn and epoch this call belongs to are what the harness has
          // recorded now, before the tool runs, and the commit is fenced
          // by exactly that identity however long `run` takes.
          const dispatched =
            result && definition.id === result.tool.id ? await result.turn() : undefined;
          const resolved = await identity({
            messageId: String(context.messageID),
            toolCallId: String(context.id),
          });
          const value = await definition.run(
            codeToolContext(resolved, input, {
              reportProgress: async (metadata) => {
                await context.progress(metadata);
              },
            }),
          );
          if (result && dispatched) {
            // Validated, committed and acknowledged before the model sees
            // success; a rejection throws and reaches the model as a
            // failed call.
            const committed = await commitResultToolOutput({
              tool: result.tool,
              value,
              turnId: dispatched.turnId,
              callId: String(context.id),
              messageId: resolved.messageId,
              runtime: dispatched.runtime,
              commit: result.commit,
            });
            return { content: committed.content };
          }
          return {
            content:
              typeof value === "string" ? value : JSON.stringify(value ?? null),
          };
        },
      });
    }
  });
}
