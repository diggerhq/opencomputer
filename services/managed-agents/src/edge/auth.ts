import {
  createRemoteJWKSet,
  jwtVerify,
} from "jose";

import type { ManagedAgentIdentity } from "../protocol.js";
import { COMPUTER_PRINCIPAL } from "./computer-principal.js";

export interface ManagedAgentAuthEnv {
  BLUE_ACCOUNT_ID: string;
  BLUE_ENVIRONMENT: string;
  BLUE_API_KEY?: string;
  OC_MANAGED_AGENTS_SECRET?: string;
  OC_MANAGED_AGENTS_ONLY?: string;
  BLUE_WORKOS_CLIENT_ID?: string;
  BLUE_WORKOS_ISSUER?: string;
  BLUE_WORKOS_JWKS_URL?: string;
  BLUE_WORKOS_DEVICE_AUTHORIZATION_ENDPOINT?: string;
  BLUE_WORKOS_TOKEN_ENDPOINT?: string;
}

export interface RequestIdentity extends ManagedAgentIdentity {
  kind: "user" | "runtime";
  projectId?: string;
  /** Set when the caller is the organization's computer (work 080). */
  principal?: typeof COMPUTER_PRINCIPAL;
  /** The computer's Slack session the key was minted for, if the host named one. */
  sessionKey?: string;
  /**
   * The API key the edge authenticated (work 084), from its `key_*` claims. Absent for a
   * dashboard session credential, which the computer API reads as "all scopes".
   */
  apiKey?: AssertedApiKey;
  /** The key creator's name and email, when the edge loaded them. */
  userName?: string;
  userEmail?: string;
}

export interface AssertedApiKey {
  id: string;
  /** SHA-256 hex of the raw key. */
  hash: string;
  name: string;
  kind: "user" | "project";
  /** The raw scopes column, split (legacy keys: `sandbox:*`). */
  scopes: string[];
  expiresAt: string | null;
  createdAt: string | null;
}

/** The `key_*` claims, or undefined when there are none; null when they are malformed. */
function assertedApiKey(payload: Record<string, unknown>): AssertedApiKey | null | undefined {
  if (payload.key_id === undefined) return undefined;
  const { key_id, key_hash, key_name, key_kind, key_scopes, key_expires_at, key_created_at } = payload;
  if (
    typeof key_id !== "string" ||
    typeof key_hash !== "string" || !/^[0-9a-f]{64}$/.test(key_hash) ||
    (key_name !== undefined && typeof key_name !== "string") ||
    (key_kind !== undefined && key_kind !== "user" && key_kind !== "project") ||
    (key_scopes !== undefined &&
      !(Array.isArray(key_scopes) && key_scopes.every((s) => typeof s === "string"))) ||
    (key_expires_at != null && typeof key_expires_at !== "string") ||
    (key_created_at != null && typeof key_created_at !== "string")
  ) {
    return null;
  }
  return {
    id: key_id,
    hash: key_hash,
    name: (key_name as string | undefined) ?? "",
    kind: (key_kind as "user" | "project" | undefined) ?? "user",
    scopes: (key_scopes as string[] | undefined) ?? [],
    expiresAt: (key_expires_at as string | null | undefined) ?? null,
    createdAt: (key_created_at as string | null | undefined) ?? null,
  };
}

export interface PublicAuthConfiguration {
  clientId: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

export function isAcceptedWorkOsIssuer(
  value: unknown,
  env: ManagedAgentAuthEnv,
): boolean {
  if (typeof value !== "string" || !env.BLUE_WORKOS_CLIENT_ID) return false;
  const normalizedIssuer = value.replace(/\/$/, "");
  const configuredIssuer = (
    env.BLUE_WORKOS_ISSUER ?? "https://api.workos.com"
  ).replace(/\/$/, "");
  return new Set([
    "https://api.workos.com",
    `https://api.workos.com/user_management/${env.BLUE_WORKOS_CLIENT_ID}`,
    configuredIssuer,
  ]).has(normalizedIssuer);
}

function bearerToken(request: Request, url: URL): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return url.searchParams.get("api_key") ?? undefined;
}

// Only the session WebSocket a runtime dials; the session object checks its
// runtime token. Any other route must not get the runtime identity.
const RUNTIME_CONNECT_PATH = /^\/v1\/sessions\/[^/]+\/connect$/;

function runtimeRequest(request: Request, url: URL): boolean {
  return (
    request.method === "GET" &&
    RUNTIME_CONNECT_PATH.test(url.pathname) &&
    url.searchParams.get("role") === "runtime"
  );
}

function safeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
  );
}

export function authConfiguration(
  env: ManagedAgentAuthEnv,
): PublicAuthConfiguration | null {
  if (!env.BLUE_WORKOS_CLIENT_ID) return null;
  return {
    clientId: env.BLUE_WORKOS_CLIENT_ID,
    deviceAuthorizationEndpoint:
      env.BLUE_WORKOS_DEVICE_AUTHORIZATION_ENDPOINT ??
      "https://api.workos.com/user_management/authorize/device",
    tokenEndpoint:
      env.BLUE_WORKOS_TOKEN_ENDPOINT ??
      "https://api.workos.com/user_management/authenticate",
  };
}

export async function authenticateRequest(
  request: Request,
  env: ManagedAgentAuthEnv,
  url: URL,
): Promise<RequestIdentity | null> {
  if (runtimeRequest(request, url)) {
    return {
      kind: "runtime",
      userId: "runtime",
      accountId: "runtime",
    };
  }

  const openComputerAssertion = request.headers.get(
    "x-opencomputer-agent-token",
  );
  if (openComputerAssertion && env.OC_MANAGED_AGENTS_SECRET) {
    try {
      const verified = await jwtVerify(
        openComputerAssertion,
        new TextEncoder().encode(env.OC_MANAGED_AGENTS_SECRET),
        {
          algorithms: ["HS256"],
          issuer: "opencomputer-edge",
          audience: "managedagents",
        },
      );
      const accountId = verified.payload.org_id;
      const userId = verified.payload.user_id;
      const role = verified.payload.role;
      const principal = verified.payload.principal;
      const sessionKey = verified.payload.session_key;
      if (
        typeof accountId !== "string" ||
        (userId !== undefined && typeof userId !== "string") ||
        (role !== undefined && typeof role !== "string") ||
        (principal !== undefined && principal !== COMPUTER_PRINCIPAL) ||
        (sessionKey !== undefined &&
          (principal !== COMPUTER_PRINCIPAL || typeof sessionKey !== "string"))
      ) {
        return null;
      }
      const apiKey = assertedApiKey(verified.payload);
      if (apiKey === null) return null;
      const userName = verified.payload.user_name;
      const userEmail = verified.payload.user_email;
      return {
        kind: "user",
        accountId,
        organizationId: accountId,
        userId: userId ?? "opencomputer-edge",
        role,
        ...(principal === COMPUTER_PRINCIPAL
          ? { principal, ...(sessionKey ? { sessionKey } : {}) }
          : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(typeof userName === "string" && userName ? { userName } : {}),
        ...(typeof userEmail === "string" && userEmail ? { userEmail } : {}),
      };
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "auth.opencomputer_assertion_rejected",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  if (env.OC_MANAGED_AGENTS_ONLY === "true") {
    return null;
  }

  const token = bearerToken(request, url);
  if (env.BLUE_WORKOS_CLIENT_ID) {
    if (!token) return null;
    const jwks = createRemoteJWKSet(
      new URL(
        env.BLUE_WORKOS_JWKS_URL ??
          `https://api.workos.com/sso/jwks/${env.BLUE_WORKOS_CLIENT_ID}`,
      ),
    );
    try {
      const verified = await jwtVerify(token, jwks);
      const clientId = verified.payload.client_id;
      const userId = verified.payload.sub;
      const organizationId = verified.payload.org_id;
      if (
        !isAcceptedWorkOsIssuer(verified.payload.iss, env) ||
        clientId !== env.BLUE_WORKOS_CLIENT_ID ||
        typeof userId !== "string" ||
        (organizationId !== undefined &&
          typeof organizationId !== "string")
      ) {
        return null;
      }
      return {
        kind: "user",
        userId,
        accountId: organizationId ?? userId,
        organizationId,
        role:
          typeof verified.payload.role === "string"
            ? verified.payload.role
            : undefined,
      };
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "auth.jwt_rejected",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  if (env.BLUE_API_KEY) {
    if (!token || !safeEqual(token, env.BLUE_API_KEY)) return null;
  } else if (env.BLUE_ENVIRONMENT !== "development") {
    return null;
  }
  return {
    kind: "user",
    userId: "local",
    accountId: env.BLUE_ACCOUNT_ID,
  };
}
