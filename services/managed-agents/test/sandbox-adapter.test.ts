import { describe, expect, it } from "vitest";

import {
  COMMAND_TIMEOUT_MAX_SECONDS,
  MicrovmEndpointCache,
  interpretSupervisorHealth,
  parseSandboxEnsureInput,
  parseSandboxExecuteCancelInput,
  parseSandboxExecuteInput,
  parseSandboxExecuteStatusInput,
  waitForSupervisorReady,
} from "../src/platform/sandbox-adapter.js";

const deployment = {
  id: "agent:digest",
  agentId: "agent",
  alias: "development",
  channels: [],
  connections: [],
  httpConnections: [],
  artifact: {
    bucket: "artifacts",
    key: "accounts/account/agent/digest.json",
    digest: "a".repeat(64),
    size: 10,
  },
  imageArn: "arn:aws:lambda:region:account:microvm-image:test",
  imageVersion: "1",
  runtimeMode: "workerd-lazy-sandbox" as const,
  createdAt: "2026-09-04T00:00:00.000Z",
};

describe("managed sandbox adapter contract", () => {
  it("accepts the pinned session workspace and deployment", () => {
    expect(
      parseSandboxEnsureInput({
        accountId: "account",
        sessionID: "session",
        edge: "https://edge.example.com",
        runtimeToken: "runtime-token",
        generation: 1,
        workspace: { id: "session", mountPath: "/workspace" },
        deployment,
      }),
    ).toMatchObject({
      accountId: "account",
      sessionID: "session",
      generation: 1,
    });
  });

  it("accepts a shared workspace id for a consulted session's computer", () => {
    expect(
      parseSandboxEnsureInput({
        accountId: "account",
        sessionID: "session",
        edge: "https://edge.example.com",
        runtimeToken: "runtime-token",
        generation: 1,
        workspace: { id: "host-session", mountPath: "/workspace" },
        deployment,
      }),
    ).toMatchObject({
      sessionID: "session",
      workspace: { id: "host-session", mountPath: "/workspace" },
    });
  });

  it("accepts bounded exec requests and rejects other capabilities", () => {
    const parsed = parseSandboxExecuteInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 1,
        toolCallID: "tool-call",
        capability: "exec",
        request: { command: "pwd", timeoutSeconds: 120 },
      });
    expect(parsed.capability).toBe("exec");
    expect(parsed.request).toEqual({ command: "pwd", timeoutSeconds: 120 });
    expect(
      parseSandboxExecuteInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 1,
        toolCallID: "tool-call-2",
        capability: "code-tool",
        request: {
          toolId: "make_video",
          input: { title: "Demo" },
          identity: {
            projectId: "project",
            environment: "development",
            agentId: "agent",
            deploymentId: "deployment",
            sessionId: "session",
            turnId: "turn",
            messageId: "message",
            toolCallId: "tool-call-2",
            providerCallId: "provider-tool-call-2",
          },
        },
      }),
    ).toMatchObject({
      capability: "code-tool",
      request: {
        toolId: "make_video",
        input: { title: "Demo" },
        messageId: "message",
        agentId: "agent",
        identity: {
          turnId: "turn",
          toolCallId: "tool-call-2",
          providerCallId: "provider-tool-call-2",
        },
      },
    });
    // A code tool call is refused without a host identity naming this
    // session and call; the message and agent are read from it, never sent alone.
    for (const request of [
      { toolId: "make_video", input: {}, messageId: "message", agentId: "agent" },
      {
        toolId: "make_video",
        input: {},
        identity: {
          projectId: "project",
          environment: "development",
          agentId: "agent",
          deploymentId: "deployment",
          sessionId: "other-session",
          turnId: "turn",
          messageId: "message",
          toolCallId: "tool-call-2",
        },
      },
      {
        toolId: "make_video",
        input: {},
        identity: {
          projectId: "project",
          environment: "staging",
          agentId: "agent",
          deploymentId: "deployment",
          sessionId: "session",
          turnId: "turn",
          messageId: "message",
          toolCallId: "tool-call-2",
        },
      },
    ]) {
      expect(() =>
        parseSandboxExecuteInput({
          sessionID: "session",
          sandboxId: "microvm",
          generation: 1,
          toolCallID: "tool-call-2",
          capability: "code-tool",
          request,
        }),
      ).toThrow("request.identity is invalid");
    }
    expect(() =>
      parseSandboxExecuteInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 1,
        toolCallID: "tool-call",
        capability: "browser",
        request: { command: "pwd" },
      }),
    ).toThrow("Unsupported sandbox capability");
  });

  it("requires a command timeout within the ceiling", () => {
    const exec = (timeoutSeconds: unknown) =>
      parseSandboxExecuteInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 1,
        toolCallID: "tool-call",
        capability: "exec",
        request: { command: "npm test", timeoutSeconds },
      });
    expect(exec(COMMAND_TIMEOUT_MAX_SECONDS).request).toMatchObject({ timeoutSeconds: 1_800 });
    for (const value of [undefined, 0, -1, 1.5, "120", COMMAND_TIMEOUT_MAX_SECONDS + 1]) {
      expect(() => exec(value)).toThrow("timeoutSeconds must be an integer between 1 and 1800");
    }
  });

  it("accepts fenced operation cancel requests with a bounded reason", () => {
    expect(
      parseSandboxExecuteCancelInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 2,
        toolCallID: "tool-call",
        reason: "interrupted",
      }),
    ).toEqual({
      sessionID: "session",
      sandboxId: "microvm",
      generation: 2,
      toolCallID: "tool-call",
      reason: "interrupted",
    });
    expect(
      parseSandboxExecuteCancelInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 2,
        toolCallID: "tool-call",
      }).reason,
    ).toBe("stop");
    expect(() =>
      parseSandboxExecuteCancelInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 0,
        toolCallID: "tool-call",
      }),
    ).toThrow("generation must be a positive integer");
  });

  it("accepts fenced operation status requests", () => {
    expect(
      parseSandboxExecuteStatusInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 2,
        toolCallID: "tool-call",
        after: 4,
      }),
    ).toEqual({
      sessionID: "session",
      sandboxId: "microvm",
      generation: 2,
      toolCallID: "tool-call",
      after: 4,
    });
    expect(() =>
      parseSandboxExecuteStatusInput({
        sessionID: "session",
        sandboxId: "microvm",
        generation: 2,
        toolCallID: "tool-call",
        after: -1,
      }),
    ).toThrow("after must be a non-negative integer");
  });
});

describe("the liveness probe's reading of a supervisor health reply", () => {
  /**
   * Recorded from `git show f19dcad:src/microvm/supervisor.ts`, the
   * `/health` route: `{ status, runtime, opencode, sessionId, pool,
   * toolSandbox }`, no generation, no boot id (`pool` is undefined and
   * dropped by JSON). The supervisor from before the command contract.
   */
  const preContractHealth = {
    status: "ok",
    runtime: "running",
    opencode: "running",
    sessionId: "session-1",
    toolSandbox: "ready",
  };
  const currentHealth = { ...preContractHealth, generation: 3, bootId: "boot-a", operations: { running: 0 } };
  const expected = { sessionID: "session-1", generation: 3 };

  it("reports the pre-contract supervisor as unverifiable rather than alive or merely dead", () => {
    const verdict = interpretSupervisorHealth(preContractHealth, expected);
    expect(verdict.alive).toBe(false);
    if (verdict.alive) return;
    expect(verdict.supervisor).toBe("unverifiable");
    expect(verdict.reason).toContain("does not report its generation");
  });

  it("reports the current supervisor alive for its own session and generation, with its boot id", () => {
    expect(interpretSupervisorHealth(currentHealth, expected)).toEqual({ alive: true, bootId: "boot-a" });
  });

  it("is not alive for another session, another generation, or without a tool sandbox, and never unverifiable for those", () => {
    for (const health of [
      { ...currentHealth, sessionId: "session-2" },
      { ...currentHealth, generation: 2 },
      { ...currentHealth, toolSandbox: undefined },
      null,
      "ready",
    ]) {
      const verdict = interpretSupervisorHealth(health, expected);
      expect(verdict.alive).toBe(false);
      if (verdict.alive) return;
      expect(verdict.supervisor).toBeUndefined();
    }
  });
});

describe("sandbox supervisor readiness", () => {
  const expected = { sessionID: "session-1", generation: 3 };
  const ready = {
    status: "ok",
    sessionId: "session-1",
    toolSandbox: "ready",
    generation: 3,
    bootId: "boot-a",
  };

  it("waits through the AWS running-before-listening race and incomplete lifecycle state", async () => {
    const responses = [
      new Response(null, { status: 502 }),
      Response.json({ ...ready, toolSandbox: undefined }),
      Response.json(ready),
    ];
    let probes = 0;
    const slept: number[] = [];

    await expect(
      waitForSupervisorReady(
        expected,
        async () => responses[probes++]!,
        {
          attempts: 3,
          delayMs: 25,
          sleep: async (delayMs) => { slept.push(delayMs); },
        },
      ),
    ).resolves.toEqual({ bootId: "boot-a" });
    expect(probes).toBe(3);
    expect(slept).toEqual([25, 25]);
  });

  it("reports the last readiness failure after the retry budget", async () => {
    await expect(
      waitForSupervisorReady(
        expected,
        async () => new Response(null, { status: 502 }),
        { attempts: 2, delayMs: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow("Timed out waiting for sandbox supervisor readiness: supervisor returned 502");
  });
});

describe("the supervisor endpoint cache behind status polling", () => {
  // Re-review, architecture: every status poll, about one a second for
  // the length of a command, went through GetMicrovm and minted a new
  // five-minute proxy token. The endpoint and token are reused within
  // the token's validity and the computer's generation, refreshed on a
  // rejection or a generation change.
  function harness(nowMs = 1_000_000) {
    let now = nowMs;
    const calls = { fresh: 0 };
    const cache = new MicrovmEndpointCache({ validityMs: 300_000, refreshMarginMs: 30_000, now: () => now });
    const fresh = async () => {
      calls.fresh += 1;
      return { base: "https://vm.example", token: `token-${String(calls.fresh)}`, port: 8080 };
    };
    return { cache, fresh, calls, advance: (ms: number) => (now += ms) };
  }

  it("performs one lookup and one mint for a command's polls within the token's validity, and one more per validity window", async () => {
    const h = harness();
    const seen = new Set<string>();
    // A command polled once a second for four minutes.
    for (let poll = 0; poll < 240; poll++) {
      seen.add((await h.cache.resolve("vm-1", 1, h.fresh))!.token);
      h.advance(1_000);
    }
    expect(h.calls.fresh).toBe(1);
    expect([...seen]).toEqual(["token-1"]);
    // Past the validity less the margin (4.5 minutes): refreshed once, then reused.
    h.advance(31_000);
    for (let poll = 0; poll < 60; poll++) {
      seen.add((await h.cache.resolve("vm-1", 1, h.fresh))!.token);
      h.advance(1_000);
    }
    expect(h.calls.fresh).toBe(2);
    expect([...seen]).toEqual(["token-1", "token-2"]);
  });

  it("refreshes on a generation change, on invalidation, and never caches an unavailable computer", async () => {
    const h = harness();
    expect((await h.cache.resolve("vm-1", 1, h.fresh))!.token).toBe("token-1");
    expect((await h.cache.resolve("vm-1", 2, h.fresh))!.token).toBe("token-2");
    expect((await h.cache.resolve("vm-1", 2, h.fresh))!.token).toBe("token-2");
    h.cache.invalidate("vm-1");
    expect((await h.cache.resolve("vm-1", 2, h.fresh))!.token).toBe("token-3");
    expect(h.calls.fresh).toBe(3);
    expect(await h.cache.resolve("vm-2", 1, async () => null)).toBeNull();
    expect(h.cache.size).toBe(1);
    expect((await h.cache.resolve("vm-2", 1, h.fresh))!.token).toBe("token-4");
  });

  it("shares one refresh between concurrent resolves of the same computer", async () => {
    const h = harness();
    const resolved = await Promise.all([1, 2, 3].map(() => h.cache.resolve("vm-1", 1, h.fresh)));
    expect(resolved.map((endpoint) => endpoint!.token)).toEqual(["token-1", "token-1", "token-1"]);
    expect(h.calls.fresh).toBe(1);
  });

  it("does not keep a refresh that failed", async () => {
    const h = harness();
    await expect(h.cache.resolve("vm-1", 1, async () => { throw new Error("AWS unavailable"); })).rejects.toThrow("AWS unavailable");
    expect((await h.cache.resolve("vm-1", 1, h.fresh))!.token).toBe("token-1");
  });
});
