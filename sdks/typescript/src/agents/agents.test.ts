import { describe, expect, it, vi } from "vitest";
import { OpenComputer } from "./client.js";

describe("Agents Slack", () => {
  it("exposes the builder-owned app deep link", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        id: "sla_1",
        agent_id: "agt_1",
        status: "active",
        slack_app_id: "A1",
        team_id: "T1",
        open_url: "https://slack.com/app_redirect?app=A1&team=T1",
      }),
    );
    const oc = new OpenComputer({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v3",
      fetch: fetcher as typeof fetch,
      maxRetries: 0,
    });

    const result = await oc.agents.getSlack("agt_1");

    expect(result.openUrl).toBe(
      "https://slack.com/app_redirect?app=A1&team=T1",
    );
  });

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

    expect("authorizeUrl" in result).toBe(true);
    expect("authorizeUrl" in result ? result.authorizeUrl : undefined).toContain(
      "slack.com/oauth/v2/authorize",
    );
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

  it("returns an already-active connection from a raced authorize", async () => {
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

    const result = await oc.agents.authorizeManagedSlack("agt_1");

    expect(result).toMatchObject({ status: "active" });
    expect("openUrl" in result ? result.openUrl : undefined).toContain(
      "slack.com/app_redirect",
    );
  });

  it("lists current owner workspace claims before OAuth", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: [
          {
            mode: "managed",
            status: "active",
            workspace: { id: "T1", name: "Acme" },
            app: { id: "A1", handle: "OpenComputer" },
            open_url: "https://slack.com/app_redirect?app=A1&team=T1",
            connected_at: "2026-07-16T17:00:00Z",
            agent: { id: "agt_1", name: "Support triage" },
          },
        ],
      }),
    );
    const oc = new OpenComputer({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v3",
      fetch: fetcher as typeof fetch,
      maxRetries: 0,
    });

    const result = await oc.agents.listManagedSlackConnections();

    expect(result.data[0]).toMatchObject({
      workspace: { id: "T1", name: "Acme" },
      agent: { id: "agt_1", name: "Support triage" },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v3/slack/managed/connections",
      expect.objectContaining({ method: "GET" }),
    );
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
