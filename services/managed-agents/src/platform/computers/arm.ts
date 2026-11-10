// A minimal Azure Resource Manager client for the platform Worker (work 052,
// ported from dash-cal src/azure.ts). Client-credentials OAuth for the
// service principal scoped to the computers' resource group, and
// GET/PUT/PATCH/DELETE on management.azure.com. Request building is pure
// (tokenRequest, armRequest) so tests drive the client with a fake fetch.
//
// Cloud credentials live only in the platform Worker, as for MicroVMs; the
// edge reaches this through the platform service binding (routes.ts).
// Errors carry the HTTP status and ARM's own error code and message, never a
// token or the client secret.

export const ARM_ORIGIN = "https://management.azure.com";
export const LOGIN_ORIGIN = "https://login.microsoftonline.com";

/** api-versions per resource provider, pinned. */
export const API_VERSIONS = {
  /** Microsoft.Compute/virtualMachines: diskControllerType, deleteOption. */
  virtualMachines: "2024-07-01",
  /** Microsoft.Compute/disks: PremiumV2_LRS, online resize. */
  disks: "2024-03-02",
  /** Microsoft.Network/networkInterfaces. */
  networkInterfaces: "2024-05-01",
} as const;

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export type Fetch = (request: Request) => Promise<Response>;

/** An ARM (or token endpoint) call failed. `code` is ARM's error code when it sent one. */
export class ArmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArmError";
  }
}

export function tokenRequest(credentials: AzureCredentials): Request {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: `${ARM_ORIGIN}/.default`,
  });
  return new Request(
    `${LOGIN_ORIGIN}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
}

export type ArmMethod = "GET" | "PUT" | "PATCH" | "DELETE";

/** `path` is a resource id (`/subscriptions/…`); extra query parameters go in `query`. */
export function armRequest(
  method: ArmMethod,
  path: string,
  apiVersion: string,
  accessToken: string,
  body?: unknown,
  query: Record<string, string> = {},
): Request {
  if (!path.startsWith("/subscriptions/")) throw new Error(`not an ARM resource id: ${path}`);
  const url = new URL(`${ARM_ORIGIN}${path}`);
  url.searchParams.set("api-version", apiVersion);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** ARM's `{ error: { code, message } }` (or the token endpoint's `{ error, error_description }`). */
export async function armError(response: Response, what: string): Promise<ArmError> {
  let code = `Http${response.status}`;
  let message = "";
  try {
    const body = (await response.json()) as {
      error?: string | { code?: string; message?: string };
      error_description?: string;
    };
    if (typeof body.error === "string") {
      code = body.error;
      // The token endpoint's description carries trace ids, never the secret.
      message = body.error_description?.split("\r\n")[0] ?? "";
    } else if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? "";
    }
  } catch {
    // Not JSON: the status says enough.
  }
  return new ArmError(
    response.status,
    code,
    `${what}: ${response.status} ${code}${message ? `: ${message.slice(0, 500)}` : ""}`,
  );
}

const TOKEN_MARGIN_MS = 5 * 60_000;

/** Tokens per service principal, kept for the isolate's life. */
const tokenCache = new Map<string, { value: string; expiresAt: number }>();

export class AzureClient {
  constructor(
    private readonly credentials: AzureCredentials,
    private readonly fetcher: Fetch = (request) => fetch(request),
    private readonly now: () => number = Date.now,
    private readonly cache: Map<string, { value: string; expiresAt: number }> = tokenCache,
  ) {}

  /** A management-plane token, reused until five minutes before it expires. */
  async accessToken(): Promise<string> {
    const key = `${this.credentials.tenantId}/${this.credentials.clientId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.value;
    const response = await this.call(tokenRequest(this.credentials), "Azure sign-in");
    if (!response.ok) throw await armError(response, "Azure sign-in");
    const body = (await response.json()) as { access_token?: string; expires_in?: number | string };
    if (!body.access_token) {
      throw new ArmError(response.status, "NoAccessToken", "Azure sign-in: no access_token in response");
    }
    this.cache.set(key, {
      value: body.access_token,
      expiresAt: this.now() + Number(body.expires_in ?? 3600) * 1000,
    });
    return body.access_token;
  }

  /** The resource, or null when it does not exist. */
  async get(path: string, apiVersion: string, query: Record<string, string> = {}): Promise<ArmResource | null> {
    const response = await this.request("GET", path, apiVersion, undefined, query);
    if (response.status === 404) return null;
    return (await response.json()) as ArmResource;
  }

  async put(path: string, apiVersion: string, body: unknown): Promise<ArmResource> {
    return (await (await this.request("PUT", path, apiVersion, body)).json()) as ArmResource;
  }

  async patch(path: string, apiVersion: string, body: unknown): Promise<ArmResource> {
    return (await (await this.request("PATCH", path, apiVersion, body)).json()) as ArmResource;
  }

  /** Starts deleting; true if ARM accepted it, false if the resource was already gone. */
  async delete(path: string, apiVersion: string): Promise<boolean> {
    const response = await this.request("DELETE", path, apiVersion);
    return response.status !== 204 && response.status !== 404;
  }

  private async request(
    method: ArmMethod,
    path: string,
    apiVersion: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<Response> {
    const what = `${method} ${path.split("/providers/")[1] ?? path}`;
    const response = await this.call(
      armRequest(method, path, apiVersion, await this.accessToken(), body, query),
      what,
    );
    if (response.ok || (response.status === 404 && (method === "GET" || method === "DELETE"))) {
      return response;
    }
    if (response.status === 401) {
      this.cache.delete(`${this.credentials.tenantId}/${this.credentials.clientId}`);
    }
    throw await armError(response, what);
  }

  private async call(request: Request, what: string): Promise<Response> {
    try {
      return await this.fetcher(request);
    } catch (error) {
      throw new ArmError(0, "NetworkError", `${what}: ${error instanceof Error ? error.message : "network error"}`);
    }
  }
}

/** The fields of ARM resources the lifecycle reads. */
export interface ArmResource {
  id?: string;
  name?: string;
  tags?: Record<string, string>;
  properties?: {
    provisioningState?: string;
    diskSizeGB?: number;
    hardwareProfile?: { vmSize?: string };
    instanceView?: { statuses?: Array<{ code?: string; displayStatus?: string; message?: string }> };
  };
}
