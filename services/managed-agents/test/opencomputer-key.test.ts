import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/edge/runtime-usage.js";
import { COMPUTER_KEYS_PATH, mintOpenComputerKey } from "../src/computer/opencomputer-key.js";

const env = { OPENCOMPUTER_APP_URL: "https://app.example.dev/", OC_MANAGED_CRED_HMAC_SECRET: "secret" };

describe("mintOpenComputerKey", () => {
  it("asks the edge with a signed request and returns the key with its API URL", async () => {
    let seen: Request | undefined;
    const fetcher = (async (input: URL, init: RequestInit) => {
      seen = new Request(input, init);
      return Response.json({ key: "osb_abc", expiresAt: "2026-10-16T01:00:00.000Z" });
    }) as unknown as typeof fetch;
    const key = await mintOpenComputerKey(env, "org-1", undefined, fetcher);
    expect(key).toEqual({ token: "osb_abc", expiresAt: "2026-10-16T01:00:00.000Z", apiUrl: "https://app.example.dev" });
    expect(new URL(seen!.url).pathname).toBe(COMPUTER_KEYS_PATH);
    const body = await seen!.text();
    expect(JSON.parse(body)).toEqual({ org_id: "org-1" });
    const ts = seen!.headers.get("X-Timestamp")!;
    expect(seen!.headers.get("X-Signature")).toBe(await hmacSha256Hex("secret", `${ts}.${body}`));
  });

  it("names the session it was checked for", async () => {
    let body = "";
    const fetcher = (async (_input: URL, init: RequestInit) => {
      body = String(init.body);
      return Response.json({ key: "osb_abc", expiresAt: "2026-10-16T01:00:00.000Z" });
    }) as unknown as typeof fetch;
    await mintOpenComputerKey(env, "org-1", "T1:C1:100.1", fetcher);
    expect(JSON.parse(body)).toEqual({ org_id: "org-1", session_key: "T1:C1:100.1" });
  });

  it("fails when unconfigured or refused", async () => {
    await expect(mintOpenComputerKey({}, "org-1")).rejects.toThrow(/not configured/);
    const refused = (async () => new Response("org not found", { status: 404 })) as unknown as typeof fetch;
    await expect(mintOpenComputerKey(env, "org-1", undefined, refused)).rejects.toThrow(/404/);
  });
});
