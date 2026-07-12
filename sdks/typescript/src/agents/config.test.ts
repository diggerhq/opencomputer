import { describe, expect, it, vi } from "vitest";
import { OpenComputer } from "./client.js";

describe("Flue agent config", () => {
  it("normalizes config and serializes replacement writes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "PUT") {
        return Response.json({ vars: { MODE: "safe" }, egress_allowlist: ["api.example.com"], deployment_required: true });
      }
      return Response.json({ vars: {}, egress_allowlist: [] });
    });
    const oc = new OpenComputer({ apiKey: "test", baseUrl: "https://cp.example/v3", fetch: fetch as typeof globalThis.fetch });

    const saved = await oc.agents.config.put("agt_1", {
      vars: { MODE: "safe" }, egressAllowlist: ["api.example.com"],
    });

    expect(saved.egressAllowlist).toEqual(["api.example.com"]);
    expect(saved.deploymentRequired).toBe(true);
    expect(calls[0]?.url).toBe("https://cp.example/v3/agents/agt_1/config");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      vars: { MODE: "safe" }, egress_allowlist: ["api.example.com"],
    });
  });

  it("never expects values when listing write-only secrets", async () => {
    const fetch = vi.fn(async () => Response.json({
      data: [{ name: "GITHUB_TOKEN", last4: "1234", updated_at: "2026-07-12T00:00:00Z", sync_status: "synced" }],
    }));
    const oc = new OpenComputer({ apiKey: "test", baseUrl: "https://cp.example/v3", fetch: fetch as typeof globalThis.fetch });
    const secrets = await oc.agents.config.listSecrets("agt_1");
    expect(secrets).toEqual([{ name: "GITHUB_TOKEN", last4: "1234", updatedAt: "2026-07-12T00:00:00Z", syncStatus: "synced" }]);
    expect(secrets[0]).not.toHaveProperty("value");
  });
});
