// The previews Worker's request path (work 074): `<name>.opencomputer.app`
// → the name's record → the computer's tunnel, signed for the host proxy.
//
// Per request: one cached `resolve` on the name's object and one fetch to
// `https://<tunnelId>.t.opencomputer.app` with the port and a signature in
// headers. The organization's computer object is asked only when the tunnel
// is not connected (530), to tell an asleep computer from a booting one.
// Every response that did not come from the host proxy (no marker header)
// is replaced by one of our pages, so no upstream error page is ever shown.

import { previewKey, signPreview } from "./auth.js";
import { PREVIEW_DOMAIN, previewHost } from "./names.js";
import { type PreviewPage, WAKE_PATH, renderPage } from "./pages.js";
import { HIT_WRITE_INTERVAL_MS, type PreviewResolution } from "./registry.js";

/** The marker every response from the host proxy carries; nothing else is shown to a visitor. */
export const PREVIEW_ORIGIN_HEADER = "x-preview-origin";
/** Set by the host proxy on its own 503 when nothing listens on the port. */
export const PREVIEW_STATE_HEADER = "x-preview-state";

/** What the computer object answers about itself for a preview (work 074, implemented with the tunnel lifecycle). */
export type PreviewComputerState = "asleep" | "waking" | "ready" | "gone";

export interface PreviewNameStub {
  resolve(): Promise<PreviewResolution>;
  hit(at: number): Promise<void>;
}

export interface PreviewComputerStub {
  previewState(): Promise<PreviewComputerState>;
  wakeForPreview(name: string): Promise<"waking" | "refused">;
  /** A served response: the computer is in use and does not park. */
  notePreviewHit(): Promise<void>;
}

export interface PreviewEnv {
  PREVIEWS: { getByName(name: string): PreviewNameStub };
  /** The ComputerDurableObject namespace of `managed-agents`, bound by script name. */
  COMPUTERS?: { getByName(organizationId: string): PreviewComputerStub };
  /** Shared with the gateway; derives each computer's key. A secret. */
  PREVIEW_PLATFORM_KEY?: string;
  PREVIEW_DOMAIN?: string;
  /** Where the tunnels' hostnames live; `t.<PREVIEW_DOMAIN>` unless set. */
  PREVIEW_TUNNEL_DOMAIN?: string;
}

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

interface Cached<T> {
  value: T;
  until: number;
}

const RESOLVE_TTL_MS = 10_000;
/** A free name is cached briefly, so a name claimed just after a miss goes live quickly. */
const FREE_TTL_MS = 2_000;
const STATE_TTL_MS = 10_000;
const CACHE_LIMIT = 5_000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value as K);
}

export interface PreviewHandlerOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** A request handler with its own isolate caches; `index.ts` makes one per isolate. */
export function createPreviewHandler(options: PreviewHandlerOptions = {}) {
  const upstream = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const resolutions = new Map<string, Cached<PreviewResolution>>();
  const states = new Map<string, Cached<Promise<PreviewComputerState>>>();
  const keys = new Map<string, Promise<string>>();
  const hits = new Map<string, number>();

  async function resolve(env: PreviewEnv, name: string): Promise<PreviewResolution> {
    const cached = resolutions.get(name);
    if (cached && cached.until > now()) return cached.value;
    const value = await env.PREVIEWS.getByName(name).resolve();
    remember(resolutions, name, { value, until: now() + (value.state === "free" ? FREE_TTL_MS : RESOLVE_TTL_MS) });
    return value;
  }

  /** Single-flight per organization: a burst of asset requests to an asleep computer asks once. */
  function computerState(env: PreviewEnv, organizationId: string): Promise<PreviewComputerState> {
    const cached = states.get(organizationId);
    if (cached && cached.until > now()) return cached.value;
    const value = (async (): Promise<PreviewComputerState> => {
      if (!env.COMPUTERS) return "gone";
      try {
        return await env.COMPUTERS.getByName(organizationId).previewState();
      } catch (error) {
        console.error(JSON.stringify({ event: "preview.computer_state_failed", error: String(error) }));
        return "gone";
      }
    })();
    remember(states, organizationId, { value, until: now() + STATE_TTL_MS });
    return value;
  }

  function key(env: PreviewEnv, tunnelId: string): Promise<string> {
    let value = keys.get(tunnelId);
    if (!value) {
      value = previewKey(env.PREVIEW_PLATFORM_KEY!, tunnelId);
      remember(keys, tunnelId, value);
      value.catch(() => keys.delete(tunnelId));
    }
    return value;
  }

  function countHit(env: PreviewEnv, ctx: WaitUntil, name: string, organizationId: string): void {
    const at = now();
    if (at - (hits.get(name) ?? 0) < HIT_WRITE_INTERVAL_MS) return;
    remember(hits, name, at);
    ctx.waitUntil(env.PREVIEWS.getByName(name).hit(at).catch(() => undefined));
    if (env.COMPUTERS) ctx.waitUntil(env.COMPUTERS.getByName(organizationId).notePreviewHit().catch(() => undefined));
  }

  async function wake(request: Request, env: PreviewEnv, name: string, organizationId: string): Promise<Response> {
    const origin = request.headers.get("origin");
    const sameOrigin =
      request.headers.get("sec-fetch-site") === "same-origin" || origin === new URL(request.url).origin;
    if (!sameOrigin || !env.COMPUTERS) return renderPage({ kind: "unavailable" });
    // A computer that is not asleep has nothing to wake; the cached state keeps a scripted POST off the computer object.
    if ((await computerState(env, organizationId)) !== "asleep") return renderPage({ kind: "unavailable" });
    try {
      const outcome = await env.COMPUTERS.getByName(organizationId).wakeForPreview(name);
      if (outcome === "refused") return renderPage({ kind: "unavailable" });
    } catch (error) {
      console.error(JSON.stringify({ event: "preview.wake_failed", error: String(error) }));
      return renderPage({ kind: "unavailable" });
    }
    states.delete(organizationId);
    return new Response(null, { status: 303, headers: { location: wakeReturnPath(request), "cache-control": "no-store" } });
  }

  async function serve(request: Request, env: PreviewEnv, ctx: WaitUntil): Promise<Response> {
    const domain = env.PREVIEW_DOMAIN ?? PREVIEW_DOMAIN;
    const url = new URL(request.url);
    const host = previewHost(url.hostname, domain);
    if (host.kind === "apex") return renderPage({ kind: "apex" });
    if (host.kind === "other") return renderPage({ kind: "unavailable" });
    if (!env.PREVIEW_PLATFORM_KEY) {
      console.error(JSON.stringify({ event: "preview.not_configured" }));
      return renderPage({ kind: "unavailable" });
    }

    const resolution = await resolve(env, host.name);
    if (resolution.state !== "live") return renderPage({ kind: "unavailable" });
    const { record } = resolution;

    if (request.method === "POST" && url.pathname === WAKE_PATH) return wake(request, env, host.name, record.organizationId);

    const tunnelDomain = env.PREVIEW_TUNNEL_DOMAIN ?? `t.${domain}`;
    const target = new URL(`${url.pathname}${url.search}`, `https://${record.tunnelId}.${tunnelDomain}`);
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) if (name.startsWith("x-preview-")) headers.delete(name);
    // The tunnel routes on its own hostname; the visitor's goes in a header
    // and the host proxy restores it as Host for the app.
    headers.delete("host");
    headers.set("x-preview-host", url.host);
    headers.set("x-preview-port", String(record.port));
    headers.set("x-preview-auth", await signPreview(await key(env, record.tunnelId), record.port, now()));

    let response: Response;
    try {
      response = await upstream(target.toString(), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        redirect: "manual",
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "preview.upstream_failed", error: String(error) }));
      return renderPage({ kind: "unavailable", status: 503 });
    }

    if (response.headers.get(PREVIEW_ORIGIN_HEADER) !== "computer") {
      // cloudflared's own 502 (host proxy down), a Cloudflare 52x: the origin is there but not answering.
      if (response.status !== 530) return renderPage({ kind: "unavailable", status: 503 });
      return renderPage(pageForState(await computerState(env, record.organizationId)));
    }
    if (response.headers.get(PREVIEW_STATE_HEADER) === "closed") return renderPage({ kind: "closed", port: record.port });

    if ((response.status >= 200 && response.status < 300) || response.status === 101) countHit(env, ctx, host.name, record.organizationId);
    // A WebSocket upgrade is handed back as it came.
    if (response.status === 101) return response;
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: visitorHeaders(response.headers, domain),
    });
  }

  /** Nothing thrown reaches the visitor as a platform error page: a failed resolve or RPC is our "unavailable". */
  return async function handle(request: Request, env: PreviewEnv, ctx: WaitUntil): Promise<Response> {
    try {
      return await serve(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ event: "preview.handler_failed", error: String(error) }));
      return renderPage({ kind: "unavailable", status: 503 });
    }
  };
}

/** After a wake, back to the page the visitor pressed the button on (same origin only). */
function wakeReturnPath(request: Request): string {
  const referer = request.headers.get("referer");
  if (!referer) return "/";
  try {
    const url = new URL(referer);
    if (url.origin !== new URL(request.url).origin || url.pathname === WAKE_PATH) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

function pageForState(state: PreviewComputerState): PreviewPage {
  if (state === "asleep") return { kind: "asleep" };
  if (state === "waking") return { kind: "waking" };
  // "ready" with the tunnel down is cloudflared gone on a running computer: not a boot to wait for.
  return { kind: "unavailable", status: state === "ready" ? 503 : 404 };
}

/**
 * The app's headers minus our marker, plus `noindex`. Until the domain is on
 * the Public Suffix List, a cookie set for the whole domain would reach every
 * other preview, so `Domain=opencomputer.app` is dropped (host-only cookie).
 */
export function visitorHeaders(upstream: Headers, domain = PREVIEW_DOMAIN): Headers {
  const headers = new Headers(upstream);
  headers.delete(PREVIEW_ORIGIN_HEADER);
  headers.delete(PREVIEW_STATE_HEADER);
  headers.set("x-robots-tag", "noindex");
  const cookies = upstream.getSetCookie();
  if (cookies.length) {
    headers.delete("set-cookie");
    const escaped = domain.replace(/\./g, "\\.");
    const apex = new RegExp(`;\\s*domain\\s*=\\s*\\.?${escaped}\\s*(?=;|$)`, "gi");
    for (const cookie of cookies) headers.append("set-cookie", cookie.replace(apex, ""));
  }
  return headers;
}
