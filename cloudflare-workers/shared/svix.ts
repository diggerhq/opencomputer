// Thin Svix REST client for the Cloudflare edge. Used by api-edge (webhook
// management: Application/Endpoint CRUD, secret, headers, test) and by
// events-ingest (delivery: message create with sync-before-ack). Mirrors the
// validated Go client in internal/svix (kept as throwaway discovery).
//
// Region is encoded in the token suffix (e.g. "sk_….us" → api.us.svix.com).
// See .agents/work/sandbox-webhooks-rearchitecture.md.

export function svixBaseURL(token: string): string {
  const i = token.lastIndexOf(".");
  if (i >= 0 && i < token.length - 1) {
    const region = token.slice(i + 1);
    if (region && region.length <= 4) return `https://api.${region}.svix.com`;
  }
  return "https://api.svix.com";
}

// SanitizeEventID maps an OC event id (which uses ':', e.g.
// "sb-x:sandbox.stopped") into Svix's eventId charset [A-Za-z0-9-_.] by
// replacing ':' with '.'. The raw id is still passed as the Idempotency-Key
// (header, unrestricted) for dedup.
export function sanitizeEventID(id: string): string {
  return id.replace(/:/g, ".");
}

export class SvixError extends Error {
  status: number;
  op: string;
  constructor(op: string, status: number, body: string) {
    super(`svix ${op}: HTTP ${status}: ${body}`);
    this.name = "SvixError";
    this.op = op;
    this.status = status;
  }
  // Transient: worth retrying (network=0, 429, or 5xx). 4xx is permanent.
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface Endpoint {
  id: string;
  url: string;
  description?: string;
  disabled?: boolean;
  filterTypes?: string[];
  channels?: string[];
  metadata?: Record<string, string>;
  createdAt?: string;
}

export interface EndpointParams {
  url: string;
  description?: string;
  filterTypes?: string[];
  channels?: string[];
  metadata?: Record<string, string>;
  disabled?: boolean;
  uid?: string;
}

export interface MessageParams {
  eventType: string;
  payload: unknown;
  eventId?: string; // sanitized to Svix charset
  channels?: string[];
  idempotencyKey?: string; // raw OC event id (header; dedups retries)
}

export class SvixClient {
  private token: string;
  private baseURL: string;

  constructor(token: string) {
    this.token = token;
    this.baseURL = svixBaseURL(token);
  }

  private async do<T>(
    op: string,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      ...(extraHeaders ?? {}),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let resp: Response;
    try {
      resp = await fetch(this.baseURL + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new SvixError(op, 0, e instanceof Error ? e.message : String(e));
    }
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new SvixError(op, resp.status, text);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // EnsureApplication creates (or returns, via get_if_exists) the org's app keyed
  // by uid. Idempotent; safe on every webhook create.
  async ensureApplication(uid: string, name: string): Promise<{ id: string; uid: string }> {
    return this.do("ensure_application", "POST", "/api/v1/app/?get_if_exists=true", { uid, name });
  }

  async createEndpoint(appID: string, p: EndpointParams): Promise<Endpoint> {
    return this.do("create_endpoint", "POST", `/api/v1/app/${appID}/endpoint/`, p);
  }

  async updateEndpoint(appID: string, epID: string, p: EndpointParams): Promise<Endpoint> {
    return this.do("update_endpoint", "PUT", `/api/v1/app/${appID}/endpoint/${epID}/`, p);
  }

  async getEndpoint(appID: string, epID: string): Promise<Endpoint> {
    return this.do("get_endpoint", "GET", `/api/v1/app/${appID}/endpoint/${epID}/`);
  }

  async listEndpoints(appID: string): Promise<Endpoint[]> {
    const out = await this.do<{ data: Endpoint[] }>(
      "list_endpoints",
      "GET",
      `/api/v1/app/${appID}/endpoint/?limit=250`,
    );
    return out?.data ?? [];
  }

  async deleteEndpoint(appID: string, epID: string): Promise<void> {
    await this.do("delete_endpoint", "DELETE", `/api/v1/app/${appID}/endpoint/${epID}/`);
  }

  // Signing secret (whsec_…).
  async getEndpointSecret(appID: string, epID: string): Promise<string> {
    const out = await this.do<{ key: string }>(
      "get_endpoint_secret",
      "GET",
      `/api/v1/app/${appID}/endpoint/${epID}/secret/`,
    );
    return out.key;
  }

  // Custom headers delivered on every request to the endpoint — how
  // per-destination registration metadata rides each delivery.
  async setEndpointHeaders(appID: string, epID: string, headers: Record<string, string>): Promise<void> {
    await this.do("set_endpoint_headers", "PUT", `/api/v1/app/${appID}/endpoint/${epID}/headers/`, {
      headers,
    });
  }

  // CreateMessage sends an event to the org's app; Svix fans it out to matching
  // endpoints. idempotencyKey makes retries safe (same key → same message).
  async createMessage(appID: string, m: MessageParams): Promise<{ id: string; eventId?: string }> {
    const body: Record<string, unknown> = { eventType: m.eventType, payload: m.payload };
    if (m.eventId) body.eventId = sanitizeEventID(m.eventId);
    if (m.channels && m.channels.length) body.channels = m.channels;
    const hdrs = m.idempotencyKey ? { "idempotency-key": m.idempotencyKey } : undefined;
    return this.do("create_message", "POST", `/api/v1/app/${appID}/msg/`, body, hdrs);
  }
}
