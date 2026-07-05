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

/** Default managed model — MUST be prompt-caching-safe (Constraint): `claude-3-haiku` fails via
 *  OpenRouter→Bedrock; `claude-haiku-4.5` works. Cheap + caching-safe for the scaffolded starter. */
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

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
 * body runs per harness init with `env` available. No-op when `OC_GATEWAY` is unset (local `flue dev`
 * falls through to pi-ai's env-var key lookup). `anthropic` is a catalog id, so `baseUrl` alone rehydrates
 * the wire protocol.
 */
export function useOcGateway(ctx: AgentInitializerContext<OcEnv>): void {
  const gw = ctx.env.OC_GATEWAY;
  if (!gw) return;
  registerProvider("anthropic", {
    baseUrl: `${gw.replace(/\/+$/, "")}/anthropic`,
    ...(ctx.env.OC_SESSION_TOKEN ? { apiKey: ctx.env.OC_SESSION_TOKEN } : {}),
  });
}

/**
 * The HTTP-transport opt-in every OC-hosted agent MUST export as `route` (an agent is reachable at
 * `/agents/:name/:id` only when its module exports `route` — flue-app.ts). Pass-through: the OC dispatch
 * Worker is the auth boundary (013 §3 B5), so the app adds none.
 */
export const route: AgentRouteHandler = async (_c, next) => next();
