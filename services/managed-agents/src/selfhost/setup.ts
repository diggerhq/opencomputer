// /setup for the self-hosted gateway (spike; selfhost/entry.ts only, never a hosted entry). Small
// server-rendered pages for the operator of the one organization: the Claude credential (required),
// the host, people, and optionally the Slack app, SSO and a GitHub App.
//
// Access: SETUP_TOKEN, as `Authorization: Bearer` or through the sign-in form, which sets an
// HttpOnly, SameSite=Strict cookie (12 h, path /setup) signed with a key derived from the token, so
// rotating SETUP_TOKEN signs everyone out. A cookie's POSTs carry a CSRF field derived from it and
// must come from this origin. Compared in constant time.
//
// Lock: once the Claude credential is set and a host has connected (or the host step was
// acknowledged), every /setup path answers 404 unless SP_SETUP_OPEN=1.
//
// No secret value is ever written into a response: steps show "set" or "not set". The host token is
// the one exception, and only on the explicit reveal (a POST), for the install command.
//
// Everything this module touches goes through `SetupDeps`, so it runs under node in tests; the
// entry builds the deps from the actors (the ACCOUNTS stand-in, account.ts; Computer; Slack).

import { hostedSlackManifest } from "../channels/slack-manifest.js";

// ------------------------------------------------------------------ the store's shapes (account.ts)

export interface SetupStatus {
  claude: { set: false } | { set: true; kind: "api-key" | "oauth"; at: string };
  hostsAcknowledged: boolean;
  slack: { clientId: string; clientSecret: boolean; signingSecret: boolean } | null;
  oidc: { issuer: string; clientId: string; clientSecret: boolean } | null;
  workos: { clientId: string; apiKey: boolean; ownerEmail: string | null } | null;
  github: { appId: string; slug: string; privateKey: boolean; webhookSecret: boolean } | null;
}

export type SetupWrite =
  | { step: "claude"; token: string; kind: "api-key" | "oauth" }
  | { step: "claude-delete" }
  | { step: "hosts-ack" }
  | { step: "slack"; clientId: string; clientSecret?: string; signingSecret?: string }
  | { step: "oidc"; issuer: string; clientId: string; clientSecret?: string }
  | { step: "workos"; clientId: string; apiKey?: string; ownerEmail: string }
  | { step: "github"; appId: string; slug: string; privateKey?: string; webhookSecret?: string };

export interface SetupStore {
  status(): Promise<SetupStatus>;
  write(w: SetupWrite): Promise<void>;
}

export interface SetupDeps {
  /** SETUP_TOKEN; unset: /setup is unavailable. */
  setupToken: string | undefined;
  /** SP_SETUP_OPEN=1: /setup stays open after completion. */
  open: boolean;
  /** The gateway's public origin (PUBLIC_URL / SP_ORIGIN), no trailing slash; null when unset. */
  publicUrl: string | null;
  org: string;
  store: SetupStore;
  /** The host's WebSocket URL and token (serve.mjs computes both); null when the gateway was not given them. */
  host: { url: string; token: string } | null;
  /** Whether the organization's host is connected now; null when that cannot be read. */
  hostConnected(): Promise<boolean | null>;
  /** The Claude credential changed: the Computer actor re-reads it and sends the host fresh credentials. */
  modelKeyChanged(): Promise<void>;
  /** The linked Slack workspace, from the Slack actor. */
  slackLinked(): Promise<{ installed: boolean; teamName?: string }>;
  /** Starts the existing Slack OAuth install (POST /v1/computer/slack/install): Slack's authorize URL, or a problem's message. */
  slackInstall(): Promise<{ url: string } | { error: string }>;
  now?: () => number;
}

// ------------------------------------------------------------------ constants

/** The hosted Slack app's bot scopes (wrangler.production.jsonc SLACK_COMPUTER_SCOPES); a test keeps them equal. */
export const COMPUTER_SLACK_SCOPES =
  "app_mentions:read,assistant:write,channels:history,channels:read,channels:manage,groups:history,groups:read,groups:write,im:history,im:read,im:write,chat:write,files:read,files:write,reactions:write,users:read,users:read.email";
/** The bot events the Slack actor handles (slack-api/web-api.ts parseSlackEnvelope). */
export const COMPUTER_SLACK_EVENTS = ["app_mention", "message.channels", "message.groups", "message.im", "app_uninstalled", "tokens_revoked", "team_leave", "user_change"];
/** slackRedirectUri's path (actors/computer/config.ts); the entry serves it as /v1/computer/slack/callback. A test keeps them equal. */
export const SLACK_CALLBACK_PATH = "/api/managed-agents/computer/slack/callback";

const COOKIE = "oc_setup";
const COOKIE_TTL_S = 12 * 3600;
const FORM_MAX_BYTES = 64 * 1024;
const SECRET_MAX = 16 * 1024;

// ------------------------------------------------------------------ crypto

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", k, encoder.encode(message)));
}

/** Equal strings, in time independent of their contents: both are hashed first, so lengths do not leak either. */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

/** The key cookies and CSRF fields are signed with: derived from SETUP_TOKEN, never the token itself. */
const cookieKey = (token: string) => hmac(token, "opencomputer selfhost setup v1");

// ------------------------------------------------------------------ html

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}
h2{margin-top:2rem;border-top:1px solid #ddd;padding-top:1rem}.done{color:#1a7f37}.pending{color:#9a6700}.err{color:#cf222e}.muted{color:#666}
code,pre{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px}pre{padding:.6rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
input[type=text],input[type=password],input[type=url],textarea{width:100%;padding:.3rem;box-sizing:border-box}label{display:block;margin:.4rem 0}
form.inline{display:inline}button{margin:.3rem 0}`;

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // No script at all; forms post here, and the Slack install redirects to slack.com.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://slack.com; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  });
}

function page(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: headers(extra) });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra } });
}

const notFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });

const back = '<p><a href="/setup">Back to setup</a></p>';

function loginPage(status: number, message?: string): Response {
  return page(
    status,
    "Sign in to setup",
    `${message ? `<p class="err">${esc(message)}</p>` : ""}<form method="post" action="/setup/login">
<label>Setup token (<code>SETUP_TOKEN</code> in the gateway's <code>.env</code>)<input type="password" name="token" autocomplete="current-password" required></label>
<button>Sign in</button></form>`,
  );
}

// ------------------------------------------------------------------ auth

type Auth = { via: "bearer" } | { via: "cookie"; csrf: string };

function cookieOf(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
  return undefined;
}

async function authenticate(request: Request, token: string, now: number): Promise<Auth | null> {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (bearer !== undefined) return (await constantTimeEqual(bearer, token)) ? { via: "bearer" } : null;
  const cookie = cookieOf(request);
  const m = cookie?.match(/^(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!cookie || !m || Number(m[1]) * 1000 <= now) return null;
  const key = await cookieKey(token);
  if (!(await constantTimeEqual(m[2]!, await hmac(key, `session.${m[1]}`)))) return null;
  return { via: "cookie", csrf: await hmac(key, `csrf.${cookie}`) };
}

/** A cookie's POST must come from this page: same origin (when the browser says) and the CSRF field. */
async function csrfOk(request: Request, auth: Auth, form: URLSearchParams, publicUrl: string | null): Promise<boolean> {
  if (auth.via === "bearer") return true;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && origin !== publicUrl) return false;
  return constantTimeEqual(form.get("csrf") ?? "", auth.csrf);
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  const text = await request.text();
  if (encoder.encode(text).byteLength > FORM_MAX_BYTES) return null;
  return new URLSearchParams(text);
}

// ------------------------------------------------------------------ state

/** Whether the required steps are done: the Claude credential, and a host connected or the step acknowledged. */
export async function setupComplete(deps: SetupDeps): Promise<boolean> {
  const status = await deps.store.status();
  if (!status.claude.set) return false;
  return status.hostsAcknowledged || (await deps.hostConnected()) === true;
}

/** What a pasted Claude credential is: a subscription's OAuth token (`claude setup-token`) or an API key. */
export function claudeCredentialKind(token: string): "api-key" | "oauth" | null {
  if (!/^sk-ant-[A-Za-z0-9_-]{16,}$/.test(token) || token.length > 512) return null;
  return token.startsWith("sk-ant-oat") ? "oauth" : "api-key";
}

/** The one-line host install (#1204's host-install.sh reads /etc/opencomputer/selfhost.env). */
export function hostInstallCommand(host: { url: string; token: string }, org: string, token = host.token): string {
  const env = `SP_GATEWAY_URL=${host.url}\\nSP_HOST_ID=${org}\\nSP_HOST_TOKEN=${token}\\n`;
  return `sudo install -d -m 0755 /etc/opencomputer && printf '${env}' | sudo install -m 0600 -o root -g root /dev/stdin /etc/opencomputer/selfhost.env && sudo selfhost/host-install.sh`;
}

const mask = (token: string) => `${token.slice(0, 4)}${"•".repeat(12)}`;

/** The Slack app manifest for this gateway: the hosted generator with the Computer path's URLs. */
export function slackManifest(publicUrl: string): Record<string, unknown> {
  const { manifest } = hostedSlackManifest("OpenComputer", `${publicUrl}/v1/webhooks/computer/slack/events`, {
    botScopes: COMPUTER_SLACK_SCOPES.split(","),
    events: COMPUTER_SLACK_EVENTS,
    redirectUri: `${publicUrl}${SLACK_CALLBACK_PATH}`,
  });
  const settings = manifest.settings as { interactivity: { request_url: string } };
  settings.interactivity.request_url = `${publicUrl}/v1/webhooks/computer/slack/interactivity`;
  return manifest;
}

// ------------------------------------------------------------------ the page

const badge = (done: boolean, yes = "done", no = "not set") => `<span class="${done ? "done" : "pending"}">${done ? yes : no}</span>`;
const setOrNot = (set: boolean) => badge(set, "set", "not set");

async function overview(deps: SetupDeps, auth: Auth, notice?: string): Promise<Response> {
  const status = await deps.store.status();
  const connected = await deps.hostConnected();
  const slack = await deps.slackLinked().catch(() => ({ installed: false }) as { installed: boolean; teamName?: string });
  const complete = status.claude.set && (status.hostsAcknowledged || connected === true);
  const csrf = auth.via === "cookie" ? `<input type="hidden" name="csrf" value="${esc(auth.csrf)}">` : "";
  const form = (action: string, inner: string, button: string, cls = "") =>
    `<form method="post" action="${action}"${cls ? ` class="${cls}"` : ""}>${csrf}${inner}<button>${esc(button)}</button></form>`;
  const field = (name: string, label: string, value = "", type = "text") =>
    `<label>${label}<input type="${type}" name="${name}" value="${esc(value)}" autocomplete="off"></label>`;
  const secret = (name: string, label: string, set: boolean) =>
    `<label>${label} ${setOrNot(set)}<input type="password" name="${name}" autocomplete="off" placeholder="${set ? "leave empty to keep" : ""}"></label>`;
  const origin = deps.publicUrl;
  const https = !!origin && origin.startsWith("https://");

  const claude = status.claude.set
    ? `<p>${badge(true, "set")} — ${status.claude.kind === "oauth" ? "Claude subscription token" : "Anthropic API key"}, since ${esc(status.claude.at)}.</p>
${form("/setup/claude/delete", "", "Remove", "inline")}`
    : `<p>${badge(false)}</p>`;

  const hostLine = connected === true ? badge(true, "connected") : connected === false ? badge(false, "", "not connected") : '<span class="muted">unknown</span>';
  const hosts = deps.host
    ? `<p>Run on the gateway's VM, from a checkout of the repository:</p><pre>${esc(hostInstallCommand(deps.host, deps.org, mask(deps.host.token)))}</pre>
${form("/setup/hosts/reveal", "", "Reveal the command with the token", "inline")}`
    : `<p class="err">The gateway was started without the host's URL and token (serve.mjs sets them); see <code>/data/host-token</code>.</p>`;

  const body = `${notice ? `<p class="done">${esc(notice)}</p>` : ""}
<p>Organization <code>${esc(deps.org)}</code>. Required steps: ${badge(complete, "complete", "not complete")}.
${complete && !deps.open ? "" : complete ? " <code>SP_SETUP_OPEN=1</code> keeps this page open." : " Once complete, this page answers 404 unless <code>SP_SETUP_OPEN=1</code>."}</p>
${auth.via === "cookie" ? form("/setup/logout", "", "Sign out", "inline") : ""}

<h2>1. Claude credential (required)</h2>
<p>Sessions spend it through the host's model proxy; the runner never sees it. Paste an Anthropic API key (<code>sk-ant-api…</code>) or a Claude subscription token from <code>claude setup-token</code> (<code>sk-ant-oat…</code>). It is stored encrypted and never shown again.</p>
${claude}
${form("/setup/claude", `<label>Credential<input type="password" name="token" autocomplete="off" required></label>`, status.claude.set ? "Replace" : "Save")}

<h2>2. Host (required)</h2>
<p>The host agent runs the sessions, on this VM. Host: ${hostLine}</p>
${hosts}
${connected === true ? "" : status.hostsAcknowledged ? `<p>${badge(true, "acknowledged")} — connect it when ready.</p>` : form("/setup/hosts/ack", "", "I'll connect the host later")}

<h2>3. Sign-in and people (optional)</h2>
<p>People sign in to the dashboard at ${origin ? `<a href="${esc(origin)}/">${esc(origin)}/</a>` : "the gateway's address"} with a WorkOS app. The owner's email below becomes the organization's owner on first sign-in; the owner invites everyone else from Settings, and WorkOS emails the invitation. Anyone else is turned away.</p>
${form(
  "/setup/sso/workos",
  field("client_id", "WorkOS client ID", status.workos?.clientId ?? "") + secret("api_key", "WorkOS API key", !!status.workos?.apiKey) + field("owner_email", "Owner's email", status.workos?.ownerEmail ?? "", "email") +
    (origin ? `<p class="muted">Redirect URI to register in WorkOS: <code>${esc(origin)}/auth/callback</code></p>` : ""),
  "Save",
)}

<h2>4. Slack app (optional)</h2>
<p>Workspace: ${slack.installed ? badge(true, `connected${slack.teamName ? ` to ${esc(slack.teamName)}` : ""}`) : badge(false, "", "not connected")}</p>
${
  https
    ? `<ol><li>Create an app from the <a href="/setup/slack/manifest.json">manifest</a> at <a href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</a> (“From a manifest”).</li>
<li>From its Basic Information, paste the client ID, client secret and signing secret here.</li>
<li>Install it to the workspace.</li></ol>
${form(
  "/setup/slack",
  field("client_id", "Client ID", status.slack?.clientId ?? "") + secret("client_secret", "Client secret", !!status.slack?.clientSecret) + secret("signing_secret", "Signing secret", !!status.slack?.signingSecret),
  "Save",
)}
${status.slack?.clientSecret && status.slack.signingSecret ? form("/setup/slack/install", "", slack.installed ? "Reinstall to Slack" : "Install to Slack") : ""}`
    : `<p class="pending">Set <code>PUBLIC_URL</code> to the gateway's public https origin (a reverse proxy or tunnel) and restart it: Slack only calls https URLs.</p>`
}

<h2>5. OIDC (optional, stored only)</h2>
<p class="pending">Sign-in uses the WorkOS app above.</p>
${form(
  "/setup/sso/oidc",
  field("issuer", "Issuer URL", status.oidc?.issuer ?? "", "url") + field("client_id", "Client ID", status.oidc?.clientId ?? "") + secret("client_secret", "Client secret", !!status.oidc?.clientSecret) +
    (origin ? `<p class="muted">Redirect URI to register: <code>${esc(origin)}/setup/sso/oidc/callback</code></p>` : ""),
  "Save",
)}

<h2>6. GitHub App (optional, limited)</h2>
<p class="pending">Stored only: this gateway's GitHub installations are not wired yet (the Account object is a stand-in), so sessions do not get GitHub tokens from it. Sessions can still use credentials you give them as secrets.</p>
${form(
  "/setup/github",
  field("app_id", "App ID", status.github?.appId ?? "") + field("slug", "App slug", status.github?.slug ?? "") +
    `<label>Private key (PEM) ${setOrNot(!!status.github?.privateKey)}<textarea name="private_key" rows="3" autocomplete="off" placeholder="${status.github?.privateKey ? "leave empty to keep" : ""}"></textarea></label>` +
    secret("webhook_secret", "Webhook secret", !!status.github?.webhookSecret),
  "Save",
)}`;
  return page(200, "OpenComputer setup", body);
}

// ------------------------------------------------------------------ steps

const text = (form: URLSearchParams, name: string, max = 512) => {
  const value = (form.get(name) ?? "").trim();
  return value.length <= max ? value : null;
};

const plainId = (value: string | null) => !!value && /^[A-Za-z0-9._:-]{1,200}$/.test(value);

function httpsUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.hash;
  } catch {
    return false;
  }
}

async function step(path: string, form: URLSearchParams, deps: SetupDeps): Promise<{ write?: SetupWrite; error?: string; done?: string } | Response> {
  switch (path) {
    case "/setup/claude": {
      const token = (form.get("token") ?? "").trim();
      const kind = claudeCredentialKind(token);
      if (!kind) return { error: "That does not look like an Anthropic API key (sk-ant-api…) or a Claude subscription token (sk-ant-oat…)." };
      return { write: { step: "claude", token, kind }, done: "Claude credential saved." };
    }
    case "/setup/claude/delete":
      return { write: { step: "claude-delete" }, done: "Claude credential removed." };
    case "/setup/hosts/ack":
      return { write: { step: "hosts-ack" }, done: "Host step acknowledged." };
    case "/setup/hosts/reveal": {
      if (!deps.host) return { error: "The gateway was started without the host's token." };
      return page(200, "Host install command", `<p>Run on the gateway's VM. It contains the host token: do not paste it anywhere else.</p><pre>${esc(hostInstallCommand(deps.host, deps.org))}</pre>${back}`);
    }
    case "/setup/slack": {
      const clientId = text(form, "client_id", 100);
      const clientSecret = text(form, "client_secret", SECRET_MAX) ?? "";
      const signingSecret = text(form, "signing_secret", SECRET_MAX) ?? "";
      if (!plainId(clientId)) return { error: "The client ID is required (digits and dots, from Basic Information)." };
      return { write: { step: "slack", clientId: clientId!, ...(clientSecret ? { clientSecret } : {}), ...(signingSecret ? { signingSecret } : {}) }, done: "Slack app saved." };
    }
    case "/setup/slack/install": {
      const result = await deps.slackInstall();
      if ("url" in result) return redirect(result.url);
      return { error: result.error };
    }
    case "/setup/sso/oidc": {
      const issuer = text(form, "issuer", 500);
      const clientId = text(form, "client_id", 200);
      const clientSecret = text(form, "client_secret", SECRET_MAX) ?? "";
      if (!httpsUrl(issuer)) return { error: "The issuer must be an https URL." };
      if (!plainId(clientId)) return { error: "The client ID is required." };
      return { write: { step: "oidc", issuer: issuer!, clientId: clientId!, ...(clientSecret ? { clientSecret } : {}) }, done: "OIDC settings saved." };
    }
    case "/setup/sso/workos": {
      const clientId = text(form, "client_id", 200);
      const apiKey = text(form, "api_key", SECRET_MAX) ?? "";
      const ownerEmail = text(form, "owner_email", 320)?.toLowerCase() ?? "";
      if (!plainId(clientId)) return { error: "The client ID is required." };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) return { error: "The owner's email is required." };
      return { write: { step: "workos", clientId: clientId!, ...(apiKey ? { apiKey } : {}), ownerEmail }, done: "Sign-in saved. The owner can sign in to the dashboard now." };
    }
    case "/setup/github": {
      const appId = text(form, "app_id", 50);
      const slug = text(form, "slug", 100);
      const privateKey = text(form, "private_key", SECRET_MAX) ?? "";
      const webhookSecret = text(form, "webhook_secret", SECRET_MAX) ?? "";
      if (!appId || !/^\d{1,20}$/.test(appId)) return { error: "The App ID is a number." };
      if (!slug || !/^[a-z0-9-]{1,100}$/.test(slug)) return { error: "The slug is the app's URL name (lowercase letters, digits, dashes)." };
      if (privateKey && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) return { error: "The private key must be the PEM file's contents." };
      return {
        write: { step: "github", appId, slug, ...(privateKey ? { privateKey } : {}), ...(webhookSecret ? { webhookSecret } : {}) },
        done: "GitHub App saved.",
      };
    }
  }
  return notFound();
}

// ------------------------------------------------------------------ the handler

/** Answers every /setup path. */
export async function handleSetup(request: Request, deps: SetupDeps): Promise<Response> {
  const url = new URL(request.url);
  const now = (deps.now ?? Date.now)();
  const token = deps.setupToken;
  if (!token) return notFound();
  if (!deps.open && (await setupComplete(deps))) return notFound();

  if (url.pathname === "/setup/login") {
    if (request.method !== "POST") return redirect("/setup");
    const form = await readForm(request);
    if (!form || !(await constantTimeEqual(form.get("token") ?? "", token))) return loginPage(401, "Wrong setup token.");
    const exp = Math.floor(now / 1000) + COOKIE_TTL_S;
    const value = `${exp}.${await hmac(await cookieKey(token), `session.${exp}`)}`;
    const secure = url.protocol === "https:" || deps.publicUrl?.startsWith("https://") ? "; Secure" : "";
    return redirect("/setup", { "set-cookie": `${COOKIE}=${value}; Path=/setup; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_TTL_S}${secure}` });
  }

  const auth = await authenticate(request, token, now);
  if (!auth) return request.method === "GET" && url.pathname === "/setup" && !request.headers.has("authorization") ? loginPage(401) : loginPage(401, "Not signed in.");

  if (request.method === "GET") {
    if (url.pathname === "/setup") return overview(deps, auth);
    if (url.pathname === "/setup/slack/manifest.json") {
      if (!deps.publicUrl?.startsWith("https://")) return page(409, "No public URL", `<p>Set <code>PUBLIC_URL</code> to an https origin first.</p>${back}`);
      return new Response(JSON.stringify(slackManifest(deps.publicUrl), null, 2), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return notFound();
  }
  if (request.method !== "POST") return notFound();

  if (url.pathname === "/setup/logout") {
    const form = (await readForm(request)) ?? new URLSearchParams();
    if (!(await csrfOk(request, auth, form, deps.publicUrl))) return page(403, "Forbidden", `<p>Stale form; reload setup.</p>${back}`);
    return redirect("/setup", { "set-cookie": `${COOKIE}=; Path=/setup; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  const form = await readForm(request);
  if (!form) return page(400, "Bad request", `<p>Send the form as application/x-www-form-urlencoded, at most 64 KiB.</p>${back}`);
  if (!(await csrfOk(request, auth, form, deps.publicUrl))) return page(403, "Forbidden", `<p>Stale form; reload setup.</p>${back}`);

  const outcome = await step(url.pathname, form, deps);
  if (outcome instanceof Response) return outcome;
  if (outcome.error) return page(400, "Not saved", `<p class="err">${esc(outcome.error)}</p>${back}`);
  if (outcome.write) {
    await deps.store.write(outcome.write);
    if (outcome.write.step === "claude" || outcome.write.step === "claude-delete") await deps.modelKeyChanged();
  }
  // A completed setup locks: the next GET is a 404 unless SP_SETUP_OPEN=1, so say so here.
  if (!deps.open && (await setupComplete(deps))) {
    return page(200, "Setup complete", `<p class="done">${esc(outcome.done ?? "Saved.")}</p><p>The required steps are done, so /setup now answers 404. Set <code>SP_SETUP_OPEN=1</code> and restart the gateway to change anything.</p>`);
  }
  return overview(deps, auth, outcome.done);
}
