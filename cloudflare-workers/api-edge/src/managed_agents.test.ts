import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleAgentWebhookInvocation,
  handleManagedAgentChannelConnection,
  handleManagedGitHubCallback,
  hasBYOKPlanAccess,
  mintManagedAgentsAssertion,
  proxyManagedAgents,
  publicFailure,
} from "./managed_agents";

function legacyPlanEnv(plan: string) {
  return {
    OPENCOMPUTER_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ plan, billing_provider: "legacy" }),
        }),
      }),
    } as unknown as D1Database,
  };
}

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
      role: "admin",
    });
    const payload = decodePayload(token);

    expect(payload).toMatchObject({
      iss: "opencomputer-edge",
      aud: "managedagents",
      sub: "org_test",
      org_id: "org_test",
      user_id: "user_test",
      role: "admin",
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(120);
  });

  it("forwards managed GitHub project connection requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        installUrl:
          "https://github.com/apps/opencomputer/installations/new?state=opaque",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/projects/prj_test/github/connect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environments: ["development"] }),
        },
      ),
      {
        MANAGED_AGENTS_API_URL: "https://manage-agents.mo-oc-dev.com",
        OC_MANAGED_AGENTS_SECRET: "test-secret",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installUrl:
        "https://github.com/apps/opencomputer/installations/new?state=opaque",
    });
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      "https://manage-agents.mo-oc-dev.com/v1/projects/prj_test/github/connect",
    );
  });

  it("forwards the unauthenticated GitHub setup callback as HTML", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>connected</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleManagedGitHubCallback(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/github/callback?code=oauth-code&installation_id=123&state=opaque",
      ),
      { MANAGED_AGENTS_API_URL: "https://manage-agents.mo-oc-dev.com" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain("connected");
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      "https://manage-agents.mo-oc-dev.com/v1/github/callback?code=oauth-code&installation_id=123&state=opaque",
    );
  });

  it("allows BYOK for Pro and Max but not the base plan", async () => {
    await expect(
      hasBYOKPlanAccess(legacyPlanEnv("base"), "org_test"),
    ).resolves.toBe(false);
    await expect(
      hasBYOKPlanAccess(legacyPlanEnv("pro"), "org_test"),
    ).resolves.toBe(true);
    await expect(
      hasBYOKPlanAccess(legacyPlanEnv("max"), "org_test"),
    ).resolves.toBe(true);
  });

  it("streams project source without exposing upstream headers", async () => {
    const fetchSpy = vi.fn(async (target: RequestInfo | URL) => {
      expect(String(target)).toBe(
        "https://managedagents.test/v1/projects/prj_test/source-archive",
      );
      return new Response("project archive", {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": 'attachment; filename="project.tar.gz"',
          "x-storage-provider": "private",
        },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/projects/prj_test/source-archive",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test", role: "admin" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("project archive");
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-storage-provider")).toBeNull();
  });

  it("reads BYOK eligibility from an active Autumn subscription", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "org_test",
          subscriptions: [
            { plan_id: "base", add_on: false, status: "active" },
            { plan_id: "pro", add_on: false, status: "active" },
          ],
        }),
      ),
    );
    const autumnDB = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            plan: "free",
            billing_provider: "autumn",
          }),
        }),
      }),
    } as unknown as D1Database;

    await expect(
      hasBYOKPlanAccess(
        {
          OPENCOMPUTER_DB: autumnDB,
          AUTUMN_SECRET_KEY: "autumn-test",
          AUTUMN_BASE_URL: "https://autumn.test/v1",
        },
        "org_test",
      ),
    ).resolves.toBe(true);
  });

  it("returns the public model-access OAuth receipt without custody fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          connection: {
            id: "mac_test",
            organizationId: "org_test",
            connectedByUserId: "user_test",
            provider: "openai",
            kind: "codex_subscription",
            label: "Codex subscription",
            status: "connecting",
            credentialCiphertext: "must-not-leak",
            oauthCodeVerifier: "must-not-leak",
          },
          status: "pending",
          authorize_url: "https://auth.openai.com/oauth/authorize?state=test",
          expires_at: "2026-08-24T00:15:00.000Z",
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/model-access/connections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai" }),
        },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
        ...legacyPlanEnv("pro"),
      },
      { orgID: "org_test", userID: "user_test", role: "admin" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      status: "pending",
      authorize_url: "https://auth.openai.com/oauth/authorize?state=test",
      connection: {
        id: "mac_test",
        organizationId: "org_test",
        connectedByUserId: "user_test",
        provider: "openai",
        status: "connecting",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /credentialCiphertext|oauthCodeVerifier|must-not-leak/,
    );
  });

  it("rejects unsupported Claude account connection", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/model-access/connections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "anthropic",
            token: "must-not-be-returned",
          }),
        },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test", role: "admin" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(400);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      error: {
        code: "unsupported_provider",
        message: "Codex is the only supported BYOK account provider.",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects BYOK connection and enablement on the base plan", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = {
      OC_MANAGED_AGENTS_SECRET: "test-secret",
      MANAGED_AGENTS_API_URL: "https://managedagents.test",
      ...legacyPlanEnv("base"),
    };

    const connect = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/model-access/connections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai" }),
        },
      ),
      env,
      { orgID: "org_test", userID: "user_test", role: "admin" },
      "/api/managed-agents",
    );
    expect(connect.status).toBe(403);
    await expect(connect.json()).resolves.toMatchObject({
      error: { code: "model_access_plan_required" },
    });

    const enable = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/projects/prj_test/model-access/bindings/openai/development",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      ),
      env,
      { orgID: "org_test", userID: "user_test", role: "admin" },
      "/api/managed-agents",
    );
    expect(enable.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a downgraded organization to disable BYOK", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        organizationId: "org_test",
        projectId: "prj_test",
        provider: "openai",
        environment: "development",
        enabled: false,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const response = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/projects/prj_test/model-access/bindings/openai/development",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
        ...legacyPlanEnv("base"),
      },
      { orgID: "org_test", userID: "user_test", role: "admin" },
      "/api/managed-agents",
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
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

  it("forwards a URL-credential delivery with the provider's delivery id and no bearer header", async () => {
    const sentryBody = {
      action: "triggered",
      data: { event: { event_id: "a".repeat(32) } },
      installation: { uuid: "inst" },
    };
    const fetchSpy = vi.fn(
      async (target: URL | RequestInfo, init?: RequestInit) => {
        expect(String(target)).toBe(
          "https://managedagents.test/v1/agent-webhooks/wh_0123456789abcdef0123456789abcdef/ocwh_token-segment_0123456789",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBeNull();
        // The sender's own headers reach the backend, which reads whichever
        // one the webhook is configured to use as its identity.
        expect(headers.get("request-id")).toBe("sentry-delivery-1");
        expect(headers.get("sentry-hook-resource")).toBe("event_alert");
        expect(headers.get("sentry-hook-signature")).toBe("abc");
        // Credentials, transport, and edge-trusted headers do not.
        expect(headers.get("cookie")).toBeNull();
        expect(headers.get("x-oc-managed-sig")).toBeNull();
        expect(headers.get("x-api-key")).toBeNull();
        expect(headers.get("x-forwarded-for")).toBeNull();
        expect(headers.get("x-request-id")).not.toBe("spoofed");
        expect(await new Response(init?.body).json()).toEqual(sentryBody);
        return Response.json({
          request: {
            id: "whr_request",
            webhookId: "wh_0123456789abcdef0123456789abcdef",
            projectId: "prj_test",
            environment: "development",
            agentId: "oncall",
            sessionId: "session_pending",
            outcome: "pending",
            attempt: 0,
            createdAt: "2026-09-08T00:00:00.000Z",
            updatedAt: "2026-09-08T00:00:00.000Z",
          },
        }, { status: 202 });
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleAgentWebhookInvocation(
      new Request(
        "https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef/ocwh_token-segment_0123456789",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "request-id": "sentry-delivery-1",
            "sentry-hook-resource": "event_alert",
            "sentry-hook-signature": "abc",
            cookie: "session=1",
            "x-oc-managed-sig": "forged",
            "x-api-key": "forged",
            "x-forwarded-for": "1.2.3.4",
            "x-request-id": "spoofed",
          },
          body: JSON.stringify(sentryBody),
        },
      ),
      { MANAGED_AGENTS_API_URL: "https://managedagents.test" },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      request: { sessionId: "session_pending", outcome: "pending" },
      sessionUrl:
        "https://app.opencomputer.dev/projects/prj_test/sessions/session_pending?agent=oncall&environment=development",
    });
  });

  it("rejects a malformed path token before reaching the backend", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await handleAgentWebhookInvocation(
      new Request(
        "https://app.opencomputer.dev/api/agent-webhooks/wh_0123456789abcdef0123456789abcdef/bad%20token",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ),
      {},
    );
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("exposes public template provenance on a project overview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          project: {
            id: "prj_test",
            slug: "example",
            name: "Example",
            environments: [],
            agents: [{ id: "reviewer", name: "Reviewer" }],
            createdAt: "2026-09-02",
            updatedAt: "2026-09-02",
          },
          templateSource: {
            repositoryUrl: "https://github.com/diggerhq/example",
            commitSha: "a".repeat(40),
            cloneReady: true,
            mirrorRepoId: "must-not-leak",
          },
          sessions: [],
          deployments: [],
          connections: [],
          channels: [],
          schedules: [],
          files: [],
          schema: {},
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_test",
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    const body = await response.json();
    expect(body).toMatchObject({
      templateSource: {
        repositoryUrl: "https://github.com/diggerhq/example",
        commitSha: "a".repeat(40),
        cloneReady: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("mirrorRepoId");
  });

  it("proxies template inspection through the authenticated managed-agent boundary", async () => {
    const fetchSpy = vi.fn(
      async (_request: URL | RequestInfo, init?: RequestInit) => {
        expect(
          new Headers(init?.headers).get("x-opencomputer-agent-token"),
        ).toBeTruthy();
        return Response.json({
          id: "tin_test",
          repository: {
            url: "https://github.com/diggerhq/example",
            fullName: "diggerhq/example",
            defaultBranch: "main",
            commitSha: "a".repeat(40),
          },
          template: { name: "Example", description: "Example agent" },
          agents: [{ id: "example", name: "Example" }],
          requirements: {
            secrets: [],
            runtimeVariables: [],
            connections: [],
          },
          expiresAt: "2026-09-01T01:00:00.000Z",
          builderCredential: "must-not-leak",
        });
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/template-inspections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repositoryUrl: "https://github.com/diggerhq/example",
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
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(await response.json())).not.toContain(
      "builderCredential",
    );
  });

  it("reports a missing root template manifest without leaking builder details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "template_sync_failed",
              message:
                "/usr/local/bin/node failed: opencomputer: oc-template.toml: expected a regular file at /tmp/template/source/oc-template.toml",
            },
          },
          { status: 422 },
        ),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://mo-oc-dev.com/api/managed-agents/template-inspections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repositoryUrl: "https://github.com/diggerhq/not-a-template",
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

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "template_manifest_missing",
        message:
          "This is not a valid template: oc-template.toml is missing from the repository root.",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/\/tmp\/|\/usr\/local|trigger/i);
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
          memory: [
            {
              id: "requirements",
              description: "Verified requirements.",
              provider: {
                kind: "http",
                maxBytes: 8192,
                connection: "notes-api",
                path: "/memory",
                tools: [{ name: "search" }],
              },
            },
          ],
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
      memory: [
        {
          id: "requirements",
          description: "Verified requirements.",
          provider: { kind: "http", maxBytes: 8192 },
        },
      ],
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
              lastEventAt: "2026-07-31T00:45:00.000Z",
              lastDelivery: {
                status: "delivered",
                at: "2026-07-31T00:46:00.000Z",
                responseBody: "private",
              },
              lastError: {
                category: "turn_delivery_failed",
                at: "2026-07-31T00:40:00.000Z",
                message: "private",
              },
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
          lastEventAt: "2026-07-31T00:45:00.000Z",
          lastDelivery: {
            status: "delivered",
            at: "2026-07-31T00:46:00.000Z",
          },
          lastError: {
            category: "turn_delivery_failed",
            at: "2026-07-31T00:40:00.000Z",
          },
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
            githubConnections: [
              {
                id: "github",
                provider: {
                  kind: "github-app",
                  permissions: {
                    contents: "write",
                    pull_requests: "write",
                  },
                },
              },
            ],
            memory: [
              {
                id: "requirements",
                description: "Verified requirements.",
                provider: { kind: "document", maxBytes: 8192 },
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
      githubConnections: [
        {
          id: "github",
          provider: {
            kind: "github-app",
            permissions: {
              contents: "write",
              pull_requests: "write",
            },
          },
        },
      ],
      memory: [
        {
          id: "requirements",
          description: "Verified requirements.",
          provider: { kind: "document", maxBytes: 8192 },
        },
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

  it("interrupts a session's running turn and returns the sanitized snapshot", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        id: "session-1",
        status: "idle",
        executionMode: "workerd",
        accountId: "org_test",
        runtimeToken: "internal-runtime-token",
        turns: [{ id: "turn-1", status: "cancelled" }],
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/interrupt",
        { method: "POST" },
      ),
      {
        OC_MANAGED_AGENTS_SECRET: "test-secret",
        MANAGED_AGENTS_API_URL: "https://managedagents.test",
      },
      { orgID: "org_test", userID: "user_test" },
      "/api/managed-agents",
    );

    expect(response.status).toBe(200);
    const [target] = fetchSpy.mock.calls[0] as unknown as [URL];
    expect(String(target)).toBe(
      "https://managedagents.test/v1/sessions/session-1/interrupt",
    );
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('"status":"cancelled"');
    expect(serialized).not.toMatch(/runtimeToken|accountId|org_test/);
  });

  // Public delivery slice (work 025): event subscriptions are managed under
  // the project and pass through the edge one-to-one; the backend owns the
  // body's validation, so fields this edge does not know (the environment
  // scope, for one) reach it and come back untouched.
  describe("event subscriptions", () => {
    const env = {
      OC_MANAGED_AGENTS_SECRET: "test-secret",
      MANAGED_AGENTS_API_URL: "https://managedagents.test",
    };
    const caller = { orgID: "org_test", userID: "user_test" };
    const subscription = {
      id: "evs_1",
      projectId: "prj_1",
      agentId: "worker",
      environment: "development",
      events: ["turn.completed", "turn.failed"],
      destination: { type: "session", sessionId: "ses_coordinator" },
      createdBy: "user_private",
      createdAt: "2026-09-10T12:00:00.000Z",
    };
    const publicSubscription = {
      id: "evs_1",
      projectId: "prj_1",
      agentId: "worker",
      environment: "development",
      events: ["turn.completed", "turn.failed"],
      destination: { type: "session", sessionId: "ses_coordinator" },
      createdAt: "2026-09-10T12:00:00.000Z",
    };

    it("creates a subscription, forwarding the body as sent", async () => {
      const fetchSpy = vi.fn(async () =>
        Response.json({ subscription }, { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchSpy);
      const body = {
        agentId: "worker",
        events: ["turn.completed", "turn.failed"],
        destination: { type: "session", sessionId: "ses_coordinator" },
        environment: "development",
      };

      const response = await proxyManagedAgents(
        new Request(
          "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/event-subscriptions",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
        env,
        caller,
        "/api/managed-agents",
      );

      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const [target, init] = fetchSpy.mock.calls[0] as unknown as [
        URL,
        RequestInit,
      ];
      expect(String(target)).toBe(
        "https://managedagents.test/v1/projects/prj_1/event-subscriptions",
      );
      expect(init.method).toBe("POST");
      expect(await new Response(init.body).json()).toEqual(body);
      expect(await response.json()).toEqual({ subscription: publicSubscription });
    });

    it("lists, reads and deletes subscriptions", async () => {
      const fetchSpy = vi.fn(async (input: URL | string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (url.endsWith("/event-subscriptions")) {
          return Response.json({ subscriptions: [subscription] });
        }
        return Response.json({ subscription });
      });
      vi.stubGlobal("fetch", fetchSpy);
      const call = (path: string, method = "GET") =>
        proxyManagedAgents(
          new Request(`https://app.opencomputer.dev/api/managed-agents${path}`, {
            method,
          }),
          env,
          caller,
          "/api/managed-agents",
        );

      const listed = await call("/projects/prj_1/event-subscriptions");
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        subscriptions: [publicSubscription],
      });

      const read = await call("/projects/prj_1/event-subscriptions/evs_1");
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ subscription: publicSubscription });

      const deleted = await call(
        "/projects/prj_1/event-subscriptions/evs_1",
        "DELETE",
      );
      expect(deleted.status).toBe(204);
      expect(
        fetchSpy.mock.calls.map((call) => String((call as unknown[])[0])),
      ).toEqual([
        "https://managedagents.test/v1/projects/prj_1/event-subscriptions",
        "https://managedagents.test/v1/projects/prj_1/event-subscriptions/evs_1",
        "https://managedagents.test/v1/projects/prj_1/event-subscriptions/evs_1",
      ]);
      expect(JSON.stringify(fetchSpy.mock.results)).not.toContain("user_test");
    });

    it("keeps the backend's error codes for a rejected subscription", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            {
              error: {
                code: "destination_session_ended",
                message: "Destination session has ended",
              },
            },
            { status: 409 },
          ),
        ),
      );
      const response = await proxyManagedAgents(
        new Request(
          "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/event-subscriptions",
          { method: "POST", body: "{}" },
        ),
        env,
        caller,
        "/api/managed-agents",
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "destination_session_ended",
      );
    });

    it("does not admit other methods on subscription routes", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      for (const [path, method] of [
        ["/projects/prj_1/event-subscriptions", "DELETE"],
        ["/projects/prj_1/event-subscriptions/evs_1", "PATCH"],
        ["/projects/prj_1/event-subscriptions/evs_1", "POST"],
      ] as const) {
        const response = await proxyManagedAgents(
          new Request(`https://app.opencomputer.dev/api/managed-agents${path}`, {
            method,
          }),
          env,
          caller,
          "/api/managed-agents",
        );
        expect(response.status).toBe(404);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("projects a turn's deliveries on the session snapshot with typed errors only", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            id: "ses_worker",
            status: "idle",
            accountId: "org_test",
            turns: [
              {
                id: "turn-1",
                input: "Reproduce the guide",
                mode: "queue",
                status: "completed",
                createdAt: "2026-09-10T12:00:00.000Z",
                updatedAt: "2026-09-10T12:01:00.000Z",
                deliveries: [
                  {
                    id: "evs_1:event_9",
                    subscriptionId: "evs_1",
                    eventId: "event_9",
                    eventType: "turn.completed",
                    destination: { type: "session", sessionId: "ses_coordinator" },
                    status: "delivered",
                    attempt: 1,
                    receipt: { sessionId: "ses_coordinator", turnId: "turn-7" },
                    updatedAt: "2026-09-10T12:01:01.000Z",
                  },
                  {
                    id: "evs_2:event_9",
                    subscriptionId: "evs_2",
                    eventId: "event_9",
                    eventType: "turn.completed",
                    destination: { type: "session", sessionId: "ses_gone" },
                    status: "failed",
                    attempt: 1,
                    error: "target_ended",
                    updatedAt: "2026-09-10T12:01:01.000Z",
                  },
                  {
                    id: "evs_3:event_9",
                    subscriptionId: "evs_3",
                    eventId: "event_9",
                    eventType: "turn.completed",
                    destination: { type: "session", sessionId: "ses_slow" },
                    status: "pending",
                    attempt: 2,
                    nextAttemptAt: "2026-09-10T12:05:00.000Z",
                    error:
                      "Target session returned 500 at https://internal.do/sessions/ses_slow with token osb_0123456789abcdef",
                    updatedAt: "2026-09-10T12:01:01.000Z",
                  },
                ],
              },
            ],
          }),
        ),
      );

      const response = await proxyManagedAgents(
        new Request(
          "https://app.opencomputer.dev/api/managed-agents/sessions/ses_worker",
        ),
        env,
        caller,
        "/api/managed-agents",
      );
      const body = (await response.json()) as {
        turns: Array<{ deliveries: Array<Record<string, unknown>> }>;
      };
      expect(body.turns[0].deliveries).toEqual([
        {
          id: "evs_1:event_9",
          subscriptionId: "evs_1",
          eventId: "event_9",
          eventType: "turn.completed",
          destination: { type: "session", sessionId: "ses_coordinator" },
          status: "delivered",
          attempt: 1,
          receipt: { sessionId: "ses_coordinator", turnId: "turn-7" },
          updatedAt: "2026-09-10T12:01:01.000Z",
        },
        {
          id: "evs_2:event_9",
          subscriptionId: "evs_2",
          eventId: "event_9",
          eventType: "turn.completed",
          destination: { type: "session", sessionId: "ses_gone" },
          status: "failed",
          attempt: 1,
          error: "target_ended",
          updatedAt: "2026-09-10T12:01:01.000Z",
        },
        {
          id: "evs_3:event_9",
          subscriptionId: "evs_3",
          eventId: "event_9",
          eventType: "turn.completed",
          destination: { type: "session", sessionId: "ses_slow" },
          status: "pending",
          attempt: 2,
          nextAttemptAt: "2026-09-10T12:05:00.000Z",
          error: "delivery_failed",
          updatedAt: "2026-09-10T12:01:01.000Z",
        },
      ]);
      expect(JSON.stringify(body)).not.toMatch(/internal\.do|osb_|accountId/);
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
              executionMode: "workerd",
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
    expect(serialized).toContain('"executionMode":"workerd"');
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

  // Project memory (docs/agents/document-memory.mdx). The fake backend below
  // answers with the documented bodies and headers; the edge must hand them
  // to the caller unchanged, including the conditional-request headers.
  const memoryEnv = {
    OC_MANAGED_AGENTS_SECRET: "test-secret",
    MANAGED_AGENTS_API_URL: "https://managedagents.test",
  };
  const memoryCaller = { orgID: "org_test", userID: "user_test" };
  const workshopDocument = {
    id: "workshop",
    title: "Workshop requirements",
    text: "Exercises must run on Node.js 22.",
    summary: "Workshop runtime requirements.",
    agentWrites: "enabled",
    revision: "rev-7",
    bytes: 33,
    maxBytes: 8192,
    updatedAt: "2026-09-10T12:00:00.000Z",
    writer: { kind: "agent", sessionId: "ses_1", accountId: "acc_private" },
    accountId: "acc_private",
  };

  it("reads a memory document with its ETag and no backend-only fields", async () => {
    const fetchSpy = vi.fn(async (target: RequestInfo | URL) => {
      expect(String(target)).toBe(
        "https://managedagents.test/v1/projects/prj_1/memory/requirements/documents/workshop?environment=development",
      );
      return Response.json(workshopDocument, {
        headers: { etag: '"rev-7"', "x-upstream": "private" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents/workshop?environment=development",
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"rev-7"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-upstream")).toBeNull();
    expect(await response.json()).toEqual({
      id: "workshop",
      title: "Workshop requirements",
      text: "Exercises must run on Node.js 22.",
      summary: "Workshop runtime requirements.",
      agentWrites: "enabled",
      revision: "rev-7",
      bytes: 33,
      maxBytes: 8192,
      updatedAt: "2026-09-10T12:00:00.000Z",
      writer: { kind: "agent", sessionId: "ses_1" },
    });
  });

  it("lists memory document metadata with the next cursor and without text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          documents: [workshopDocument],
          nextCursor: "cursor-2",
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents?environment=development&cursor=cursor-1",
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );
    const body = (await response.json()) as {
      documents: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.nextCursor).toBe("cursor-2");
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({
      id: "workshop",
      revision: "rev-7",
      writer: { kind: "agent", sessionId: "ses_1" },
    });
    expect(body.documents[0]).not.toHaveProperty("text");
    expect(JSON.stringify(body)).not.toContain("acc_private");
  });

  it("forwards memory conditional headers and returns the documented status codes", async () => {
    const fetchSpy = vi.fn(async (_target: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      if (method === "PUT" && headers.get("if-none-match") === "*") {
        expect(headers.get("if-match")).toBeNull();
        expect(await new Response(init?.body).json()).toEqual({
          title: "Workshop requirements",
          text: "Exercises must run on Node.js 22.",
        });
        return Response.json(workshopDocument, {
          status: 201,
          headers: { etag: '"rev-7"' },
        });
      }
      if (method === "PATCH") {
        expect(headers.get("if-match")).toBe('"rev-7"');
        return Response.json(
          { ...workshopDocument, agentWrites: "disabled", revision: "rev-8" },
          { headers: { etag: '"rev-8"' } },
        );
      }
      if (method === "DELETE") {
        expect(headers.get("if-match")).toBe('"rev-8"');
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const path =
      "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents/workshop?environment=development";

    const created = await proxyManagedAgents(
      new Request(path, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "if-none-match": "*",
        },
        body: JSON.stringify({
          title: "Workshop requirements",
          text: "Exercises must run on Node.js 22.",
        }),
      }),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"rev-7"');

    const patched = await proxyManagedAgents(
      new Request(path, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": '"rev-7"' },
        body: JSON.stringify({ agentWrites: "disabled" }),
      }),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );
    expect(patched.status).toBe(200);
    expect(patched.headers.get("etag")).toBe('"rev-8"');
    expect(await patched.json()).toMatchObject({
      agentWrites: "disabled",
      revision: "rev-8",
    });

    const deleted = await proxyManagedAgents(
      new Request(path, {
        method: "DELETE",
        headers: { "if-match": '"rev-8"' },
      }),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("passes memory client errors through in the documented envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "precondition_failed",
              message: "The document changed since revision rev-6.",
            },
          },
          { status: 412 },
        ),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents/workshop?environment=development",
        {
          method: "PUT",
          headers: { "content-type": "application/json", "if-match": '"rev-6"' },
          body: JSON.stringify({ text: "stale" }),
        },
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );

    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({
      error: {
        code: "precondition_failed",
        message: "The document changed since revision rev-6.",
      },
    });
  });

  it("keeps the generic redaction for memory backend failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "memory_storage_failed",
              message: "Durable Object MEMORY threw in SQLite",
            },
          },
          { status: 503 },
        ),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents?environment=development",
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("memory_storage_failed");
    expect(body.error.message).not.toMatch(/durable|sqlite/i);
  });

  it("rejects memory methods the management API does not document", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents?environment=development",
        { method: "POST", body: "{}" },
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );

    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns session memory bindings with their writable flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "ses_1",
          agentId: "hello-world",
          status: "running",
          memory: [
            {
              resource: "requirements",
              scope: "document",
              id: "workshop",
              access: "read-write",
              writable: true,
            },
          ],
          runtimeToken: "private",
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/sessions/ses_1"),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.memory).toEqual([
      {
        resource: "requirements",
        scope: "document",
        id: "workshop",
        access: "read-write",
        writable: true,
      },
    ]);
    expect(body).not.toHaveProperty("runtimeToken");
  });

  // The resource inventory (C9) is the durable list of an environment's
  // resources: a resource no active deployment declares any more still
  // appears while it holds documents.
  it("lists the memory resource inventory with declared flags and document counts", async () => {
    const fetchSpy = vi.fn(async (target: RequestInfo | URL) => {
      expect(String(target)).toBe(
        "https://managedagents.test/v1/projects/prj_1/memory?environment=production",
      );
      return Response.json({
        resources: [
          {
            id: "requirements",
            provider: { kind: "document", maxBytes: 8192, bucket: "private" },
            declared: true,
            documents: 3,
            accountId: "acc_private",
          },
          {
            id: "scratch",
            provider: { kind: "document", maxBytes: 4096 },
            declared: false,
            documents: 2,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory?environment=production",
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      resources: [
        {
          id: "requirements",
          provider: { kind: "document", maxBytes: 8192 },
          declared: true,
          documents: 3,
        },
        {
          id: "scratch",
          provider: { kind: "document", maxBytes: 4096 },
          declared: false,
          documents: 2,
        },
      ],
    });
  });

  it("keeps a backend without the inventory route answering 404 so clients can fall back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "not_found", message: "Route not found" } },
          { status: 404 },
        ),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory?environment=development",
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });

  // A failed turn carries a typed public failure: a stable code, a fixed
  // sentence and validated parameters. The runtime's own error text is an
  // operator message and never leaves the edge, whatever it contains.
  it("projects a turn failure as a typed public failure through the event stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          events: [
            {
              id: "event_1",
              seq: 9,
              timestamp: "2026-09-10T00:00:00.000Z",
              sessionId: "session-1",
              turnId: "turn-1",
              type: "turn.failed",
              data: {
                message:
                  "The Workerd runtime rejects any useModel other than anthropic/claude-sonnet-4.6 (requested openai/gpt-5)",
                runtimeToken: "never-return-this",
              },
            },
            {
              id: "event_2",
              seq: 10,
              timestamp: "2026-09-10T00:00:01.000Z",
              sessionId: "session-1",
              turnId: "turn-2",
              type: "turn.failed",
              data: {
                message:
                  "The agent runtime stopped reporting on this turn and its lease expired",
                reason: "runtime_lost",
              },
            },
            {
              id: "event_3",
              seq: 11,
              timestamp: "2026-09-10T00:00:02.000Z",
              sessionId: "session-1",
              type: "session.failed",
              data: {},
            },
          ],
        }),
      ),
    );

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/sessions/session-1/events?after=0",
      ),
      memoryEnv,
      memoryCaller,
      "/api/managed-agents",
    );
    const body = (await response.json()) as {
      events: Array<{ type: string; data: Record<string, unknown> }>;
    };

    expect(body.events[0].data).toEqual({
      code: "model_unavailable",
      message: "The model openai/gpt-5 is not available to this agent.",
      model: "openai/gpt-5",
    });
    expect(body.events[1].data).toEqual({
      code: "runtime_lost",
      message:
        "The agent runtime stopped responding and the turn was abandoned.",
    });
    expect(body.events[2].data).toEqual({
      code: "agent_failed",
      message: "The agent could not complete this request.",
    });
    expect(JSON.stringify(body)).not.toContain("never-return-this");
    expect(JSON.stringify(body)).not.toContain("Workerd");
  });

  it("classifies known runtime failures into typed public failures", () => {
    expect(publicFailure({ reason: "interrupted" })).toEqual({
      code: "interrupted",
      message: "The turn was interrupted before it finished.",
    });
    expect(
      publicFailure({
        message: "OpenCode execution was interrupted",
        reason: "runtime_interrupted",
      }),
    ).toEqual({
      code: "interrupted",
      message: "The turn was interrupted before it finished.",
    });
    expect(publicFailure({ reason: "session_ended" })).toEqual({
      code: "session_ended",
      message: "The session ended before the turn finished.",
    });
    expect(
      publicFailure({ message: "Model unavailable: openai/gpt-5-mini" }),
    ).toEqual({
      code: "model_unavailable",
      message: "The model openai/gpt-5-mini is not available to this agent.",
      model: "openai/gpt-5-mini",
    });
    // A model id that is not a model id is not echoed.
    expect(
      publicFailure({ message: "Model unavailable: sk-ant-api03-0123456789abcdefghijklmnop/x" }),
    ).toEqual({
      code: "model_unavailable",
      message: "The requested model is not available to this agent.",
    });
    expect(
      publicFailure({
        message:
          "AI_APICallError: 401 Unauthorized: invalid x-api-key sk-ant-api03-0123456789abcdefghijklmnop",
      }),
    ).toEqual({
      code: "model_rejected",
      message: "The model provider rejected the request.",
    });
    expect(
      publicFailure({ message: "Rate limit exceeded; retry after 20s" }),
    ).toEqual({
      code: "model_rejected",
      message: "The model provider rejected the request.",
    });
    expect(
      publicFailure({
        message: "prompt is too long: 214000 tokens > 200000 maximum context length",
      }),
    ).toEqual({
      code: "context_too_long",
      message: "The conversation is too long for the model's context window.",
    });
    expect(
      publicFailure({ message: "Tool module exported an unregistered tool: lookup_venue" }),
    ).toEqual({
      code: "tool_failed",
      message: "Tool lookup_venue failed.",
      tool: "lookup_venue",
    });
    expect(publicFailure({ message: "The tool has no edge implementation" })).toEqual({
      code: "tool_failed",
      message: "A tool failed.",
    });
    expect(publicFailure({ message: "Sandbox operation timed out" })).toEqual({
      code: "sandbox_timeout",
      message: "A sandbox command did not finish in time.",
    });
    expect(
      publicFailure({
        message: "Sandbox acquisition returned 503: {\"error\":\"no capacity in us-east\"}",
      }),
    ).toEqual({
      code: "sandbox_failed",
      message: "The sandbox could not run this turn.",
    });
    expect(publicFailure({ reason: "Runtime harness is not ready\u0007" })).toEqual({
      code: "runtime_failed",
      message: "The agent runtime failed before the turn finished.",
    });
    expect(publicFailure({ message: "The Workerd runtime stream ended before the turn did" })).toEqual({
      code: "runtime_failed",
      message: "The agent runtime failed before the turn finished.",
    });
    expect(
      publicFailure({ message: "The deployment is missing tool module \"tools/x.js\"" }),
    ).toEqual({
      code: "deployment_invalid",
      message: "The deployment could not be loaded by the runtime.",
    });
    expect(publicFailure(undefined)).toEqual({
      code: "agent_failed",
      message: "The agent could not complete this request.",
    });
  });

  // Review reproductions: text the label-and-length redaction used to let
  // through. None of it is public now, because no runtime text is.
  it("never publishes unclassified runtime error text", () => {
    const leaks = [
      'provider rejected {"api_key":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"} for org 42',
      "fetch failed: Authorization: Basic dXNlcjpwYXNz was refused",
      "connect to db: password=hunter2 host=10.0.0.5",
      [
        "ENOENT: no such file or directory, open '/Users/dev/app/.opencomputer/agent.js'",
        "    at Object.openSync (node:fs:581:3)",
      ].join("\n"),
      "fetch to http://127.0.0.1:4096/session/ses_1/message?token=abc failed",
      "The turn exceeded its budget. ".repeat(40),
    ];
    expect(publicFailure({ message: leaks[3] })).toEqual({
      code: "agent_failed",
      message: "The agent could not complete this request.",
    });
    for (const message of leaks) {
      const failure = publicFailure({ message });
      // Whatever the classification, nothing but a fixed sentence goes out.
      expect(Object.keys(failure).sort()).toEqual(["code", "message"]);
      expect(failure.message).toMatch(/^[A-Z][a-z' ]+\.$/);
      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
      expect(serialized).not.toContain("dXNlcjpwYXNz");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("/Users/dev");
      expect(serialized).not.toContain("127.0.0.1");
    }
    // Parameters are the only runtime-derived text, and they are validated:
    // a credential in a model or tool position is dropped.
    expect(
      publicFailure({
        message:
          "Tool module exported an unregistered tool: sk-ant-api03-0123456789abcdefghijklmnop",
      }),
    ).toEqual({ code: "tool_failed", message: "A tool failed." });
  });
});
