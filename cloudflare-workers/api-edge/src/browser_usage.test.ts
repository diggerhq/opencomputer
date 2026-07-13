import { describe, expect, it, vi } from "vitest";
import { browserUsageInternal, type AutumnEnv } from "./autumn_webhook";

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function env(): AutumnEnv {
  return {
    AUTUMN_SECRET_KEY: "autumn-secret",
    AUTUMN_BASE_URL: "https://autumn.test/v1",
    AUTUMN_WEBHOOK_SECRET: "whsec_test",
    EVENT_SECRET: "event-secret",
    BROWSER_USAGE_HMAC_SECRET: "browser-usage-secret",
    CF_ADMIN_SECRET: "admin-secret",
    OPENCOMPUTER_DB: {} as D1Database,
  };
}

describe("browser usage billing", () => {
  it("tracks browser runtime into Autumn with the signed usage payload", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ balance: { remaining: 10 } }));
    const body = JSON.stringify({
      org_id: "org_1",
      browser_id: "br_1",
      provider_session_id: "kernel_1",
      seconds: 60,
      value: 60,
      usage_micro: 8000,
      idempotency_key: "browser_runtime:br_1",
      feature_id: "browser_runtime",
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const path = "/internal/browser-usage";
    const sig = await hmacHex("browser-usage-secret", `${ts}.${path}.${body}`);

    const resp = await browserUsageInternal(
      new Request(`https://api.test${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Timestamp": ts,
          "X-Signature": sig,
        },
        body,
      }),
      env(),
    );

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      ok: true,
      billed: true,
      org_id: "org_1",
      browser_id: "br_1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://autumn.test/v1/track",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer autumn-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customer_id: "org_1",
          feature_id: "browser_runtime",
          value: 60,
          idempotency_key: "browser_runtime:br_1",
        }),
      }),
    );
  });
});
