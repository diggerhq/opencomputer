import { isRecord } from "../protocol.js";
import type {
  ConnectionRequestInput,
  ConnectionRequestResult,
} from "../protocol.js";

const GOOGLE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

export const GMAIL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number;
  scopes: string[];
}

export interface GoogleIdentity {
  id: string;
  email: string;
  name?: string;
}

const GOOGLE_SCOPE_ALIASES: Record<string, string[]> = {
  email: [
    "email",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
};

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
          : "Google returned an invalid token response";
    throw new Error(message);
  }
  return value as unknown as TokenResponse;
}

async function googleTokenRequest(
  body: URLSearchParams,
): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    tokenResponse(value);
    throw new Error(`Google token exchange failed (${String(response.status)})`);
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

export function assertGoogleScopes(
  credential: OAuthCredential,
  requiredScopes: string[],
): void {
  const granted = new Set(credential.scopes);
  const missing = requiredScopes.filter((scope) => {
    const accepted = GOOGLE_SCOPE_ALIASES[scope] ?? [scope];
    return !accepted.some((candidate) => granted.has(candidate));
  });
  if (missing.length > 0) {
    throw new Error(
      `Google did not grant the required scope${missing.length === 1 ? "" : "s"}: ` +
        `${missing.join(", ")}. Enable the Gmail API, add the scope to the ` +
        "OAuth app's Data Access configuration, and approve Gmail access " +
        "when reconnecting.",
    );
  }
}

export function googleAuthorizationUrl(input: {
  config: GoogleOAuthConfig;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGoogleCode(input: {
  config: GoogleOAuthConfig;
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
  return credentialFromToken(await googleTokenRequest(body));
}

export async function refreshGoogleCredential(
  config: GoogleOAuthConfig,
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (credential.expiresAt > Date.now() + 60_000) return credential;
  if (!credential.refreshToken) {
    throw new Error("Google connection has no refresh token");
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: credential.refreshToken,
    grant_type: "refresh_token",
  });
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }
  return credentialFromToken(await googleTokenRequest(body), credential);
}

export async function resolveGoogleIdentity(
  credential: OAuthCredential,
): Promise<GoogleIdentity> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      authorization: `${credential.tokenType} ${credential.accessToken}`,
    },
  });
  const value: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !isRecord(value) ||
    typeof value.sub !== "string" ||
    typeof value.email !== "string"
  ) {
    throw new Error("Google did not return the connected account identity");
  }
  return {
    id: value.sub,
    email: value.email,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}

function googleServiceOrigin(service: string): string {
  switch (service) {
    case "gmail":
      return "https://gmail.googleapis.com";
    case "calendar":
    case "drive":
    case "sheets":
      return "https://www.googleapis.com";
    default:
      throw new Error(`Unsupported Google service: ${service}`);
  }
}

async function readLimitedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Google API response exceeded the 4 MB limit");
      }
      body += decoder.decode(result.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function requestGoogleApi(
  credential: OAuthCredential,
  input: ConnectionRequestInput,
): Promise<ConnectionRequestResult> {
  if (!input.path.startsWith("/") || input.path.startsWith("//")) {
    throw new Error("Connection request path must be relative");
  }
  const method = (input.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new Error(`Unsupported connection request method: ${method}`);
  }
  if (
    input.body &&
    new TextEncoder().encode(input.body).byteLength > 4_000_000
  ) {
    throw new Error("Connection request body exceeded the 4 MB limit");
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const normalized = name.toLowerCase();
    if (
      typeof value === "string" &&
      [
        "accept",
        "content-type",
        "if-match",
        "if-none-match",
      ].includes(normalized)
    ) {
      headers.set(name, value);
    }
  }
  headers.set(
    "authorization",
    `${credential.tokenType} ${credential.accessToken}`,
  );
  const response = await fetch(
    new URL(input.path, googleServiceOrigin(input.service)),
    {
      method,
      headers,
      body:
        method === "GET" || method === "DELETE"
          ? undefined
          : input.body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const responseHeaders: Record<string, string> = {};
  for (const name of ["content-type", "etag", "location"]) {
    const value = response.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  return {
    status: response.status,
    headers: responseHeaders,
    body: await readLimitedText(response, 4_000_000),
  };
}
