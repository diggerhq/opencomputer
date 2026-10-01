import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OpenComputerError, type OpenComputer, type SessionEvent } from "@opencomputer/sdk/agents";
import { z } from "zod";
import { SCOPE } from "./env.js";
import { buildSessionView, describeSessionView, isTerminalTurn, type SessionView } from "./transcript.js";
import { WIDGET_URI, widgetResource } from "./widget.js";

export interface ToolOptions {
  /** Upper bound on how long a tool waits for a turn to finish. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_WAIT_SECONDS = 25;
const MAX_WAIT_SECONDS = 50;
const MAX_EVENT_PAGES = 20;

const security = [{ type: "oauth2", scopes: [SCOPE] }];
const widgetMeta = (invoking: string, invoked: string) => ({
  ui: { resourceUri: WIDGET_URI },
  "openai/outputTemplate": WIDGET_URI,
  "openai/widgetAccessible": true,
  "openai/toolInvocation/invoking": invoking,
  "openai/toolInvocation/invoked": invoked,
  securitySchemes: security,
});
const plainMeta = (invoking: string, invoked: string) => ({
  "openai/toolInvocation/invoking": invoking,
  "openai/toolInvocation/invoked": invoked,
  securitySchemes: security,
});

const agentRef = z
  .string()
  .min(1)
  .max(200)
  .describe("The agent id from list_agents, e.g. agt_123. Append @development to use the development environment; a bare id uses production.");
const sessionId = z.string().min(1).max(200).describe("The session id, e.g. ses_123.");
const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(`How long to wait for the agent to reply before returning, at most ${MAX_WAIT_SECONDS}. Default ${DEFAULT_WAIT_SECONDS}.`);
const input = z.string().min(1).max(32_000).describe("The message for the agent.");

function failure(error: unknown): CallToolResult {
  const message =
    error instanceof OpenComputerError
      ? `${error.message} (${error.code}, HTTP ${error.status})`
      : error instanceof Error
        ? error.message
        : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(oc: OpenComputer, options: ToolOptions = {}): McpServer {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_SECONDS * 1000;

  async function readEvents(id: string): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    let after = 0;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const batch = await oc.sessions.events.list(id, { after });
      if (batch.length === 0) break;
      events.push(...batch);
      after = batch[batch.length - 1]!.seq;
    }
    return events;
  }

  async function view(id: string, waitForTurnId?: string, wait = 0): Promise<SessionView> {
    const deadline = now() + Math.min(wait * 1000, maxWaitMs);
    let session = await oc.sessions.get(id);
    while (waitForTurnId && now() < deadline) {
      const turn = session.turns.find((t) => t.id === waitForTurnId);
      if (!turn || isTerminalTurn(turn) || session.status === "ended" || session.status === "failed") break;
      await sleep(pollIntervalMs);
      session = await oc.sessions.get(id);
    }
    return buildSessionView(session, await readEvents(id));
  }

  const sessionResult = (data: SessionView): CallToolResult => ({
    structuredContent: data as unknown as Record<string, unknown>,
    content: [{ type: "text", text: describeSessionView(data) }],
  });

  const server = new McpServer({ name: "opencomputer-agents", version: "0.1.0" });

  server.registerResource("session-widget", WIDGET_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [widgetResource()],
  }));

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List the OpenComputer serverless agents in the connected organization.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: plainMeta("Listing agents…", "Listed agents"),
    },
    () =>
      guarded(async () => {
        const agents = await oc.agents.list();
        const rows = agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deployed: Boolean(agent.activeDeploymentId),
          updatedAt: agent.updatedAt ?? null,
        }));
        const text = rows.length
          ? rows.map((a) => `- ${a.name} (${a.id})${a.deployed ? "" : " — not deployed"}`).join("\n")
          : "This organization has no agents yet. Deploy one with `oc deploy`.";
        return { structuredContent: { agents: rows }, content: [{ type: "text", text }] };
      }),
  );

  server.registerTool(
    "run_agent",
    {
      title: "Run agent",
      description:
        "Start a new session with an OpenComputer agent and send it a first message. Waits briefly for the reply; " +
        "if the agent is still working, call get_session later. Use send_message to continue the same session.",
      inputSchema: { agent: agentRef, input, waitSeconds },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      _meta: widgetMeta("Starting agent…", "Agent responded"),
    },
    ({ agent, input: text, waitSeconds: wait }) =>
      guarded(async () => {
        const { session } = await oc.sessions.create(
          { agentId: agent, source: "api", labels: { client: "chatgpt" } },
          { idempotencyKey: crypto.randomUUID() },
        );
        const receipt = await oc.sessions.turns.send(session.id, { input: text, idempotencyKey: crypto.randomUUID() });
        return sessionResult(await view(session.id, receipt.turnId, wait ?? DEFAULT_WAIT_SECONDS));
      }),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Send a follow-up message to an existing agent session. By default it queues behind the running turn; " +
        "mode 'interrupt' stops the running turn first and 'steer' redirects it.",
      inputSchema: {
        sessionId,
        input,
        mode: z.enum(["queue", "steer", "interrupt"]).optional().describe("Default queue."),
        waitSeconds,
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      _meta: widgetMeta("Sending…", "Agent responded"),
    },
    ({ sessionId: id, input: text, mode, waitSeconds: wait }) =>
      guarded(async () => {
        const receipt = await oc.sessions.turns.send(id, { input: text, mode, idempotencyKey: crypto.randomUUID() });
        return sessionResult(await view(id, receipt.turnId, wait ?? DEFAULT_WAIT_SECONDS));
      }),
  );

  server.registerTool(
    "get_session",
    {
      title: "Get session",
      description: "Read an agent session: its status, recent turns with the agent's replies, tools it used and its result.",
      inputSchema: { sessionId },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: widgetMeta("Reading session…", "Read session"),
    },
    ({ sessionId: id }) => guarded(async () => sessionResult(await view(id))),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description: "List recent agent sessions, newest first, optionally for one agent or status.",
      inputSchema: {
        agent: z.string().min(1).max(200).optional().describe("Only sessions of this agent id."),
        status: z
          .enum(["new", "idle", "running", "suspended", "failed", "ended"])
          .optional()
          .describe("Only sessions in this status."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: plainMeta("Listing sessions…", "Listed sessions"),
    },
    ({ agent, status, limit }) =>
      guarded(async () => {
        const page = await oc.sessions.list({ agentId: agent, status, limit: limit ?? 10 });
        const rows = page.sessions.map((s) => ({
          id: s.id,
          agentId: s.agentId,
          environment: s.environment ?? null,
          status: s.status,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }));
        const text = rows.length
          ? rows.map((s) => `- ${s.id} · ${s.agentId} · ${s.status} · updated ${s.updatedAt}`).join("\n")
          : "No sessions match.";
        return { structuredContent: { sessions: rows }, content: [{ type: "text", text }] };
      }),
  );

  server.registerTool(
    "interrupt_session",
    {
      title: "Interrupt session",
      description: "Stop the turn an agent session is running. The session stays open; the next queued message starts.",
      inputSchema: { sessionId },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: plainMeta("Interrupting…", "Interrupted"),
    },
    ({ sessionId: id }) =>
      guarded(async () => {
        const session = await oc.sessions.interrupt(id);
        return {
          structuredContent: { id: session.id, status: session.status },
          content: [{ type: "text", text: `Interrupted session ${session.id}; it is ${session.status}.` }],
        };
      }),
  );

  server.registerTool(
    "end_session",
    {
      title: "End session",
      description: "End an agent session. It cannot take further messages afterwards.",
      inputSchema: { sessionId },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      _meta: plainMeta("Ending session…", "Session ended"),
    },
    ({ sessionId: id }) =>
      guarded(async () => {
        const session = await oc.sessions.end(id);
        return {
          structuredContent: { id: session.id, status: session.status },
          content: [{ type: "text", text: `Ended session ${session.id}.` }],
        };
      }),
  );

  return server;
}
