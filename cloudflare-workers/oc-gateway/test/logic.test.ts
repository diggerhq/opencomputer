// Pure-logic tests (no Workers runtime needed): EdDSA token crypto, the SessionBudget DO's epoch
// fence + budget gate + idempotency (over a fake DurableObjectState), cache_control safety, and cost
// extraction. The full on-path flow (forward + meter) is exercised by the live integration in
// README.md / scripts/e2e. Run: npx vitest run

import { describe, it, expect } from "vitest";
import { generateKeyPair, mintSessionToken, verifySessionToken, type SessionClaims } from "../src/token.js";
import { costFromJson, costFromStream } from "../src/cost.js";
import { unsafeModelMatchers, modelNeedsCacheStrip, stripCacheControl } from "../src/models.js";
import { SessionBudget } from "../src/budget.js";

const now = 1_800_000_000;
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const claims = (o: Partial<SessionClaims> = {}): SessionClaims => ({
  sub: "ses_abc", org: "org_1", agt: "agt_1", bud: 0.5, ep: 2, iat: now, exp: now + 3600, ...o,
});

describe("session token (EdDSA)", () => {
  it("mint → verify round-trips the claims", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const v = await verifySessionToken(publicKeyB64url, await mintSessionToken(privateKey, claims()), now);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.sub).toBe("ses_abc");
      expect(v.claims.org).toBe("org_1");
      expect(v.claims.bud).toBe(0.5);
      expect(v.claims.ep).toBe(2);
    }
  });
  it("rejects a token signed by a different key (gateway holds only the public key)", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const v = await verifySessionToken(b.publicKeyB64url, await mintSessionToken(a.privateKey, claims()), now);
    expect(v.ok).toBe(false);
  });
  it("rejects a tampered payload", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const [h, , s] = (await mintSessionToken(privateKey, claims())).split(".");
    const v = await verifySessionToken(publicKeyB64url, `${h}.${b64url(claims({ org: "org_evil" }))}.${s}`, now);
    expect(v.ok).toBe(false);
  });
  it("rejects an expired token", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const v = await verifySessionToken(publicKeyB64url, await mintSessionToken(privateKey, claims({ exp: now - 1 })), now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });
  it("pins alg=EdDSA — rejects an alg-swap (none/HS256) header", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const [, p, s] = (await mintSessionToken(privateKey, claims())).split(".");
    const v = await verifySessionToken(publicKeyB64url, `${b64url({ alg: "none", typ: "JWT" })}.${p}.${s}`, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unexpected_alg");
  });
});

describe("SessionBudget DO — epoch fence + budget gate + idempotency", () => {
  function fakeState(): DurableObjectState {
    const m = new Map<string, unknown>();
    return { storage: { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v) } } as unknown as DurableObjectState;
  }
  const call = async (bd: SessionBudget, path: string, body: unknown) =>
    (await bd.fetch(new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;

  it("fences a stale lease epoch (monotonic)", async () => {
    const bd = new SessionBudget(fakeState());
    expect((await call(bd, "/check", { ep: 1 })).allowed).toBe(true);
    expect((await call(bd, "/check", { ep: 2 })).allowed).toBe(true); // adopt the newer epoch
    const stale = await call(bd, "/check", { ep: 1 }); // the old turn's token is now superseded
    expect(stale.fenced).toBe(true);
    expect(stale.allowed).toBe(false);
  });

  it("gates on the per-session budget (spent < budget)", async () => {
    const bd = new SessionBudget(fakeState());
    const cap = 1_000_000; // $1.00 in µ$
    expect((await call(bd, "/check", { budget_micro: cap, ep: 1 })).allowed).toBe(true);
    await call(bd, "/add", { cost_micro: 600_000, idem: "g1" });
    expect((await call(bd, "/check", { budget_micro: cap, ep: 1 })).allowed).toBe(true); // 0.6 < 1.0
    await call(bd, "/add", { cost_micro: 600_000, idem: "g2" }); // now 1.2 > 1.0
    expect((await call(bd, "/check", { budget_micro: cap, ep: 1 })).allowed).toBe(false);
  });

  it("dedupes /add by generation id (retried meter never double-counts)", async () => {
    const bd = new SessionBudget(fakeState());
    await call(bd, "/add", { cost_micro: 100_000, idem: "gen-x" });
    const second = await call(bd, "/add", { cost_micro: 100_000, idem: "gen-x" });
    expect(second.deduped).toBe(true);
    const st = (await (await bd.fetch(new Request("https://do/state"))).json()) as { spent_micro: number };
    expect(st.spent_micro).toBe(100_000);
  });
});

describe("cache_control safety", () => {
  const m = unsafeModelMatchers();
  it("flags claude-3-haiku, leaves sonnet alone", () => {
    expect(modelNeedsCacheStrip("anthropic/claude-3-haiku", m)).toBe(true);
    expect(modelNeedsCacheStrip("anthropic/claude-sonnet-4", m)).toBe(false);
  });
  it("env extends the denylist", () => {
    expect(modelNeedsCacheStrip("vendor/some-bedrock-model", unsafeModelMatchers("some-bedrock-model"))).toBe(true);
  });
  it("strips every nested cache_control in place", () => {
    const body = {
      model: "anthropic/claude-3-haiku",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    };
    expect(stripCacheControl(body)).toBe(2);
    expect(JSON.stringify(body).includes("cache_control")).toBe(false);
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
    const c = await costFromStream(new Response(sse).body!);
    expect(c.costUsd).toBe(0.0009);
    expect(c.generationId).toBe("gen-9");
  });
});
