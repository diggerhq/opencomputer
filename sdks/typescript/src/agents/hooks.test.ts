import { describe, expect, it, vi } from "vitest";
import { OpenComputer } from "./client.js";

function client(fetcher: typeof fetch) {
  return new OpenComputer({
    apiKey: "test-key",
    baseUrl: "https://api.example.test/v3",
    fetch: fetcher,
    maxRetries: 0,
  });
}

describe("Agent URLs and Hooks", () => {
  it("maps the canonical Agent URL without adding an invoke helper", async () => {
    const fetcher = vi.fn(async () => Response.json({
      id: "agt_0123456789abcdef01234567",
      name: "triage",
      invoke_url: "https://agt-0123456789abcdef01234567.agents.opencomputer.dev",
      model: "anthropic/claude-sonnet-5",
      runtime: "claude",
    }));
    const oc = client(fetcher as typeof fetch);

    const agent = await oc.agents.get("agt_0123456789abcdef01234567");

    expect(agent.invokeUrl).toBe(
      "https://agt-0123456789abcdef01234567.agents.opencomputer.dev",
    );
    expect("invoke" in oc.agents).toBe(false);
  });

  it("returns the complete Hook URL only from create", async () => {
    const fetcher = vi.fn(async () => Response.json({
      hook: {
        id: "hk_0123456789abcdef01234567",
        agent_id: "agt_0123456789abcdef01234567",
        name: "grafana-prod",
        status: "active",
        secret_last4: "dHh8",
        revoked_reason: null,
        expires_at: null,
        created_at: "2026-07-22T12:00:00.000Z",
      },
      hook_url: "https://agt-0123456789abcdef01234567.agents.opencomputer.dev/hooks/ochk_v1_secret",
    }, { status: 201 }));
    const oc = client(fetcher as typeof fetch);

    const created = await oc.agents.hooks.create(
      "agt_0123456789abcdef01234567",
      { name: "grafana-prod", expiresAt: null },
    );

    expect(created.hookUrl).toContain("/hooks/ochk_v1_");
    expect(created.hook).toMatchObject({
      agentId: "agt_0123456789abcdef01234567",
      secretLast4: "dHh8",
      revokedReason: null,
    });
    expect(JSON.stringify(created.hook)).not.toContain("ochk_v1_");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v3/agents/agt_0123456789abcdef01234567/hooks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "grafana-prod", expires_at: null }),
      }),
    );
  });

  it("lists, gets, and revokes without a credential recovery surface", async () => {
    const responses = [
      Response.json({
        data: [{
          id: "hk_0123456789abcdef01234567",
          agent_id: "agt_0123456789abcdef01234567",
          name: "grafana-prod",
          status: "revoked",
          secret_last4: "dHh8",
          revoked_reason: "secret_exposure",
          expires_at: null,
          created_at: "2026-07-22T12:00:00.000Z",
        }],
        next_cursor: "cursor-2",
      }),
      Response.json({
        id: "hk_0123456789abcdef01234567",
        agent_id: "agt_0123456789abcdef01234567",
        name: "grafana-prod",
        status: "revoked",
        secret_last4: "dHh8",
        revoked_reason: "secret_exposure",
        expires_at: null,
        created_at: "2026-07-22T12:00:00.000Z",
      }),
      new Response(null, { status: 204 }),
    ];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responses.shift()!
    );
    const oc = client(fetcher as typeof fetch);

    const page = await oc.agents.hooks.list(
      "agt_0123456789abcdef01234567",
      { includeRevoked: true, cursor: "cursor-1", limit: 10 },
    );
    const hook = await oc.agents.hooks.get(
      "agt_0123456789abcdef01234567",
      "hk_0123456789abcdef01234567",
    );
    await oc.agents.hooks.delete(
      "agt_0123456789abcdef01234567",
      "hk_0123456789abcdef01234567",
    );

    expect(page.nextCursor).toBe("cursor-2");
    expect(page.data[0].revokedReason).toBe("secret_exposure");
    expect(hook).not.toHaveProperty("hookUrl");
    expect(fetcher.mock.calls[0][0]).toContain(
      "include_revoked=true&cursor=cursor-1&limit=10",
    );
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
  });
});
