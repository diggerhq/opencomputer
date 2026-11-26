import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueHostToken, setupComplete, setupLocked, setupRoutes } from './index.js';
import { openSecrets, type SecretStore } from './secrets.js';

const STORE_KEY = 'b'.repeat(64);
const SETUP_TOKEN = 'setup-fixture-token';
const ORIGIN = 'https://gw.example.test';
const ENV = /^(SLACK_|GITHUB_|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|MODEL_PROFILE|MODEL_TOKEN|SP_STORE_KEY|SETUP_TOKEN|SP_HOST_TOKENS|SP_SETUP_OPEN|PORT)$/;

let saved: NodeJS.ProcessEnv;
let db: DatabaseSync;
let secrets: SecretStore;
let server: Server;
let base: string;

beforeEach(async () => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (ENV.test(k)) delete process.env[k];
  process.env.SP_STORE_KEY = STORE_KEY;
  process.env.SETUP_TOKEN = SETUP_TOKEN;
  process.env.PORT = '8080';
  db = new DatabaseSync(':memory:');
  secrets = openSecrets(db, STORE_KEY);
  const routes = setupRoutes({ secrets, origin: ORIGIN, db, onPush: () => {} });
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    const r = routes.find((r) => r.path === path && [r.method].flat().includes(req.method!));
    if (r) r.handler(req as any, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  process.env = saved;
  await new Promise((ok) => server.close(ok));
});

/** Everything but the host: Slack installed, GitHub installed, a model credential. */
function allButHost() {
  secrets.set('SLACK_SIGNING_SECRET', 'ss');
  secrets.set('SLACK_BOT_TOKEN', 'xoxb-fixture');
  secrets.set('GITHUB_INSTALLATION_ID', '555');
  secrets.set('ANTHROPIC_API_KEY', 'sk-ant-api-fixture');
}

const get = (path: string, cookie = '') => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
async function signIn() {
  const r = await get(`/setup?token=${SETUP_TOKEN}`);
  expect(r.status).toBe(303);
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await (await get('/setup', cookie)).text()).match(/name="csrf" value="([^"]+)"/)![1]!;
  return { cookie, csrf };
}
const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

describe('setupComplete', () => {
  it('needs Slack, GitHub, a model credential and a host', () => {
    expect(setupComplete(secrets, db)).toBe(false);
    allButHost();
    expect(setupComplete(secrets, db)).toBe(false);
    issueHostToken(db, 'vm-1');
    expect(setupComplete(secrets, db)).toBe(true);
  });

  it('counts SP_HOST_TOKENS as a host, and an operator model profile as the credential', () => {
    allButHost();
    secrets.set('ANTHROPIC_API_KEY', '');
    process.env.SP_HOST_TOKENS = ' static-1 ';
    expect(setupComplete(secrets, db)).toBe(false);
    process.env.MODEL_PROFILE = 'mine';
    process.env.MODEL_TOKEN = 'tok';
    expect(setupComplete(secrets, db)).toBe(true);
  });

  it('SP_SETUP_OPEN=1 keeps a complete setup unlocked', () => {
    allButHost();
    issueHostToken(db);
    expect(setupLocked(secrets, db)).toBe(true);
    process.env.SP_SETUP_OPEN = '1';
    expect(setupLocked(secrets, db)).toBe(false);
  });
});

describe('/setup after setup is complete', () => {
  it('is open (behind SETUP_TOKEN) while a step is left', async () => {
    allButHost();
    expect((await get('/setup')).status).toBe(401);
    await signIn();
  });

  it('answers 404 to every page, the token sign-in and a signed-in cookie', async () => {
    allButHost();
    const { cookie, csrf } = await signIn();
    issueHostToken(db, 'vm-1');
    expect((await get('/setup')).status).toBe(404);
    expect((await get(`/setup?token=${SETUP_TOKEN}`)).status).toBe(404);
    expect((await get('/setup', cookie)).status).toBe(404);
    expect((await post('/setup/host', cookie, { csrf, label: 'late' })).status).toBe(404);
    expect((await post('/setup/claude', cookie, { csrf, token: 'sk-ant-api-other' })).status).toBe(404);
    expect(secrets.get('ANTHROPIC_API_KEY')).toBe('sk-ant-api-fixture');
  });

  it('still serves the GitHub webhook, which its signature guards', async () => {
    allButHost();
    issueHostToken(db);
    expect((await fetch(`${base}/github/events`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('opens again with SP_SETUP_OPEN=1', async () => {
    allButHost();
    issueHostToken(db);
    process.env.SP_SETUP_OPEN = '1';
    await signIn();
  });
});

describe('the Host step', () => {
  it('prints the loopback /host URL, not the public origin', async () => {
    const { cookie, csrf } = await signIn();
    const html = await (await post('/setup/host', cookie, { csrf, label: 'vm-1' })).text();
    expect(html).toContain('SP_GATEWAY_URL=ws://127.0.0.1:8080/host');
    expect(html).not.toContain(`SP_GATEWAY_URL=${ORIGIN}`);
    expect(html).toContain('wss://gw.example.test/host');
  });

  it('says /setup is closing when the token it issues completes setup', async () => {
    allButHost();
    const { cookie, csrf } = await signIn();
    const html = await (await post('/setup/host', cookie, { csrf, label: 'vm-1' })).text();
    expect(html).toContain('SP_HOST_TOKEN=sph_');
    expect(html).toContain('SP_SETUP_OPEN=1');
    expect((await get('/setup', cookie)).status).toBe(404);
  });
});
