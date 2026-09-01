import { afterEach, describe, expect, it, vi } from "vitest";

import {
  annotateBillingResponse,
  dataAnalystTokenMatches,
  handleDataAnalystAPI,
  type DataAnalystEnv,
} from "./data_analyst";

function env(overrides: Partial<DataAnalystEnv> = {}): DataAnalystEnv {
  return {
    DATA_ANALYST_API_TOKEN: "analyst-secret",
    OC_MANAGED_AGENTS_SECRET: "managed-secret",
    MANAGED_AGENTS_API_URL: "https://managedagents.test",
    ...overrides,
  } as DataAnalystEnv;
}

function request(path: string, token = "analyst-secret", method = "GET") {
  return new Request(`https://app.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("internal data analyst API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compares credentials without comparing their raw values", async () => {
    await expect(
      dataAnalystTokenMatches("analyst-secret", "analyst-secret"),
    ).resolves.toBe(true);
    await expect(
      dataAnalystTokenMatches("wrong-secret", "analyst-secret"),
    ).resolves.toBe(false);
  });

  it("is disabled when the dedicated credential is absent", async () => {
    const response = await handleDataAnalystAPI(
      request("/api/internal/data-analyst/orgs/org_1/sessions"),
      env({ DATA_ANALYST_API_TOKEN: undefined }),
      "/api/internal/data-analyst/orgs/org_1/sessions",
    );
    expect(response.status).toBe(404);
  });

  it("authenticates before resolving an organization and remains GET-only", async () => {
    const path = "/api/internal/data-analyst/orgs/org_1/sessions";
    const unauthorized = await handleDataAnalystAPI(
      request(path, "wrong-secret"),
      env(),
      path,
    );
    expect(unauthorized.status).toBe(401);

    const wrongMethod = await handleDataAnalystAPI(
      request(path, "analyst-secret", "POST"),
      env(),
      path,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("bounds session fan-out and omits the initial-input preview by default", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        sessions: [
          {
            id: "session_1",
            title: "customer-provided first turn",
            source: "schedule",
            runtimeSecondsByTier: { "2gb_1vcpu": 60 },
          },
        ],
      }),
    );
    const requestPath =
      "/api/internal/data-analyst/orgs/org_1/sessions?limit=999";
    const path = "/api/internal/data-analyst/orgs/org_1/sessions";
    const response = await handleDataAnalystAPI(
      request(requestPath),
      env(),
      path,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/v1/billing/sessions?limit=100",
    );
    const body = await response.json();
    expect(body).toMatchObject({
      orgId: "org_1",
      sessions: [
        {
          id: "session_1",
          source: "schedule",
          runtimeSecondsByTier: { "2gb_1vcpu": 60 },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("customer-provided");
  });

  it("returns the bounded preview only when explicitly requested", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        sessions: [{ id: "session_1", title: "first turn" }],
      }),
    );
    const requestPath =
      "/api/internal/data-analyst/orgs/org_1/sessions?include_preview=true";
    const path = "/api/internal/data-analyst/orgs/org_1/sessions";
    const response = await handleDataAnalystAPI(
      request(requestPath),
      env(),
      path,
    );

    expect(await response.json()).toMatchObject({
      sessions: [{ id: "session_1", title: "first turn" }],
    });
  });

  it("adds organization scope and freshness to a successful billing response", async () => {
    const response = await annotateBillingResponse(
      Response.json({ creditsRemainingCents: 1234 }),
      "org_1",
      "2026-09-01T12:00:00.000Z",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      orgId: "org_1",
      observedAt: "2026-09-01T12:00:00.000Z",
      creditsRemainingCents: 1234,
    });
  });
});
