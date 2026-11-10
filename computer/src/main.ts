// Slack entry point. `npm start` provisions everything: rotates the config
// token, creates/updates the Slack app from code, opens an ngrok tunnel for
// events + OAuth, and installs via a browser click (see provision.ts).
//
//   @bot <task>        in a channel   → session in that thread
//   @bot ch <task>     in a channel   → session in a new Slack Code channel
//   DM the bot                        → session in that DM thread
//   reply in the thread / code channel → steer (mid-turn) or continue
//   !stop !mode !model !status !diff !done; +smart / +fast at the start of a message

import { bootCommit } from './build.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { App, LogLevel, type Installation, type InstallationStore } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { loadEnv, setEnv } from './env.js';
import { SCOPES, ensureApp, startTunnel, syncManifest } from './provision.js';
import { Session, prompts, type SessionInfo } from './runner/session.js';
import { panels } from './runner/agents.js';
import { ensureWorkdir } from './workspace.js';
import { addressed, decodeSlack } from './slack-text.js';
import { fetchAttachments, type SlackFile } from './runner/attachments.js';
import { linkResolver, withLinked } from './links.js';
import { log } from './log.js';
import { decodeActionId, type PermissionMode } from './protocol.js';
import { takeTier } from './tiers.js';
import { applyPromptCacheTtl, presetTtls } from './runner/cache-ttl.js';
import { configureCompaction } from './runner/harness/claude/shadow.js';

loadEnv();
const env = process.env;
const STATE = path.resolve(import.meta.dirname, '..', 'state.json');
const DEFAULT_MODE = (env.PERMISSION_MODE ?? 'bypassPermissions') as PermissionMode;
const PORT = Number(env.PORT ?? 3170);
// Prompt cache TTL for Claude Code: 1 hour on Anthropic's own API (runner/cache-ttl.ts).
applyPromptCacheTtl(env, env.SP_PROMPT_CACHE_TTL, presetTtls(env));
// Compaction: between turns in a fork (runner/harness/claude/shadow.ts), Claude Code's own as the backstop.
configureCompaction(env);

await ensureApp();
const url = await startTunnel(PORT);

// Single-workspace prototype: the one installation lives in .env.
const installationStore: InstallationStore = {
  storeInstallation: async (i: Installation) => {
    setEnv({
      SLACK_BOT_TOKEN: i.bot?.token,
      SLACK_BOT_ID: i.bot?.id,
      SLACK_BOT_USER_ID: i.bot?.userId,
      SLACK_TEAM_ID: i.team?.id,
    });
    log.info(`installed to ${i.team?.name ?? i.team?.id}`);
  },
  fetchInstallation: async () => {
    if (!env.SLACK_BOT_TOKEN) throw new Error(`not installed yet: open ${url}/slack/install`);
    return {
      team: { id: env.SLACK_TEAM_ID! },
      enterprise: undefined,
      user: { token: undefined, scopes: undefined, id: '' },
      bot: { token: env.SLACK_BOT_TOKEN, id: env.SLACK_BOT_ID!, userId: env.SLACK_BOT_USER_ID!, scopes: SCOPES },
    } as Installation;
  },
  deleteInstallation: async () => setEnv({ SLACK_BOT_TOKEN: '' }),
};

const app = new App({
  signingSecret: env.SLACK_SIGNING_SECRET!,
  clientId: env.SLACK_CLIENT_ID,
  clientSecret: env.SLACK_CLIENT_SECRET,
  stateSecret: env.SLACK_STATE_SECRET,
  scopes: SCOPES,
  redirectUri: `${url}/slack/oauth_redirect`,
  installationStore,
  installerOptions: { directInstall: true, redirectUriPath: '/slack/oauth_redirect' },
  logLevel: LogLevel.WARN,
});

// ---- session registry, persisted so a restart resumes conversations

const infos: Record<string, SessionInfo> = (() => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
})();
const live = new Map<string, Session>();
const persist = () => writeFileSync(STATE, JSON.stringify(infos, null, 2));

function sessionFor(key: string, client: WebClient): Session | undefined {
  let s = live.get(key);
  if (!s && infos[key]) live.set(key, (s = new Session(infos[key], client, persist)));
  if (s) s.client = client;
  return s;
}

function create(info: SessionInfo, client: WebClient): Session {
  infos[info.key] = info;
  persist();
  const s = new Session(info, client, persist);
  live.set(info.key, s);
  return s;
}

// ---- routing

interface Msg {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  channel_type?: string;
  files?: SlackFile[];
}

const seen = new Set<string>();
const once = (m: Msg) => {
  const k = `${m.channel}:${m.ts}`;
  if (seen.has(k)) return false;
  seen.add(k);
  if (seen.size > 5000) seen.delete(seen.values().next().value!);
  return true;
};

interface Ctx {
  client: WebClient;
  botUserId?: string;
  teamId?: string;
}

async function route(m: Msg, ctx: Ctx, mentioned: boolean) {
  const { client, botUserId, teamId } = ctx;
  if (!m.user || m.user === botUserId || !once(m)) return;
  // Slack sends both `message` and `app_mention` for a mention, in either
  // order, and `once` drops the second. Read the mention from the text so
  // whichever arrives first starts the session.
  const a = addressed(m.text ?? '', botUserId, env.SLACK_APP_NAME ?? 'Computer');
  mentioned ||= a.mentioned;
  const text = decodeSlack(a.text).trim();
  if (!text && !m.files?.length) return;

  const existing =
    sessionFor(m.channel, client) ?? (m.thread_ts ? sessionFor(`${m.channel}:${m.thread_ts}`, client) : undefined);
  // In a DM or a code channel every message is for the bot.
  if (existing) return deliver(existing, m, text, mentioned || m.channel_type === 'im' || existing.info.kind === 'channel');

  if (!mentioned && m.channel_type !== 'im') return;

  const { tier, rest } = takeTier(text);
  const wantsChannel = /^(ch|channel)\b/i.test(rest) && m.channel_type !== 'im';
  const task = wantsChannel ? (tier ? `+${tier} ` : '') + rest.replace(/^(ch|channel)\b\s*/i, '') : text;
  const title = takeTier(task).rest;
  if (wantsChannel) {
    const s = await startCodeChannel(m, ctx, title);
    if (s) return deliver(s, m, task);
  }
  const threadTs = m.thread_ts ?? m.ts;
  const key = `${m.channel}:${threadTs}`;
  const s = create({
    key,
    kind: 'thread',
    channel: m.channel,
    threadTs,
    userId: m.user,
    teamId,
    cwd: await ensureWorkdir(key),
    title: title.slice(0, 80),
    mode: DEFAULT_MODE,
  }, client);
  return deliver(s, m, task, true, !!m.thread_ts && m.thread_ts !== m.ts);
}

const resolveLinks = linkResolver();

async function deliver(s: Session, m: Msg, text: string, mentioned = true, midThread = false) {
  if (text.startsWith('!')) return s.command(text, m.user!);
  if (s.isBusy) void s.client.reactions.add({ channel: m.channel, timestamp: m.ts, name: 'eyes' }).catch(() => {});
  const atts = await fetchAttachments(m.files, s.client.token ?? env.SLACK_BOT_TOKEN, s.info.key);
  // One machine has no people table: whoever posts is the owner for the link check (work 049).
  const req = { text, poster: m.user!, owner: m.user!, destination: m.channel };
  const linked = await resolveLinks(s.client, req);
  // Mentioned mid-thread: the replies above, so the new session sees what it was asked about.
  if (midThread) linked.unshift(await resolveLinks.thread(s.client, req, m.thread_ts!, m.ts));
  await s.send(withLinked(text, linked), m.user!, atts, mentioned);
}

async function startCodeChannel(m: Msg, { client, teamId }: Ctx, task: string) {
  const key0 = `cc-${m.channel}-${m.ts}`;
  try {
    const r = await client.agents.conversations.create({
      name: task.slice(0, 60) || 'claude session',
      origin_channel_id: m.channel,
      origin_message_ts: m.ts,
      session_id: key0,
    });
    const channel = r.channel_id!;
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.ts,
      text: `On it in <#${channel}>`,
    });
    const s = create({
      key: channel,
      kind: 'channel',
      channel,
      userId: m.user!,
      teamId,
      cwd: await ensureWorkdir(key0),
      title: task.slice(0, 80),
      mode: DEFAULT_MODE,
    }, client);
    void s.updateContextBar();
    return s;
  } catch (e: any) {
    log.warn('agents.conversations.create failed, using a thread:', e?.data?.error ?? e?.message);
    await client.chat
      .postMessage({
        channel: m.channel,
        thread_ts: m.ts,
        text: `Couldn't open a code channel (\`${e?.data?.error ?? 'error'}\`), working here instead.`,
      })
      .catch(() => {});
    return undefined;
  }
}

// ---- events

app.event('app_mention', async ({ event, body, client, context }) => {
  await route(event as unknown as Msg, { client, botUserId: context.botUserId, teamId: (body as any).team_id }, true);
});

app.message(async ({ message, body, client, context }) => {
  const m = message as any;
  if ((m.subtype && m.subtype !== 'file_share' && m.subtype !== 'thread_broadcast') || m.bot_id) return;
  await route(m, { client, botUserId: context.botUserId, teamId: (body as any).team_id }, false);
});

// Slack's native stop button on a processing agent session.
app.event('agent_session_stopped' as any, async ({ event, client }: any) => {
  const s = sessionFor(event.channel, client) ?? sessionFor(`${event.channel}:${event.thread_ts}`, client);
  log.info('stop button', event.channel, event.thread_ts, !!s);
  await s?.interrupt();
});

// post_card's link buttons (post-card.ts): Slack opens the URL; acked so it shows no error.
app.action(/^link-/, async ({ ack }) => void (await ack()));

app.action(/^p:/, async ({ ack, action, body }) => {
  await ack();
  const a = decodeActionId((action as any).action_id);
  const p = a && prompts.get(a.promptId);
  if (a && p) await p.onAction(a.value, body.user.id);
});

app.action(/^a:/, async ({ ack, action, body }) => {
  await ack();
  const [, pid, verb, taskId] = (action as any).action_id.split(':');
  await panels.get(pid)?.onAction(verb, taskId, (body as any).trigger_id);
});

await app.start(PORT);
// The server must be up first: Slack verifies the events URL on update.
const scopesChanged = await syncManifest(url);
log.info(`slack-presence ${bootCommit ?? "?"} on ${url} (app ${env.SLACK_APP_ID}); workdir: ${env.WORKDIR ?? './workspaces/<session>'}`);
if (!env.SLACK_BOT_TOKEN || scopesChanged) {
  const install = `${url}/slack/install`;
  log.info(`${scopesChanged ? 'scopes changed, reinstall' : 'install the app'}: ${install}`);
  spawn('open', [install], { stdio: 'ignore' }).on('error', () => {});
}
