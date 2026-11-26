// The computer's edge routes (work 052, "API contract").
//
// Dashboard routes, behind the opencomputer edge's assertion
// (authenticateRequest; organization = identity.accountId):
//   GET    /v1/computer                 → { computer, slack, github, plan }
//   POST   /v1/computer                 → same body; creates, wakes or retries the computer
//                                          (idempotent; not needed to start one: the Slack install does)
//   GET    /v1/computer/sessions        → { sessions }
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

import type { RequestIdentity } from "../edge/auth.js";
import { json, problem, readBoundedText } from "../edge/http.js";
import { AGENT_CHOICES, type AgentChoice, CODEX_AUTH_MAX_BYTES } from "./model-access.js";
import { CONNECT_CODE_INDEX_PREFIX, CONNECT_CODE_INVALID, connectCodeHash, connectCodeIndexName, logConnectCode, normalizeConnectCode } from "./connect-code-index.js";
import type { GitHubInstallation } from "../protocol.js";
import { type ComputerEdgeEnv } from "./config.js";
import type { ComputerDurableObject, ComputerOverview } from "./durable-object.js";
import { isHarness } from "./harnesses.js";
import { bearerToken, hostAuthorized } from "./host-token.js";
import { POOL_OBJECT, isPoolId } from "../ids/computer-names.js";
import { liveOf } from "../actors/addresses.js";
import { apiRefusal, type ComputerApiStub, routeComputerApi } from "./api-http.js";
import { memberId } from "../ids/session-ids.js";

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

/** `POST /v1/internal/live/revoke {org, credentialId}`: from the edge only, never an API key or the session API's mount. */
async function liveRevoke(request: Request, env: ComputerEdgeEnv, identity: RequestIdentity): Promise<Response> {
  if (request.method !== "POST") return problem(405, "method_not_allowed", "POST only");
  // The edge asserts the organization with no user: `authenticateRequest` names that caller "opencomputer-edge".
  if (identity.kind !== "user" || identity.userId !== "opencomputer-edge" || identity.principal || identity.projectId || identity.apiKey) return problem(403, "forbidden", "Revocations come from the edge");
  const input = await agentBody(request);
  if (input instanceof Response) return input;
  if (input.org !== identity.accountId) return problem(403, "forbidden", "org is not the asserted organization");
  if (typeof input.credentialId !== "string" || !input.credentialId || input.credentialId.length > 200) return problem(400, "invalid_request", "credentialId is required");
  await liveOf(env, identity.accountId).revoke(input.credentialId);
  return new Response(null, { status: 204 });
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
  // A credential ended (spec 18.7): the edge, asserted as the organization, has its Live close the sockets it opened.
  if (url.pathname === "/v1/internal/live/revoke") return liveRevoke(request, env, identity);
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

  return null;
}

/** Provider and host routes, reachable without the edge assertion; null when the path is not one of them. */
export async function routeComputerPublic(
  request: Request,
  env: ComputerEdgeEnv,
  _context: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/computer/host" && request.method === "GET") return hostRoute(request, env, url);
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
