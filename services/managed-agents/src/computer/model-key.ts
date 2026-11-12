// The model credentials Claude Code on the computer runs with (work 052).
//
// Serverless agents' managed inference spends the organization's own
// OpenRouter key, which the public edge creates per organization
// (opencomputer api-edge model_billing.ts, `enableManagedBilling`) and hands
// to bluecode over `/internal/managed-credential`, signed with
// OC_MANAGED_CRED_HMAC_SECRET; the AccountDurableObject keeps it encrypted
// (`managed_model_credentials`, provider `openrouter`). The edge's metering
// cron reads that key's spend into `model_spend`, so a computer that uses the
// same key is metered the same way with nothing new on the edge.
//
// Claude Code reaches OpenRouter through its Anthropic-compatible API: the
// host gets `anthropicApiKey = <org key>` and
// `anthropicBaseUrl = https://openrouter.ai/api` (Calvin sets
// ANTHROPIC_BASE_URL for its runners from it).
//
// The key exists once the organization has used managed models; the public
// edge creates it lazily on the first managed session. An organization with
// none gets it the same way sessions-api's `ensureManagedProvisioned` gets it:
// POST `/internal/model-billing/enable` on the public edge, signed
// `${ts}.${body}` with OC_MANAGED_CRED_HMAC_SECRET (the route accepts that
// scoped secret for `enable`). Until it lands the computer falls back to the
// shared COMPUTER_ANTHROPIC_API_KEY and logs `computer.model_key_fallback`.
// Key values are never logged. A subscription seat is never shared this way:
// the shared Claude OAuth token fallback went in work 097.
//
// Protocol 5 (work 097, design C2 and C8): the key no longer travels in the
// host's credentials. It is a variable of a model route, `managedModelRoute`:
// profile `openrouter` for the organization's key, `anthropic-key` for the
// shared one; the host's model proxy holds the value and the runner never
// sees it. `modelCredentials` is protocol 4's and goes with it.

import { hmacSha256Hex } from "../edge/runtime-usage.js";
import { sha256Hex } from "./crypto.js";
import type { CalvinHostCredentials, ModelProfile, ModelRoute } from "./protocol.js";

export const MANAGED_MODEL_PROVIDER = "openrouter";
/**
 * The model the computer runs on the organization's credits, by name, for
 * the dashboard (`agent.managedModel` in GET /v1/computer, work 081). The
 * computer's model is chosen by calvin (`DEFAULT_MODEL` in calvin
 * `src/tiers.ts`), which blue can't import: the two change together, by
 * convention. The right fix is the host reporting its model in `hello`.
 */
export const MANAGED_MODEL_NAME = "Claude Opus 5.5";
export const MANAGED_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
export const MODEL_BILLING_ENABLE_PATH = "/internal/model-billing/enable";
const ENABLE_TIMEOUT_MS = 15_000;

export type ModelCredentials = Pick<CalvinHostCredentials, "anthropicApiKey" | "anthropicBaseUrl">;

export interface SharedModelEnv {
  COMPUTER_ANTHROPIC_API_KEY?: string;
}

/** The organization's key with OpenRouter's base URL, or the shared API key. */
export function modelCredentials(organizationKey: string | null, env: SharedModelEnv): { credentials: ModelCredentials; fallback: boolean } {
  if (organizationKey) {
    return { credentials: { anthropicApiKey: organizationKey, anthropicBaseUrl: MANAGED_ANTHROPIC_BASE_URL }, fallback: false };
  }
  if (env.COMPUTER_ANTHROPIC_API_KEY) return { credentials: { anthropicApiKey: env.COMPUTER_ANTHROPIC_API_KEY }, fallback: true };
  return { credentials: {}, fallback: true };
}

/** The profile that spends the organization's key, and the one that spends the shared key (the proxy's default profiles). */
export const MANAGED_MODEL_PROFILE = "openrouter";
export const SHARED_KEY_PROFILE = "anthropic-key";

/** What a thread hears when its computer has no managed credential at all; the host says the same of a session with no route. */
export const NO_MODEL_CREDENTIAL = "No model credential is configured for this computer.";

/**
 * A credential's `key` when its author has no better name (design C2): the
 * first 16 hex digits of sha256 over the profile, then every variable as
 * `name=value` in name order, joined by NUL. It names the credential without
 * revealing it, for high-entropy values only.
 */
export async function modelKey(profile: string, vars: Record<string, string>): Promise<string> {
  const names = Object.keys(vars).sort();
  return (await sha256Hex([profile, ...names.map((name) => `${name}=${vars[name]}`)].join("\0"))).slice(0, 16);
}

/** Whether a host lists `profile`. `profiles` undefined: its hello never listed any, so the host answers for itself. */
export function listsProfile(profiles: readonly ModelProfile[] | undefined, profile: string): boolean {
  return !profiles || profiles.some((p) => p.name === profile);
}

/** The route for `profile` with `vars`; a refusal when the host does not list the profile. */
async function profileRoute(profiles: readonly ModelProfile[] | undefined, profile: string, vars: Record<string, string>): Promise<ModelRoute> {
  if (!listsProfile(profiles, profile)) return { mode: "refuse", reason: `This computer has no model profile \`${profile}\`.` };
  return { mode: "profile", profile, vars, key: await modelKey(profile, vars) };
}

/** Protocol 5's `modelCredentials`: the managed route of a host that lists `profiles`, and whether it is the shared key's. */
export async function managedModelRoute(
  organizationKey: string | null,
  env: SharedModelEnv,
  profiles: readonly ModelProfile[] | undefined,
): Promise<{ route: ModelRoute; fallback: boolean }> {
  if (organizationKey) return { route: await profileRoute(profiles, MANAGED_MODEL_PROFILE, { token: organizationKey }), fallback: false };
  if (env.COMPUTER_ANTHROPIC_API_KEY) return { route: await profileRoute(profiles, SHARED_KEY_PROFILE, { token: env.COMPUTER_ANTHROPIC_API_KEY }), fallback: true };
  return { route: { mode: "refuse", reason: NO_MODEL_CREDENTIAL }, fallback: true };
}

export interface ProvisionEnv {
  OPENCOMPUTER_APP_URL?: string;
  OC_MANAGED_CRED_HMAC_SECRET?: string;
}

export type ProvisionOutcome = "requested" | "not_configured" | "failed";

/**
 * Asks the public edge to create the organization's managed key. The edge
 * binds it back to this Worker (`/internal/managed-credential`) before it
 * answers, so on "requested" the key can be resolved from the account.
 */
export async function requestManagedModelKey(env: ProvisionEnv, organizationId: string, fetcher: typeof fetch = fetch): Promise<ProvisionOutcome> {
  if (!env.OPENCOMPUTER_APP_URL || !env.OC_MANAGED_CRED_HMAC_SECRET) return "not_configured";
  const body = JSON.stringify({ org_id: organizationId });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await hmacSha256Hex(env.OC_MANAGED_CRED_HMAC_SECRET, `${timestamp}.${body}`);
  try {
    const response = await fetcher(new URL(MODEL_BILLING_ENABLE_PATH, env.OPENCOMPUTER_APP_URL), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Timestamp": timestamp, "X-Signature": signature },
      body,
      signal: AbortSignal.timeout(ENABLE_TIMEOUT_MS),
    });
    if (response.ok) return "requested";
    // A halted free organization answers 500 {status: "halted"}; its messages are refused by the credit gate anyway.
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    console.warn(JSON.stringify({ level: "warn", event: "computer.model_key_provision_failed", orgId: organizationId, status: response.status, detail }));
    return "failed";
  } catch (error) {
    console.warn(
      JSON.stringify({ level: "warn", event: "computer.model_key_provision_failed", orgId: organizationId, error: error instanceof Error ? error.message : String(error) }),
    );
    return "failed";
  }
}
