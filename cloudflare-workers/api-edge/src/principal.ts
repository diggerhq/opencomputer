// Who is asking (tracks and threads spec 34.3). The edge verifies the
// credential and resolves it to a Principal, which rides the assertion as the
// `oc_principal` claim; state and link actors never see a credential.
//
// The type is a copy of services/managed-agents/src/actor/principal.ts (the
// packages share no code); the member id mapping a copy of `memberId` in
// services/managed-agents/src/computer/session-ids.ts, and the scope reading
// a copy of `apiScopes` in services/managed-agents/src/computer/keys.ts.

export const API_SCOPES = [
  "sessions:read",
  "sessions:write",
  "asks:answer",
  "secrets:write",
  "terminals",
  "work:read",
  "work:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface Principal {
  org: string;
  /** `usr_…`; `slack:<team>:<user>`; `cs_…` for an agent; `platform`. */
  subject: string;
  kind: "member" | "key" | "agent" | "platform";
  via: "dashboard" | "app" | "opc" | "api" | "slack" | "agent";
  scopes: ApiScope[];
  /** member, key: `['org', 'member:<subject>']`; agent, platform: `[]`. */
  audiences: string[];
  /** agent: the session the key is bound to. */
  session?: string;
  admin: boolean;
  credential: { id: string; expiresAt: number | null };
}

/** What a member by cookie or by the Mac app's token may do: what the surface uses. */
export const MEMBER_SCOPES: readonly ApiScope[] = [
  "sessions:read",
  "sessions:write",
  "asks:answer",
  "work:read",
  "work:write",
];

const WORKOS_USER = /^user_([0-9A-HJKMNP-TV-Z]{26})$/;

/** The member id (`usr_…`) of a dashboard user id, as managed agents maps it. */
export async function memberId(userId: string): Promise<string> {
  const workos = WORKOS_USER.exec(userId);
  if (workos) return `usr_${workos[1]!.toLowerCase()}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId)),
  );
  return `usr_x${[...digest.slice(0, 13)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const NAMED_ONLY: readonly ApiScope[] = ["secrets:write", "work:read", "work:write"];

/** A key's API scopes: `sandbox:*`, `*` or none mean every scope but NAMED_ONLY. */
export function apiScopes(raw: readonly string[] | undefined): ApiScope[] {
  const named = (scope: ApiScope) => raw?.includes(scope) ?? false;
  const wildcard =
    !raw || raw.length === 0 || raw.some((s) => s === "*" || s === "sandbox:*");
  return API_SCOPES.filter(
    (scope) => named(scope) || (wildcard && !NAMED_ONLY.includes(scope)),
  );
}

/** A session id: `cs_` + 16 lowercase Crockford base32. */
export const SESSION_ID = /^cs_[0-9a-hjkmnp-tv-z]{16}$/;

/** A member by cookie (`dashboard`) or by the Mac app's token (`app`). */
export async function memberPrincipal(input: {
  org: string;
  userId: string;
  admin: boolean;
  via: "dashboard" | "app";
  credential: { id: string; expiresAt: number | null };
}): Promise<Principal> {
  const subject = await memberId(input.userId);
  return {
    org: input.org,
    subject,
    kind: "member",
    via: input.via,
    scopes: [...MEMBER_SCOPES],
    audiences: ["org", `member:${subject}`],
    admin: input.admin,
    credential: input.credential,
  };
}

/**
 * An API key. A key whose record names a session (`session_key`, migration
 * 0010) is that session's agent: `work:read` and `work:write` are added and
 * `terminals` taken away; its reach is checked by SessionLog and Org, not here.
 * Any other key is its creator's, `opc` or `api` by the caller's user agent
 * (as the edge's telemetry tells them apart).
 */
export async function keyPrincipal(input: {
  org: string;
  createdBy: string | null;
  admin: boolean;
  keyId: string;
  scopes: readonly string[];
  /** Epoch ms, or null for a key that never expires. */
  expiresAt: number | null;
  sessionKey?: string | null;
  userAgent?: string | null;
}): Promise<Principal> {
  const credential = { id: input.keyId, expiresAt: input.expiresAt };
  if (input.sessionKey) {
    const scopes = new Set<ApiScope>(apiScopes(input.scopes));
    scopes.add("work:read");
    scopes.add("work:write");
    scopes.delete("terminals");
    return {
      org: input.org,
      subject: input.sessionKey,
      kind: "agent",
      via: "agent",
      scopes: API_SCOPES.filter((scope) => scopes.has(scope)),
      audiences: [],
      session: input.sessionKey,
      admin: false,
      credential,
    };
  }
  const subject = await memberId(input.createdBy ?? "");
  return {
    org: input.org,
    subject,
    kind: "key",
    via: (input.userAgent ?? "").startsWith("opc/") ? "opc" : "api",
    scopes: apiScopes(input.scopes),
    audiences: ["org", `member:${subject}`],
    admin: input.admin,
    credential,
  };
}

/**
 * The credential id of a session cookie: `ck:<org>:<user>:<exp>:<hash>`, so
 * Live can revalidate it by id alone (the membership still exists, the
 * cookie not expired) and a sign-out can name the one cookie it ends.
 */
export async function cookieCredentialId(
  token: string,
  org: string,
  userId: string,
  expSec: number,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  const hash = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ck:${org}:${userId}:${expSec}:${hash}`;
}

export function parseCookieCredentialId(
  id: string,
): { org: string; userId: string; expSec: number } | null {
  const parts = id.split(":");
  if (parts.length !== 5 || parts[0] !== "ck") return null;
  const expSec = Number(parts[3]);
  if (!parts[1] || !parts[2] || !Number.isFinite(expSec)) return null;
  return { org: parts[1], userId: parts[2], expSec };
}

/**
 * `x-oc-principal: <org>/<subject>` (spec 34.2): absent is fine; present, it
 * must name the credential's principal.
 */
export function principalHeaderMatches(request: Request, principal: Principal): boolean {
  const named = request.headers.get("x-oc-principal");
  if (named === null) return true;
  return named === `${principal.org}/${principal.subject}`;
}
