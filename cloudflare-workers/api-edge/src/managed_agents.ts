export interface ManagedAgentsEnv {
  MANAGED_AGENTS_API_URL?: string;
  OC_MANAGED_AGENTS_SECRET?: string;
}

export interface ManagedAgentsCaller {
  orgID: string;
  userID: string | null;
}

const DEFAULT_MANAGED_AGENTS_API_URL = "https://managedagents.opencomputer.dev";
const MAX_AGENT_SOURCE_BYTES = 10 * 1024 * 1024;

function b64url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let encoded = "";
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return btoa(encoded)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function mintManagedAgentsAssertion(
  secret: string,
  caller: ManagedAgentsCaller,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: "opencomputer-edge",
    aud: "managedagents",
    sub: caller.orgID,
    org_id: caller.orgID,
    iat: now,
    exp: now + 120,
  };
  if (caller.userID) payload.user_id = caller.userID;
  const encoder = new TextEncoder();
  const signingInput =
    `${b64url(encoder.encode(JSON.stringify(header)))}.` +
    b64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${b64url(signature)}`;
}

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "idempotency-key",
    "last-event-id",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-request-id", crypto.randomUUID());
  return headers;
}

async function publicErrorResponse(upstream: Response): Promise<Response> {
  const body: unknown = await upstream.json().catch(() => null);
  const backendError =
    body &&
    typeof body === "object" &&
    "error" in body &&
    (body as { error?: unknown }).error &&
    typeof (body as { error: unknown }).error === "object"
      ? (body as { error: Record<string, unknown> }).error
      : null;
  const backendCode =
    typeof backendError?.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(backendError.code)
      ? backendError.code
      : "agent_request_failed";
  let message = "The agent request could not be completed.";
  if (upstream.status === 400) {
    message =
      backendCode === "invalid_agent_name"
        ? "Agent names must use lowercase letters, numbers, and hyphens."
        : "The agent request was invalid.";
  } else if (upstream.status === 401 || upstream.status === 403) {
    message = "The agent request was not authorized.";
  } else if (upstream.status === 404) {
    message = "The requested agent resource was not found.";
  } else if (upstream.status === 409) {
    message = "The agent request conflicts with the current state.";
  } else if (upstream.status === 429) {
    message = "Too many agent requests. Try again shortly.";
  } else if (upstream.status >= 500) {
    message = "The agent service is temporarily unavailable.";
  }
  const headers = new Headers({ "content-type": "application/json" });
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(
    JSON.stringify({ error: { code: backendCode, message } }),
    { status: upstream.status, headers },
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function publicDeployment(value: unknown): Record<string, unknown> {
  const deployment = record(value) ?? {};
  return {
    id: deployment.id,
    agentId: deployment.agentId,
    alias: deployment.alias,
    channels: strings(deployment.channels),
    connections: strings(deployment.connections),
    createdAt: deployment.createdAt,
  };
}

function publicProject(value: unknown): Record<string, unknown> {
  const project = record(value) ?? {};
  const agentId =
    typeof project.agentId === "string" ? project.agentId : undefined;
  const agents = Array.isArray(project.agents)
    ? project.agents.flatMap((value) => {
        const agent = record(value);
        return agent && typeof agent.id === "string"
          ? [
              {
                id: agent.id,
                name: typeof agent.name === "string" ? agent.name : agent.id,
              },
            ]
          : [];
      })
    : agentId
      ? [
          {
            id: agentId,
            name: `Hello ${typeof project.name === "string" ? project.name : agentId}`.slice(
              0,
              80,
            ),
          },
        ]
      : [];
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    environments: Array.isArray(project.environments)
      ? stripPrivateValues(project.environments)
      : [],
    agents,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function publicConnection(value: unknown): Record<string, unknown> {
  const connection = record(value) ?? {};
  return {
    id: connection.id,
    kind: connection.kind,
    provider: connection.provider,
    label: connection.label,
    agentId: connection.agentId,
    alias: connection.alias,
    displayName: connection.displayName,
    scopes: strings(connection.scopes),
    status: connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function publicChannel(value: unknown): Record<string, unknown> {
  const channel = record(value) ?? {};
  return {
    id: channel.id,
    channel: "slack",
    agentId: channel.agentId,
    alias: channel.alias,
    appName: channel.appName,
    appId: channel.appId,
    teamName: channel.teamName,
    verifiedAt: channel.verifiedAt,
    verificationError: channel.verificationError,
    status: channel.status,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function stripPrivateValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateValues);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !PRIVATE_EVENT_KEYS.has(key))
      .map(([key, child]) => [key, stripPrivateValues(child)]),
  );
}

const PRIVATE_EVENT_KEYS = new Set([
  "accountId",
  "account_id",
  "ownerUserId",
  "owner_user_id",
  "userId",
  "user_id",
  "artifact",
  "bucket",
  "imageArn",
  "image_arn",
  "imageVersion",
  "image_version",
  "microvmId",
  "microvm_id",
  "runtimeId",
  "runtime_id",
  "runtimeToken",
  "runtime_token",
]);

function publicEventData(
  type: string,
  value: unknown,
): Record<string, unknown> {
  if (type.startsWith("runtime.")) return {};
  if (type === "session.failed" || type === "turn.failed") {
    return { message: "The agent could not complete this request." };
  }
  const data = record(value) ?? {};
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !PRIVATE_EVENT_KEYS.has(key)),
  );
}

function publicSuccessBody(
  method: string,
  suffix: string,
  value: unknown,
): unknown {
  const body = record(value) ?? {};
  if (method === "GET" && suffix === "/agents") {
    return {
      agents: Array.isArray(body.agents)
        ? body.agents.map((value) => {
            const agent = record(value) ?? {};
            return {
              id: agent.id,
              name:
                typeof agent.name === "string" && agent.name
                  ? agent.name
                  : agent.id,
              activeAlias: agent.activeAlias,
              activeDeploymentId: agent.activeDeploymentId,
              deploymentCount: agent.deploymentCount,
              createdAt: agent.createdAt,
              updatedAt: agent.updatedAt,
            };
          })
        : [],
    };
  }
  if (method === "GET" && suffix === "/projects") {
    return {
      projects: Array.isArray(body.projects)
        ? body.projects.map(publicProject)
        : [],
    };
  }
  if (method === "POST" && suffix === "/projects") {
    return publicProject(body);
  }
  if (method === "GET" && /^\/projects\/[^/]+$/.test(suffix)) {
    const project = publicProject(body.project);
    return {
      project,
      sessions: stripPrivateValues(body.sessions ?? []),
      deployments: Array.isArray(body.deployments)
        ? body.deployments.map(publicDeployment)
        : [],
      connections: Array.isArray(body.connections)
        ? body.connections.map(publicConnection)
        : [],
      channels: Array.isArray(body.channels)
        ? body.channels.map(publicChannel)
        : [],
      schedules: stripPrivateValues(body.schedules ?? []),
      files: stripPrivateValues(body.files ?? []),
      schema: stripPrivateValues(body.schema ?? {}),
    };
  }
  if (method === "GET" && suffix === "/me") {
    return stripPrivateValues(body);
  }
  if (method === "POST" && suffix === "/deployments") {
    return publicDeployment(body);
  }
  if (method === "POST" && suffix === "/benchmarks/warm-pool") {
    return stripPrivateValues(body);
  }
  if (method === "POST" && suffix === "/channel-connections/claim") {
    return {
      authorizationUrl: body.authorizationUrl,
      expiresAt: body.expiresAt,
      status: body.status,
    };
  }
  if (method === "GET" && suffix === "/deployments") {
    return {
      deployments: Array.isArray(body.deployments)
        ? body.deployments.map(publicDeployment)
        : [],
    };
  }
  if (method === "GET" && /^\/deployments\/[^/]+$/.test(suffix)) {
    return publicDeployment(body);
  }
  if (method === "GET" && suffix === "/connections") {
    return {
      connections: Array.isArray(body.connections)
        ? body.connections.map(publicConnection)
        : [],
    };
  }
  if (method === "GET" && suffix === "/channels") {
    return {
      channels: Array.isArray(body.connections)
        ? body.connections.map(publicChannel)
        : [],
    };
  }
  if (method === "POST" && suffix === "/channels/slack/connections") {
    return {
      connection: publicChannel(body.connection),
      manifest: stripPrivateValues(body.manifest),
      createUrl: body.createUrl,
      steps: strings(body.steps),
    };
  }
  if (
    (method === "PUT" || method === "DELETE") &&
    /^\/channels\/slack\/connections\/[^/]+$/.test(suffix)
  ) {
    return publicChannel(body);
  }
  if (
    (method === "GET" && suffix.startsWith("/connections")) ||
    (method === "POST" && suffix.startsWith("/connections")) ||
    (method === "PUT" && suffix.startsWith("/connections")) ||
    (method === "DELETE" && suffix.startsWith("/connections")) ||
    (method === "GET" && suffix.startsWith("/channels")) ||
    (method === "POST" && suffix.startsWith("/channels")) ||
    (method === "PUT" && suffix.startsWith("/channels")) ||
    (method === "DELETE" && suffix.startsWith("/channels"))
  ) {
    return stripPrivateValues(body);
  }
  if (method === "POST" && suffix === "/sessions") {
    const session = record(body.session) ?? {};
    return {
      session: {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
      },
      deployment: body.deployment
        ? publicDeployment(body.deployment)
        : undefined,
    };
  }
  if (method === "GET" && /^\/sessions\/[^/]+\/events$/.test(suffix)) {
    return {
      events: Array.isArray(body.events)
        ? body.events.map((value) => {
            const event = record(value) ?? {};
            const type = typeof event.type === "string" ? event.type : "";
            return {
              id: event.id,
              seq: event.seq,
              timestamp: event.timestamp,
              sessionId: event.sessionId,
              turnId: event.turnId,
              type,
              data: publicEventData(type, event.data),
            };
          })
        : [],
    };
  }
  if (method === "POST" && /\/turns$/.test(suffix)) {
    return {
      turnId: body.turnId,
      status: body.status,
      duplicate: body.duplicate,
    };
  }
  if (method === "POST" && /\/suspend$/.test(suffix)) {
    return {
      id: body.id,
      status: body.status,
      updatedAt: body.updatedAt,
    };
  }
  if (
    (method === "GET" && /^\/sessions(?:\/[^/]+)?$/.test(suffix)) ||
    (method === "POST" &&
      /^\/sessions\/[^/]+\/(resume|end|terminate)$/.test(suffix))
  ) {
    return stripPrivateValues(body);
  }
  throw new Error("Unsupported managed agents response");
}

async function publicSuccessResponse(
  upstream: Response,
  method: string,
  suffix: string,
): Promise<Response> {
  const value: unknown = await upstream.json();
  const headers = new Headers({ "content-type": "application/json" });
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  return new Response(
    JSON.stringify(publicSuccessBody(method, suffix, value)),
    {
      status: upstream.status,
      headers,
    },
  );
}

function invalidDeploymentResponse(message: string): Response {
  return Response.json(
    { error: { code: "invalid_deployment", message } },
    { status: 400 },
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function deploySourceAgent(
  request: Request,
  base: string,
  upstreamHeaders: Headers,
): Promise<Response> {
  const body = record(await request.json().catch(() => null));
  const source = record(body?.source);
  if (
    !body ||
    typeof body.agentId !== "string" ||
    typeof body.alias !== "string" ||
    !source ||
    typeof source.digest !== "string" ||
    typeof source.size !== "number" ||
    typeof source.contentType !== "string" ||
    typeof source.body !== "string"
  ) {
    return invalidDeploymentResponse("The agent deployment was invalid.");
  }
  const bytes = new TextEncoder().encode(source.body);
  if (
    bytes.byteLength !== source.size ||
    bytes.byteLength > MAX_AGENT_SOURCE_BYTES ||
    (await sha256Hex(bytes)) !== source.digest
  ) {
    return invalidDeploymentResponse(
      "The agent source size or digest did not match.",
    );
  }

  const uploadHeaders = new Headers(upstreamHeaders);
  uploadHeaders.set("content-type", "application/json");
  const uploadResponse = await fetch(`${base}/v1/deployment-uploads`, {
    method: "POST",
    headers: uploadHeaders,
    body: JSON.stringify({
      agentId: body.agentId,
      digest: source.digest,
      size: source.size,
      contentType: source.contentType,
    }),
    redirect: "manual",
  });
  if (!uploadResponse.ok) return publicErrorResponse(uploadResponse);
  const upload = record(await uploadResponse.json().catch(() => null));
  const artifact = record(upload?.artifact);
  const uploadURL =
    typeof upload?.uploadUrl === "string" ? new URL(upload.uploadUrl) : null;
  if (
    !uploadURL ||
    uploadURL.protocol !== "https:" ||
    upload?.method !== "PUT" ||
    !artifact
  ) {
    return Response.json(
      { error: "managed agents service is unavailable" },
      { status: 502 },
    );
  }
  const stored = await fetch(uploadURL, {
    method: "PUT",
    headers: { "content-type": source.contentType },
    body: bytes,
    redirect: "manual",
  });
  if (!stored.ok) {
    return Response.json(
      { error: "managed agents service is unavailable" },
      { status: 502 },
    );
  }

  const deploymentResponse = await fetch(`${base}/v1/deployments`, {
    method: "POST",
    headers: uploadHeaders,
    body: JSON.stringify({
      agentId: body.agentId,
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : body.agentId,
      alias: body.alias,
      channels: strings(body.channels),
      connections: strings(body.connections),
      artifact,
    }),
    redirect: "manual",
  });
  if (!deploymentResponse.ok) {
    return publicErrorResponse(deploymentResponse);
  }
  return publicSuccessResponse(deploymentResponse, "POST", "/deployments");
}

function isAllowedManagedAgentsRoute(method: string, suffix: string): boolean {
  if (method === "GET" && suffix === "/agents") return true;
  if (method === "GET" && suffix === "/me") return true;
  if ((method === "GET" || method === "POST") && suffix === "/projects") {
    return true;
  }
  if (method === "GET" && /^\/projects\/[^/]+$/.test(suffix)) return true;
  if (method === "POST" && suffix === "/deployments") return true;
  if (method === "POST" && suffix === "/benchmarks/warm-pool") return true;
  if (method === "POST" && suffix === "/channel-connections/claim") {
    return true;
  }
  if (method === "GET" && suffix === "/deployments") return true;
  if (method === "GET" && /^\/deployments\/[^/]+$/.test(suffix)) return true;
  if (
    (method === "GET" &&
      (/^\/connections(?:\/.*)?$/.test(suffix) ||
        /^\/channels(?:\/.*)?$/.test(suffix))) ||
    ((method === "POST" || method === "PUT" || method === "DELETE") &&
      (/^\/connections(?:\/.*)?$/.test(suffix) ||
        /^\/channels(?:\/.*)?$/.test(suffix)))
  )
    return true;
  if (suffix.startsWith("/openrouter/")) return true;
  if (method === "POST" && suffix === "/sessions") return true;
  if (method === "GET" && suffix === "/sessions") return true;
  if (method === "GET" && /^\/sessions\/[^/]+$/.test(suffix)) return true;
  if (method === "GET" && /^\/sessions\/[^/]+\/events$/.test(suffix)) {
    return true;
  }
  return (
    method === "POST" &&
    /^\/sessions\/[^/]+\/(turns|suspend|resume|end|terminate)$/.test(suffix)
  );
}

function channelConnectionPage(
  action: string,
  status: number,
  error?: string,
): Response {
  const message = error
    ? `<p role="alert">${error}</p>`
    : `<p>Continue to securely connect an account to this agent in Slack.</p>
       <form method="post" action="${action}">
         <button type="submit">Continue</button>
       </form>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect account · OpenComputer</title><style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:2rem;color:#171717}h1{font-size:1.7rem}p{line-height:1.55;color:#555}button{font:inherit;background:#171717;color:#fff;border:0;border-radius:8px;padding:.8rem 1.2rem;cursor:pointer}</style></head><body><h1>Connect account</h1>${message}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}

export async function handleManagedAgentChannelConnection(
  request: Request,
  env: ManagedAgentsEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/api\/managed-agents\/channel-connections\/([^/]+)\/([a-f0-9]{32})$/i,
  );
  if (!match) {
    return channelConnectionPage(
      url.pathname,
      404,
      "This connection link is invalid.",
    );
  }
  const accountId = decodeURIComponent(match[1]);
  const token = match[2];
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(accountId)) {
    return channelConnectionPage(
      url.pathname,
      404,
      "This connection link is invalid.",
    );
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const response = channelConnectionPage(url.pathname, 200);
    return request.method === "HEAD"
      ? new Response(null, {
          status: response.status,
          headers: response.headers,
        })
      : response;
  }
  if (request.method !== "POST") {
    return channelConnectionPage(
      url.pathname,
      405,
      "This request is not supported.",
    );
  }
  const internal = new Request(
    new URL("/api/managed-agents/channel-connections/claim", url.origin),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    },
  );
  const response = await proxyManagedAgents(
    internal,
    env,
    { orgID: accountId, userID: null },
    "/api/managed-agents",
  );
  if (!response.ok) {
    return channelConnectionPage(
      url.pathname,
      response.status === 404 ? 404 : 502,
      response.status === 404
        ? "This connection link has expired or was already used. Ask the agent for a new one."
        : "OpenComputer could not start the connection. Please try again.",
    );
  }
  const body = record(await response.json().catch(() => null));
  if (body?.status === "connected") {
    return channelConnectionPage(
      url.pathname,
      200,
      "This account is already connected. You can return to Slack.",
    );
  }
  let authorizationUrl: URL | null = null;
  if (typeof body?.authorizationUrl === "string") {
    try {
      authorizationUrl = new URL(body.authorizationUrl);
    } catch {
      authorizationUrl = null;
    }
  }
  if (!authorizationUrl || authorizationUrl.protocol !== "https:") {
    return channelConnectionPage(
      url.pathname,
      502,
      "OpenComputer could not start the connection. Please try again.",
    );
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: authorizationUrl.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function proxyManagedAgents(
  request: Request,
  env: ManagedAgentsEnv,
  caller: ManagedAgentsCaller,
  publicPrefix: string,
): Promise<Response> {
  const requestURL = new URL(request.url);
  const requestedSuffix = requestURL.pathname.slice(publicPrefix.length);
  const suffix =
    requestedSuffix === "/v1"
      ? ""
      : requestedSuffix.startsWith("/v1/")
        ? requestedSuffix.slice(3)
        : requestedSuffix;
  if (
    requestURL.pathname !== publicPrefix &&
    !requestURL.pathname.startsWith(`${publicPrefix}/`)
  ) {
    return Response.json({ error: "route not found" }, { status: 404 });
  }
  if (!isAllowedManagedAgentsRoute(request.method.toUpperCase(), suffix)) {
    return Response.json({ error: "route not found" }, { status: 404 });
  }
  if (!env.OC_MANAGED_AGENTS_SECRET) {
    return Response.json(
      { error: "managed agents are not configured" },
      { status: 503 },
    );
  }
  const base = (
    env.MANAGED_AGENTS_API_URL ?? DEFAULT_MANAGED_AGENTS_API_URL
  ).replace(/\/+$/, "");
  const target = new URL(`${base}/v1${suffix}${requestURL.search}`);
  if (target.protocol !== "https:" && target.hostname !== "localhost") {
    return Response.json(
      { error: "managed agents upstream must use HTTPS" },
      { status: 503 },
    );
  }
  const headers = copyRequestHeaders(request);
  headers.set(
    "x-opencomputer-agent-token",
    await mintManagedAgentsAssertion(env.OC_MANAGED_AGENTS_SECRET, caller),
  );
  if (request.method.toUpperCase() === "POST" && suffix === "/deployments") {
    try {
      return await deploySourceAgent(request, base, headers);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "managed_agents.deployment_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json(
        { error: "managed agents service is unavailable" },
        { status: 502 },
      );
    }
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  try {
    const upstream = await fetch(target, init);
    if (!upstream.ok) return publicErrorResponse(upstream);
    if (suffix.startsWith("/openrouter/")) {
      return upstream;
    }
    return publicSuccessResponse(
      upstream,
      request.method.toUpperCase(),
      suffix,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "managed_agents.upstream_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json(
      { error: "managed agents service is unavailable" },
      { status: 502 },
    );
  }
}
