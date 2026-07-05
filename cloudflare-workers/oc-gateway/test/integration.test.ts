// In-process integration: the REAL worker handler + the REAL SessionBudget DO, with `fetch`
// stubbed to a mock OpenRouter. Proves the whole on-path flow deterministically without wrangler:
// token verify → per-session budget gate → org-key injection → forward → cost sub-meter →
// passthrough → refusal past budget. (The wrangler-dev + curl variant is documented in README.md;
// this is the CI-able equivalent.)
//
// Run: npx vitest run

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import worker, { Env } from "../src/index.js";
import { SessionBudget } from "../src/budget.js";
import { mintSessionToken } from "../src/token.js";

const SECRET = "spike-secret";
const OR_KEY = "sk-or-v1-FAKE-org-key";
const OR_BASE = "https://mock-openrouter.test/api";

// ── a fake DurableObjectState backed by a Map (the real DO runs against it) ──
function fakeState() {
  const store = new Map<string, unknown>();
  return { storage: {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => void store.set(k, v),
  } } as unknown as DurableObjectState;
}

// ── a fake SESSION_BUDGET namespace: one real SessionBudget instance per name ──
function fakeBudgetNamespace() {
  const instances = new Map<string, SessionBudget>();
  return {
    idFromName: (n: string) => ({ toString: () => n, name: n }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = (id as unknown as { name: string }).name;
      if (!instances.has(name)) instances.set(name, new SessionBudget(fakeState()));
      const inst = instances.get(name)!;
      return { fetch: (input: RequestInfo, init?: RequestInit) => inst.fetch(new Request(typeof input === "string" ? input : (input as Request).url, init)) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

let lastAuthToOR: string | null;
let lastBodyToOR: Record<string, unknown> | null;

function mockFetch(perCallCost: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    lastAuthToOR = new Headers(init?.headers).get("authorization");
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

function env(): Env {
  return { GATEWAY_TOKEN_SECRET: SECRET, SPIKE_OR_KEY: OR_KEY, OPENROUTER_BASE: OR_BASE, SESSION_BUDGET: fakeBudgetNamespace() };
}

// waitUntil runs the metering; collect the promises so we can await them (the meter is off-path).
function ctx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, _pending: pending } as unknown as ExecutionContext;
}
async function drain(c: ExecutionContext) { await Promise.all((c as unknown as { _pending: Promise<unknown>[] })._pending); }

const MSG = JSON.stringify({ model: "anthropic/claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "ping" }] });
const post = (token?: string) => new Request("https://gw.test/anthropic/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: MSG,
});

describe("gateway on-path flow", () => {
  beforeEach(() => { lastAuthToOR = null; lastBodyToOR = null; });
  afterEach(() => vi.restoreAllMocks());

  it("GET /healthz → ok", async () => {
    const res = await worker.fetch(new Request("https://gw.test/healthz"), env(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe("ok");
  });

  it("rejects a POST with no session token (401)", async () => {
    const res = await worker.fetch(post(), env(), ctx());
    expect(res.status).toBe(401);
  });

  it("rejects an invalid/expired token (401)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await mintSessionToken(SECRET, { sub: "ses_x", org: "org_1", agt: "a", iat: now - 10, exp: now - 5 });
    const res = await worker.fetch(post(expired), env(), ctx());
    expect(res.status).toBe(401);
  });

  it("forwards a valid turn: injects the ORG key (not the session token), adds usage.include, passes the body through", async () => {
    vi.stubGlobal("fetch", mockFetch(0.02));
    const now = Math.floor(Date.now() / 1000);
    const token = await mintSessionToken(SECRET, { sub: "ses_ok", org: "org_1", agt: "a", bud: 1, iat: now, exp: now + 3600 });
    const e = env();
    const c = ctx();
    const res = await worker.fetch(post(token), e, c);
    expect(res.status).toBe(200);
    const body = await res.json() as { content: { text: string }[] };
    expect(body.content[0].text).toBe("pong");
    // the ORG key was injected; the session token never reached OpenRouter
    expect(lastAuthToOR).toBe(`Bearer ${OR_KEY}`);
    expect(lastAuthToOR).not.toContain(token);
    // usage.include was injected so OR echoes cost
    expect(lastBodyToOR?.usage).toMatchObject({ include: true });
    // original request fields preserved
    expect(lastBodyToOR?.model).toBe("anthropic/claude-sonnet-5");
    await drain(c);
  });

  it("enforces the per-session budget ON-PATH: refuses once spend reaches the cap (402)", async () => {
    vi.stubGlobal("fetch", mockFetch(0.02)); // $0.02 per call
    const now = Math.floor(Date.now() / 1000);
    // budget $0.03 → call1 (spent 0<0.03) ok→0.02; call2 (0.02<0.03) ok→0.04; call3 (0.04≥0.03) refused.
    const token = await mintSessionToken(SECRET, { sub: "ses_budget", org: "org_1", agt: "a", bud: 0.03, iat: now, exp: now + 3600 });
    const e = env();

    const c1 = ctx(); const r1 = await worker.fetch(post(token), e, c1); await drain(c1);
    const c2 = ctx(); const r2 = await worker.fetch(post(token), e, c2); await drain(c2);
    const c3 = ctx(); const r3 = await worker.fetch(post(token), e, c3); await drain(c3);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(402);
    const refusal = await r3.json() as { error: { type: string }; oc: { spent_usd: number; budget_usd: number } };
    expect(refusal.error.type).toBe("budget_exceeded");
    expect(refusal.oc.spent_usd).toBeCloseTo(0.04, 5); // bounded one-call overshoot past $0.03
    expect(refusal.oc.budget_usd).toBeCloseTo(0.03, 5);
  });

  it("uncapped session (no bud claim) never refuses", async () => {
    vi.stubGlobal("fetch", mockFetch(1.0));
    const now = Math.floor(Date.now() / 1000);
    const token = await mintSessionToken(SECRET, { sub: "ses_uncapped", org: "org_1", agt: "a", iat: now, exp: now + 3600 });
    const e = env();
    for (let i = 0; i < 3; i++) { const c = ctx(); const r = await worker.fetch(post(token), e, c); await drain(c); expect(r.status).toBe(200); }
  });
});
