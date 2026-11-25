/**
 * The organization's computer as a caller (work 080). The
 * edge marks an assertion minted for a computer key with `principal:
 * "computer"` and, when the host named one, the Slack session it was minted
 * for. A computer may use what the organization has granted it; it never
 * connects, attaches or grants credentials itself: a person does that from
 * Slack or the dashboard. The edge refuses these routes first; this is the
 * same list, so a missed edge rule is not enough.
 *
 * Also the caller as tracks and threads names it (spec 34.3): the `Principal` the edge puts
 * in the assertion as `oc_principal`, or, for an assertion without it, the same principal
 * built from the older claims.
 */

import type { Principal } from "../actor/principal.js";
import { API_SCOPES, type ApiScope } from "../computer/api-types.js";
import { apiScopes } from "../computer/keys.js";
import { isSessionId, memberId } from "../computer/session-ids.js";
import type { RequestIdentity } from "./auth.js";

export const COMPUTER_PRINCIPAL = "computer";

const FETCH_ROUTE = /^\/v1\/connections\/[^/]+\/fetch$/;

export function isComputerGrantRoute(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return false;
  if (/^\/v1\/connections(?:\/|$)/.test(pathname)) {
    return !(verb === "POST" && FETCH_ROUTE.test(pathname));
  }
  return (
    /^\/v1\/projects\/[^/]+\/service-connections$/.test(pathname) ||
    pathname === "/v1/computer/service-connections" ||
    /^\/v1\/(?:projects\/[^/]+\/)?model-access(?:\/|$)/.test(pathname) ||
    pathname.startsWith("/v1/linear/") ||
    /^\/v1\/projects\/[^/]+\/linear(?:\/|$)/.test(pathname) ||
    /^\/v1\/channels(?:\/|$)/.test(pathname) ||
    pathname === "/v1/channel-connections/claim" ||
    pathname === "/v1/github/connect" ||
    /^\/v1\/projects\/[^/]+\/github(?:\/(?:connect|attach))?$/.test(pathname)
  );
}

const KINDS = new Set(["member", "key", "agent", "platform"]);
const VIAS = new Set(["dashboard", "app", "opc", "api", "slack", "agent"]);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * The `oc_principal` claim, checked: undefined when absent, null when malformed or of another
 * organization (the assertion is then refused). `platform` never arrives from outside.
 */
export function principalClaim(claim: unknown, org: string): Principal | null | undefined {
  if (claim === undefined) return undefined;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return null;
  const c = claim as Record<string, unknown>;
  const cred = c.credential as Record<string, unknown> | null | undefined;
  if (
    c.org !== org ||
    typeof c.subject !== "string" || !c.subject ||
    typeof c.kind !== "string" || !KINDS.has(c.kind) || c.kind === "platform" ||
    typeof c.via !== "string" || !VIAS.has(c.via) ||
    !strings(c.scopes) || !strings(c.audiences) ||
    (c.session !== undefined && typeof c.session !== "string") ||
    typeof c.admin !== "boolean" ||
    !cred || typeof cred !== "object" || typeof cred.id !== "string" ||
    !(cred.expiresAt === null || (typeof cred.expiresAt === "number" && Number.isFinite(cred.expiresAt)))
  ) {
    return null;
  }
  return {
    org,
    subject: c.subject,
    kind: c.kind as Principal["kind"],
    via: c.via as Principal["via"],
    scopes: API_SCOPES.filter((s) => (c.scopes as string[]).includes(s)),
    audiences: [...c.audiences],
    ...(typeof c.session === "string" ? { session: c.session } : {}),
    admin: c.admin,
    credential: { id: cred.id, expiresAt: cred.expiresAt as number | null },
  };
}

/** What a member's cookie or the app's token may do (spec 34.3); the Computer's own routes keep today's check. */
const MEMBER_SCOPES: ApiScope[] = ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"];

/**
 * The caller's principal: the edge's `oc_principal` when the assertion has it, else the same
 * principal built from the older claims. Null for a project key, which uses no session.
 */
export async function principalOf(identity: RequestIdentity, userAgent: string | null): Promise<Principal | null> {
  if (identity.ocPrincipal) return identity.ocPrincipal;
  const key = identity.apiKey;
  if (key?.kind === "project" || identity.projectId) return null;
  const org = identity.accountId;
  // The edge folds an organization's `owner` and `admin` roles into `admin`.
  const admin = identity.role === "admin" || identity.role === "owner";
  const expiresAt = key?.expiresAt ? Date.parse(key.expiresAt) : NaN;
  const credential = { id: key?.id ?? `login:${identity.userId}`, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
  if (identity.principal === COMPUTER_PRINCIPAL) {
    // A `cs_…` session key binds the agent to that session; an older Slack thread key binds it to none.
    const session = identity.sessionKey && isSessionId(identity.sessionKey) ? identity.sessionKey : undefined;
    const scopes = new Set<ApiScope>([...apiScopes(key?.scopes), "work:read", "work:write"]);
    scopes.delete("terminals");
    return {
      org,
      subject: session ?? COMPUTER_PRINCIPAL,
      kind: "agent",
      via: "agent",
      scopes: API_SCOPES.filter((s) => scopes.has(s)),
      audiences: [],
      ...(session ? { session } : {}),
      admin,
      credential,
    };
  }
  const subject = await memberId(identity.userId);
  return {
    org,
    subject,
    kind: key ? "key" : "member",
    via: userAgent?.startsWith("opc/") ? "opc" : key ? "api" : "dashboard",
    scopes: key ? apiScopes(key.scopes) : [...MEMBER_SCOPES],
    audiences: ["org", `member:${subject}`],
    admin,
    credential,
  };
}
