// The instance /setup web flow and the GitHub webhook endpoint (work 045, item S3).
// Owned by S3; the gateway mounts these as Bolt customRoutes.
//
// Access: SETUP_TOKEN (a deployment secret). Open /setup?token=<SETUP_TOKEN> once; the
// gateway answers with a signed cookie (12 h, path /setup) and drops the token
// from the URL. Rotating SETUP_TOKEN invalidates every cookie. Forms carry a
// CSRF field derived from the cookie. Every step can be re-run.
//
// Steps: 1 Slack app (paste config refresh token → create → connect URLs →
// /slack/install), 2 GitHub App (manifest flow → install), 3 Claude credential,
// 4 people (not here yet: the gateway seeds them from env), 5 host tokens.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { CustomRoute } from '@slack/bolt';
import { appRequest, clearTokenCache, verifySignature } from '../github/app.js';
import { appManifest, convertManifest, installUrl, newAppUrl } from '../github/manifest.js';
import { log } from '../log.js';
import { issueHostToken, listHostTokens, revokeHostToken } from './hosts.js';
import { secretsDb, type SecretStore, type Secrets } from './secrets.js';
import { createSlackApp, slackApi, syncSlackManifest, type SlackSetupApi } from './slack.js';

export { checkHostToken, issueHostToken, listHostTokens, revokeHostToken } from './hosts.js';

export type SetupStep = 'slack' | 'github' | 'claude' | 'host';

export interface SetupDeps {
  secrets: Secrets;
  /** The gateway's public origin, e.g. https://calvin.example.com */
  origin: string;
  /** Called on a verified GitHub push: repo `owner/name`, ref `refs/heads/main`. */
  onPush(repo: string, ref: string): void;
  /** Database for host tokens; defaults to the one behind `secrets` (openSecrets). */
  db?: DatabaseSync;
  /** Slack calls; defaults to the real Web API. Injected by checks. */
  slack?: SlackSetupApi;
  /** A step stored new credentials (e.g. reload Bolt with the new Slack app). */
  onChange?(step: SetupStep): void;
}

/** True once the Slack app and its bot token exist (env or store). */
export function slackReady(secrets: Secrets): boolean {
  return !!(secrets.get('SLACK_SIGNING_SECRET') && secrets.get('SLACK_BOT_TOKEN'));
}

/** True once the Slack app exists, so Bolt can serve /slack/events and the OAuth install. */
export function slackAppReady(secrets: Secrets): boolean {
  return !!(secrets.get('SLACK_SIGNING_SECRET') && secrets.get('SLACK_CLIENT_ID') && secrets.get('SLACK_CLIENT_SECRET'));
}

// ---------------------------------------------------------------- html

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}
h2{margin-top:2rem;border-top:1px solid #ddd;padding-top:1rem}.done{color:#1a7f37}.pending{color:#9a6700}.err{color:#cf222e}
code,pre{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px}pre{padding:.6rem;overflow-x:auto}
input[type=text],input[type=password]{width:100%;padding:.3rem;box-sizing:border-box}label{display:block;margin:.4rem 0}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(html);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end();
}

const back = '<p><a href="/setup">Back to setup</a></p>';

// ---------------------------------------------------------------- auth

const COOKIE = 'sp_setup';
const COOKIE_TTL_S = 12 * 3600;
const STATE_TTL_S = 3600;

function key(): Buffer | undefined {
  const t = process.env.SETUP_TOKEN;
  return t ? createHmac('sha256', t).update('slack-presence setup v1').digest() : undefined;
}

const mac = (k: Buffer, msg: string) => createHmac('sha256', k).update(msg).digest('base64url');

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
}

function validSession(k: Buffer, v: string | undefined): boolean {
  const m = v?.match(/^(\d+)\.([A-Za-z0-9_-]+)$/);
  return !!m && Number(m[1]) > Date.now() / 1000 && safeEq(m[2], mac(k, `session.${m[1]}`));
}

const csrfFor = (k: Buffer, session: string) => mac(k, `csrf.${session}`);

/** Signed, time-limited state for the GitHub manifest round trip. */
function makeState(k: Buffer) {
  const body = `${Math.floor(Date.now() / 1000)}.${randomBytes(12).toString('base64url')}`;
  return `${body}.${mac(k, `gh-state.${body}`)}`;
}

function validState(k: Buffer, s: string | null): boolean {
  const m = s?.match(/^((\d+)\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  return !!m && Date.now() / 1000 - Number(m[2]) < STATE_TTL_S && safeEq(m[3], mac(k, `gh-state.${m[1]}`));
}

interface Ctx {
  url: URL;
  k: Buffer;
  csrf: string;
}

/** Runs `handler` only for an authorized browser; handles ?token= and the cookie. */
function guarded(origin: string, handler: (req: IncomingMessage, res: ServerResponse, ctx: Ctx) => Promise<void> | void) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://setup.local');
      const k = key();
      if (!k) return send(res, 503, page('Setup unavailable', '<p>Set <code>SETUP_TOKEN</code> in the gateway environment to enable /setup.</p>'));
      const given = url.searchParams.get('token');
      if (given !== null && req.method === 'GET') {
        if (!safeEq(given, process.env.SETUP_TOKEN!)) return send(res, 401, page('Not authorized', '<p>Wrong setup token.</p>'));
        const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_S;
        const secure = origin.startsWith('https:') ? '; Secure' : '';
        url.searchParams.delete('token');
        return redirect(res, url.pathname + url.search, {
          'Set-Cookie': `${COOKIE}=${exp}.${mac(k, `session.${exp}`)}; Path=/setup; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_S}${secure}`,
        });
      }
      const session = cookieValue(req);
      if (!validSession(k, session))
        return send(res, 401, page('Not authorized', '<p>Open <code>/setup?token=&lt;SETUP_TOKEN&gt;</code> to sign in.</p>'));
      const ctx: Ctx = { url, k, csrf: csrfFor(k, session!) };
      if (req.method === 'POST') {
        const form = await readForm(req);
        if (!safeEq(form.get('csrf') ?? '', ctx.csrf)) return send(res, 403, page('Forbidden', '<p>Stale form; reload /setup.</p>'));
        (req as any).form = form;
      }
      await handler(req, res, ctx);
    } catch (e: any) {
      log.warn('setup:', e?.message ?? e);
      if (!res.headersSent) send(res, 500, page('Setup step failed', `<p class="err">${esc(e?.message ?? e)}</p>${back}`));
    }
  };
}

// ---------------------------------------------------------------- bodies

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readForm(req: IncomingMessage) {
  return new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'));
}

const formOf = (req: IncomingMessage): URLSearchParams => (req as any).form;

// ---------------------------------------------------------------- status

function status(secrets: Secrets, names: string[]): 'done' | 'pending' | 'error' {
  try {
    return names.every((n) => secrets.get(n)) ? 'done' : 'pending';
  } catch {
    return 'error';
  }
}

function safeGet(secrets: Secrets, name: string): string | undefined {
  try {
    return secrets.get(name);
  } catch {
    return undefined;
  }
}

const fromEnv = (secrets: Secrets, name: string) => (secrets as Partial<SecretStore>).source?.(name) === 'env';

const badge = (s: string) => `<span class="${s === 'error' ? 'err' : s}">${s}</span>`;
const hidden = (ctx: Ctx) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`;

function statusPage(deps: SetupDeps, ctx: Ctx): string {
  const { secrets, origin } = deps;
  const db = deps.db ?? secretsDb(secrets);
  const g = (n: string) => esc(safeGet(secrets, n));
  const writable = !!process.env.SP_STORE_KEY;
  const slackApp = status(secrets, ['SLACK_APP_ID', 'SLACK_SIGNING_SECRET']);
  const slackInst = status(secrets, ['SLACK_BOT_TOKEN']);
  const ghApp = status(secrets, ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY']);
  const ghInst = status(secrets, ['GITHUB_INSTALLATION_ID']);
  const claude = safeGet(secrets, 'CLAUDE_CODE_OAUTH_TOKEN') ? 'done (setup-token)' : safeGet(secrets, 'ANTHROPIC_API_KEY') ? 'done (API key)' : 'pending';
  const hosts = db ? listHostTokens(db) : [];
  // Required, no default: the organization the GitHub App is created in.
  const org = process.env.GITHUB_ORG?.trim();
  const appName = `${process.env.SLACK_APP_NAME ?? 'Computer'} ${org}`;

  return page(
    'slack-presence setup',
    `<p>Origin <code>${esc(origin)}</code>. Every step can be re-run to repair or rotate.</p>
${writable ? '' : '<p class="err">SP_STORE_KEY is not set: nothing can be saved. Set it (<code>openssl rand -hex 32</code>) as a secret and restart.</p>'}

<h2>1. Slack app: ${badge(slackApp)}, installed: ${badge(slackInst)}</h2>
${slackApp === 'done' ? `<p>App <code>${g('SLACK_APP_ID')}</code>${safeGet(secrets, 'SLACK_TEAM_ID') ? ` in team <code>${g('SLACK_TEAM_ID')}</code>` : ''}.</p>` : ''}
<form method="post" action="/setup/slack">${hidden(ctx)}
<p>Generate a configuration token at <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a> → <i>Your App Configuration Tokens</i> → Generate Token, and paste the <b>refresh token</b> (<code>xoxe-1-…</code>).${safeGet(secrets, 'SLACK_CONFIG_REFRESH_TOKEN') ? ' A refresh token is stored; leave empty to use it.' : ''}</p>
<label>Refresh token <input type="password" name="refresh_token" autocomplete="off"></label>
<button>${slackApp === 'done' ? 'Point the app at this origin' : 'Create the Slack app'}</button></form>
${slackApp === 'done' ? `<p>Then install it: <a href="/slack/install">${esc(origin)}/slack/install</a></p>` : ''}

<h2>2. GitHub App: ${badge(ghApp)}, installed: ${badge(ghInst)}</h2>
${ghApp === 'done' ? `<p>App <code>${g('GITHUB_APP_SLUG')}</code> (id ${g('GITHUB_APP_ID')}) owned by <code>${g('GITHUB_APP_OWNER')}</code>${ghInst === 'done' ? `, installation ${g('GITHUB_INSTALLATION_ID')} on <code>${g('GITHUB_INSTALLATION_ACCOUNT')}</code>` : ''}.
 <a href="${esc(installUrl(safeGet(secrets, 'GITHUB_APP_SLUG') ?? ''))}">Install or change repositories</a>.</p>
<p>Creating again makes a <b>new</b> app and replaces the stored one.</p>` : ''}
${
  org
    ? `<form method="post" action="/setup/github">${hidden(ctx)}
<p>You need to be an owner or GitHub App manager of the organization. You'll click <b>Create GitHub App</b> on GitHub, then pick repositories.</p>
<label>Organization (empty: your personal account) <input type="text" name="org" value="${esc(org)}"></label>
<label>App name (unique on GitHub) <input type="text" name="name" value="${esc(appName)}"></label>
<button>Create the GitHub App on GitHub</button></form>`
    : '<p class="err">GITHUB_ORG is not set: the GitHub App cannot be created from here. Set it to the GitHub organization that will own the app and restart.</p>'
}

<h2>3. Claude credential: ${badge(claude.startsWith('done') ? 'done' : 'pending')}</h2>
${claude.startsWith('done') ? `<p>${esc(claude)}${fromEnv(secrets, 'CLAUDE_CODE_OAUTH_TOKEN') || fromEnv(secrets, 'ANTHROPIC_API_KEY') ? ', from the environment (overrides the store)' : ''}.</p>` : ''}
<form method="post" action="/setup/claude">${hidden(ctx)}
<p>Paste a token from <code>claude setup-token</code> (<code>sk-ant-oat…</code>) or an Anthropic API key (<code>sk-ant-api…</code>).</p>
<label>Token <input type="password" name="token" autocomplete="off"></label>
<button>Save</button></form>

<h2>4. People: <span class="pending">from the environment</span></h2>
<p>Not configured here yet: the gateway seeds the people table from its environment.</p>

<h2>5. Hosts: ${hosts.length ? `<span class="done">${hosts.length} token(s)</span>` : '<span class="pending">pending</span>'}</h2>
${hosts.length ? `<ul>${hosts.map((h) => `<li><code>${esc(h.id)}</code> ${esc(h.label)}, issued ${esc(h.createdAt)}, last used ${esc(h.lastUsedAt ?? 'never')} <form method="post" action="/setup/host/revoke" style="display:inline">${hidden(ctx)}<input type="hidden" name="id" value="${esc(h.id)}"><button>Revoke</button></form></li>`).join('')}</ul>` : ''}
<form method="post" action="/setup/host">${hidden(ctx)}
<label>Host name <input type="text" name="label" value="vm-1"></label>
<button>Issue a host token</button></form>`,
  );
}

// ---------------------------------------------------------------- routes

export function setupRoutes(deps: SetupDeps): CustomRoute[] {
  const { secrets, origin } = deps;
  const slack = () => (deps.slack ??= slackApi());
  const changed = (step: SetupStep) => {
    try {
      deps.onChange?.(step);
    } catch (e: any) {
      log.warn(`setup: onChange(${step}) failed:`, e?.message ?? e);
    }
  };
  const db = () => {
    const d = deps.db ?? secretsDb(secrets);
    if (!d) throw new Error('no database for host tokens (pass deps.db)');
    return d;
  };

  const route = (method: string, path: string, h: Parameters<typeof guarded>[1]): CustomRoute => ({ method, path, handler: guarded(origin, h) });

  return [
    route('GET', '/setup', (_req, res, ctx) => send(res, 200, statusPage(deps, ctx))),

    // 1. Slack app
    route('POST', '/setup/slack', async (req, res, ctx) => {
      const refresh = formOf(req).get('refresh_token')?.trim();
      if (refresh) {
        const word = refresh.split(/\s+/).find((w) => /^xoxe-\d/.test(w));
        if (!word) return send(res, 400, page('Not a refresh token', `<p class="err">A refresh token starts with <code>xoxe-1-</code> (not <code>xoxe.xoxp-</code>).</p>${back}`));
        secrets.set('SLACK_CONFIG_REFRESH_TOKEN', word);
        secrets.set('SLACK_CONFIG_TOKEN', '');
        secrets.set('SLACK_CONFIG_TOKEN_EXP', '0');
      }
      const { appId, created } = await createSlackApp(secrets, slack());
      if (created) {
        changed('slack');
        return send(
          res,
          200,
          page(
            'Slack app created',
            `<p>Created <code>${esc(appId)}</code>. The gateway is loading its credentials; then connect the app's URLs to <code>${esc(origin)}</code> (Slack checks them right away).</p>
<form method="post" action="/setup/slack/sync">${hidden(ctx)}<button>Connect URLs</button></form>${back}`,
          ),
        );
      }
      await syncAndOffer(res);
    }),
    route('POST', '/setup/slack/sync', async (_req, res) => syncAndOffer(res)),

    // 2. GitHub App
    route('POST', '/setup/github', (req, res, ctx) => {
      const f = formOf(req);
      const org = (f.get('org') ?? '').trim();
      const name = (f.get('name') ?? '').trim();
      if (org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) return send(res, 400, page('Bad organization', `<p class="err">Not a GitHub organization name.</p>${back}`));
      if (!name || name.length > 100) return send(res, 400, page('Bad name', `<p class="err">Give the app a name.</p>${back}`));
      const action = newAppUrl(org, makeState(ctx.k));
      const manifest = JSON.stringify(appManifest(origin, name));
      send(
        res,
        200,
        page(
          'Creating the GitHub App',
          `<p>Sending you to GitHub to create <b>${esc(name)}</b>${org ? ` in <b>${esc(org)}</b>` : ''}…</p>
<form id="m" method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(manifest)}"><button>Continue to GitHub</button></form>
<script>document.getElementById('m').submit()</script>`,
        ),
      );
    }),
    route('GET', '/setup/github/created', async (_req, res, ctx) => {
      const code = ctx.url.searchParams.get('code');
      if (!validState(ctx.k, ctx.url.searchParams.get('state')))
        return send(res, 400, page('GitHub App not saved', `<p class="err">Missing, expired or forged state. Start the GitHub step again.</p>${back}`));
      if (!code) return send(res, 400, page('GitHub App not saved', `<p class="err">GitHub returned no code.</p>${back}`));
      const { slug } = await convertManifest(secrets, code);
      changed('github');
      redirect(res, installUrl(slug));
    }),
    route('GET', '/setup/github/installed', async (_req, res, ctx) => {
      const id = ctx.url.searchParams.get('installation_id');
      if (!id || !/^\d{1,20}$/.test(id)) return send(res, 400, page('Installation not saved', `<p class="err">No installation_id.</p>${back}`));
      // Setup URLs can be hit with a spoofed id; ask GitHub, as the app, whether it is ours.
      const inst = await appRequest(secrets, 'GET', `/app/installations/${id}`);
      secrets.set('GITHUB_INSTALLATION_ID', String(inst.id));
      secrets.set('GITHUB_INSTALLATION_ACCOUNT', inst.account?.login ?? '');
      clearTokenCache();
      changed('github');
      send(
        res,
        200,
        page(
          'GitHub App installed',
          `<p>Installation ${esc(inst.id)} on <code>${esc(inst.account?.login)}</code>, ${esc(inst.repository_selection === 'all' ? 'all repositories' : 'selected repositories')}.</p>${back}`,
        ),
      );
    }),

    // 3. Claude credential
    route('POST', '/setup/claude', (req, res) => {
      const token = (formOf(req).get('token') ?? '').trim();
      const name = /^sk-ant-oat/.test(token) ? 'CLAUDE_CODE_OAUTH_TOKEN' : /^sk-ant-api/.test(token) ? 'ANTHROPIC_API_KEY' : undefined;
      if (!name || /\s/.test(token))
        return send(res, 400, page('Not saved', `<p class="err">Expected a <code>sk-ant-oat…</code> setup-token or a <code>sk-ant-api…</code> API key.</p>${back}`));
      // Exactly one credential (HostCredentials).
      secrets.set(name, token);
      secrets.set(name === 'ANTHROPIC_API_KEY' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY', '');
      changed('claude');
      redirect(res, '/setup');
    }),

    // 5. Host tokens
    route('POST', '/setup/host', (req, res) => {
      const label = (formOf(req).get('label') ?? '').trim().slice(0, 64) || 'host';
      const token = issueHostToken(db(), label);
      changed('host');
      send(
        res,
        200,
        page(
          'Host token issued',
          `<p>Token for <b>${esc(label)}</b>. It is shown once; only its hash is kept.</p>
<pre>SP_GATEWAY_URL=${esc(origin)}\nSP_HOST_TOKEN=${esc(token)}</pre>
<p>Give both to the host's provisioning script; the host dials the gateway with <code>Authorization: Bearer $SP_HOST_TOKEN</code>.</p>${back}`,
        ),
      );
    }),
    route('POST', '/setup/host/revoke', (req, res) => {
      revokeHostToken(db(), formOf(req).get('id') ?? '');
      redirect(res, '/setup');
    }),

    // GitHub webhooks: not behind the setup cookie; the signature is the auth.
    {
      method: 'POST',
      path: '/github/events',
      handler: async (req, res) => {
        try {
          const body = await readBody(req, 25 * 1024 * 1024);
          const sig = req.headers['x-hub-signature-256'];
          let secret: string;
          try {
            secret = secrets.get('GITHUB_WEBHOOK_SECRET') ?? '';
          } catch {
            secret = '';
          }
          if (!verifySignature(secret, body, Array.isArray(sig) ? sig[0] : sig)) {
            res.writeHead(401).end('bad signature');
            return;
          }
          const event = req.headers['x-github-event'];
          if (event === 'push') {
            const p = JSON.parse(body.toString('utf8'));
            const repo = p?.repository?.full_name;
            // Hosts fetch only for the branch forks start from (they know it per clone); tags, deletions
            // and sessions' own sp/* branches never are, so they don't reach the hosts at all.
            const ref = p?.ref;
            if (typeof repo === 'string' && typeof ref === 'string' && ref.startsWith('refs/heads/') && !ref.startsWith('refs/heads/sp/') && !p.deleted)
              deps.onPush(repo, ref);
            res.writeHead(200).end('ok');
          } else if (event === 'ping') res.writeHead(200).end('pong');
          else res.writeHead(202).end('ignored');
        } catch (e: any) {
          log.warn('github webhook:', e?.message ?? e);
          if (!res.headersSent) res.writeHead(400).end('bad request');
        }
      },
    },
  ];

  async function syncAndOffer(res: ServerResponse) {
    const reinstall = await syncSlackManifest(secrets, slack(), origin);
    changed('slack');
    send(
      res,
      200,
      page(
        'Slack app connected',
        `<p>Events, interactivity and the OAuth redirect now point at <code>${esc(origin)}</code>.${reinstall ? ' Scopes changed: reinstall.' : ''}</p>
<p><a href="/slack/install">Install the app into the workspace</a> (the bot token is stored by the gateway's OAuth flow).</p>${back}`,
      ),
    );
  }
}
