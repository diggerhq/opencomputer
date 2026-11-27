// The self-hosted gateway (spike): the hosted edge Worker, mounted on the Computer path only, for
// one VM under Miniflare (selfhost/gateway). Hosted-only routes answer 404 here, and their
// bindings (billing, Modal, Azure, Workers AI, the Account and Session objects, previews, wire,
// platform) are not bound. The operator signs in with BLUE_API_KEY (auth.ts's self-hosted path),
// which serve.mjs sets from SETUP_TOKEN.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import edge from "../edge/index.js";
import { memberId } from "../ids/session-ids.js";
import { API_SCOPES } from "../api-objects/objects.js";
import type { Principal } from "../auth/principal.js";
import type { LiveCredentials as LiveCredentialsRpc } from "../actors/live/contract.js";

export { ComputerDurableObject, OrgDurableObject, SessionLogDurableObject, SlackDurableObject } from "../edge/index.js";
export { LiveDurableObject } from "../actors/live/durable-object.js";

/**
 * ACCOUNTS: the hosted Account object holds GitHub App installations, managed model credentials
 * and service connections, none of which a self-hosted gateway has yet. This stand-in answers
 * "none" to what the Computer path asks of it, so no hosted code changes.
 */
export class SelfhostAccountDurableObject extends DurableObject {
  async listGitHubInstallations(): Promise<[]> {
    return [];
  }
  async getGitHubInstallation(): Promise<null> {
    return null;
  }
  async mintGitHubInstallationToken(): Promise<never> {
    throw new Error("GitHub is not configured on this self-hosted gateway");
  }
  async resolveManagedModelCredential(): Promise<null> {
    return null;
  }
  async listComputerServiceAttachments(): Promise<[]> {
    return [];
  }
  async grantableComputerConnections(): Promise<[]> {
    return [];
  }
  async getConnection(): Promise<null> {
    return null;
  }
  async getConnectionForUser(): Promise<null> {
    return null;
  }
}

interface SelfhostEnv {
  BLUE_API_KEY?: string;
  BLUE_ACCOUNT_ID: string;
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

export default {
  async fetch(request: Request, env: never, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, mode: "miniflare" });
    if (!computerPath(url.pathname)) return Response.json({ error: "not_found" }, { status: 404 });
    return edge.fetch(request, env, context);
  },
};
