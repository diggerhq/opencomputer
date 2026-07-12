// OC model-gateway wiring (design 013 §4). A stock Flue app points its managed `anthropic` provider at
// the OC gateway (a thin Worker over OpenRouter that injects the org key + meters per session).
//
// TOKEN SEAM — RESOLVED + VALIDATED end-to-end (2026-07-08). The per-deploy OC_SESSION_TOKEN is a Worker
// SECRET. Secrets are NOT on the CF ambient env (`cloudflare:workers`) at all — only plain vars like
// OC_GATEWAY are — and `ctx.env` at defineAgent-init is empty for the OC bindings too. So an init-time
// registerProvider reads the token falsy and every model call throws "No API key for provider: anthropic".
// The secret DOES live on the per-REQUEST env (`c.env`) — the same source ocSandbox reads at run time.
// Fix: bind the apiKey at RUN scope from the exported `route` middleware, reading OC_SESSION_TOKEN from
// `c.env` by DIRECT property access (NEVER spread c.env — the CF env is a proxy and spreading it throws)
// and OC_GATEWAY from the ambient snapshot. The token is per-DEPLOY (identical for every session), so
// rebinding it is race-free. The route also sets a best-effort X-OC-Session header; that static registry
// header can race under co-location and is never an authorization boundary. Exact attribution still needs
// the upstream per-request headers(ctx) resolver.

import { registerProvider } from "@flue/runtime";
import type { AgentInitializerContext, AgentRouteHandler } from "@flue/runtime";
import { ocResolveEnv } from "./cf-env.js";

/** Default managed model — MUST be prompt-caching-safe (Constraint): `claude-3-haiku` fails via
 *  OpenRouter→Bedrock; `claude-haiku-4-5` works. Use the pi-ai CATALOG id with DASHES
 *  (`claude-haiku-4-5`), never a dot (`claude-haiku-4.5`): the dotted id is absent from pi-ai's model
 *  catalog, so pi-ai can't derive the model's max output tokens and defaults `max_tokens` to 1 → empty
 *  completions. The dashed id resolves in the catalog and OpenRouter routes it too. Cheap + caching-safe. */
export const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

export interface OcEnv {
  /** Deployed gateway Worker base URL (set per tenant script by the OC deploy). */
  OC_GATEWAY?: string;
  /** Signed session/deploy JWT the gateway verifies (`{sub, org, agt, bud}`); never a raw provider key. */
  OC_SESSION_TOKEN?: string;
  /** Telemetry sink for `observe()` (operator panel + spend attribution). */
  OC_INGEST?: string;
  [key: string]: unknown;
}

/** Register the managed `anthropic` provider from an OC env snapshot. Always registers the baseUrl (so the
 *  model specifier resolves); attaches the apiKey only when the per-deploy OC_SESSION_TOKEN is present in
 *  this snapshot. Returns true only when the apiKey actually landed — callers use that to stop rebinding.
 *  No-op when OC_GATEWAY is unset (local `flue dev` falls through to pi-ai's env-var key lookup). */
function bindOcProvider(env: OcEnv, sessionId?: string): boolean {
  const gw = env.OC_GATEWAY;
  if (!gw) return false;
  registerProvider("anthropic", {
    baseUrl: `${gw.replace(/\/+$/, "")}/anthropic`,
    ...(env.OC_SESSION_TOKEN ? { apiKey: env.OC_SESSION_TOKEN } : {}),
    ...(sessionId ? { headers: { "X-OC-Session": sessionId } } : {}),
  });
  return Boolean(env.OC_SESSION_TOKEN);
}

/**
 * Point the managed `anthropic` provider at the OC gateway. **Call this INSIDE the `defineAgent`
 * initializer** — top-level module code is stripped by the CF build (proven in 1a). This runs at INIT
 * scope, where the per-deploy OC_SESSION_TOKEN (a secret) is typically not yet readable, so it registers
 * the baseUrl (model specifier resolves) and defers the apiKey to `route` (run scope) — see the token-seam
 * note above. Binds the apiKey here too if the token happens to already be present. Reads the CF ambient
 * env (`cloudflare:workers`), not `ctx.env`: on the `--target cloudflare` build the real Worker bindings
 * live on the ambient env and `ctx.env` is empty for them.
 */
export function useOcGateway(ctx: AgentInitializerContext<OcEnv>): void {
  bindOcProvider(ocResolveEnv<OcEnv>(ctx.env));
}

/**
 * The HTTP-transport opt-in every OC-hosted agent MUST export as `route` (an agent is reachable at
 * `/agents/:name/:id` only when its module exports `route` — flue-app.ts). ALSO the run-scope binder for
 * the token seam: on each request (where the request ALS is entered and OC_SESSION_TOKEN is readable) it
 * (re)binds the provider's apiKey and best-effort session attribution BEFORE the turn's model call
 * runs via `next()`. The provider registry is isolate-global, so the session header is visibility-only
 * until Flue exposes a per-request provider resolver; hard enforcement remains org+agent in the token.
 * The OC dispatch Worker is the auth boundary (013 §3 B5), so the transport itself adds none.
 */
export const route: AgentRouteHandler = async (c, next) => {
  // OC_SESSION_TOKEN is a Worker SECRET; secrets are absent from the ambient `cloudflare:workers` env
  // (only vars like OC_GATEWAY live there), so the ambient-only read leaves the apiKey empty ("No API
  // key"). The secret IS on the REQUEST env (c.env) — the same source ocSandbox reads in createSessionEnv.
  // Read the token from c.env by DIRECT property access (never spread c.env — the CF env is a proxy and
  // spreading it throws, which would break the request), and take OC_GATEWAY from the ambient snapshot.
  const amb = ocResolveEnv<OcEnv>(undefined);
  const token = (c.env as OcEnv | undefined)?.OC_SESSION_TOKEN ?? amb.OC_SESSION_TOKEN;
  const sessionId = c.req.param("id") || undefined;
  bindOcProvider({ ...amb, ...(token ? { OC_SESSION_TOKEN: token } : {}) }, sessionId);
  return next();
};
