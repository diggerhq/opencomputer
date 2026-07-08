// OC model-gateway wiring (design 013 §4). A stock Flue app points its managed `anthropic` provider at
// the OC gateway (a thin Worker over OpenRouter that injects the org key + meters per session).
//
// TOKEN SEAM — RESOLVED (2026-07-08). The per-deploy OC_SESSION_TOKEN is a SECRET, surfaced on the CF
// ambient env only once the request AsyncLocalStorage is entered — NOT at defineAgent-init (which runs in
// DO-construction scope, where the ambient env shows plain vars like OC_GATEWAY but the secret reads
// falsy). So an init-time registerProvider gets an empty apiKey -> "No API key for provider: anthropic".
// Fix: bind the apiKey at RUN scope from the exported `route` middleware — the SAME lifecycle phase where
// ocSandbox reads the token (in createSessionEnv) and succeeds. Because the token is per-DEPLOY (identical
// for every session of the deploy), the MODULE(isolate)-scoped provider registry holds one static value
// with NO cross-session race; the upstream per-request headers(ctx)/getApiKey(ctx) ask is only needed IF a
// PER-SESSION token is later introduced (buildout "Upstream asks"). registerProvider still takes a static
// apiKey and getApiKey(providerId) still has no turn context (providers.ts:199) — that's fine here.

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

/**
 * Point the managed `anthropic` provider at the OC gateway. **Call this INSIDE the `defineAgent`
 * initializer** — top-level module code is stripped by the CF build (proven in 1a), and the initializer
 * body runs per harness init. Reads the CF ambient env (`cloudflare:workers`), not `ctx.env`: on the
 * `--target cloudflare` build the real Worker bindings live on the ambient env and `ctx.env` is empty
 * for them (Flue's generated entry threads `instance.env`, which lacks the OC bindings), so reading
 * `ctx.env` alone would leave `OC_GATEWAY` unset and the provider unregistered ("Unknown model
 * specifier"). No-op when `OC_GATEWAY` is unset (local `flue dev` falls through to pi-ai's env-var key
 * lookup). `anthropic` is a catalog id, so `baseUrl` alone rehydrates the wire protocol.
 */
/** Register the managed `anthropic` provider from an OC env snapshot. Always registers the baseUrl (so the
 *  model specifier resolves); attaches the apiKey only when the per-deploy OC_SESSION_TOKEN is present in
 *  this snapshot. Returns true only when the apiKey actually landed — callers use that to stop rebinding.
 *  No-op when OC_GATEWAY is unset (local `flue dev` falls through to pi-ai's env-var key lookup). */
function bindOcProvider(env: OcEnv): boolean {
  const gw = env.OC_GATEWAY;
  if (!gw) return false;
  registerProvider("anthropic", {
    baseUrl: `${gw.replace(/\/+$/, "")}/anthropic`,
    ...(env.OC_SESSION_TOKEN ? { apiKey: env.OC_SESSION_TOKEN } : {}),
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

/** Set once the run-scope apiKey bind lands (module/isolate-scoped; the token is deploy-static so one
 *  bind serves every co-located session — no per-session race). */
let ocProviderBound = false;

/**
 * The HTTP-transport opt-in every OC-hosted agent MUST export as `route` (an agent is reachable at
 * `/agents/:name/:id` only when its module exports `route` — flue-app.ts). ALSO the run-scope binder for
 * the token seam: on each request (where the request ALS is entered and OC_SESSION_TOKEN is readable) it
 * (re)binds the provider's apiKey, once per isolate, BEFORE the turn's model call runs via `next()`. A
 * first `?view=updates` read that predates the token just leaves the flag false and retries next request.
 * The OC dispatch Worker is the auth boundary (013 §3 B5), so the transport itself adds none.
 */
export const route: AgentRouteHandler = async (_c, next) => {
  if (!ocProviderBound) ocProviderBound = bindOcProvider(ocResolveEnv<OcEnv>(undefined));
  return next();
};
