// The HTTP layer of the management client: the API key header, JSON both
// ways, the error envelope, `Idempotency-Key`, and nothing else. Web
// standards only (fetch, URL, Headers), so the same code runs on Node,
// Workers, Deno and browsers-with-a-proxy. No retries: the API's idempotency
// keys make a caller's retry safe, and the caller knows which calls to
// repeat; a client that retried on its own would hide that decision.
//
// No redirects either. The key is sent to the configured origin and nowhere
// else: fetch runs with `redirect: "manual"`, and a 3xx answer is an error
// with code `redirected`, because following it would carry the key to
// whatever origin the response names.
//
// Every success is checked against the documented shape of its route
// (shapes.ts) before it is returned: a body that is not JSON, or does not
// have the fields the docs promise, is an error with code `invalid_response`
// rather than a value typed by assumption.

import { errorFromResponse, OpenComputerError } from "./errors.js";
import { ShapeError, type Shape } from "./shapes.js";

export const DEFAULT_BASE_URL = "https://app.opencomputer.dev/api/managed-agents";

export interface HttpOptions {
  /** Base URL of the management API. Default `https://app.opencomputer.dev/api/managed-agents`. */
  baseUrl?: string;
  /** The fetch to use. Default: the global. */
  fetch?: typeof fetch;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** A response with its status kept, for callers that branch on 200 versus 201. */
export interface Answer<T> {
  status: number;
  body: T;
  headers: Headers;
}

export class Http {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof fetch;

  constructor(apiKey: string, options: HttpOptions = {}) {
    if (!apiKey) throw new Error("An OpenComputer API key is required.");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    if (!f) throw new Error("No global fetch is available; pass { fetch } to the client.");
    // Call it as a plain function, never as a method of this client: a native
    // fetch checks its receiver, and workerd answers `Illegal invocation` when
    // the receiver is anything but the global; a caller's own fetch keeps
    // whatever binding it came with.
    this.doFetch = (input, init) => f(input, init);
  }

  url(path: string, query?: Query): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Sends a request and returns the body, checked against `shape`, with the
   * status. Throws `OpenComputerError` on a failed status, on a redirect, and
   * on a success whose body is not JSON or not the documented shape.
   */
  async send<T>(method: string, path: string, shape: Shape<T>, options: RequestOptions = {}): Promise<Answer<T>> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      accept: "application/json",
      ...options.headers,
    };
    const init: RequestInit = { method, headers, signal: options.signal, redirect: "manual" };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await this.doFetch(this.url(path, options.query), init);
    if (isRedirect(response)) {
      throw new OpenComputerError(
        response.status,
        "redirected",
        `${method} ${path} was answered with a redirect (${String(response.status)}); ` +
          "the client does not follow redirects with the API key. Check baseUrl.",
      );
    }
    const text = response.status === 204 ? "" : await response.text();
    if (!response.ok) {
      throw errorFromResponse(response.status, parseJson(text) ?? (text ? { error: text } : undefined), response.headers);
    }
    let body: unknown;
    if (text) {
      body = parseJson(text);
      if (body === undefined) {
        throw new OpenComputerError(
          response.status,
          "invalid_response",
          `${method} ${path} returned a body that is not JSON`,
        );
      }
    }
    try {
      return { status: response.status, body: shape(body, "body"), headers: response.headers };
    } catch (cause) {
      if (!(cause instanceof ShapeError)) throw cause;
      throw new OpenComputerError(
        response.status,
        "invalid_response",
        `${method} ${path} returned a body that is not the documented shape: ${cause.message}`,
      );
    }
  }

  /** `send` for callers that need only the body. */
  async request<T>(method: string, path: string, shape: Shape<T>, options: RequestOptions = {}): Promise<T> {
    return (await this.send(method, path, shape, options)).body;
  }
}

/**
 * A redirect as fetch reports it under `redirect: "manual"`: the 3xx answer
 * itself, or on browsers an opaque response of type `opaqueredirect` whose
 * status reads 0.
 */
function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/** The parsed JSON of a body, or undefined when the text is not JSON. */
function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** URL-encodes one path segment. */
export const segment = (value: string): string => encodeURIComponent(value);
