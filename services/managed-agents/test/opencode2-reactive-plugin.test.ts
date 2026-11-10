import { describe, expect, it, vi } from "vitest";
import { Plugin } from "@opencode-ai/plugin-v2";
import type { SessionContext } from "@opencode-ai/plugin-v2/promise/session";

import {
  defineOpenCode2ReactivePlugin,
  OPENCODE2_REACTIVE_PLUGIN_ID,
} from "../src/runtime/opencode2-reactive-plugin.js";
import {
  modelRegistry,
  useInput,
  useMcpServer,
  useMemory,
  useModel,
  useSessionData,
  useTool,
} from "../src/runtime/reactive-agent.js";
import { memoryToolDescription } from "../src/runtime/memory-tools.js";

type ContextHook = (event: SessionContext) => Promise<void> | void;

function pluginContext(
  register: (hook: ContextHook) => void,
): Plugin.Context {
  return {
    session: {
      hook: async (name: string, callback: ContextHook) => {
        if (name === "context") register(callback as ContextHook);
        return { dispose: async () => undefined };
      },
    },
  } as unknown as Plugin.Context;
}

function contextEvent(): SessionContext {
  return {
    sessionID: "oc_ses_test",
    agent: "support",
    model: {
      providerID: "openrouter",
      id: "anthropic/claude-sonnet-4.6",
    },
    system: [],
    messages: [
      {
        id: "msg_user",
        role: "user",
        content: [{ type: "text", text: "help with billing" }],
      },
    ],
    tools: {
      "search-docs": {
        description: "Search documentation",
        input: { type: "object" },
      },
      "update-subscription": {
        description: "Update a subscription",
        input: { type: "object" },
      },
      bash: {
        description: "Run a shell command",
        input: { type: "object" },
      },
      shell: {
        description: "Run a shell command",
        input: { type: "object" },
      },
      load_agent_skill: {
        description: "Load a packaged agent skill",
        input: { type: "object" },
      },
    },
  } as unknown as SessionContext;
}

const memoryTools = {
  memory_save: { description: "Save", input: { type: "object" } },
  memory_read: { description: "Read", input: { type: "object" } },
  memory_list: { description: "List", input: { type: "object" } },
};

const memoryGrants = {
  bindings: [
    { resource: "notes", scope: "document" as const, id: "workshop", access: "read-write" as const },
    { resource: "archive", scope: "collection" as const, access: "read" as const },
  ],
  descriptions: { notes: "Running notes.", archive: "Past runs." },
};

function memoryBinding(agent: () => string, selectedTurn = 1) {
  return {
    agent,
    input: {
      projectId: "prj_test",
      deploymentId: "dep_test",
      agentId: "support",
      sessionId: "ses_test",
      responseId: "rsp_test",
      providerTurn: selectedTurn,
      stateVersion: 0,
      state: {},
      currentInput: { source: "user" as const, text: "help" },
      memory: {
        notes: { text: "v1 notes", sources: [], writable: true },
        archive: { text: "- run-1", sources: [], writable: false },
      },
    },
    registry: { tools: new Set<string>() },
    memory: memoryGrants,
  };
}

describe("OpenCode 2 reactive plugin", () => {
  it("renders, commits, and filters the provider-turn context", async () => {
    let hook: ContextHook | undefined;
    const commit = vi.fn();
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: (turn) => ({
        agent: () => {
          useModel(turn.model);
          useTool("search-docs");
          return `Session state is ${useSessionData("status")}. Input: ${useInput().text}.`;
        },
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 4,
          state: { status: "ready" },
          currentInput: turn.input,
        },
        registry: {
          tools: new Set(["search-docs", "update-subscription"]),
          models: modelRegistry([turn.model]),
        },
        renderOptions: {
          now: () => new Date("2026-08-08T20:00:00.000Z"),
          renderId: () => "rnd_test",
        },
      }),
      commit,
    });

    expect(plugin.id).toBe(OPENCODE2_REACTIVE_PLUGIN_ID);
    await plugin.setup(pluginContext((registered) => (hook = registered)));
    expect(hook).toBeDefined();

    const event = contextEvent();
    await hook?.(event);

    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      renderId: "rnd_test",
      deploymentId: "dep_test",
      stateVersion: 4,
      enabledTools: ["search-docs"],
    });
    expect(commit.mock.calls[0]?.[1]).toEqual({
      input: { source: "user", text: "help with billing" },
      tools: [
        { name: "search-docs", description: "Search documentation" },
      ],
      model: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      },
    });
    expect(event.system).toEqual([
      {
        type: "text",
        text: "Session state is ready. Input: help with billing.",
      },
    ]);
    expect(Object.keys(event.tools)).toEqual([
      "search-docs",
      "load_agent_skill",
    ]);
  });

  it("commits the render before mutating the OpenCode context", async () => {
    let hook: ContextHook | undefined;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () => ({
        agent: () => {
          useTool("search-docs");
          return "Rendered instructions";
        },
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "help" },
        },
        registry: {
          tools: new Set(["search-docs"]),
        },
      }),
      commit: () => {
        throw new Error("durable render store unavailable");
      },
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));

    const event = contextEvent();
    await expect(hook?.(event)).rejects.toThrow(
      "durable render store unavailable",
    );
    expect(event.system).toEqual([]);
    expect(Object.keys(event.tools)).toEqual([
      "search-docs",
      "update-subscription",
      "bash",
      "shell",
      "load_agent_skill",
    ]);
  });

  it("enables OpenCode's bash when the agent selects sandbox_exec", async () => {
    let hook: ContextHook | undefined;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () => ({
        agent: () => {
          useTool("sandbox_exec");
          return "Use the shell.";
        },
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "list files" },
        },
        registry: {
          tools: new Set(["sandbox_exec", "search-docs"]),
          models: modelRegistry([
            { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
          ]),
        },
        renderOptions: {
          now: () => new Date("2026-08-08T20:00:00.000Z"),
          renderId: () => "rnd_test",
        },
      }),
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));

    const event = contextEvent();
    await hook?.(event);
    expect(Object.keys(event.tools)).toEqual([
      "bash",
      "shell",
      "load_agent_skill",
    ]);
  });

  it("keeps enabled MCP namespaces and the catalog bridge", async () => {
    let hook: ContextHook | undefined;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () => ({
        agent: () => {
          useMcpServer("unleash");
          useMcpServer("github");
          return "Use Unleash.";
        },
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "list flags" },
        },
        registry: {
          tools: new Set(),
          mcpServers: new Set(["unleash", "github"]),
        },
      }),
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));
    const event = contextEvent();
    event.tools = {
      unleash_list_flags: {
        description: "List Unleash flags",
        input: { type: "object" },
      },
      github_get_file: {
        description: "Get a GitHub file",
        input: { type: "object" },
      },
      search: {
        description: "Search the lazy MCP tool catalog",
        input: { type: "object" },
      },
      execute: {
        description: "Execute a lazy MCP catalog tool",
        input: { type: "object" },
      },
      bash: {
        description: "Run shell",
        input: { type: "object" },
      },
    };
    await hook?.(event);
    expect(Object.keys(event.tools)).toEqual([
      "unleash_list_flags",
      "github_get_file",
      "search",
      "execute",
    ]);
  });

  it("removes the shared MCP catalog bridge when only some servers are enabled", async () => {
    let hook: ContextHook | undefined;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () => ({
        agent: () => {
          useMcpServer("unleash");
          return "Use only Unleash.";
        },
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "list flags" },
        },
        registry: {
          tools: new Set(),
          mcpServers: new Set(["unleash", "github"]),
        },
      }),
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));
    const event = contextEvent();
    event.tools = {
      unleash_list_flags: {
        description: "List Unleash flags",
        input: { type: "object" },
      },
      search: {
        description: "Search the lazy MCP tool catalog",
        input: { type: "object" },
      },
      execute: {
        description: "Execute a lazy MCP catalog tool",
        input: { type: "object" },
      },
    };
    await hook?.(event);
    expect(Object.keys(event.tools)).toEqual(["unleash_list_flags"]);
  });

  it("renders useMemory from the projection and exposes the tools the render read", async () => {
    let hook: ContextHook | undefined;
    const commit = vi.fn();
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () =>
        memoryBinding(() => {
          const notes = useMemory("notes");
          expect(useMemory("missing")).toBeUndefined();
          return `Notes: ${notes?.text ?? "none"}`;
        }),
      commit,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));
    const event = contextEvent();
    event.tools = { ...event.tools, ...memoryTools };
    event.messages = [
      { id: "msg_a1", role: "assistant", content: [{ type: "text", text: "earlier" }] },
      { id: "msg_user", role: "user", content: [{ type: "text", text: "help" }] },
    ] as unknown as SessionContext["messages"];
    await hook?.(event);

    expect(event.system).toEqual([{ type: "text", text: "Notes: v1 notes" }]);
    // Only the read-write document was read: save is offered for it; the
    // collection tools go, as do the agent tools the render did not select.
    expect(Object.keys(event.tools)).toEqual(["load_agent_skill", "memory_save"]);
    expect(event.tools.memory_save?.description).toBe(
      memoryToolDescription("memory_save", [{ resource: "notes", description: "Running notes." }]),
    );
    expect(commit.mock.calls[0]?.[0].render.selectedMemory).toEqual(new Set(["notes"]));
    // The transcript's assistant messages travel with the turn, so a tool
    // call from one of them can be told apart from this request's own.
    expect(commit.mock.calls[0]?.[2]).toMatchObject({
      openCodeSessionId: "oc_ses_test",
      assistantMessageIds: ["msg_a1"],
    });
  });

  it("describes a memory tool with every selected resource and removes the ones no selection offers", async () => {
    let hook: ContextHook | undefined;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () =>
        memoryBinding(() => {
          useMemory("archive");
          return "Read the archive.";
        }),
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));
    const event = contextEvent();
    event.tools = { ...event.tools, ...memoryTools };
    await hook?.(event);
    expect(Object.keys(event.tools)).toEqual(["load_agent_skill", "memory_read", "memory_list"]);
    expect(event.tools.memory_list?.description).toContain("- archive: Past runs.");
    expect(event.tools.memory_list?.description).toContain('defaults to "archive"');
  });

  it("removes every memory tool when the render read no memory", async () => {
    let hook: ContextHook | undefined;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () => memoryBinding(() => "No memory this step."),
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));
    const event = contextEvent();
    event.tools = { ...event.tools, ...memoryTools };
    await hook?.(event);
    expect(Object.keys(event.tools)).toEqual(["load_agent_skill"]);
  });

  it("rejects a model change during an active response", async () => {
    let hook: ContextHook | undefined;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: () => ({
        agent: () => {
          useModel({ provider: "openai", model: "gpt-5" });
          return "Use another model";
        },
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "help" },
        },
        registry: {
          tools: new Set(),
        },
      }),
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));

    await expect(hook?.(contextEvent())).rejects.toThrow(
      "Model changes apply to the next response",
    );
  });

  it("validates the exact rendered model before committing the render", async () => {
    let hook: ContextHook | undefined;
    const validated: Array<{ provider: string; model: string }> = [];
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: (turn) => ({
        agent: () => {
          useModel("anthropic/claude-sonnet-5");
          return "Use the selected model";
        },
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "help" },
        },
        registry: {
          tools: new Set(),
          models: modelRegistry([turn.model]),
        },
      }),
      validateModel: (model) => {
        if (!model) throw new Error("Expected an explicit model");
        validated.push(model);
        return model;
      },
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));
    const event = {
      ...contextEvent(),
      model: {
        providerID: "openrouter",
        id: "anthropic/claude-sonnet-5",
      },
    } as unknown as SessionContext;

    await hook?.(event);
    expect(validated).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
    ]);
  });

  it("asks the resolver for the deployment default when useModel is omitted", async () => {
    let hook: ContextHook | undefined;
    let requested: unknown = "not-called";
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: (turn) => ({
        agent: () => "Use the default model",
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "help" },
        },
        registry: {
          tools: new Set(),
          models: modelRegistry([turn.model]),
        },
      }),
      validateModel: (model, turn) => {
        requested = model;
        return turn.model;
      },
      commit: () => undefined,
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));

    await hook?.(contextEvent());
    expect(requested).toBeUndefined();
  });
  it("accepts a pinned model route the resolver returns as the connection", async () => {
    let hook: ContextHook | undefined;
    let committed = false;
    const plugin = defineOpenCode2ReactivePlugin({
      resolve: (turn) => ({
        agent: () => "Use the routed model",
        input: {
          projectId: "prj_test",
          deploymentId: "dep_test",
          agentId: "support",
          sessionId: "ses_test",
          responseId: "rsp_test",
          providerTurn: 1,
          stateVersion: 0,
          state: {},
          currentInput: { source: "user", text: "help" },
        },
        registry: {
          tools: new Set(),
          models: modelRegistry([turn.model]),
        },
      }),
      validateModel: () => ({ provider: "connection", model: "deepseek/deepseek-v4" }),
      commit: () => {
        committed = true;
      },
    });
    await plugin.setup(pluginContext((registered) => (hook = registered)));

    await hook?.(contextEvent());
    expect(committed).toBe(true);
  });
});
