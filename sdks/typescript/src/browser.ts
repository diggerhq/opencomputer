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
  recording?: boolean;
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
  if (opts.recording !== undefined) body.recording = opts.recording;
  return body;
}

async function browserError(resp: Response, action: string): Promise<Error> {
  const text = await resp.text();
  return new Error(`Failed to ${action}: ${resp.status} ${text}`);
}
