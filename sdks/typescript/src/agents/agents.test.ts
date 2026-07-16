import { describe, expect, it, vi } from "vitest";
import { OpenComputer } from "./client.js";

describe("Agents managed Slack", () => {
  it("starts OAuth with validated deployment return context", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json({
        mode: "managed",
        status: "pending",
        authorize_url: "https://slack.com/oauth/v2/authorize?state=opaque",
        expires_at: "2026-07-16T18:00:00Z",
      }),
    );
    const oc = new OpenComputer({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v3",
      fetch: fetcher as typeof fetch,
      maxRetries: 0,
    });

    const result = await oc.agents.authorizeManagedSlack("agt_1", {
      returnDeploymentId: "dep_1",
    });

    expect(result.authorizeUrl).toContain("slack.com/oauth/v2/authorize");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v3/agents/agt_1/slack/managed/authorize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ return_deployment_id: "dep_1" }),
      }),
    );
  });

  it("reads the browser-safe managed connection", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        mode: "managed",
        status: "active",
        workspace: { id: "T1", name: "Acme" },
        app: { id: "A1", handle: "OpenComputer" },
        open_url: "https://slack.com/app_redirect?app=A1&team=T1",
        connected_at: "2026-07-16T17:00:00Z",
      }),
    );
    const oc = new OpenComputer({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v3",
      fetch: fetcher as typeof fetch,
      maxRetries: 0,
    });

    const result = await oc.agents.getManagedSlack("agt_1");

    expect(result).toMatchObject({
      mode: "managed",
      status: "active",
      openUrl: "https://slack.com/app_redirect?app=A1&team=T1",
    });
    expect(JSON.stringify(result)).not.toContain("xoxb-");
  });

  it("disconnects the managed connection without uninstalling the app", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ok: true, status: "disconnected" }),
    );
    const oc = new OpenComputer({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v3",
      fetch: fetcher as typeof fetch,
      maxRetries: 0,
    });

    await expect(
      oc.agents.disconnectManagedSlack("agt_1"),
    ).resolves.toEqual({ ok: true, status: "disconnected" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v3/agents/agt_1/slack/managed",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
