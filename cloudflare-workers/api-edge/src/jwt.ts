// The edge's HS256 JWTs: the dashboard cookie (`oc_session`, SESSION_JWT_SECRET,
// issuer "opensandbox-session", kept so existing sessions stay valid), the Mac
// app's access token (app_auth.ts: the same secret, its own issuer, so neither
// verifier accepts the other's) and the assertion to managed agents
// (managed_agents.ts, OC_MANAGED_AGENTS_SECRET).

import { jwtVerify, SignJWT, type JWTPayload } from "jose";

export const SESSION_ISSUER = "opensandbox-session";
export const SESSION_TTL_SEC = 60 * 60 * 8; // 8h

export interface SessionClaims {
  iss?: string;
  sub: string;
  iat: number;
  exp: number;
  org_id: string;
  user_id: string;
  plan: string;
  // WorkOS session id (sid). Carried so /auth/logout can build the WorkOS
  // hosted logout URL and tear down the SSO session, not just our cookie.
  // Optional: sessions minted before this existed won't have it.
  wsid?: string;
}

const encoder = new TextEncoder();

export function signJWT(secret: string, claims: JWTPayload): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(encoder.encode(secret));
}

/** The claims of a token signed with `secret` under `issuer`; null unless it verifies and has not expired. */
export async function verifyJWT<T>(secret: string, token: string, issuer: string): Promise<T | null> {
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), { issuer, algorithms: ["HS256"] });
    return payload as T;
  } catch {
    return null;
  }
}

export function mintSessionJWT(secret: string, orgID: string, userID: string, plan: string, wsid?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(secret, {
    iss: SESSION_ISSUER,
    sub: userID,
    iat: now,
    exp: now + SESSION_TTL_SEC,
    org_id: orgID,
    user_id: userID,
    plan,
    ...(wsid ? { wsid } : {}),
  });
}

export function verifySessionJWT(secret: string, token: string): Promise<SessionClaims | null> {
  return verifyJWT<SessionClaims>(secret, token, SESSION_ISSUER);
}
