// The instance's GitHub App (work 045, item S3). Owned by S3; the gateway
// imports only these signatures.
//
// App JWT: RS256, iat 60 s in the past, exp 9 min ahead (GitHub allows ≤ 10),
// iss = client id (recommended) or app id. Installation tokens live 1 h; they
// are cached in memory per (app, installation, repos) and reused until 5 min
// before expiry. Nothing is written to disk.

import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import type { GitHubToken } from '../protocol.js';
import type { Secrets } from '../setup/secrets.js';

/** SP_GITHUB_API_URL: dev only, a local fake GitHub for end-to-end checks. */
export const GITHUB_API = (process.env.SP_GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
export const GITHUB_API_VERSION = '2022-11-28';

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** Sign an app JWT. `now` in seconds, for tests. */
export function appJwt(issuer: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: issuer }));
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

function need(secrets: Secrets, name: string): string {
  const v = secrets.get(name);
  if (!v) throw new Error(`GitHub App not set up: ${name} missing (run /setup)`);
  return v;
}

/** A JWT for this instance's app, from the store. */
export function jwtFor(secrets: Secrets): string {
  const issuer = secrets.get('GITHUB_CLIENT_ID') || need(secrets, 'GITHUB_APP_ID');
  // Deployment secrets and .env flatten newlines; accept a PEM with literal \n.
  return appJwt(issuer, need(secrets, 'GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n'));
}

/** Call the GitHub REST API as the app (JWT). Throws with GitHub's message on non-2xx. */
export async function appRequest(secrets: Secrets, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwtFor(secrets)}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'slack-presence',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${json?.message ?? text}`);
  return json;
}

/** The installation to mint from: stored, or the app's only installation (then stored). */
async function installationId(secrets: Secrets): Promise<string> {
  const id = secrets.get('GITHUB_INSTALLATION_ID');
  if (id) return id;
  const list: any[] = await appRequest(secrets, 'GET', '/app/installations');
  if (list.length !== 1)
    throw new Error(`GitHub App has ${list.length} installations; install it once (or set GITHUB_INSTALLATION_ID) via /setup`);
  secrets.set('GITHUB_INSTALLATION_ID', String(list[0].id));
  secrets.set('GITHUB_INSTALLATION_ACCOUNT', list[0].account?.login ?? '');
  return String(list[0].id);
}

const cache = new Map<string, { token: GitHubToken }>();
const REUSE_MARGIN_MS = 5 * 60_000;

/** Drop cached tokens (after the app or installation changes). */
export function clearTokenCache() {
  cache.clear();
}

/** Mint an installation token (1 h), optionally narrowed to `repos` (`owner/name`). */
export async function mintInstallationToken(secrets: Secrets, repos?: string[]): Promise<GitHubToken> {
  const inst = await installationId(secrets);
  // GitHub's `repositories` takes bare names within the installation's account.
  const names = repos?.length ? [...new Set(repos.map((r) => r.split('/').pop()!))].sort() : undefined;
  const owners = new Set((repos ?? []).filter((r) => r.includes('/')).map((r) => r.split('/')[0].toLowerCase()));
  const account = secrets.get('GITHUB_INSTALLATION_ACCOUNT')?.toLowerCase();
  if (owners.size > 1 || (account && owners.size && !owners.has(account)))
    throw new Error(`repositories ${repos!.join(', ')} are outside the installation's account ${account ?? '(one owner)'}`);

  const key = `${secrets.get('GITHUB_APP_ID')}/${inst}/${names?.join(',') ?? '*'}`;
  const hit = cache.get(key);
  if (hit && Date.parse(hit.token.expiresAt) - REUSE_MARGIN_MS > Date.now()) return hit.token;

  const r = await appRequest(secrets, 'POST', `/app/installations/${inst}/access_tokens`, names ? { repositories: names } : undefined);
  const token: GitHubToken = { token: r.token, expiresAt: r.expires_at };
  cache.set(key, { token });
  return token;
}

/** HMAC-SHA256 of the raw body, compared in constant time. */
export function verifySignature(secret: string, body: string | Buffer, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Verify a webhook delivery's X-Hub-Signature-256 against the stored webhook secret. */
export function verifyWebhook(secrets: Secrets, body: string, signature: string | undefined): boolean {
  return verifySignature(secrets.get('GITHUB_WEBHOOK_SECRET') ?? '', body, signature);
}
