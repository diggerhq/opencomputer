import { isRecord } from "../protocol.js";

/**
 * Codex subscription OAuth adapter (work 011).
 *
 * Connects a personal Codex subscription through the authorized OAuth flow and
 * reuses the standard authorization-code + PKCE + refresh-token grant. The
 * authorize/token/Responses endpoints are supplied by the deployment via
 * `BLUE_CODEX_*` env vars so the exact authorized OpenAI consumer contract can
 * be wired without hard-coding or reverse-engineering endpoints.
 */

export interface CodexOAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  completionsUrl: string;
  scopes: string[];
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number;
  scopes: string[];
}

export function codexAccountId(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    ) as unknown;
    if (!isRecord(decoded)) return null;
    const auth = decoded["https://api.openai.com/auth"];
    if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") {
      return null;
    }
    const accountId = auth.chatgpt_account_id.trim();
    return accountId && accountId.length <= 256 ? accountId : null;
  } catch {
    return null;
  }
}

export function codexComputeResidency(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    ) as unknown;
    if (!isRecord(decoded)) return null;
    const auth = decoded["https://api.openai.com/auth"];
    const value =
      (isRecord(auth) ? auth.chatgpt_compute_residency : undefined) ??
      decoded.chatgpt_compute_residency;
    if (typeof value !== "string") return null;
    const residency = value.trim();
    return residency && residency !== "no_constraint" && residency.length <= 128
      ? residency
      : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

function tokenResponse(value: unknown): TokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    typeof value.expires_in !== "number"
  ) {
    const message =
      isRecord(value) && typeof value.error_description === "string"
        ? value.error_description
        : isRecord(value) && typeof value.error === "string"
          ? value.error
          : "Codex returned an invalid token response";
    throw new Error(message);
  }
  return value as unknown as TokenResponse;
}

async function codexTokenRequest(
  config: CodexOAuthConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    tokenResponse(value);
    throw new Error(`Codex token exchange failed (${String(response.status)})`);
  }
  return tokenResponse(value);
}

function credentialFromToken(
  token: TokenResponse,
  previous?: OAuthCredential,
): OAuthCredential {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? previous?.refreshToken,
    tokenType: token.token_type ?? previous?.tokenType ?? "Bearer",
    expiresAt: Date.now() + token.expires_in * 1_000,
    scopes:
      token.scope?.split(/\s+/).filter(Boolean) ??
      previous?.scopes ??
      [],
  };
}

export function codexAuthorizationUrl(input: {
  config: CodexOAuthConfig;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.config.authorizeUrl);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", input.config.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCodexCode(input: {
  config: CodexOAuthConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthCredential> {
  const body = new URLSearchParams({
    client_id: input.config.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  if (input.config.clientSecret) {
    body.set("client_secret", input.config.clientSecret);
  }
  return credentialFromToken(await codexTokenRequest(input.config, body));
}

export async function refreshCodexCredential(
  config: CodexOAuthConfig,
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (credential.expiresAt > Date.now() + 60_000) return credential;
  if (!credential.refreshToken) {
    throw new Error("Codex connection has no refresh token");
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: credential.refreshToken,
    grant_type: "refresh_token",
  });
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }
  return credentialFromToken(await codexTokenRequest(config, body), credential);
}
