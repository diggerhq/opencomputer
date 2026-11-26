// Slack app by manifest API for the /setup flow (work 045, item S3): the web
// counterpart of provision.ts, with the secret store instead of .env.
//
//   create: apps.manifest.create without URLs (Slack verifies request URLs at
//           once, and the gateway can only answer that once it has the new
//           signing secret) → credentials into the store
//   sync:   apps.manifest.update with <origin>/slack/... once the gateway has
//           loaded the credentials
//   install: <origin>/slack/install, Bolt's OAuth flow in the gateway
//
// The config refresh token is single-use: every rotated pair is stored before
// the new access token is used.

import { randomBytes } from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { log } from '../log.js';
import { manifest, prune } from '../provision.js';
import type { Secrets } from './secrets.js';

/** The Slack calls setup makes; injectable so the flow can be checked without Slack. */
export interface SlackSetupApi {
  rotate(refreshToken: string): Promise<{ token: string; refresh_token: string; exp: number }>;
  create(token: string, manifest: unknown): Promise<any>;
  update(token: string, appId: string, manifest: unknown): Promise<any>;
}

export function slackApi(client = new WebClient()): SlackSetupApi {
  return {
    rotate: async (refresh_token) => (await client.tooling.tokens.rotate({ refresh_token })) as any,
    create: (token, m) => client.apps.manifest.create({ token, manifest: m as any }),
    update: (token, app_id, m) => client.apps.manifest.update({ token, app_id, manifest: m as any }),
  };
}

/** A valid config access token, rotating (and storing the new pair first) when needed. */
export async function slackConfigToken(secrets: Secrets, api: SlackSetupApi): Promise<string> {
  const exp = Number(secrets.get('SLACK_CONFIG_TOKEN_EXP') ?? 0);
  const current = secrets.get('SLACK_CONFIG_TOKEN');
  if (current && exp - 600 > Date.now() / 1000) return current;
  const refresh = secrets.get('SLACK_CONFIG_REFRESH_TOKEN');
  if (!refresh) throw new Error('No Slack config refresh token: paste one on /setup');
  let r: Awaited<ReturnType<typeof api.rotate>>;
  try {
    r = await api.rotate(refresh);
  } catch (e: any) {
    if (e?.data?.error === 'invalid_refresh_token') {
      secrets.set('SLACK_CONFIG_REFRESH_TOKEN', '');
      secrets.set('SLACK_CONFIG_TOKEN', '');
      throw new Error('Slack rejected the refresh token (invalid, expired or already used); generate a new one');
    }
    throw e;
  }
  secrets.set('SLACK_CONFIG_REFRESH_TOKEN', r.refresh_token);
  secrets.set('SLACK_CONFIG_TOKEN', r.token);
  secrets.set('SLACK_CONFIG_TOKEN_EXP', String(r.exp));
  log.info('rotated Slack config token, valid until', new Date(r.exp * 1000).toISOString());
  return r.token;
}

async function apply(secrets: Secrets, api: SlackSetupApi, m: any, appId?: string) {
  for (let attempt = 0; ; attempt++) {
    const token = await slackConfigToken(secrets, api);
    try {
      return appId ? await api.update(token, appId, m) : await api.create(token, m);
    } catch (e: any) {
      const errs: { message?: string; pointer?: string }[] = e?.data?.errors ?? [];
      const optional = errs.filter((x) => x.pointer && /^\/(features\/|settings\/event_subscriptions\/bot_events\/)/.test(x.pointer));
      if (!optional.length || attempt >= 4) {
        const detail = errs.map((x) => `${x.pointer}: ${x.message}`).join('; ');
        throw new Error(`apps.manifest.${appId ? 'update' : 'create'} failed: ${e?.data?.error ?? e?.message}${detail ? ` (${detail})` : ''}`);
      }
      for (const x of optional.sort((a, b) => b.pointer!.localeCompare(a.pointer!, undefined, { numeric: true }))) {
        log.warn(`manifest: dropping ${x.pointer} (${x.message})`);
        prune(m, x.pointer!);
      }
    }
  }
}

/** Create the Slack app if there is none. Returns the app id and whether it was created now. */
export async function createSlackApp(secrets: Secrets, api: SlackSetupApi): Promise<{ appId: string; created: boolean }> {
  const existing = secrets.get('SLACK_APP_ID');
  if (existing) return { appId: existing, created: false };
  const r: any = await apply(secrets, api, manifest());
  secrets.set('SLACK_APP_ID', r.app_id);
  secrets.set('SLACK_CLIENT_ID', r.credentials.client_id);
  secrets.set('SLACK_CLIENT_SECRET', r.credentials.client_secret);
  secrets.set('SLACK_SIGNING_SECRET', r.credentials.signing_secret);
  if (!secrets.get('SLACK_STATE_SECRET')) secrets.set('SLACK_STATE_SECRET', randomBytes(24).toString('hex'));
  log.info(`created Slack app ${r.app_id}`);
  return { appId: r.app_id, created: true };
}

/** Point the app's events, interactivity and OAuth redirect at `origin`. True when scopes changed (reinstall). */
export async function syncSlackManifest(secrets: Secrets, api: SlackSetupApi, origin: string): Promise<boolean> {
  const appId = secrets.get('SLACK_APP_ID');
  if (!appId) throw new Error('No Slack app yet');
  const r: any = await apply(secrets, api, manifest(origin), appId);
  return !!r?.permissions_updated;
}
