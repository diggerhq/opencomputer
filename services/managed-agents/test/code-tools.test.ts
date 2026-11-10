import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Plugin } from "@opencode-ai/plugin-v2";
import { describe, expect, it, vi } from "vitest";

import type {
  ResultCommitInput,
  ResultCommitOutcome,
  ToolInvocationIdentity,
} from "../src/protocol.js";
import {
  codeToolContext,
  loadCodeTools,
  registerCodeTools,
} from "../src/runtime/code-tools.js";
import { ResultCommitTransportError } from "../src/runtime/session-result.js";

/** What the host recorded about the session and turn; the resolver a runtime hands `registerCodeTools`. */
const hostSession = {
  projectId: "prj_host",
  environment: "development",
  agentId: "agent_host",
  deploymentId: "dep_host",
  sessionId: "ses_test",
  turnId: "turn_host",
} as const;
const identity = async (call: {
  messageId: string;
  toolCallId: string;
}): Promise<ToolInvocationIdentity> => ({
  ...hostSession,
  ...call,
  providerCallId: call.toolCallId,
});

describe("OpenComputer code tools", () => {
  it("loads and registers tool definitions through the OpenCode 2 API", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencomputer-code-tools-"));
    const manifestPath = join(root, "reactive.json");
    await writeFile(manifestPath, "{}\n");
    await writeFile(
      join(root, "hacker-news.js"),
      `export const hackerNews = {
  kind: "tool",
  version: 1,
  id: "hacker_news",
  name: "hacker_news",
  description: "Fetch Hacker News stories",
  input: { type: "object", properties: { limit: { type: "integer" } } },
  async run({ input, ...context }) {
    await context.reportProgress({ stage: "fetching" });
    return { limit: input.limit, sessionId: context.sessionId };
  },
};
`,
    );

    const added: Array<Record<string, unknown>> = [];
    const context = {
      tool: {
        transform: async (
          callback: (draft: { add(value: Record<string, unknown>): void }) => void,
        ) => {
          callback({ add: (value) => added.push(value) });
          return { dispose: async () => undefined };
        },
      },
    } as unknown as Plugin.Context;

    await registerCodeTools(
      context,
      manifestPath,
      ["hacker-news.js"],
      new Set(["hacker_news"]),
      { identity },
    );

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: "hacker_news",
      description: "Fetch Hacker News stories",
      options: { codemode: false },
    });
    const progress = vi.fn(async () => undefined);
    const execute = added[0]?.execute as (
      input: unknown,
      context: unknown,
    ) => Promise<unknown>;
    await expect(
      execute(
        { limit: 2 },
        {
          sessionID: "ses_test",
          messageID: "msg_test",
          agent: "support",
          abort: new AbortController().signal,
          progress,
        },
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ limit: 2, sessionId: "ses_test" }),
    });
    expect(progress).toHaveBeenCalledWith({ stage: "fetching" });
  });

  describe("the host-assigned invocation identity", () => {
    async function registerEcho(
      options: Parameters<typeof registerCodeTools>[4],
    ): Promise<(input: unknown) => Promise<{ content: string }>> {
      const root = await mkdtemp(join(tmpdir(), "opencomputer-tool-identity-"));
      const manifestPath = join(root, "reactive.json");
      await writeFile(manifestPath, "{}\n");
      await writeFile(
        join(root, "echo.js"),
        `export const echo = {
  kind: "tool",
  version: 1,
  id: "echo",
  name: "echo",
  description: "Echo the identity the runtime handed the tool",
  input: { type: "object", properties: {}, additionalProperties: true },
  async run(context) {
    const { input, identity } = context;
    const merged = { ...input, ...context };
    let mutated = "no";
    try {
      identity.turnId = "turn_forged";
      mutated = "yes";
    } catch {
      mutated = "threw";
    }
    return {
      identity,
      frozen: Object.isFrozen(identity),
      mutated,
      afterMutation: identity.turnId,
      mergedTurnId: merged.identity.turnId,
      inputIdentity: input.identity,
      inputTurnId: input.turnId,
      legacy: {
        sessionId: context.sessionId,
        messageId: context.messageId,
        agentId: context.agentId,
        toolCallId: context.toolCallId,
      },
    };
  },
};
`,
      );
      const added: Array<Record<string, unknown>> = [];
      const context = {
        tool: {
          transform: async (
            callback: (draft: { add(value: Record<string, unknown>): void }) => void,
          ) => {
            callback({ add: (value) => added.push(value) });
            return { dispose: async () => undefined };
          },
        },
      } as unknown as Plugin.Context;
      await registerCodeTools(context, manifestPath, ["echo.js"], new Set(["echo"]), options);
      const execute = added[0]!.execute as (
        input: unknown,
        context: unknown,
      ) => Promise<{ content: string }>;
      return (input) =>
        execute(input, {
          sessionID: "oc_session_local",
          messageID: "msg_host",
          agent: "build-label",
          id: "call_host",
          progress: async () => undefined,
        });
    }

    it("hands the tool the tuple the host resolved, frozen, with the legacy ids from it (acceptance 1)", async () => {
      const run = await registerEcho({ identity });
      const echoed = JSON.parse((await run({ limit: 1 })).content) as Record<string, unknown>;
      expect(echoed.identity).toEqual({
        ...hostSession,
        messageId: "msg_host",
        toolCallId: "call_host",
        providerCallId: "call_host",
      });
      expect(echoed.frozen).toBe(true);
      // Strict-mode module code: the write throws and changes nothing.
      expect(echoed.mutated).toBe("threw");
      expect(echoed.afterMutation).toBe("turn_host");
      // The canonical agent, not OpenCode's local agent label.
      expect(echoed.legacy).toEqual({
        sessionId: "ses_test",
        messageId: "msg_host",
        agentId: "agent_host",
        toolCallId: "call_host",
      });
    });

    it("keeps a model-supplied identity inside input, where it cannot shadow the host's (acceptance 5)", async () => {
      const run = await registerEcho({ identity });
      const forged = {
        projectId: "prj_forged",
        environment: "production",
        agentId: "agent_forged",
        deploymentId: "dep_forged",
        sessionId: "ses_forged",
        turnId: "turn_forged",
        messageId: "msg_forged",
        toolCallId: "call_forged",
      };
      const echoed = JSON.parse(
        (await run({ identity: forged, turnId: "turn_forged", deploymentId: "dep_forged" })).content,
      ) as Record<string, unknown>;
      expect(echoed.identity).toEqual({
        ...hostSession,
        messageId: "msg_host",
        toolCallId: "call_host",
        providerCallId: "call_host",
      });
      // Spreading input under the context still leaves the host's identity on top.
      expect(echoed.mergedTurnId).toBe("turn_host");
      // The forged copy is still there as data, for the tool to treat as such.
      expect(echoed.inputIdentity).toEqual(forged);
      expect(echoed.inputTurnId).toBe("turn_forged");
    });

    it("refuses the call, before run, when the host has no turn to attribute it to", async () => {
      const run = await registerEcho({
        identity: async () => {
          throw new Error("The tool call was refused: no managed turn is running");
        },
      });
      await expect(run({})).rejects.toThrow(/refused/);
    });
  });

  describe("the result tool in the MicroVM runtime", () => {
    const output = {
      type: "object",
      properties: { branch: { type: "string" } },
      required: ["branch"],
      additionalProperties: false,
    };

    async function registerReport(
      commit: (input: ResultCommitInput) => Promise<ResultCommitOutcome>,
      turn = async () => ({ turnId: "turn-1", runtime: { kind: "microvm" as const, epoch: 3 } }),
    ) {
      const root = await mkdtemp(join(tmpdir(), "opencomputer-result-tool-"));
      const manifestPath = join(root, "reactive.json");
      await writeFile(manifestPath, "{}\n");
      await writeFile(
        join(root, "report.js"),
        `export const report = {
  kind: "tool",
  version: 1,
  id: "report",
  name: "report",
  description: "Report the branch",
  output: ${JSON.stringify(output)},
  result: true,
  async run({ input }) {
    return input.value;
  },
};
export const lookup = {
  kind: "tool",
  version: 1,
  id: "lookup",
  name: "lookup",
  description: "Look up",
  async run() {
    return "looked up";
  },
};
`,
      );
      const added: Array<Record<string, unknown>> = [];
      const context = {
        tool: {
          transform: async (
            callback: (draft: { add(value: Record<string, unknown>): void }) => void,
          ) => {
            callback({ add: (value) => added.push(value) });
            return { dispose: async () => undefined };
          },
        },
      } as unknown as Plugin.Context;
      await registerCodeTools(
        context,
        manifestPath,
        ["report.js"],
        new Set(["report", "lookup"]),
        { result: { tool: { id: "report", output }, turn, commit }, identity },
      );
      const execute = (name: string, input: unknown) => {
        const tool = added.find((candidate) => candidate.name === name);
        return (tool!.execute as (input: unknown, context: unknown) => Promise<{ content: string }>)(
          input,
          {
            sessionID: "ses_test",
            messageID: "msg_test",
            agent: "worker",
            id: "call-1",
            abort: new AbortController().signal,
            progress: async () => undefined,
          },
        );
      };
      return { execute };
    }

    const receipt = (input: ResultCommitInput, replayed = false): ResultCommitOutcome => ({
      status: "committed",
      replayed,
      receipt: {
        turnId: input.turnId,
        callId: input.callId,
        reportedAt: "2026-09-15T00:00:00.000Z",
        eventId: "event-1",
      },
    });

    it("commits the validated output under the recorded turn and epoch before returning it", async () => {
      const order: string[] = [];
      const commit = vi.fn(async (input: ResultCommitInput) => {
        order.push("commit");
        return receipt(input);
      });
      const { execute } = await registerReport(commit);
      const result = await execute("report", { value: { branch: "task/1" } });
      order.push("returned");
      expect(result).toEqual({ content: '{"branch":"task/1"}' });
      expect(order).toEqual(["commit", "returned"]);
      expect(commit).toHaveBeenCalledWith({
        turnId: "turn-1",
        callId: "call-1",
        tool: "report",
        runtime: { kind: "microvm", epoch: 3 },
        data: { branch: "task/1" },
        // The message the host saw behind the call, for the result's identity.
        messageId: "msg_test",
      });
      // Other tools are untouched: no commit, string output as is.
      await expect(execute("lookup", {})).resolves.toEqual({ content: "looked up" });
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it("fails the call to the model on invalid output without committing", async () => {
      const commit = vi.fn();
      const { execute } = await registerReport(commit);
      await expect(execute("report", { value: { branch: 7 } })).rejects.toThrow(
        "does not match its output schema",
      );
      expect(commit).not.toHaveBeenCalled();
    });

    it("fails the call on a definite rejection and on an unrecorded turn", async () => {
      const commit = vi.fn(async (): Promise<ResultCommitOutcome> => ({
        status: "rejected",
        reason: "stale_runtime",
        message: "The result was reported by a runtime that no longer drives this session",
      }));
      const { execute } = await registerReport(commit);
      await expect(execute("report", { value: { branch: "task/1" } })).rejects.toThrow(
        "Result rejected: The result was reported by a runtime that no longer drives this session",
      );
      const unrecorded = await registerReport(commit, async () => {
        throw new Error("Result rejected: the runtime has not recorded the turn this call belongs to");
      });
      await expect(unrecorded.execute("report", { value: { branch: "task/1" } })).rejects.toThrow(
        "has not recorded the turn",
      );
    });

    it("commits a call held past its turn under the turn that dispatched it, never the turn the harness moved on to", async () => {
      // Review finding 5, MicroVM half: the tool's managed turn was read
      // after `run` returned, so holding an old call, aborting it, and
      // advancing the binding committed its output under the new turn.
      const root = await mkdtemp(join(tmpdir(), "opencomputer-held-result-"));
      const manifestPath = join(root, "reactive.json");
      await writeFile(manifestPath, "{}\n");
      const release = Symbol.for("opencomputer.test.release-held-report");
      await writeFile(
        join(root, "report.js"),
        `export const report = {
  kind: "tool",
  version: 1,
  id: "report",
  name: "report",
  description: "Report the branch",
  output: ${JSON.stringify(output)},
  result: true,
  async run({ input }) {
    while (!globalThis[Symbol.for("opencomputer.test.release-held-report")]) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return input.value;
  },
};
`,
      );
      const added: Array<Record<string, unknown>> = [];
      const context = {
        tool: {
          transform: async (
            callback: (draft: { add(value: Record<string, unknown>): void }) => void,
          ) => {
            callback({ add: (value) => added.push(value) });
            return { dispose: async () => undefined };
          },
        },
      } as unknown as Plugin.Context;
      let currentTurn = "turn-1";
      const commit = vi.fn(async (input: ResultCommitInput) => receipt(input));
      await registerCodeTools(context, manifestPath, ["report.js"], new Set(["report"]), {
        result: {
          tool: { id: "report", output },
          turn: async () => ({ turnId: currentTurn, runtime: { kind: "microvm", epoch: 3 } }),
          commit,
        },
        identity,
      });
      const tool = added.find((candidate) => candidate.name === "report")!;
      const abort = new AbortController();
      (globalThis as Record<symbol, unknown>)[release] = false;
      const held = (tool.execute as (input: unknown, context: unknown) => Promise<{ content: string }>)(
        { value: { branch: "task/old" } },
        {
          sessionID: "ses_test",
          messageID: "msg_old",
          agent: "worker",
          id: "call-old",
          abort: abort.signal,
          progress: async () => undefined,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The harness aborts the old call and moves on to the next turn.
      abort.abort();
      currentTurn = "turn-2";
      (globalThis as Record<symbol, unknown>)[release] = true;
      await held;
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0]![0]).toMatchObject({ turnId: "turn-1", callId: "call-old" });
    });

    it("retries a lost acknowledgement under the same call id and returns once the receipt arrives", async () => {
      let calls = 0;
      const commit = vi.fn(async (input: ResultCommitInput) => {
        calls += 1;
        if (calls === 1) throw new ResultCommitTransportError("socket hang up");
        return receipt(input, true);
      });
      const { execute } = await registerReport(commit);
      await expect(execute("report", { value: { branch: "task/1" } })).resolves.toEqual({
        content: '{"branch":"task/1"}',
      });
      expect(commit).toHaveBeenCalledTimes(2);
      expect(commit.mock.calls[0]![0].callId).toBe("call-1");
      expect(commit.mock.calls[1]![0].callId).toBe("call-1");
    });
  });

  it("rejects tool exports that are absent from the deployment manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencomputer-code-tools-"));
    const manifestPath = join(root, "reactive.json");
    await writeFile(manifestPath, "{}\n");
    await writeFile(
      join(root, "unexpected.js"),
      `export default {
  kind: "tool",
  version: 1,
  id: "unexpected",
  name: "unexpected",
  description: "Unexpected tool",
  input: { type: "object" },
  run: async () => "no",
};
`,
    );

    await expect(
      loadCodeTools(manifestPath, ["unexpected.js"], new Set()),
    ).rejects.toThrow("exported unregistered tool");
  });

  it("registers a gated tool and keeps its apply for after the decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencomputer-gated-tools-"));
    const manifestPath = join(root, "reactive.json");
    await writeFile(manifestPath, "{}\n");
    await writeFile(
      join(root, "billing.js"),
      `export const attach = {
  kind: "gated-tool",
  version: 1,
  id: "attach",
  name: "attach",
  description: "Move a customer onto a plan",
  async run() {
    return "Recorded for approval.";
  },
  async apply({ input, decision }) {
    return { applied: input.plan, by: decision.decidedBy };
  },
};
`,
    );

    const added: Array<Record<string, unknown>> = [];
    const context = {
      tool: {
        transform: async (
          callback: (draft: { add(value: Record<string, unknown>): void }) => void,
        ) => {
          callback({ add: (value) => added.push(value) });
          return { dispose: async () => undefined };
        },
      },
    } as unknown as Plugin.Context;

    // The model sees it as an ordinary tool. If the loader only admitted
    // kind "tool", it would be skipped here and never offered at all.
    await registerCodeTools(context, manifestPath, ["billing.js"], new Set(["attach"]), {
      identity,
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: "attach" });

    const [definition] = await loadCodeTools(
      manifestPath,
      ["billing.js"],
      new Set(["attach"]),
    );
    expect(definition!.kind).toBe("gated-tool");
    // The write lives here, and runs from the arguments it is handed.
    await expect(
      definition!.apply!({
        ...codeToolContext(
          { ...hostSession, messageId: "apr_1", toolCallId: "apr_1", providerCallId: "apr_1" },
          { plan: "pro" },
          { reportProgress: async () => undefined },
        ),
        decision: { id: "apr_1", decidedAt: "2026-09-10T00:00:00Z", decidedBy: "U1" },
      }),
    ).resolves.toEqual({ applied: "pro", by: "U1" });
  });

  it("refuses a gated tool with no apply, rather than offering a write that cannot land", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencomputer-gated-broken-"));
    const manifestPath = join(root, "reactive.json");
    await writeFile(manifestPath, "{}\n");
    await writeFile(
      join(root, "broken.js"),
      `export const broken = {
  kind: "gated-tool",
  version: 1,
  id: "broken",
  name: "broken",
  description: "Missing its apply",
  async run() { return "nothing"; },
};
`,
    );
    await expect(
      loadCodeTools(manifestPath, ["broken.js"], new Set(["broken"])),
    ).resolves.toEqual([]);
  });

  it("refuses a tool whose gatedness disagrees with the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencomputer-gated-mismatch-"));
    const manifestPath = join(root, "reactive.json");
    await writeFile(manifestPath, "{}\n");
    await writeFile(
      join(root, "drift.js"),
      `export const attach = {
  kind: "tool",
  version: 1,
  id: "attach",
  name: "attach",
  description: "Writes immediately",
  async run() { return "written"; },
};
`,
    );
    // Declared gated, exported plain: it would write without ever asking.
    // Catching that at load is the whole reason the manifest carries the list.
    await expect(
      loadCodeTools(
        manifestPath,
        ["drift.js"],
        new Set(["attach"]),
        new Set(["attach"]),
      ),
    ).rejects.toThrow(/does not wait for approval/);
  });
});
