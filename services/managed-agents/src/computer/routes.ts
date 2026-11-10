// The computer's edge routes (work 052, "API contract").
//
// Dashboard routes, behind the opencomputer edge's assertion
// (authenticateRequest; organization = identity.accountId):
//   GET    /v1/computer                 → { computer, slack, github, plan }
//   POST   /v1/computer                 → same body; creates, wakes or retries the computer
//                                          (idempotent; not needed to start one: the Slack install does)
//   GET    /v1/computer/sessions        → { sessions }
//   POST   /v1/computer/slack/install   → { url }
//   DELETE /v1/computer/slack           → 204
//   PUT    /v1/computer/agent/claude    {token} → { agent, verified, via }   (work 081)
//   DELETE /v1/computer/agent/claude    → 204
//   POST   /v1/computer/agent/claude/resume → { agent }
//   PUT    /v1/computer/agent/codex     {authJson} → { agent }             (work 082)
//   DELETE /v1/computer/agent/codex     → 204
//   PUT    /v1/computer/agent/choice    {choice} → { agent }
//   POST   /v1/computer/agent/connect-code {purpose?} → { code, expiresAt } (work 082, CLI connect;
//                                                  purpose connect|link, work 083)
//   GET and POST /v1/computer also carry `agent`, the caller's (work 081).
//
// Provider and host routes, without the assertion (their own auth):
//   GET  /v1/computer/slack/callback               Slack OAuth; the install nonce is the auth
//   POST /v1/webhooks/computer/slack/events        Slack signature (v0, 5-minute window)
//   POST /v1/webhooks/computer/slack/interactivity Slack signature
//   GET  /v1/computer/host?organizationId=<id>     WebSocket; the organization's host token
//   POST /v1/computer/agent/connect                {code, provider, token | authJson} → { provider, connected }
//                                                  the connect code is the auth (connect-codes.ts)
//
// When the computer is created: on the Slack install (the OAuth callback's
// success), not on a visit to the page. GET answers `computer: null` until
// then. A Slack message for a linked organization with no computer creates
// one too (ensureAwake), as a safety net.
//
// Public responses never name the cloud, region, VM size or private host
// (002, forbidden vocabulary).

import { exchangeSlackOAuthCode } from "../channels/slack-api.js";
import { verifySlackSignature } from "../channels/slack-events.js";
import type { RequestIdentity } from "../edge/auth.js";
import { json, problem, readBoundedText } from "../edge/http.js";
import { AGENT_CHOICES, type AgentChoice, CODEX_AUTH_MAX_BYTES } from "./model-access.js";
import { CONNECT_CODE_INDEX_PREFIX, CONNECT_CODE_INVALID, connectCodeHash, connectCodeIndexName, logConnectCode, normalizeConnectCode } from "./connect-code-index.js";
import type { GitHubInstallation } from "../protocol.js";
import { type ComputerEdgeEnv, publicOrigin, slackRedirectUri } from "./config.js";
import { randomToken } from "./crypto.js";
import type { ComputerDurableObject, ComputerOverview } from "./durable-object.js";
import { isHarness } from "./harnesses.js";
import { bearerToken, hostAuthorized } from "./host-token.js";
import { POOL_OBJECT, isPoolId } from "./names.js";
import { apiRefusal, type ComputerApiStub, routeComputerApi } from "./api-http.js";
import { memberId } from "./session-ids.js";
import {
  decodeInstallState,
  encodeInstallState,
  parseInteraction,
  parseSlackEnvelope,
  slackAuthorizeUrl,
  slackTeamLinkName,
} from "./slack.js";
import { TEAM_ACCOUNT_TTL_MS, TeamAccountCache, type TeamLookup, coloTeamLinks } from "./team-cache.js";
import { interactionSpan, receivedMessage } from "./telemetry/routes.js";

type ComputerStub = DurableObjectStub<ComputerDurableObject>;

function computers(env: ComputerEdgeEnv): DurableObjectNamespace<ComputerDurableObject> | null {
  return (env.COMPUTERS as DurableObjectNamespace<ComputerDurableObject> | undefined) ?? null;
}

function computerOf(env: ComputerEdgeEnv, accountId: string): ComputerStub {
  return computers(env)!.getByName(accountId);
}

/**
 * The organization's managed model key was bound or deleted (work 058): its
 * computer refreshes its stored copy and sends the host fresh credentials.
 * No computers configured, or none for the organization: nothing. Never throws.
 */
export async function computerModelKeyChanged(env: ComputerEdgeEnv, accountId: string): Promise<void> {
  const namespace = computers(env);
  if (!namespace || reservedName(accountId)) return;
  try {
    await namespace.getByName(accountId).modelKeyChanged();
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "computer.model_key_push_failed", accountId, message: error instanceof Error ? error.message : "unknown" }));
  }
}

/** Names of ComputerDurableObjects that are not an organization's: the pool's slot table, Slack team links and connect code routing. */
function reservedName(name: string): boolean {
  return name === POOL_OBJECT || name.startsWith("computer-slack-team:") || name.startsWith(CONNECT_CODE_INDEX_PREFIX);
}

function teamLinkOf(env: ComputerEdgeEnv, teamId: string): ComputerStub {
  return computers(env)!.getByName(slackTeamLinkName(teamId));
}

/** The dashboard's `github`: the organization's managed installations (work 028). */
async function gitHubOf(env: ComputerEdgeEnv, accountId: string) {
  const account = env.ACCOUNTS.getByName(accountId) as unknown as {
    listGitHubInstallations(): Promise<GitHubInstallation[]>;
  };
  const installations = (await account.listGitHubInstallations())
    .filter((installation) => installation.state === "active")
    .map((installation) => ({ id: String(installation.id), accountLogin: installation.accountLogin }));
  return { connected: installations.length > 0, installations };
}

async function body(env: ComputerEdgeEnv, accountId: string, userId?: string, overview?: ComputerOverview) {
  const view = overview ?? (await computerOf(env, accountId).overview(accountId, userId));
  return {
    computer: view.computer,
    slack: view.slack,
    github: await gitHubOf(env, accountId),
    plan: view.plan,
    ...(view.agent ? { agent: view.agent } : {}),
  };
}

/** A setup token is at most ~430 bytes; the body has room for JSON around it and no more. */
const AGENT_BODY_MAX_BYTES = 4096;
/** An auth.json is capped at CODEX_AUTH_MAX_BYTES; sent as a JSON string its quotes are escaped, so twice that, and the envelope. */
const CODEX_BODY_MAX_BYTES = 2 * CODEX_AUTH_MAX_BYTES + 1024;

/** An agent route's JSON object body; 413 over the limit, `{}` when it is not a JSON object (each route then says what is missing). */
async function agentBody(request: Request, maxBytes = AGENT_BODY_MAX_BYTES): Promise<Record<string, unknown> | Response> {
  const text = await readBoundedText(request, maxBytes);
  if (text === null) return problem(413, "payload_too_large", "Request body is too large");
  try {
    const value: unknown = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The edge's `SyncedComputerKey`, checked. */
function syncedKeyOf(value: unknown): { id: string; hash: string; kind: "user" | "project"; scopes: string[]; expiresAt: string | null; userId: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const k = value as Record<string, unknown>;
  if (typeof k.id !== "string" || !k.id || typeof k.hash !== "string" || !/^[0-9a-f]{64}$/.test(k.hash)) return null;
  if (k.kind !== "user" && k.kind !== "project") return null;
  if (!Array.isArray(k.scopes) || !k.scopes.every((x) => typeof x === "string")) return null;
  if (k.expiresAt != null && typeof k.expiresAt !== "string") return null;
  if (k.userId != null && typeof k.userId !== "string") return null;
  return { id: k.id, hash: k.hash, kind: k.kind, scopes: k.scopes as string[], expiresAt: (k.expiresAt as string | null) ?? null, userId: (k.userId as string | null) ?? null };
}

function slackConfigured(env: ComputerEdgeEnv): boolean {
  return Boolean(
    env.SLACK_COMPUTER_CLIENT_ID &&
      env.SLACK_COMPUTER_CLIENT_SECRET &&
      env.SLACK_COMPUTER_SIGNING_SECRET &&
      env.SLACK_COMPUTER_SCOPES,
  );
}

/** Dashboard routes; null when the path is not one of them. */
export async function routeComputerDashboard(
  request: Request,
  env: ComputerEdgeEnv,
  identity: RequestIdentity,
  /** Keeps telemetry sends alive past the response (the Worker's `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/computer" && !url.pathname.startsWith("/v1/computer/")) return null;
  const route = `${request.method} ${url.pathname}`;
  // Work 084: the session API (api-http.ts). The opencomputer edge sets the surface header on
  // the routes of its computer mount only, and strips a client's.
  if (request.headers.get("x-opencomputer-surface") === "api") {
    if (identity.kind !== "user") return apiRefusal(request, 403, "forbidden", "Not a person's credential.");
    if (identity.projectId) return apiRefusal(request, 403, "forbidden", "Project keys cannot use sessions.", { reason: "project_key" });
    if (!computers(env)) return apiRefusal(request, 503, "unavailable", "Computers are not available yet.", { retryAfterMs: 60_000 });
    if (reservedName(identity.accountId) || isPoolId(identity.accountId)) return apiRefusal(request, 403, "forbidden", "Not an organization.");
    const stub = computerOf(env, identity.accountId) as unknown as ComputerApiStub;
    return routeComputerApi(request, env, identity, identity.accountId, stub, url.pathname.slice("/v1/computer".length), waitUntil);
  }
  // Work 084: the edge's API key events (opencomputer computer_keys.ts), asserted as the
  // organization; never from an API key or the session API's mount.
  if (route === "POST /v1/computer/keys/sync" || route === "POST /v1/computer/keys/revoke") {
    if (identity.kind !== "user" || identity.projectId || identity.apiKey) return problem(403, "forbidden", "Key events come from the edge");
    if (!computers(env)) return problem(503, "computer_not_configured", "Computers are not available yet");
    if (reservedName(identity.accountId) || isPoolId(identity.accountId)) return problem(403, "forbidden", "Not an organization");
    const input = await agentBody(request);
    if (input instanceof Response) return input;
    const computer = computerOf(env, identity.accountId);
    if (route === "POST /v1/computer/keys/revoke") {
      if (typeof input.keyId !== "string" || !input.keyId) return problem(400, "invalid_request", "keyId is required");
      return json({ revoked: await computer.keysRevoke(identity.accountId, input.keyId) });
    }
    const key = syncedKeyOf(input.key);
    if (!key) return problem(400, "invalid_request", "key is not a key");
    // The member is the asserted caller's; the body's userId may only repeat it.
    if (key.userId !== null && key.userId !== identity.userId) return problem(403, "forbidden", "key.userId is not the asserted user");
    await computer.keysSync(identity.accountId, { ...key, member: await memberId(identity.userId) });
    return new Response(null, { status: 204 });
  }
  const known = [
    "GET /v1/computer",
    "POST /v1/computer",
    "GET /v1/computer/sessions",
    "POST /v1/computer/slack/install",
    "DELETE /v1/computer/slack",
    "PUT /v1/computer/agent/claude",
    "DELETE /v1/computer/agent/claude",
    "POST /v1/computer/agent/claude/resume",
    "PUT /v1/computer/agent/codex",
    "DELETE /v1/computer/agent/codex",
    "PUT /v1/computer/agent/choice",
    "POST /v1/computer/agent/connect-code",
  ];
  if (!known.includes(route)) return null;
  if (identity.kind !== "user" || identity.projectId) {
    return problem(403, "forbidden", "The computer is managed from the dashboard");
  }
  if (!computers(env)) return problem(503, "computer_not_configured", "Computers are not available yet");
  const accountId = identity.accountId;
  // Pool computers and internal objects share the namespace with organizations.
  if (reservedName(accountId) || isPoolId(accountId)) return problem(403, "forbidden", "Not an organization");
  const computer = computerOf(env, accountId);

  if (route === "GET /v1/computer") return json(await body(env, accountId, identity.userId));

  // Work 081. The token is in the request body only: never logged, never echoed.
  if (route === "PUT /v1/computer/agent/claude") {
    const input = await agentBody(request);
    if (input instanceof Response) return input;
    const result = await computer.agentConnect(accountId, identity.userId, input.token);
    if (!result.ok) return problem(result.status, result.code, result.message);
    return json({ agent: result.agent, verified: result.verified, via: result.via });
  }
  if (route === "DELETE /v1/computer/agent/claude") {
    await computer.agentDisconnect(accountId, identity.userId);
    return new Response(null, { status: 204 });
  }
  if (route === "POST /v1/computer/agent/claude/resume") return json({ agent: await computer.agentResume(accountId, identity.userId) });
  // Work 082: the Codex CLI's auth.json, as a string or as the object itself. Never logged, never echoed.
  if (route === "PUT /v1/computer/agent/codex") {
    const input = await agentBody(request, CODEX_BODY_MAX_BYTES);
    if (input instanceof Response) return input;
    const authJson = input.authJson && typeof input.authJson === "object" ? JSON.stringify(input.authJson) : input.authJson;
    const result = await computer.agentConnectCodex(accountId, identity.userId, authJson);
    if (!result.ok) return problem(result.status, result.code, result.message);
    return json({ agent: result.agent });
  }
  if (route === "DELETE /v1/computer/agent/codex") {
    await computer.agentDisconnectCodex(accountId, identity.userId);
    return new Response(null, { status: 204 });
  }
  // Work 082, CLI connect: the code goes to the person's browser only; never logged. Work 083: or a link code.
  if (route === "POST /v1/computer/agent/connect-code") {
    const input = await agentBody(request);
    if (input instanceof Response) return input;
    const purpose = input.purpose ?? "connect";
    if (purpose !== "connect" && purpose !== "link") return problem(400, "invalid_request", "purpose must be connect or link");
    const result = await computer.agentConnectCode(accountId, identity.userId, purpose);
    if (!result.ok) return problem(result.status, result.code, result.message);
    return json({ code: result.code, expiresAt: new Date(result.expiresAt).toISOString() });
  }
  if (route === "PUT /v1/computer/agent/choice") {
    const input = await agentBody(request);
    if (input instanceof Response) return input;
    const choice = input.choice;
    if (typeof choice !== "string" || !(AGENT_CHOICES as readonly string[]).includes(choice)) {
      return problem(400, "invalid_request", "choice must be one of claude, codex, credits");
    }
    return json({ agent: await computer.agentChoose(accountId, identity.userId, choice as AgentChoice) });
  }

  if (route === "POST /v1/computer") {
    const reply = await computer.ensureComputer(accountId);
    if (reply.status === 503) {
      console.error(JSON.stringify({ level: "error", event: "computer.not_configured", message: reply.error }));
      return problem(503, "computer_not_configured", "Computers are not available yet");
    }
    if (reply.status === 409 && /being deleted/.test(reply.error ?? "")) {
      return problem(409, "computer_busy", "The computer is being deleted; try again when it is gone");
    }
    if (reply.status >= 400) {
      console.error(JSON.stringify({ level: "error", event: "computer.create_failed", status: reply.status, message: reply.error }));
      return problem(503, "computer_unavailable", "The computer cannot be started right now");
    }
    return json(await body(env, accountId, identity.userId), reply.status === 202 ? 202 : 200);
  }

  if (route === "GET /v1/computer/sessions") return json({ sessions: await computer.sessions(accountId) });

  if (route === "POST /v1/computer/slack/install") {
    if (!slackConfigured(env)) return problem(503, "computer_slack_not_configured", "The Slack app is not available yet");
    const nonce = randomToken();
    await computer.startSlackInstall(accountId, identity.userId, nonce);
    return json({
      url: slackAuthorizeUrl({
        clientId: env.SLACK_COMPUTER_CLIENT_ID!,
        scopes: env.SLACK_COMPUTER_SCOPES!,
        redirectUri: slackRedirectUri(env),
        state: encodeInstallState(accountId, nonce),
      }),
    });
  }

  // DELETE /v1/computer/slack: the bot token goes; the app stays installed in Slack until removed there.
  const { teamId } = await computer.unlinkSlack(accountId);
  if (!teamId) return problem(404, "computer_slack_not_installed", "No Slack workspace is linked");
  await releaseTeam(env, teamId, accountId);
  return new Response(null, { status: 204 });
}

/** Provider and host routes, reachable without the edge assertion; null when the path is not one of them. */
export async function routeComputerPublic(
  request: Request,
  env: ComputerEdgeEnv,
  context: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/computer/host" && request.method === "GET") return hostRoute(request, env, url);
  if (url.pathname === "/v1/computer/slack/callback" && request.method === "GET") return slackCallback(env, url, context);
  if (url.pathname === "/v1/webhooks/computer/slack/events" && request.method === "POST") {
    return slackEvents(request, env, context);
  }
  if (url.pathname === "/v1/webhooks/computer/slack/interactivity" && request.method === "POST") {
    return slackInteractivity(request, env, context);
  }
  if (url.pathname === "/v1/computer/agent/connect" && request.method === "POST") return connectWithCode(request, env);
  return null;
}

/**
 * POST /v1/computer/agent/connect (work 082, CLI connect): the CLI's login,
 * with the connect code the dashboard minted, stored as the dashboard's PUT
 * /agent/claude or /agent/codex would for the code's person. Every bad code
 * is the same 401, and so is a harness this computer can't run (the
 * authenticated routes' 409 would say which codes are live); the connect's
 * other refusals pass through. The answer says nothing about the person.
 * Neither the code nor the login is logged.
 */
async function connectWithCode(request: Request, env: ComputerEdgeEnv): Promise<Response> {
  const input = await agentBody(request, CODEX_BODY_MAX_BYTES);
  if (input instanceof Response) return input;
  const provider = input.provider;
  if (typeof input.code !== "string" || !isHarness(provider)) {
    return problem(400, "invalid_request", "code and provider (claude or codex) are required");
  }
  if (!computers(env)) return problem(503, "computer_not_configured", "Computers are not available yet");
  const invalid = () => problem(CONNECT_CODE_INVALID.status, CONNECT_CODE_INVALID.code, CONNECT_CODE_INVALID.message);
  const code = normalizeConnectCode(input.code);
  if (!code) {
    logConnectCode({ action: "refused", reason: "malformed", provider });
    return invalid();
  }
  const hash = await connectCodeHash(code);
  const accountId = await computers(env)!.getByName(connectCodeIndexName(hash)).connectCodeAccount(hash);
  if (!accountId || reservedName(accountId) || isPoolId(accountId)) {
    logConnectCode({ action: "refused", reason: "unknown", provider });
    return invalid();
  }
  const authJson = input.authJson && typeof input.authJson === "object" ? JSON.stringify(input.authJson) : input.authJson;
  const result = await computerOf(env, accountId).agentConnectWithCode(accountId, code, {
    provider,
    ...(provider === "claude" ? { token: input.token } : { authJson }),
  });
  if (!result.ok) return problem(result.status, result.code, result.message);
  return json({ provider: result.provider, connected: true });
}

async function hostRoute(request: Request, env: ComputerEdgeEnv, url: URL): Promise<Response> {
  const organizationId = url.searchParams.get("organizationId");
  // Pool computers (`pool-<random>`) connect here too, with their own derived token.
  if (!computers(env) || (organizationId !== null && reservedName(organizationId)) || !(await hostAuthorized(bearerToken(request), organizationId, env.COMPUTER_HOST_TOKEN_KEY))) {
    console.warn(JSON.stringify({ level: "warn", event: "computer.host_rejected", organizationId }));
    return problem(401, "unauthorized", "Host authentication required");
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return problem(426, "upgrade_required", "WebSocket upgrade required");
  }
  return computerOf(env, organizationId!).fetch(request);
}

function callbackRedirect(
  env: ComputerEdgeEnv,
  outcome: { ok: true } | { ok: false; reason: string; notified?: boolean },
): Response {
  const target = new URL(`${publicOrigin(env)}/computer`);
  if (outcome.ok) target.searchParams.set("slack", "connected");
  else {
    target.searchParams.set("slack", "error");
    target.searchParams.set("reason", outcome.reason);
    if (outcome.notified !== undefined) target.searchParams.set("notified", outcome.notified ? "1" : "0");
  }
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
}

/**
 * How long the callback waits for the install's computer before redirecting.
 * A warm claim answers in tens of milliseconds and a cold create only writes
 * a row and arms an alarm (the VM is built later, alarm-driven), so the page
 * normally lands on a computer already provisioning. Past this, the redirect
 * goes and the claim finishes in the background.
 */
const INSTALL_CLAIM_BUDGET_MS = 1_500;

async function slackCallback(env: ComputerEdgeEnv, url: URL, context: ExecutionContext): Promise<Response> {
  const fail = (reason: string) => callbackRedirect(env, { ok: false, reason });
  const slackError = url.searchParams.get("error");
  if (slackError) return fail(slackError === "access_denied" ? "access_denied" : "slack_error");
  const code = url.searchParams.get("code");
  const state = decodeInstallState(url.searchParams.get("state") ?? "");
  if (!code || !state) return fail("invalid_state");
  if (!computers(env) || !slackConfigured(env)) return fail("not_configured");
  const computer = computerOf(env, state.accountId);
  const consumed = await computer.consumeSlackInstall(state.accountId, state.nonce);
  if (!consumed.ok) return fail(consumed.reason);
  let grant;
  try {
    grant = await exchangeSlackOAuthCode({
      clientId: env.SLACK_COMPUTER_CLIENT_ID!,
      clientSecret: env.SLACK_COMPUTER_CLIENT_SECRET!,
      code,
      redirectUri: slackRedirectUri(env),
    });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "computer.slack_oauth_failed", message: error instanceof Error ? error.message : String(error) }));
    return fail("oauth_failed");
  }
  if (grant.isEnterpriseInstall) return fail("enterprise_install_unsupported");
  if (!grant.teamId || !grant.botUserId) return fail("oauth_failed");
  // One Slack workspace links to one organization. A holder whose app was
  // uninstalled (its token dead, with or without our hearing of it) no
  // longer holds it: the workspace is freed and this install takes it.
  let claim = await teamLinkOf(env, grant.teamId).claimTeam(grant.teamId, state.accountId);
  if (!claim.ok && (await releaseRevokedTeam(env, grant.teamId, claim.holder))) {
    claim = await teamLinkOf(env, grant.teamId).claimTeam(grant.teamId, state.accountId);
  }
  if (!claim.ok) {
    // Another organization has it: nothing links. Its object DMs the person
    // who tried and the person who linked it, with its own bot token (this
    // install's token is dropped unused). The redirect says only whether
    // someone was asked; never which organization.
    let installerNotified = false;
    if (grant.authedUserId) {
      try {
        ({ installerNotified } = await computerOf(env, claim.holder).notifyJoinRequest(claim.holder, {
          teamId: grant.teamId,
          requesterUserId: grant.authedUserId,
        }));
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "computer.slack_join_request_failed", message: error instanceof Error ? error.message : String(error) }));
      }
    }
    console.log(JSON.stringify({ level: "info", event: "computer.slack_team_already_linked", accountId: state.accountId, teamId: grant.teamId, installerNotified }));
    return callbackRedirect(env, { ok: false, reason: "team_already_linked", notified: installerNotified });
  }
  const { previousTeamId } = await computer.linkSlack(state.accountId, {
    teamId: grant.teamId,
    teamName: grant.teamName ?? grant.teamId,
    botUserId: grant.botUserId,
    botToken: grant.accessToken,
    ...(grant.authedUserId ? { installerUserId: grant.authedUserId } : {}),
    dashboardUserId: consumed.userId,
  });
  if (previousTeamId) await releaseTeam(env, previousTeamId, state.accountId);
  await teamAccounts.remember(grant.teamId, state.accountId);
  console.log(JSON.stringify({ level: "info", event: "computer.slack_linked", accountId: state.accountId, teamId: grant.teamId, by: consumed.userId }));
  await installComputer(computer, state.accountId, context);
  return callbackRedirect(env, { ok: true });
}

/**
 * Unlinks `holder` from `teamId` and frees the workspace when Slack says the
 * holder's bot token is dead. Whether it did; never throws.
 */
async function releaseRevokedTeam(env: ComputerEdgeEnv, teamId: string, holder: string): Promise<boolean> {
  try {
    const { unlinked } = await computerOf(env, holder).unlinkRevokedSlack(holder, teamId);
    if (!unlinked) return false;
    await releaseTeam(env, teamId, holder);
    console.log(JSON.stringify({ level: "info", event: "computer.slack_team_released", accountId: holder, teamId }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "computer.slack_release_failed", accountId: holder, teamId, message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

/**
 * The install is when the organization's computer comes alive: claimed from
 * the warm pool or created. Waits at most INSTALL_CLAIM_BUDGET_MS, then lets
 * it finish after the answer; never throws, so the redirect always goes.
 */
async function installComputer(computer: ComputerStub, accountId: string, context: ExecutionContext): Promise<void> {
  const failed = (message: string, status?: number) =>
    console.error(JSON.stringify({ level: "error", event: "computer.install_claim_failed", accountId, ...(status ? { status } : {}), message }));
  const claim = (async () => {
    try {
      const reply = await computer.ensureComputerOnInstall(accountId);
      if (!reply) return;
      if (reply.status >= 400) failed(reply.error ?? "unknown", reply.status);
      else console.log(JSON.stringify({ level: "info", event: "computer.install_claim", accountId, status: reply.status }));
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
    }
  })();
  context.waitUntil(claim);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([claim, new Promise<void>((resolve) => (timer = setTimeout(resolve, INSTALL_CLAIM_BUDGET_MS)))]);
  clearTimeout(timer);
}

/** Reads and verifies a Slack request; a Response when it must stop there. */
async function verifiedSlackBody(request: Request, env: ComputerEdgeEnv): Promise<string | Response> {
  if (!env.SLACK_COMPUTER_SIGNING_SECRET) return problem(503, "computer_slack_not_configured", "The Slack app is not available yet");
  const raw = await request.text();
  if (!(await verifySlackSignature(raw, request.headers, env.SLACK_COMPUTER_SIGNING_SECRET))) {
    return problem(401, "invalid_signature", "Invalid Slack signature");
  }
  return raw;
}

/** Workspace → organization (team-cache.ts): the isolate's memory, then the colo's cache, then the link object. */
const teamAccounts = new TeamAccountCache(TEAM_ACCOUNT_TTL_MS, Date.now, () =>
  typeof caches !== "undefined" && (caches as { default?: Cache }).default ? coloTeamLinks((caches as unknown as { default: Cache }).default) : null,
);

/** The organization a Slack workspace is linked to (null: none), and which cache answered. */
async function lookupTeam(env: ComputerEdgeEnv, teamId: string): Promise<TeamLookup> {
  if (!computers(env)) return { accountId: null, cached: null };
  return teamAccounts.get(teamId, () => teamLinkOf(env, teamId).teamAccount());
}

async function accountForTeam(env: ComputerEdgeEnv, teamId: string): Promise<string | null> {
  return (await lookupTeam(env, teamId)).accountId;
}

/** Releases a workspace's link and forgets it here. */
async function releaseTeam(env: ComputerEdgeEnv, teamId: string, accountId: string): Promise<void> {
  await teamAccounts.forget(teamId);
  await teamLinkOf(env, teamId).releaseTeam(accountId);
}

async function slackEvents(request: Request, env: ComputerEdgeEnv, context: ExecutionContext): Promise<Response> {
  const raw = await verifiedSlackBody(request, env);
  if (raw instanceof Response) return raw;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return problem(400, "invalid_json", "Invalid JSON");
  }
  const parsed = parseSlackEnvelope(payload);
  if (parsed.kind === "challenge") return json({ challenge: parsed.challenge });
  if (parsed.kind === "ignored") return json({ ok: true });
  // Slack wants an answer within three seconds: the work happens after it.
  const teamId = parsed.kind === "message" ? parsed.job.teamId : parsed.teamId;
  // Work 054: every message gets a trace here (`message.received`), carried to the host.
  const received = parsed.kind === "message" ? receivedMessage(env, request, parsed.job) : null;
  context.waitUntil(
    (async () => {
      const { accountId, cached } = await lookupTeam(env, teamId);
      received?.resolved(accountId, cached);
      if (received) context.waitUntil(received.t.done());
      if (!accountId) {
        console.warn(JSON.stringify({ level: "warn", event: "computer.slack_team_unlinked", teamId }));
        return;
      }
      if (parsed.kind === "revoked") {
        await releaseRevokedTeam(env, teamId, accountId);
        return;
      }
      const computer = computerOf(env, accountId);
      if (parsed.kind === "member-left") {
        await computer.slackMemberLeft(accountId, parsed.userId);
        return;
      }
      if (parsed.kind === "stop") {
        const interacted = interactionSpan(env, request, context, { teamId, channelId: parsed.channelId, accountId });
        await interacted("stop", computer.slackStop(accountId, parsed.channelId, parsed.threadTs));
      } else {
        const accepted = await computer.acceptSlackEvent(accountId, received ? { ...parsed.job, trace: received.trace } : parsed.job);
        // The organization is not linked to this workspace (any more): a cached link was stale.
        if (accepted.unlinked) await teamAccounts.forget(teamId);
      }
    })().catch((error) =>
      console.error(JSON.stringify({ level: "error", event: "computer.slack_event_failed", message: error instanceof Error ? error.message : String(error) })),
    ),
  );
  return json({ ok: true });
}

async function slackInteractivity(request: Request, env: ComputerEdgeEnv, context: ExecutionContext): Promise<Response> {
  const raw = await verifiedSlackBody(request, env);
  if (raw instanceof Response) return raw;
  const interaction = parseInteraction(raw);
  if (!interaction) return problem(400, "invalid_payload", "Missing Slack interaction payload");
  const teamId = interaction.team?.id;
  const accountId = teamId ? await accountForTeam(env, teamId) : null;
  if (!accountId) return new Response(null, { status: 200 });
  const userId = interaction.user?.id;
  const channelId = interaction.channel?.id ?? interaction.container?.channel_id;
  const interacted = interactionSpan(env, request, context, { teamId: teamId!, accountId, ...(userId ? { userId } : {}), ...(channelId ? { channelId } : {}) });
  const kind = interaction.type === "view_submission" || interaction.actions?.[0]?.action_id?.startsWith("s:") ? "secret" : "action";
  const work = interacted(kind, computerOf(env, accountId).slackInteraction(accountId, interaction));
  // A modal submission waits for its answer: errors keep the modal open. A
  // button opens a modal with a trigger that expires in three seconds.
  if (interaction.type === "view_submission" || interaction.trigger_id) {
    // The modal's answer (work 077 adds `view`: "checking" while a token is probed).
    const { errors, view } = (await work) as { errors?: Record<string, string>; view?: Record<string, unknown> };
    if (errors) return json({ response_action: "errors", errors });
    return view ? json({ response_action: "update", view }) : new Response(null, { status: 200 });
  }
  context.waitUntil(work.catch(() => {}));
  return new Response(null, { status: 200 });
}
