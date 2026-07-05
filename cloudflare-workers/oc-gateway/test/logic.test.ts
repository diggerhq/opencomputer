// Pure-logic tests (no Workers runtime needed): EdDSA per-deploy token crypto, the SpendCounter DO's
// budget gate + idempotency + provision, the DeployLease DO's epoch fence + bump, cache_control safety,
// and cost extraction. The full on-path flow (forward + meter) is exercised by test/integration.test.ts.
// Run: npx vitest run

import { describe, it, expect } from "vitest";
import { generateKeyPair, mintDeployToken, verifyDeployToken, type DeployClaims } from "../src/token.js";
import { costFromJson, costFromStream } from "../src/cost.js";
import { unsafeModelMatchers, modelNeedsCacheStrip, stripCacheControl } from "../src/models.js";
import { SpendCounter } from "../src/budget.js";
import { DeployLease } from "../src/deploylease.js";

const now = 1_800_000_000;
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const claims = (o: Partial<DeployClaims> = {}): DeployClaims => ({
  org: "org_1", agt: "agt_1", ep: 2, iat: now, exp: now + 3600, ...o,
});

function fakeState(): DurableObjectState {
  const m = new Map<string, unknown>();
  return { storage: { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v) } } as unknown as DurableObjectState;
}
const call = async (o: { fetch(r: Request): Promise<Response> }, path: string, body?: unknown) =>
  (await o.fetch(new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }))).json() as Promise<Record<string, unknown>>;

describe("deploy token (EdDSA, per-deploy {org, agt})", () => {
  it("mint → verify round-trips the claims", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const v = await verifyDeployToken(publicKeyB64url, await mintDeployToken(privateKey, claims()), now);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.org).toBe("org_1");
      expect(v.claims.agt).toBe("agt_1");
      expect(v.claims.ep).toBe(2);
      // resolved seam: no per-session data in the token
      const raw = v.claims as unknown as Record<string, unknown>;
      expect(raw.sub).toBeUndefined();
      expect(raw.bud).toBeUndefined();
    }
  });
  it("rejects a token signed by a different key (gateway holds only the public key)", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const v = await verifyDeployToken(b.publicKeyB64url, await mintDeployToken(a.privateKey, claims()), now);
    expect(v.ok).toBe(false);
  });
  it("rejects a tampered payload", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const [h, , s] = (await mintDeployToken(privateKey, claims())).split(".");
    const v = await verifyDeployToken(publicKeyB64url, `${h}.${b64url(claims({ org: "org_evil" }))}.${s}`, now);
    expect(v.ok).toBe(false);
  });
  it("rejects an expired token", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const v = await verifyDeployToken(publicKeyB64url, await mintDeployToken(privateKey, claims({ exp: now - 1 })), now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });
  it("rejects a token missing org/agt", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const t = await mintDeployToken(privateKey, { org: "", agt: "", iat: now, exp: now + 3600 });
    const v = await verifyDeployToken(publicKeyB64url, t, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("missing_claims");
  });
  it("pins alg=EdDSA — rejects an alg-swap (none/HS256) header", async () => {
    const { privateKey, publicKeyB64url } = await generateKeyPair();
    const [, p, s] = (await mintDeployToken(privateKey, claims())).split(".");
    const v = await verifyDeployToken(publicKeyB64url, `${b64url({ alg: "none", typ: "JWT" })}.${p}.${s}`, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unexpected_alg");
  });
});

describe("SpendCounter DO — budget gate + idempotency + provision", () => {
  it("gates on the budget (spent < budget), applies the default on first check", async () => {
    const c = new SpendCounter(fakeState());
    const capMicro = 1_000_000; // $1.00 in µ$
    expect((await call(c, "/check", { default_budget_micro: capMicro })).allowed).toBe(true);
    await call(c, "/add", { cost_micro: 600_000, idem: "g1" });
    expect((await call(c, "/check", { default_budget_micro: capMicro })).allowed).toBe(true); // 0.6 < 1.0
    await call(c, "/add", { cost_micro: 600_000, idem: "g2" }); // now 1.2 > 1.0
    expect((await call(c, "/check", { default_budget_micro: capMicro })).allowed).toBe(false);
  });

  it("a provisioned cap wins over the gateway default", async () => {
    const c = new SpendCounter(fakeState());
    await call(c, "/provision", { budget_micro: 100_000 }); // $0.10 explicit
    await call(c, "/add", { cost_micro: 150_000, idem: "x" });
    // default is huge, but the provisioned $0.10 cap is what gates
    expect((await call(c, "/check", { default_budget_micro: 999_000_000 })).allowed).toBe(false);
  });

  it("uncapped (no budget, no default) never gates", async () => {
    const c = new SpendCounter(fakeState());
    await call(c, "/add", { cost_micro: 5_000_000, idem: "big" });
    expect((await call(c, "/check", {})).allowed).toBe(true);
  });

  it("dedupes /add by generation id (retried meter never double-counts)", async () => {
    const c = new SpendCounter(fakeState());
    await call(c, "/add", { cost_micro: 100_000, idem: "gen-x" });
    const second = await call(c, "/add", { cost_micro: 100_000, idem: "gen-x" });
    expect(second.deduped).toBe(true);
    const st = (await (await c.fetch(new Request("https://do/state"))).json()) as { spent_micro: number };
    expect(st.spent_micro).toBe(100_000);
  });
});

describe("DeployLease DO — lease-epoch fence + bump (revocation)", () => {
  it("fences a stale deploy epoch (monotonic floor)", async () => {
    const l = new DeployLease(fakeState());
    expect((await call(l, "/gate", { ep: 1 })).fenced).toBe(false);
    expect((await call(l, "/gate", { ep: 2 })).fenced).toBe(false); // adopt the newer epoch → floor 2
    const stale = await call(l, "/gate", { ep: 1 }); // the old deploy's token is now superseded
    expect(stale.fenced).toBe(true);
    expect(stale.ok).toBe(false);
  });
  it("a token with no epoch is never fenced (opt-in fence)", async () => {
    const l = new DeployLease(fakeState());
    await call(l, "/gate", { ep: 5 }); // raise the floor
    expect((await call(l, "/gate", {})).fenced).toBe(false); // no ep → passes
  });
  it("bump revokes without a redeploy (raise the floor above the live token)", async () => {
    const l = new DeployLease(fakeState());
    expect((await call(l, "/gate", { ep: 3 })).fenced).toBe(false); // floor 3, current token ep=3 valid
    await call(l, "/bump", { min_epoch: 4 }); // revoke everything below 4
    expect((await call(l, "/gate", { ep: 3 })).fenced).toBe(true); // the still-live ep=3 token now fences
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
