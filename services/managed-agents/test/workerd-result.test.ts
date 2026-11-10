import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { ResultCommitInput, ResultCommitOutcome, SessionIdentity } from "../src/protocol.js";
import {
  ResultCommitTransportError,
  type ResultCommitter,
} from "../src/runtime/session-result.js";

/**
 * Drives the Workerd host's result commit (C1) with a scripted sandbox and
 * a scripted committer: the sandbox "runs" the tool by echoing the call's
 * input as the tool's output, and the committer stands in for the edge
 * route. What is under test is the host's own protocol: validate against
 * the pinned schema, commit under the managed turn and this activation,
 * return to the model only after the acknowledgement, retry a lost
 * acknowledgement under the same call id, and fail the call on a definite
 * rejection or a turn that is no longer this host's.
 */

interface Host {
  env: Record<string, unknown>;
  bootID: string;
  activation: number;
  results: (context: unknown) => ResultCommitter;
  ensurePlatformSchema(): void;
  pinSandboxContext(context: {
    accountId: string;
    managedSessionId: string;
    edge: string;
    runtimeToken: string;
  }): void;
  claimTurnLease(sessionID: string, turnId: string, identity?: SessionIdentity): void;
  releaseTurnLease(sessionID: string, turnId?: string): void;
  executeSandboxTool(
    definition: {
      toolId: string;
      capability: "exec" | "code-tool";
      sandboxRequest: (input: unknown) => unknown;
      commandTimeoutSeconds?: (input: unknown) => number;
    },
    input: unknown,
    sessionID: string,
    toolCallID: string,
    context: { messageId: string; agentId?: string },
    reportProgress?: (metadata: Record<string, unknown>) => Promise<void>,
  ): Promise<{ content: string; metadata: Record<string, unknown> }>;
}

interface TestTool {
  toolId: string;
  capability: "exec" | "code-tool";
  sandboxRequest(input: unknown): unknown;
  commandTimeoutSeconds?: (input: unknown) => number;
}

const encode = (value: string) => btoa(unescape(encodeURIComponent(value)));

const output = {
  type: "object",
  properties: {
    branch: { type: "string" },
    pr: {
      type: "object",
      properties: { number: { type: "integer" } },
      required: ["number"],
      additionalProperties: false,
    },
  },
  required: ["branch"],
  additionalProperties: false,
};

/** A deployed agent with one result tool (`report`) and one ordinary tool (`lookup`). */
const artifactBundle = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    files: [
      {
        path: "agent.js",
        content: encode(`
          import { useTool } from "./opencomputer-agent.js";
          import { report, lookup } from "./tools/report.js";
          export default function agent() { useTool(report); useTool(lookup); return "Report when known."; }
        `),
      },
      {
        path: "opencomputer-agent.js",
        content: encode(`
          const hooks = () => globalThis[Symbol.for("opencomputer.agent-hooks")];
          export const useTool = (tool) => hooks().useTool(tool);
        `),
      },
      {
        path: "tools/report.js",
        content: encode(`
          export const report = { kind: "tool", version: 1, id: "report", name: "report", description: "Report", output: ${JSON.stringify(output)}, result: true, run: async ({ input }) => input };
          export const lookup = { kind: "tool", version: 1, id: "lookup", name: "lookup", description: "Look up", run: async () => "looked up" };
        `),
      },
      {
        path: ".opencomputer/reactive.json",
        content: encode(
          JSON.stringify({
            version: 2,
            entry: "../agent.js",
            tools: ["lookup", "report"],
            toolModules: ["../tools/report.js"],
            connections: [],
            mcpServers: [],
            resultTool: { id: "report", output },
          }),
        ),
      },
    ],
  }),
);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const artifacts = { fetch: async () => new Response(artifactBundle) };

const managedSessionId = "managed-result";
const openCodeSessionId = "oc-session";
const sessions = (env as unknown as { OPENCODE_SESSIONS: DurableObjectNamespace }).OPENCODE_SESSIONS;
let counter = 0;

/**
 * The sandbox adapter as the host sees it: one lease, and a tool operation
 * whose output is the call's input echoed as JSON, the way the supervisor
 * returns a result tool's value. `beforeCompleted` runs when the host
 * polls the finished operation, before it learns the result. Replies
 * carry the supervisor's boot id as the current supervisor's do; one
 * without it is the pre-contract supervisor and retires the computer.
 */
const scriptedBootId = "boot-scripted";

class FakeSandbox {
  readonly executions: Array<Record<string, unknown>> = [];
  beforeCompleted: (() => void) | undefined;

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith("/v1/sandboxes/ensure")) {
      return Response.json({ sandboxId: "sandbox-1", expiresAtMs: Date.now() + 60 * 60_000 });
    }
    if (url.endsWith("/v1/sandboxes/execute")) {
      if (!this.executions.some((candidate) => candidate.toolCallID === body.toolCallID)) {
        this.executions.push(body);
      }
      return Response.json({ operationId: body.toolCallID, status: "running", bootId: scriptedBootId });
    }
    if (url.endsWith("/v1/sandboxes/execute/status")) {
      const execution = this.executions.find((candidate) => candidate.toolCallID === body.toolCallID);
      const request = execution?.request as { input?: unknown; command?: string } | undefined;
      this.beforeCompleted?.();
      this.beforeCompleted = undefined;
      return Response.json({
        operationId: body.toolCallID,
        status: "completed",
        bootId: scriptedBootId,
        progress: [],
        result:
          typeof request?.command === "string"
            ? { stdout: request.command, stderr: "", exitCode: 0 }
            : { content: JSON.stringify(request?.input ?? null) },
      });
    }
    return Response.json({ error: `unexpected sandbox call ${url}` }, { status: 500 });
  };
}

const sessionIdentity: SessionIdentity = {
  projectId: "prj_result",
  environment: "development",
  agentId: "worker",
  deploymentId: "dep_result",
  sessionId: managedSessionId,
};

const reportTool = {
  toolId: "report",
  capability: "code-tool" as const,
  sandboxRequest: (input: unknown) => ({ toolId: "report", input }),
};
const lookupTool = { ...reportTool, toolId: "lookup", sandboxRequest: (input: unknown) => ({ toolId: "lookup", input }) };
const commandTool = {
  toolId: "sandbox_exec",
  capability: "exec" as const,
  sandboxRequest: (input: unknown) => ({
    command: (input as { command: string }).command,
    timeoutSeconds: 30,
  }),
  commandTimeoutSeconds: () => 30,
};

class Session {
  readonly stub: DurableObjectStub;
  readonly sandbox = new FakeSandbox();
  readonly commits: ResultCommitInput[] = [];
  committer: ResultCommitter = async (input) => {
    this.commits.push(input);
    return {
      status: "committed",
      replayed: false,
      receipt: { turnId: input.turnId, callId: input.callId, reportedAt: "2026-09-15T00:00:00.000Z", eventId: "event-1" },
    };
  };

  constructor() {
    this.stub = sessions.getByName(`result-${String(++counter)}`);
  }

  static async create(): Promise<Session> {
    const session = new Session();
    const digest = await sha256(artifactBundle);
    await session.run((instance) => {
      instance.ensurePlatformSchema();
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "INSERT INTO workerd_deployment (slot, deployment_json) VALUES (1, ?)",
        JSON.stringify({
          id: "dep_result",
          artifact: { bucket: "test", key: digest, digest, size: artifactBundle.byteLength },
        }),
      );
      instance.pinSandboxContext({
        accountId: "acct",
        managedSessionId,
        edge: "https://edge.test",
        runtimeToken: "rt-secret",
      });
      instance.claimTurnLease(openCodeSessionId, "turn-1", sessionIdentity);
    });
    return session;
  }

  run<T>(body: (instance: Host) => Promise<T> | T): Promise<T> {
    return runInDurableObject(this.stub, (raw) => {
      const instance = raw as unknown as Host;
      instance.env = { ...instance.env, ARTIFACTS: artifacts, SANDBOX: this.sandbox };
      instance.results = () => (input) => this.committer(input);
      return body(instance);
    });
  }

  /** One result tool call; the returned content is what the model would receive. */
  call(
    tool: TestTool = reportTool,
    input: unknown = { branch: "task/1", pr: { number: 7 } },
    callId = "call-1",
    messageId = "msg-1",
  ) {
    return this.run((instance) =>
      instance.executeSandboxTool(tool, input, openCodeSessionId, callId, { messageId, agentId: "worker" }),
    );
  }
}

describe("the Workerd host owns logical tool-call identity", () => {
  it("does not alias the same provider call label across different turns", async () => {
    const session = await Session.create();
    const first = await session.call(commandTool, { command: "printf discovery" }, "call_0", "msg-discovery");
    await session.run((instance) =>
      instance.claimTurnLease(openCodeSessionId, "turn-2", sessionIdentity),
    );
    const second = await session.call(commandTool, { command: "printf testing" }, "call_0", "msg-testing");

    expect(first.content).toContain("printf discovery");
    expect(second.content).toContain("printf testing");
    expect(session.sandbox.executions).toHaveLength(2);
    const [discovery, testing] = session.sandbox.executions;
    expect(discovery!.toolCallID).not.toBe(testing!.toolCallID);
    expect(discovery!.toolCallID).not.toBe("call_0");
    expect(testing!.toolCallID).not.toBe("call_0");
    expect(discovery!.request).toMatchObject({
      identity: { toolCallId: discovery!.toolCallID, providerCallId: "call_0", turnId: "turn-1" },
    });
    expect(testing!.request).toMatchObject({
      identity: { toolCallId: testing!.toolCallID, providerCallId: "call_0", turnId: "turn-2" },
    });
  });

  it("converges an exact replay and rejects changed input under one logical identity", async () => {
    const session = await Session.create();
    await session.call(commandTool, { command: "printf once" }, "call_0", "msg-1");
    await session.call(commandTool, { command: "printf once" }, "call_0", "msg-1");
    expect(session.sandbox.executions).toHaveLength(1);

    await expect(
      session.call(commandTool, { command: "printf changed" }, "call_0", "msg-1"),
    ).rejects.toThrow("its input changed");
    expect(session.sandbox.executions).toHaveLength(1);
  });
});

describe("the Workerd host commits the result tool's output before the model sees success", () => {
  it("validates, commits under the leased turn and this activation, then returns the content", async () => {
    const session = await Session.create();
    const order: string[] = [];
    const committer = session.committer;
    session.committer = async (input) => {
      order.push("commit");
      return committer(input);
    };
    const result = await session.call();
    order.push("returned");
    expect(order).toEqual(["commit", "returned"]);
    expect(result.content).toBe('{"branch":"task/1","pr":{"number":7}}');
    const generation = await session.run((instance) => ({ bootId: instance.bootID, activation: instance.activation }));
    expect(session.commits).toEqual([
      {
        turnId: "turn-1",
        callId: "call-1",
        tool: "report",
        messageId: "msg-1",
        runtime: { kind: "workerd", bootId: generation.bootId, activation: generation.activation },
        data: { branch: "task/1", pr: { number: 7 } },
      },
    ]);
    // An ordinary tool never commits.
    await expect(session.call(lookupTool, { q: 1 }, "call-2")).resolves.toMatchObject({ content: '{"q":1}' });
    expect(session.commits).toHaveLength(1);
  });

  it("fails the call on output that does not match the pinned schema, without committing", async () => {
    const session = await Session.create();
    await expect(session.call(reportTool, { branch: 12 })).rejects.toThrow("does not match its output schema");
    await expect(session.call(reportTool, { branch: "x".repeat(9_000) }, "call-2")).rejects.toThrow("exceeds 8192 bytes");
    expect(session.commits).toHaveLength(0);
  });

  it("fails the call on a definite rejection, and the previous result is the session's business", async () => {
    const session = await Session.create();
    session.committer = async () => ({
      status: "rejected",
      reason: "stale_turn",
      message: "The turn that produced the result is no longer running",
    });
    await expect(session.call()).rejects.toThrow("Result rejected: The turn that produced the result is no longer running");
  });

  it("retries a lost acknowledgement under the same call id and returns once the receipt arrives", async () => {
    const session = await Session.create();
    const base = session.committer;
    let attempts = 0;
    session.committer = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new ResultCommitTransportError("connection reset");
      const outcome = await base(input);
      return { ...outcome, replayed: true } as ResultCommitOutcome;
    };
    const result = await session.call();
    expect(result.content).toBe('{"branch":"task/1","pr":{"number":7}}');
    expect(attempts).toBe(2);
    expect(session.commits.map((commit) => commit.callId)).toEqual(["call-1"]);
  });

  it("fails the call when no acknowledgement ever arrives", async () => {
    const session = await Session.create();
    session.committer = vi.fn(async () => {
      throw new ResultCommitTransportError("gateway timeout");
    });
    await expect(session.call()).rejects.toThrow("could not be committed after 4 attempts");
    expect(session.committer).toHaveBeenCalledTimes(4);
  }, 15_000);

  it("fails the call when the turn was cancelled between execution and commit", async () => {
    const session = await Session.create();
    // The tool finished in the sandbox; before the host commits, the turn
    // is interrupted and the lease released. Nothing may be attributed.
    await session.run((instance) => {
      session.sandbox.beforeCompleted = () => instance.releaseTurnLease(openCodeSessionId);
    });
    await expect(session.call()).rejects.toThrow("the turn that dispatched this call is no longer running");
    expect(session.commits).toHaveLength(0);
  });

  it("never commits a call held past its turn under the turn that replaced it", async () => {
    // Review finding 5, Workerd half: the helper looked up the current
    // lease after execution, so a call dispatched under turn-1 that
    // finished after turn-2 took the lease committed under turn-2.
    const session = await Session.create();
    await session.run((instance) => {
      session.sandbox.beforeCompleted = () => {
        instance.releaseTurnLease(openCodeSessionId, "turn-1");
        instance.claimTurnLease(openCodeSessionId, "turn-2", sessionIdentity);
      };
    });
    await expect(session.call()).rejects.toThrow("the turn that dispatched this call is no longer running");
    expect(session.commits.map((commit) => commit.turnId)).not.toContain("turn-2");
    expect(session.commits).toHaveLength(0);
  });

  it("refuses a result call dispatched with no managed turn", async () => {
    const session = await Session.create();
    await session.run((instance) => instance.releaseTurnLease(openCodeSessionId));
    await expect(session.call()).rejects.toThrow("no managed turn was running when this call was dispatched");
    expect(session.commits).toHaveLength(0);
  });
});
