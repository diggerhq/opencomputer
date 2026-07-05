// Pure-logic tests (no Workers runtime needed): token crypto, cost extraction, path mapping.
// The full on-path flow (DO budget gate + forward + meter) is exercised by the wrangler-dev
// integration documented in README.md. Run: npx vitest run

import { describe, it, expect } from "vitest";
import { mintSessionToken, verifySessionToken, type SessionClaims } from "../src/token.js";
import { costFromJson, costFromStream } from "../src/cost.js";

const SECRET = "spike-secret";
const now = 1_800_000_000;
const claims = (o: Partial<SessionClaims> = {}): SessionClaims => ({
  sub: "ses_abc", org: "org_1", agt: "agt_1", bud: 0.5, iat: now, exp: now + 3600, ...o,
});

describe("session token", () => {
  it("mint → verify round-trips the claims", async () => {
    const t = await mintSessionToken(SECRET, claims());
    const v = await verifySessionToken(SECRET, t, now);
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.claims.sub).toBe("ses_abc"); expect(v.claims.org).toBe("org_1"); expect(v.claims.bud).toBe(0.5); }
  });
  it("rejects a tampered payload", async () => {
    const t = await mintSessionToken(SECRET, claims());
    const [h, , s] = t.split(".");
    const forged = btoa(JSON.stringify(claims({ org: "org_evil" }))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const v = await verifySessionToken(SECRET, `${h}.${forged}.${s}`, now);
    expect(v.ok).toBe(false);
  });
  it("rejects the wrong secret", async () => {
    const t = await mintSessionToken(SECRET, claims());
    const v = await verifySessionToken("other-secret", t, now);
    expect(v.ok).toBe(false);
  });
  it("rejects an expired token", async () => {
    const t = await mintSessionToken(SECRET, claims({ exp: now - 1 }));
    const v = await verifySessionToken(SECRET, t, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });
});

describe("cost extraction", () => {
  it("reads usage.cost from a JSON response", () => {
    const c = costFromJson(JSON.stringify({ id: "gen-123", usage: { cost: 0.0042, prompt_tokens: 10 } }));
    expect(c.costUsd).toBe(0.0042);
    expect(c.generationId).toBe("gen-123");
    expect(c.source).toBe("usage.cost");
  });
  it("falls back to usage.total_cost", () => {
    const c = costFromJson(JSON.stringify({ id: "g", usage: { total_cost: 0.01 } }));
    expect(c.costUsd).toBe(0.01);
    expect(c.source).toBe("usage.total_cost");
  });
  it("returns null cost when the echo lacks it (flagged, never guessed)", () => {
    const c = costFromJson(JSON.stringify({ id: "g", usage: { prompt_tokens: 10 } }));
    expect(c.costUsd).toBeNull();
    expect(c.source).toBe("none");
  });
  it("extracts cost + generation id from an SSE stream", async () => {
    const sse = [
      'data: {"id":"gen-9","type":"message_start"}',
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
      'data: {"type":"message_delta","usage":{"cost":0.0009,"output_tokens":3}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const stream = new Response(sse).body!;
    const c = await costFromStream(stream);
    expect(c.costUsd).toBe(0.0009);
    expect(c.generationId).toBe("gen-9");
  });
});
