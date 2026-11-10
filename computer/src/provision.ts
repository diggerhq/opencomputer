// The Slack app is created and kept in sync from code, using an app
// configuration token (api.slack.com/apps → "Your App Configuration Tokens").
//
//   first run: apps.manifest.create (no URLs yet) → credentials into .env
//   every run: ngrok tunnel → apps.manifest.update with the tunnel URL for
//              events, interactivity and the OAuth redirect
//   install:   Bolt's OAuth flow at <url>/slack/install; the bot token lands in .env
//
// Config tokens live 12 h; each run rotates the pair with tooling.tokens.rotate
// and writes the new pair back (the old refresh token stops working).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createInterface as prompt } from 'node:readline/promises';
import { WebClient } from '@slack/web-api';
import { setEnv } from './env.js';
import { log } from './log.js';

const api = new WebClient();
const env = process.env;

export const SCOPES = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:read',
  'channels:manage',
  'groups:history',
  'groups:read',
  'groups:write',
  'im:history',
  'im:read',
  'im:write',
  'chat:write',
  'files:read',
  'files:write',
  'reactions:write',
  'users:read',
];

const EVENTS = ['app_mention', 'message.channels', 'message.groups', 'message.im', 'agent_session_stopped'];

export function manifest(url?: string) {
  return {
    display_information: {
      name: env.SLACK_APP_NAME ?? 'Computer',
      description: 'Claude Code in a Slack thread: live streaming, steering, approvals',
    },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: (env.SLACK_APP_NAME ?? 'computer').toLowerCase().replace(/\s+/g, '-'), always_online: true },
      // Agent features. Keys Slack rejects are dropped with a warning (see applyManifest).
      agent_view: { agent_description: 'A coding agent you drive live from Slack' },
      code_channels: { enabled: true },
    },
    oauth_config: {
      scopes: { bot: SCOPES },
      ...(url ? { redirect_urls: [`${url}/slack/oauth_redirect`] } : {}),
    },
    settings: {
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      org_deploy_enabled: false,
      ...(url
        ? {
            event_subscriptions: { request_url: `${url}/slack/events`, bot_events: EVENTS },
            interactivity: { is_enabled: true, request_url: `${url}/slack/events` },
          }
        : {}),
    },
  };
}

const TOKENS_PAGE = 'https://api.slack.com/apps';

/** First run: open the token page and take one paste. The refresh token alone is enough. */
async function askForRefreshToken() {
  if (!process.stdin.isTTY)
    throw new Error(`Set SLACK_CONFIG_REFRESH_TOKEN in .env (${TOKENS_PAGE} → Your App Configuration Tokens → Generate Token)`);
  console.log(
    `\nNo Slack config token yet. Opening ${TOKENS_PAGE}\n` +
      'Scroll to "Your App Configuration Tokens" → Generate Token → pick the workspace,\n' +
      'then copy the Refresh Token (xoxe-1-…). Pasting both tokens works too.\n',
  );
  spawn('open', [TOKENS_PAGE], { stdio: 'ignore' }).on('error', () => {});
  const rl = prompt({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const words = (await rl.question('refresh token: ')).split(/\s+/);
      const refresh = words.find((w) => /^xoxe-\d/.test(w));
      if (refresh) return setEnv({ SLACK_CONFIG_REFRESH_TOKEN: refresh, SLACK_CONFIG_TOKEN_EXP: '0' });
      console.log('That is not a refresh token (it starts with "xoxe-1-", not "xoxe.xoxp-"). Try again.');
    }
  } finally {
    rl.close();
  }
}

async function configToken(): Promise<string> {
  const exp = Number(env.SLACK_CONFIG_TOKEN_EXP ?? 0);
  if (env.SLACK_CONFIG_TOKEN && exp - 600 > Date.now() / 1000) return env.SLACK_CONFIG_TOKEN;
  for (;;) {
    if (!env.SLACK_CONFIG_REFRESH_TOKEN) await askForRefreshToken();
    const r = await api.tooling.tokens.rotate({ refresh_token: env.SLACK_CONFIG_REFRESH_TOKEN! }).catch((e) => {
      if (e?.data?.error !== 'invalid_refresh_token') throw e;
      // Refresh tokens are single-use; a stale or mistyped one means generating a new pair.
      console.log('Slack rejected the refresh token (invalid, expired, or already used). Generate a new one.');
      setEnv({ SLACK_CONFIG_REFRESH_TOKEN: '', SLACK_CONFIG_TOKEN: '', SLACK_CONFIG_TOKEN_EXP: '0' });
      return undefined;
    });
    if (!r) continue;
    setEnv({ SLACK_CONFIG_TOKEN: r.token, SLACK_CONFIG_REFRESH_TOKEN: r.refresh_token, SLACK_CONFIG_TOKEN_EXP: String(r.exp) });
    log.info('rotated Slack config token, valid until', new Date(r.exp! * 1000).toISOString());
    return r.token!;
  }
}

/** Remove the node a JSON pointer names: /features/x/... → features.x, /settings/.../bot_events/3 → that event. */
export function prune(m: any, pointer: string) {
  const parts = pointer.split('/').slice(1);
  const depth = parts[0] === 'features' ? 2 : parts.findIndex((p) => /^\d+$/.test(p)) + 1 || parts.length;
  const keys = parts.slice(0, depth);
  const parent = keys.slice(0, -1).reduce((o, k) => o?.[k], m);
  const last = keys.at(-1)!;
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else if (parent) delete parent[last];
}

async function applyManifest(m: any, appId?: string) {
  for (let attempt = 0; ; attempt++) {
    const token = await configToken();
    try {
      return appId
        ? await api.apps.manifest.update({ token, app_id: appId, manifest: m })
        : await api.apps.manifest.create({ token, manifest: m });
    } catch (e: any) {
      const errs: { message?: string; pointer?: string }[] = e?.data?.errors ?? [];
      // Agent features and new event types are the parts most likely to be
      // unavailable for this workspace/plan; drop them and keep going.
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

/** Create the app on first run; credentials go to .env. */
export async function ensureApp() {
  if (env.SLACK_APP_ID) return;
  const r: any = await applyManifest(manifest());
  setEnv({
    SLACK_APP_ID: r.app_id,
    SLACK_CLIENT_ID: r.credentials.client_id,
    SLACK_CLIENT_SECRET: r.credentials.client_secret,
    SLACK_SIGNING_SECRET: r.credentials.signing_secret,
    SLACK_STATE_SECRET: randomBytes(24).toString('hex'),
  });
  log.info(`created Slack app ${r.app_id} in ${r.team_domain ?? r.team_id}: https://api.slack.com/apps/${r.app_id}`);
}

/** Point the app at the current public URL. Returns true when scopes changed (reinstall needed). */
export async function syncManifest(url: string) {
  const r = await applyManifest(manifest(url), env.SLACK_APP_ID);
  return !!(r as any).permissions_updated;
}

/** PUBLIC_URL if set, else an ngrok tunnel (NGROK_URL pins a reserved domain). */
export async function startTunnel(port: number): Promise<string> {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, '');
  const args = ['http', String(port), '--log', 'stdout', '--log-format', 'json'];
  if (env.NGROK_URL) args.push('--url', env.NGROK_URL);
  const p = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => p.kill());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ngrok did not report a tunnel within 20s')), 20_000);
    p.on('error', (e) => reject(new Error(`ngrok: ${e.message} (install ngrok, or set PUBLIC_URL)`)));
    p.on('exit', (code) => reject(new Error(`ngrok exited with ${code}`)));
    createInterface({ input: p.stdout! }).on('line', (line) => {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (j.msg === 'started tunnel' && j.url) {
        clearTimeout(timer);
        resolve(j.url);
      } else if (j.lvl === 'eror' || j.lvl === 'crit') log.warn('ngrok:', j.err ?? j.msg);
    });
  });
}
