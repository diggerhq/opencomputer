import { randomUUID } from "node:crypto";

import { GitActionLedger } from "./git-ledger.js";
import type {
  ActionRequestRecord,
  ActionResultRecord,
  CompiledActionDefinition,
  DataValue,
} from "./protocol.js";

export interface ActionBridgeContext {
  projectId: string;
  environment: string;
  agentId: string;
  sessionId: string;
  deploymentDigest: string;
}

export class GitActionBridge {
  private readonly tools = new Map<string, CompiledActionDefinition>();

  constructor(
    private readonly ledger: GitActionLedger,
    definitions: CompiledActionDefinition[],
    private readonly context: ActionBridgeContext,
    private readonly timeoutMs = 30_000,
  ) {
    for (const definition of definitions) {
      const name = `${definition.server}_${definition.tool}`;
      if (this.tools.has(name)) {
        throw new Error(`Action MCP tool ${name} is defined more than once`);
      }
      this.tools.set(name, definition);
    }
  }

  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [...this.tools.entries()].map(([name, definition]) => ({
      name,
      description:
        definition.description ??
        `Gated ${definition.server}.${definition.tool} action`,
      inputSchema: definition.input ?? {
        type: "object",
        additionalProperties: true,
      },
    }));
  }

  async callTool(input: {
    name: string;
    arguments?: Record<string, DataValue>;
    actionId?: string;
  }): Promise<ActionResultRecord> {
    const definition = this.tools.get(input.name);
    if (!definition) throw new Error(`Unknown action tool ${input.name}`);
    const actionId = input.actionId ?? randomUUID();
    const existing = await this.ledger.read<ActionRequestRecord>(
      "requests",
      actionId,
    );
    if (!existing) {
      await this.ledger.write<ActionRequestRecord>(
        "requests",
        actionId,
        {
          schemaVersion: 1,
          actionId,
          definitionId: definition.id,
          server: definition.server,
          tool: definition.tool,
          effect: definition.effect,
          duration: definition.duration,
          ...this.context,
          createdAt: new Date().toISOString(),
          input: input.arguments ?? {},
        },
        { message: `request: ${definition.server}.${definition.tool}` },
      );
    } else if (existing.record.definitionId !== definition.id) {
      throw new Error(`Action ID ${actionId} is already used by another action`);
    }
    return (
      await this.ledger.waitFor<ActionResultRecord>("results", actionId, {
        timeoutMs: this.timeoutMs,
      })
    ).record;
  }
}
