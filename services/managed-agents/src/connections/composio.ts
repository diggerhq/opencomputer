import type {
  ConnectionRequestInput,
  ConnectionRequestResult,
} from "../protocol.js";

const COMPOSIO_API = "https://backend.composio.dev";

const GOOGLE_TOOLKITS: Record<string, string> = {
  gmail: "gmail",
  calendar: "googlecalendar",
  drive: "googledrive",
  sheets: "googlesheets",
};

const DEFAULT_GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  // These must mirror what the pinned auth config actually grants. The value
  // is not what gets requested — an auth config id short-circuits that — but
  // it IS what the API reports to customers as the connection's scopes, and
  // Gmail already advertises gmail.readonly while granting full mailbox
  // access. Do not let these drift.
  drive: ["https://www.googleapis.com/auth/drive"],
  sheets: ["https://www.googleapis.com/auth/spreadsheets"],
};

export const GITHUB_SCOPES = ["repo"] as const;
export const LINEAR_SCOPES = [
  "read",
  "write",
  "issues:create",
  "comments:create",
] as const;

interface ComposioErrorBody {
  error?: {
    message?: string;
    suggested_fix?: string;
    errors?: string[];
  };
  message?: string;
}

interface ComposioAuthConfig {
  id: string;
  name?: string;
  status?: string;
  is_composio_managed?: boolean;
  toolkit?: {
    slug?: string;
  };
}

interface ComposioAuthConfigList {
  items?: ComposioAuthConfig[];
}

interface ComposioAuthConfigCreated {
  auth_config?: ComposioAuthConfig;
}

interface ComposioConnectedAccount {
  id: string;
  status: string;
  alias?: string;
  user_id?: string;
  toolkit?: {
    slug?: string;
  };
  auth_config?: {
    id?: string;
  };
  data?: Record<string, unknown>;
}

interface ComposioConnectedAccountList {
  items?: ComposioConnectedAccount[];
}

interface ComposioLink {
  redirect_url: string;
  expires_at?: string;
  connected_account_id?: string;
}

interface ComposioProxyResult {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export interface ComposioConnectionConfiguration {
  apiKey: string;
  authConfigId?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri?: string;
  callbackUrl?: string;
  appName?: string;
  scopes?: string[];
}

export interface ManagedConnectionLink {
  service: string;
  toolkit: string;
  scopes: string[];
  status: "connected" | "pending" | "disconnected";
  connectedAccountId?: string;
  displayName?: string;
  authorizationUrl?: string;
  expiresAt?: string;
}

function emailAddress(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ? value.trim()
    : undefined;
}

function connectedAccountDisplayName(
  account: ComposioConnectedAccount,
): string | undefined {
  const data = account.data;
  if (!data) return undefined;
  for (const key of ["email", "email_address", "emailAddress"]) {
    const email = emailAddress(data[key]);
    if (email) return email;
  }
  return undefined;
}

function proxiedGoogleDisplayName(
  service: string,
  result: ConnectionRequestResult,
): string | undefined {
  if (result.status < 200 || result.status >= 300 || !result.body) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(result.body) as unknown;
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (service === "gmail") return emailAddress(record.emailAddress);
  if (service !== "calendar" || !Array.isArray(record.items)) {
    return undefined;
  }
  for (const item of record.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const calendar = item as Record<string, unknown>;
    if (calendar.primary === true) {
      const email = emailAddress(calendar.id);
      if (email) return email;
    }
  }
  return undefined;
}

async function resolveConnectedAccountDisplayName(
  configuration: ComposioConnectionConfiguration,
  account: ComposioConnectedAccount,
  service: string,
): Promise<string | undefined> {
  const embedded = connectedAccountDisplayName(account);
  if (embedded) return embedded;
  return managedGoogleAccountDisplayName(
    configuration,
    account.id,
    service,
  );
}

export async function managedGoogleAccountDisplayName(
  configuration: ComposioConnectionConfiguration,
  connectedAccountId: string,
  service: string,
): Promise<string | undefined> {
  const path =
    service === "gmail"
      ? "/gmail/v1/users/me/profile"
      : service === "calendar"
        ? "/users/me/calendarList?minAccessRole=reader"
        : null;
  if (!path) return undefined;
  try {
    return proxiedGoogleDisplayName(
      service,
      await proxyManagedGoogleAccountRequest(configuration, connectedAccountId, {
        service,
        path,
      }),
    );
  } catch {
    // Account identity is presentation metadata and must not block auth.
    return undefined;
  }
}

interface ComposioConnectedAccountDeleteResult {
  success: boolean;
  revoke_job_id?: string;
}

function toolkitForGoogleService(service: string): string {
  const toolkit = GOOGLE_TOOLKITS[service.toLowerCase()];
  if (!toolkit) {
    throw new Error(`Google service ${service} is not supported`);
  }
  return toolkit;
}

function scopesForGoogleService(
  configuration: ComposioConnectionConfiguration,
  service: string,
): string[] {
  const scopes =
    configuration.scopes ?? DEFAULT_GOOGLE_SCOPES[service.toLowerCase()];
  if (!scopes?.length) {
    throw new Error(
      `Google ${service} does not have a configured OAuth scope profile`,
    );
  }
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

async function composioRequest<T>(
  configuration: ComposioConnectionConfiguration,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("x-api-key", configuration.apiKey);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`${COMPOSIO_API}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as T & ComposioErrorBody;
  if (!response.ok) {
    let message =
      body.error?.message ??
      body.message ??
      `Composio returned status ${String(response.status)}`;
    const validationErrors = body.error?.errors
      ?.map((error) => error.trim())
      .filter(Boolean);
    if (validationErrors?.length) {
      message = `${message}: ${validationErrors.join("; ")}`;
    }
    const fix = body.error?.suggested_fix;
    throw new Error(fix ? `${message}. ${fix}` : message);
  }
  return body;
}

async function scopeProfileName(
  configuration: ComposioConnectionConfiguration,
  service: string,
  scopes: string[],
): Promise<string> {
  const profileSource = [
    ...scopes,
    configuration.oauthClientId ?? "",
    configuration.oauthRedirectUri ?? "",
  ].join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(profileSource),
  );
  const profile = [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const serviceName =
    service.length > 0
      ? `${service[0]?.toUpperCase()}${service.slice(1)}`
      : service;
  return `${configuration.appName ?? "OpenComputer"} ${serviceName} ${profile}`;
}

function assertAuthConfig(
  authConfig: ComposioAuthConfig,
  toolkit: string,
): void {
  if (authConfig.status && authConfig.status !== "ENABLED") {
    throw new Error(`Composio auth config ${authConfig.id} is not enabled`);
  }
  if (
    authConfig.toolkit?.slug &&
    authConfig.toolkit.slug !== toolkit
  ) {
    throw new Error(
      `Composio auth config ${authConfig.id} belongs to ${authConfig.toolkit.slug}, not ${toolkit}`,
    );
  }
}

async function resolveAuthConfigId(
  configuration: ComposioConnectionConfiguration,
  service: string,
  toolkit: string,
  scopes: string[],
  create: boolean,
): Promise<string | undefined> {
  if (configuration.authConfigId) {
    const selected = await composioRequest<ComposioAuthConfig>(
      configuration,
      `/api/v3.1/auth_configs/${encodeURIComponent(configuration.authConfigId)}`,
    );
    assertAuthConfig(selected, toolkit);
    return selected.id;
  }

  const name = await scopeProfileName(configuration, service, scopes);
  const query = new URLSearchParams({
    toolkit_slug: toolkit,
    show_disabled: "false",
    search: name,
    limit: "50",
  });
  const existing = await composioRequest<ComposioAuthConfigList>(
    configuration,
    `/api/v3.1/auth_configs?${query.toString()}`,
  );
  const selected = (existing.items ?? []).find(
    (item) =>
      item.status === "ENABLED" &&
      item.name === name &&
      item.is_composio_managed === false,
  );
  if (selected) return selected.id;
  if (!create) return undefined;

  if (
    !configuration.oauthClientId ||
    !configuration.oauthClientSecret ||
    !configuration.oauthRedirectUri
  ) {
    throw new Error(
      "Gmail authentication is not configured. Provide an explicit " +
        "Composio-managed or custom auth config ID, or configure the Google " +
        "OAuth client ID, client secret, and first-party OAuth redirect URI.",
    );
  }
  const created = await composioRequest<ComposioAuthConfigCreated>(
    configuration,
    "/api/v3.1/auth_configs",
    {
      method: "POST",
      body: JSON.stringify({
        toolkit: { slug: toolkit },
        auth_config: {
          type: "use_custom_auth",
          auth_scheme: "OAUTH2",
          name,
          credentials: {
            client_id: configuration.oauthClientId,
            client_secret: configuration.oauthClientSecret,
            oauth_redirect_uri: configuration.oauthRedirectUri,
            scopes: scopes.join(","),
          },
          restrict_to_following_tools: [],
        },
      }),
    },
  );
  if (!created.auth_config?.id) {
    throw new Error(`Composio did not create an auth config for ${toolkit}`);
  }
  assertAuthConfig(created.auth_config, toolkit);
  return created.auth_config.id;
}

async function activeAccount(
  configuration: ComposioConnectionConfiguration,
  userId: string,
  toolkit: string,
  authConfigId: string,
): Promise<ComposioConnectedAccount | undefined> {
  const query = new URLSearchParams({
    limit: "10",
    order_by: "updated_at",
    order_direction: "desc",
  });
  query.append("user_ids", userId);
  query.append("toolkit_slugs", toolkit);
  query.append("statuses", "ACTIVE");
  query.append("auth_config_ids", authConfigId);
  const result = await composioRequest<ComposioConnectedAccountList>(
    configuration,
    `/api/v3.1/connected_accounts?${query.toString()}`,
  );
  return result.items?.find(
    (account) =>
      account.status === "ACTIVE" &&
      account.user_id === userId &&
      account.toolkit?.slug === toolkit &&
      (!account.auth_config?.id ||
        account.auth_config.id === authConfigId),
  );
}

export async function managedGoogleConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
  service: string,
): Promise<ManagedConnectionLink> {
  const toolkit = toolkitForGoogleService(service);
  const scopes = scopesForGoogleService(configuration, service);
  const authConfigId = await resolveAuthConfigId(
    configuration,
    service,
    toolkit,
    scopes,
    false,
  );
  const account = authConfigId
    ? await activeAccount(configuration, userId, toolkit, authConfigId)
    : undefined;
  return {
    service,
    toolkit,
    scopes,
    status: account ? "connected" : "pending",
    connectedAccountId: account?.id,
    displayName: account
      ? await resolveConnectedAccountDisplayName(
          configuration,
          account,
          service,
        )
      : undefined,
  };
}

export async function linkManagedGoogleConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
  service: string,
): Promise<ManagedConnectionLink> {
  const toolkit = toolkitForGoogleService(service);
  const scopes = scopesForGoogleService(configuration, service);
  const authConfigId = await resolveAuthConfigId(
    configuration,
    service,
    toolkit,
    scopes,
    true,
  );
  if (!authConfigId) {
    throw new Error(`No OAuth auth config exists for ${toolkit}`);
  }
  const account = await activeAccount(
    configuration,
    userId,
    toolkit,
    authConfigId,
  );
  if (account) {
    return {
      service,
      toolkit,
      scopes,
      status: "connected",
      connectedAccountId: account.id,
      displayName: await resolveConnectedAccountDisplayName(
        configuration,
        account,
        service,
      ),
    };
  }

  const linked = await composioRequest<ComposioLink>(
    configuration,
    "/api/v3/connected_accounts/link",
    {
      method: "POST",
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: userId,
        ...(configuration.callbackUrl
          ? { callback_url: configuration.callbackUrl }
          : {}),
      }),
    },
  );
  return {
    service,
    toolkit,
    scopes,
    status: "pending",
    authorizationUrl: linked.redirect_url,
    expiresAt: linked.expires_at,
    connectedAccountId: linked.connected_account_id,
  };
}

/**
 * Disconnect one account.
 *
 * `revoke` withdraws the user's consent at the provider, not just this record.
 * Google revokes per application, not per token, so every connected account
 * sharing that Google user and OAuth client dies with it — which silently
 * kills a person's other mailboxes. Only the caller knows whether this is the
 * last one, so only the caller may ask for it.
 */
export async function disconnectManagedGoogleConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
  service: string,
  options: { revoke?: boolean } = {},
): Promise<ManagedConnectionLink> {
  const toolkit = toolkitForGoogleService(service);
  const scopes = scopesForGoogleService(configuration, service);
  const authConfigId = await resolveAuthConfigId(
    configuration,
    service,
    toolkit,
    scopes,
    false,
  );
  const account = authConfigId
    ? await activeAccount(configuration, userId, toolkit, authConfigId)
    : undefined;
  if (!account) {
    return { service, toolkit, scopes, status: "disconnected" };
  }

  await composioRequest<ComposioConnectedAccountDeleteResult>(
    configuration,
    `/api/v3.1/connected_accounts/${encodeURIComponent(account.id)}` +
      (options.revoke ? "?revoke_on_delete=true" : ""),
    { method: "DELETE" },
  );
  return {
    service,
    toolkit,
    scopes,
    status: "disconnected",
    connectedAccountId: account.id,
  };
}

export async function proxyManagedGoogleRequest(
  configuration: ComposioConnectionConfiguration,
  userId: string,
  input: ConnectionRequestInput,
): Promise<ConnectionRequestResult> {
  const toolkit = toolkitForGoogleService(input.service);
  const scopes = scopesForGoogleService(configuration, input.service);
  const authConfigId = await resolveAuthConfigId(
    configuration,
    input.service,
    toolkit,
    scopes,
    false,
  );
  const account = authConfigId
    ? await activeAccount(configuration, userId, toolkit, authConfigId)
    : undefined;
  if (!account) {
    throw new Error(
      `Google ${input.service} is not connected with the required scope profile. ` +
        "Reconnect it to approve the current permissions.",
    );
  }
  return proxyManagedGoogleAccountRequest(configuration, account.id, input);
}

export async function proxyManagedGoogleAccountRequest(
  configuration: ComposioConnectionConfiguration,
  connectedAccountId: string,
  input: ConnectionRequestInput,
): Promise<ConnectionRequestResult> {
  toolkitForGoogleService(input.service);
  const method = (input.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    throw new Error(`HTTP method ${method} is not supported`);
  }
  const parameters = Object.entries(input.headers ?? {})
    .filter(
      ([name]) =>
        ![
          "authorization",
          "host",
          "content-length",
          "content-type",
        ].includes(name.toLowerCase()),
    )
    .map(([name, value]) => ({ name, value, type: "header" }));
  let body: unknown;
  if (input.body) {
    try {
      body = JSON.parse(input.body) as unknown;
    } catch {
      throw new Error("Composio proxy requests require a JSON body");
    }
  }
  const result = await composioRequest<ComposioProxyResult>(
    configuration,
    "/api/v3.1/tools/execute/proxy",
    {
      method: "POST",
      body: JSON.stringify({
        connected_account_id: connectedAccountId,
        endpoint: input.path,
        method,
        ...(body === undefined ? {} : { body }),
        ...(parameters.length === 0 ? {} : { parameters }),
      }),
    },
  );
  return {
    status: result.status,
    headers: result.headers ?? {},
    body:
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data ?? null),
  };
}

function githubPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\\")) {
    throw new Error("GitHub proxy paths must be relative API paths");
  }
  const url = new URL(path, "https://api.github.com");
  if (url.origin !== "https://api.github.com" || url.pathname.includes("..")) {
    throw new Error("GitHub proxy path is invalid");
  }
  const allowed = [
    /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/,
    /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/(?:reviews|comments|files)$/,
    /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
    /^\/repos\/[^/]+\/[^/]+\/git\/commits\/[0-9a-f]{40}$/i,
    /^\/repos\/[^/]+\/[^/]+\/git\/trees\/[0-9a-f]{40}$/i,
    /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/[0-9a-f]{40}$/i,
    /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/,
  ];
  if (!allowed.some((pattern) => pattern.test(url.pathname))) {
    throw new Error(`GitHub API path is not allowed: ${url.pathname}`);
  }
  if (url.pathname.includes("/contents/")) {
    const segments = url.pathname.split("/").slice(5);
    if (
      segments.length === 0 ||
      segments.some((segment) => {
        const decoded = decodeURIComponent(segment);
        return !decoded || decoded === "." || decoded === "..";
      }) ||
      [...url.searchParams.keys()].some((key) => key !== "ref") ||
      !/^[0-9a-f]{40}$/i.test(url.searchParams.get("ref") ?? "")
    ) {
      throw new Error("GitHub contents path or ref is invalid");
    }
  }
  return `${url.pathname}${url.search}`;
}

export async function managedGithubConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
): Promise<ManagedConnectionLink> {
  const authConfigId = await resolveAuthConfigId(
    configuration,
    "github",
    "github",
    [...GITHUB_SCOPES],
    false,
  );
  const account = authConfigId
    ? await activeAccount(configuration, userId, "github", authConfigId)
    : undefined;
  return {
    service: "github",
    toolkit: "github",
    scopes: [...GITHUB_SCOPES],
    status: account ? "connected" : "pending",
    connectedAccountId: account?.id,
  };
}

export async function linkManagedGithubConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
): Promise<ManagedConnectionLink> {
  const authConfigId = await resolveAuthConfigId(
    configuration,
    "github",
    "github",
    [...GITHUB_SCOPES],
    true,
  );
  if (!authConfigId) throw new Error("No OAuth auth config exists for github");
  const account = await activeAccount(
    configuration,
    userId,
    "github",
    authConfigId,
  );
  if (account) {
    return {
      service: "github",
      toolkit: "github",
      scopes: [...GITHUB_SCOPES],
      status: "connected",
      connectedAccountId: account.id,
    };
  }
  const linked = await composioRequest<ComposioLink>(
    configuration,
    "/api/v3/connected_accounts/link",
    {
      method: "POST",
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: userId,
        ...(configuration.callbackUrl
          ? { callback_url: configuration.callbackUrl }
          : {}),
      }),
    },
  );
  return {
    service: "github",
    toolkit: "github",
    scopes: [...GITHUB_SCOPES],
    status: "pending",
    authorizationUrl: linked.redirect_url,
    expiresAt: linked.expires_at,
    connectedAccountId: linked.connected_account_id,
  };
}

export async function disconnectManagedGithubConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
  options: { revoke?: boolean } = {},
): Promise<ManagedConnectionLink> {
  const authConfigId = await resolveAuthConfigId(
    configuration,
    "github",
    "github",
    [...GITHUB_SCOPES],
    false,
  );
  const account = authConfigId
    ? await activeAccount(configuration, userId, "github", authConfigId)
    : undefined;
  if (!account) {
    return {
      service: "github",
      toolkit: "github",
      scopes: [...GITHUB_SCOPES],
      status: "disconnected",
    };
  }
  await composioRequest<ComposioConnectedAccountDeleteResult>(
    configuration,
    `/api/v3.1/connected_accounts/${encodeURIComponent(account.id)}` +
      (options.revoke ? "?revoke_on_delete=true" : ""),
    { method: "DELETE" },
  );
  return {
    service: "github",
    toolkit: "github",
    scopes: [...GITHUB_SCOPES],
    status: "disconnected",
    connectedAccountId: account.id,
  };
}

export async function proxyManagedGithubAccountRequest(
  configuration: ComposioConnectionConfiguration,
  connectedAccountId: string,
  input: ConnectionRequestInput,
): Promise<ConnectionRequestResult> {
  const method = (input.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new Error("GitHub connections are read-only; only GET is allowed");
  }
  const endpoint = githubPath(input.path);
  const allowedHeaders = new Set(["accept", "x-github-api-version"]);
  const accept = Object.entries(input.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "accept",
  )?.[1];
  if (accept?.includes("application/vnd.github.v3.diff")) {
    const match = endpoint.match(
      /^(\/repos\/[^/]+\/[^/]+\/pulls\/\d+)$/,
    );
    if (!match?.[1]) throw new Error("GitHub diff path is invalid");
    const chunks: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await composioRequest<ComposioProxyResult>(
        configuration,
        "/api/v3.1/tools/execute/proxy",
        {
          method: "POST",
          body: JSON.stringify({
            connected_account_id: connectedAccountId,
            endpoint: `${match[1]}/files?per_page=100&page=${String(page)}`,
            method: "GET",
            parameters: [
              {
                name: "accept",
                value: "application/vnd.github+json",
                type: "header",
              },
            ],
          }),
        },
      );
      if (result.status < 200 || result.status >= 300) {
        return {
          status: result.status,
          headers: result.headers ?? {},
          body: JSON.stringify(result.data ?? null),
        };
      }
      if (!Array.isArray(result.data)) {
        throw new Error("GitHub changed-files response was invalid");
      }
      for (const value of result.data) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("GitHub changed-file record was invalid");
        }
        const file = value as Record<string, unknown>;
        if (typeof file.filename !== "string" || typeof file.patch !== "string") {
          throw new Error(
            "GitHub omitted a patch for a changed file; the complete diff is unavailable",
          );
        }
        const previous =
          typeof file.previous_filename === "string"
            ? file.previous_filename
            : file.filename;
        const before = file.status === "added" ? "/dev/null" : `a/${previous}`;
        const after = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
        chunks.push(
          `diff --git a/${previous} b/${file.filename}\n--- ${before}\n+++ ${after}\n${file.patch}`,
        );
      }
      if (result.data.length < 100) break;
      if (page === 10) throw new Error("GitHub changed-files pagination is incomplete");
    }
    const body = chunks.join("\n");
    if (body.length > 4_000_000) {
      throw new Error("GitHub diff exceeds the broker's 4 MB response limit");
    }
    return { status: 200, headers: {}, body };
  }
  const parameters = Object.entries(input.headers ?? {})
    .filter(([name]) => allowedHeaders.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value, type: "header" }));
  const result = await composioRequest<ComposioProxyResult>(
    configuration,
    "/api/v3.1/tools/execute/proxy",
    {
      method: "POST",
      body: JSON.stringify({
        connected_account_id: connectedAccountId,
        endpoint,
        method: "GET",
        ...(parameters.length === 0 ? {} : { parameters }),
      }),
    },
  );
  return {
    status: result.status,
    headers: result.headers ?? {},
    body:
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data ?? null),
  };
}

export async function managedLinearConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
): Promise<ManagedConnectionLink> {
  const authConfigId = await resolveAuthConfigId(
    configuration,
    "linear",
    "linear",
    [...LINEAR_SCOPES],
    false,
  );
  const account = authConfigId
    ? await activeAccount(configuration, userId, "linear", authConfigId)
    : undefined;
  return {
    service: "linear",
    toolkit: "linear",
    scopes: [...LINEAR_SCOPES],
    status: account ? "connected" : "pending",
    connectedAccountId: account?.id,
  };
}

export async function linkManagedLinearConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
): Promise<ManagedConnectionLink> {
  const authConfigId = await resolveAuthConfigId(
    configuration,
    "linear",
    "linear",
    [...LINEAR_SCOPES],
    true,
  );
  if (!authConfigId) throw new Error("No OAuth auth config exists for linear");
  const account = await activeAccount(
    configuration,
    userId,
    "linear",
    authConfigId,
  );
  if (account) {
    return {
      service: "linear",
      toolkit: "linear",
      scopes: [...LINEAR_SCOPES],
      status: "connected",
      connectedAccountId: account.id,
    };
  }
  const linked = await composioRequest<ComposioLink>(
    configuration,
    "/api/v3/connected_accounts/link",
    {
      method: "POST",
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: userId,
        ...(configuration.callbackUrl
          ? { callback_url: configuration.callbackUrl }
          : {}),
      }),
    },
  );
  return {
    service: "linear",
    toolkit: "linear",
    scopes: [...LINEAR_SCOPES],
    status: "pending",
    authorizationUrl: linked.redirect_url,
    expiresAt: linked.expires_at,
    connectedAccountId: linked.connected_account_id,
  };
}

export async function disconnectManagedLinearConnection(
  configuration: ComposioConnectionConfiguration,
  userId: string,
  options: { revoke?: boolean } = {},
): Promise<ManagedConnectionLink> {
  const authConfigId = await resolveAuthConfigId(
    configuration,
    "linear",
    "linear",
    [...LINEAR_SCOPES],
    false,
  );
  const account = authConfigId
    ? await activeAccount(configuration, userId, "linear", authConfigId)
    : undefined;
  if (!account) {
    return {
      service: "linear",
      toolkit: "linear",
      scopes: [...LINEAR_SCOPES],
      status: "disconnected",
    };
  }
  await composioRequest<ComposioConnectedAccountDeleteResult>(
    configuration,
    `/api/v3.1/connected_accounts/${encodeURIComponent(account.id)}` +
      (options.revoke ? "?revoke_on_delete=true" : ""),
    { method: "DELETE" },
  );
  return {
    service: "linear",
    toolkit: "linear",
    scopes: [...LINEAR_SCOPES],
    status: "disconnected",
    connectedAccountId: account.id,
  };
}

export async function proxyManagedLinearAccountRequest(
  configuration: ComposioConnectionConfiguration,
  connectedAccountId: string,
  input: ConnectionRequestInput,
): Promise<ConnectionRequestResult> {
  const method = (input.method ?? "POST").toUpperCase();
  if (method !== "POST") {
    throw new Error("Linear connections support only POST requests");
  }
  const url = new URL(input.path, "https://api.linear.app");
  if (
    !input.path.startsWith("/") ||
    input.path.includes("\\") ||
    url.origin !== "https://api.linear.app" ||
    url.pathname !== "/graphql" ||
    url.search
  ) {
    throw new Error("Linear connections allow only the /graphql endpoint");
  }
  let body: unknown;
  try {
    body = JSON.parse(input.body ?? "") as unknown;
  } catch {
    throw new Error("Linear GraphQL requests require a JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Linear GraphQL requests require a JSON object body");
  }
  const parameters = Object.entries(input.headers ?? {})
    .filter(([name]) => ["accept", "content-type"].includes(name.toLowerCase()))
    .map(([name, value]) => ({ name, value, type: "header" }));
  const result = await composioRequest<ComposioProxyResult>(
    configuration,
    "/api/v3.1/tools/execute/proxy",
    {
      method: "POST",
      body: JSON.stringify({
        connected_account_id: connectedAccountId,
        endpoint: "/graphql",
        method: "POST",
        body,
        ...(parameters.length === 0 ? {} : { parameters }),
      }),
    },
  );
  return {
    status: result.status,
    headers: result.headers ?? {},
    body:
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data ?? null),
  };
}
