// The single-VM self-hosted gateway (selfhost/gateway). serve.mjs runs this Worker under
// Miniflare next to managed-agents, with SELFHOST="1". There is no billing: no Autumn, Stripe or
// OpenRouter provisioning, no credit gate and no billing crons. There is one organization,
// SELFHOST_ORG_ID, the gateway's GATEWAY_ORG, which the host dials. The WorkOS app and the
// owner's email come from /setup, through managed-agents' SelfhostSignIn entrypoint.

export interface SelfhostSignIn {
  clientId: string;
  apiKey: string;
  ownerEmail: string | null;
}

export interface SelfhostEnv {
  SELFHOST?: string;
  SELFHOST_ORG_ID?: string;
  SELFHOST_OWNER_EMAIL?: string | null;
  /** managed-agents' SelfhostSignIn entrypoint (service binding). */
  SELFHOST_SETUP?: { signIn(): Promise<SelfhostSignIn | null> };
}

export function isSelfhost(env: SelfhostEnv): boolean {
  return env.SELFHOST === "1";
}

/** The env with /setup's WorkOS app and owner email; empty WorkOS values until /setup has them. */
export async function withSelfhostSignIn<E extends SelfhostEnv & { WORKOS_CLIENT_ID: string; WORKOS_API_KEY: string }>(
  env: E,
): Promise<E> {
  const signIn = (await env.SELFHOST_SETUP?.signIn().catch((err) => {
    console.error("selfhost: reading the sign-in settings failed", err);
    return null;
  })) ?? null;
  return {
    ...env,
    WORKOS_CLIENT_ID: signIn?.clientId ?? "",
    WORKOS_API_KEY: signIn?.apiKey ?? "",
    SELFHOST_OWNER_EMAIL: signIn?.ownerEmail ?? null,
  };
}

/** Answers /auth/login until /setup has the WorkOS app. */
export function signInNotConfigured(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>OpenComputer</title><p>Sign-in isn't set up yet. The operator adds the WorkOS app in <a href="/setup">/setup</a>.</p>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** A person who is neither the owner nor invited. */
export class SelfhostNotInvited extends Error {
  constructor() {
    super("not invited to this self-hosted OpenComputer");
  }
}

export function notInvitedPage(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>OpenComputer</title><p>You aren't a member of this OpenComputer. Ask its owner to invite you, then <a href="/auth/login">sign in again</a>.</p>`,
    { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

type Db = { OPENCOMPUTER_DB: D1Database };

/**
 * Before a sign-in picks its organization: creates the one organization on first use and makes
 * the owner's email its owner. Invitations are redeemed by the caller afterwards, as hosted.
 */
export async function ensureSelfhostOrg(env: SelfhostEnv & Db, userID: string, email: string, nowSec: number): Promise<void> {
  const org = env.SELFHOST_ORG_ID;
  if (!org) throw new Error("SELFHOST_ORG_ID is not set");
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO orgs (id, name, slug, plan, home_cell, is_personal, billing_provider, created_at, updated_at)
     VALUES (?1, 'OpenComputer', ?1, 'free', '', 0, 'legacy', ?2, ?2)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(org, nowSec)
    .run();
  const owner = env.SELFHOST_OWNER_EMAIL?.trim().toLowerCase();
  if (!owner || owner !== email.trim().toLowerCase()) return;
  await env.OPENCOMPUTER_DB.batch([
    env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)
       ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'owner'`,
    ).bind(org, userID, nowSec),
    env.OPENCOMPUTER_DB.prepare(`UPDATE orgs SET owner_user_id = ?1, updated_at = ?2 WHERE id = ?3`).bind(userID, nowSec, org),
  ]);
}

/** Billing's routes, which answer 404 on the self-hosted gateway. */
export function selfhostBillingPath(path: string): boolean {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return (
    under("/api/dashboard/billing") ||
    under("/api/billing") ||
    path.startsWith("/api/public/promo/") ||
    path === "/api/dashboard/github-star/claim" ||
    path === "/webhooks/stripe" ||
    path === "/webhooks/autumn" ||
    path.startsWith("/internal/autumn-") ||
    path === "/internal/run-autumn-meter" ||
    under("/internal/model-billing")
  );
}
