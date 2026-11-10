import { describe, expect, it, vi } from "vitest";

import type { ResultCommitInput, ResultCommitOutcome } from "../src/protocol.js";
import {
  commitResultToolOutput,
  commitWithRetry,
  ResultCommitTransportError,
  ResultCommitUnconfirmedError,
  ResultRejectedError,
  sessionResultCommitter,
  validateResultOutput,
} from "../src/runtime/session-result.js";

const tool = {
  id: "report",
  output: {
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
  },
};

const runtime = { kind: "microvm" as const, epoch: 2 };

function receipt(input: ResultCommitInput, replayed = false): ResultCommitOutcome {
  return {
    status: "committed",
    replayed,
    receipt: {
      turnId: input.turnId,
      callId: input.callId,
      reportedAt: "2026-09-15T00:00:00.000Z",
      eventId: `event-${input.callId}`,
    },
  };
}

describe("result output validation", () => {
  it("accepts a value that matches the pinned schema", () => {
    expect(validateResultOutput(tool.output, { branch: "task/1", pr: { number: 7 } })).toEqual({
      valid: true,
    });
  });

  it("names the first violations", () => {
    const outcome = validateResultOutput(tool.output, { pr: { number: "7" } });
    expect(outcome.valid).toBe(false);
    if (outcome.valid) return;
    expect(outcome.message).toContain("branch");
    expect(outcome.message).toContain("number");
  });
});

describe("the result commit protocol at the host", () => {
  it("validates, commits with the turn and generation, and returns the content only after acknowledgement", async () => {
    const order: string[] = [];
    const commit = vi.fn(async (input: ResultCommitInput) => {
      order.push("commit");
      return receipt(input);
    });
    const committed = await commitResultToolOutput({
      tool,
      value: { branch: "task/1", pr: { number: 7 }, ignored: undefined },
      turnId: "turn-1",
      callId: "call-1",
      runtime,
      commit,
    });
    order.push("returned");
    expect(order).toEqual(["commit", "returned"]);
    expect(commit).toHaveBeenCalledWith({
      turnId: "turn-1",
      callId: "call-1",
      tool: "report",
      runtime,
      data: { branch: "task/1", pr: { number: 7 } },
    });
    expect(committed.content).toBe('{"branch":"task/1","pr":{"number":7}}');
    expect(committed.replayed).toBe(false);
  });

  it("rejects invalid output before anything is sent", async () => {
    const commit = vi.fn();
    await expect(
      commitResultToolOutput({
        tool,
        value: { branch: 12 },
        turnId: "turn-1",
        callId: "call-1",
        runtime,
        commit,
      }),
    ).rejects.toMatchObject({
      name: "ResultRejectedError",
      reason: "invalid_output",
      message: expect.stringContaining("does not match its output schema"),
    });
    await expect(
      commitResultToolOutput({
        tool,
        value: undefined,
        turnId: "turn-1",
        callId: "call-1",
        runtime,
        commit,
      }),
    ).rejects.toMatchObject({ reason: "invalid_output" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects output past the size bound before anything is sent", async () => {
    const commit = vi.fn();
    await expect(
      commitResultToolOutput({
        tool,
        value: { branch: "x".repeat(9_000) },
        turnId: "turn-1",
        callId: "call-1",
        runtime,
        commit,
      }),
    ).rejects.toMatchObject({ reason: "result_too_large" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("fails the call on a definite rejection, with the reason the model reads", async () => {
    const commit = vi.fn(async (): Promise<ResultCommitOutcome> => ({
      status: "rejected",
      reason: "stale_turn",
      message: "The turn that produced the result is no longer running",
    }));
    await expect(
      commitResultToolOutput({
        tool,
        value: { branch: "task/1" },
        turnId: "turn-1",
        callId: "call-1",
        runtime,
        commit,
      }),
    ).rejects.toMatchObject({
      reason: "stale_turn",
      message: "Result rejected: The turn that produced the result is no longer running",
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("retries a lost acknowledgement under the same key and takes the receipt", async () => {
    let calls = 0;
    const commit = vi.fn(async (input: ResultCommitInput) => {
      calls += 1;
      // The first commit landed, but its answer never arrived.
      if (calls === 1) throw new ResultCommitTransportError("connection reset");
      return receipt(input, true);
    });
    const committed = await commitResultToolOutput({
      tool,
      value: { branch: "task/1" },
      turnId: "turn-1",
      callId: "call-1",
      runtime,
      commit,
      retry: { sleep: async () => undefined },
    });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]![0]).toEqual(commit.mock.calls[1]![0]);
    expect(committed.replayed).toBe(true);
    expect(committed.receipt.eventId).toBe("event-call-1");
  });

  it("does not retry anything but transport failures, and gives up after the attempts", async () => {
    const refused = vi.fn(async () => {
      throw new Error("Result commit was refused by the session (401)");
    });
    await expect(
      commitWithRetry(refused, { turnId: "t", callId: "c", tool: "report", runtime, data: {} }),
    ).rejects.toThrow("refused");
    expect(refused).toHaveBeenCalledTimes(1);

    const sleeps: number[] = [];
    const lost = vi.fn(async () => {
      throw new ResultCommitTransportError("gateway timeout");
    });
    await expect(
      commitWithRetry(
        lost,
        { turnId: "t", callId: "c", tool: "report", runtime, data: {} },
        { attempts: 3, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toBeInstanceOf(ResultCommitUnconfirmedError);
    expect(lost).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
  });
});

describe("the committer over the session route", () => {
  const input: ResultCommitInput = {
    turnId: "turn-1",
    callId: "call-1",
    tool: "report",
    runtime,
    data: { branch: "task/1" },
  };

  function committerAnswering(response: () => Response | Promise<Response>) {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://edge.test/v1/sessions/ses%2F1/result");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rt-secret");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return response();
    });
    return {
      fetchImpl,
      commit: sessionResultCommitter("https://edge.test/", "ses/1", "rt-secret", fetchImpl as unknown as typeof fetch),
    };
  }

  it("takes a 2xx receipt as the acknowledgement", async () => {
    const { commit } = committerAnswering(() =>
      Response.json({
        status: "committed",
        replayed: true,
        receipt: { turnId: "turn-1", callId: "call-1", reportedAt: "2026-09-15T00:00:00.000Z", eventId: "event-call-1" },
      }),
    );
    await expect(commit(input)).resolves.toEqual(receipt(input, true));
  });

  it("maps a 409 with a known reason to a definite rejection", async () => {
    const { commit } = committerAnswering(() =>
      Response.json(
        { error: { code: "result_conflict", message: "This call already committed a different value" } },
        { status: 409 },
      ),
    );
    await expect(commit(input)).resolves.toEqual({
      status: "rejected",
      reason: "result_conflict",
      message: "This call already committed a different value",
    });
  });

  it("treats a 5xx or a failed request as transport uncertainty and any other 4xx as final", async () => {
    const unavailable = committerAnswering(() => new Response("", { status: 503 }));
    await expect(unavailable.commit(input)).rejects.toBeInstanceOf(ResultCommitTransportError);
    const offline = committerAnswering(() => {
      throw new TypeError("fetch failed");
    });
    await expect(offline.commit(input)).rejects.toBeInstanceOf(ResultCommitTransportError);
    const refused = committerAnswering(() =>
      Response.json({ error: { code: "invalid_runtime_token", message: "Runtime token is invalid" } }, { status: 401 }),
    );
    const failure = await refused.commit(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ResultCommitTransportError);
    expect(failure).not.toBeInstanceOf(ResultRejectedError);
  });
});
