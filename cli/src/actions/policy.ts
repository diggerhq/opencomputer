import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ActionDisposition,
  ActionRequestRecord,
  CompiledActionDefinition,
} from "./protocol.js";

interface ActionModule {
  default?: unknown;
  [key: string]: unknown;
}

export interface LoadedActionBundle {
  module: ActionModule;
  definitions: Map<
    string,
    Omit<CompiledActionDefinition, "secrets"> & {
      secrets: Record<string, { kind: "secret"; id: string }>;
      run?: unknown;
    }
  >;
}

export async function loadActionBundle(entry: string): Promise<LoadedActionBundle> {
  const module = (await import(`${pathToFileURL(entry).href}?load=${Date.now()}`)) as ActionModule;
  const definitions: LoadedActionBundle["definitions"] = new Map();
  for (const value of Object.values(module)) {
    if (
      value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "action" &&
      "id" in value &&
      typeof value.id === "string"
    ) {
      definitions.set(
        value.id,
        value as unknown as Omit<CompiledActionDefinition, "secrets"> & {
          secrets: Record<string, { kind: "secret"; id: string }>;
          run?: unknown;
        },
      );
    }
  }
  return { module, definitions };
}

export function evaluateActionGate(
  bundle: LoadedActionBundle,
  request: ActionRequestRecord,
): ActionDisposition {
  if (typeof bundle.module.default !== "function") {
    throw new Error("actions.ts must default-export an action policy function");
  }
  let decision: ActionDisposition | undefined;
  const symbol = Symbol.for("opencomputer.action-hooks");
  const target = globalThis as Record<PropertyKey, unknown>;
  if (target[symbol]) throw new Error("An action policy is already being evaluated");
  target[symbol] = {
    useAction: () => ({
      id: request.actionId,
      definitionId: request.definitionId,
      server: request.server,
      tool: request.tool,
      effect: request.effect,
      duration: request.duration,
      input: request.input,
      projectId: request.projectId,
      environment: request.environment,
      agentId: request.agentId,
      sessionId: request.sessionId,
      deploymentDigest: request.deploymentDigest,
    }),
    useGate: (gate: () => ActionDisposition) => {
      if (decision) throw new Error("An action policy may declare only one gate");
      decision = gate();
    },
  };
  try {
    const returned = bundle.module.default();
    if (returned instanceof Promise) {
      throw new Error("Action policy functions must be synchronous");
    }
  } finally {
    delete target[symbol];
  }
  if (!decision) throw new Error("Action policy did not call useGate()");
  return decision;
}

export interface ActionPolicyEvaluator {
  evaluate(input: {
    entry: string;
    request: ActionRequestRecord;
  }): Promise<ActionDisposition>;
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C",
  } as unknown as NodeJS.ProcessEnv;
}

export class ChildProcessPolicyEvaluator implements ActionPolicyEvaluator {
  constructor(
    private readonly childEntry = resolve(import.meta.dirname, "policy-child.js"),
    private readonly timeoutMs = 10_000,
  ) {}

  async evaluate(input: {
    entry: string;
    request: ActionRequestRecord;
  }): Promise<ActionDisposition> {
    return new Promise<ActionDisposition>((resolvePromise, reject) => {
      const childArguments = this.childEntry.endsWith(".ts")
        ? ["--import", "tsx", this.childEntry]
        : [this.childEntry];
      const child = spawn(process.execPath, childArguments, {
        stdio: ["pipe", "pipe", "pipe"],
        env: isolatedEnvironment(),
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Action policy timed out"));
      }, this.timeoutMs);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timeout);
        try {
          const line = stdout.trim().split("\n").at(-1);
          const result = JSON.parse(line ?? "") as
            | { ok: true; disposition: ActionDisposition }
            | { ok: false; error: string };
          if (!result.ok) throw new Error(result.error);
          resolvePromise(result.disposition);
        } catch (error) {
          reject(
            error instanceof Error
              ? new Error(`${error.message}${stderr ? `: ${stderr}` : ""}`)
              : error,
          );
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}
