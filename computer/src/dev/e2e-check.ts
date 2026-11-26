// End to end on one machine, no real Slack and no real GitHub (work 045, S6):
//
//   fake Slack + GitHub API (HTTP, in this process)
//     ▲ every Slack call: the gateway's Bolt client, /setup, OAuth, and the runners' WebClient
//   gateway (child: src/gateway/main.ts, temp SQLite)  ◀── signed Slack events / actions / webhooks from here
//     ▲ WebSocket, host token issued by /setup
//   host agent (child: src/host/main.ts, laptop mode, detached runners, workspace definition of local bare repos)
//     ▲ unix sockets in /tmp/spe2e/run
//   runners (real processes, real Claude: a few one-word turns)
//
// Drives: /setup (Slack app by manifest API, host token, OAuth install → credentials pushed to the host),
// a mention → fork → runner → Claude turn; a thread reply; a mid-turn message (👀); !status; !mode default and
// a permission button routed by its action id; spawn_thread (work 047: brief check, approval, new top-level
// thread owned by the same person, its first turn reading the brief); host killed and restarted under a live runner; GitHub token via
// the credential helper and the gh shim (owner stripped); a signed push webhook → fetch; gateway restarted
// (SIGTERM, same db) → host reconnects, session table persists. Prints the latency rows measurable here.
//
//   npx tsx src/dev/e2e-check.ts [--keep] [--pool]   --pool: the host keeps one spare runner (work 069)

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeActionId, type Person } from '../protocol.js';
import { checkBrief } from '../runner/spawn.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const KEEP = process.argv.includes('--keep');
const POOL = process.argv.includes('--pool');
const BASE = '/tmp/spe2e'; // short: unix socket paths are limited to ~104 bytes on macOS
const DATA = path.join(BASE, 'data');
const RUN = path.join(BASE, 'run');
const DB = path.join(BASE, 'gateway.db');
const LOGS = path.join(BASE, 'logs');
const t0 = performance.now();
const now = () => performance.now() - t0;
const say = (...a: unknown[]) => console.log(`+${(now() / 1000).toFixed(2)}s`, ...a);
let failed = 0;
let passed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  ok ? passed++ : failed++;
  say(ok ? 'PASS' : 'FAIL', what, !ok && detail !== undefined ? JSON.stringify(detail).slice(0, 400) : '');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000, every = 20): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await f();
    if (v) return v;
  }
}
const latency: [string, string, string][] = [];
const ms = (x: number | undefined) => (x === undefined ? 'n/a' : `${Math.round(x)} ms`);

// ---------------------------------------------------------------- scratch area

if (existsSync(BASE)) {
  if (!existsSync(path.join(BASE, '.e2e'))) throw new Error(`${BASE} exists and is not ours; remove it first`);
  for (const f of existsSync(path.join(RUN, 'runners')) ? readdirSync(path.join(RUN, 'runners')) : [])
    if (f.endsWith('.pid')) kill(Number(readFileSync(path.join(RUN, 'runners', f), 'utf8')), 'SIGTERM'); // runners of an earlier run of this check
  rmSync(BASE, { recursive: true, force: true });
}
mkdirSync(LOGS, { recursive: true });
writeFileSync(path.join(BASE, '.e2e'), '');
const gitconfig = path.join(BASE, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = e2e\n\temail = e2e@localhost\n[init]\n\tdefaultBranch = main\n');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Two remotes, acme/alpha and acme/beta, and a definition naming them.
const remotes = path.join(BASE, 'remotes', 'acme');
for (const name of ['alpha', 'beta']) {
  const bare = path.join(remotes, `${name}.git`);
  const scratch = path.join(BASE, 'scratch', name);
  mkdirSync(scratch, { recursive: true });
  git(BASE, 'init', '-q', '--bare', '-b', 'main', bare);
  git(scratch, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(scratch, 'README.md'), `# ${name}\n`);
  git(scratch, 'add', '-A');
  git(scratch, 'commit', '-qm', 'init');
  git(scratch, 'push', '-q', bare, 'main');
}
mkdirSync(path.join(BASE, 'def'));
writeFileSync(path.join(BASE, 'def', 'root.md'), '# e2e workspace\nTwo repositories: alpha and beta. Answer briefly.\n');
const DEFINITION = path.join(BASE, 'def', 'e2e.json');
writeFileSync(
  DEFINITION,
  JSON.stringify({
    name: 'e2e',
    repos: ['alpha', 'beta'].map((n) => ({ name: n, remote: `file://${remotes}/${n}.git` })),
    rootFiles: { 'AGENTS.md': 'root.md' },
  }),
);

// ---------------------------------------------------------------- fake Slack and GitHub

interface Call {
  method: string;
  args: any;
  at: number;
  result?: any;
}
const calls: Call[] = [];
const gh: { method: string; path: string; auth?: string; body?: any }[] = [];
const SIGNING = 'e2e-signing-' + randomBytes(8).toString('hex');
let tsN = 0;
const slackResult = (method: string, args: any): any => {
  switch (method) {
    case 'tooling.tokens.rotate':
      return { token: 'xoxe.xoxp-1-e2e-config', refresh_token: 'xoxe-1-e2e-next', exp: Math.floor(Date.now() / 1000) + 43200 };
    case 'apps.manifest.create':
      return { app_id: 'A_E2E', credentials: { client_id: '111.222', client_secret: 'e2e-client-secret', signing_secret: SIGNING, verification_token: 'v' } };
    case 'apps.manifest.update':
      return { app_id: 'A_E2E', permissions_updated: false };
    case 'oauth.v2.access':
      return {
        app_id: 'A_E2E', authed_user: { id: 'U_OWNER' }, scope: 'chat:write', token_type: 'bot', access_token: 'xoxb-e2e-installed',
        bot_user_id: 'U_BOT', team: { id: 'T_E2E', name: 'E2E team' }, enterprise: null, is_enterprise_install: false,
      };
    case 'auth.test':
      return { url: 'https://e2e.slack.com/', team: 'E2E team', user: 'bot', team_id: 'T_E2E', user_id: 'U_BOT', bot_id: 'B_BOT' };
    case 'chat.getPermalink':
      return { permalink: `https://e2e.slack.com/archives/${args.channel}/p${String(args.message_ts).replace('.', '')}` };
    case 'users.info':
      return { user: { id: args.user, name: 'owner', profile: { display_name: 'owner' } } };
    default:
      return { ts: `${Math.floor(Date.now() / 1000)}.${String(++tsN).padStart(6, '0')}`, channel: args.channel ?? args.channel_id, channel_id: 'C_CODE' };
  }
};
const readBody = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let s = '';
    req.setEncoding('utf8').on('data', (d) => (s += d)).on('end', () => ok(s));
  });
const fake = createServer(async (req, res) => {
  const raw = await readBody(req);
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const method = url.pathname.slice(5);
    let args: any = {};
    if ((req.headers['content-type'] ?? '').includes('json')) args = raw ? JSON.parse(raw) : {};
    else for (const [k, v] of new URLSearchParams(raw)) args[k] = /^[[{]/.test(v) ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v;
    const result = slackResult(method, args);
    calls.push({ method, args, at: now(), result });
    appendFileSync(path.join(LOGS, 'slack.log'), `+${(now() / 1000).toFixed(2)}s ${method} ${JSON.stringify(args).slice(0, 300)}\n`);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...result }));
  }
  if (url.pathname.startsWith('/github/')) {
    const p = url.pathname.slice(7);
    const body = raw ? JSON.parse(raw) : undefined;
    gh.push({ method: req.method!, path: p, auth: req.headers.authorization, body });
    const m = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (req.method === 'POST' && m)
      return void res
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ token: `ghs_e2e_${(body?.repositories ?? ['all']).join('+')}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
    return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not Found"}');
  }
  res.writeHead(404).end();
});
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok));
const FAKE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
const callsSince = (at: number, method: string, f: (c: Call) => unknown = () => true) => calls.filter((c) => c.at >= at && c.method === method && f(c));
const firstCall = (at: number, method: string | RegExp, f: (c: Call) => unknown = () => true) =>
  calls.find((c) => c.at >= at && (typeof method === 'string' ? c.method === method : method.test(c.method)) && f(c));

// ---------------------------------------------------------------- processes

const freePort = async () => {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const p = (s.address() as AddressInfo).port;
  await new Promise((ok) => s.close(ok));
  return p;
};
const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SETUP_TOKEN = 'e2e-setup-' + randomBytes(8).toString('hex');
const STORE_KEY = randomBytes(32).toString('hex');
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const owner: Person = { slackUserId: 'U_OWNER', dir: 'owner', gitName: 'Owner E2E', gitEmail: 'owner@e2e.local' };
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** The parent's environment without anything that could reach real Slack/GitHub or carry live credentials. */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(SLACK_|GITHUB_|SP_|SETUP_TOKEN|NGROK|PUBLIC_URL|WORKDIR|RUNNER_SPEC|GIT_CONFIG)/.test(k)),
  ) as Record<string, string>;

const logLines: Record<string, { at: number; line: string }[]> = { gateway: [], host: [] };
function child(name: 'gateway' | 'host', script: string, env: Record<string, string>): ChildProcess {
  const c = spawn(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [c.stdout!, c.stderr!])
    s.setEncoding('utf8').on('data', (d: string) => {
      for (const line of d.split('\n').filter(Boolean)) {
        logLines[name].push({ at: now(), line });
        appendFileSync(path.join(LOGS, `${name}.log`), line + '\n');
      }
    });
  return c;
}
const logged = (name: 'gateway' | 'host', re: RegExp, since = 0) => logLines[name].find((l) => l.at >= since && re.test(l.line));

function startGateway() {
  return child('gateway', 'src/gateway/main.ts', {
    ...cleanEnv(),
    PORT: String(PORT), SP_DB: DB, SP_ORIGIN: ORIGIN, SP_VERSION: 'e2e', SETUP_TOKEN, SP_STORE_KEY: STORE_KEY,
    SP_PEOPLE: JSON.stringify([owner]), SP_SLACK_API_URL: `${FAKE}/api/`, SP_GITHUB_API_URL: `${FAKE}/github`,
    GITHUB_APP_ID: '4242', GITHUB_PRIVATE_KEY: pem, GITHUB_INSTALLATION_ID: '42', GITHUB_INSTALLATION_ACCOUNT: 'acme',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
}
let hostToken = '';
function startHost() {
  return child('host', 'src/host/main.ts', {
    ...cleanEnv(),
    SP_GATEWAY_URL: `ws://127.0.0.1:${PORT}/host`, SP_HOST_TOKEN: hostToken, SP_HOST_ID: 'e2e-host',
    SP_RUN: RUN, SP_DATA: DATA, SP_DEFINITION: DEFINITION, SP_LAUNCH: 'detached', SP_FETCH_INTERVAL: '1h',
    SP_SLACK_API_URL: `${FAKE}/api/`, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', SP_POOL_SIZE: POOL ? '1' : '0',
  });
}
function kill(pid: number, sig: NodeJS.Signals) {
  try {
    if (pid > 0) process.kill(pid, sig);
  } catch {}
}
const alive = (pid: number) => {
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch {
    return false;
  }
};
/** Run a command without blocking this process (it serves the fake GitHub the command ends up calling). */
function run(cmd: string, args: string[], env: Record<string, string>, input = ''): Promise<string> {
  return new Promise((ok, fail) => {
    const c = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    c.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    c.on('error', fail).on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${path.basename(cmd)} exited ${code}: ${err}`))));
    c.stdin.end(input);
  });
}
const exited = (c: ChildProcess) => new Promise<void>((ok) => (c.exitCode !== null || c.signalCode !== null ? ok() : c.once('exit', () => ok())));

// ---------------------------------------------------------------- HTTP helpers (a browser, and Slack's side)

const health = async () => {
  try {
    const r = await fetch(`${ORIGIN}/healthz`);
    return r.ok ? ((await r.json()) as { ok: boolean; mode: string; version: string; hosts: string[] }) : undefined;
  } catch {
    return undefined;
  }
};
let cookie = '';
async function browse(p: string, init: RequestInit = {}) {
  const r = await fetch(ORIGIN + p, { redirect: 'manual', ...init, headers: { cookie, ...(init.headers as any) } });
  for (const c of r.headers.getSetCookie()) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
  return r;
}
let csrf = '';
const post = (p: string, form: Record<string, string>) =>
  browse(p, { method: 'POST', body: new URLSearchParams({ csrf, ...form }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } as any });

function signed(body: string, contentType: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = 'v0=' + createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex');
  return { method: 'POST', body, headers: { 'content-type': contentType, 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig } };
}
let evN = 0;
/** POST a signed event_callback; returns when the gateway acked, with the time it was sent. */
async function event(ev: Record<string, unknown>) {
  const body = JSON.stringify({
    token: 'v', team_id: 'T_E2E', api_app_id: 'A_E2E', type: 'event_callback', event_id: `Ev${Date.now()}${++evN}`,
    event_time: Math.floor(Date.now() / 1000), event: { event_ts: ev.ts, ...ev },
    authorizations: [{ team_id: 'T_E2E', user_id: 'U_BOT', is_bot: true }],
  });
  const at = now();
  const r = await fetch(`${ORIGIN}/slack/events`, signed(body, 'application/json'));
  return { at, status: r.status, ack: now() - at };
}
const CH = 'C_E2E';
const newTs = () => `${Math.floor(Date.now() / 1000)}.${String(++evN).padStart(6, '0')}`;
const THREAD = newTs();
const KEY = `${CH}:${THREAD}`;
const reply = (text: string, ts = newTs()) => event({ type: 'message', channel: CH, channel_type: 'channel', user: owner.slackUserId, text, ts, thread_ts: THREAD });
async function click(actionId: string, value: string) {
  const payload = {
    type: 'block_actions', team: { id: 'T_E2E' }, user: { id: owner.slackUserId, name: 'owner' }, api_app_id: 'A_E2E', token: 'v',
    container: { type: 'message', channel_id: CH, is_ephemeral: false }, trigger_id: '1.2.3', channel: { id: CH, name: 'e2e' },
    actions: [{ type: 'button', action_id: actionId, block_id: 'b1', value, action_ts: String(Date.now() / 1000) }],
  };
  const r = await fetch(`${ORIGIN}/slack/events`, signed(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), 'application/x-www-form-urlencoded'));
  return r.status;
}

const sessionRow = () => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM sessions WHERE key = ?').get(KEY) as any;
  } finally {
    db.close();
  }
};
/** The session's runner socket: runners are named by an id the host logs when it starts or claims one (work 069). */
const sockOf = (key: string) => {
  const id = logLines.host.map((l) => l.line.match(/runner (\w+) (?:up|claimed) for (\S+)/)).find((m) => m?.[2] === key)?.[1];
  return id ? path.join(RUN, 'runners', `${id}.sock`) : '';
};
const runnerPid = () => {
  const pid = sockOf(KEY).replace(/\.sock$/, '.pid');
  return pid && existsSync(pid) ? Number(readFileSync(pid, 'utf8')) : 0;
};
const inThread = (c: Call) => c.args.channel === CH && (c.args.thread_ts === THREAD || c.args.thread_ts === undefined);
const streamed = (since: number) => firstCall(since, /^chat\.(startStream|appendStream|postMessage)$/, (c) => inThread(c) && !/cwd|mode →/.test(JSON.stringify(c.args)));
/** A turn that started after `since` ended: the runner set `active`, and reported idle to the session table. */
async function idle(since: number) {
  await until(() => firstCall(since, 'agents.sessions.setStatus', (c) => c.args.status === 'active' && c.args.thread_ts === THREAD), 120_000, 50);
  return until(() => sessionRow()?.status === 'idle' && sessionRow(), 5000, 50);
}
const textSince = (since: number) => calls.filter((c) => c.at >= since && inThread(c)).map((c) => JSON.stringify(c.args)).join('\n');

let gateway = startGateway();
let host: ChildProcess | undefined;
try {
  // ================================================================ setup mode → Slack mode
  const h0 = await until(health, 20_000, 50);
  check(h0?.mode === 'setup' && h0.version === 'e2e', 'gateway: /healthz 200 in setup mode, SP_VERSION reported', h0);

  let r = await browse(`/setup?token=${SETUP_TOKEN}`);
  check(r.status === 303 && cookie.includes('sp_setup='), '/setup: token exchanged for a cookie', r.status);
  const page = await (await browse('/setup')).text();
  csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
  check(!!csrf, '/setup: status page with a CSRF field');

  r = await post('/setup/host', { label: 'e2e-host' });
  hostToken = (await r.text()).match(/SP_HOST_TOKEN=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  check(hostToken.startsWith('sph_'), '/setup: host token issued', hostToken.slice(0, 6));

  host = startHost();
  check(!!(await until(() => logged('host', /connected to/), 20_000)), 'host dialed in with the /setup token (checkHostToken) while the gateway is in setup mode');

  r = await post('/setup/slack', { refresh_token: 'xoxe-1-e2e-refresh' });
  const created = await r.text();
  check(r.status === 200 && /Slack app created/.test(created), '/setup/slack: app created by apps.manifest.create', created.slice(0, 200));
  const h1 = await health();
  check(h1?.mode === 'slack', "onChange('slack'): Bolt swapped in without a restart; /healthz says slack", h1);
  check(!!(await until(() => logged('host', /connected to/) && h1?.hosts.includes('e2e-host'), 1000)), 'host link survived the switch to Slack mode', h1?.hosts);

  r = await post('/setup/slack/sync', {});
  const upd = callsSince(0, 'apps.manifest.update')[0];
  check(r.status === 200 && upd?.args.manifest?.settings?.event_subscriptions?.request_url === `${ORIGIN}/slack/events`, '/setup/slack/sync: manifest points at the origin', upd?.args.manifest?.settings);

  r = await browse('/slack/install');
  const authorize = r.headers.get('location') ?? '';
  const state = new URL(authorize, 'http://x').searchParams.get('state') ?? '';
  check(r.status === 302 && /oauth\/v2\/authorize/.test(authorize) && !!state, 'Bolt OAuth: /slack/install redirects to Slack with a state', r.status);
  const credsAt = now();
  r = await browse(`/slack/oauth_redirect?code=e2e-code&state=${encodeURIComponent(state)}`);
  check(r.status === 200 && callsSince(0, 'oauth.v2.access').length === 1, 'Bolt OAuth: callback exchanged the code', r.status);
  check(!!(await until(() => logged('host', /credentials refreshed/, credsAt), 5000)), "installationStore: bot token stored, `credentials` pushed to the host (no disconnect)");
  check(!logged('host', /connected to/, credsAt), 'host was not dropped by the install');

  // ================================================================ a session
  const ws = path.join(DATA, 'people', 'owner', 'ws');
  check(!!(await until(() => existsSync(path.join(ws, 'alpha', '.git')) && existsSync(path.join(ws, 'beta', '.git')), 30_000)), 'housekeeping after welcome cloned the workspace');

  // 1. mention → fork → runner → first Claude turn (cold)
  const mention = await event({ type: 'app_mention', channel: CH, user: owner.slackUserId, text: '<@U_BOT> Reply with exactly the word: pong', ts: THREAD });
  const dup = await event({ type: 'message', channel: CH, channel_type: 'channel', user: owner.slackUserId, text: '<@U_BOT> Reply with exactly the word: pong', ts: THREAD });
  check(mention.status === 200 && dup.status === 200, `events acked (${ms(mention.ack)})`);
  const status1 = await until(() => firstCall(mention.at, 'agents.sessions.setStatus', (c) => c.args.status === 'processing' && c.args.thread_ts === THREAD), 5000, 5);
  check(status1, 'gateway set status `processing` on receipt', calls.slice(-3));
  const up = await until(() => existsSync(sockOf(KEY)) && now(), 60_000, 10);
  check(up, 'runner started and listening');
  const chunk1 = await until(() => streamed(mention.at), 120_000, 10);
  check(chunk1, 'first output streamed to (fake) Slack');
  const row1 = await idle(mention.at);
  check(row1?.sdk_session_id && row1.fork_path, 'session table: idle, sdkSessionId and forkPath reported', row1);
  check(/pong/i.test(textSince(mention.at)), 'Claude answered "pong"', textSince(mention.at).slice(-300));
  check(callsSince(mention.at, 'agents.sessions.setStatus', (c) => c.args.status === 'active').length > 0, 'status back to `active` at turn end');
  const fork = row1?.fork_path ?? '';
  const forkInfo = existsSync(path.join(fork, '.fork.json')) ? JSON.parse(readFileSync(path.join(fork, '.fork.json'), 'utf8')) : undefined;
  check(forkInfo?.repos?.alpha?.branch === `sp/${KEY.replace(/[^a-zA-Z0-9]+/g, '-')}` && existsSync(path.join(fork, 'beta', 'README.md')) && existsSync(path.join(fork, 'AGENTS.md')),
    'fork: a git worktree per repository on sp/<key>, root files copied', forkInfo);
  const pid = runnerPid();
  const forkLog = logged('host', /forked \d+ repos for/)?.line.match(/in (\d+) ms/)?.[1];
  const upLog = logged('host', /runner \w+ up for C_E2E/)?.line.match(/in (\d+) ms/)?.[1];
  latency.push(['Something visible after sending (receipt → status set)', ms(status1 ? status1.at - mention.at : undefined), '< 1 s']);
  latency.push(['New thread: deliver → runner listening (cold, incl. fork)', `${ms(up ? up - mention.at : undefined)} (fork ${forkLog ?? '?'} ms, process up ${upLog ?? '?'} ms)`, '≈ 1–3 s']);
  latency.push(['New thread: deliver → first stream chunk (cold)', ms(chunk1 ? chunk1.at - mention.at : undefined), 'same as laptop']);

  // 2. thread reply into the live session (warm), with a mid-turn message
  const r2 = await reply('Use the Bash tool to run `sleep 6`, then reply with exactly the word: ping');
  const chunk2 = await until(() => streamed(r2.at), 120_000, 10);
  // A message while the turn runs (the sleep): queued into it, 👀 on the message.
  await until(() => firstCall(r2.at, /^chat\.(startStream|appendStream)$/, (c) => /sleep/.test(JSON.stringify(c.args))), 60_000, 20);
  const midTs = newTs();
  const mid = await reply('Also add the word: zebra', midTs);
  const eyes = await until(() => firstCall(mid.at, 'reactions.add', (c) => c.args.timestamp === midTs && c.args.name === 'eyes'), 30_000, 5);
  check(chunk2 && runnerPid() === pid, 'thread reply → same runner, streamed', { pid, now: runnerPid() });
  check(eyes, 'mid-turn message: 👀 from the runner (queued into the running turn)');
  await idle(mid.at);
  check(/ping/i.test(textSince(r2.at)), 'Claude answered "ping"');
  latency.push(['Reply into a live session: deliver → first stream chunk (warm)', ms(chunk2 ? chunk2.at - r2.at : undefined), 'model time only']);
  latency.push(['Reply into a live session: Slack event → runner acts (mid-turn 👀)', ms(eyes ? eyes.at - mid.at : undefined), '+ < 50 ms']);

  // 3. !status: the full hop with no model in it
  const st = await reply('!status');
  const stMsg = await until(() => firstCall(st.at, 'chat.postMessage', (c) => inThread(c) && /cwd/.test(String(c.args.text))), 10_000, 2);
  check(stMsg, '!status answered by the runner');
  latency.push(['Reply into a live session: Slack event → runner reply (!status, idle runner)', ms(stMsg ? stMsg.at - st.at : undefined), '+ < 50 ms']);

  // 4. !mode default, then a tool that needs permission; the button goes gateway → host → runner by its action id
  const md = await reply('!mode default');
  check(await until(() => firstCall(md.at, 'chat.postMessage', (c) => /mode →/.test(String(c.args.text))), 10_000), '!mode default');
  const perm = await reply('Use the Bash tool to run exactly this command and nothing else: touch e2e-perm.txt');
  const prompt = await until(() => firstCall(perm.at, 'chat.postMessage', (c) => JSON.stringify(c.args.blocks ?? '').includes('"p:')), 120_000, 20);
  const allow = (prompt?.args.blocks as any[] | undefined)?.flatMap((b) => b.elements ?? []).find((e: any) => decodeActionId(e.action_id ?? '')?.value === 'allow');
  check(allow && decodeActionId(allow.action_id)?.sessionKey === KEY, 'permission prompt posted with session-keyed action ids', prompt?.args.blocks);
  if (allow) {
    const clickAt = now();
    check((await click(allow.action_id, 'allow')) === 200, 'button click acked');
    const deleted = await until(() => firstCall(clickAt, 'chat.delete'), 30_000);
    check(deleted, 'runner resolved the prompt (prompt message deleted)');
    await idle(clickAt);
    check(existsSync(path.join(fork, 'e2e-perm.txt')), 'allowed tool ran in the fork');
  }

  // 4b. spawn_thread (work 047): the brief must be on origin/main; the tool asks (mode default); the gateway posts a
  // top-level message and starts a session on it for the same person, whose first turn reads the brief.
  const briefRel = 'alpha/docs/brief.md';
  const notPushed = await checkBrief(fork, briefRel).then(() => 'passed', (e) => String(e.message));
  check(/not on origin\/main|no such directory/.test(notPushed), 'spawn: a brief that is not on origin/main is refused', notPushed);
  const scratchAlpha = path.join(BASE, 'scratch', 'alpha');
  mkdirSync(path.join(scratchAlpha, 'docs'), { recursive: true });
  writeFileSync(path.join(scratchAlpha, 'docs', 'brief.md'), '# Brief\n\n## Item 1\n\nReply with exactly the word spawned-ok and nothing else. Do not use any tools after reading this.\n');
  git(scratchAlpha, 'add', '-A');
  git(scratchAlpha, 'commit', '-qm', 'brief');
  git(scratchAlpha, 'push', '-q', path.join(remotes, 'alpha.git'), 'main');
  mkdirSync(path.join(fork, 'alpha', 'docs'), { recursive: true }); // as if this session wrote and pushed it
  const okBrief = await checkBrief(fork, briefRel + '#item-1').then(() => 'ok', (e) => String(e.message));
  check(okBrief === 'ok', 'spawn: a brief on origin/main passes the check (fetched by the tool)', okBrief);
  const sp = await reply(`Call the spawn_thread tool once with task "Say spawned-ok" and brief "${briefRel}#item-1". Then reply done.`);
  const spPrompt = await until(() => firstCall(sp.at, 'chat.postMessage', (c) => /start a new thread/.test(String(c.args.text)) && JSON.stringify(c.args.blocks ?? '').includes('"p:')), 120_000, 20);
  const spAllow = (spPrompt?.args.blocks as any[] | undefined)?.flatMap((b) => b.elements ?? []).find((e: any) => decodeActionId(e.action_id ?? '')?.value === 'allow');
  check(spAllow && /Say spawned-ok/.test(JSON.stringify(spPrompt?.args.blocks)), 'spawn: approval prompt previews the task (mode default)', spPrompt?.args);
  if (spAllow) {
    const clickAt = now();
    await click(spAllow.action_id, 'allow');
    const top = await until(() => firstCall(clickAt, 'chat.postMessage', (c) => c.args.channel === CH && !c.args.thread_ts && /↳ Say spawned-ok/.test(String(c.args.text))), 30_000);
    check(top && String(top.args.text).includes(`<@${owner.slackUserId}>`) && /brief\.md/.test(String(top.args.text)) && /from this thread/.test(String(top.args.text)),
      'spawn: gateway posted a short top-level message mentioning the owner, the brief and the parent', top?.args.text);
    const childRow = () => {
      const db = new DatabaseSync(DB, { readOnly: true });
      try {
        return (db.prepare('SELECT * FROM sessions').all() as any[]).find((r) => JSON.parse(r.spec).title === 'Say spawned-ok');
      } finally {
        db.close();
      }
    };
    const row = await until(childRow, 10_000, 50);
    const spec = row && JSON.parse(row.spec);
    const childTs = spec?.threadTs;
    check(spec?.owner?.slackUserId === owner.slackUserId && spec?.mode === 'default' && spec?.kind === 'thread', 'spawn: child session owned by the same person, inheriting mode', spec);
    // Stream appends name their message by its own ts, so follow the messages started in the child's thread.
    const childText = () => {
      const msgs = new Set(calls.filter((c) => c.at >= clickAt && c.args.thread_ts === childTs).map((c) => c.result?.ts));
      return calls.filter((c) => c.at >= clickAt && c.args.channel === CH && (c.args.thread_ts === childTs || msgs.has(c.args.ts))).map((c) => JSON.stringify(c.args)).join('\n');
    };
    check(await until(() => /spawned-ok/.test(childText()), 180_000, 100), 'spawn: child runner started in its own fork and answered from the brief', childText().slice(-400));
    if (POOL) check(row && logged('host', new RegExp(`claimed for ${row.key}`)), 'pool: the child session took the parked spare (work 069)', logLines.host.slice(-8));
    check(await until(() => /e2e\.slack\.com\/archives/.test(textSince(clickAt)), 60_000, 100), "spawn: parent got the child's link back", textSince(clickAt).slice(-400));
    await idle(clickAt);
  }

  // 5. host killed while the runner lives → restart, rediscovery, next delivery
  host.kill('SIGKILL');
  await exited(host);
  await sleep(500);
  check(alive(pid), 'runner survives the host being killed');
  const restartAt = now();
  host = startHost();
  check(await until(() => logged('host', /rediscovered runner/, restartAt), 15_000), 'restarted host rediscovered the runner by its socket');
  check(await until(async () => (await health())?.hosts.includes('e2e-host'), 15_000), 'host reconnected to the gateway');
  const st2 = await reply('!status');
  check(await until(() => firstCall(st2.at, 'chat.postMessage', (c) => inThread(c) && /cwd/.test(String(c.args.text))), 15_000) && runnerPid() === pid, 'delivery after host restart → same runner');

  // 6. GitHub token: credential helper → token.sock → host → gateway → mint (fake GitHub), owner stripped
  const helperEnv = { ...cleanEnv(), SP_RUN: RUN, SP_SESSION_KEY: KEY };
  const tokAt = now();
  const cred = await run(path.join(ROOT, 'bin', 'git-credential-slack-presence'), ['get'], helperEnv, 'protocol=https\nhost=github.com\npath=acme/beta.git\n');
  const tokMs = now() - tokAt;
  const mint = gh.find((g) => g.method === 'POST' && /access_tokens/.test(g.path));
  check(/password=ghs_e2e_beta\n/.test(cred) && mint?.body?.repositories?.join() === 'beta' && /^Bearer [^.]+\.[^.]+\.[^.]+$/.test(mint?.auth ?? ''),
    `credential helper got a token narrowed to "beta" (owner stripped), minted with an app JWT (${ms(tokMs)})`, { cred, mint });
  const fakeGh = path.join(BASE, 'real-gh');
  writeFileSync(fakeGh, '#!/bin/sh\necho "token=$GH_TOKEN args=$*"\n', { mode: 0o755 });
  const shim = await run(path.join(ROOT, 'bin', 'gh'), ['pr', 'list'], { ...helperEnv, SP_REAL_GH: fakeGh });
  check(/token=ghs_e2e_all args=pr list/.test(shim), 'gh shim ran the real gh by absolute path with GH_TOKEN', shim);
  latency.push(['GitHub token via helper (cold mint, fake GitHub)', ms(tokMs), '—']);

  // 7. push webhook → `pushed` → host fetches the repository in the workspace
  const scratch = path.join(BASE, 'scratch', 'alpha');
  writeFileSync(path.join(scratch, 'pushed.txt'), 'x');
  git(scratch, 'add', '-A');
  git(scratch, 'commit', '-qm', 'pushed');
  git(scratch, 'push', '-q', path.join(remotes, 'alpha.git'), 'main');
  const head = git(scratch, 'rev-parse', 'HEAD');
  const hook = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'acme/alpha' } });
  const hr = await fetch(`${ORIGIN}/github/events`, {
    method: 'POST', body: hook,
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(hook).digest('hex') },
  });
  check(hr.status === 200 && (await until(() => git(path.join(ws, 'alpha'), 'rev-parse', 'origin/main') === head, 15_000, 100)), 'signed push webhook → host fetched acme/alpha');

  // 8. gateway restart (SIGTERM, same db): host reconnects, the session table persists
  const stopAt = now();
  gateway.kill('SIGTERM');
  await exited(gateway);
  const stopMs = now() - stopAt;
  check(stopMs < 10_000 && gateway.exitCode === 0, `gateway exited cleanly on SIGTERM in ${ms(stopMs)}`, { code: gateway.exitCode, sig: gateway.signalCode });
  gateway = startGateway();
  const h2 = await until(async () => { const h = await health(); return h?.hosts.includes('e2e-host') && h; }, 40_000, 100);
  check(h2?.mode === 'slack', `restarted gateway came up in Slack mode from the store; host reconnected after ${ms(now() - stopAt)}`, h2);
  check(sessionRow()?.sdk_session_id === row1?.sdk_session_id && sessionRow()?.host === 'e2e-host', 'session table persisted across the restart', sessionRow());
  const st3 = await reply('!status');
  check(await until(() => firstCall(st3.at, 'chat.postMessage', (c) => inThread(c) && /cwd/.test(String(c.args.text))), 15_000) && runnerPid() === pid, 'thread reply after gateway restart → same session, same runner');
} catch (e) {
  failed++;
  say('ERROR', e);
} finally {
  // Runners first (they are ours: their pid files are in our temp run dir), then the host and the gateway.
  for (const f of existsSync(path.join(RUN, 'runners')) ? readdirSync(path.join(RUN, 'runners')) : [])
    if (f.endsWith('.pid')) kill(Number(readFileSync(path.join(RUN, 'runners', f), 'utf8')), 'SIGTERM');
  host?.kill('SIGTERM');
  gateway.kill('SIGTERM');
  await Promise.all([host && exited(host), exited(gateway)]);
  fake.close();
  console.log('\nLatency (this laptop, loopback; Slack, gateway and host network hops not included):');
  const w = Math.max(...latency.map((l) => l[0].length));
  for (const [what, got, target] of latency) console.log(`  ${what.padEnd(w)}  ${got.padStart(9)}   target ${target}`);
  if (failed) console.log(`\nlogs: ${LOGS} (gateway.log, host.log, slack.log), runner logs in ${path.join(RUN, 'logs')}`);
  if (!KEEP && !failed) rmSync(BASE, { recursive: true, force: true });
  say(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
