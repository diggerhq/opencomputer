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
        request: {
          method: "POST",
          url: "https://user:password@dispatch.test/agents/example/session?token=secret#fragment",
        },
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
  assert.equal(records[0]?.request_url, "https://dispatch.test/agents/example/session");
  assert.equal(JSON.stringify(records[0]).includes("secret"), false);
  assert.equal(JSON.stringify(records[0]).includes("password"), false);
});

test("redacts the webhook credential segment from request URLs", async () => {
  const originalFetch = globalThis.fetch;
  let records: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    records = JSON.parse(String(init?.body));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const token = "ocwh_dummy-credential-segment_0123456789";

  try {
    await worker.tail([{
      scriptName: "api-edge",
      outcome: "ok",
      eventTimestamp: Date.parse("2026-09-08T20:00:00Z"),
      event: {
        request: {
          method: "POST",
          url: `https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef/${token}`,
        },
        response: { status: 502 },
      },
      logs: [],
      exceptions: [],
    }, {
      scriptName: "managed-agents",
      outcome: "ok",
      eventTimestamp: Date.parse("2026-09-08T20:00:01Z"),
      event: {
        request: {
          method: "POST",
          url: `https://managedagents.example/v1/agent-webhooks/wh_0123456789abcdef0123456789abcdef/${token}`,
        },
        response: { status: 502 },
      },
      logs: [],
      exceptions: [],
    }, {
      scriptName: "api-edge",
      outcome: "ok",
      eventTimestamp: Date.parse("2026-09-08T20:00:02Z"),
      event: {
        request: {
          method: "POST",
          url: `https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef/${token}/extra/`,
        },
        response: { status: 502 },
      },
      logs: [],
      exceptions: [],
    }, {
      scriptName: "managed-agents",
      outcome: "ok",
      eventTimestamp: Date.parse("2026-09-08T20:00:03Z"),
      event: {
        request: { method: "POST", url: "https://managedagents.example/v1/other" },
        response: { status: 500 },
      },
      // A console message that quoted the path, as an unredacted emitter would.
      logs: [{
        level: "error",
        timestamp: Date.parse("2026-09-08T20:00:03Z"),
        message: [`{"event":"edge.request_failed","path":"/v1/agent-webhooks/wh_0123456789abcdef0123456789abcdef/${token}"}`],
      }],
      exceptions: [],
    }], env, {} as ExecutionContext);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(records.length, 4);
  assert.equal(
    records[3]?.msg,
    `{"event":"edge.request_failed","path":"/v1/agent-webhooks/wh_0123456789abcdef0123456789abcdef/redacted"}`,
  );
  assert.equal(
    records[2]?.request_url,
    "https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef/redacted",
  );
  assert.equal(
    records[0]?.request_url,
    "https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef/redacted",
  );
  assert.equal(
    records[1]?.request_url,
    "https://managedagents.example/v1/agent-webhooks/wh_0123456789abcdef0123456789abcdef/redacted",
  );
  assert.equal(JSON.stringify(records).includes(token), false);
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
