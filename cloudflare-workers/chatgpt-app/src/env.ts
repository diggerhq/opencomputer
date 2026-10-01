import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Public origin of this Worker, e.g. `https://chatgpt.opencomputer.dev`. */
  PUBLIC_URL: string;
  /** OpenComputer API origin, e.g. `https://app.opencomputer.dev`. */
  OPENCOMPUTER_API_URL: string;
  /**
   * Optional service binding to the OpenComputer API edge. When bound, auth calls carry the
   * user's IP so the edge's per-caller login rate limits apply per user, not per Worker.
   */
  API_EDGE?: Fetcher;
}

/**
 * What a grant carries, encrypted by the OAuth provider with the token. The OpenComputer key
 * never leaves this Worker: ChatGPT only ever holds the provider's opaque tokens.
 */
export interface GrantProps {
  apiKey: string;
  orgId: string;
  orgName: string;
  userId: string | null;
  email: string;
  [key: string]: unknown;
}

export const SCOPE = "agents";
