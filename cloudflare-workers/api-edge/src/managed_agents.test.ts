import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleManagedAgentChannelConnection,
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

  it("does not consume a channel connection grant on link preview", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleManagedAgentChannelConnection(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/channel-connections/org_test/0123456789abcdef0123456789abcdef",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).not.toContain(
      "form-action",
    );
    expect(await response.text()).toContain("Continue");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("claims a channel grant and redirects to the provider", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        authorizationUrl: "https://connect.example.test/authorize",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const url =
      "https://app.opencomputer.dev/api/managed-agents/channel-connections/org_test/0123456789abcdef0123456789abcdef";

    const response = await handleManagedAgentChannelConnection(
      new Request(url, { method: "POST" }),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://connect.example.test/authorize",
    );
    const [target, init] = fetchSpy.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(target.toString()).toBe(
      "https://managedagents.test/v1/channel-connections/claim",
    );
    expect(await new Response(init.body).json()).toEqual({
      token: "0123456789abcdef0123456789abcdef",
    });
    expect(
      decodePayload(
        new Headers(init.headers).get("x-opencomputer-agent-token")!,
      ),
    ).toMatchObject({ org_id: "org_test" });
  });

  it("shows a completed state when the channel account is already connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "connected" })),
    );
    const response = await handleManagedAgentChannelConnection(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/channel-connections/org_test/0123456789abcdef0123456789abcdef",
        { method: "POST" },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("already connected");
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

  it("returns agent display names separately from stable IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          agents: [
            {
              id: "0195f5fb-2d5d-4aa4-b28e-b0df0af60cd8",
              name: "Gentle Falcon",
              activeAlias: "production",
              activeDeploymentId: "agent:digest",
              deploymentCount: 2,
              createdAt: "2026-07-31T00:00:00.000Z",
              updatedAt: "2026-07-31T01:00:00.000Z",
              artifact: "private",
            },
          ],
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/agents"),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(await response.json()).toEqual({
      agents: [
        {
          id: "0195f5fb-2d5d-4aa4-b28e-b0df0af60cd8",
          name: "Gentle Falcon",
          activeAlias: "production",
          activeDeploymentId: "agent:digest",
          deploymentCount: 2,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T01:00:00.000Z",
        },
      ],
    });
  });

  it("exposes a sanitized active deployment for agent details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "agent:digest",
          agentId: "agent",
          alias: "production",
          channels: ["slack"],
          connections: ["gmail"],
          createdAt: "2026-07-31T00:00:00.000Z",
          artifact: { bucket: "private", key: "source.tar.gz" },
          imageArn: "arn:aws:private",
          imageVersion: "7",
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployments/agent%3Adigest",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(await response.json()).toEqual({
      id: "agent:digest",
      agentId: "agent",
      alias: "production",
      channels: ["slack"],
      connections: ["gmail"],
      createdAt: "2026-07-31T00:00:00.000Z",
    });
  });

  it("lists connections and channels without provider credentials or account IDs", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          connections: [
            {
              id: "connection_google",
              kind: "tool",
              provider: "google",
              label: "gmail",
              agentId: "email-triage",
              alias: "production",
              externalAccountId: "ca_private",
              displayName: "Personal Gmail",
              scopes: ["gmail.readonly"],
              status: "connected",
              createdAt: "2026-07-31T00:00:00.000Z",
              updatedAt: "2026-07-31T01:00:00.000Z",
              credential: "secret",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          connections: [
            {
              id: "channel_slack",
              agentId: "support-agent",
              alias: "production",
              appId: "app_private",
              teamId: "team_private",
              teamName: "OpenComputer",
              botUserId: "bot_private",
              status: "connected",
              createdAt: "2026-07-31T00:00:00.000Z",
              updatedAt: "2026-07-31T01:00:00.000Z",
              botToken: "secret",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const env = {
      OC_MANAGED_AGENTS_SECRET: "test-secret",
      MANAGED_AGENTS_API_URL: "https://managedagents.test",
    };
    const caller = { orgID: "org_test", userID: "user_test" };

    const connections = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/connections",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    const channels = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/channels"),
      env,
      caller,
      "/api/managed-agents",
    );

    expect(await connections.json()).toEqual({
      connections: [
        {
          id: "connection_google",
          kind: "tool",
          provider: "google",
          label: "gmail",
          agentId: "email-triage",
          alias: "production",
          displayName: "Personal Gmail",
          status: "connected",
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T01:00:00.000Z",
        },
      ],
    });
    expect(await channels.json()).toEqual({
      channels: [
        {
          id: "channel_slack",
          channel: "slack",
          agentId: "support-agent",
          alias: "production",
          teamName: "OpenComputer",
          status: "connected",
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T01:00:00.000Z",
        },
      ],
    });
  });

  it("returns a public per-agent Slack manifest", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      Response.json({
        connection: {
          id: "channel_slack",
          agentId: "support-agent",
          alias: "production",
          status: "pending",
          accountId: "private_org",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        manifest: {
          display_information: { name: "Support Helper" },
          settings: {
            event_subscriptions: {
              request_url:
                "https://managedagents.test/v1/webhooks/slack/id/token",
            },
          },
        },
        createUrl: "https://api.slack.com/apps",
        steps: ["Create the app"],
        runtimeToken: "private",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/channels/slack/connections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: "support-agent@production",
            name: "Support Helper",
          }),
        },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(await response.json()).toEqual({
      connection: {
        id: "channel_slack",
        channel: "slack",
        agentId: "support-agent",
        alias: "production",
        status: "pending",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      manifest: {
        display_information: { name: "Support Helper" },
        settings: {
          event_subscriptions: {
            request_url:
              "https://managedagents.test/v1/webhooks/slack/id/token",
          },
        },
      },
      createUrl: "https://api.slack.com/apps",
      steps: ["Create the app"],
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
            name: "Gentle Falcon",
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
    expect(
      JSON.parse(String((fetchSpy.mock.calls[2]?.[1] as RequestInit).body)),
    ).toMatchObject({
      agentId: "gmail-summarizer",
      name: "Gentle Falcon",
    });
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

  it("lists sanitized deployment history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          deployments: [
            {
              id: "research-assistant:digest",
              agentId: "research-assistant",
              alias: "production",
              channels: ["slack"],
              connections: ["google"],
              createdAt: "2026-07-30T00:00:00.000Z",
              artifact: { bucket: "private-bucket", key: "private-key" },
              imageArn: "arn:aws:private",
              imageVersion: "7",
            },
          ],
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployments?agentId=research-assistant",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(serialized).toContain("research-assistant:digest");
    expect(serialized).not.toMatch(/artifact|bucket|imageArn|imageVersion/i);
  });
});
