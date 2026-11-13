// The router against an in-memory store, a recording hub and a recording
// Slack client: who gets a session, what reaches the host, and what Slack sees.

import { beforeEach, describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Delivery, SlackPerson, SlackSessionSpec } from '../protocol.js';
import type { ModelRoutes } from '../protocol-model.js';
import type { Store } from './db.js';
import type { Hub } from './hosts.js';
import { withLinked } from '../links.js';
import { type Ctx, createRouter, type Msg, takeHarness } from './routing.js';

const owner: SlackPerson = { slackUserId: 'U1', dir: 'owner', gitName: 'Owner', gitEmail: 'owner@example.com' };
const BOT = 'UBOT';

function fakeStore() {
  const sessions = new Map<string, SlackSessionSpec>();
  const people = new Map<string, SlackPerson>([[owner.slackUserId, owner]]);
  const events = new Set<string>();
  return {
    sessions,
    session: (key: string) => (sessions.has(key) ? { spec: sessions.get(key)!, updated: 0 } : undefined),
    putSession: (spec: SlackSessionSpec) => void sessions.set(spec.key, spec),
    person: (id: string) => people.get(id),
    firstSeen: (id: string) => (events.has(id) ? false : (events.add(id), true)),
  };
}

function fakeHub(online = true) {
  const delivered: { spec: SlackSessionSpec; msg: Delivery }[] = [];
  const stops: string[] = [];
  return {
    delivered,
    stops,
    get connected() {
      return online ? ['host-1'] : [];
    },
    deliver: async (spec: SlackSessionSpec, msg: Delivery) => (online ? (delivered.push({ spec, msg }), { ok: true }) : 'queued'),
    action: async () => ({ ok: true }),
    stop: async (key: string) => (stops.push(key), { ok: true }),
  };
}

function fakeClient() {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const rec =
    (method: string, result: Record<string, unknown> = { ok: true }) =>
    async (args: Record<string, unknown>) => (calls.push({ method, args }), result);
  return {
    calls,
    of: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
    chat: { postMessage: rec('chat.postMessage', { ok: true, ts: '2.0' }), postEphemeral: rec('chat.postEphemeral') },
    reactions: { add: rec('reactions.add') },
    agents: {
      sessions: { setStatus: rec('agents.sessions.setStatus'), rename: rec('agents.sessions.rename') },
      conversations: { create: rec('agents.conversations.create', { ok: true, channel_id: 'CCODE' }) },
    },
  };
}

let store: ReturnType<typeof fakeStore>;
let hub: ReturnType<typeof fakeHub>;
let client: ReturnType<typeof fakeClient>;
let router: ReturnType<typeof createRouter>;
let n = 0;
let models: ModelRoutes;
const claude = { mode: 'profile', profile: 'anthropic-key', vars: { token: 'fake' }, key: 'k1' } as const;

const msg = (over: Partial<Msg> = {}): Msg => ({ channel: 'C1', ts: `1.${++n}`, user: owner.slackUserId, text: `<@${BOT}> do it`, ...over });
const ctx = (): Ctx => ({ client: client as unknown as WebClient, botUserId: BOT, teamId: 'T1', eventId: `ev-${++n}` });

beforeEach(() => {
  store = fakeStore();
  hub = fakeHub();
  client = fakeClient();
  models = { claude };
  router = createRouter({ store: store as unknown as Store, hub: hub as unknown as Hub, mode: 'bypassPermissions', models: () => models });
});

describe('starting sessions', () => {
  it('a mention by an enabled person starts a thread session and delivers the task', async () => {
    const m = msg();
    await router.route(m, ctx(), true);
    const key = `C1:${m.ts}`;
    expect(store.sessions.get(key)).toMatchObject({ key, kind: 'thread', channel: 'C1', threadTs: m.ts, owner, mode: 'bypassPermissions' });
    expect(hub.delivered).toHaveLength(1);
    expect(hub.delivered[0].msg).toMatchObject({ userId: 'U1', text: 'do it', ts: m.ts, mentioned: true });
    expect(client.of('agents.sessions.setStatus')[0]).toMatchObject({ channel_id: 'C1', thread_ts: m.ts, status: 'processing' });
  });

  it('a new thread session is renamed to the task, without the mention; replies do not rename it', async () => {
    const m = msg({ text: `<@${BOT}> fix   the\nlogin page` });
    await router.route(m, ctx(), true);
    await new Promise((r) => setImmediate(r));
    expect(client.of('agents.sessions.rename')).toEqual([{ channel_id: 'C1', thread_ts: m.ts, title: 'fix the login page' }]);
    await router.route(msg({ thread_ts: m.ts, text: 'and the signup page' }), ctx(), false);
    await new Promise((r) => setImmediate(r));
    expect(client.of('agents.sessions.rename')).toHaveLength(1);
  });

  it('a `message` event carrying the mention starts the session too (whichever arrives first)', async () => {
    await router.route(msg(), ctx(), false);
    expect(hub.delivered[0].msg.mentioned).toBe(true);
  });

  it('a message without a mention outside any session is ignored', async () => {
    await router.route(msg({ text: 'just chatting' }), ctx(), false);
    expect(hub.delivered).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
  });

  it('a DM needs no mention', async () => {
    await router.route(msg({ channel: 'D1', channel_type: 'im', text: 'hi' }), ctx(), false);
    expect(hub.delivered[0].spec.channel).toBe('D1');
    expect(hub.delivered[0].msg.mentioned).toBe(true);
  });

  it('someone not in the people table gets an ephemeral and no session', async () => {
    await router.route(msg({ user: 'U9' }), ctx(), true);
    expect(store.sessions.size).toBe(0);
    expect(hub.delivered).toHaveLength(0);
    expect(client.of('chat.postEphemeral')[0]).toMatchObject({ channel: 'C1', user: 'U9' });
  });

  it('`ch <task>` opens a code channel and keys the session by the channel', async () => {
    const m = msg({ text: `<@${BOT}> ch fix the build` });
    await router.route(m, ctx(), true);
    expect(client.of('agents.conversations.create')[0]).toMatchObject({ origin_channel_id: 'C1', origin_message_ts: m.ts });
    expect(store.sessions.get('CCODE')).toMatchObject({ kind: 'channel', title: 'fix the build' });
    expect(hub.delivered[0].msg.text).toBe('fix the build');
  });

  it('a mention mid-thread starts a session that gets the replies above it, not after', async () => {
    const replies = [
      { ts: '5.0', user: 'U2', text: 'the export is broken' },
      { ts: '5.1', user: 'U3', text: 'since Tuesday' },
      { ts: '5.2', user: owner.slackUserId, text: `<@${BOT}> look into it` },
      { ts: '5.3', user: 'U2', text: 'later' },
    ];
    Object.assign(client, {
      auth: { test: async () => ({ url: 'https://acme.slack.com/' }) },
      users: {
        list: async () => ({
          members: [
            { id: 'U2', name: 'ada' },
            { id: 'U3', name: 'sam' },
            { id: 'U1', name: 'owner' },
          ],
        }),
      },
      conversations: {
        info: async () => ({ channel: { id: 'C1', name: 'eng', is_member: true } }),
        members: async () => ({ members: ['U1', 'U2', 'U3'] }),
        replies: async () => ({ messages: replies }),
      },
    });
    await router.route(msg({ ts: '5.2', thread_ts: '5.0', text: replies[2].text }), ctx(), true);
    const [l] = hub.delivered[0].msg.linked!;
    expect(l).toMatchObject({ ok: true, here: true, where: '#eng' });
    expect(l.ok && l.messages.map((m) => m.text)).toEqual(['the export is broken', 'since Tuesday']);
  });

  it('a mention mid-thread whose thread cannot be read still starts, with a note', async () => {
    Object.assign(client, {
      auth: { test: async () => ({ url: 'https://acme.slack.com/' }) },
      conversations: {
        info: async () => {
          throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } });
        },
      },
    });
    await router.route(msg({ ts: '5.2', thread_ts: '5.0' }), ctx(), true);
    const linked = hub.delivered[0].msg.linked!;
    expect(linked[0]).toMatchObject({ ok: false, here: true });
    expect(withLinked('look into it', linked)).toContain('The earlier messages of this thread are not shared with you');
  });

  it('a mention that starts a thread reads no history', async () => {
    await router.route(msg(), ctx(), true);
    expect(hub.delivered[0].msg.linked).toBeUndefined();
  });

  it('a forwarded message reaches the session as a block, not just the comment around it', async () => {
    const share = {
      is_share: true,
      is_msg_unfurl: true,
      from_url: 'https://acme.slack.com/archives/C9/p1793394313352819',
      author_name: 'Alec Watts',
      channel_name: 'autumn-kino',
      ts: '1793394313.352819',
      text: 'Checkout succeeded but the customer is still on Free',
    };
    const unfurl = { is_msg_unfurl: true, text: 'a link preview' };
    await router.route(msg({ text: `<@${BOT}> check please`, attachments: [share, unfurl] }), ctx(), true);
    const { msg: d } = hub.delivered[0];
    expect(d.text).toBe('check please');
    expect(d.linked).toHaveLength(1);
    const block = withLinked(d.text, d.linked);
    expect(block).toContain('forwarded in the message above');
    expect(block).toContain('Alec Watts: Checkout succeeded but the customer is still on Free');
    expect(block).toContain('in="#autumn-kino"');
  });

  it('the bot’s own messages and empty messages are ignored', async () => {
    await router.route(msg({ user: BOT }), ctx(), true);
    await router.route(msg({ text: `<@${BOT}>` }), ctx(), true);
    expect(hub.delivered).toHaveLength(0);
  });
});

describe('replies in a session', () => {
  let root: Msg;
  beforeEach(async () => {
    root = msg();
    await router.route(root, ctx(), true);
    hub.delivered.length = 0;
    client.calls.length = 0;
  });

  it('a reply from the owner is delivered, marked as not mentioning the bot', async () => {
    await router.route(msg({ thread_ts: root.ts, text: 'also check x' }), ctx(), false);
    expect(hub.delivered[0]).toMatchObject({ spec: { key: `C1:${root.ts}` }, msg: { text: 'also check x', mentioned: false } });
  });

  it('a mid-message mention keeps its place in the text and is marked inline', async () => {
    await router.route(msg({ thread_ts: root.ts, text: `<@U7> can you ask <@${BOT}> to check the logs?` }), ctx(), true);
    expect(hub.delivered[0].msg).toMatchObject({
      text: '@U7 can you ask @Computer (you) to check the logs?',
      mentioned: true,
      mentionedInline: true,
    });
    expect(client.of('agents.sessions.setStatus')).toHaveLength(0);
  });

  it('a leading mention is dropped and not marked inline', async () => {
    await router.route(msg({ thread_ts: root.ts, text: `<@${BOT}> and lint` }), ctx(), true);
    expect(hub.delivered[0].msg).toMatchObject({ text: 'and lint', mentioned: true });
    expect(hub.delivered[0].msg.mentionedInline).toBeUndefined();
  });

  it('a reply that @mentions someone else gets no thinking status', async () => {
    await router.route(msg({ thread_ts: root.ts, text: '<@U7> can you look?' }), ctx(), false);
    expect(hub.delivered).toHaveLength(1);
    expect(client.of('agents.sessions.setStatus')).toHaveLength(0);
  });

  it('a `!command` is delivered without feedback', async () => {
    await router.route(msg({ thread_ts: root.ts, text: '!status' }), ctx(), false);
    expect(hub.delivered[0].msg.text).toBe('!status');
    expect(client.calls).toHaveLength(0);
  });

  it('a non-member replying in someone’s thread is neither delivered nor told off', async () => {
    await router.route(msg({ thread_ts: root.ts, user: 'U9', text: 'nice' }), ctx(), false);
    expect(hub.delivered).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
  });

  it('the stop button interrupts the session', async () => {
    await router.stop({ channel: 'C1', thread_ts: root.ts }, 'ev-stop');
    expect(hub.stops).toEqual([`C1:${root.ts}`]);
  });
});

describe('de-duplication', () => {
  it('drops the second of Slack’s message/app_mention pair for one post', async () => {
    const m = msg();
    await router.route(m, ctx(), false);
    await router.route(m, ctx(), true);
    expect(hub.delivered).toHaveLength(1);
  });

  it('drops a retried event id', async () => {
    const c = ctx();
    await router.route(msg(), c, true);
    await router.route(msg(), c, true);
    expect(hub.delivered).toHaveLength(1);
  });
});

describe('+codex', () => {
  it('takes a leading +claude or +codex only, as a word', () => {
    expect(takeHarness('+Codex  fix it')).toEqual({ harness: 'codex', text: 'fix it' });
    expect(takeHarness('+claude')).toEqual({ harness: 'claude', text: '' });
    expect(takeHarness('+codexy fix')).toEqual({ text: '+codexy fix' });
    expect(takeHarness('fix +codex')).toEqual({ text: 'fix +codex' });
  });

  it('a first message starting with +codex starts a Codex session, without the prefix', async () => {
    models = { claude, codex: { mode: 'profile', profile: 'openai-key', vars: { token: 'fake' }, key: 'k2' } };
    const m = msg({ text: `<@${BOT}> +codex +smart port it` });
    await router.route(m, ctx(), true);
    expect(store.sessions.get(`C1:${m.ts}`)).toMatchObject({ harness: 'codex', title: 'port it' });
    expect(hub.delivered[0].msg.text).toBe('+smart port it');
  });

  it('without a route for Codex the person is told why and no session starts', async () => {
    await router.route(msg({ text: `<@${BOT}> +codex port it` }), ctx(), true);
    expect(client.of('chat.postEphemeral')[0].text).toBe('Codex needs OPENAI_API_KEY on this computer.');
    expect(store.sessions.size).toBe(0);
    expect(hub.delivered).toHaveLength(0);
  });

  it('a session started without a prefix names no harness, and a later +codex is only text', async () => {
    const m = msg();
    await router.route(m, ctx(), true);
    await router.route(msg({ thread_ts: m.ts, text: '+codex now' }), ctx(), false);
    expect(store.sessions.get(`C1:${m.ts}`)?.harness).toBeUndefined();
    expect(hub.delivered[1].msg.text).toBe('+codex now');
  });
});

describe('with no host connected', () => {
  it('tells the person the message is queued', async () => {
    hub = fakeHub(false);
    router = createRouter({ store: store as unknown as Store, hub: hub as unknown as Hub, mode: 'default', models: () => models });
    await router.route(msg(), ctx(), true);
    expect(client.of('chat.postEphemeral')[0].text).toMatch(/offline/);
    expect(client.of('agents.sessions.setStatus')).toHaveLength(0);
  });
});
