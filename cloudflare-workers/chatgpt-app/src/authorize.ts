import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { SCOPE, type Env, type GrantProps } from "./env.js";
import { errorPage, escapeHtml, page } from "./html.js";
import { OpenComputerAccounts, type Identity } from "./opencomputer.js";

const PENDING_PREFIX = "chatgpt-login:";
const MAX_FORM_BYTES = 8 * 1024;

interface PendingLogin {
  deviceCode: string;
  handle: string;
  expiresAt: number;
}

const accounts = (req: Request, env: Env) => new OpenComputerAccounts(env, req.headers.get("CF-Connecting-IP"));

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** POSTs must come from this Worker's own pages. */
function sameOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && origin === new URL(env.PUBLIC_URL).origin;
}

function grantedScopes(request: AuthRequest): string[] {
  return [SCOPE, ...request.scope.filter((scope) => scope === "offline_access")];
}

async function complete(
  req: Request,
  env: Env,
  handle: string,
  apiKey: string,
  identity: Identity,
  method: "sign_in" | "api_key",
): Promise<{ redirectTo: string; headers: Headers }> {
  const oauth = env.OAUTH_PROVIDER;
  const approved = await oauth.approveConsent(req, handle);
  const props: GrantProps = { apiKey, ...identity };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: `${identity.orgId}.${identity.userId ?? "org-key"}`,
    metadata: { orgName: identity.orgName, email: identity.email, method },
    scope: grantedScopes(approved.request),
    props,
  });
  return { redirectTo, headers: approved.headers };
}

function consentPage(
  details: Awaited<ReturnType<Env["OAUTH_PROVIDER"]["describeConsent"]>>,
  handle: string,
  headers: Headers,
): Response {
  const name = escapeHtml(details.clientName);
  const publisher = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>`
    : "";
  const h = escapeHtml(handle);
  return page(
    "Connect OpenComputer",
    `<div class="card">
      <h1>Connect ${name} to OpenComputer</h1>
      <p>${publisher} It will be able to list your agents, start and continue agent sessions, and read their replies.
      Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
      ${loopback}
      <div class="stack">
        <form method="post" action="/authorize"><input type="hidden" name="handle" value="${h}">
          <button class="primary" name="action" value="sign_in">Sign in with OpenComputer</button></form>
        <form method="post" action="/authorize"><input type="hidden" name="handle" value="${h}">
          <button class="secondary" name="action" value="deny">Cancel</button></form>
      </div>
      <details><summary>Use an API key instead</summary>
        <form method="post" action="/authorize" class="stack" style="margin-top:10px">
          <input type="hidden" name="handle" value="${h}">
          <input type="password" name="api_key" placeholder="osb_…" autocomplete="off" required>
          <button class="secondary" name="action" value="api_key">Connect with key</button>
        </form>
      </details>
    </div>`,
    headers,
  );
}

function waitingPage(userCode: string, verificationUri: string, pendingId: string, interval: number): Response {
  // Values the script needs travel as data attributes, never interpolated into script text.
  return page(
    "Sign in to OpenComputer",
    `<div class="card" id="login" data-pending="${escapeHtml(pendingId)}" data-interval="${interval}">
      <h1>Sign in to OpenComputer</h1>
      <p>Continue in the window that opens and confirm this code:</p>
      <div class="code">${escapeHtml(userCode)}</div>
      <a class="button primary" href="${escapeHtml(verificationUri)}" target="_blank" rel="noopener noreferrer">Open OpenComputer sign-in</a>
      <p class="muted" id="state" style="margin-top:12px">Waiting for you to sign in…</p>
    </div>
    <script>
    (() => {
      const root = document.getElementById("login");
      const state = document.getElementById("state");
      const pending = root.dataset.pending;
      let delay = Math.max(2, Number(root.dataset.interval) || 5) * 1000;
      async function poll() {
        try {
          const res = await fetch("/authorize/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pending }) });
          const body = await res.json();
          if (body.status === "authorized" && typeof body.redirectTo === "string") { state.textContent = "Signed in. Returning to ChatGPT…"; location.assign(body.redirectTo); return; }
          if (body.status === "pending") { delay = Math.max(2, Number(body.retryAfter) || 5) * 1000; setTimeout(poll, delay); return; }
          state.textContent = body.message || "Sign-in failed. Close this window and try again.";
          state.className = "error";
        } catch (_) { setTimeout(poll, delay); }
      }
      setTimeout(poll, delay);
    })();
    </script>`,
  );
}

async function showConsent(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const request = await oauth.parseAuthRequest(req);
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  return consentPage(details, consent.handle, consent.headers);
}

async function readForm(req: Request): Promise<FormData | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_FORM_BYTES) return null;
  try {
    return await req.formData();
  } catch {
    return null;
  }
}

async function submitConsent(req: Request, env: Env): Promise<Response> {
  if (!sameOrigin(req, env)) return errorPage("This request didn't come from the OpenComputer connect page.", 403);
  const form = await readForm(req);
  const handle = form?.get("handle");
  const action = form?.get("action");
  if (!form || typeof handle !== "string" || handle.length === 0 || handle.length > 512) {
    return errorPage("The connect page expired.");
  }

  if (action === "deny") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  if (action === "api_key") {
    const apiKey = String(form.get("api_key") ?? "").trim();
    const identity = apiKey.startsWith("osb_") && apiKey.length <= 512 ? await accounts(req, env).whoami(apiKey) : null;
    if (!identity) {
      return page(
        "OpenComputer",
        `<div class="card"><h1>That key didn't work</h1><p class="error">OpenComputer didn't accept the API key.</p>
        <button class="secondary" onclick="history.back()">Go back</button></div>`,
        undefined,
        400,
      );
    }
    const done = await complete(req, env, handle, apiKey, identity, "api_key");
    done.headers.set("Location", done.redirectTo);
    return new Response(null, { status: 302, headers: done.headers });
  }

  if (action === "sign_in") {
    const login = await accounts(req, env).startDeviceLogin();
    if (!login) return errorPage("OpenComputer sign-in is unavailable right now. Try again shortly.", 503);
    const pendingId = randomId();
    const ttl = Math.max(60, Math.min(login.expiresIn, 900));
    const record: PendingLogin = { deviceCode: login.deviceCode, handle, expiresAt: Date.now() + ttl * 1000 };
    await env.OAUTH_KV.put(PENDING_PREFIX + pendingId, JSON.stringify(record), { expirationTtl: ttl });
    return waitingPage(login.userCode, login.verificationUri, pendingId, login.interval);
  }

  return errorPage("Unknown action.");
}

const json = (body: unknown, status = 200, headers?: Headers): Response => {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json");
  out.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: out });
};

async function pollLogin(req: Request, env: Env): Promise<Response> {
  if (!sameOrigin(req, env)) return json({ status: "error", message: "Forbidden." }, 403);
  const body = (await req.json().catch(() => null)) as { pending?: unknown } | null;
  const pendingId = body?.pending;
  if (typeof pendingId !== "string" || pendingId.length === 0 || pendingId.length > 128) {
    return json({ status: "error", message: "Invalid request." }, 400);
  }
  const key = PENDING_PREFIX + pendingId;
  const record = (await env.OAUTH_KV.get(key, "json")) as PendingLogin | null;
  if (!record || record.expiresAt < Date.now()) {
    return json({ status: "expired", message: "Sign-in expired. Close this window and connect again." }, 410);
  }

  const client = accounts(req, env);
  const exchange = await client.exchangeDeviceLogin(record.deviceCode);
  if (exchange.status === "pending") return json({ status: "pending", retryAfter: exchange.retryAfter });
  await env.OAUTH_KV.delete(key);
  if (exchange.status !== "authorized") return json({ status: exchange.status, message: exchange.message });

  const identity = await client.whoami(exchange.apiKey);
  if (!identity) return json({ status: "unavailable", message: "OpenComputer sign-in is unavailable right now." });
  const done = await complete(req, env, record.handle, exchange.apiKey, identity, "sign_in");
  return json({ status: "authorized", redirectTo: done.redirectTo }, 200, done.headers);
}

function landing(env: Env): Response {
  const mcp = escapeHtml(new URL("/mcp", env.PUBLIC_URL).toString());
  return page(
    "OpenComputer for ChatGPT",
    `<div class="card"><h1>OpenComputer for ChatGPT</h1>
    <p>Run your OpenComputer agents from ChatGPT. Add this MCP server URL as an app in ChatGPT:</p>
    <div class="code" style="font-size:14px;letter-spacing:0">${mcp}</div></div>`,
  );
}

export async function handleDefault(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/authorize" && req.method === "GET") return await showConsent(req, env);
    if (url.pathname === "/authorize" && req.method === "POST") return await submitConsent(req, env);
    if (url.pathname === "/authorize/poll" && req.method === "POST") return await pollLogin(req, env);
    if (url.pathname === "/" && req.method === "GET") return landing(env);
    if (url.pathname === "/healthz") return new Response("ok");
    return new Response("Not found", { status: 404 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) {
      return url.pathname === "/authorize/poll"
        ? json({ status: "expired", message: "This connect page expired. Close this window and connect again." }, 400)
        : errorPage(error.description);
    }
    if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
    throw error;
  }
}
