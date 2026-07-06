const DEFAULT_BROWSER_API_URL = "https://browser.opencomputer.dev";

function resolveBrowserApiUrl(url?: string): string {
  return (url || process.env.OPENCOMPUTER_BROWSER_API_URL || DEFAULT_BROWSER_API_URL).replace(/\/+$/, "");
}

export interface BrowserCreateOpts {
  apiKey?: string;
  apiUrl?: string;
  name?: string;
  tags?: Record<string, string>;
  stealth?: boolean;
  headless?: boolean;
  gpu?: boolean;
  timeoutSeconds?: number;
  profile?: { id?: string; name?: string; saveChanges?: boolean };
  extensions?: Array<{ id?: string; name?: string }>;
  proxyId?: string;
  viewport?: { width: number; height: number; refreshRate?: number };
  kioskMode?: boolean;
  startUrl?: string;
  chromePolicy?: Record<string, unknown>;
  telemetry?: Record<string, unknown> | null;
}

export interface BrowserData {
  id: string;
  provider: "kernel";
  provider_session_id: string;
  status: string;
  cdp_ws_url: string;
  webdriver_ws_url: string;
  live_view_url?: string | null;
  base_url?: string | null;
  headless?: boolean;
  stealth?: boolean;
  gpu?: boolean;
  timeout_seconds?: number;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface BrowserProfileCreateOpts {
  apiKey?: string;
  apiUrl?: string;
  name?: string;
}

export interface BrowserProfileData {
  id: string;
  provider: "kernel";
  provider_profile_id: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  provider_created_at?: string;
  provider_updated_at?: string;
  provider_last_used_at?: string;
}

export type BrowserRunStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "expired";
export type BrowserStepMode = "helper" | "raw_playwright" | "rawPlaywright";

export interface BrowserWorkflowStep {
  id: string;
  mode?: BrowserStepMode;
  task?: string;
  script?: string;
  input?: Record<string, unknown>;
}

export interface BrowserWorkflowJob {
  needs?: string[];
  browser?: Record<string, unknown>;
  saveProfile?: boolean;
  closeBrowser?: boolean;
  steps: BrowserWorkflowStep[];
}

export interface BrowserWorkflowDefinition {
  name?: string;
  description?: string;
  concurrency?: "sequential" | "parallel";
  jobs: Record<string, BrowserWorkflowJob>;
}

export interface BrowserWorkflowData {
  id: string;
  name: string;
  description?: string | null;
  definition: BrowserWorkflowDefinition;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface BrowserRunData {
  id: string;
  type?: "workflow" | "single";
  workflow_id?: string | null;
  workflow_version?: number | null;
  status: BrowserRunStatus;
  concurrency?: "sequential" | "parallel";
  input?: Record<string, unknown>;
  definition?: BrowserWorkflowDefinition;
  output?: unknown;
  error?: unknown;
  trigger_run_id?: string | null;
  jobs?: Array<Record<string, unknown>>;
  steps?: Array<Record<string, unknown>>;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  canceled_at?: string | null;
}

export interface BrowserRunCreateOpts {
  apiKey?: string;
  apiUrl?: string;
  name?: string;
  browser?: Record<string, unknown>;
  mode?: BrowserStepMode;
  task?: string;
  script?: string;
  input?: Record<string, unknown>;
  saveProfile?: boolean;
  closeBrowser?: boolean;
}

export interface BrowserWorkflowCreateOpts extends BrowserWorkflowDefinition {
  apiKey?: string;
  apiUrl?: string;
}

export interface BrowserWorkflowRunCreateOpts {
  apiKey?: string;
  apiUrl?: string;
  workflowId?: string;
  workflow?: BrowserWorkflowDefinition;
  input?: Record<string, unknown>;
}

export interface BrowserWaitOpts {
  intervalMs?: number;
  timeoutMs?: number;
}

export class Browser {
  readonly id: string;
  readonly provider: "kernel";
  readonly providerSessionId: string;
  readonly status: string;
  readonly cdpWsUrl: string;
  readonly webdriverWsUrl: string;
  readonly liveViewUrl: string | null;
  readonly baseUrl: string | null;
  readonly headless?: boolean;
  readonly stealth?: boolean;
  readonly gpu?: boolean;
  readonly timeoutSeconds?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;

  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(data: BrowserData, apiUrl: string, apiKey: string) {
    this.id = data.id;
    this.provider = data.provider;
    this.providerSessionId = data.provider_session_id;
    this.status = data.status;
    this.cdpWsUrl = data.cdp_ws_url;
    this.webdriverWsUrl = data.webdriver_ws_url;
    this.liveViewUrl = data.live_view_url ?? null;
    this.baseUrl = data.base_url ?? null;
    this.headless = data.headless;
    this.stealth = data.stealth;
    this.gpu = data.gpu;
    this.timeoutSeconds = data.timeout_seconds;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.deletedAt = data.deleted_at;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  static async create(opts: BrowserCreateOpts = {}): Promise<Browser> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/browsers`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(toCreateBody(opts)),
    });
    if (!resp.ok) {
      throw await browserError(resp, "create browser");
    }
    return new Browser(await resp.json() as BrowserData, apiUrl, apiKey);
  }

  static async connect(id: string, opts: { apiKey?: string; apiUrl?: string } = {}): Promise<Browser> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/browsers/${encodeURIComponent(id)}`, {
      headers: headers(apiKey),
    });
    if (!resp.ok) {
      throw await browserError(resp, "connect browser");
    }
    return new Browser(await resp.json() as BrowserData, apiUrl, apiKey);
  }

  async delete(): Promise<void> {
    const resp = await fetch(`${this.apiUrl}/v1/browsers/${encodeURIComponent(this.id)}`, {
      method: "DELETE",
      headers: headers(this.apiKey),
    });
    if (!resp.ok) {
      throw await browserError(resp, "delete browser");
    }
  }
}

export class BrowserProfile {
  readonly id: string;
  readonly provider: "kernel";
  readonly providerProfileId: string;
  readonly name: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;
  readonly providerCreatedAt?: string;
  readonly providerUpdatedAt?: string;
  readonly providerLastUsedAt?: string;

  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(data: BrowserProfileData, apiUrl: string, apiKey: string) {
    this.id = data.id;
    this.provider = data.provider;
    this.providerProfileId = data.provider_profile_id;
    this.name = data.name ?? null;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.deletedAt = data.deleted_at;
    this.providerCreatedAt = data.provider_created_at;
    this.providerUpdatedAt = data.provider_updated_at;
    this.providerLastUsedAt = data.provider_last_used_at;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  static async create(opts: BrowserProfileCreateOpts = {}): Promise<BrowserProfile> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    const resp = await fetch(`${apiUrl}/v1/profiles`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw await browserError(resp, "create browser profile");
    }
    return new BrowserProfile(await resp.json() as BrowserProfileData, apiUrl, apiKey);
  }

  static async list(opts: { apiKey?: string; apiUrl?: string } = {}): Promise<BrowserProfile[]> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/profiles`, {
      headers: headers(apiKey),
    });
    if (!resp.ok) {
      throw await browserError(resp, "list browser profiles");
    }
    const data = await resp.json() as { profiles: BrowserProfileData[] };
    return (data.profiles ?? []).map((profile) => new BrowserProfile(profile, apiUrl, apiKey));
  }

  static async connect(idOrName: string, opts: { apiKey?: string; apiUrl?: string } = {}): Promise<BrowserProfile> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/profiles/${encodeURIComponent(idOrName)}`, {
      headers: headers(apiKey),
    });
    if (!resp.ok) {
      throw await browserError(resp, "connect browser profile");
    }
    return new BrowserProfile(await resp.json() as BrowserProfileData, apiUrl, apiKey);
  }

  async delete(): Promise<void> {
    const resp = await fetch(`${this.apiUrl}/v1/profiles/${encodeURIComponent(this.id)}`, {
      method: "DELETE",
      headers: headers(this.apiKey),
    });
    if (!resp.ok) {
      throw await browserError(resp, "delete browser profile");
    }
  }
}

export class BrowserRun {
  readonly id: string;
  readonly type: "workflow" | "single";
  readonly workflowId: string | null;
  readonly status: BrowserRunStatus;
  readonly concurrency?: "sequential" | "parallel";
  readonly input: Record<string, unknown>;
  readonly definition?: BrowserWorkflowDefinition;
  readonly output: unknown;
  readonly error: unknown;
  readonly triggerRunId: string | null;
  readonly jobs: Array<Record<string, unknown>>;
  readonly steps: Array<Record<string, unknown>>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly canceledAt?: string | null;

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly endpoint: "browser-runs" | "browser-workflow-runs";

  constructor(data: BrowserRunData, apiUrl: string, apiKey: string, endpoint?: "browser-runs" | "browser-workflow-runs") {
    this.id = data.id;
    this.type = data.type ?? (this.id.startsWith("brun_") ? "single" : "workflow");
    this.workflowId = data.workflow_id ?? null;
    this.status = data.status;
    this.concurrency = data.concurrency;
    this.input = data.input ?? {};
    this.definition = data.definition;
    this.output = data.output;
    this.error = data.error;
    this.triggerRunId = data.trigger_run_id ?? null;
    this.jobs = data.jobs ?? [];
    this.steps = data.steps ?? [];
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.startedAt = data.started_at;
    this.finishedAt = data.finished_at;
    this.canceledAt = data.canceled_at;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.endpoint = endpoint ?? (this.type === "single" ? "browser-runs" : "browser-workflow-runs");
  }

  static async create(opts: BrowserRunCreateOpts = {}): Promise<BrowserRun> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/browser-runs`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(runCreateBody(opts)),
    });
    if (!resp.ok) throw await browserError(resp, "create browser run");
    return new BrowserRun(await resp.json() as BrowserRunData, apiUrl, apiKey, "browser-runs");
  }

  static async connect(id: string, opts: { apiKey?: string; apiUrl?: string } = {}): Promise<BrowserRun> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const endpoint = id.startsWith("brun_") ? "browser-runs" : "browser-workflow-runs";
    const resp = await fetch(`${apiUrl}/v1/${endpoint}/${encodeURIComponent(id)}`, {
      headers: headers(apiKey),
    });
    if (!resp.ok) throw await browserError(resp, "connect browser run");
    return new BrowserRun(await resp.json() as BrowserRunData, apiUrl, apiKey, endpoint);
  }

  async refresh(): Promise<BrowserRun> {
    return BrowserRun.connect(this.id, { apiUrl: this.apiUrl, apiKey: this.apiKey });
  }

  async wait(opts: BrowserWaitOpts = {}): Promise<BrowserRun> {
    const intervalMs = opts.intervalMs ?? 1000;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    let current: BrowserRun = this;
    while (!["completed", "failed", "canceled", "expired"].includes(current.status)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for browser run ${this.id}`);
      await sleep(intervalMs);
      current = await current.refresh();
    }
    return current;
  }

  async cancel(): Promise<BrowserRun> {
    const endpoint = this.endpoint;
    const resp = await fetch(`${this.apiUrl}/v1/${endpoint}/${encodeURIComponent(this.id)}/cancel`, {
      method: "POST",
      headers: headers(this.apiKey),
    });
    if (!resp.ok) throw await browserError(resp, "cancel browser run");
    return new BrowserRun(await resp.json() as BrowserRunData, this.apiUrl, this.apiKey, endpoint);
  }
}

export class BrowserWorkflow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly definition: BrowserWorkflowDefinition;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;

  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(data: BrowserWorkflowData, apiUrl: string, apiKey: string) {
    this.id = data.id;
    this.name = data.name;
    this.description = data.description ?? null;
    this.definition = data.definition;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.deletedAt = data.deleted_at;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  static async create(opts: BrowserWorkflowCreateOpts): Promise<BrowserWorkflow> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/browser-workflows`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(workflowCreateBody(opts)),
    });
    if (!resp.ok) throw await browserError(resp, "create browser workflow");
    return new BrowserWorkflow(await resp.json() as BrowserWorkflowData, apiUrl, apiKey);
  }

  static async list(opts: { apiKey?: string; apiUrl?: string } = {}): Promise<BrowserWorkflow[]> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/browser-workflows`, { headers: headers(apiKey) });
    if (!resp.ok) throw await browserError(resp, "list browser workflows");
    const data = await resp.json() as { workflows: BrowserWorkflowData[] };
    return (data.workflows ?? []).map((workflow) => new BrowserWorkflow(workflow, apiUrl, apiKey));
  }

  static async connect(id: string, opts: { apiKey?: string; apiUrl?: string } = {}): Promise<BrowserWorkflow> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const resp = await fetch(`${apiUrl}/v1/browser-workflows/${encodeURIComponent(id)}`, { headers: headers(apiKey) });
    if (!resp.ok) throw await browserError(resp, "connect browser workflow");
    return new BrowserWorkflow(await resp.json() as BrowserWorkflowData, apiUrl, apiKey);
  }

  async update(opts: Partial<BrowserWorkflowDefinition>): Promise<BrowserWorkflow> {
    const resp = await fetch(`${this.apiUrl}/v1/browser-workflows/${encodeURIComponent(this.id)}`, {
      method: "PATCH",
      headers: headers(this.apiKey),
      body: JSON.stringify(opts),
    });
    if (!resp.ok) throw await browserError(resp, "update browser workflow");
    return new BrowserWorkflow(await resp.json() as BrowserWorkflowData, this.apiUrl, this.apiKey);
  }

  async delete(): Promise<void> {
    const resp = await fetch(`${this.apiUrl}/v1/browser-workflows/${encodeURIComponent(this.id)}`, {
      method: "DELETE",
      headers: headers(this.apiKey),
    });
    if (!resp.ok) throw await browserError(resp, "delete browser workflow");
  }

  async run(opts: Omit<BrowserWorkflowRunCreateOpts, "workflowId" | "workflow"> = {}): Promise<BrowserRun> {
    return BrowserWorkflowRun.create({ ...opts, workflowId: this.id, apiUrl: this.apiUrl, apiKey: this.apiKey });
  }
}

export class BrowserWorkflowRun {
  static async create(opts: BrowserWorkflowRunCreateOpts): Promise<BrowserRun> {
    const apiUrl = resolveBrowserApiUrl(opts.apiUrl);
    const apiKey = opts.apiKey || process.env.OPENCOMPUTER_API_KEY || "";
    const body: Record<string, unknown> = {};
    if (opts.workflowId !== undefined) body.workflowId = opts.workflowId;
    if (opts.workflow !== undefined) body.workflow = opts.workflow;
    if (opts.input !== undefined) body.input = opts.input;
    const resp = await fetch(`${apiUrl}/v1/browser-workflow-runs`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw await browserError(resp, "create browser workflow run");
    return new BrowserRun(await resp.json() as BrowserRunData, apiUrl, apiKey, "browser-workflow-runs");
  }

  static async connect(id: string, opts: { apiKey?: string; apiUrl?: string } = {}): Promise<BrowserRun> {
    return BrowserRun.connect(id, opts);
  }
}

function headers(apiKey: string): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h["X-API-Key"] = apiKey;
  return h;
}

function toCreateBody(opts: BrowserCreateOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.tags !== undefined) body.tags = opts.tags;
  if (opts.stealth !== undefined) body.stealth = opts.stealth;
  if (opts.headless !== undefined) body.headless = opts.headless;
  if (opts.gpu !== undefined) body.gpu = opts.gpu;
  if (opts.timeoutSeconds !== undefined) body.timeout_seconds = opts.timeoutSeconds;
  if (opts.profile !== undefined) {
    body.profile = {
      ...(opts.profile.id !== undefined ? { id: opts.profile.id } : {}),
      ...(opts.profile.name !== undefined ? { name: opts.profile.name } : {}),
      ...(opts.profile.saveChanges !== undefined ? { save_changes: opts.profile.saveChanges } : {}),
    };
  }
  if (opts.extensions !== undefined) body.extensions = opts.extensions;
  if (opts.proxyId !== undefined) body.proxy_id = opts.proxyId;
  if (opts.viewport !== undefined) {
    body.viewport = {
      width: opts.viewport.width,
      height: opts.viewport.height,
      ...(opts.viewport.refreshRate !== undefined ? { refresh_rate: opts.viewport.refreshRate } : {}),
    };
  }
  if (opts.kioskMode !== undefined) body.kiosk_mode = opts.kioskMode;
  if (opts.startUrl !== undefined) body.start_url = opts.startUrl;
  if (opts.chromePolicy !== undefined) body.chrome_policy = opts.chromePolicy;
  if (opts.telemetry !== undefined) body.telemetry = opts.telemetry;
  return body;
}

function workflowCreateBody(opts: BrowserWorkflowCreateOpts): Record<string, unknown> {
  const { apiKey: _apiKey, apiUrl: _apiUrl, ...body } = opts;
  return body;
}

function runCreateBody(opts: BrowserRunCreateOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.browser !== undefined) body.browser = opts.browser;
  if (opts.mode !== undefined) body.mode = opts.mode;
  if (opts.task !== undefined) body.task = opts.task;
  if (opts.script !== undefined) body.script = opts.script;
  if (opts.input !== undefined) body.input = opts.input;
  if (opts.saveProfile !== undefined) body.saveProfile = opts.saveProfile;
  if (opts.closeBrowser !== undefined) body.closeBrowser = opts.closeBrowser;
  return body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function browserError(resp: Response, action: string): Promise<Error> {
  const text = await resp.text();
  return new Error(`Failed to ${action}: ${resp.status} ${text}`);
}
