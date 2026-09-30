import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyManagedAgents } from "./managed_agents";

const env = {
  OC_MANAGED_AGENTS_SECRET: "test-secret",
  MANAGED_AGENTS_API_URL: "https://managedagents.test",
};
const caller = { orgID: "org_test", userID: "user_test" };

function backendResult(overrides: Record<string, unknown> = {}) {
  return {
    resultId: "result_0123",
    projectId: "prj_1",
    environment: "development",
    agentId: "agent_1",
    deploymentId: "dep_1",
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: null,
    toolCallId: "call-1",
    resultTool: "submit_result",
    schemaId: "example.result/v1",
    schemaDigest: "sha256:aa",
    dataDigest: "sha256:bb",
    data: { finding: "ok", userId: "kept-verbatim" },
    eventId: "event-private",
    createdAt: "2026-09-25T00:00:00.000Z",
    accountId: "acct_private",
    ...overrides,
  };
}

const publicResult = {
  resultId: "result_0123",
  projectId: "prj_1",
  environment: "development",
  agentId: "agent_1",
  deploymentId: "dep_1",
  sessionId: "session-1",
  turnId: "turn-1",
  messageId: null,
  toolCallId: "call-1",
  resultTool: "submit_result",
  schemaId: "example.result/v1",
  schemaDigest: "sha256:aa",
  dataDigest: "sha256:bb",
  data: { finding: "ok", userId: "kept-verbatim" },
  createdAt: "2026-09-25T00:00:00.000Z",
};

describe("session result history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists a session's results with the query passed through and the platform envelope stripped", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        results: [backendResult(), backendResult({ resultId: "result_0124" })],
        nextCursor: "c2VxOjI",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/results?limit=2&cursor=c2VxOjA",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(response.status).toBe(200);
    const [url] = fetchSpy.mock.calls[0] as unknown as [URL | string];
    expect(String(url)).toBe(
      "https://managedagents.test/v1/sessions/session-1/results?limit=2&cursor=c2VxOjA",
    );
    expect(await response.json()).toEqual({
      results: [publicResult, { ...publicResult, resultId: "result_0124" }],
      nextCursor: "c2VxOjI",
    });
  });

  it("answers an empty list for a turn without a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results: [], nextCursor: null })),
    );
    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/turns/turn-9/results",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [], nextCursor: null });
  });

  it("reads one result by id and passes result_not_found through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(backendResult())));
    const found = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/results/result_0123",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(publicResult);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "result_not_found", message: "Result not found" } },
          { status: 404 },
        ),
      ),
    );
    const missing = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/results/result_none",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "result_not_found" },
    });
  });

  it("only reads result history", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/results",
        { method: "POST", body: "{}" },
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the session data digest and revision on session creation", async () => {
    const body = {
      agentId: "agent@development",
      sessionData: { schema: "example.session-context/v1", mode: "test" },
    };
    const fetchSpy = vi.fn(async () =>
      Response.json(
        {
          session: {
            id: "session-1",
            executionMode: "workerd",
            status: "starting",
            createdAt: "2026-09-25T00:00:00.000Z",
            sessionDataDigest: "sha256:cc",
            sessionDataRevision: 1,
            runtimeEpoch: 1,
          },
          runtimeToken: "private-token",
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "session-example-001",
        },
        body: JSON.stringify(body),
      }),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(response.status).toBe(201);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(await new Response(init.body).text()).toBe(JSON.stringify(body));
    expect(new Headers(init.headers).get("idempotency-key")).toBe(
      "session-example-001",
    );
    expect(await response.json()).toEqual({
      session: {
        id: "session-1",
        executionMode: "workerd",
        status: "starting",
        createdAt: "2026-09-25T00:00:00.000Z",
        sessionDataDigest: "sha256:cc",
        sessionDataRevision: 1,
      },
    });
  });
});
