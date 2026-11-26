// Test-only fakes for the router's tests (routing.test.ts, access-flow.test.ts,
// access-ui.test.ts): the gateway's real Store in memory, a hub that records
// what it delivers, and a Slack client that records every call. Never
// imported by the gateway itself.

import type { Delivery, SlackPerson, SlackSessionSpec } from '../protocol.js';
import { Store } from './db.js';

export const owner: SlackPerson = { slackUserId: 'U1', dir: 'owner', gitName: 'Owner', gitEmail: 'owner@example.com' };
export const BOT = 'UBOT';

/** The gateway's own store, in memory, with the owner enabled; `sessions` reads specs back. */
export function fakeStore(...people: SlackPerson[]) {
  const store = new Store(':memory:');
  for (const p of [owner, ...people]) store.putPerson(p);
  const sessions = {
    get: (key: string) => store.session(key)?.spec,
    get size() {
      return (store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    },
  };
  return Object.assign(store, { sessions });
}

export function fakeHub(online = true) {
  const delivered: { spec: SlackSessionSpec; msg: Delivery }[] = [];
  const stops: string[] = [];
  const actions: { key: string; promptId: string; value: string; userId: string; role?: string }[] = [];
  return {
    delivered,
    stops,
    actions,
    /** What the next deliver answers (online). */
    reply: { ok: true } as { ok: boolean; error?: string },
    get connected() {
      return online ? ['host-1'] : [];
    },
    async deliver(spec: SlackSessionSpec, msg: Delivery) {
      if (!online) return 'queued';
      if (this.reply.ok) delivered.push({ spec, msg });
      return this.reply;
    },
    actionReply: { ok: true } as { ok: boolean; error?: string },
    async action(key: string, promptId: string, value: string, userId: string, role?: string) {
      actions.push({ key, promptId, value, userId, ...(role ? { role } : {}) });
      return this.actionReply;
    },
    stop: async (key: string) => (stops.push(key), { ok: true }),
  };
}

export function fakeClient() {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const rec =
    (method: string, result: Record<string, unknown> = { ok: true }) =>
    async (args: Record<string, unknown>) => (calls.push({ method, args }), result);
  return {
    calls,
    of: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
    chat: {
      postMessage: rec('chat.postMessage', { ok: true, ts: '2.0' }),
      postEphemeral: rec('chat.postEphemeral'),
      update: rec('chat.update'),
      getPermalink: rec('chat.getPermalink', { ok: true, permalink: 'https://example.slack.com/archives/C1/p1' }),
    },
    conversations: { open: rec('conversations.open', { ok: true, channel: { id: 'D1' } }) },
    users: { list: rec('users.list', { ok: true, members: [{ id: 'UBEA0002', profile: { display_name: 'Bea' } }] }) },
    reactions: { add: rec('reactions.add'), remove: rec('reactions.remove') },
    views: { open: rec('views.open') },
    agents: {
      sessions: { setStatus: rec('agents.sessions.setStatus'), rename: rec('agents.sessions.rename') },
      conversations: { create: rec('agents.conversations.create', { ok: true, channel_id: 'CCODE' }) },
    },
  };
}
