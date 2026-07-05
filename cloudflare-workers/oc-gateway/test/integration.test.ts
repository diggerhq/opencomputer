// In-process integration: the REAL worker handler + REAL SpendCounter/DeployLease DOs, with `fetch`
// stubbed to a mock OpenRouter. Proves the whole on-path flow deterministically without wrangler:
// deploy-token verify → lease fence → HARD org+agt budget gate → org-key injection → forward → cost
// sub-meter (org+agt authoritative + best-effort per session) → passthrough → 402 over budget.
// Reflects the resolved token seam + co-location refinement: HARD enforcement is org+agt (race-free);
// the X-OC-Session header is best-effort per-session tracking, never gated.
// Run: npx vitest run

import { describe, it, expect, beforeEach, beforeAll, vi, afterEach } from "vitest";
import worker, { Env } from "../src/index.js";
import { SpendCounter } from "../src/budget.js";
import { DeployLease } from "../src/deploylease.js";
import { generateKeyPair, mintDeployToken } from "../src/token.js";

const OR_KEY = "sk-or-v1-FAKE-org-key";
const OR_BASE = "https://mock-openrouter.test/api";

// EdDSA keypair for the suite: the minter (control plane) holds PRIV, the gateway holds PUB.
let PRIV: CryptoKey;
let PUB: string;
beforeAll(async () => { const kp = await generateKeyPair(); PRIV = kp.privateKey; PUB = kp.publicKeyB64url; });

// ── a fake DurableObjectState backed by a Map (the real DO runs against it) ──
function fakeState() {
  const store = new Map<string, unknown>();
  return { storage: {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => void store.set(k, v),
  } } as unknown as DurableObjectState;
}

// ── a fake DO namespace: one real instance of `Klass` per name; `instances` exposed for assertions ──
function fakeNamespace<T extends { fetch(r: Request): Promise<Response> }>(Klass: new (s: DurableObjectState) => T) {
  const instances = new Map<string, T>();
  const ns = {
    idFromName: (n: string) => ({ toString: () => n, name: n }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = (id as unknown as { name: string }).name;
      if (!instances.has(name)) instances.set(name, new Klass(fakeState()));
      const inst = instances.get(name)!;
      return { fetch: (input: RequestInfo, init?: RequestInit) => inst.fetch(new Request(typeof input === "string" ? input : (input as Request).url, init)) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, instances };
}

let lastAuthToOR: string | null;
let lastBodyToOR: Record<string, unknown> | null;
let lastHeadersToOR: Headers | null;

function mockFetch(perCallCost: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    lastHeadersToOR = new Headers(init?.headers);
    lastAuthToOR = lastHeadersToOR.get("authorization");
    lastBodyToOR = init?.body ? JSON.parse(init.body as string) : null;
    expect(url.startsWith(OR_BASE)).toBe(true); // forwarded to the OR base, tail preserved
    return new Response(JSON.stringify({
      id: "gen-" + Math.random().toString(36).slice(2),
      type: "message", role: "assistant",
      content: [{ type: "text", text: "pong" }],
      usage: { input_tokens: 10, output_tokens: 3, cost: perCallCost },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

// a fresh env each test; `spend`/`lease` handles let us assert on per-grain DO state.
function mkEnv(extra: Partial<Env> = {}) {
  const spend = fakeNamespace(SpendCounter);
  const lease = fakeNamespace(DeployLease);
  const env = { GATEWAY_TOKEN_PUBLIC_KEY: PUB, TEST_OR_KEY: OR_KEY, OPENROUTER_BASE: OR_BASE, SPEND_COUNTER: spend.ns, DEPLOY_LEASE: lease.ns, ...extra } as Env;
  return { env, spend, lease };
}

// waitUntil runs the metering; collect the promises so we can await them (the meter is off-path).
function ctx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, _pending: pending } as unknown as ExecutionContext;
}
async function drain(c: ExecutionContext) { await Promise.all((c as unknown as { _pending: Promise<unknown>[] })._pending); }

const MSG = JSON.stringify({ model: "anthropic/claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "ping" }] });
const post = (token?: string, session?: string, body = MSG) => new Request("https://gw.test/anthropic/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(session ? { "x-oc-session": session } : {}),
  },
  body,
});
const mint = async (o: Partial<{ org: string; agt: string; ep: number; iat: number; exp: number }> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return mintDeployToken(PRIV, { org: "org_1", agt: "agt_1", iat: now, exp: now + 3600, ...o });
};
const stateOf = async (inst: { fetch(r: Request): Promise<Response> }) =>
  (await inst.fetch(new Request("https://do/state"))).json() as Promise<{ spent_micro: number }>;

describe("gateway on-path flow (resolved seam)", () => {
  beforeEach(() => { lastAuthToOR = null; lastBodyToOR = null; lastHeadersToOR = null; });
  afterEach(() => vi.restoreAllMocks());

  it("GET /healthz → ok", async () => {
    const { env } = mkEnv();
    const res = await worker.fetch(new Request("https://gw.test/healthz"), env, ctx());
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe("ok");
  });

  it("rejects a POST with no deploy token (401)", async () => {
    const { env } = mkEnv();
    const res = await worker.fetch(post(), env, ctx());
    expect(res.status).toBe(401);
  });

  it("rejects an expired token (401)", async () => {
    const { env } = mkEnv();
    const now = Math.floor(Date.now() / 1000);
    const expired = await mint({ iat: now - 10, exp: now - 5 });
    const res = await worker.fetch(post(expired), env, ctx());
    expect(res.status).toBe(401);
  });

  it("forwards a valid turn: injects the ORG key (not the deploy token), adds usage.include, passes the body through, does NOT leak the session header to OR", async () => {
    vi.stubGlobal("fetch", mockFetch(0.02));
    const { env } = mkEnv();
    const token = await mint();
    const c = ctx();
    const res = await worker.fetch(post(token, "ses_ok"), env, c);
    expect(res.status).toBe(200);
    const body = await res.json() as { content: { text: string }[] };
    expect(body.content[0].text).toBe("pong");
    // the ORG key was injected; the deploy token never reached OpenRouter (no raw key to the tenant either)
    expect(lastAuthToOR).toBe(`Bearer ${OR_KEY}`);
    expect(lastAuthToOR).not.toContain(token);
    // the session header is an OC-internal signal — it must not egress to OpenRouter
    expect(lastHeadersToOR?.get("x-oc-session")).toBeNull();
    // usage.include injected so OR echoes cost
    expect(lastBodyToOR?.usage).toMatchObject({ include: true });
    expect(lastBodyToOR?.model).toBe("anthropic/claude-sonnet-5");
    await drain(c);
  });

  it("proceeds WITHOUT an X-OC-Session header (best-effort attribution, not required)", async () => {
    vi.stubGlobal("fetch", mockFetch(0.01));
    const { env } = mkEnv();
    const c = ctx();
    const res = await worker.fetch(post(await mint()), env, c); // no session header
    expect(res.status).toBe(200);
    await drain(c);
  });

  it("HARD-enforces the org+agt budget ON-PATH: refuses once org+agt spend reaches the cap (402)", async () => {
    vi.stubGlobal("fetch", mockFetch(0.02)); // $0.02 per call
    // default org+agt budget $0.03 → call1 (0<0.03) ok→0.02; call2 (0.02<0.03) ok→0.04; call3 refused.
    const { env } = mkEnv({ AGENT_BUDGET_USD_DEFAULT: "0.03" });
    const token = await mint();
    const c1 = ctx(); const r1 = await worker.fetch(post(token, "ses_a"), env, c1); await drain(c1);
    const c2 = ctx(); const r2 = await worker.fetch(post(token, "ses_a"), env, c2); await drain(c2);
    const c3 = ctx(); const r3 = await worker.fetch(post(token, "ses_a"), env, c3); await drain(c3);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(402);
    const refusal = await r3.json() as { error: { type: string }; oc: { spent_usd: number; budget_usd: number } };
    expect(refusal.error.type).toBe("budget_exceeded");
    expect(refusal.oc.spent_usd).toBeCloseTo(0.04, 5); // bounded one-call overshoot past $0.03
    expect(refusal.oc.budget_usd).toBeCloseTo(0.03, 5);
  });

  it("co-location: two DIFFERENT sessions of the same org+agt SHARE the hard budget (grain is org+agt, not per-session)", async () => {
    vi.stubGlobal("fetch", mockFetch(0.02));
    const { env, spend } = mkEnv({ AGENT_BUDGET_USD_DEFAULT: "0.03" });
    const token = await mint();
    // ses_x spends $0.02, ses_y spends $0.02 → org+agt total $0.04 ≥ $0.03 → the next call (either
    // session) is refused. This is exactly the race-free property: budget is on the token's org+agt.
    const cx = ctx(); const rx = await worker.fetch(post(token, "ses_x"), env, cx); await drain(cx);
    const cy = ctx(); const ry = await worker.fetch(post(token, "ses_y"), env, cy); await drain(cy);
    const cz = ctx(); const rz = await worker.fetch(post(token, "ses_z"), env, cz); await drain(cz);
    expect(rx.status).toBe(200);
    expect(ry.status).toBe(200);
    expect(rz.status).toBe(402); // org+agt cap hit across sessions
    // best-effort per-session tracking recorded each session's own spend separately
    expect((await stateOf(spend.instances.get("sess:ses_x")!)).spent_micro).toBe(20_000);
    expect((await stateOf(spend.instances.get("sess:ses_y")!)).spent_micro).toBe(20_000);
    // and the authoritative org+agt grain summed them
    expect((await stateOf(spend.instances.get("agt:org_1:agt_1")!)).spent_micro).toBe(40_000);
  });

  it("per-session counter is TRACKED but NEVER gated: a session over its own spend is not 402'd", async () => {
    vi.stubGlobal("fetch", mockFetch(0.10)); // $0.10/call, well over any per-session intuition
    const { env, spend } = mkEnv(); // no org+agt cap → uncapped hard grain
    const token = await mint();
    for (let i = 0; i < 3; i++) { const c = ctx(); const r = await worker.fetch(post(token, "ses_hot"), env, c); await drain(c); expect(r.status).toBe(200); }
    // the session accumulated $0.30 but was never blocked (no per-session hard gate)
    expect((await stateOf(spend.instances.get("sess:ses_hot")!)).spent_micro).toBe(300_000);
  });

  it("fences a superseded deploy lease epoch (401 token_superseded)", async () => {
    vi.stubGlobal("fetch", mockFetch(0.001));
    const { env } = mkEnv(); // same DEPLOY_LEASE namespace → same lease for org_1:agt_1
    const t2 = await mint({ ep: 2 });
    const c2 = ctx(); const r2 = await worker.fetch(post(t2, "ses_ep"), env, c2); await drain(c2);
    expect(r2.status).toBe(200); // adopt epoch 2
    const t1 = await mint({ ep: 1 });
    const r1 = await worker.fetch(post(t1, "ses_ep"), env, ctx()); // the old deploy's token — superseded
    expect(r1.status).toBe(401);
    expect((await r1.json() as { error: { code?: string } }).error.code).toBe("token_superseded");
  });

  it("strips cache_control for a caching-unsafe model, still injects usage.include", async () => {
    vi.stubGlobal("fetch", mockFetch(0.001));
    const { env } = mkEnv();
    const token = await mint();
    const body = JSON.stringify({
      model: "anthropic/claude-3-haiku", max_tokens: 16,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "ping" }],
    });
    const c = ctx(); const r = await worker.fetch(post(token, "ses_cc", body), env, c); await drain(c);
    expect(r.status).toBe(200);
    expect(JSON.stringify(lastBodyToOR).includes("cache_control")).toBe(false);
    expect(lastBodyToOR?.usage).toMatchObject({ include: true });
  });

  it("admin: provision an org+agt cap, then it gates (402); guarded by GATEWAY_ADMIN_SECRET", async () => {
    vi.stubGlobal("fetch", mockFetch(0.05));
    const { env } = mkEnv({ GATEWAY_ADMIN_SECRET: "adm" });
    // unauthorized admin call is rejected
    const bad = await worker.fetch(new Request("https://gw.test/admin/agent/budget", { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: JSON.stringify({ org: "org_1", agt: "agt_1", budget_usd: 0.04 }) }), env, ctx());
    expect(bad.status).toBe(401);
    // provision a $0.04 cap
    const prov = await worker.fetch(new Request("https://gw.test/admin/agent/budget", { method: "POST", headers: { authorization: "Bearer adm", "content-type": "application/json" }, body: JSON.stringify({ org: "org_1", agt: "agt_1", budget_usd: 0.04 }) }), env, ctx());
    expect(prov.status).toBe(200);
    const token = await mint();
    const c1 = ctx(); const r1 = await worker.fetch(post(token, "s1"), env, c1); await drain(c1); // 0→0.05
    const c2 = ctx(); const r2 = await worker.fetch(post(token, "s1"), env, c2); await drain(c2); // 0.05≥0.04 → 402
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(402);
  });
});
