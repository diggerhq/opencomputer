// OC model-gateway wiring (design 013 §4). A stock Flue app points its managed `anthropic` provider at
// the OC gateway (a thin Worker over OpenRouter that injects the org key + meters per session).
//
// TOKEN SEAM — OPEN, confirm with the orchestrator. The buildout's seam (a) ("per-turn token → Flue's
// per-call getApiKey(providerId) callback") is NOT achievable: `registerProvider` accepts only a STATIC
// `apiKey`, and Flue's internal `getApiKey(providerId)` gets no request/turn context (providers.ts:199).
// Worse, the provider registry is MODULE(isolate)-scoped and shared across co-located DO instances, so a
// per-SESSION `apiKey`/`headers`/`baseUrl` set via registerProvider RACES across sessions in one isolate.
// → Robust per-session attribution needs the upstream ask (per-request `headers(ctx)` on registerProvider,
//   buildout "Upstream asks"). Interim, buildable shape below: a static env token (works one-session-per-
//   isolate) with metering by `token.sub` at the gateway. See the W4 hand-off note.

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
export function useOcGateway(ctx: AgentInitializerContext<OcEnv>): void {
  const env = ocResolveEnv<OcEnv>(ctx.env);
  const gw = env.OC_GATEWAY;
  if (!gw) return;
  registerProvider("anthropic", {
    baseUrl: `${gw.replace(/\/+$/, "")}/anthropic`,
    ...(env.OC_SESSION_TOKEN ? { apiKey: env.OC_SESSION_TOKEN } : {}),
  });
}

/**
 * The HTTP-transport opt-in every OC-hosted agent MUST export as `route` (an agent is reachable at
 * `/agents/:name/:id` only when its module exports `route` — flue-app.ts). Pass-through: the OC dispatch
 * Worker is the auth boundary (013 §3 B5), so the app adds none.
 */
export const route: AgentRouteHandler = async (_c, next) => next();
