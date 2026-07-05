// oc-gateway — the thin per-session Worker over OpenRouter (design 013 §4, buildout contract #1 / W3).
//
// An unmodified Flue app does:
//   registerProvider('anthropic', { baseUrl: `${env.OC_GATEWAY}/anthropic`, apiKey: <session_token> })
// and this Worker, on every model call:
//   (a) verifies the per-session EdDSA token → (org, agent, session, budget, epoch);
//   (b) fences a superseded lease epoch, then gates on the per-session budget ON-PATH (§8);
//   (c) injects the ORG's OpenRouter inference key (resolved from the credential store; never exposed);
//   (d) makes the body prompt-caching-safe, injects usage accounting, forwards to OpenRouter;
//   (e) sub-meters the response cost per session (SessionBudget DO), leaving ORG-level spend on that
//       same OR key → the existing model_meter cron → Autumn (one cost-source-of-truth).
//
// It builds NOTHING new for billing: org spend flows through the org's single OR key exactly as the
// brain-box path does today; the gateway only adds per-session sub-metering + enforcement.

import { verifySessionToken } from "./token.js";
import { costFromJson, costFromStream } from "./cost.js";
import { resolveOrgKey } from "./orgkey.js";
import { unsafeModelMatchers, modelNeedsCacheStrip, stripCacheControl } from "./models.js";
export { SessionBudget } from "./budget.js";

export interface Env {
  // base64url raw 32-byte Ed25519 PUBLIC key. The minter (control plane) holds the private key.
  GATEWAY_TOKEN_PUBLIC_KEY: string;
  // Per-session budget counter + gate + epoch fence.
  SESSION_BUDGET: DurableObjectNamespace;
  // Org OR-key seam (orgkey.ts): dedicated internal sessions-api route + its bearer secret.
  GATEWAY_ORKEY_URL?: string;
  GATEWAY_ORKEY_SECRET?: string;
  // Acceptance-test single-key override (bypasses the seam). Never set in multi-org prod.
  TEST_OR_KEY?: string;
  // Override OpenRouter base for tests; default = prod.
  OPENROUTER_BASE?: string;
  // Extra comma-separated model patterns whose OR route rejects cache_control (models.ts).
  CACHE_CONTROL_UNSAFE_MODELS?: string;
  // Optional per-session spend telemetry sink (OC_INGEST). Best-effort; absent = skip.
  OC_INGEST_URL?: string;
  OC_INGEST_AUTH?: string;
}

const OR_BASE_DEFAULT = "https://openrouter.ai/api"; // == credential.ts MANAGED_ANTHROPIC_BASE

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

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok", service: "oc-gateway" });
    }

    const target = forwardUrl(env.OPENROUTER_BASE || OR_BASE_DEFAULT, url.pathname);
    if (!target) return json({ error: { type: "not_found", message: "unknown gateway path" } }, 404);
    if (req.method !== "POST") return json({ error: { type: "method_not_allowed" } }, 405);

    // (a) verify the per-session token (EdDSA — gateway holds only the public key).
    const token = bearer(req.headers);
    if (!token) return json({ error: { type: "unauthorized", message: "missing session token" } }, 401);
    const nowSec = Math.floor(Date.now() / 1000);
    const v = await verifySessionToken(env.GATEWAY_TOKEN_PUBLIC_KEY, token, nowSec);
    if (!v.ok) return json({ error: { type: "unauthorized", message: `invalid session token: ${v.reason}` } }, 401);
    const { sub: sessionId, org: orgId, bud, ep } = v.claims;

    // (b) lease-epoch fence + budget gate — ON-PATH, before the model call (§8), DO-serialized.
    const doStub = env.SESSION_BUDGET.get(env.SESSION_BUDGET.idFromName(sessionId));
    const budgetMicro = typeof bud === "number" && bud > 0 ? Math.round(bud * 1e6) : null;
    const check = await doStub
      .fetch("https://do/check", { method: "POST", body: JSON.stringify({ budget_micro: budgetMicro, ep }) })
      .then((r) => r.json() as Promise<{ allowed: boolean; fenced?: boolean; spent_micro: number; budget_micro: number | null }>);
    if (check.fenced) {
      // A superseded lease epoch — the token was minted for an older turn. 401 so the caller re-mints.
      return json({ error: { type: "unauthorized", message: "session token superseded (stale lease epoch)", code: "token_superseded" } }, 401);
    }
    if (!check.allowed) {
      // Refuse past the per-session budget. Shaped as a provider-style error so the Flue/pi-ai turn
      // terminates and the tailer maps it to outcome `budget_exceeded` (§8). Exact shape = live-verify.
      return json({
        error: { type: "budget_exceeded", message: "per-session model budget exhausted", code: "insufficient_quota" },
        oc: { session: sessionId, spent_usd: check.spent_micro / 1e6, budget_usd: (check.budget_micro ?? 0) / 1e6 },
      }, 402);
    }

    // (c) resolve the ORG's OpenRouter inference key (from the credential-store seam; never exposed).
    const orKey = await resolveOrgKey(env, orgId, Date.now());
    if (!orKey) return json({ error: { type: "server_error", message: "no OpenRouter key resolved for org" } }, 500);

    // (d) rewrite the body: strip cache_control for caching-unsafe models, inject usage:{include:true}
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

    // forward to OpenRouter with the org key swapped in. Strip the tenant's auth; pass the rest.
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.delete("x-api-key");
    fwdHeaders.delete("authorization");
    fwdHeaders.set("authorization", `Bearer ${orKey}`);
    fwdHeaders.set("content-type", req.headers.get("content-type") || "application/json");
    fwdHeaders.set("content-length", String(new TextEncoder().encode(outBody).length));
    // OpenRouter attribution/routing headers (non-secret): help the OR dashboard + rankings.
    fwdHeaders.set("http-referer", "https://opencomputer.dev");
    fwdHeaders.set("x-title", "OpenComputer");

    const forwardTarget = target + (url.search || "");
    const upstream = await fetch(forwardTarget, { method: "POST", headers: fwdHeaders, body: outBody });

    // (e) sub-meter the response cost per session, off the response path (waitUntil).
    const isStream = (upstream.headers.get("content-type") || "").includes("text/event-stream");
    const meterCopy = upstream.clone();
    ctx.waitUntil(meter(meterCopy, isStream, doStub, env, { sessionId, orgId }));

    // Passthrough: return OpenRouter's response (status + headers + body) untouched to Flue.
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  },
};

async function meter(
  resp: Response,
  isStream: boolean,
  doStub: DurableObjectStub,
  env: Env,
  ctx: { sessionId: string; orgId: string },
): Promise<void> {
  try {
    if (resp.status >= 400) return; // a failed provider call bills nothing
    const extracted = isStream
      ? await costFromStream(resp.body ?? new ReadableStream())
      : costFromJson(await resp.text());
    const costMicro = extracted.costUsd != null ? Math.round(extracted.costUsd * 1e6) : 0;
    await doStub.fetch("https://do/add", {
      method: "POST",
      body: JSON.stringify({ cost_micro: costMicro, idem: extracted.generationId }),
    });
    // Per-session spend telemetry (dashboard, §9) — best-effort; NOT a billing source (org billing
    // is OR→cron→Autumn). Absent OC_INGEST_URL → skip.
    if (env.OC_INGEST_URL) {
      await fetch(env.OC_INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", ...(env.OC_INGEST_AUTH ? { "x-internal-auth": env.OC_INGEST_AUTH } : {}) },
        body: JSON.stringify({
          name: "gateway.model_call", session: ctx.sessionId, org: ctx.orgId,
          cost_usd: extracted.costUsd, cost_source: extracted.source, generation_id: extracted.generationId,
        }),
      }).catch(() => {});
    }
  } catch {
    // Metering must never affect the served response; a lost sample is tolerable (org billing is
    // OR-authoritative). Enforcement degrades gracefully — worst case one uncounted call.
  }
}
