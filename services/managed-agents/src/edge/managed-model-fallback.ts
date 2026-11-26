import type { ManagedModelBilling } from "./billing-admission.js";

/**
 * Open-weight model that paid orgs fall back to once their prepaid credits are
 * exhausted. Served through OpenRouter on every OpenCode wire protocol
 * (chat completions, responses, anthropic messages).
 */
export const DEFAULT_MANAGED_FALLBACK_MODEL = "z-ai/glm-5.3";

export interface ManagedModelFallbackEnv {
  MANAGED_FALLBACK_MODEL?: string;
  MANAGED_FALLBACK_OPENROUTER_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export interface ManagedModelFallbackTarget {
  apiKey: string;
  model: string;
}

/**
 * The platform key and model a paid org's calls move to after its credits run
 * out. Fallback spend is not debited from the org's credits, so it never uses
 * the org's capped managed key.
 */
export function managedFallbackTarget(
  env: ManagedModelFallbackEnv,
  billing: ManagedModelBilling,
): ManagedModelFallbackTarget | undefined {
  if (!billing.paid) return undefined;
  const apiKey =
    env.MANAGED_FALLBACK_OPENROUTER_API_KEY?.trim() ||
    env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model =
    env.MANAGED_FALLBACK_MODEL?.trim() || DEFAULT_MANAGED_FALLBACK_MODEL;
  return { apiKey, model };
}

/**
 * OpenRouter answers 402 once the org's managed key reaches its credit cap,
 * which can precede the billing projection marking the org exhausted. A paid
 * org's call is then retried on the fallback instead of failing the turn.
 */
export function shouldRetryOnFallback(
  status: number,
  billing: ManagedModelBilling,
): boolean {
  return status === 402 && billing.paid && !billing.fallback;
}
