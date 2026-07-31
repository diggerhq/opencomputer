import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mintManagedAgentsAssertion,
  proxyManagedAgents,
} from "./managed_agents";

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(
    atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
  ) as Record<string, unknown>;
}

describe("managed agents proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints a short-lived org-scoped assertion", async () => {
    const token = await mintManagedAgentsAssertion("test-secret", {
      orgID: "org_test",
      userID: "user_test",
    });
    const payload = decodePayload(token);

    expect(payload).toMatchObject({
      iss: "opencomputer-edge",
      aud: "managedagents",
      sub: "org_test",
      org_id: "org_test",
      user_id: "user_test",
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(120);
  });

  it("keeps API keys out of the private backend request", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ templates: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/templates?limit=3",
        {
          headers: {
            "X-API-Key": "osb_customer_secret",
            Accept: "application/json",
          },
        },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: null },
      "/api/managed-agents",
    );

    expect(response.status).toBe(200);
    const [target, init] = fetchSpy.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(target.toString()).toBe(
      "https://managedagents.test/v1/templates?limit=3",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-opencomputer-agent-token")).toBeTruthy();
  });

  it("preserves public template integrations and strips backend fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          templates: [
            {
              id: "email-triage",
              name: "Email triage",
              description: "Triage mail.",
              category: "Comms",
              integrations: ["Gmail", "OpenComputer"],
              suggestedPrompts: ["Triage today's inbox."],
              instructions: "private runtime instructions",
              imageArn: "private image",
            },
          ],
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/templates"),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(await response.json()).toEqual({
      templates: [
        {
          id: "email-triage",
          name: "Email triage",
          description: "Triage mail.",
          category: "Comms",
          integrations: ["Gmail", "OpenComputer"],
          suggestedPrompts: ["Triage today's inbox."],
        },
      ],
    });
  });

  it("does not expose arbitrary private backend routes", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployment-uploads",
        { method: "POST" },
      ),
      { OC_MANAGED_AGENTS_SECRET: "test-secret" },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads source without exposing provider details to the CLI", async () => {
    const source = JSON.stringify({ version: 1, files: [] });
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    );
    const digest = Array.from(new Uint8Array(digestBytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          uploadUrl: "https://uploads.test/signed",
          method: "PUT",
          headers: { "content-type": "application/json" },
          artifact: {
            bucket: "private-bucket",
            key: "private-key",
            digest,
            size: source.length,
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            id: "gmail-summarizer:test",
            agentId: "gmail-summarizer",
            alias: "production",
            channels: [],
            connections: ["google"],
            createdAt: "2026-07-30T00:00:00.000Z",
            artifact: { bucket: "private-bucket" },
            imageArn: "arn:aws:private",
          },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployments",
        {
          method: "POST",
          body: JSON.stringify({
            agentId: "gmail-summarizer",
            alias: "production",
            channels: [],
            connections: ["google"],
            source: {
              digest,
              size: source.length,
              contentType: "application/vnd.opencomputer.agent+json",
              body: source,
            },
          }),
          headers: {
            "content-type": "application/json",
            "x-api-key": "osb_customer_secret",
          },
        },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(201);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-opencomputer-agent-token")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await response.json())).not.toMatch(
      /bucket|imageArn|arn:aws|uploads\.test/i,
    );
  });

  it("redacts backend implementation errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "runtime_service_unavailable",
              message: "The Blue Lambda MicroVM service is not configured",
            },
          },
          { status: 503 },
        ),
      ),
    );

    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/sessions", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      { OC_MANAGED_AGENTS_SECRET: "test-secret" },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("runtime_service_unavailable");
    expect(body.error.message).toBe(
      "The agent service is temporarily unavailable.",
    );
    expect(JSON.stringify(body)).not.toMatch(/blue|lambda|microvm/i);
  });

  it("removes backend artifact and runtime fields from successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            session: {
              id: "session_test",
              status: "connecting",
              createdAt: "2026-07-30T00:00:00.000Z",
              accountId: "org_test",
              microvmId: "internal-vm",
            },
            runtimeToken: "internal-runtime-token",
            deployment: {
              id: "agent:digest",
              agentId: "research-assistant",
              alias: "production",
              channels: [],
              connections: [],
              createdAt: "2026-07-30T00:00:00.000Z",
              artifact: { bucket: "private-bucket" },
              imageArn: "arn:aws:private",
              imageVersion: "7",
            },
          },
          { status: 201 },
        ),
      ),
    );

    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/sessions", {
        method: "POST",
        body: JSON.stringify({ agentId: "research-assistant" }),
        headers: { "content-type": "application/json" },
      }),
      { OC_MANAGED_AGENTS_SECRET: "test-secret" },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(201);
    expect(serialized).toContain("research-assistant");
    expect(serialized).not.toMatch(
      /runtimeToken|microvm|artifact|bucket|imageArn|arn:aws/i,
    );
  });
});
