import { describe, expect, it, vi } from "vitest";
import { agentRuntimeUsageInternal, type AutumnEnv } from "./autumn_webhook";

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function env(): AutumnEnv {
  return {
    AUTUMN_SECRET_KEY: "autumn-secret",
    AUTUMN_BASE_URL: "https://autumn.test/v1",
    AUTUMN_WEBHOOK_SECRET: "whsec_test",
    EVENT_SECRET: "event-secret",
    AGENT_RUNTIME_USAGE_HMAC_SECRET: "agent-runtime-secret",
    CF_ADMIN_SECRET: "admin-secret",
    OPENCOMPUTER_DB: {} as D1Database,
  };
}

describe("managed-agent runtime usage billing", () => {
  it("tracks a finalized resource segment with its stable idempotency key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ balance: { remaining: 9.7 } }));
    const body = JSON.stringify({
      org_id: "org_1",
      deployment_id: "dep_1",
      agent_id: "agent_1",
      session_id: "session_1",
      microvm_id: "vm_1",
      resource_tier: "2gb_1vcpu",
      quantity_seconds: 60,
      idempotency_key: "lease_1:final",
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const path = "/internal/agent-runtime-usage";
    const sig = await hmacHex("agent-runtime-secret", `${ts}.${path}.${body}`);

    const response = await agentRuntimeUsageInternal(
      new Request(`https://api.test${path}`, {
        method: "POST",
        headers: { "X-Timestamp": ts, "X-Signature": sig },
        body,
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      billed: true,
      org_id: "org_1",
      session_id: "session_1",
      remaining: 9.7,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://autumn.test/v1/track",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "lease_1:final",
        }),
        body: JSON.stringify({
          customer_id: "org_1",
          feature_id: "agent_runtime_2gb_1vcpu",
          value: 60,
          idempotency_key: "lease_1:final",
        }),
      }),
    );
  });
});
