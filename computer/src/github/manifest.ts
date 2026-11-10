// GitHub App by the manifest flow (work 045, item S3; docs:
// docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
//
//   1. the browser POSTs a form field `manifest` (JSON) to
//      github.com/organizations/<org>/settings/apps/new?state=<nonce>
//   2. GitHub redirects to redirect_url?code=<code>&state=<nonce> (code: 1 h)
//   3. POST /app-manifests/{code}/conversions (no auth) → id, slug, client_id,
//      client_secret, webhook_secret, pem, owner
//   then github.com/apps/<slug>/installations/new → setup_url?installation_id=…&setup_action=install

import { clearTokenCache, GITHUB_API, GITHUB_API_VERSION } from './app.js';
import type { Secrets } from '../setup/secrets.js';

/** Work 045 "The GitHub App in use". Workflows is write-only on GitHub's side. */
export const PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  workflows: 'write',
  checks: 'read',
  actions: 'read',
  statuses: 'read',
  metadata: 'read',
} as const;

export const EVENTS = ['push'];

export function appManifest(origin: string, name: string) {
  return {
    name,
    url: origin,
    description: 'Claude Code driven from Slack (slack-presence): pushes, pull requests and comments for the team',
    hook_attributes: { url: `${origin}/github/events`, active: true },
    redirect_url: `${origin}/setup/github/created`,
    setup_url: `${origin}/setup/github/installed`,
    setup_on_update: true,
    request_oauth_on_install: false,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: EVENTS,
  };
}

/** Where the manifest form posts: an organization, or the signed-in user when org is empty. */
export function newAppUrl(org: string, state: string): string {
  const base = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

export const installUrl = (slug: string) => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

/** Exchange the manifest code for the app's credentials and store them. Returns the slug. */
export async function convertManifest(secrets: Secrets, code: string): Promise<{ slug: string; id: string; owner?: string }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new Error('malformed code');
  const res = await fetch(`${GITHUB_API}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': 'slack-presence' },
  });
  const text = await res.text();
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    r = undefined;
  }
  if (!res.ok || !r?.id || !r?.pem)
    throw new Error(`GitHub manifest conversion failed: ${res.status} ${r?.message ?? text.slice(0, 200)} (codes are single-use and expire after 1 h)`);
  secrets.set('GITHUB_APP_ID', String(r.id));
  secrets.set('GITHUB_APP_SLUG', r.slug);
  secrets.set('GITHUB_APP_OWNER', r.owner?.login ?? '');
  secrets.set('GITHUB_CLIENT_ID', r.client_id ?? '');
  secrets.set('GITHUB_CLIENT_SECRET', r.client_secret ?? '');
  secrets.set('GITHUB_WEBHOOK_SECRET', r.webhook_secret ?? '');
  secrets.set('GITHUB_PRIVATE_KEY', r.pem);
  // A new app means the old installation no longer applies.
  secrets.set('GITHUB_INSTALLATION_ID', '');
  secrets.set('GITHUB_INSTALLATION_ACCOUNT', '');
  clearTokenCache();
  return { slug: r.slug, id: String(r.id), owner: r.owner?.login };
}
