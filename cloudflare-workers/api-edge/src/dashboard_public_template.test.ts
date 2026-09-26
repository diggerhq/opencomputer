import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDashboard, type DashboardEnv } from "./dashboard";

const env = {
  SESSION_JWT_SECRET: "test-secret",
  MANAGED_AGENTS_API_URL: "https://managedagents.test",
  OPENCOMPUTER_DB: {
    prepare: () => {
      throw new Error("anonymous requests must not touch D1");
    },
  },
} as unknown as DashboardEnv;

function anonymousPost(path: string): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryUrl: "https://github.com/acme/template" }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("anonymous dashboard template inspection", () => {
  it("proxies template inspection to the public upstream route without a session", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        template: {
          name: "Template",
          repositoryUrl: "https://github.com/acme/template",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const path = "/api/dashboard/managed-agents/template-inspections";
    const response = await handleDashboard(
      anonymousPost(path),
      env,
      {} as ExecutionContext,
      path,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(String(target)).toBe(
      "https://managedagents.test/v1/public/template-inspections",
    );
    expect(
      new Headers(init.headers).get("x-opencomputer-agent-token"),
    ).toBeNull();
  });

  it("still rejects anonymous template installation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const path = "/api/dashboard/managed-agents/template-installations";
    const response = await handleDashboard(
      anonymousPost(path),
      env,
      {} as ExecutionContext,
      path,
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
