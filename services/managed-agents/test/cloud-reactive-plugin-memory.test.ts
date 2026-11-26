import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode-ai/plugin-v2";
import type { SessionContext } from "@opencode-ai/plugin-v2/promise/session";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The sandbox session runtime's memory, end to end inside the plugin: the
 * render reads `useMemory` through the hooks global (what the SDK's
 * `hooks()` resolves to), the projection comes from the edge memory route,
 * and the fixed tools go back to it with the revision the render was given.
 * The edge is a fetch stub recording what it was asked.
 */

type ContextHook = (event: SessionContext) => Promise<void> | void;
type ToolExecute = (
  input: unknown,
  context: { sessionID: string; messageID: string; id: string; progress(): Promise<void> },
) => Promise<{ content: string }>;

interface Registered {
  hook?: ContextHook;
  tools: Map<string, { description: string; execute: ToolExecute }>;
}

function fakeContext(registered: Registered): Plugin.Context {
  return {
    session: {
      hook: async (name: string, callback: ContextHook) => {
        if (name === "context") registered.hook = callback;
        return { dispose: async () => undefined };
      },
    },
    tool: {
      transform: async (apply: (tools: { add(tool: unknown): void }) => void) => {
        apply({
          add: (tool) => {
            const definition = tool as { name: string; description: string; execute: ToolExecute };
            registered.tools.set(definition.name, definition);
          },
        });
      },
    },
  } as unknown as Plugin.Context;
}

function contextEvent(messages: Array<{ id: string; role: string; text: string }>): SessionContext {
  return {
    sessionID: "oc_ses_memory",
    agent: "build",
    model: { providerID: "openrouter", id: "anthropic/claude-sonnet-4.6" },
    system: [],
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: [{ type: "text", text: message.text }],
    })),
    tools: {
      memory_save: { description: "Save", input: { type: "object" } },
      memory_read: { description: "Read", input: { type: "object" } },
      memory_list: { description: "List", input: { type: "object" } },
    },
  } as unknown as SessionContext;
}

const edge = "https://edge.test";
const sessionId = "ses_memory";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloud reactive plugin memory", () => {
  it("renders useMemory from the edge recall and saves against the recalled revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencomputer-cloud-memory-"));
    const manifestPath = join(root, "reactive.json");
    const bindingPath = join(root, "reactive-session.json");
    await writeFile(
      join(root, "agent.js"),
      `export default function agent() {
  const hooks = globalThis[Symbol.for("opencomputer.agent-hooks")];
  const notes = hooks.useMemory("notes");
  return "Notes so far: " + (notes ? notes.text : "none");
}
`,
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 2,
        entry: "agent.js",
        tools: [],
        connections: [],
        mcpServers: [],
        memory: [{ id: "notes", description: "Running notes.", provider: { kind: "document", maxBytes: 1024 } }],
      }),
    );
    await writeFile(
      bindingPath,
      JSON.stringify({
        projectId: "prj_test",
        deploymentId: "dep_test",
        agentId: "support",
        sessionId,
        edge,
        runtimeToken: "rt_secret",
        turnId: "turn_1",
        runtimeEpoch: 1,
      }),
    );
    process.env.OPENCOMPUTER_REACTIVE_SESSION_PATH = bindingPath;
    process.env.OPENCOMPUTER_REACTIVE_MANIFEST_PATH = manifestPath;

    const calls: Array<{ method: string; path: string; authorization: string | null; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        calls.push({
          method,
          path,
          authorization: headers.get("authorization"),
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const reply = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (path.endsWith("/resources")) return reply({ data: [] });
        if (path.endsWith("/renders")) return reply({ ok: true });
        if (path.endsWith("/models/resolve")) {
          return reply({ model: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" } });
        }
        if (path.endsWith("/memory")) {
          return reply({
            bindings: [
              {
                resource: "notes",
                scope: "document",
                id: "workshop",
                access: "read-write",
                projection: { text: "v1", sources: [], cursor: "", writable: true, revision: "1", documentId: "workshop" },
              },
            ],
          });
        }
        if (path.endsWith("/memory/save")) return reply({ status: "saved", revision: "2", bytes: 2 });
        return reply({ error: "unexpected" }, 500);
      }),
    );

    const module = await import("../src/runtime/cloud-reactive-plugin.js");
    const registered: Registered = { tools: new Map() };
    await module.default.setup(fakeContext(registered));
    expect([...registered.tools.keys()]).toEqual(["memory_save", "memory_read", "memory_list", "ask"]);
    expect(registered.hook).toBeDefined();

    const event = contextEvent([
      { id: "msg_a0", role: "assistant", text: "an earlier step" },
      { id: "msg_u1", role: "user", text: "continue" },
    ]);
    await registered.hook!(event);
    expect(event.system).toEqual([{ type: "text", text: "Notes so far: v1" }]);
    expect(Object.keys(event.tools)).toEqual(["memory_save"]);
    expect(event.tools.memory_save?.description).toContain("- notes: Running notes.");
    expect(calls.find((call) => call.path.endsWith("/memory"))).toEqual({
      method: "GET",
      path: `/v1/sessions/${sessionId}/memory`,
      authorization: "Bearer rt_secret",
    });

    const call = (messageID: string) => ({ sessionID: "oc_ses_memory", messageID, id: "call_1", progress: async () => undefined });
    const save = registered.tools.get("memory_save")!;
    const saved = await save.execute({ text: "v2" }, call("msg_a1"));
    expect(JSON.parse(saved.content)).toEqual({ status: "saved", revision: "2", bytes: 2 });
    expect(calls.at(-1)).toEqual({
      method: "POST",
      path: `/v1/sessions/${sessionId}/memory/save`,
      authorization: "Bearer rt_secret",
      body: { resource: "notes", text: "v2", expectedRevision: "1" },
    });

    // A call from an assistant message that was already in the transcript
    // at the render belongs to an earlier request: never applied.
    const stale = await save.execute({ text: "v3" }, call("msg_a0"));
    expect(JSON.parse(stale.content)).toEqual({ status: "rejected", reason: "stale" });

    // The render read no collection, so the collection tools have no target.
    const read = await registered.tools.get("memory_read")!.execute({ id: "x" }, call("msg_a1"));
    expect(JSON.parse(read.content)).toEqual({ status: "rejected", reason: "not_bound", bound: [] });
    const other = await save.execute({ text: "v3", memory: "other" }, call("msg_a1"));
    expect(JSON.parse(other.content)).toEqual({ status: "rejected", reason: "not_bound", bound: ["notes"] });
  });
});
