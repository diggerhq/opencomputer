import { describe, expect, it } from "vitest";

import {
  AgentRenderError,
  modelRegistry,
  renderAgent,
  resolveModel,
  useModel,
  useInput,
  useConnection,
  useMcpServer,
  useMemory,
  useSessionData,
  useTool,
  type AgentRenderInput,
} from "../src/runtime/reactive-agent.js";
import {
  SupportAgent,
  supportAgentRegistry as registry,
} from "./fixtures/reactive-support-agent.js";

function input(
  state: AgentRenderInput["state"],
  sessionId = "ses_test",
): AgentRenderInput {
  return {
    projectId: "prj_test",
    deploymentId: "dep_test",
    agentId: "support",
    sessionId,
    responseId: `rsp_${sessionId}`,
    providerTurn: 1,
    stateVersion: 0,
    state,
    currentInput: { source: "user", text: "test input" },
  };
}

const deterministicOptions = {
  now: () => new Date("2026-08-08T20:00:00.000Z"),
  renderId: () => "rnd_test",
};

describe("reactive agent rendering", () => {
  it("selects resources conditionally from an immutable session snapshot", async () => {
    const anonymous = await renderAgent(
      SupportAgent,
      input({ authenticated: false }),
      registry,
      deterministicOptions,
    );
    const authenticated = await renderAgent(
      SupportAgent,
      { ...input({ authenticated: true }), stateVersion: 1, providerTurn: 2 },
      registry,
      deterministicOptions,
    );

    expect(anonymous.enabledTools).toEqual(["search-docs"]);
    expect(anonymous.render.instructions).toContain("without exposing private");
    expect(authenticated.enabledTools).toEqual([
      "search-docs",
      "update-subscription",
    ]);
    expect(authenticated.render.instructions).toContain(
      "authenticated customer",
    );
    expect(authenticated.stateVersion).toBe(1);
    expect(authenticated.providerTurn).toBe(2);
  });

  it("selects connections and MCP servers from the immutable current input", async () => {
    const rendered = await renderAgent(
      () => {
        const current = useInput();
        expect(Object.isFrozen(current)).toBe(true);
        if (current.text?.includes("repository")) {
          useConnection("github");
          useMcpServer({ id: "github" });
        }
        return `Handle: ${current.text ?? "nothing"}`;
      },
      {
        ...input({}),
        currentInput: { source: "user", text: "Review this repository" },
      },
      registry,
      deterministicOptions,
    );

    expect(rendered.requiredConnections).toEqual(["github"]);
    expect(rendered.enabledMcpServers).toEqual(["github"]);
    expect(rendered.render.instructions).toBe("Handle: Review this repository");
  });

  it("produces stable output ordering and fingerprints", async () => {
    function Agent(): string {
      useTool("update-subscription");
      useTool("search-docs");
      return "Stable instructions";
    }

    const first = await renderAgent(
      Agent,
      input({}),
      registry,
      deterministicOptions,
    );
    const second = await renderAgent(
      Agent,
      input({}),
      registry,
      deterministicOptions,
    );

    expect(first.enabledTools).toEqual([
      "search-docs",
      "update-subscription",
    ]);
    expect(second).toEqual(first);
  });

  it("isolates concurrent render scopes", async () => {
    const [first, second] = await Promise.all([
      renderAgent(
        () => {
          useTool("search-docs");
          return useSessionData<string>("message") ?? "";
        },
        input({ message: "first" }, "ses_first"),
        registry,
        deterministicOptions,
      ),
      renderAgent(
        () => {
          useTool("update-subscription");
          return useSessionData<string>("message") ?? "";
        },
        input({ message: "second" }, "ses_second"),
        registry,
        deterministicOptions,
      ),
    ]);

    expect(first.render.instructions).toBe("first");
    expect(first.enabledTools).toEqual(["search-docs"]);
    expect(second.render.instructions).toBe("second");
    expect(second.enabledTools).toEqual(["update-subscription"]);
  });

  it("prevents an agent from mutating its state snapshot", async () => {
    await renderAgent(
      () => {
        const profile = useSessionData<{ readonly name: string }>("profile");
        expect(() => {
          (profile as { name: string }).name = "changed";
        }).toThrow();
        return profile?.name ?? "missing";
      },
      input({ profile: { name: "original" } }),
      registry,
      deterministicOptions,
    );
  });

  it("enables ask like any tool when the runtime offers it", async () => {
    const record = await renderAgent(
      () => {
        useTool("ask");
        return "Ask when unsure";
      },
      input({}),
      { ...registry, tools: new Set([...registry.tools, "ask"]) },
      deterministicOptions,
    );
    expect(record.render.enabledTools.has("ask")).toBe(true);
  });

  it("fails closed for resources outside the deployment", async () => {
    await expect(
      renderAgent(
        () => {
          useTool("delete-account");
          return "Never reached";
        },
        input({}),
        registry,
      ),
    ).rejects.toThrow("not part of this deployment");
  });

  it("returns the memory projection and records the resources the render read", async () => {
    const record = await renderAgent(
      () => {
        const notes = useMemory("notes");
        const absent = useMemory({ id: "absent" });
        return `${notes?.text ?? ""}|${notes?.writable ? "rw" : "ro"}|${absent === undefined ? "none" : "?"}`;
      },
      {
        ...input({}),
        memory: { notes: { text: "v1", sources: [], writable: true } },
      },
      registry,
      deterministicOptions,
    );
    expect(record.render.instructions).toBe("v1|rw|none");
    expect(record.render.selectedMemory).toEqual(new Set(["notes"]));

    const without = await renderAgent(() => `${useMemory("notes")}`, input({}), registry, deterministicOptions);
    expect(without.render.instructions).toBe("undefined");
    expect(without.render.selectedMemory.size).toBe(0);
  });

  it("rejects hooks outside a render", () => {
    expect(() => useTool("search-docs")).toThrow(AgentRenderError);
    expect(() => useSessionData("authenticated")).toThrow(
      "can only be called while rendering",
    );
    expect(() => useInput()).toThrow("can only be called while rendering");
    expect(() => useConnection("github")).toThrow(AgentRenderError);
    expect(() => useMcpServer("github")).toThrow(AgentRenderError);
  });

  it("rejects conflicting model declarations", async () => {
    await expect(
      renderAgent(
        () => {
          useModel("model-one");
          useModel("model-two");
          return "Never reached";
        },
        input({}),
        { ...registry, models: undefined },
      ),
    ).rejects.toThrow("selected both");
  });

  it("defaults model strings to OpenRouter and accepts structured providers", () => {
    expect(resolveModel("anthropic/claude-sonnet-4.6")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    });
    expect(resolveModel({ provider: "openai", model: "gpt-5.2" })).toEqual({
      provider: "openai",
      model: "gpt-5.2",
    });
    expect(modelRegistry(["openai/gpt-5.2"])).toEqual(
      modelRegistry([
        { provider: "openrouter", model: "openai/gpt-5.2" },
      ]),
    );
  });
});
