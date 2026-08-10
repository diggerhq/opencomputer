import assert from "node:assert/strict";
import test from "node:test";

import { startGateway } from "./local.js";

test("the local gateway proxies connection list and calendar requests", async () => {
  const originalFetch = globalThis.fetch;
  const upstream: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    upstream.push({ url, init });
    if (url.endsWith("/connections")) {
      return Response.json({ connections: [] });
    }
    return Response.json({
      service: "calendar",
      status: "pending",
      authorizationUrl: "https://connect.composio.dev/link/test",
    });
  }) as typeof fetch;

  const gateway = await startGateway({
    apiUrl: "https://mo-oc-dev.com",
    apiKey: "oc_test",
  });
  try {
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      "content-type": "application/json",
    };
    const listed = await originalFetch(`${gateway.url}/opencomputer/fetch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "list" }),
    });
    assert.equal(listed.status, 200);
    assert.equal(
      upstream[0]?.url,
      "https://mo-oc-dev.com/api/managed-agents/connections",
    );
    assert.equal(upstream[0]?.init?.method, "GET");

    const requested = await originalFetch(`${gateway.url}/opencomputer/fetch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "request",
        service: "calendar",
        label: "work-calendar",
      }),
    });
    assert.equal(requested.status, 200);
    assert.equal(
      upstream[1]?.url,
      "https://mo-oc-dev.com/api/managed-agents/connections/link",
    );
    assert.equal(upstream[1]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(upstream[1]?.init?.body)), {
      service: "calendar",
      label: "work-calendar",
    });
  } finally {
    await gateway.close();
    globalThis.fetch = originalFetch;
  }
});

test("the local gateway authenticates React requests to the cloud agent API", async () => {
  const originalFetch = globalThis.fetch;
  const upstream: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    upstream.push({ url: String(input), init });
    return Response.json({ session: { id: "ses_cloud" } }, { status: 201 });
  }) as typeof fetch;

  const gateway = await startGateway({
    apiUrl: "https://mo-oc-dev.com",
    apiKey: "oc_test",
  });
  try {
    const response = await originalFetch(
      `${gateway.url}/managed-agents/sessions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${gateway.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "hello@development" }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal(
      upstream[0]?.url,
      "https://mo-oc-dev.com/api/managed-agents/sessions",
    );
    assert.equal(
      new Headers(upstream[0]?.init?.headers).get("x-api-key"),
      "oc_test",
    );
  } finally {
    await gateway.close();
    globalThis.fetch = originalFetch;
  }
});
