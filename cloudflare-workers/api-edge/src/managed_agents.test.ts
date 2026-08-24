import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleAgentWebhookInvocation,
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

  it("forwards webhook text and payload without requiring a user API key", async () => {
    const fetchSpy = vi.fn(
      async (_target: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer webhook-secret",
        );
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(
          "delivery-1",
        );
        expect(await new Response(init?.body).json()).toEqual({
          text: "Run the review",
          payload: { mode: "hygiene", repository: "acme/api" },
        });
        return Response.json({
          request: {
            id: "whr_request",
            webhookId: "wh_0123456789abcdef0123456789abcdef",
            projectId: "prj_test",
            environment: "development",
            agentId: "reviewer",
            sessionId: "session_test",
            outcome: "accepted",
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:01.000Z",
            internal: "private",
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleAgentWebhookInvocation(
      new Request(
        "https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef",
        {
          method: "POST",
          headers: {
            authorization: "Bearer webhook-secret",
            "content-type": "application/json",
            "idempotency-key": "delivery-1",
          },
          body: JSON.stringify({
            text: "Run the review",
            payload: { mode: "hygiene", repository: "acme/api" },
          }),
        },
      ),
      { MANAGED_AGENTS_API_URL: "https://managedagents.test" },
    );

    expect(response.status).toBe(202);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body).toMatchObject({
      request: { sessionId: "session_test", outcome: "accepted" },
      duplicate: false,
      sessionUrl:
        "https://app.opencomputer.dev/projects/prj_test/sessions/session_test?agent=reviewer&environment=development",
    });
    expect(JSON.stringify(body)).not.toContain("internal");
  });

  it("rejects webhook calls without bearer credentials", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await handleAgentWebhookInvocation(
      new Request(
        "https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef",
        { method: "POST", body: "{}" },
      ),
      {},
    );
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) =>
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
    const fetchSpy = vi.fn(async () => Response.json({ agents: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/agents?limit=3",
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
      "https://managedagents.test/v1/agents?limit=3",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-opencomputer-agent-token")).toBeTruthy();
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

    const body = await response.json();
    expect(body).toEqual({
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

  it("creates and lists projects without exposing the backend account model", async () => {
    const fetchSpy = vi.fn(async (request: URL | RequestInfo) => {
      const url = String(request);
      const project = {
        id: "prj_test",
        slug: "hello-world",
        name: "Hello World",
        agentId: "hello-world",
        environments: [{ name: "development", updatedAt: "2026-08-08" }],
        accountId: "private-account",
        createdAt: "2026-08-08",
        updatedAt: "2026-08-08",
      };
      return Response.json(
        url.endsWith("/v1/projects") ? { projects: [project] } : project,
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/projects"),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    const body = await response.json();
    expect(body).toEqual({
      projects: [
        {
          id: "prj_test",
          slug: "hello-world",
          name: "Hello World",
          environments: [{ name: "development", updatedAt: "2026-08-08" }],
          agents: [{ id: "hello-world", name: "Hello Hello World" }],
          createdAt: "2026-08-08",
          updatedAt: "2026-08-08",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("private-account");
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
              appId: "A01234ABCDE",
              teamId: "team_private",
              teamName: "OpenComputer",
              botUserId: "bot_private",
              verifiedAt: "2026-07-31T00:30:00.000Z",
              verificationError: null,
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
          scopes: ["gmail.readonly"],
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
          appId: "A01234ABCDE",
          teamName: "OpenComputer",
          verifiedAt: "2026-07-31T00:30:00.000Z",
          verificationError: null,
          status: "connected",
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T01:00:00.000Z",
        },
      ],
    });
  });

  it("lists one environment's outboxes without private delivery details", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      Response.json({
        agentId: "reviewer-agent",
        environment: "development",
        deploymentId: "reviewer-agent:digest",
        accountId: "private_org",
        outboxes: [
          {
            id: "review-requests",
            channelId: "team-slack",
            channelName: "Team Slack",
            destination: "pull-request-reviews",
            readiness: "ready",
            targetDisplayName: "#pull-request-reviews",
            connectionId: "private_connection",
            items: [
              {
                id: "outbox_item",
                outboxId: "review-requests",
                eventType: "pull-request.ready",
                sessionId: "session_public",
                contentPreview: {
                  title: "Pull request ready",
                  body: "Please review it.",
                  url: "https://example.com/pull/42",
                  secret: "private",
                },
                status: "failed",
                attemptCount: 1,
                error: "Slack chat.postMessage failed: internal_detail",
                createdAt: "2026-08-15T00:00:00.000Z",
                updatedAt: "2026-08-15T00:01:00.000Z",
                externalMessageId: "private_message",
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/outboxes?agentId=reviewer-agent&environment=development",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "https://managedagents.test/v1/outboxes?agentId=reviewer-agent&environment=development",
      }),
      expect.anything(),
    );
    expect(await response.json()).toEqual({
      agentId: "reviewer-agent",
      environment: "development",
      deploymentId: "reviewer-agent:digest",
      outboxes: [
        {
          id: "review-requests",
          channelId: "team-slack",
          channelName: "Team Slack",
          destination: "pull-request-reviews",
          readiness: "ready",
          targetDisplayName: "#pull-request-reviews",
          items: [
            {
              id: "outbox_item",
              outboxId: "review-requests",
              eventType: "pull-request.ready",
              sessionId: "session_public",
              contentPreview: {
                title: "Pull request ready",
                body: "Please review it.",
                url: "https://example.com/pull/42",
              },
              status: "failed",
              attemptCount: 1,
              error: "Delivery failed.",
              createdAt: "2026-08-15T00:00:00.000Z",
              updatedAt: "2026-08-15T00:01:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("lists schedules and exposes only a public run failure", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          accountId: "private_org",
          schedules: [
            {
              id: "weekday-hygiene",
              projectId: "prj_test",
              environment: "development",
              agentId: "hygiene-agent",
              deploymentId: "hygiene-agent:digest",
              cron: "0 9 * * 1-5",
              timezone: "America/Los_Angeles",
              overlap: "skip",
              dispatch: { text: "Review flags", payload: { mode: "async" } },
              nextRunAt: "2026-08-17T16:00:00.000Z",
              status: "manual",
              userId: "private_user",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            run: {
              id: "run_test",
              scheduleId: "weekday-hygiene",
              projectId: "prj_test",
              environment: "development",
              deploymentId: "hygiene-agent:digest",
              scheduledAt: "2026-08-16T20:00:00.000Z",
              manual: true,
              attempt: 1,
              outcome: "failed",
              error: "Runtime secret and topology details",
              createdAt: "2026-08-16T20:00:00.000Z",
            },
          },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const env = {
      OC_MANAGED_AGENTS_SECRET: "test-secret",
      MANAGED_AGENTS_API_URL: "https://managedagents.test",
    };
    const caller = { orgID: "org_test", userID: "user_test" };

    const schedules = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/schedules?projectId=prj_test&agentId=hygiene-agent&environment=development",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(await schedules.json()).toEqual({
      schedules: [
        {
          id: "weekday-hygiene",
          projectId: "prj_test",
          environment: "development",
          agentId: "hygiene-agent",
          deploymentId: "hygiene-agent:digest",
          cron: "0 9 * * 1-5",
          timezone: "America/Los_Angeles",
          overlap: "skip",
          dispatch: { text: "Review flags", payload: { mode: "async" } },
          nextRunAt: "2026-08-17T16:00:00.000Z",
          status: "manual",
        },
      ],
    });

    const run = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/schedules/weekday-hygiene/run?projectId=prj_test&agentId=hygiene-agent&environment=development",
        { method: "POST" },
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(run.status).toBe(201);
    expect(await run.json()).toEqual({
      run: {
        id: "run_test",
        scheduleId: "weekday-hygiene",
        projectId: "prj_test",
        environment: "development",
        deploymentId: "hygiene-agent:digest",
        scheduledAt: "2026-08-16T20:00:00.000Z",
        manual: true,
        attempt: 1,
        outcome: "failed",
        error: "The scheduled run could not be started.",
        createdAt: "2026-08-16T20:00:00.000Z",
      },
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

  it("returns actionable Slack destination verification errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "destination_verification_failed",
              message: "Slack conversations.info failed: channel_not_found",
            },
          },
          { status: 409 },
        ),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/channels/slack/connections/channel_slack/destinations/pull-request-reviews",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: "C012ABCDEF" }),
        },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "destination_verification_failed",
        message:
          "Slack could not find that conversation. Check its ID and invite the app first.",
      },
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
            httpConnections: [
              {
                id: "github-api",
                origin: "https://api.github.com",
                methods: ["GET"],
                headers: {
                  Authorization: {
                    kind: "secret",
                    name: "GITHUB_TOKEN",
                    prefix: "Bearer ",
                  },
                },
              },
            ],
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
            httpConnections: [
              {
                id: "github-api",
                origin: "https://api.github.com",
                methods: ["GET"],
                headers: {
                  Authorization: {
                    kind: "secret",
                    name: "GITHUB_TOKEN",
                    prefix: "Bearer ",
                  },
                },
              },
            ],
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
      httpConnections: [
        expect.objectContaining({
          id: "github-api",
          origin: "https://api.github.com",
        }),
      ],
    });
    expect(JSON.stringify(await response.json())).not.toMatch(
      /bucket|imageArn|arn:aws|uploads\.test/i,
    );
  });

  it("forwards managed secret metadata and aggregate logs through the public contract", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          name: "GITHUB_TOKEN",
          projectId: "prj_1",
          environment: "development",
          allowedOrigins: ["https://api.github.com"],
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          logs: [
            {
              id: "log_1",
              cursor: "cursor_1",
              timestamp: "2026-08-10T00:00:00.000Z",
              level: "info",
              event: "runtime.log",
              agentId: "agent-1",
              sessionId: "session-1",
              data: { message: "ready" },
            },
          ],
          cursor: "cursor_1",
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const environment = {
      OC_MANAGED_AGENTS_SECRET: "test-secret",
      MANAGED_AGENTS_API_URL: "https://managedagents.test",
    };
    const caller = { orgID: "org_test", userID: "user_test" };

    const secret = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/secrets/GITHUB_TOKEN",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: "never-return-this",
            environment: "development",
            allowedOrigins: ["https://api.github.com"],
          }),
        },
      ),
      environment,
      caller,
      "/api/managed-agents",
    );
    expect(secret.status).toBe(200);
    expect(JSON.stringify(await secret.json())).not.toContain(
      "never-return-this",
    );

    const logs = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/logs?agentId=agent-1",
      ),
      environment,
      caller,
      "/api/managed-agents",
    );
    expect(logs.status).toBe(200);
    await expect(logs.json()).resolves.toMatchObject({
      logs: [{ event: "runtime.log", data: { message: "ready" } }],
    });
  });

  it("forwards runtime variable metadata without returning its value", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        name: "DATABASE_URL",
        value: "postgres://must-not-leak",
        projectId: "prj_1",
        environment: "production",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/runtime-variables/DATABASE_URL",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: "postgres://must-not-leak",
            environment: "production",
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

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      name: "DATABASE_URL",
      environment: "production",
    });
    expect(JSON.stringify(body)).not.toContain("postgres://must-not-leak");
  });

  it("forwards redacted reactive render snapshots for the debug playground", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          events: [
            {
              id: "event_1",
              seq: 4,
              timestamp: "2026-08-10T00:00:00.000Z",
              sessionId: "session-1",
              turnId: "turn-1",
              type: "agent.rendered",
              data: {
                instructions: "Help with the current request.",
                platformInstructions: ["You are an OpenComputer agent."],
                enabledTools: ["search_docs"],
                runtimeToken: "never-return-this",
              },
            },
          ],
        }),
      ),
    );
    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/events?after=0",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      events: [
        {
          type: "agent.rendered",
          data: {
            instructions: "Help with the current request.",
            enabledTools: ["search_docs"],
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("never-return-this");
    expect(JSON.stringify(body)).not.toContain(
      "You are an OpenComputer agent.",
    );
    expect(JSON.stringify(body)).not.toContain("platformInstructions");
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

  it("exposes durable per-session billing attribution", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        sessions: [
          {
            id: "session-1",
            agentId: "reviewer",
            deploymentId: "reviewer:digest",
            source: "schedule",
            status: "idle",
            title: "Review stale flags",
            createdAt: "2026-08-22T00:00:00.000Z",
            updatedAt: "2026-08-22T00:01:00.000Z",
            modelCalls: 2,
            modelProviderCostUsd: 0.0123,
            modelUsage: [
              { timestamp: "2026-08-22T00:00:30.000Z", costUsd: 0.0123 },
            ],
            runtimeSecondsByTier: { "2gb_1vcpu": 40 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/dashboard/managed-agents/billing/sessions?limit=100",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/dashboard/managed-agents",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessions: [
        {
          id: "session-1",
          modelProviderCostUsd: 0.0123,
          runtimeSecondsByTier: { "2gb_1vcpu": 40 },
        },
      ],
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://managedagents.test/v1/billing/sessions?limit=100",
    );
  });

  it("forwards explicit running-session input modes", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json(
        { turnId: "turn-2", status: "running", duplicate: false },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/turns",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: "focus on the failing test",
            mode: "steer",
            idempotencyKey: "admission-1",
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

    expect(response.status).toBe(202);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(await new Response(init.body).json()).toMatchObject({
      input: "focus on the failing test",
      mode: "steer",
      idempotencyKey: "admission-1",
    });
    expect(await response.json()).toEqual({
      turnId: "turn-2",
      status: "running",
      duplicate: false,
    });
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
