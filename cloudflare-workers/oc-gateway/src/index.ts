// oc-agent-gateway — the thin OC Worker over OpenRouter (design 013 §4, contract #1 / W3).
//
// An unmodified Flue app registers the managed provider INSIDE defineAgent (resolved token seam):
//   registerProvider('anthropic', {
//     baseUrl: `${env.OC_GATEWAY}/anthropic`,
//     apiKey: env.OC_SESSION_TOKEN,          // the per-DEPLOY token — authorizes (org, agt) only
//     headers: { 'X-OC-Session': id },       // the DO's own init id = ses_… — BEST-EFFORT attribution
//   });
//
// COST-SAFETY GRAIN (co-location refinement 2026-07-05). Flue's provider registry is isolate-global and
// CF co-locates many session-DOs of one agent's script in one isolate, so per-session data injected via
// registerProvider (the token OR the X-OC-Session header) RACES across co-located sessions. Therefore:
//   - HARD enforcement (the 402) is at the **org+agt** grain — carried by the per-DEPLOY token, so it is
//     race-free. This matches today's org-level OpenRouter→Autumn model; cost-safety is unchanged.
//   - The X-OC-Session header is **best-effort per-session attribution** — recorded for visibility only,
//     never gated (a co-location race must not wrongly block a legitimate session). Exact per-session
//     enforcement is deferred to an upstream Flue per-request resolver (tracked ask, off the critical path).
//
// On every model call the Worker:
//   (a) verifies the per-DEPLOY EdDSA token → (org, agt, ep). No session id, no budget in the token.
//   (b) fences a superseded lease epoch (DeployLease DO, per org+agt) — a rotated/revoked token stops.
//   (c) HARD-gates the org+agt budget ON-PATH (SpendCounter DO, keyed `${org}:${agt}`; budget looked up
//       server-side, never in the token — §8). Over → 402 budget_exceeded.
//   (d) injects the ORG's OpenRouter inference key (resolved from the credential store; never exposed).
//   (e) makes the body prompt-caching-safe, injects usage accounting, forwards to OpenRouter.
//   (f) sub-meters the response cost at the org+agt grain (authoritative) AND best-effort per session
//       (X-OC-Session), leaving ORG-level spend on that same OR key → the existing model_meter cron →
//       Autumn (one cost-source-of-truth). The gateway pushes NOTHING to Autumn.

import { verifyDeployToken } from "./token.js";
import { costFromJson, costFromStream } from "./cost.js";
import { resolveOrgKey } from "./orgkey.js";
import { unsafeModelMatchers, modelNeedsCacheStrip, stripCacheControl } from "./models.js";
export { SpendCounter } from "./budget.js";
export { DeployLease } from "./deploylease.js";

export interface Env {
  // base64url raw 32-byte Ed25519 PUBLIC key. The minter (control plane / W7) holds the private key.
  GATEWAY_TOKEN_PUBLIC_KEY: string;
  // Spend counter + gate. Used at org+agt grain (hard) and per-session grain (tracked-only).
  SPEND_COUNTER: DurableObjectNamespace;
  // Per-(org, agt) lease-epoch floor that fences rotated/revoked deploy tokens.
  DEPLOY_LEASE: DurableObjectNamespace;
  // Default HARD budget (USD) per org+agt, applied to an unprovisioned grain on first sight. Unset = uncapped.
  AGENT_BUDGET_USD_DEFAULT?: string;
  // Org OR-key seam (orgkey.ts): dedicated internal sessions-api route + its bearer secret.
  GATEWAY_ORKEY_URL?: string;
  GATEWAY_ORKEY_SECRET?: string;
  // Bearer that guards the control-plane admin routes (/admin/*). Unset → admin routes 404.
  GATEWAY_ADMIN_SECRET?: string;
  // Override OpenRouter base for tests; default = prod.
  OPENROUTER_BASE?: string;
  // Extra comma-separated model patterns whose OR route rejects cache_control (models.ts).
  CACHE_CONTROL_UNSAFE_MODELS?: string;
  // Optional per-session spend telemetry sink (OC_INGEST). Best-effort; absent = skip.
  OC_INGEST_URL?: string;
  OC_INGEST_AUTH?: string;
}

const OR_BASE_DEFAULT = "https://openrouter.ai/api"; // == credential.ts MANAGED_ANTHROPIC_BASE
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID = /^agt_[0-9a-f]{24}$/;

// Map a gateway path prefix → the OpenRouter path prefix (credential.ts managed bases).
//   /anthropic/v1/messages  → https://openrouter.ai/api/v1/messages   (Claude-Code path)
//   /openai/chat/completions → https://openrouter.ai/api/v1/chat/completions
function forwardUrl(base: string, pathname: string): string | null {
  if (pathname === "/anthropic" || pathname.startsWith("/anthropic/")) {
    return base + pathname.slice("/anthropic".length); // base already ends /api
  }
  if (pathname === "/openai" || pathname.startsWith("/openai/")) {
    return base + "/v1" + pathname.slice("/openai".length);
  }
  return null;
}

function bearer(h: Headers): string | null {
  const a = h.get("authorization");
  if (a && /^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, "").trim();
  const x = h.get("x-api-key"); // Anthropic-style clients put the apiKey here
  return x ? x.trim() : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validSessionId(value: string | null): string | null {
  const id = value?.trim() ?? "";
  return id.length <= 128 && /^ses_[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok", service: "oc-agent-gateway" });
    }

    // Control-plane admin routes (provision an org+agt budget, revoke a deploy lease). Guarded by a
    // dedicated bearer; absent secret → not exposed. These are the W1/W7 control-plane seams.
    if (url.pathname.startsWith("/admin/")) {
      return admin(req, env, url);
    }

    const target = forwardUrl(env.OPENROUTER_BASE || OR_BASE_DEFAULT, url.pathname);
    if (!target) return json({ error: { type: "not_found", message: "unknown gateway path" } }, 404);
    if (req.method !== "POST") return json({ error: { type: "method_not_allowed" } }, 405);

    // (a) verify the per-DEPLOY token (EdDSA — gateway holds only the public key).
    const token = bearer(req.headers);
    if (!token) return json({ error: { type: "unauthorized", message: "missing deploy token" } }, 401);
    const nowSec = Math.floor(Date.now() / 1000);
    const v = await verifyDeployToken(env.GATEWAY_TOKEN_PUBLIC_KEY, token, nowSec);
    if (!v.ok) return json({ error: { type: "unauthorized", message: `invalid deploy token: ${v.reason}` } }, 401);
    const { org: orgId, agt: agentId, ep } = v.claims;

    // Best-effort per-session attribution — the header may be stale under co-location; used for
    // tracking only, never gated. Absent → we simply skip the per-session record (the call proceeds).
    const sessionId = validSessionId(req.headers.get("x-oc-session"));

    // (b) lease-epoch fence — a rotated/revoked deploy token stops verifying (per org+agt, DO-serialized).
    const leaseStub = env.DEPLOY_LEASE.get(env.DEPLOY_LEASE.idFromName(`${orgId}:${agentId}`));
    const gate = await leaseStub
      .fetch("https://do/gate", { method: "POST", body: JSON.stringify({ ep }) })
      .then((r) => r.json() as Promise<{ ok: boolean; fenced?: boolean; floor: number }>);
    if (gate.fenced) {
      return json({ error: { type: "unauthorized", message: "deploy token superseded (stale lease epoch)", code: "token_superseded" } }, 401);
    }

    // (c) HARD budget gate at the org+agt grain — ON-PATH, before the model call (§8), DO-serialized,
    //     race-free (org+agt from the token). Budget looked up SERVER-SIDE (provisioned cap, else the
    //     gateway default); NEVER carried in the token.
    const agentKey = `agt:${orgId}:${agentId}`;
    const agentBudget = env.SPEND_COUNTER.get(env.SPEND_COUNTER.idFromName(agentKey));
    const defaultBudgetMicro = parseUsdMicro(env.AGENT_BUDGET_USD_DEFAULT);
    const check = await agentBudget
      .fetch("https://do/check", { method: "POST", body: JSON.stringify({ default_budget_micro: defaultBudgetMicro }) })
      .then((r) => r.json() as Promise<{ allowed: boolean; spent_micro: number; budget_micro: number | null }>);
    if (!check.allowed) {
      // Refuse past the org+agt budget. Shaped as a provider-style error so the Flue/pi-ai turn
      // terminates and the tailer maps it to outcome `budget_exceeded` (§8). Exact shape = live-verify.
      return json({
        error: { type: "budget_exceeded", message: "org/agent model budget exhausted", code: "insufficient_quota" },
        oc: { org: orgId, agent: agentId, spent_usd: check.spent_micro / 1e6, budget_usd: (check.budget_micro ?? 0) / 1e6 },
      }, 402);
    }

    // (d) resolve the ORG's OpenRouter inference key (from the credential-store seam; never exposed).
    const orKey = await resolveOrgKey(env, orgId, Date.now());
    if (!orKey) return json({ error: { type: "server_error", message: "no OpenRouter key resolved for org" } }, 500);

    // (e) rewrite the body: strip cache_control for caching-unsafe models, inject usage:{include:true}
    //     so OpenRouter echoes cost (openrouter.ts precedent). Model bodies are small; buffer is fine.
    const rawBody = await req.text();
    let outBody = rawBody;
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (modelNeedsCacheStrip(parsed.model, unsafeModelMatchers(env.CACHE_CONTROL_UNSAFE_MODELS))) {
        stripCacheControl(parsed);
      }
      const usage = (parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {}) as Record<string, unknown>;
      usage.include = true;
      parsed.usage = usage;
      outBody = JSON.stringify(parsed);
    } catch {
      /* not JSON — forward verbatim */
    }

    // forward to OpenRouter with the org key swapped in. Strip the tenant's auth + the session header;
    // pass the rest.
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.delete("x-api-key");
    fwdHeaders.delete("authorization");
    fwdHeaders.delete("x-oc-session");
    fwdHeaders.set("authorization", `Bearer ${orKey}`);
    fwdHeaders.set("content-type", req.headers.get("content-type") || "application/json");
    fwdHeaders.set("content-length", String(new TextEncoder().encode(outBody).length));
    // OpenRouter attribution/routing headers (non-secret): help the OR dashboard + rankings.
    fwdHeaders.set("http-referer", "https://opencomputer.dev");
    fwdHeaders.set("x-title", "OpenComputer");

    const forwardTarget = target + (url.search || "");
    const upstream = await fetch(forwardTarget, { method: "POST", headers: fwdHeaders, body: outBody });

    // (f) sub-meter the response cost, off the response path (waitUntil): authoritative at the org+agt
    //     grain + best-effort per session (for the dashboard). Passing the same generation id to both
    //     grains is safe — each DO instance has its own idempotency namespace.
    const isStream = (upstream.headers.get("content-type") || "").includes("text/event-stream");
    const meterCopy = upstream.clone();
    ctx.waitUntil(
      meter(meterCopy, isStream, env, {
        agentBudget,
        sessionCounter: sessionId
          ? env.SPEND_COUNTER.get(env.SPEND_COUNTER.idFromName(`sess:${orgId}:${agentId}:${sessionId}`))
          : null,
        sessionId, orgId, agentId,
      }),
    );

    // Passthrough: return OpenRouter's response (status + headers + body) untouched to Flue.
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  },
};

/** Parse a USD string into integer µ$, or null (uncapped) if unset/invalid/≤0. */
function parseUsdMicro(usd?: string): number | null {
  if (!usd) return null;
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e6);
}

function parseAdminBudgetMicro(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const micro = Math.round(value * 1e6);
  return Number.isSafeInteger(micro) ? micro : undefined;
}

// ── Control-plane admin routes (guarded by GATEWAY_ADMIN_SECRET) ──
async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.GATEWAY_ADMIN_SECRET) return json({ error: { type: "not_found" } }, 404);
  const auth = bearer(req.headers);
  if (!auth || !timingSafeEqual(auth, env.GATEWAY_ADMIN_SECRET)) return json({ error: { type: "unauthorized" } }, 401);
  if (req.method !== "POST") return json({ error: { type: "method_not_allowed" } }, 405);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // POST /admin/agent/budget {org, agt, budget_usd|null} — provision the org+agt HARD cap (W1/W7 seam).
  if (url.pathname === "/admin/agent/budget") {
    const org = typeof body.org === "string" ? body.org : null;
    const agt = typeof body.agt === "string" ? body.agt : null;
    if (!org || !agt || !ORG_ID.test(org) || !AGENT_ID.test(agt)) {
      return json({ error: { type: "bad_request", message: "canonical bare org UUID and agent id required" } }, 400);
    }
    const budgetMicro = parseAdminBudgetMicro(body.budget_usd);
    if (budgetMicro === undefined) {
      return json({ error: { type: "bad_request", message: "budget_usd must be a non-negative finite number or null" } }, 400);
    }
    const stub = env.SPEND_COUNTER.get(env.SPEND_COUNTER.idFromName(`agt:${org}:${agt}`));
    const r = await stub.fetch("https://do/provision", { method: "POST", body: JSON.stringify({ budget_micro: budgetMicro }) });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // POST /admin/lease/bump {org, agt, min_epoch} — revoke deploy tokens below min_epoch (no redeploy).
  if (url.pathname === "/admin/lease/bump") {
    const org = typeof body.org === "string" ? body.org : null;
    const agt = typeof body.agt === "string" ? body.agt : null;
    const minEpoch = typeof body.min_epoch === "number" ? body.min_epoch : null;
    if (!org || !agt || !ORG_ID.test(org) || !AGENT_ID.test(agt) || minEpoch == null) {
      return json({ error: { type: "bad_request", message: "canonical bare org UUID, agent id and min_epoch required" } }, 400);
    }
    const stub = env.DEPLOY_LEASE.get(env.DEPLOY_LEASE.idFromName(`${org}:${agt}`));
    const r = await stub.fetch("https://do/bump", { method: "POST", body: JSON.stringify({ min_epoch: minEpoch }) });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }

  return json({ error: { type: "not_found" } }, 404);
}

async function meter(
  resp: Response,
  isStream: boolean,
  env: Env,
  ctx: {
    agentBudget: DurableObjectStub;
    sessionCounter: DurableObjectStub | null;
    sessionId: string | null;
    orgId: string;
    agentId: string;
  },
): Promise<void> {
  try {
    if (resp.status >= 400) return; // a failed provider call bills nothing
    const extracted = isStream
      ? await costFromStream(resp.body ?? new ReadableStream())
      : costFromJson(await resp.text());
    const costMicro = extracted.costUsd != null ? Math.round(extracted.costUsd * 1e6) : 0;
    // Authoritative: the org+agt grain that gates.
    await ctx.agentBudget.fetch("https://do/add", {
      method: "POST",
      body: JSON.stringify({ cost_micro: costMicro, idem: extracted.generationId }),
    });
    // Best-effort per-session tracking (visibility only; never gated).
    if (ctx.sessionCounter) {
      await ctx.sessionCounter
        .fetch("https://do/add", { method: "POST", body: JSON.stringify({ cost_micro: costMicro, idem: extracted.generationId }) })
        .catch(() => {});
    }
    // Per-session spend telemetry (dashboard, §9) — best-effort; NOT a billing source. Absent → skip.
    if (env.OC_INGEST_URL) {
      await fetch(env.OC_INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", ...(env.OC_INGEST_AUTH ? { "x-internal-auth": env.OC_INGEST_AUTH } : {}) },
        body: JSON.stringify({
          name: "gateway.model_call", session: ctx.sessionId, org: ctx.orgId, agent: ctx.agentId,
          cost_usd: extracted.costUsd, cost_source: extracted.source, generation_id: extracted.generationId,
        }),
      }).catch(() => {});
    }
  } catch {
    // Metering must never affect the served response; a lost sample is tolerable (org billing is
    // OR-authoritative). Enforcement degrades gracefully — worst case one uncounted call.
  }
}
