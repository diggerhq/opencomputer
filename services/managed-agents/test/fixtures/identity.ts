// Assertions as the edge mints them: every caller of the Computer API carries the one principal
// (`oc_principal`, spec 34.3).

import type { Principal } from "../../src/actor/principal.js";
import { API_SCOPES, type ApiScope } from "../../src/computer/api-types.js";
import { apiScopes } from "../../src/computer/keys.js";
import type { RequestIdentity } from "../../src/edge/auth.js";

/** A member by cookie: the web tab is not narrowed. */
const DASHBOARD_SCOPES: ApiScope[] = [...API_SCOPES];

/** `usr_…` of a WorkOS user id, as `memberId` maps it. */
const subjectOf = (userId: string) => `usr_${userId.slice("user_".length).toLowerCase()}`;

export function memberIdentity(org: string, userId: string, extra: Partial<RequestIdentity> = {}): RequestIdentity {
  const subject = subjectOf(userId);
  const ocPrincipal: Principal = {
    org, subject, kind: "member", via: "dashboard", scopes: [...DASHBOARD_SCOPES],
    audiences: ["org", `member:${subject}`], admin: false, credential: { id: `ck:${org}:${userId}`, expiresAt: null },
  };
  return { kind: "user", userId, accountId: org, organizationId: org, ocPrincipal, ...extra } as RequestIdentity;
}

export function keyIdentity(org: string, userId: string, scopes: string[], id = "key_1", extra: Partial<RequestIdentity> = {}): RequestIdentity {
  const base = memberIdentity(org, userId, extra);
  return {
    ...base,
    apiKey: { id, hash: "a".repeat(64), name: "k", kind: "user", scopes, expiresAt: null, createdAt: null },
    ocPrincipal: { ...base.ocPrincipal!, kind: "key", via: "api", scopes: apiScopes(scopes), credential: { id, expiresAt: null } },
  } as RequestIdentity;
}

export function agentIdentity(org: string, session: string, scopes: ApiScope[], id = "key_2"): RequestIdentity {
  return {
    kind: "user", userId: "computer", accountId: org, organizationId: org,
    apiKey: { id, hash: "b".repeat(64), name: "s", kind: "user", scopes, expiresAt: null, createdAt: null },
    ocPrincipal: {
      org, subject: session, kind: "agent", via: "agent", session, scopes: [...new Set<ApiScope>([...scopes, "work:read", "work:write"])],
      audiences: [], admin: false, credential: { id, expiresAt: null },
    },
  } as RequestIdentity;
}
