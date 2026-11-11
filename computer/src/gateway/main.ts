// Gateway entry (work 045, item S1): Slack's HTTP endpoint, routing, the
// session and people tables, and the WebSocket hosts dial into. It holds no
// per-session runtime state, so it can restart at any time; Slack retries
// cover events that arrive meanwhile.
//
//   PORT            listen port (3170), on 0.0.0.0
//   SP_DB           SQLite file (./gateway.db)
//   SP_ORIGIN       public origin, e.g. https://calvin.example.com
//   SP_VERSION      code version reported on /healthz (the image has no .git)
//   SP_TUNNEL=1     laptop mode: provision.ts creates/updates the app behind ngrok
//   SP_HOST_TOKENS  comma list of accepted host tokens (plus tokens issued by /setup)
//   GITHUB_ORG      required for /setup's GitHub App step: the organization that will own the app (no default)
//   SP_PEOPLE       JSON array of SlackPerson, upserted into the people table on start
//   SP_SLACK_API_URL  dev only: Slack Web API base URL (a local fake), for every Slack call the gateway makes
//
// Slack credentials come from env first, then the secret store. One HTTP
// server listens the whole time; what answers behind it is either the setup
// routes (no Slack app yet) or Bolt (the app exists). When /setup stores new
// Slack app credentials (onChange('slack')), Bolt is rebuilt in-process and
// swapped in: no restart, the host WebSockets stay connected, and Slack's URL
// verification right after `apps.manifest.update` is answered with the new
// signing secret. GET /healthz answers 200 in both modes.

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { App, LogLevel, type CustomRoute, type Installation, type InstallationStore } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { loadEnv, setEnv } from '../env.js';
import { SCOPES, ensureApp, startTunnel, syncManifest } from '../provision.js';
import { type HostCredentials, isSlackSpec, type PermissionMode, type SlackPerson } from '../protocol.js';
import { openSecrets, type Secrets } from '../setup/secrets.js';
import { checkHostToken, setupRoutes, slackAppReady, slackReady, type SetupStep } from '../setup/index.js';
import { slackApi } from '../setup/slack.js';
import { mintInstallationToken } from '../github/app.js';
import { Store } from './db.js';
import { Hub } from './hosts.js';
import { Vault } from './vault.js';
import { createSecretsUi, SECRET_VIEW, type SecretsUi } from './secrets-ui.js';
import { createVariablesUi } from './variables-ui.js';
import { createRouter, type Ctx, type Msg, type Router } from './routing.js';
import { installerPerson, type SlackProfile } from './first-person.js';
import { errorText, log } from '../log.js';

loadEnv();
const env = process.env;
const PORT = Number(env.PORT ?? 3170);
const laptop = env.SP_TUNNEL === '1';
const VERSION =
  env.SP_VERSION ||
  (() => {
    try {
      return execFileSync('git', ['-C', import.meta.dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return 'dev';
    }
  })();
const slackClientOptions = env.SP_SLACK_API_URL ? { slackApiUrl: env.SP_SLACK_API_URL } : {};

const store = new Store(env.SP_DB ?? './gateway.db');
const secrets: Secrets = (() => {
  try {
    return openSecrets(store.db);
  } catch (e: any) {
    log.warn(`secret store unavailable (${e?.message}); env only`);
    return { get: (n: string) => env[n] || undefined, set: () => { throw new Error('no secret store'); } };
  }
})();
/** A secret, or undefined when it is missing or cannot be decrypted (logged once by the store's error). */
const get = (name: string) => {
  try {
    return secrets.get(name) || undefined;
  } catch (e: any) {
    log.warn(e?.message ?? e);
    return undefined;
  }
};

for (const p of JSON.parse(env.SP_PEOPLE ?? '[]') as SlackPerson[]) store.putPerson(p);

// Secrets people give their sessions (work 046), encrypted with SP_STORE_KEY.
const vault = new Vault(store.db);
const purge = () => {
  const n = vault.purge();
  if (n) log.info(`purged ${n} session secret(s) of inactive sessions`);
};
purge();
setInterval(purge, 24 * 3600_000).unref();

const credentials = (): HostCredentials => {
  const claude = get('CLAUDE_CODE_OAUTH_TOKEN');
  return {
    slackBotToken: get('SLACK_BOT_TOKEN') ?? '',
    slackBotUserId: get('SLACK_BOT_USER_ID') ?? '',
    teamId: get('SLACK_TEAM_ID'),
    ...(claude ? { claudeOAuthToken: claude } : { anthropicApiKey: get('ANTHROPIC_API_KEY') }),
  };
};

const hub = new Hub({
  store,
  tokens: (env.SP_HOST_TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean),
  checkToken: (t) => checkHostToken(store.db, t),
  credentials,
  mintToken: (repos) => mintInstallationToken(secrets, repos),
  spawn: (from, req) => {
    if (!slackRouter) throw new Error('Slack is not set up on the gateway');
    return slackRouter.spawn(from, req, new WebClient(get('SLACK_BOT_TOKEN'), slackClientOptions));
  },
  readThread: (from, host, req) => {
    if (!slackRouter) throw new Error('Slack is not set up on the gateway');
    return slackRouter.threads.read(from, host, req, new WebClient(get('SLACK_BOT_TOKEN'), slackClientOptions));
  },
  postThread: (from, host, req) => {
    if (!slackRouter) throw new Error('Slack is not set up on the gateway');
    return slackRouter.threads.post(from, host, req, new WebClient(get('SLACK_BOT_TOKEN'), slackClientOptions));
  },
  secretsFor: (spec) => (isSlackSpec(spec) ? vault.forSession(spec.key, spec.owner.slackUserId) : []),
  requestSecret: (from, req) => secretsUi.request(from, req, new WebClient(get('SLACK_BOT_TOKEN'), slackClientOptions)),
});
const secretsUi: SecretsUi = createSecretsUi({ store, vault, hub });
const variablesUi = createVariablesUi({ store, vault, hub });
/** The current Slack router (rebuilt with Bolt on reload); spawn requests from hosts go through it. */
let slackRouter: Router | undefined;

let origin = (env.SP_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/$/, '');
if (laptop) {
  await ensureApp();
  origin = await startTunnel(PORT);
}

/** A setup step stored something: Slack app credentials rebuild Bolt; a new Claude token goes to the hosts. */
function onChange(step: SetupStep) {
  if (step === 'slack') reload();
  if (step === 'claude' || step === 'slack') hub.refreshCredentials();
}

const routes = (): CustomRoute[] => {
  try {
    return setupRoutes({
      secrets,
      origin,
      db: store.db,
      onPush: (repo, ref) => hub.broadcast({ t: 'pushed', repo, ref }),
      onChange,
      ...(env.SP_SLACK_API_URL ? { slack: slackApi(new WebClient(undefined, slackClientOptions)) } : {}),
    });
  } catch (e: any) {
    log.warn(`setup routes unavailable: ${e?.message}`);
    return [];
  }
};

/**
 * Bolt can run once the Slack app exists: with its client id and secret it
 * also serves the OAuth install (S3's slackAppReady); a signing secret and a
 * bot token alone also work (S3's slackReady; env-configured instances).
 */
const slackConfigured = () => {
  const s = { get, set: secrets.set };
  return slackAppReady(s) || slackReady(s);
};

// ---------------------------------------------------------------- one server, two modes

let mode: 'setup' | 'slack' = 'setup';
let handler: RequestListener = setupHandler();

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD'))
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, mode, version: VERSION, hosts: hub.connected }));
  try {
    handler(req, res);
  } catch (e: any) {
    log.warn('request', path, e?.message ?? e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});
hub.attach(server);
reload();
await new Promise<void>((ok) => server.listen(PORT, '0.0.0.0', ok));
log.info(`gateway ${VERSION} on ${origin} (port ${PORT}, ${mode} mode; hosts dial ${origin.replace(/^http/, 'ws')}/host)`);
if (mode === 'setup') log.info(`Slack app not configured yet: ${origin}/setup`);
else await afterSlackStart();

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: gateway stopping`);
    // Container platforms allow ~10 s before SIGKILL; hosts reconnect to the next machine on their own.
    setTimeout(() => process.exit(0), 5000).unref();
    hub.closeAll();
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 1000).unref();
  });

/** (Re)build what answers HTTP: Bolt when the Slack app exists, else the setup routes. */
function reload() {
  if (!slackConfigured()) {
    handler = setupHandler();
    mode = 'setup';
    return;
  }
  try {
    handler = boltHandler();
    if (mode === 'setup') log.info('Slack app configured: serving Slack');
    else log.info('Slack credentials changed: Bolt reloaded');
    mode = 'slack';
  } catch (e: any) {
    log.error(`Bolt failed to start, staying in ${mode} mode:`, e?.message ?? e);
  }
}

// ---------------------------------------------------------------- setup mode

/** Only the setup routes (and /host, /healthz) until the Slack app exists. */
function setupHandler(): RequestListener {
  const table = routes();
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const r = table.find((r) => r.path === path && [r.method].flat().some((m) => m.toUpperCase() === req.method));
    if (r) return void r.handler(req as any, res);
    res.writeHead(path === '/' ? 302 : 404, path === '/' ? { location: '/setup' } : {}).end();
  };
}

// ---------------------------------------------------------------- Slack mode

function boltHandler(): RequestListener {
  // The one installation of this instance: the secret store, or .env on a laptop.
  const installationStore: InstallationStore = {
    storeInstallation: async (i: Installation) => {
      const values = {
        SLACK_BOT_TOKEN: i.bot?.token,
        SLACK_BOT_ID: i.bot?.id,
        SLACK_BOT_USER_ID: i.bot?.userId,
        SLACK_TEAM_ID: i.team?.id,
      };
      if (laptop) setEnv(values);
      else for (const [k, v] of Object.entries(values)) if (v) secrets.set(k, v);
      log.info(`installed to ${i.team?.name ?? i.team?.id}`);
      // A fresh instance answers its installer without SP_PEOPLE (work 101, first-person.ts).
      const installer = i.user?.id;
      if (installer && !store.people().length) {
        const info = await new WebClient(i.bot?.token, slackClientOptions).users.info({ user: installer }).catch(() => undefined);
        store.putPerson(installerPerson(installer, info?.user as SlackProfile | undefined));
        log.info(`${installer} installed the app and is the first person (admin)`);
        hub.broadcast({ t: 'people', people: store.people() });
      }
      hub.refreshCredentials();
    },
    fetchInstallation: async () => {
      const token = get('SLACK_BOT_TOKEN');
      if (!token) throw new Error(`not installed yet: open ${origin}/slack/install`);
      return {
        team: { id: get('SLACK_TEAM_ID')! },
        enterprise: undefined,
        user: { token: undefined, scopes: undefined, id: '' },
        bot: { token, id: get('SLACK_BOT_ID')!, userId: get('SLACK_BOT_USER_ID')!, scopes: SCOPES },
      } as Installation;
    },
    deleteInstallation: async () => (laptop ? setEnv({ SLACK_BOT_TOKEN: '' }) : secrets.set('SLACK_BOT_TOKEN', '')),
  };

  const signingSecret = get('SLACK_SIGNING_SECRET')!;
  const clientId = get('SLACK_CLIENT_ID');
  const clientSecret = get('SLACK_CLIENT_SECRET');
  const oauth = !!(clientId && clientSecret);
  const app = new App({
    signingSecret,
    customRoutes: routes(),
    logLevel: LogLevel.WARN,
    clientOptions: slackClientOptions,
    ...(oauth
      ? {
          clientId,
          clientSecret,
          stateSecret: get('SLACK_STATE_SECRET') ?? createHash('sha256').update(`state:${signingSecret}`).digest('hex'),
          scopes: SCOPES,
          redirectUri: `${origin}/slack/oauth_redirect`,
          installationStore,
          installerOptions: { directInstall: true, redirectUriPath: '/slack/oauth_redirect', clientOptions: slackClientOptions },
        }
      : { token: get('SLACK_BOT_TOKEN'), botUserId: get('SLACK_BOT_USER_ID'), tokenVerificationEnabled: false }),
  });

  const router = (slackRouter = createRouter({
    store,
    hub,
    mode: (env.PERMISSION_MODE ?? 'bypassPermissions') as PermissionMode,
    secrets: secretsUi,
    variables: variablesUi,
  }));
  const ctx = (client: any, body: any, context: any): Ctx => ({
    client,
    botUserId: context.botUserId,
    teamId: body.team_id,
    eventId: body.event_id,
  });

  app.event('app_mention', async ({ event, body, client, context }) => {
    await router.route(event as unknown as Msg, ctx(client, body, context), true);
  });

  app.message(async ({ message, body, client, context }) => {
    const m = message as any;
    if ((m.subtype && m.subtype !== 'file_share' && m.subtype !== 'thread_broadcast') || m.bot_id) return;
    await router.route(m, ctx(client, body, context), false);
  });

  app.event('agent_session_stopped' as any, async ({ event, body }: any) => {
    await router.stop(event, body.event_id);
  });

  // post_card's link buttons (post-card.ts): Slack opens the URL; acked so it shows no error.
  app.action(/^link-/, async ({ ack }) => void (await ack()));

  app.action(/^p:/, async ({ ack, action, body, client }) => {
    await ack();
    await router.action((action as any).action_id, body.user.id, client, (body as any).channel?.id);
  });

  // "Enter NAME" buttons open the secret modal; its submission stores the value (secrets-ui.ts).
  app.action(/^s:/, async ({ ack, action, body, client }) => {
    await ack();
    await secretsUi.open((action as { action_id: string }).action_id, body, client);
  });

  // "Set it anyway" on a variable that looks like a credential (variables-ui.ts).
  app.action(/^v:/, async ({ ack, action, body, respond }) => {
    await ack();
    const a = action as { action_id: string; value?: string };
    await variablesUi.confirm(a.action_id, a.value ?? '', body, respond);
  });

  app.view(SECRET_VIEW, async ({ ack, view, body, client }) => {
    const r = secretsUi.submit(view, body.user.id);
    if ('errors' in r) return void (await ack({ response_action: 'errors', errors: r.errors }));
    await ack();
    await r.done(client).catch((e) => log.warn('secret saved, follow-up failed:', errorText(e)));
  });

  // Bolt's own HTTPReceiver, used as a request listener on our server (never app.start()).
  const receiver = (app as any).receiver as { requestListener: RequestListener };
  return receiver.requestListener;
}

async function afterSlackStart() {
  if (laptop) {
    // The server must be up first: Slack verifies the events URL on update.
    const scopesChanged = await syncManifest(origin);
    if (!get('SLACK_BOT_TOKEN') || scopesChanged) {
      const install = `${origin}/slack/install`;
      log.info(`${scopesChanged ? 'scopes changed, reinstall' : 'install the app'}: ${install}`);
      spawn('open', [install], { stdio: 'ignore' }).on('error', () => {});
    }
  } else if (!get('SLACK_BOT_TOKEN')) log.info(`install the app: ${origin}/slack/install`);
}
