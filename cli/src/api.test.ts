import assert from "node:assert/strict";
import test from "node:test";

import { OpenComputerClient } from "./api.js";

test("mutations derive stable, operation-specific idempotency headers", async (context) => {
  const requests: Request[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ id: "project", agents: [], environments: [] });
  });
  const client = new OpenComputerClient(
    { apiUrl: "https://app.opencomputer.dev", apiKey: "test" },
    "retry-42",
  );

  await client.createProject("Agent", "agent");
  await client.createProject("Agent", "agent");
  await client.createProject("Different", "different");

  const keys = requests.map((request) => request.headers.get("idempotency-key"));
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.equal(keys[0]?.includes("retry-42"), false);
});
