import { readFile } from "node:fs/promises";
import readline from "node:readline";

import { GitActionBridge } from "./bridge.js";
import { GitActionLedger } from "./git-ledger.js";
import type { CompiledActionManifest, DataValue } from "./protocol.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

interface ReactiveManifest {
  actions?: CompiledActionManifest;
}

const manifest = JSON.parse(
  await readFile(required("OPENCOMPUTER_REACTIVE_MANIFEST_PATH"), "utf8"),
) as ReactiveManifest;
if (!manifest.actions) throw new Error("Deployment does not declare actions");

const bridge = new GitActionBridge(
  new GitActionLedger(required("OPENCOMPUTER_ACTION_REPOSITORY")),
  manifest.actions.definitions,
  {
    projectId: required("OPENCOMPUTER_PROJECT_ID"),
    environment: required("OPENCOMPUTER_ENVIRONMENT"),
    agentId: required("OPENCOMPUTER_AGENT_ID"),
    sessionId: required("OPENCOMPUTER_SESSION_ID"),
    deploymentDigest: required("OPENCOMPUTER_DEPLOYMENT_DIGEST"),
  },
  Number(process.env.OPENCOMPUTER_ACTION_TIMEOUT_MS ?? 30_000),
);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line) as {
    jsonrpc?: string;
    id?: string | number;
    method?: string;
    params?: {
      name?: string;
      arguments?: Record<string, DataValue>;
      _meta?: { actionId?: string };
    };
  };
  if (request.method === "notifications/initialized") continue;
  try {
    let result: unknown;
    if (request.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "opencomputer-actions", version: "0.1.0" },
      };
    } else if (request.method === "tools/list") {
      result = { tools: bridge.listTools() };
    } else if (request.method === "tools/call") {
      if (!request.params?.name) throw new Error("Tool name is required");
      const actionResult = await bridge.callTool({
        name: request.params.name,
        arguments: request.params.arguments,
        actionId: request.params._meta?.actionId,
      });
      result = {
        content: [{ type: "text", text: JSON.stringify(actionResult) }],
        structuredContent: actionResult,
        isError: actionResult.outcome.status !== "succeeded",
      };
    } else {
      throw new Error(`Unsupported MCP method ${request.method ?? "unknown"}`);
    }
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

