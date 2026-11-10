import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  executeDeterministicOperation,
  type SpikeExecutionSnapshot,
  type SpikeOperation,
} from "../spikes/do-first-session/protocol.js";

const edgeOnly: SpikeOperation[] = [
  { id: "one", kind: "edge.compute", input: { operation: "concat", values: ["hello", " "] } },
  { id: "two", kind: "edge.compute", input: { operation: "concat", values: ["world"] } },
];

const mixed: SpikeOperation[] = [
  edgeOnly[0]!,
  { id: "read", kind: "sandbox.fs", input: { path: "/workspace/README.md" } },
  edgeOnly[1]!,
  { id: "exec", kind: "sandbox.exec", input: { command: "npm test" } },
];

const currentAgentTurn: SpikeOperation[] = [
  {
    id: "agent-loop",
    kind: "runtime.agent",
    input: { engine: "opencode", render: "deployment-bundle" },
  },
  mixed[1]!,
];

async function post(path: string, body?: unknown): Promise<SpikeExecutionSnapshot> {
  const response = await SELF.fetch(`https://spike.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json<SpikeExecutionSnapshot>();
}

describe("DO-first session escalation spike", () => {
  it("completes an edge-only session without starting a runtime", async () => {
    await post("/sessions/edge-only/initialize", {
      sessionId: "edge-only",
      deploymentId: "deployment-1",
      plan: edgeOnly,
    });
    const completed = await post("/sessions/edge-only/edge");
    expect(completed).toMatchObject({
      mode: "completed",
      continuation: 2,
      metrics: { runtimeStarts: 0, edgeOperations: 2, sandboxOperations: 0 },
    });
  });

  it("persists one capability fault and resumes at the faulting operation", async () => {
    await post("/sessions/mixed/initialize", {
      sessionId: "mixed",
      deploymentId: "deployment-2",
      plan: mixed,
    });
    const faulted = await post("/sessions/mixed/edge");
    expect(faulted).toMatchObject({
      mode: "awaiting_runtime",
      continuation: 1,
      fault: { operationId: "read", operationIndex: 1, capability: "fs" },
      metrics: { runtimeStarts: 1, edgeOperations: 1, sandboxOperations: 0 },
    });
    const replayed = await post("/sessions/mixed/edge");
    expect(replayed).toEqual(faulted);

    await post("/sessions/mixed/runtime/ack", {
      escalationEpoch: faulted.escalationEpoch,
    });
    let current = faulted;
    for (const operation of mixed.slice(faulted.continuation)) {
      current = await post("/sessions/mixed/runtime/result", {
        escalationEpoch: faulted.escalationEpoch,
        operationId: operation.id,
        value: executeDeterministicOperation(operation),
      });
    }
    expect(current).toMatchObject({
      mode: "completed",
      continuation: mixed.length,
      metrics: { runtimeStarts: 1, edgeOperations: 1, sandboxOperations: 3 },
    });
    expect(current.results.map((result) => result.value)).toEqual(
      mixed.map(executeDeterministicOperation),
    );
  });

  it("makes runtime acknowledgement and result delivery retry-safe", async () => {
    await post("/sessions/retry-safe/initialize", {
      sessionId: "retry-safe",
      deploymentId: "deployment-3",
      plan: mixed,
    });
    const faulted = await post("/sessions/retry-safe/edge");
    const firstAck = await post("/sessions/retry-safe/runtime/ack", {
      escalationEpoch: faulted.escalationEpoch,
    });
    expect(
      await post("/sessions/retry-safe/runtime/ack", {
        escalationEpoch: faulted.escalationEpoch,
      }),
    ).toEqual(firstAck);
    const value = executeDeterministicOperation(mixed[1]!);
    const committed = await post("/sessions/retry-safe/runtime/result", {
      escalationEpoch: faulted.escalationEpoch,
      operationId: "read",
      value,
    });
    expect(
      await post("/sessions/retry-safe/runtime/result", {
        escalationEpoch: faulted.escalationEpoch,
        operationId: "read",
        value,
      }),
    ).toEqual(committed);
    expect(committed.metrics.runtimeStarts).toBe(1);
  });

  it("faults immediately for the current untrusted agent engine", async () => {
    await post("/sessions/current-agent/initialize", {
      sessionId: "current-agent",
      deploymentId: "deployment-4",
      plan: currentAgentTurn,
    });
    const faulted = await post("/sessions/current-agent/edge");
    expect(faulted).toMatchObject({
      mode: "awaiting_runtime",
      continuation: 0,
      fault: {
        operationId: "agent-loop",
        operationIndex: 0,
        capability: "agent_runtime",
      },
      metrics: { runtimeStarts: 1, edgeOperations: 0, sandboxOperations: 0 },
    });
  });

});
