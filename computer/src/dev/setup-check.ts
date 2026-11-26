// Checks for work 045 item S3 without touching Slack or GitHub: secret store,
// app JWT, installation token cache, webhook signatures, and the /setup routes
// on a plain HTTP server with fetch to api.github.com and the Slack calls faked.
//
//   npx tsx src/dev/setup-check.ts

import assert from 'node:assert/strict';
import { createHmac, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { appJwt, clearTokenCache, mintInstallationToken, verifyWebhook } from '../github/app.js';
import { checkHostToken, issueHostToken, listHostTokens, setupRoutes, slackAppReady, slackReady } from '../setup/index.js';
import { openSecrets } from '../setup/secrets.js';
import type { SlackSetupApi } from '../setup/slack.js';

let passed = 0;
async function check(name: string, fn: () => unknown) {
  await fn();
  passed++;
  console.log('ok  ', name);
}

// Nothing from a developer's .env may leak in.
for (const k of Object.keys(process.env)) if (/^(SLACK_|GITHUB_|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|SP_STORE_KEY|SETUP_TOKEN)/.test(k)) delete process.env[k];

const STORE_KEY = randomBytes(32).toString('hex');
const SETUP_TOKEN = 'setup-' + randomBytes(8).toString('hex');

// ---------------------------------------------------------------- fetch stub

const realFetch = globalThis.fetch;
const ghCalls: { method: string; path: string; headers: Headers; body?: any }[] = [];
type Fake = (method: string, path: string, body: any) => { status: number; json: unknown } | undefined;
let fake: Fake = () => undefined;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://')) return realFetch(input, init);
  const u = new URL(url);
  if (u.host !== 'api.github.com') throw new Error(`unexpected network call to ${u.host}`);
  const body = init.body ? JSON.parse(init.body) : undefined;
  ghCalls.push({ method: init.method ?? 'GET', path: u.pathname, headers: new Headers(init.headers), body });
  const r = fake(init.method ?? 'GET', u.pathname, body);
  if (!r) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());

// ---------------------------------------------------------------- secrets

await check('secrets: round trip, ciphertext at rest, delete', () => {
  const db = new DatabaseSync(':memory:');
  const s = openSecrets(db, STORE_KEY);
  s.set('GITHUB_CLIENT_SECRET', 'very-secret-value');
  assert.equal(s.get('GITHUB_CLIENT_SECRET'), 'very-secret-value');
  const row = db.prepare('SELECT iv, tag, data FROM secrets WHERE name = ?').get('GITHUB_CLIENT_SECRET') as any;
  assert.equal(Buffer.from(row.iv).length, 12);
  assert.equal(Buffer.from(row.tag).length, 16);
  assert.ok(!Buffer.from(row.data).toString('latin1').includes('very-secret'));
  s.set('GITHUB_CLIENT_SECRET', '');
  assert.equal(s.get('GITHUB_CLIENT_SECRET'), undefined);
});

await check('secrets: env wins over the store', () => {
  const s = openSecrets(new DatabaseSync(':memory:'), STORE_KEY);
  s.set('SLACK_BOT_TOKEN', 'stored');
  process.env.SLACK_BOT_TOKEN = 'from-env';
  assert.equal(s.get('SLACK_BOT_TOKEN'), 'from-env');
  assert.equal(s.source('SLACK_BOT_TOKEN'), 'env');
  delete process.env.SLACK_BOT_TOKEN;
  assert.equal(s.get('SLACK_BOT_TOKEN'), 'stored');
  assert.equal(s.source('SLACK_BOT_TOKEN'), 'store');
});

await check('secrets: wrong key, missing key, swapped rows fail clearly', () => {
  const db = new DatabaseSync(':memory:');
  openSecrets(db, STORE_KEY).set('A', 'x');
  openSecrets(db, STORE_KEY).set('B', 'y');
  assert.throws(() => openSecrets(db, 'other-key').get('A'), /cannot decrypt A/);
  assert.throws(() => openSecrets(db, undefined).get('A'), /SP_STORE_KEY is not set/);
  assert.throws(() => openSecrets(db, undefined).set('A', 'z'), /cannot save A: SP_STORE_KEY is not set/);
  assert.equal(openSecrets(db, undefined).get('NOT_STORED'), undefined);
  db.exec("UPDATE secrets SET iv = (SELECT iv FROM secrets WHERE name='B'), tag = (SELECT tag FROM secrets WHERE name='B'), data = (SELECT data FROM secrets WHERE name='B') WHERE name='A'");
  assert.throws(() => openSecrets(db, STORE_KEY).get('A'), /cannot decrypt A/);
});

// ---------------------------------------------------------------- jwt, webhook

await check('jwt: RS256, iat backdated 60 s, exp ≤ 10 min, iss, valid signature', () => {
  const now = 1_800_000_000;
  const jwt = appJwt('Iv1.client', PEM, now);
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  const c = decode(p);
  assert.equal(c.iss, 'Iv1.client');
  assert.equal(c.iat, now - 60);
  assert.ok(c.exp - now <= 600 && c.exp > now);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')));
});

await check('verifyWebhook: good, tampered, missing, wrong scheme, no secret', () => {
  const s = openSecrets(new DatabaseSync(':memory:'), STORE_KEY);
  const body = '{"zen":"Keep it logically awesome."}';
  const sig = 'sha256=' + createHmac('sha256', 'whsec').update(body).digest('hex');
  assert.equal(verifyWebhook(s, body, sig), false, 'no secret stored');
  s.set('GITHUB_WEBHOOK_SECRET', 'whsec');
  assert.equal(verifyWebhook(s, body, sig), true);
  assert.equal(verifyWebhook(s, body + ' ', sig), false);
  assert.equal(verifyWebhook(s, body, undefined), false);
  assert.equal(verifyWebhook(s, body, sig.replace('sha256=', 'sha1=')), false);
  assert.equal(verifyWebhook(s, body, sig.slice(0, -1)), false);
});

// ---------------------------------------------------------------- installation tokens

await check('mintInstallationToken: JWT auth, bare repo names, cache per repos, re-mint near expiry', async () => {
  clearTokenCache();
  const s = openSecrets(new DatabaseSync(':memory:'), STORE_KEY);
  s.set('GITHUB_APP_ID', '42');
  s.set('GITHUB_CLIENT_ID', 'Iv1.abc');
  s.set('GITHUB_PRIVATE_KEY', PEM);
  s.set('GITHUB_INSTALLATION_ID', '777');
  s.set('GITHUB_INSTALLATION_ACCOUNT', 'example-org');
  let ttl = 3600_000;
  let n = 0;
  fake = (m, path) =>
    m === 'POST' && path === '/app/installations/777/access_tokens'
      ? { status: 201, json: { token: `ghs_${++n}`, expires_at: new Date(Date.now() + ttl).toISOString() } }
      : undefined;
  ghCalls.length = 0;
  const a = await mintInstallationToken(s, ['example-org/widgets', 'example-org/gadgets']);
  const b = await mintInstallationToken(s, ['example-org/gadgets', 'example-org/widgets']);
  assert.equal(a.token, 'ghs_1');
  assert.equal(b.token, 'ghs_1', 'same repo set is cached');
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0].body, { repositories: ['gadgets', 'widgets'] });
  const jwt = ghCalls[0].headers.get('authorization')!.replace('Bearer ', '');
  assert.equal(decode(jwt.split('.')[1]).iss, 'Iv1.abc');
  const all = await mintInstallationToken(s);
  assert.equal(all.token, 'ghs_2');
  assert.equal(ghCalls[1].body, undefined, 'no narrowing → no body');
  ttl = 4 * 60_000; // within the 5 min margin: never reused
  const c1 = await mintInstallationToken(s, ['example-org/x']);
  const c2 = await mintInstallationToken(s, ['example-org/x']);
  assert.notEqual(c1.token, c2.token);
  await assert.rejects(mintInstallationToken(s, ['someone-else/repo']), /outside the installation/);
});

// ---------------------------------------------------------------- routes over HTTP

const db = new DatabaseSync(':memory:');
const secrets = openSecrets(db, STORE_KEY);
process.env.SP_STORE_KEY = STORE_KEY;
process.env.SETUP_TOKEN = SETUP_TOKEN;
const pushes: [string, string][] = [];
const changes: string[] = [];
const slackCalls: { op: string; manifest?: any; token?: string }[] = [];
let rotation = 0;
const slack: SlackSetupApi = {
  async rotate(refresh) {
    slackCalls.push({ op: 'rotate', token: refresh });
    rotation++;
    return { token: `xoxe.xoxp-access-${rotation}`, refresh_token: `xoxe-1-refresh-${rotation}`, exp: Math.floor(Date.now() / 1000) + 43200 };
  },
  async create(token, manifest) {
    slackCalls.push({ op: 'create', token, manifest });
    return { ok: true, app_id: 'A0FAKE', credentials: { client_id: '1.2', client_secret: 'cs', signing_secret: 'ss' } };
  },
  async update(token, _appId, manifest) {
    slackCalls.push({ op: 'update', token, manifest });
    return { ok: true, permissions_updated: false };
  },
};

const ORIGIN = 'https://sp.example.test';
const routes = setupRoutes({ secrets, origin: ORIGIN, onPush: (r, ref) => pushes.push([r, ref]), slack, onChange: (s) => changes.push(s) });
const server = createServer((req, res) => {
  const path = new URL(req.url!, 'http://x').pathname;
  const r = routes.find((r) => r.path === path && [r.method].flat().includes(req.method!));
  if (r) r.handler(req as any, res);
  else res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let cookie = '';
const http = (path: string, init: RequestInit = {}) =>
  realFetch(base + path, { redirect: 'manual', ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as any) } });
const post = (path: string, fields: Record<string, string>) =>
  http(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
let csrf = '';

await check('auth: no cookie 401, wrong token 401, right token sets cookie and drops it from the URL', async () => {
  assert.equal((await http('/setup')).status, 401);
  assert.equal((await http('/setup?token=nope')).status, 401);
  const r = await http(`/setup?token=${SETUP_TOKEN}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/setup');
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Secure/);
  assert.match(sc, /Path=\/setup/);
  cookie = sc.split(';')[0];
  assert.equal((await http('/setup', { headers: { cookie: cookie.replace(/.$/, 'x') } })).status, 401, 'tampered cookie');
});

await check('status page: every step pending, nothing secret shown', async () => {
  const r = await http('/setup');
  assert.equal(r.status, 200);
  const html = await r.text();
  for (const s of ['1. Slack app', '2. GitHub App', '3. Claude credential', '4. People', '5. Hosts']) assert.ok(html.includes(s), s);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  assert.equal((await post('/setup/claude', { token: 'sk-ant-oat-x' })).status, 403, 'POST without csrf');
  // GITHUB_ORG is required and has no default: without it the GitHub App form is replaced by the reason.
  assert.ok(html.includes('GITHUB_ORG is not set') && !html.includes('action="/setup/github"'), 'no GITHUB_ORG: no form');
  process.env.GITHUB_ORG = 'acme';
  const withOrg = await (await http('/setup')).text();
  assert.ok(withOrg.includes('name="org" value="acme"') && !withOrg.includes('GITHUB_ORG is not set'), 'GITHUB_ORG prefills the form');
});

await check('slack: paste refresh token → rotate (stored first) → create without URLs → connect URLs', async () => {
  let r = await post('/setup/slack', { csrf, refresh_token: 'xoxe.xoxp-not-a-refresh' });
  assert.equal(r.status, 400);
  r = await post('/setup/slack', { csrf, refresh_token: 'xoxe-1-pasted' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(slackCalls.map((c) => c.op), ['rotate', 'create']);
  assert.equal(slackCalls[0].token, 'xoxe-1-pasted');
  assert.equal(slackCalls[1].token, 'xoxe.xoxp-access-1');
  assert.equal(slackCalls[1].manifest.settings.event_subscriptions, undefined, 'created without URLs');
  assert.equal(secrets.get('SLACK_CONFIG_REFRESH_TOKEN'), 'xoxe-1-refresh-1');
  assert.equal(secrets.get('SLACK_APP_ID'), 'A0FAKE');
  assert.equal(secrets.get('SLACK_SIGNING_SECRET'), 'ss');
  assert.ok(secrets.get('SLACK_STATE_SECRET'));
  assert.ok(slackAppReady(secrets) && !slackReady(secrets));
  assert.deepEqual(changes, ['slack']);
  r = await post('/setup/slack/sync', { csrf });
  assert.equal(r.status, 200);
  const upd = slackCalls.at(-1)!;
  assert.equal(upd.op, 'update');
  assert.equal(upd.token, 'xoxe.xoxp-access-1', 'config token reused while valid');
  assert.equal(upd.manifest.settings.event_subscriptions.request_url, `${ORIGIN}/slack/events`);
  assert.deepEqual(upd.manifest.oauth_config.redirect_urls, [`${ORIGIN}/slack/oauth_redirect`]);
  assert.ok((await r.text()).includes('/slack/install'));
  // Re-run with the app present: no second create, just a sync.
  await post('/setup/slack', { csrf });
  assert.equal(slackCalls.filter((c) => c.op === 'create').length, 1);
  secrets.set('SLACK_BOT_TOKEN', 'xoxb-fake');
  assert.ok(slackReady(secrets));
});

let state = '';
await check('github: manifest form auto-posts to the org with permissions, URLs and a state', async () => {
  const r = await post('/setup/github', { csrf, org: 'example-org', name: 'Claude Live example-org' });
  assert.equal(r.status, 200);
  const html = await r.text();
  const action = new URL(unesc(html.match(/<form id="m" method="post" action="([^"]+)"/)![1]));
  assert.equal(action.origin + action.pathname, 'https://github.com/organizations/example-org/settings/apps/new');
  state = action.searchParams.get('state')!;
  assert.ok(state);
  const m = JSON.parse(unesc(html.match(/name="manifest" value="([^"]+)"/)![1]));
  assert.ok(html.includes("document.getElementById('m').submit()"));
  assert.deepEqual(m.hook_attributes, { url: `${ORIGIN}/github/events`, active: true });
  assert.equal(m.redirect_url, `${ORIGIN}/setup/github/created`);
  assert.equal(m.setup_url, `${ORIGIN}/setup/github/installed`);
  assert.equal(m.public, false);
  assert.deepEqual(m.default_events, ['push']);
  assert.deepEqual(m.default_permissions, {
    contents: 'write', pull_requests: 'write', issues: 'write', workflows: 'write',
    checks: 'read', actions: 'read', statuses: 'read', metadata: 'read',
  });
  console.log('     manifest:', JSON.stringify(m));
  assert.equal((await post('/setup/github', { csrf, org: 'bad org!', name: 'x' })).status, 400);
});

await check('github: created callback rejects bad state, converts code, redirects to install', async () => {
  assert.equal((await http(`/setup/github/created?code=abc&state=${state.replace(/.$/, 'A')}x`)).status, 400);
  fake = (m, path) =>
    m === 'POST' && path === '/app-manifests/abc123/conversions'
      ? { status: 201, json: { id: 9001, slug: 'claude-live-example-org', owner: { login: 'example-org' }, client_id: 'Iv23.fake', client_secret: 'csec', webhook_secret: 'whsec-fake', pem: PEM } }
      : undefined;
  ghCalls.length = 0;
  const r = await http(`/setup/github/created?code=abc123&state=${encodeURIComponent(state)}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://github.com/apps/claude-live-example-org/installations/new');
  assert.equal(ghCalls[0].headers.get('authorization'), null, 'conversion is unauthenticated');
  assert.equal(secrets.get('GITHUB_APP_ID'), '9001');
  assert.equal(secrets.get('GITHUB_PRIVATE_KEY'), PEM);
  assert.equal(secrets.get('GITHUB_WEBHOOK_SECRET'), 'whsec-fake');
  assert.equal(secrets.get('GITHUB_CLIENT_ID'), 'Iv23.fake');
  // A replayed code fails cleanly (GitHub codes are single-use).
  assert.equal((await http(`/setup/github/created?code=used&state=${encodeURIComponent(state)}`)).status, 500);
});

await check('github: installed callback checks the installation as the app, then stores it', async () => {
  fake = (m, path) =>
    m === 'GET' && path === '/app/installations/555'
      ? { status: 200, json: { id: 555, account: { login: 'example-org' }, repository_selection: 'selected' } }
      : undefined;
  assert.equal((await http('/setup/github/installed?installation_id=999&setup_action=install')).status, 500, 'foreign id rejected');
  assert.equal(secrets.get('GITHUB_INSTALLATION_ID'), undefined);
  const r = await http('/setup/github/installed?installation_id=555&setup_action=install');
  assert.equal(r.status, 200);
  assert.equal(decode(ghCalls.at(-1)!.headers.get('authorization')!.split(' ')[1].split('.')[1]).iss, 'Iv23.fake');
  assert.equal(secrets.get('GITHUB_INSTALLATION_ID'), '555');
  assert.equal(secrets.get('GITHUB_INSTALLATION_ACCOUNT'), 'example-org');
});

await check('claude: setup-token or API key, exactly one kept', async () => {
  assert.equal((await post('/setup/claude', { csrf, token: 'hello' })).status, 400);
  assert.equal((await post('/setup/claude', { csrf, token: 'sk-ant-api03-fake' })).status, 303);
  assert.equal(secrets.get('ANTHROPIC_API_KEY'), 'sk-ant-api03-fake');
  assert.equal((await post('/setup/claude', { csrf, token: 'sk-ant-oat01-fake' })).status, 303);
  assert.equal(secrets.get('CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat01-fake');
  assert.equal(secrets.get('ANTHROPIC_API_KEY'), undefined);
});

await check('hosts: issue shows the token once, only a hash stored, check and revoke', async () => {
  const r = await post('/setup/host', { csrf, label: 'vm-1' });
  const token = (await r.text()).match(/SP_HOST_TOKEN=(sph_[A-Za-z0-9_-]+)/)![1];
  assert.equal(checkHostToken(db, token), 'vm-1');
  assert.equal(checkHostToken(db, token + 'x'), undefined);
  assert.equal(checkHostToken(db, undefined), undefined);
  const raw = JSON.stringify(db.prepare('SELECT * FROM host_tokens').all());
  assert.ok(!raw.includes(token));
  const other = issueHostToken(db, 'laptop');
  const [vm] = listHostTokens(db);
  assert.ok(vm.lastUsedAt);
  assert.equal((await post('/setup/host/revoke', { csrf, id: vm.id })).status, 303);
  assert.equal(checkHostToken(db, token), undefined);
  assert.equal(checkHostToken(db, other), 'laptop');
});

await check('status page: steps done, no secret values in the HTML', async () => {
  const html = await (await http('/setup')).text();
  assert.ok(html.includes('A0FAKE') && html.includes('claude-live-example-org') && html.includes('installation 555'));
  for (const v of ['ss', 'cs', 'csec', 'whsec-fake', 'xoxb-fake', 'sk-ant-oat01-fake', 'xoxe-1-refresh', 'BEGIN RSA'])
    assert.ok(!html.includes(`>${v}<`) && !html.includes(`"${v}"`) && !(v.length > 3 && html.includes(v)), v);
});

await check('webhook: signed push → onPush; ping 200; other events 202; bad signature 401', async () => {
  const deliver = (event: string, payload: unknown, secret = 'whsec-fake') => {
    const body = JSON.stringify(payload);
    return realFetch(base + '/github/events', {
      method: 'POST',
      headers: { 'x-github-event': event, 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') },
      body,
    });
  };
  const push = { ref: 'refs/heads/main', repository: { full_name: 'example-org/opencomputer' } };
  assert.equal((await deliver('push', push)).status, 200);
  assert.deepEqual(pushes, [['example-org/opencomputer', 'refs/heads/main']]);
  // A session's own branch, a tag and a branch deletion are acknowledged but not passed on.
  for (const other of [{ ...push, ref: 'refs/heads/sp/C0B-1791-82' }, { ...push, ref: 'refs/tags/v1' }, { ...push, ref: 'refs/heads/old', deleted: true }])
    assert.equal((await deliver('push', other)).status, 200);
  assert.equal(pushes.length, 1);
  assert.equal((await deliver('ping', { zen: 'x' })).status, 200);
  assert.equal((await deliver('issues', { action: 'opened' })).status, 202);
  assert.equal((await deliver('push', push, 'wrong')).status, 401);
  assert.equal(pushes.length, 1);
});

await check('without SETUP_TOKEN the flow is closed', async () => {
  delete process.env.SETUP_TOKEN;
  assert.equal((await http('/setup')).status, 503);
  process.env.SETUP_TOKEN = SETUP_TOKEN;
});

server.close();
console.log(`\n${passed} checks passed`);
