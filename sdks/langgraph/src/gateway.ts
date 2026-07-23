// OC model-gateway wiring for LangGraph.js agents (parallels @opencomputer/flue's
// useOcGateway). A LangGraph graph calls models through LangChain chat models; this
// points one at the OC gateway — a thin Worker over the providers that injects the
// org key + meters per session.
//
// TOKEN SEAM (same as flue's gateway.ts): OC_GATEWAY is a plain var, but
// OC_SESSION_TOKEN is a per-deploy Worker SECRET only readable on the per-REQUEST
// env, not at module/init scope. So construct the model INSIDE the node/turn from
// the request env — never cache a model built at init, or the apiKey reads empty and
// every call throws "no API key". `ocModel(env)` takes the env explicitly for that
// reason; on Node/local it defaults to process.env and ANTHROPIC_API_KEY.

import { ChatAnthropic } from "@langchain/anthropic";

export interface OcGatewayEnv {
  /** Deployed gateway Worker base URL (injected per deploy). */
  OC_GATEWAY?: string;
  /** Signed per-deploy JWT the gateway verifies (never a raw provider key). */
  OC_SESSION_TOKEN?: string;
  /** Local fallback when OC_GATEWAY is unset. */
  ANTHROPIC_API_KEY?: string;
  [key: string]: unknown;
}

export interface OcModelOptions {
  /** Anthropic model id (dashed pi-ai catalog id, e.g. claude-sonnet-4-6). */
  model?: string;
  /** Extra ChatAnthropic options (temperature, maxTokens, …). */
  overrides?: Record<string, unknown>;
}

/**
 * Build a LangChain Anthropic model pointed at the OC gateway when deployed
 * (OC_GATEWAY + OC_SESSION_TOKEN), or at ANTHROPIC_API_KEY locally. Call this
 * per-request/per-node (see token-seam note) — do not cache the result at init.
 */
export function ocModel(env: OcGatewayEnv, opts: OcModelOptions = {}): ChatAnthropic {
  const model = opts.model ?? "claude-sonnet-4-6";
  const gw = env.OC_GATEWAY;
  if (gw) {
    return new ChatAnthropic({
      model,
      apiKey: env.OC_SESSION_TOKEN,
      anthropicApiUrl: gw.replace(/\/+$/, "") + "/anthropic",
      ...opts.overrides,
    });
  }
  return new ChatAnthropic({ model, apiKey: env.ANTHROPIC_API_KEY, ...opts.overrides });
}
