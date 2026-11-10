// Private routes for Linear agent connections (work 037 "Routes", stream S1).
//
//   POST   /v1/projects/:projectId/linear/connections          allocate
//   GET    /v1/projects/:projectId/linear/connections?environment=  list + health
//   PUT    /v1/linear/connections/:id/credentials               paste the app's secrets
//   POST   /v1/linear/connections/:id/authorize                 → { authorizeUrl }
//   DELETE /v1/linear/connections/:id                           revoke, unbind
//   GET    /v1/linear/oauth/callback                            public: Linear's redirect
//
// Access follows the GitHub project routes: a project-scoped token may read
// its own project's connections; managing credentials and bindings needs an
// account identity. The handlers stay thin; the Account object's
// `LinearConnections` owns every rule.

import type { Project, ProjectEnvironmentName } from "../protocol.js";
import type { AccountDurableObject } from "./account-do.js";
import type { RequestIdentity } from "./auth.js";
import { renderConnectionCallback } from "./connection-callback.js";
import { json, problem, readBoundedJson } from "./http.js";
import type { LinearAuthorizationResult } from "./linear-connections.js";
import {
  checkLinearAppName,
  isLinearConnectionId,
  isLinearCredentialValue,
  linearAuthorizeUrl,
  linearRouteName,
  newLinearWebhookToken,
  sha256Hex,
} from "./linear-connections.js";

/** Helpers `index.ts` already owns, passed in so this module never imports it. */
export interface LinearRouteHelpers {
  encodeOAuthState(accountId: string, nonce: string): string;
  decodeOAuthState(state: string): { accountId: string; nonce: string } | null;
  html(body: string, status?: number): Response;
  projectOwnsAgent(project: Project, agentId: string): boolean;
}

interface LinearRouteEnv {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
  BLUE_CHANNEL_ENCRYPTION_KEY?: string;
  /** The public OAuth callback (api-edge `/api/managed-agents/linear/callback`). */
  BLUE_LINEAR_OAUTH_REDIRECT_URI?: string;
  BLUE_SLACK_OAUTH_REDIRECT_URI?: string;
  OPENCOMPUTER_APP_URL?: string;
}

const BODY_LIMIT = 16 * 1024;

/**
 * The public callback Linear redirects to. Configured explicitly, or the
 * Slack callback's sibling on the same api-edge host, since api-edge serves
 * both under `/api/managed-agents/<provider>/callback`.
 */
export function linearRedirectUri(env: LinearRouteEnv): string | null {
  const explicit = env.BLUE_LINEAR_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const slack = env.BLUE_SLACK_OAUTH_REDIRECT_URI?.trim();
  if (!slack) return null;
  try {
    const url = new URL(slack);
    if (!url.pathname.endsWith("/slack/callback")) return null;
    url.pathname = url.pathname.replace(/\/slack\/callback$/, "/linear/callback");
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Returns null when the request is not a Linear connection route. */
export async function handleLinearConnectionRoute(
  request: Request,
  rawEnv: Env,
  identity: RequestIdentity,
  helpers: LinearRouteHelpers,
): Promise<Response | null> {
  const env = rawEnv as unknown as LinearRouteEnv;
  const url = new URL(request.url);
  const projectMatch = url.pathname.match(
    /^\/v1\/projects\/([^/]+)\/linear\/connections$/,
  );
  if (projectMatch?.[1]) {
    const account = env.ACCOUNTS.getByName(identity.accountId);
    const project = await account.getProject(decodeURIComponent(projectMatch[1]));
    if (!project || (identity.projectId && identity.projectId !== project.id)) {
      return problem(404, "project_not_found", "Project not found");
    }
    if (request.method === "GET") {
      const environment = url.searchParams.get("environment");
      if (
        environment !== null &&
        environment !== "development" &&
        environment !== "production"
      ) {
        return problem(
          400,
          "invalid_environment",
          "environment must be development or production",
        );
      }
      return json({
        connections: await account.listLinearConnections(
          project.id,
          environment ?? undefined,
        ),
      });
    }
    if (request.method === "POST") {
      return createConnection(request, env, identity, project, helpers);
    }
    return problem(405, "method_not_allowed", "Unsupported Linear connection request");
  }

  const connectionMatch = url.pathname.match(
    /^\/v1\/linear\/connections\/([^/]+)(?:\/(credentials|authorize))?$/,
  );
  if (!connectionMatch?.[1]) return null;
  const connectionId = decodeURIComponent(connectionMatch[1]);
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const connection = isLinearConnectionId(connectionId)
    ? await account.getLinearConnection(connectionId)
    : null;
  if (
    !connection ||
    connection.status === "disconnected" ||
    (identity.projectId && identity.projectId !== connection.projectId)
  ) {
    return problem(404, "linear_connection_not_found", "Linear connection not found");
  }
  if (identity.projectId) {
    return problem(403, "forbidden", "Project tokens cannot manage Linear connections");
  }
  const action = connectionMatch[2];
  if (action === "credentials" && request.method === "PUT") {
    return putCredentials(request, account, connectionId);
  }
  if (action === "authorize" && request.method === "POST") {
    const nonce = oauthNonce();
    const issued = await account.issueLinearAuthorization(
      connectionId,
      await sha256Hex(nonce),
    );
    if (issued.outcome === "not_found") {
      return problem(404, "linear_connection_not_found", "Linear connection not found");
    }
    if (issued.outcome === "needs_credentials") {
      return problem(
        409,
        "linear_credentials_required",
        "Paste the app's client id, client secret and webhook signing secret before authorizing",
      );
    }
    return json({
      authorizeUrl: linearAuthorizeUrl({
        clientId: issued.clientId,
        redirectUri: issued.redirectUri,
        state: helpers.encodeOAuthState(identity.accountId, nonce),
      }),
      expiresAt: issued.expiresAt,
    });
  }
  if (!action && request.method === "DELETE") {
    // The route goes first: once it is gone nothing more is accepted for the
    // connection, even while Linear still delivers to the URL.
    await env.ACCOUNTS.getByName(linearRouteName(connectionId)).clearChannelRoute(
      connectionId,
    );
    const disconnected = await account.disconnectLinearConnection(connectionId);
    if (disconnected.outcome === "not_found") {
      return problem(404, "linear_connection_not_found", "Linear connection not found");
    }
    return json({ connection: disconnected.connection, revoked: disconnected.revoked });
  }
  return problem(405, "method_not_allowed", "Unsupported Linear connection request");
}

async function createConnection(
  request: Request,
  env: LinearRouteEnv,
  identity: RequestIdentity,
  project: Project,
  helpers: LinearRouteHelpers,
): Promise<Response> {
  if (identity.projectId) {
    return problem(403, "forbidden", "Project tokens cannot manage Linear connections");
  }
  if (project.archivedAt) {
    return problem(409, "project_archived", "Restore the project before starting new work");
  }
  const redirectUri = linearRedirectUri(env);
  if (!env.BLUE_CHANNEL_ENCRYPTION_KEY || !redirectUri) {
    return problem(
      503,
      "linear_connector_unavailable",
      "Linear connections are not configured",
    );
  }
  const body = await readBoundedJson(request, BODY_LIMIT);
  const environment = body?.environment;
  const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
  if (environment !== "development" && environment !== "production") {
    return problem(
      400,
      "invalid_environment",
      "environment must be development or production",
    );
  }
  if (!agentId || !helpers.projectOwnsAgent(project, agentId)) {
    return problem(400, "invalid_agent", "agentId must name an agent of this project");
  }
  const name = checkLinearAppName(body?.name);
  if (!name.ok) return problem(400, name.code, name.message);

  const webhookToken = newLinearWebhookToken();
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const created = await account.createLinearConnection({
    projectId: project.id,
    environment: environment as ProjectEnvironmentName,
    agentId,
    name: name.name,
    webhookToken,
    webhookOrigin: new URL(request.url).origin,
    redirectUri,
  });
  if (created.outcome === "bound") {
    return problem(
      409,
      "linear_already_connected",
      "This agent already has a Linear connection in this environment; disconnect it first",
      { connectionId: created.connection.id },
    );
  }
  const published = await env.ACCOUNTS.getByName(
    linearRouteName(created.connection.id),
  ).setChannelRoute({
    accountId: identity.accountId,
    connectionId: created.connection.id,
    webhookTokenHash: await sha256Hex(webhookToken),
    provider: "linear",
    revision: created.revision,
  });
  if (!published) {
    // A later create for the same binding already published a newer route;
    // this response's webhook URL would never be accepted.
    return problem(
      409,
      "linear_connection_changed",
      "The connection was changed by another request; list the connections and continue from there",
      { connectionId: created.connection.id },
    );
  }
  return json(
    {
      connectionId: created.connection.id,
      webhookUrl: created.connection.webhookUrl,
      createAppUrl: created.connection.createAppUrl,
      connection: created.connection,
    },
    created.outcome === "created" ? 201 : 200,
  );
}

async function putCredentials(
  request: Request,
  account: DurableObjectStub<AccountDurableObject>,
  connectionId: string,
): Promise<Response> {
  const body = await readBoundedJson(request, BODY_LIMIT);
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret =
    typeof body?.clientSecret === "string" ? body.clientSecret.trim() : "";
  const signingSecret =
    typeof body?.signingSecret === "string" ? body.signingSecret.trim() : "";
  if (
    !isLinearCredentialValue(clientId) ||
    !isLinearCredentialValue(clientSecret) ||
    !isLinearCredentialValue(signingSecret)
  ) {
    return problem(
      400,
      "invalid_linear_credentials",
      "Expected clientId, clientSecret and signingSecret as copied from the Linear app",
    );
  }
  const updated = await account.setLinearConnectionCredentials(connectionId, {
    clientId,
    clientSecret,
    signingSecret,
  });
  switch (updated.outcome) {
    case "updated":
      return json({ connection: updated.connection });
    case "not_found":
      return problem(404, "linear_connection_not_found", "Linear connection not found");
    case "client_in_use":
      return problem(
        409,
        "linear_app_already_connected",
        "This Linear app is already connected to another agent or environment; create a separate app for each",
      );
    case "connected_to_another_app":
      return problem(
        409,
        "linear_connection_connected",
        "This connection is authorized with a different Linear app; disconnect it first",
      );
    case "changed":
      return problem(
        409,
        "linear_connection_changed",
        "The connection changed while the credentials were saved; try again",
      );
  }
}

/**
 * Linear's OAuth redirect. Public: the state names the account and a nonce
 * that account claims exactly once. Redirects to the project's Connections
 * page when the dashboard URL is configured, else renders the shared page.
 */
export async function linearAuthorizationCallback(
  request: Request,
  rawEnv: Env,
  helpers: LinearRouteHelpers,
): Promise<Response> {
  const env = rawEnv as unknown as LinearRouteEnv;
  const url = new URL(request.url);
  const failed = () =>
    helpers.html(renderConnectionCallback({ provider: "Linear", status: "error" }), 400);
  const decoded = helpers.decodeOAuthState(url.searchParams.get("state") ?? "");
  if (!decoded) return failed();
  const account = env.ACCOUNTS.getByName(decoded.accountId);
  const completion = await account.completeLinearAuthorization({
    nonceHash: await sha256Hex(decoded.nonce),
    code: url.searchParams.get("code"),
    denied: url.searchParams.get("error") !== null,
  });
  if (completion.outcome === "missing") return failed();
  const appUrl = env.OPENCOMPUTER_APP_URL?.trim();
  if (!appUrl) {
    return helpers.html(
      renderConnectionCallback({
        provider: "Linear",
        status: completion.outcome === "connected" ? "success" : "error",
      }),
      completion.outcome === "connected" ? 200 : 400,
    );
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: linearReturnUrl(appUrl, completion.connection, completion.outcome),
      "cache-control": "no-store",
    },
  });
}

/** The dashboard location after authorization, in the shape of Slack's return URL. */
export function linearReturnUrl(
  appUrl: string,
  connection: { id: string; projectId: string; environment: ProjectEnvironmentName },
  result: LinearAuthorizationResult,
): string {
  const url = new URL(
    `/projects/${encodeURIComponent(connection.projectId)}/connections`,
    appUrl,
  );
  url.searchParams.set("environment", connection.environment);
  url.searchParams.set("linear", result);
  url.searchParams.set("connection", connection.id);
  return url.toString();
}

function oauthNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
