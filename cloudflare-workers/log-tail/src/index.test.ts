import assert from "node:assert/strict";
import test from "node:test";
import worker from "./index.ts";

const env = {
  AXIOM_HOST: "https://axiom.test",
  AXIOM_DATASET: "edge",
  AXIOM_TOKEN: "test-token",
};

test("records a silent HTTP 5xx even when the invocation outcome is ok", async () => {
  const originalFetch = globalThis.fetch;
  let records: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    records = JSON.parse(String(init?.body));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    await worker.tail([{
      scriptName: "agt_test",
      outcome: "ok",
      eventTimestamp: Date.parse("2026-07-13T20:00:00Z"),
      event: {
        request: { method: "POST", url: "https://dispatch.test/agents/example/session" },
        response: { status: 500 },
      },
      logs: [],
      exceptions: [],
    }], env, {} as ExecutionContext);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(records.length, 1);
  assert.equal(records[0]?.level, "ERROR");
  assert.equal(records[0]?.msg, "worker request returned HTTP 500");
  assert.equal(records[0]?.service, "agt_test");
  assert.equal(records[0]?.response_status, 500);
});

test("fails the collector invocation when the durable sink rejects a batch", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ code: 403, message: "not allowed to ingest into dataset" }),
    { status: 403 },
  )) as typeof fetch;
  console.error = () => {};

  try {
    await assert.rejects(
      worker.tail([{
        scriptName: "agt_test",
        outcome: "exception",
        eventTimestamp: Date.parse("2026-07-13T20:00:00Z"),
        logs: [],
        exceptions: [],
      }], env, {} as ExecutionContext),
      /axiom ingest failed status=403/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
