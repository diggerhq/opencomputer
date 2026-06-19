import { errorFromResponse } from "./errors.js";
import { normalize } from "./normalize.js";

/** Either an org API key (server) or a session-scoped client token (browser/edge). */
export type Auth = { apiKey: string } | { token: string };

export interface HttpOptions {
  /** Defaults to https://api.opencomputer.dev/v3 */
  baseUrl?: string;
  /** Override fetch (for runtimes without a global, or for testing). */
  fetch?: typeof fetch;
  /** Retries on 429 / 5xx / network error. Default 2. */
  maxRetries?: number;
}

export type Query = Record<string, string | number | boolean | undefined | null>;
interface RequestOptions { query?: Query; body?: unknown; idempotencyKey?: string; signal?: AbortSignal; }

const DEFAULT_BASE = "https://api.opencomputer.dev/v3";

/** Tiny fetch wrapper: auth, JSON, normalization, typed errors, retry. The whole HTTP layer. */
export class Http {
  readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly bearer: string;

  constructor(auth: Auth, opts: HttpOptions = {}) {
    this.bearer = "token" in auth ? auth.token : auth.apiKey;
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    const f = opts.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!f) throw new Error("global fetch is unavailable — pass { fetch } in the client options.");
    this.doFetch = f.bind(globalThis) as typeof fetch;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.bearer}`, ...extra };
  }

  url(path: string, query?: Query): string {
    const u = new URL(this.base + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers = this.headers(opts.body !== undefined ? { "Content-Type": "application/json" } : undefined);
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const init: RequestInit = { method, headers, signal: opts.signal };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const url = this.url(path, opts.query);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(url, init);
      } catch (e) {
        if (attempt < this.maxRetries && !opts.signal?.aborted) { await sleep(backoff(attempt)); continue; }
        throw e;
      }
      if (res.ok) return res.status === 204 ? (undefined as T) : normalize<T>(await res.json());
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      throw errorFromResponse(res.status, (await safeJson(res))?.error, retryAfterSec(res));
    }
  }

  /** Open an SSE stream (caller reads the body). Auth via the Authorization header. */
  async stream(path: string, query?: Query, signal?: AbortSignal): Promise<Response> {
    const res = await this.doFetch(this.url(path, query), {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok) throw errorFromResponse(res.status, (await safeJson(res))?.error, retryAfterSec(res));
    return res;
  }

  /** Raw GET (no JSON parse) — e.g. blob-backed event content. Returns the checked Response. */
  async raw(method: string, path: string, opts: { query?: Query; signal?: AbortSignal } = {}): Promise<Response> {
    const res = await this.doFetch(this.url(path, opts.query), { method, headers: this.headers(), signal: opts.signal });
    if (!res.ok) throw errorFromResponse(res.status, (await safeJson(res))?.error, retryAfterSec(res));
    return res;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8000);
const retryAfterSec = (res: Response): number | undefined => {
  const v = Number(res.headers.get("retry-after"));
  return Number.isFinite(v) && v > 0 ? v : undefined;
};
const retryAfterMs = (res: Response): number | undefined => {
  const s = retryAfterSec(res);
  return s ? s * 1000 : undefined;
};
async function safeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return undefined; }
}
