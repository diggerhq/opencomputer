import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OpenComputer, Session, SessionEvent } from "@opencomputer/sdk/agents";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/tools.js";
import { buildSessionView } from "../src/transcript.js";
import { WIDGET_URI } from "../src/widget.js";

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: "ses_1",
    agentId: "agt_1",
    deploymentId: "dep_1",
    environment: "production",
    status: "idle",
    source: "api",
    turns: [{ id: "trn_1", input: "hi", mode: "queue", status: "completed", createdAt: "t", updatedAt: "t" }],
    ...over,
  }) as Session;

const ev = (seq: number, type: string, data: Record<string, unknown>, turnId = "trn_1"): SessionEvent =>
  ({ id: `evt_${seq}`, seq, timestamp: "t", sessionId: "ses_1", turnId, type, data }) as SessionEvent;

function fakeClient(overrides: Record<string, unknown> = {}) {
  const sessions = {
    create: vi.fn(async () => ({ session: { id: "ses_1", status: "new", createdAt: "t" }, created: true })),
    get: vi.fn(async () => session()),
    list: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    end: vi.fn(async () => session({ status: "ended" })),
    interrupt: vi.fn(async () => session()),
    turns: { send: vi.fn(async () => ({ turnId: "trn_1", status: "running", duplicate: false })) },
    events: {
      list: vi.fn(async (_id: string, q: { after?: number }) =>
        (q.after ?? 0) === 0 ? [ev(1, "tool.started", { tool: "bash", title: "Run tests" }), ev(2, "message.completed", { text: "hello!" })] : [],
      ),
    },
    ...overrides,
  };
  const agents = { list: vi.fn(async () => [{ id: "agt_1", name: "Helper", activeDeploymentId: "dep_1" }]) };
  return { sessions, agents } as unknown as OpenComputer & { sessions: typeof sessions; agents: typeof agents };
}

async function connect(oc: OpenComputer, options = {}) {
  const server = createMcpServer(oc, { sleep: async () => {}, ...options });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("buildSessionView", () => {
  it("joins replies, tools and failures per turn", () => {
    const view = buildSessionView(
      session({
        turns: [
          { id: "trn_1", input: "a", mode: "queue", status: "completed", createdAt: "t", updatedAt: "t" },
          { id: "trn_2", input: "b", mode: "queue", status: "failed", createdAt: "t", updatedAt: "t" },
        ],
      }),
      [
        ev(1, "message.completed", { text: "one" }),
        ev(2, "message.completed", { text: "two" }),
        ev(3, "tool.started", { tool: "bash" }),
        ev(4, "tool.started", { tool: "bash" }),
        ev(5, "turn.failed", { code: "runtime_lost", message: "Runtime lost" }, "trn_2"),
      ],
    );
    expect(view.turns[0]).toMatchObject({ reply: "one\n\ntwo", tools: ["bash"] });
    expect(view.turns[1]).toMatchObject({ status: "failed", error: "Runtime lost", reply: "" });
    expect(view.running).toBe(false);
  });

  it("keeps the latest turns and reports how many were omitted", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({
      id: `trn_${i}`, input: String(i), mode: "queue" as const, status: "completed", createdAt: "t", updatedAt: "t",
    }));
    const view = buildSessionView(session({ turns }), [], 10);
    expect(view.turns).toHaveLength(10);
    expect(view.turns[0]!.id).toBe("trn_2");
    expect(view.omittedTurns).toBe(2);
  });
});

describe("MCP tools", () => {
  it("lists every tool with auth metadata and the widget on session tools", async () => {
    const client = await connect(fakeClient());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "end_session", "get_session", "interrupt_session", "list_agents", "list_sessions", "run_agent", "send_message",
    ]);
    for (const tool of tools) expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["agents"] }]);
    const withWidget = tools.filter((t) => (t._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri === WIDGET_URI);
    expect(withWidget.map((t) => t.name).sort()).toEqual(["get_session", "run_agent", "send_message"]);
    expect(tools.find((t) => t.name === "end_session")!.annotations?.destructiveHint).toBe(true);
  });

  it("serves the widget as an MCP Apps resource", async () => {
    const client = await connect(fakeClient());
    const { contents } = await client.readResource({ uri: WIDGET_URI });
    expect(contents[0]).toMatchObject({ uri: WIDGET_URI, mimeType: "text/html;profile=mcp-app" });
    expect(String((contents[0] as { text: string }).text)).toContain("ui/notifications/tool-result");
  });

  it("run_agent creates a session, sends the turn, and waits for the reply", async () => {
    const oc = fakeClient();
    oc.sessions.get
      .mockResolvedValueOnce(session({ status: "running", turns: [{ id: "trn_1", input: "hi", mode: "queue", status: "running", createdAt: "t", updatedAt: "t" }] }))
      .mockResolvedValue(session());
    const client = await connect(oc);
    const result = await client.callTool({ name: "run_agent", arguments: { agent: "agt_1@development", input: "hi" } });
    expect(oc.sessions.create).toHaveBeenCalledWith(
      { agentId: "agt_1@development", source: "api", labels: { client: "chatgpt" } },
      { idempotencyKey: expect.any(String) },
    );
    expect(oc.sessions.turns.send).toHaveBeenCalledWith("ses_1", { input: "hi", idempotencyKey: expect.any(String) });
    expect(oc.sessions.get).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({ running: false, turns: [{ reply: "hello!", tools: ["Run tests"] }] });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("hello!");
  });

  it("stops waiting at the deadline and says how to follow up", async () => {
    const oc = fakeClient();
    const running = session({ status: "running", turns: [{ id: "trn_1", input: "hi", mode: "queue", status: "running", createdAt: "t", updatedAt: "t" }] });
    oc.sessions.get.mockResolvedValue(running);
    oc.sessions.events.list.mockResolvedValue([]);
    let clock = 0;
    const client = await connect(oc, { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollIntervalMs: 1000 });
    const result = await client.callTool({ name: "send_message", arguments: { sessionId: "ses_1", input: "hi", waitSeconds: 3 } });
    expect(oc.sessions.get).toHaveBeenCalledTimes(4);
    expect(result.structuredContent).toMatchObject({ running: true });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("call get_session");
  });

  it("returns API failures as tool errors", async () => {
    const oc = fakeClient();
    oc.sessions.end.mockRejectedValue(new Error("boom"));
    const client = await connect(oc);
    const result = await client.callTool({ name: "end_session", arguments: { sessionId: "ses_1" } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("boom");
  });

  it("list_agents summarizes agents", async () => {
    const client = await connect(fakeClient());
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    expect(result.structuredContent).toEqual({ agents: [{ id: "agt_1", name: "Helper", deployed: true, updatedAt: null }] });
  });
});
