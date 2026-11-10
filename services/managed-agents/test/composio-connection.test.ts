import { afterEach, describe, expect, it, vi } from "vitest";

import {
  linkManagedGithubConnection,
  linkManagedLinearConnection,
  disconnectManagedGoogleConnection,
  linkManagedGoogleConnection,
  managedGoogleConnection,
  proxyManagedGithubAccountRequest,
  proxyManagedLinearAccountRequest,
  proxyManagedGoogleAccountRequest,
  proxyManagedGoogleRequest,
} from "../src/connections/composio.js";
import {
  requestedConnectionLabel,
  selectManagedGoogleConnection,
  selectManagedProviderConnection,
} from "../src/connections/selection.js";
import type { Connection } from "../src/protocol.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Composio connections", () => {
  it("preserves an omitted account alias for unique-account selection", () => {
    expect(requestedConnectionLabel(undefined)).toBeUndefined();
    expect(requestedConnectionLabel(" Engineering ")).toBe("engineering");
    expect(requestedConnectionLabel("not a valid alias")).toBeNull();
  });

  it("links Linear with the configured read and create scopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/auth_configs/ac_linear")) {
          return Promise.resolve(Response.json({
            id: "ac_linear",
            status: "ENABLED",
            toolkit: { slug: "linear" },
          }));
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        return Promise.resolve(Response.json({
          redirect_url: "https://connect.composio.dev/link/linear",
          connected_account_id: "ca_linear_pending",
        }));
      }),
    );
    await expect(
      linkManagedLinearConnection(
        { apiKey: "secret", authConfigId: "ac_linear" },
        "blue:user_123",
      ),
    ).resolves.toMatchObject({
      toolkit: "linear",
      scopes: ["read", "write", "issues:create", "comments:create"],
      status: "pending",
      authorizationUrl: "https://connect.composio.dev/link/linear",
    });
  });

  it("allows only JSON POST requests to Linear GraphQL", async () => {
    const fetchMock = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(Response.json({ status: 200, data: { data: { viewer: { id: "usr_1" } } } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      proxyManagedLinearAccountRequest(
        { apiKey: "secret" },
        "ca_linear",
        {
          service: "linear",
          method: "POST",
          path: "/graphql",
          headers: { "content-type": "application/json", authorization: "bad" },
          body: JSON.stringify({ query: "query { viewer { id } }" }),
        },
      ),
    ).resolves.toMatchObject({ status: 200 });
    const request = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { method: string; endpoint: string; parameters: Array<{ name: string }> };
    expect(request).toMatchObject({ method: "POST", endpoint: "/graphql" });
    expect(request.parameters).toEqual([
      { name: "content-type", value: "application/json", type: "header" },
    ]);

    await expect(
      proxyManagedLinearAccountRequest(
        { apiKey: "secret" },
        "ca_linear",
        { service: "linear", method: "GET", path: "/graphql" },
      ),
    ).rejects.toThrow(/only POST/);
    await expect(
      proxyManagedLinearAccountRequest(
        { apiKey: "secret" },
        "ca_linear",
        { service: "linear", method: "POST", path: "/oauth/token", body: "{}" },
      ),
    ).rejects.toThrow(/only the \/graphql endpoint/);
  });

  it("links GitHub with the configured repo scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/auth_configs/ac_github")) {
          return Promise.resolve(Response.json({
            id: "ac_github",
            status: "ENABLED",
            toolkit: { slug: "github" },
          }));
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        return Promise.resolve(Response.json({
          redirect_url: "https://connect.composio.dev/link/github",
          connected_account_id: "ca_github_pending",
        }));
      }),
    );
    await expect(
      linkManagedGithubConnection(
        { apiKey: "secret", authConfigId: "ac_github" },
        "blue:user_123",
      ),
    ).resolves.toMatchObject({
      toolkit: "github",
      scopes: ["repo"],
      status: "pending",
    });
  });

  it("allows only GET requests to the PR review GitHub endpoint allowlist", async () => {
    const fetchMock = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(Response.json({ status: 200, data: { id: 1 } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      proxyManagedGithubAccountRequest(
        { apiKey: "secret" },
        "ca_github",
        {
          service: "github",
          path: "/repos/opencomputer/test/pulls/42",
        },
      ),
    ).resolves.toMatchObject({ status: 200 });
    const request = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { method: string; endpoint: string };
    expect(request).toMatchObject({
      method: "GET",
      endpoint: "/repos/opencomputer/test/pulls/42",
    });
    await expect(
      proxyManagedGithubAccountRequest(
        { apiKey: "secret" },
        "ca_github",
        {
          service: "github",
          method: "POST",
          path: "/repos/opencomputer/test/issues/42/comments",
        },
      ),
    ).rejects.toThrow(/read-only/);
    await expect(
      proxyManagedGithubAccountRequest(
        { apiKey: "secret" },
        "ca_github",
        { service: "github", path: "/user/repos" },
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it("reconstructs a GitHub diff from paginated changed-file patches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            status: 200,
            data: [
              {
                filename: "src/new.ts",
                previous_filename: "src/old.ts",
                status: "renamed",
                patch: "@@ -1 +1 @@\n-old\n+new",
              },
            ],
          }),
        ),
      ),
    );
    await expect(
      proxyManagedGithubAccountRequest(
        { apiKey: "secret" },
        "ca_github",
        {
          service: "github",
          path: "/repos/opencomputer/test/pulls/42",
          headers: { accept: "application/vnd.github.v3.diff" },
        },
      ),
    ).resolves.toMatchObject({
      status: 200,
      body:
        "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new",
    });
  });

  it("allows exact-head GitHub contents reads and rejects traversal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            status: 200,
            data: { encoding: "base64", content: "aGVsbG8=" },
          }),
        ),
      ),
    );
    const result = await proxyManagedGithubAccountRequest(
      { apiKey: "secret" },
      "ca_github",
      {
        service: "github",
        path:
          "/repos/opencomputer/test/contents/src/index.ts?ref=0123456789abcdef0123456789abcdef01234567",
      },
    );
    expect(JSON.parse(result.body ?? "null")).toMatchObject({
      encoding: "base64",
      content: "aGVsbG8=",
    });
    await expect(
      proxyManagedGithubAccountRequest(
        { apiKey: "secret" },
        "ca_github",
        {
          service: "github",
          path:
            "/repos/opencomputer/test/contents/%2E%2E/secret?ref=0123456789abcdef0123456789abcdef01234567",
        },
      ),
    ).rejects.toThrow(/invalid|not allowed/);
  });

  function connection(
    label: string,
    scopes: string[],
    overrides: Partial<Connection> = {},
  ): Connection {
    return {
      id: `connection-${label}`,
      kind: "tool",
      provider: "google",
      label,
      ownerUserId: "user-one",
      agentId: "",
      alias: "",
      externalAccountId: `ca_${label}`,
      scopes,
      status: "connected",
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      ...overrides,
    };
  }

  it("selects the sole connected account matching the requested Google service", () => {
    const calendar = connection("work-calendar", [
      "https://www.googleapis.com/auth/calendar",
    ]);
    const gmail = connection("personal-gmail", [
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);

    expect(
      selectManagedGoogleConnection([gmail, calendar], "calendar"),
    ).toEqual({ kind: "selected", connection: calendar });
  });

  it("requires an alias when multiple accounts match the requested service", () => {
    const work = connection("work", [
      "https://www.googleapis.com/auth/calendar",
    ]);
    const personal = connection("personal", [
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);

    expect(
      selectManagedGoogleConnection([work, personal], "calendar"),
    ).toEqual({
      kind: "alias_required",
      labels: ["personal", "work"],
    });
    expect(
      selectManagedGoogleConnection([work, personal], "calendar", "work"),
    ).toEqual({ kind: "selected", connection: work });
  });

  it("selects the sole connected Linear account when no alias is requested", () => {
    const linear = connection("engineering", [], {
      provider: "linear",
      externalAccountId: "ca_linear",
    });

    expect(selectManagedProviderConnection([linear], "linear")).toEqual({
      kind: "selected",
      connection: linear,
    });
  });

  it("does not select disconnected or wrong-service aliases", () => {
    const disconnected = connection(
      "work-calendar",
      ["https://www.googleapis.com/auth/calendar"],
      { status: "disconnected" },
    );
    const gmail = connection("work-calendar", [
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);

    expect(
      selectManagedGoogleConnection(
        [disconnected, gmail],
        "calendar",
        "work-calendar",
      ),
    ).toEqual({ kind: "not_found" });
  });

  it("creates a custom Gmail OAuth config and a branded Connect Link", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/auth_configs?")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        if (url.endsWith("/api/v3.1/auth_configs")) {
          return Promise.resolve(
            Response.json(
              {
                auth_config: {
                  id: "ac_opencomputer_gmail",
                  status: "ENABLED",
                  is_composio_managed: false,
                },
              },
              { status: 201 },
            ),
          );
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        return Promise.resolve(
          Response.json(
            {
              redirect_url: "https://connect.composio.dev/link/link_123",
              connected_account_id: "ca_pending",
            },
            { status: 201 },
          ),
        );
      }),
    );

    await expect(
      linkManagedGoogleConnection(
        {
          apiKey: "secret",
          oauthClientId: "google-client",
          oauthClientSecret: "google-secret",
          oauthRedirectUri:
            "https://app.opencomputer.dev/v1/connections/google/oauth/callback",
          callbackUrl:
            "https://app.opencomputer.dev/v1/connections/google/callback?service=gmail",
          appName: "OpenComputer",
        },
        "blue:user_123",
        "gmail",
      ),
    ).resolves.toMatchObject({
      service: "gmail",
      toolkit: "gmail",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "pending",
      authorizationUrl: "https://connect.composio.dev/link/link_123",
    });
    expect(requests[1]?.url.endsWith("/api/v3.1/auth_configs")).toBe(
      true,
    );
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      toolkit: { slug: "gmail" },
      auth_config: {
        type: "use_custom_auth",
        auth_scheme: "OAUTH2",
        credentials: {
          client_id: "google-client",
          client_secret: "google-secret",
          oauth_redirect_uri:
            "https://app.opencomputer.dev/v1/connections/google/oauth/callback",
          scopes: "https://www.googleapis.com/auth/gmail.readonly",
        },
      },
    });
    expect(
      requests[2]?.url.includes(
        "auth_config_ids=ac_opencomputer_gmail",
      ),
    ).toBe(true);
    expect(requests[3]?.url.endsWith("/api/v3/connected_accounts/link")).toBe(
      true,
    );
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
      auth_config_id: "ac_opencomputer_gmail",
      user_id: "blue:user_123",
      callback_url:
        "https://app.opencomputer.dev/v1/connections/google/callback?service=gmail",
    });
    expect(new Headers(requests[3]?.init?.headers).get("x-api-key")).toBe(
      "secret",
    );
  });

  it("uses an explicitly configured Composio-managed auth config", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/auth_configs/ac_managed")) {
          return Promise.resolve(
            Response.json({
              id: "ac_managed",
              status: "ENABLED",
              is_composio_managed: true,
              toolkit: { slug: "gmail" },
            }),
          );
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        return Promise.resolve(
          Response.json(
            {
              redirect_url: "https://connect.composio.dev/link/link_managed",
              connected_account_id: "ca_managed_pending",
            },
            { status: 201 },
          ),
        );
      }),
    );

    await expect(
      linkManagedGoogleConnection(
        { apiKey: "secret", authConfigId: "ac_managed" },
        "blue:user_123",
        "gmail",
      ),
    ).resolves.toMatchObject({
      service: "gmail",
      toolkit: "gmail",
      status: "pending",
      authorizationUrl: "https://connect.composio.dev/link/link_managed",
    });
    expect(requests[2]?.url.endsWith("/api/v3/connected_accounts/link")).toBe(
      true,
    );
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      auth_config_id: "ac_managed",
      user_id: "blue:user_123",
    });
  });

  it("uses an explicitly configured Google Calendar auth config", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/auth_configs/ac_calendar")) {
          return Promise.resolve(
            Response.json({
              id: "ac_calendar",
              status: "ENABLED",
              is_composio_managed: true,
              toolkit: { slug: "googlecalendar" },
            }),
          );
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(Response.json({ items: [] }));
        }
        return Promise.resolve(
          Response.json(
            {
              redirect_url: "https://connect.composio.dev/link/calendar",
              connected_account_id: "ca_calendar_pending",
            },
            { status: 201 },
          ),
        );
      }),
    );

    await expect(
      linkManagedGoogleConnection(
        { apiKey: "secret", authConfigId: "ac_calendar" },
        "blue:user_123",
        "calendar",
      ),
    ).resolves.toMatchObject({
      service: "calendar",
      toolkit: "googlecalendar",
      scopes: ["https://www.googleapis.com/auth/calendar"],
      status: "pending",
      authorizationUrl: "https://connect.composio.dev/link/calendar",
    });
    expect(requests[2]?.url.endsWith("/api/v3/connected_accounts/link")).toBe(
      true,
    );
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      auth_config_id: "ac_calendar",
      user_id: "blue:user_123",
    });
  });

  it("resolves the connected Google Calendar email for display", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/auth_configs/ac_calendar")) {
          return Promise.resolve(
            Response.json({
              id: "ac_calendar",
              status: "ENABLED",
              toolkit: { slug: "googlecalendar" },
            }),
          );
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(
            Response.json({
              items: [
                {
                  id: "ca_calendar",
                  status: "ACTIVE",
                  user_id: "blue:user_123",
                  toolkit: { slug: "googlecalendar" },
                  auth_config: { id: "ac_calendar" },
                },
              ],
            }),
          );
        }
        expect(JSON.parse(String(init?.body))).toMatchObject({
          connected_account_id: "ca_calendar",
          endpoint: "/users/me/calendarList?minAccessRole=reader",
          method: "GET",
        });
        return Promise.resolve(
          Response.json({
            status: 200,
            data: {
              items: [
                { id: "team@example.com" },
                { id: "owner@example.com", primary: true },
              ],
            },
          }),
        );
      }),
    );

    await expect(
      managedGoogleConnection(
        { apiKey: "secret", authConfigId: "ac_calendar" },
        "blue:user_123",
        "calendar",
      ),
    ).resolves.toMatchObject({
      status: "connected",
      connectedAccountId: "ca_calendar",
      displayName: "owner@example.com",
    });
    expect(requests).toHaveLength(3);
  });

  it("treats a new scope profile as pending until the user reconnects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/auth_configs/ac_gmail_readonly")) {
          return Promise.resolve(
            Response.json({
              id: "ac_gmail_readonly",
              status: "ENABLED",
              is_composio_managed: false,
              toolkit: { slug: "gmail" },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            items: [
              {
                id: "ca_old_modify_grant",
                status: "ACTIVE",
                user_id: "blue:user_123",
                toolkit: { slug: "gmail" },
                auth_config: { id: "ac_gmail_modify" },
              },
            ],
          }),
        );
      }),
    );

    await expect(
      managedGoogleConnection(
        {
          apiKey: "secret",
          authConfigId: "ac_gmail_readonly",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
        "blue:user_123",
        "gmail",
      ),
    ).resolves.toEqual({
      service: "gmail",
      toolkit: "gmail",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "pending",
      connectedAccountId: undefined,
    });
  });

  it("disconnects only the authenticated user's active Gmail account", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/auth_configs/ac_gmail")) {
          return Promise.resolve(
            Response.json({
              id: "ac_gmail",
              status: "ENABLED",
              toolkit: { slug: "gmail" },
            }),
          );
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(
            Response.json({
              items: [
                {
                  id: "ca_gmail",
                  status: "ACTIVE",
                  user_id: "blue:user_123",
                  toolkit: { slug: "gmail" },
                  auth_config: { id: "ac_gmail" },
                },
              ],
            }),
          );
        }
        return Promise.resolve(Response.json({ success: true }));
      }),
    );

    await expect(
      disconnectManagedGoogleConnection(
        { apiKey: "secret", authConfigId: "ac_gmail" },
        "blue:user_123",
        "gmail",
      ),
    ).resolves.toMatchObject({
      service: "gmail",
      toolkit: "gmail",
      status: "disconnected",
      connectedAccountId: "ca_gmail",
    });
    // Consent is NOT withdrawn by default. Google revokes per application, not
    // per token, so withdrawing it takes every connected account on the same
    // Google user and OAuth client — someone who connected two mailboxes from
    // one account would lose both by removing one.
    expect(requests[2]?.url).toBe(
      "https://backend.composio.dev/api/v3.1/connected_accounts/ca_gmail",
    );
    expect(requests[2]?.init?.method).toBe("DELETE");

    // The caller asks for it only when nothing else shares the account.
    requests.length = 0;
    await disconnectManagedGoogleConnection(
      { apiKey: "secret", authConfigId: "ac_gmail" },
      "blue:user_123",
      "gmail",
      { revoke: true },
    );
    expect(requests[2]?.url).toBe(
      "https://backend.composio.dev/api/v3.1/connected_accounts/ca_gmail?revoke_on_delete=true",
    );
  });

  it("does not disconnect a connected account owned by another user", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/auth_configs/ac_gmail")) {
          return Promise.resolve(
            Response.json({
              id: "ac_gmail",
              status: "ENABLED",
              toolkit: { slug: "gmail" },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            items: [
              {
                id: "ca_other_user",
                status: "ACTIVE",
                user_id: "blue:user_other",
                toolkit: { slug: "gmail" },
                auth_config: { id: "ac_gmail" },
              },
            ],
          }),
        );
      }),
    );

    await expect(
      disconnectManagedGoogleConnection(
        { apiKey: "secret", authConfigId: "ac_gmail" },
        "blue:user_123",
        "gmail",
      ),
    ).resolves.toMatchObject({ status: "disconnected" });
    expect(requests).toHaveLength(2);
    expect(requests.some((request) => request.init?.method === "DELETE")).toBe(
      false,
    );
  });

  it("proxies Gmail through the matching custom connected account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/auth_configs/ac_gmail")) {
          return Promise.resolve(
            Response.json({
              id: "ac_gmail",
              status: "ENABLED",
              is_composio_managed: false,
              toolkit: { slug: "gmail" },
            }),
          );
        }
        if (url.includes("/connected_accounts?")) {
          return Promise.resolve(
            Response.json({
              items: [
                {
                  id: "ca_gmail",
                  status: "ACTIVE",
                  user_id: "blue:user_123",
                  toolkit: { slug: "gmail" },
                  auth_config: { id: "ac_gmail" },
                },
              ],
            }),
          );
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          connected_account_id: "ca_gmail",
          endpoint: "/gmail/v1/users/me/messages",
          method: "GET",
        });
        return Promise.resolve(
          Response.json({
            status: 200,
            data: { messages: [{ id: "one" }] },
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );

    await expect(
      proxyManagedGoogleRequest(
        { apiKey: "secret", authConfigId: "ac_gmail" },
        "blue:user_123",
        {
          service: "gmail",
          path: "/gmail/v1/users/me/messages",
        },
      ),
    ).resolves.toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"messages":[{"id":"one"}]}',
    });
  });

  it("forwards a Calendar event creation body through the proxy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          connected_account_id: "ca_calendar",
          endpoint: "/calendars/primary/events",
          method: "POST",
          body: {
            summary: "Out of office",
            start: { date: "2026-08-05" },
            end: { date: "2026-08-06" },
            transparency: "opaque",
          },
        });
        expect(body).not.toHaveProperty("parameters");
        return Promise.resolve(
          Response.json({ status: 200, data: { id: "event_123" } }),
        );
      }),
    );

    await expect(
      proxyManagedGoogleAccountRequest(
        { apiKey: "secret" },
        "ca_calendar",
        {
          service: "calendar",
          method: "POST",
          path: "/calendars/primary/events",
          body: JSON.stringify({
            summary: "Out of office",
            start: { date: "2026-08-05" },
            end: { date: "2026-08-06" },
            transparency: "opaque",
          }),
          headers: { "content-type": "application/json" },
        },
      ),
    ).resolves.toMatchObject({ status: 200, body: '{"id":"event_123"}' });
  });
});
