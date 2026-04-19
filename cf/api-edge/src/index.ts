/**
 * api-edge Worker — phase 2 cut.
 *
 * Current routes:
 *   POST /webhooks/stripe
 *     Stripe webhook receiver. On `checkout.session.completed`, flips the
 *     org's plan to "pro" in D1 and calls the CreditAccount DO's /mark-pro,
 *     which fans out /admin/resume-org to any cells that still have
 *     credit-halted sandboxes.
 *
 *   GET /internal/halt-list?cell={cell_id}
 *     HMAC-authed safety-net endpoint consumed by each CP's halt_reconciler.
 *     Returns the list of org_ids that SHOULD be halted in the cell (status =
 *     halted_credits on the DO side) so CPs can catch webhooks lost to
 *     network partitions.
 *
 * Phase 3 adds: /auth/login, /api/sandboxes (create proxy + list), capability
 * tokens, 307 catch-all, cross-cell metadata lookups. Stubs exist below but
 * return 501 until the relevant pieces land.
 */

import { CreditAccount } from "../../shared/credit_account";
import Stripe from "stripe";

export { CreditAccount }; // re-export so tests & miniflare pick up the class

export interface Env {
  OPENCOMPUTER_DB: D1Database;
  CREDIT_ACCOUNT: DurableObjectNamespace;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_SECRET_KEY?: string;
  CF_ADMIN_SECRET: string;
}

const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case "GET /health":
        return Response.json({ status: "ok" });
      case "POST /webhooks/stripe":
        return handleStripeWebhook(req, env);
      case "GET /internal/halt-list":
        return handleHaltList(req, url, env);
      default:
        return new Response("not found (phase 3 endpoint?)", { status: 404 });
    }
  },
};

// --- Stripe webhook -------------------------------------------------------

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const sig = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();
  if (!sig || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("missing stripe signature or secret", { status: 400 });
  }

  // Stripe's Node SDK supports webhook signature verification in Workers. The
  // crypto provider must be explicitly set to the SubtleCrypto-backed one.
  const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_placeholder", {
    httpClient: Stripe.createFetchHttpClient(),
  });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.warn(`api-edge: stripe signature verify failed: ${String(err)}`);
    return new Response("bad signature", { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event, env);
      break;
    default:
      // Unrecognized events are acked — Stripe will retry others until 2xx.
      break;
  }
  return Response.json({ received: true });
}

async function handleCheckoutCompleted(event: Stripe.Event, env: Env): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  // Org ID is expected in the session metadata (the Go-side code that kicks
  // off the checkout puts it there already — see internal/api/dashboard_billing.go).
  const orgId = session.metadata?.org_id ?? (session.client_reference_id ?? "");
  if (!orgId) {
    console.warn("api-edge: checkout.session.completed without org_id metadata");
    return;
  }

  // Flip the plan in D1 up front so reads are immediately consistent. The DO
  // also writes this itself, but doing it here shortens the window where
  // another request sees the stale plan.
  const now = Date.now();
  await env.OPENCOMPUTER_DB.prepare(
    `INSERT INTO orgs (id, plan, stripe_customer_id, stripe_subscription_id, created_at, updated_at)
     VALUES (?, 'pro', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       plan = 'pro',
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      orgId,
      typeof session.customer === "string" ? session.customer : null,
      typeof session.subscription === "string" ? session.subscription : null,
      now,
      now,
    )
    .run();

  // DO takes the authoritative action: state→pro, dispatch resume if halted.
  const stub = env.CREDIT_ACCOUNT.get(env.CREDIT_ACCOUNT.idFromName(orgId));
  const resp = await stub.fetch("https://do/mark-pro", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_id: orgId }),
  });
  if (!resp.ok) {
    console.warn(`api-edge: DO mark-pro for ${orgId} returned ${resp.status}`);
  }
}

// --- Halt list ------------------------------------------------------------

async function handleHaltList(req: Request, url: URL, env: Env): Promise<Response> {
  const cell = url.searchParams.get("cell");
  if (!cell) {
    return new Response("missing cell param", { status: 400 });
  }
  const ok = await verifyAdminSignature(req, env);
  if (!ok) {
    return new Response("unauthorized", { status: 401 });
  }

  // Which orgs have sandboxes in this cell AND are in halted_credits state
  // per their DO? We can't query every DO — instead, we ask D1: "orgs that
  // have sandboxes in this cell with status=hibernated" and let the CP's
  // reconciler make the real decision by comparing against its own PG. The
  // CP knows if those hibernations were for credits_exhausted reason.
  const { results } = await env.OPENCOMPUTER_DB.prepare(
    `SELECT DISTINCT org_id FROM sandboxes_index
     WHERE cell_id = ? AND status = 'hibernated'`,
  )
    .bind(cell)
    .all<{ org_id: string }>();

  const orgIds = (results ?? []).map((r) => r.org_id);
  return Response.json({ org_ids: orgIds });
}

async function verifyAdminSignature(req: Request, env: Env): Promise<boolean> {
  const ts = req.headers.get("X-Timestamp") ?? "";
  const sig = req.headers.get("X-Signature") ?? "";
  if (!ts || !sig) return false;

  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  // Body is empty for GETs but signed nonetheless so callers can share the
  // same signing helper.
  const body = req.method === "GET" ? "" : await req.clone().text();
  const expected = await hmacHex(env.CF_ADMIN_SECRET, `${ts}.${body}`);
  return constantTimeEqual(expected, sig);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
