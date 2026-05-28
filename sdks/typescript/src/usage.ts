// Usage + tags — TypeScript SDK surface.
//
// All numeric fields are GB-seconds. Dollars live in Stripe; the SDK
// intentionally mirrors the server's "physical quantity" model so
// the invoice stays the source of truth for currency.

function resolveApiUrl(url: string): string {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}

async function throwApiError(resp: Response, action: string): Promise<never> {
  const body = await resp.text();
  const detail = body ? ` ${body}` : "";
  throw new Error(`Failed to ${action}: ${resp.status}${detail}`);
}

export interface UsageSandboxItem {
  sandboxId: string;
  alias?: string;
  status?: string;
  tags: Record<string, string>;
  tagsLastUpdatedAt: string | null;
  memoryGbSeconds: number;
  diskOverageGbSeconds: number;
}

export interface UsageTagItem {
  tagKey: string;
  tagValue: string;
  memoryGbSeconds: number;
  diskOverageGbSeconds: number;
  sandboxCount: number;
}

export interface UsageTotals {
  memoryGbSeconds: number;
  diskOverageGbSeconds: number;
}

export interface UsageUntaggedBucket extends UsageTotals {
  sandboxCount: number;
}

export interface UsageBySandboxResponse {
  from: string;
  to: string;
  groupBy: "sandbox";
  total: UsageTotals;
  items: UsageSandboxItem[];
  nextCursor: string | null;
}

export interface UsageByTagResponse {
  from: string;
  to: string;
  groupBy: string; // "tag:<key>"
  total: UsageTotals;
  untagged: UsageUntaggedBucket;
  items: UsageTagItem[];
  nextCursor: string | null;
}

export interface UsageFilterMap {
  /**
   * One entry per dimension. Comma-separated values within an entry are
   * OR'd; entries across different dimensions are AND'd. Empty string
   * matches "key absent." Repeating the same dimension is rejected by
   * the server — put multiple values in one comma-separated string.
   */
  [tagFilter: string]: string;
}

export interface UsageQueryOpts {
  from?: string; // ISO date (YYYY-MM-DD) or RFC3339; default: now - 30d
  to?: string; // ISO date (YYYY-MM-DD) or RFC3339
  filter?: UsageFilterMap;
  sort?: "-memoryGbSeconds" | "-diskOverageGbSeconds";
  limit?: number;
  cursor?: string;
}

/**
 * One 1-minute bucket of memory usage for a sandbox. Integrals
 * (`*GbSeconds`, `uptimeSeconds`) compose by summation; snapshot scalars
 * (`allocatedMemoryMb`, `usedMemoryMb*`) are for chart rendering.
 *
 * v1 is memory only. CPU fields will be added symmetrically once the
 * server-side collector starts populating cgroup cpu.stat.
 */
export interface SandboxUsagePoint {
  ts: string; // RFC3339, bucket start, minute-aligned in UTC
  memoryAllocatedGbSeconds: number;
  memoryUsedGbSeconds: number;
  uptimeSeconds: number;
  allocatedMemoryMb: number;
  usedMemoryMbAvg: number;
  usedMemoryMbPeak: number;
}

/**
 * Envelope totals over `[from, to)`. Server-side invariant: summing
 * the matching field across `points[]` reproduces the value here.
 */
export interface SandboxUsageTotals {
  memoryAllocatedGbSeconds: number;
  memoryUsedGbSeconds: number;
  uptimeSeconds: number;
  memoryAllocatedPeakMb: number;
  memoryUsedPeakMb: number;
}

/**
 * Response shape for `GET /api/sandboxes/:id/usage`. Default window is
 * last 1 hour; max window is 30 days (server returns 400 beyond that).
 * Allocation comes from scale events; used memory from cgroup samples.
 *
 * Charts read `points[]`; programmatic consumers usually want `totals`.
 */
export interface SandboxUsageResponse {
  sandboxId: string;
  alias?: string;
  from: string;
  to: string;
  totals: SandboxUsageTotals;
  points: SandboxUsagePoint[];
}

export interface TagKeyInfo {
  key: string;
  sandboxCount: number;
  valueCount: number;
}

export class Usage {
  private apiUrl: string;

  constructor(
    apiUrl: string,
    private apiKey: string,
  ) {
    this.apiUrl = resolveApiUrl(apiUrl);
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  private buildQueryString(params: Record<string, string | undefined>, filter?: UsageFilterMap): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") u.set(k, v);
    }
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        u.append(`filter[${k}]`, v);
      }
    }
    const s = u.toString();
    return s ? `?${s}` : "";
  }

  /** `GET /usage?groupBy=sandbox` — top sandboxes by usage. */
  async bySandbox(opts: UsageQueryOpts = {}): Promise<UsageBySandboxResponse> {
    const qs = this.buildQueryString({
      groupBy: "sandbox",
      from: opts.from,
      to: opts.to,
      sort: opts.sort,
      limit: opts.limit?.toString(),
      cursor: opts.cursor,
    }, opts.filter);
    const resp = await fetch(`${this.apiUrl}/usage${qs}`, { headers: this.headers });
    if (!resp.ok) await throwApiError(resp, "fetch usage");
    return resp.json();
  }

  /** `GET /usage?groupBy=tag:<key>` — usage per tag value, plus untagged sibling bucket. */
  async byTag(tagKey: string, opts: UsageQueryOpts = {}): Promise<UsageByTagResponse> {
    const qs = this.buildQueryString({
      groupBy: `tag:${tagKey}`,
      from: opts.from,
      to: opts.to,
      sort: opts.sort,
      limit: opts.limit?.toString(),
      cursor: opts.cursor,
    }, opts.filter);
    const resp = await fetch(`${this.apiUrl}/usage${qs}`, { headers: this.headers });
    if (!resp.ok) await throwApiError(resp, "fetch usage");
    return resp.json();
  }

  /** `GET /sandboxes/:id/usage` — per-sandbox drilldown. */
  async forSandbox(sandboxId: string, opts: Pick<UsageQueryOpts, "from" | "to"> = {}): Promise<SandboxUsageResponse> {
    const qs = this.buildQueryString({ from: opts.from, to: opts.to });
    const resp = await fetch(`${this.apiUrl}/sandboxes/${sandboxId}/usage${qs}`, { headers: this.headers });
    if (!resp.ok) await throwApiError(resp, "fetch sandbox usage");
    return resp.json();
  }
}

export class Tags {
  private apiUrl: string;

  constructor(
    apiUrl: string,
    private apiKey: string,
  ) {
    this.apiUrl = resolveApiUrl(apiUrl);
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  /** `GET /tags` — discovery of all tag keys across the org. */
  async listKeys(): Promise<TagKeyInfo[]> {
    const resp = await fetch(`${this.apiUrl}/tags`, { headers: this.headers });
    if (!resp.ok) await throwApiError(resp, "list tag keys");
    const body = await resp.json();
    return body.keys;
  }

  /** `GET /sandboxes/:id/tags` — current tag set. */
  async get(sandboxId: string): Promise<{ tags: Record<string, string>; tagsLastUpdatedAt: string | null }> {
    const resp = await fetch(`${this.apiUrl}/sandboxes/${sandboxId}/tags`, { headers: this.headers });
    if (!resp.ok) await throwApiError(resp, "get tags");
    return resp.json();
  }

  /** `PUT /sandboxes/:id/tags` — full replace. `{}` clears all tags. */
  async set(sandboxId: string, tags: Record<string, string>): Promise<{ tags: Record<string, string>; tagsLastUpdatedAt: string | null }> {
    const resp = await fetch(`${this.apiUrl}/sandboxes/${sandboxId}/tags`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(tags),
    });
    if (!resp.ok) await throwApiError(resp, "set tags");
    return resp.json();
  }
}
