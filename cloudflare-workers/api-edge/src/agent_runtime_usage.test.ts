import { afterEach, describe, expect, it, vi } from "vitest";
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

async function post(fields: Record<string, unknown>) {
  const body = JSON.stringify({
    org_id: "org_1",
    deployment_id: "dep_1",
    agent_id: "agent_1",
    session_id: "session_1",
    microvm_id: "vm_1",
    resource_tier: "2gb_1vcpu",
    quantity_seconds: 60,
    close_reason: "suspended",
    idempotency_key: "lease_1:final",
    ...fields,
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const path = "/internal/agent-runtime-usage";
  const sig = await hmacHex("agent-runtime-secret", `${ts}.${path}.${body}`);
  return agentRuntimeUsageInternal(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { "X-Timestamp": ts, "X-Signature": sig },
      body,
    }),
    env(),
  );
}

describe("managed-agent runtime usage billing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bills an org on a work-minute plan in work minutes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ id: "org_1", balances: { work_minutes: { remaining: 600 }, credits: { remaining: 10 } } }),
      )
      .mockResolvedValueOnce(Response.json({ balance: { remaining: 595.5 } }));

    const response = await post({ quantity_seconds: 270, close_reason: "idle", idempotency_key: "crt_1:3" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ feature_id: "work_minutes", remaining: 595.5 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://autumn.test/v1/track",
      expect.objectContaining({
        body: JSON.stringify({
          customer_id: "org_1",
          feature_id: "work_minutes",
          value: 4.5,
          idempotency_key: "crt_1:3",
        }),
      }),
    );
  });

  it("bills a turn as work minutes on a work-minute plan", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "org_1", balances: { work_minutes: { remaining: 600 } } }))
      .mockResolvedValueOnce(Response.json({ balance: { remaining: 599 } }));

    const response = await post({ close_reason: "turn_settled", idempotency_key: "turn_1:turn" });

    expect(await response.json()).toMatchObject({ billed: true, feature_id: "work_minutes" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a turn on a credit plan without billing it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "org_1", balances: { credits: { remaining: 10 } } }));

    const response = await post({ close_reason: "turn_settled", idempotency_key: "turn_1:turn" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, billed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a microVM lease on a work-minute plan without billing it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "org_1", balances: { work_minutes: { remaining: 600 } } }));

    const response = await post({ close_reason: "session_ended" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, billed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an org the edge cannot find in Autumn on agent runtime", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ balance: { remaining: 1 } }));

    const response = await post({});

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ feature_id: "agent_runtime_2gb_1vcpu" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks blue to retry when Autumn cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("down", { status: 503 }));

    const response = await post({});

    expect(response.status).toBe(502);
  });

  it("bills an org on a credit plan in agent runtime, with the segment's idempotency key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "org_1", balances: { credits: { remaining: 10 } } }))
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
      feature_id: "agent_runtime_2gb_1vcpu",
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
