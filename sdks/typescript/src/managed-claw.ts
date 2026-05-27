export type ManagedClawSandboxTimeout = number | "never" | "persistent";

export interface ManagedClawOpts {
  apiKey?: string;
  apiUrl?: string;
  opencomputerApiKey?: string;
  fetch?: typeof fetch;
}

export interface ManagedClawFleet {
  id: string;
  name: string;
  instructions: string;
  model: string;
  runtime: {
    type: "opencomputer";
    image: string;
    sandboxTimeoutSeconds: number;
  };
  tools: {
    browser: boolean;
    filesystem: boolean;
    shell: boolean;
  };
  limits: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManagedClawFleetOpts {
  name: string;
  instructions?: string;
  model?: string;
  runtime?: {
    type?: "opencomputer";
    image?: string;
    sandboxTimeoutSeconds?: ManagedClawSandboxTimeout;
  };
  tools?: {
    browser?: boolean;
    filesystem?: boolean;
    shell?: boolean;
  };
  limits?: Record<string, unknown>;
}

export interface ManagedClawAgent {
  id: string;
  fleetId: string;
  endUserId: string;
  displayName: string;
  status: "creating" | "running" | "hibernated" | "error";
  sandboxId?: string;
  runtimeImage: string;
  sandboxTimeoutSeconds: number;
  gatewayToken?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedClawMessageResult {
  replyText: string;
  raw: unknown;
}

export interface GetOrCreateManagedClawAgentOpts {
  externalUserId: string;
  displayName?: string;
  fleetId: string;
}

interface ApiErrorBody {
  error?: { message?: string };
}

export class ManagedClawApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message = isApiErrorBody(body) && body.error?.message
      ? body.error.message
      : `Managed Claw API request failed with status ${status}`;
    super(message);
    this.name = "ManagedClawApiError";
    this.status = status;
    this.body = body;
  }
}

export class ManagedClaw {
  readonly fleets: ManagedClawFleetsClient;
  readonly agents: ManagedClawAgentsClient;

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly opencomputerApiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ManagedClawOpts = {}) {
    this.apiUrl = (opts.apiUrl ?? process.env.CLAWPUTER_API_URL ?? "http://localhost:8081").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.CLAWPUTER_API_KEY ?? "";
    this.opencomputerApiKey = opts.opencomputerApiKey ?? process.env.CLAWPUTER_OPENCOMPUTER_API_KEY ?? process.env.OPENCOMPUTER_API_KEY ?? "";
    this.fetchImpl = opts.fetch ?? fetch;
    this.fleets = new ManagedClawFleetsClient(this);
    this.agents = new ManagedClawAgentsClient(this);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.opencomputerApiKey) headers["x-opencomputer-api-key"] = this.opencomputerApiKey;

    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await readJson(res);
    if (!res.ok) throw new ManagedClawApiError(res.status, parsed);
    return parsed as T;
  }
}

export class ManagedClawFleetsClient {
  constructor(private readonly client: ManagedClaw) {}

  create(opts: CreateManagedClawFleetOpts): Promise<ManagedClawFleet> {
    return this.client.request<ManagedClawFleet>("POST", "/v1/fleets", opts);
  }

  get(fleetId: string): Promise<ManagedClawFleet> {
    return this.client.request<ManagedClawFleet>("GET", `/v1/fleets/${encodeURIComponent(fleetId)}`);
  }
}

export class ManagedClawAgentsClient {
  constructor(private readonly client: ManagedClaw) {}

  getOrCreate(opts: GetOrCreateManagedClawAgentOpts): Promise<ManagedClawAgent> {
    return this.client.request<ManagedClawAgent>("POST", "/v1/agents/get-or-create", opts);
  }

  get(agentId: string): Promise<ManagedClawAgent> {
    return this.client.request<ManagedClawAgent>("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  sendMessage(agentId: string, input: string): Promise<ManagedClawMessageResult> {
    return this.client.request<ManagedClawMessageResult>("POST", `/v1/agents/${encodeURIComponent(agentId)}/messages`, {
      input,
    });
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null && "error" in value;
}
