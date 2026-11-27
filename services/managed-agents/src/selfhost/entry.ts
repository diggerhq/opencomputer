// The self-hosted gateway (spike): the hosted edge Worker, mounted on the Computer path only, for
// one VM under Miniflare (selfhost/gateway). Hosted-only routes answer 404 here, and their
// bindings (billing, Modal, Azure, Workers AI, the Account and Session objects, previews, wire,
// platform) are not bound. The operator signs in with BLUE_API_KEY (auth.ts's self-hosted path),
// which serve.mjs sets from SETUP_TOKEN. api-edge, in front, serves the dashboard and reaches
// this Worker with its agent token; SelfhostSignIn gives it /setup's WorkOS app.

import { WorkerEntrypoint } from "cloudflare:workers";
import edge from "../edge/index.js";
import { memberId } from "../ids/session-ids.js";
import { API_SCOPES } from "../api-objects/objects.js";
import type { Principal } from "../auth/principal.js";
import type { LiveCredentials as LiveCredentialsRpc } from "../actors/live/contract.js";
import { slackOf } from "../actors/addresses.js";
import { computerOf } from "../http/computer-objects.js";
import { computerModelKeyChanged } from "../http/dashboard/routes.js";
import { routeSlackDashboard } from "../http/slack/webhooks.js";
import type { SelfhostAccountDurableObject } from "./account.js";
import { COMPUTER_SLACK_SCOPES, SLACK_CALLBACK_PATH, handleSetup, type SetupDeps } from "./setup.js";

export { ComputerDurableObject, OrgDurableObject, SessionLogDurableObject, SlackDurableObject } from "../edge/index.js";
export { LiveDurableObject } from "../actors/live/durable-object.js";

export { SelfhostAccountDurableObject } from "./account.js";

interface SelfhostEnv {
  BLUE_API_KEY?: string;
  BLUE_ACCOUNT_ID: string;
  /** SETUP_TOKEN (serve.mjs): /setup's credential. */
  SELFHOST_SETUP_TOKEN?: string;
  /** "1": /setup stays open once complete. */
  SP_SETUP_OPEN?: string;
  /** The host's dial URL and token, for /setup's install command. */
  SELFHOST_HOST_URL?: string;
  SELFHOST_HOST_TOKEN?: string;
  COMPUTER_PUBLIC_ORIGIN?: string;
  ACCOUNTS: DurableObjectNamespace<SelfhostAccountDurableObject>;
}

/** Slack's routes on the Computer path; they get the Slack app /setup stored as SLACK_COMPUTER_*. */
function slackPath(pathname: string): boolean {
  return pathname.startsWith("/v1/webhooks/computer/slack/") || pathname === "/v1/computer/slack" || pathname.startsWith("/v1/computer/slack/");
}

/** Paths the self-hosted gateway serves; every other answers 404. */
function computerPath(pathname: string): boolean {
  return (
    pathname === "/v1/computer" ||
    pathname.startsWith("/v1/computer/") ||
    pathname.startsWith("/v1/webhooks/computer/slack/") ||
    pathname === "/v1/internal/live/revoke"
  );
}

/** The operator's principal, as auth.ts builds it for a bearer equal to BLUE_API_KEY. */
async function operatorPrincipal(org: string): Promise<Principal> {
  const subject = await memberId("local");
  return {
    org,
    subject,
    kind: "member",
    via: "api",
    scopes: [...API_SCOPES],
    audiences: ["org", `member:${subject}`],
    admin: true,
    credential: { id: "local", expiresAt: null },
  };
}

/**
 * Live's credential check, which api-edge answers in the hosted deployment: here the operator's
 * key is the one credential, and it is never revoked.
 */
export class LiveCredentials extends WorkerEntrypoint<SelfhostEnv> implements LiveCredentialsRpc {
  async revoked(_ids: string[]): Promise<string[]> {
    return [];
  }
  async principal(token: string): Promise<Principal | null> {
    const key = this.env.BLUE_API_KEY;
    if (!key || token !== key) return null;
    return operatorPrincipal(this.env.BLUE_ACCOUNT_ID);
  }
}

/** The WorkOS app and owner's email /setup stored, for api-edge's sign-in (its SELFHOST_SETUP binding). */
export class SelfhostSignIn extends WorkerEntrypoint<SelfhostEnv> {
  async signIn(): Promise<{ clientId: string; apiKey: string; ownerEmail: string | null } | null> {
    return this.env.ACCOUNTS.getByName(this.env.BLUE_ACCOUNT_ID).signIn();
  }
}

/** The env with the Slack app /setup stored, as the hosted Worker reads it from its vars; unchanged until all three are set. */
async function withSlackApp(env: SelfhostEnv): Promise<SelfhostEnv> {
  const app = await env.ACCOUNTS.getByName(env.BLUE_ACCOUNT_ID).slackApp();
  if (!app) return env;
  return {
    ...env,
    SLACK_COMPUTER_CLIENT_ID: app.clientId,
    SLACK_COMPUTER_CLIENT_SECRET: app.clientSecret,
    SLACK_COMPUTER_SIGNING_SECRET: app.signingSecret,
    SLACK_COMPUTER_SCOPES: COMPUTER_SLACK_SCOPES,
  } as SelfhostEnv;
}

function setupDeps(env: SelfhostEnv): SetupDeps {
  const org = env.BLUE_ACCOUNT_ID;
  const account = env.ACCOUNTS.getByName(org);
  const edgeEnv = env as never;
  const origin = env.COMPUTER_PUBLIC_ORIGIN?.replace(/\/+$/, "") || null;
  return {
    setupToken: env.SELFHOST_SETUP_TOKEN,
    open: env.SP_SETUP_OPEN === "1",
    publicUrl: origin,
    org,
    store: { status: () => account.status(), write: (w) => account.write(w) },
    host: env.SELFHOST_HOST_URL && env.SELFHOST_HOST_TOKEN ? { url: env.SELFHOST_HOST_URL, token: env.SELFHOST_HOST_TOKEN } : null,
    async hostConnected() {
      try {
        return (await computerOf(edgeEnv, org).overview(org)).computer?.connected ?? false;
      } catch {
        return null;
      }
    },
    modelKeyChanged: () => computerModelKeyChanged(edgeEnv, org),
    async slackLinked() {
      const slack = (await slackOf(edgeEnv, org).forHost()).slack;
      return slack ? { installed: true, ...(slack.teamName ? { teamName: slack.teamName } : {}) } : { installed: false };
    },
    async slackInstall() {
      const request = new Request(`${origin ?? "http://localhost"}/v1/computer/slack/install`, { method: "POST" });
      const response = await routeSlackDashboard(request, (await withSlackApp(env)) as never, () => operatorPrincipal(org));
      const body = (await response?.json().catch(() => null)) as { url?: string; detail?: string; title?: string } | null;
      if (response?.ok && body?.url) return { url: body.url };
      return { error: body?.detail ?? body?.title ?? "The Slack install could not start." };
    },
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Where the Slack OAuth callback lands (`${COMPUTER_PUBLIC_ORIGIN}/computer?slack=…`): the hosted dashboard's page, which this gateway does not run. */
function slackOutcomePage(url: URL): Response {
  const ok = url.searchParams.get("slack") === "connected";
  const reason = url.searchParams.get("reason") ?? "unknown";
  const message = ok ? "Slack is connected. Mention the app in a channel, or DM it, to start." : `Slack was not connected (${escapeHtml(reason)}).`;
  const html = `<!doctype html><meta charset="utf-8"><title>OpenComputer</title><p>${message}</p><p><a href="/setup">Back to setup</a></p>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'", "referrer-policy": "no-referrer" },
  });
}

export default {
  async fetch(request: Request, env: SelfhostEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, mode: "miniflare" });
    if (url.pathname === "/setup" || url.pathname.startsWith("/setup/")) return handleSetup(request, setupDeps(env));
    if (url.pathname === "/computer" && request.method === "GET") return slackOutcomePage(url);
    // slackRedirectUri names the hosted dashboard's proxy path; here it is the Worker's own.
    if (url.pathname === SLACK_CALLBACK_PATH) {
      url.pathname = "/v1/computer/slack/callback";
      request = new Request(url, request);
    }
    if (!computerPath(url.pathname)) return Response.json({ error: "not_found" }, { status: 404 });
    return edge.fetch(request, (slackPath(url.pathname) ? await withSlackApp(env) : env) as never, context);
  },
};
