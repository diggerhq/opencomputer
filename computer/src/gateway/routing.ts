// Slack events → sessions → hosts. Ported from the monolith's route() in
// src/main.ts; the difference is that a session is a row and a host, not an
// in-process object, and the gateway gives the immediate feedback itself.
//
//   @bot <task>        in a channel    → new session in that thread
//   @bot ch <task>     in a channel    → new session in a new Slack Code channel
//   @bot +codex <task>                 → the new session runs Codex (when the gateway has OPENAI_API_KEY)
//   DM the bot                         → new session in that DM thread
//   reply in a session's thread/channel → deliver (`!` commands too: the runner handles them),
//                                          marked mentioned or not; the agent may stay silent
//   spawn_thread from a session         → new session in a new top-level message (work 047)
//   read_thread / post_thread from a session → threads.ts, with this router's link resolver (work 049 L3)
//   `!secret …` wherever the bot is addressed → handled here, never delivered (secrets-ui.ts, work 046)
//   `!var …` likewise (variables-ui.ts)
//
// Only people in the people table get a session; anyone else gets an ephemeral
// "not enabled for you yet" and nothing else.

import type { WebClient } from '@slack/web-api';
import { decodeActionId, type Delivery, type HarnessName, type PermissionMode, type SlackPerson, type SlackSessionSpec, type SpawnRequest, type SpawnResult } from '../protocol.js';
import type { SlackFile } from '../protocol.js';
import type { ModelRoutes } from '../protocol-model.js';
import { addressed, decodeSlack } from '../slack-text.js';
import { findPermalinks, forwarded, linkResolver, type Linked, type SharedAttachment } from '../links.js';
import { TIERS, takeTier } from '../tiers.js';
import type { Store } from './db.js';
import { threadAccess } from './threads.js';
import type { Hub, Reply } from './hosts.js';
import type { SecretsUi } from './secrets-ui.js';
import type { VariablesUi } from './variables-ui.js';
import { log } from '../log.js';

export interface Msg {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  channel_type?: string;
  files?: SlackFile[];
  attachments?: SharedAttachment[];
}

export interface Ctx {
  client: WebClient;
  botUserId?: string;
  teamId?: string;
  /** Slack's event_id: retries of an unacked event carry the same one. */
  eventId?: string;
}

export interface RouterDeps {
  store: Store;
  hub: Hub;
  mode: PermissionMode;
  /** The model routes hosts get (main.ts): a thread starts on Codex only when there is one for it. */
  models(): ModelRoutes;
  secrets?: SecretsUi;
  variables?: VariablesUi;
}

const APP_NAME = process.env.SLACK_APP_NAME ?? 'Computer';
const NOT_ENABLED = `${APP_NAME} is not enabled for you yet. Ask the instance owner to add you.`;
const OFFLINE = 'The agent host is offline; your message will be delivered when it reconnects.';
/** Reading linked threads must not hold a message up for long. */
const LINKS_TIMEOUT_MS = 10_000;
const CODEX_NEEDS_KEY = 'Codex needs OPENAI_API_KEY on this computer.';

/** `+codex fix it` → `{ harness: 'codex', text: 'fix it' }`; the first message of a thread picks its harness. */
export function takeHarness(text: string): { harness?: HarnessName; text: string } {
  const m = /^\+(claude|codex)(?=\s|$)\s*/i.exec(text);
  return m ? { harness: m[1].toLowerCase() as HarnessName, text: text.slice(m[0].length) } : { text };
}

export function createRouter({ store, hub, mode, models, secrets, variables }: RouterDeps) {
  // Slack sends both `message` and `app_mention` for a mention (different
  // event ids, same channel:ts); the first one routes, the second is dropped.
  const seen = new Set<string>();
  const once = (m: Msg) => {
    const k = `${m.channel}:${m.ts}`;
    if (seen.has(k)) return false;
    seen.add(k);
    if (seen.size > 5000) seen.delete(seen.values().next().value!);
    return true;
  };
  const fresh = (eventId?: string) => !eventId || store.firstSeen(eventId);
  const resolveLinks = linkResolver();
  // Reading links takes a moment; a session's messages still reach it in the order they were posted.
  const sending = new Map<string, Promise<unknown>>();

  const lookup = (channel: string, threadTs?: string) =>
    store.session(channel) ?? (threadTs ? store.session(`${channel}:${threadTs}`) : undefined);

  async function route(m: Msg, ctx: Ctx, mentioned: boolean) {
    const { client, botUserId } = ctx;
    if (!m.user || m.user === botUserId || !fresh(ctx.eventId) || !once(m)) return;
    const a = addressed(m.text ?? '', botUserId, APP_NAME);
    // Bolt's app_mention says mentioned; the text says where.
    mentioned ||= a.mentioned;
    const text = decodeSlack(a.text).trim();
    if (!text && !m.files?.length && !forwarded(m.attachments).length) return;

    const existing = lookup(m.channel, m.thread_ts);
    if (!existing && !mentioned && m.channel_type !== 'im') return;
    const person = store.person(m.user);
    // Someone else talking in a session's thread is not asking for access.
    if (!person) return mentioned || !existing ? notEnabled(m, client) : undefined;
    if (secrets && /^!secrets?(\s|$)/i.test(text)) return secrets.command(text, m, person, existing?.spec, client);
    if (variables && (await variables.command(text, m, person, existing?.spec, client))) return;
    // In a DM or a code channel every message is for the bot.
    if (existing) return forward(existing.spec, m, text, client, mentioned || m.channel_type === 'im' || existing.spec.kind === 'channel', a.inline);

    // `+codex` first; then `+smart ch <task>` and `ch +smart <task>` both work; the tier stays on the task for the session.
    const { harness, text: asked } = takeHarness(text);
    if (harness === 'codex' && !models().codex) return ephemeral(client, m.channel, m.user, CODEX_NEEDS_KEY, m.thread_ts);
    const { tier, rest } = takeTier(asked);
    const wantsChannel = /^(ch|channel)\b/i.test(rest) && m.channel_type !== 'im';
    const task = wantsChannel ? (tier ? `+${tier} ` : '') + rest.replace(/^(ch|channel)\b\s*/i, '') : asked;
    const title = takeTier(task).rest.replace(/\s+/g, ' ');
    const threadTs = m.thread_ts ?? m.ts;
    const spec: SlackSessionSpec = {
      ...((wantsChannel && (await codeChannel(m, ctx, title, person))) || {
        key: `${m.channel}:${threadTs}`,
        kind: 'thread',
        channel: m.channel,
        threadTs,
        owner: person,
        teamId: ctx.teamId,
        title: title.slice(0, 80),
        mode,
      }),
      ...(harness ? { harness } : {}),
    };
    store.putSession(spec);
    log.info(`new session ${spec.key} for ${person.dir}`);
    // Mentioned mid-thread: the session also gets the replies above (it only sees what reaches it from now on).
    const midThread = spec.kind === 'thread' && !!m.thread_ts && m.thread_ts !== m.ts;
    return forward(spec, m, task, client, true, a.inline, midThread, spec.kind === 'thread');
  }

  /** Feedback first (< 1 s, no await), then hand to the host. */
  async function forward(spec: SlackSessionSpec, m: Msg, text: string, client: WebClient, mentioned?: boolean, inline = false, midThread = false, fresh = false) {
    const msg: Delivery = {
      userId: m.user!,
      text,
      ts: m.ts,
      ...(m.files?.length ? { files: m.files } : {}),
      ...(mentioned !== undefined ? { mentioned } : {}),
      ...(mentioned && inline ? { mentionedInline: true } : {}),
    };
    const command = text.startsWith('!') && !text.startsWith('!!');
    const online = hub.connected.length > 0;
    // A reply that @mentions other people and not the bot is most likely for
    // them: no "thinking…" flash; the agent decides whether to answer.
    // Same for a bot mentioned only mid-message ("I'll ask @bot later").
    const elsewhere = (mentioned === false && /<@[UW]/.test(m.text ?? '')) || (mentioned && inline);
    if (online && !command && !elsewhere) acknowledge(spec, m, client, fresh);
    // Only what people type: a spawned thread's first message links its parent on purpose.
    const reading =
      mentioned !== undefined && !command
        ? Promise.all([midThread ? threadAbove(spec, m, client) : [], linkedFor(spec, m.user!, text, client).catch(() => [])]).then((r) => r.flat())
        : [];
    const ready = Promise.all([sending.get(spec.key), reading]);
    sending.set(spec.key, ready);
    const [, linked] = await ready;
    if (sending.get(spec.key) === ready) sending.delete(spec.key);
    const all = [...forwarded(m.attachments), ...linked];
    if (all.length) msg.linked = all;
    const r = await hub.deliver(spec, msg);
    if (r === 'queued') return ephemeral(client, m.channel, m.user!, OFFLINE, m.thread_ts);
    if (!r.ok) await failed(spec, r, client);
  }

  /** The replies above a mid-thread mention, or why not; bounded like links. */
  async function threadAbove(spec: SlackSessionSpec, m: Msg, client: WebClient): Promise<Linked[]> {
    const req = { text: '', poster: m.user!, owner: spec.owner.slackUserId, destination: m.channel };
    const timeout = new Promise<Linked>((ok) => setTimeout(() => ok({ url: '', ok: false, reason: 'reading it took too long', here: true }), LINKS_TIMEOUT_MS).unref());
    const l = await Promise.race([resolveLinks.thread(client, req, m.thread_ts!, m.ts), timeout]);
    log.info(`thread above ${spec.key}: ${l.ok ? `read ${l.messages.length}` : `refused (${l.reason})`}`);
    return [l];
  }

  /** Permalinks in a message, read or refused (work 049); bounded so delivery is never held up for long. */
  async function linkedFor(spec: SlackSessionSpec, poster: string, text: string, client: WebClient): Promise<Linked[]> {
    const links = findPermalinks(text);
    if (!links.length) return [];
    const timeout = new Promise<Linked[]>((ok) =>
      setTimeout(() => ok(links.map((l) => ({ url: l.url, ok: false, reason: 'reading it took too long' }))), LINKS_TIMEOUT_MS).unref(),
    );
    const linked = await Promise.race([resolveLinks(client, { text, poster, owner: spec.owner.slackUserId, destination: spec.channel }), timeout]);
    // Outcomes only: never the content.
    log.info(`links in ${spec.key}: ${linked.map((l) => (l.ok ? `read ${l.messages.length}` : `refused (${l.reason})`)).join('; ')}`);
    return linked;
  }

  /**
   * Immediate feedback: the agent session status (`is thinking…`), which works
   * in channel threads, DM threads and code channels alike. The runner's
   * Session sets `processing` again at turn start and `active` at turn end, so
   * it clears itself. Where agent sessions are unavailable, a 👀 reaction.
   *
   * A fresh thread session is also renamed: Slack creates the session from the
   * mention before this call, so setStatus's `title` is ignored and the sidebar
   * would show the raw message, `@Computer` and all.
   */
  function acknowledge(spec: SlackSessionSpec, m: Msg, client: WebClient, fresh = false) {
    const thread = spec.kind === 'thread' ? { thread_ts: spec.threadTs } : {};
    const title = spec.title.slice(0, 200);
    void client.agents.sessions
      .setStatus({ channel_id: spec.channel, status: 'processing', ...thread, title, initiator_user_id: spec.owner.slackUserId })
      .then(() => {
        if (!fresh || !title) return;
        return client.agents.sessions.rename({ channel_id: spec.channel, ...thread, title }).catch((e) => log.warn('agents.sessions.rename', e?.data?.error ?? e?.message));
      })
      .catch(() => client.reactions.add({ channel: m.channel, timestamp: m.ts, name: 'eyes' }).catch(() => {}));
  }

  /** The host could not take the message: say so in the thread and clear the status. */
  async function failed(spec: SlackSessionSpec, r: Reply, client: WebClient) {
    log.warn(`deliver to ${spec.key} failed: ${r.error}`);
    if (r.error === 'timeout') return; // the runner may still be starting; it clears the status itself
    const thread = spec.kind === 'thread' ? { thread_ts: spec.threadTs } : {};
    await client.chat.postMessage({ channel: spec.channel, ...thread, text: `:warning: couldn't reach the session: ${r.error}` }).catch(() => {});
    await client.agents.sessions.setStatus({ channel_id: spec.channel, status: 'active', ...thread }).catch(() => {});
  }

  async function notEnabled(m: Msg, client: WebClient) {
    log.info(`not enabled: ${m.user} in ${m.channel}`);
    await ephemeral(client, m.channel, m.user!, NOT_ENABLED, m.thread_ts);
  }

  async function ephemeral(client: WebClient, channel: string, user: string, text: string, threadTs?: string) {
    await client.chat
      .postEphemeral({ channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
      .catch((e) => log.warn('postEphemeral', e?.data?.error ?? e?.message));
  }

  /** `@bot ch <task>`: open a Slack Code channel; undefined falls back to a thread. */
  async function codeChannel(m: Msg, { client, teamId }: Ctx, task: string, owner: SlackPerson): Promise<SlackSessionSpec | undefined> {
    try {
      const r = await client.agents.conversations.create({
        name: task.slice(0, 60) || 'claude session',
        origin_channel_id: m.channel,
        origin_message_ts: m.ts,
        session_id: `cc-${m.channel}-${m.ts}`,
      });
      const channel = r.channel_id!;
      await client.chat.postMessage({ channel: m.channel, thread_ts: m.ts, text: `On it in <#${channel}>` });
      return { key: channel, kind: 'channel', channel, owner, teamId, title: task.slice(0, 80), mode };
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

  /** Slack's native stop button on a processing agent session. */
  async function stop(ev: { channel: string; thread_ts?: string }, eventId?: string) {
    if (!fresh(eventId)) return;
    const row = lookup(ev.channel, ev.thread_ts);
    log.info('stop button', ev.channel, ev.thread_ts, !!row);
    if (!row) return;
    const r = await hub.stop(row.spec.key);
    if (!r.ok) log.warn(`stop ${row.spec.key}: ${r.error}`);
  }

  /** A prompt button: `p:<base64url(sessionKey)>:<promptId>:<value>`. */
  async function action(actionId: string, userId: string, client: WebClient, channel?: string) {
    const a = decodeActionId(actionId);
    if (!a) return log.warn('unknown action id', actionId);
    if (!store.person(userId)) return channel ? ephemeral(client, channel, userId, NOT_ENABLED) : undefined;
    if (!store.session(a.sessionKey)) return log.warn('action for unknown session', a.sessionKey);
    const r = await hub.action(a.sessionKey, a.promptId, a.value, userId);
    if (r === 'queued') return channel ? ephemeral(client, channel, userId, OFFLINE) : undefined;
    if (!r.ok) log.warn(`action for ${a.sessionKey}: ${r.error}`);
  }

  /**
   * A session starts a thread (work 047): post a short top-level message where
   * the owner sees it, and start a session on it as if they had mentioned the
   * bot there, with the parent's owner, mode and model. A code channel's
   * top-level messages belong to its session, so its children go to the DM.
   */
  async function spawn(from: string, req: SpawnRequest, client: WebClient): Promise<SpawnResult> {
    const parent = store.session(from)?.spec;
    if (!parent) throw new Error(`unknown session ${from}`);
    const { owner } = parent;
    const channel =
      parent.kind === 'channel' ? (await client.conversations.open({ users: owner.slackUserId })).channel?.id : parent.channel;
    if (!channel) throw new Error('could not open a DM with the owner');
    const link = async (ch: string, ts?: string) =>
      ts ? (await client.chat.getPermalink({ channel: ch, message_ts: ts }).catch(() => undefined))?.permalink : undefined;
    const parentUrl = await link(parent.channel, parent.threadTs);
    const from_ = parentUrl ? `<${parentUrl}|from this thread>` : `from <#${parent.channel}>`;
    const brief = req.briefUrl ? `<${req.briefUrl}|${req.brief}>` : `\`${req.brief}\``;
    const posted = await client.chat.postMessage({
      channel,
      text: `<@${owner.slackUserId}> ↳ ${req.tier ? `+${req.tier} ` : ''}${req.task}\nBrief: ${brief} · ${from_}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    const threadTs = posted.ts!;
    const spec: SlackSessionSpec = {
      key: `${channel}:${threadTs}`,
      kind: 'thread',
      channel,
      threadTs,
      owner,
      teamId: parent.teamId,
      title: req.task.slice(0, 80),
      mode: parent.mode,
      // A tier picks the model; `default` drops the parent's so the runner's default applies.
      ...(req.tier && req.tier !== 'default' ? { model: TIERS[parent.harness ?? 'claude'][req.tier] } : !req.tier && parent.model ? { model: parent.model } : {}),
    };
    store.putSession(spec);
    log.info(`spawned ${spec.key} from ${from} for ${owner.dir}`);
    const text =
      `${req.task}\n\nBrief: ${req.brief}\n` +
      `Started by the session in thread ${from}${parentUrl ? ` (${parentUrl})` : ''}. ` +
      'Read the brief first; claim and report there.';
    // Not awaited: starting the runner can take longer than the parent should wait.
    void forward(spec, { channel, ts: threadTs, thread_ts: threadTs, user: owner.slackUserId }, text, client).catch((e) =>
      log.warn(`deliver to spawned ${spec.key}:`, e?.message ?? e),
    );
    return { key: spec.key, url: await link(channel, threadTs) };
  }

  return { route, stop, action, spawn, threads: threadAccess(store, resolveLinks) };
}

export type Router = ReturnType<typeof createRouter>;
