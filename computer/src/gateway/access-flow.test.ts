// Session roles through the router (work 112, "Tests"): one test per rule of
// "Messages", "Request to drive", "Prompts", "Stop" and "One transition", on
// routing.test.ts's fakes. U1 owns every session; UBEA0002 and UCY00003 are members, UA a
// member admin, U9 not in the people table.

import { beforeEach, describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { encodeActionId, NOT_ASKED } from '../protocol.js';
import { encodeAccessId } from '../access-views.js';
import type { Store } from './db.js';
import type { Hub } from './hosts.js';
import { type Ctx, createRouter, type Msg } from './routing.js';
import type { SecretsUi } from './secrets-ui.js';
import type { VariablesUi } from './variables-ui.js';
import { BOT, fakeClient, fakeHub, fakeStore } from './test-fakes.js';

const person = (id: string, admin = false) => ({ slackUserId: id, dir: id.toLowerCase(), gitName: id, gitEmail: `${id}@example.com`, ...(admin ? { admin } : {}) });

let store: ReturnType<typeof fakeStore>;
let hub: ReturnType<typeof fakeHub>;
let client: ReturnType<typeof fakeClient>;
let router: ReturnType<typeof createRouter>;
let n = 0;
let root: Msg;
let key: string;
const deps = () => ({ store: store as unknown as Store, hub: hub as unknown as Hub, mode: 'default' as const, models: () => ({ claude: { mode: 'profile' as const, profile: 'p', vars: {}, key: 'k' } }) });

const msg = (over: Partial<Msg> = {}): Msg => ({ channel: 'C1', ts: `1.${++n}`, user: 'U1', text: `<@${BOT}> do it`, ...over });
const ctx = (): Ctx => ({ client: client as unknown as WebClient, botUserId: BOT, teamId: 'T1', eventId: `ev-${++n}` });
const wc = () => client as unknown as WebClient;
/** A reply in the session's thread. */
const say = (user: string, text: string, mentioned = false) => router.route(msg({ thread_ts: root.ts, user, text }), ctx(), mentioned);
const ephemerals = (user: string) => client.of('chat.postEphemeral').filter((a) => a.user === user).map((a) => a.text);
const posts = () => client.of('chat.postMessage').map((a) => a.text);
const lock = (method: 'reactions.add' | 'reactions.remove') => client.of(method).filter((a) => a.name === 'lock');

beforeEach(async () => {
  store = fakeStore(person('UBEA0002'), person('UCY00003'), person('UA', true));
  hub = fakeHub();
  client = fakeClient();
  router = createRouter(deps());
  root = msg();
  key = `C1:${root.ts}`;
  await router.route(root, ctx(), true);
  hub.delivered.length = 0;
  client.calls.length = 0;
});

describe('messages', () => {
  beforeEach(() => store.access.writeDrivers(key, []));

  it('a participant’s message is held, not delivered and not acknowledged', async () => {
    await say('UBEA0002', 'the bug is in login.ts');
    expect(hub.delivered).toHaveLength(0);
    expect(store.access.held(key)).toMatchObject([{ userId: 'UBEA0002', text: 'the bug is in login.ts' }]);
    expect(client.calls).toHaveLength(0);
  });

  it('an outsider’s message is dropped and never held; a mention gets NOT_ENABLED', async () => {
    await say('U9', 'hello');
    await say('U9', `<@${BOT}> do something`, true);
    expect(hub.delivered).toHaveLength(0);
    expect(store.access.held(key)).toHaveLength(0);
    expect(ephemerals('U9')).toEqual([expect.stringMatching(/not enabled/)]);
  });

  it('held context rides the next driver message and is deleted after', async () => {
    await say('UBEA0002', 'the bug is in login.ts');
    await say('U1', 'fix it');
    const linked = hub.delivered[0].msg.linked!;
    expect(linked.at(-1)).toMatchObject({ context: true, ok: true, messages: [{ name: 'Bea', text: 'the bug is in login.ts' }] });
    expect(hub.delivered[0].msg.role).toBe('owner');
    expect(store.access.held(key)).toHaveLength(0);
    await say('U1', 'and the tests');
    expect(hub.delivered[1].msg.linked).toBeUndefined();
  });

  it('a failed delivery keeps the held context', async () => {
    await say('UBEA0002', 'the bug is in login.ts');
    hub.reply = { ok: false, error: 'boom' };
    await say('U1', 'fix it');
    expect(store.access.held(key)).toHaveLength(1);
  });

  it('a settings command from a driver answers S7 and is not delivered; a command from a participant answers S8', async () => {
    store.access.writeDrivers(key, ['UBEA0002']);
    await say('UBEA0002', '!mode plan');
    await say('UCY00003', '!diff');
    expect(hub.delivered).toHaveLength(0);
    expect(ephemerals('UBEA0002')).toEqual(['Only <@U1> can use `!mode` in this session.']);
    expect(ephemerals('UCY00003')).toEqual(['Only people who can drive this session can use `!diff`.']);
    expect(store.access.held(key)).toHaveLength(0);
  });

  it('a driver’s message is delivered with role driver; `!stop` from a participant with role participant', async () => {
    store.access.writeDrivers(key, ['UBEA0002']);
    await say('UBEA0002', 'go on');
    await say('UCY00003', '!stop');
    expect(hub.delivered.map((d) => [d.msg.userId, d.msg.role])).toEqual([
      ['UBEA0002', 'driver'],
      ['UCY00003', 'participant'],
    ]);
  });
});

describe('request to drive', () => {
  beforeEach(() => store.access.writeDrivers(key, []));
  const allow = (clicker: string, verb: 'allow' | 'deny' = 'allow') =>
    router.access.click(encodeAccessId(key, verb, 'UBEA0002'), { user: { id: clicker }, channel: { id: 'C1' } }, wc());

  it('a first mention posts S1 with buttons once and answers S2; a second answers S2b and posts nothing', async () => {
    await say('UBEA0002', `<@${BOT}> fix the login`, true);
    await say('UBEA0002', `<@${BOT}> please`, true);
    const [request] = client.of('chat.postMessage');
    expect(client.of('chat.postMessage')).toHaveLength(1);
    expect(request).toMatchObject({ channel: 'C1', thread_ts: root.ts, text: '<@U1>, <@UBEA0002> wants to drive this session.' });
    expect(JSON.stringify(request.blocks)).toContain(encodeAccessId(key, 'allow', 'UBEA0002'));
    expect(ephemerals('UBEA0002')).toEqual([
      '<@U1> decides who can drive this session and has been asked. Your message runs if they allow it.',
      '<@U1> decides who can drive this session.',
    ]);
    expect(store.access.held(key)).toHaveLength(2);
  });

  it('a mention mid-message is held without a request', async () => {
    await router.route(msg({ thread_ts: root.ts, user: 'UBEA0002', text: `ask <@${BOT}> later` }), ctx(), true);
    expect(client.of('chat.postMessage')).toHaveLength(0);
    expect(store.access.held(key)).toHaveLength(1);
  });

  it('Allow by someone who cannot grant (the requester too) answers S5 and changes nothing', async () => {
    await say('UBEA0002', `<@${BOT}> fix the login`, true);
    await allow('UCY00003');
    await allow('UBEA0002');
    expect(ephemerals('UCY00003')).toEqual(['Only <@U1> or an admin can answer this.']);
    expect(store.access.drivers(key)).toEqual([]);
    expect(store.access.request(key, 'UBEA0002')?.state).toBe('open');
    expect(client.of('chat.update')).toHaveLength(0);
  });

  it('Allow by the owner adds the driver, edits the request and delivers the held message once', async () => {
    await say('UBEA0002', `<@${BOT}> fix the login`, true);
    await allow('U1');
    expect(store.access.drivers(key)).toEqual(['UBEA0002']);
    expect(client.of('chat.update')).toEqual([
      { channel: 'C1', ts: '2.0', text: '<@U1> let <@UBEA0002> drive this session. It keeps running as <@U1>.', blocks: [] },
    ]);
    expect(hub.delivered).toHaveLength(1);
    expect(hub.delivered[0].msg).toMatchObject({ userId: 'UBEA0002', text: 'fix the login', role: 'driver' });
    expect(hub.delivered[0].msg.linked).toBeUndefined();
    expect(posts()).toHaveLength(1); // the request; no separate S3
    await allow('U1');
    expect(hub.delivered).toHaveLength(1);
  });

  it('Not now declines: the request reads S4, the message stays context, a later mention gets S2b', async () => {
    await say('UBEA0002', `<@${BOT}> fix the login`, true);
    await allow('U1', 'deny');
    expect(client.of('chat.update')[0]).toMatchObject({ text: '<@UBEA0002> asked to drive · not now', blocks: [{ type: 'context' }] });
    expect(store.access.held(key)).toHaveLength(1);
    await say('UBEA0002', `<@${BOT}> again`, true);
    expect(posts()).toHaveLength(1);
    expect(ephemerals('UBEA0002').at(-1)).toBe('<@U1> decides who can drive this session.');
  });
});

describe('prompts', () => {
  const click = (user: string) => router.action(encodeActionId(key, 'p1', 'allow'), user, wc(), 'C1');

  it('a participant’s click answers S6 and reaches no host', async () => {
    store.access.writeDrivers(key, []);
    await click('UBEA0002');
    expect(hub.actions).toHaveLength(0);
    expect(ephemerals('UBEA0002')).toEqual(['This is waiting on someone else. Only they or <@U1> can answer it.']);
  });

  it('a click carries the clicker’s role; the runner’s not-asked answers S6', async () => {
    await click('U1');
    await click('UBEA0002');
    expect(hub.actions.map((a) => [a.userId, a.role])).toEqual([
      ['U1', 'owner'],
      ['UBEA0002', 'driver'],
    ]);
    hub.actionReply = { ok: false, error: NOT_ASKED };
    await click('UBEA0002');
    expect(ephemerals('UBEA0002')).toHaveLength(1);
  });
});

describe('stop', () => {
  beforeEach(() => store.access.writeDrivers(key, []));

  it('a stop by an outsider is ignored', async () => {
    await router.stop({ channel: 'C1', thread_ts: root.ts, user: 'U9' }, 'ev-s1', wc());
    expect(hub.stops).toHaveLength(0);
  });

  it('a stop by a participant stops the turn and posts S9; the owner’s posts nothing', async () => {
    await router.stop({ channel: 'C1', thread_ts: root.ts, user: 'UBEA0002' }, 'ev-s2', wc());
    await router.stop({ channel: 'C1', thread_ts: root.ts, user: 'U1' }, 'ev-s3', wc());
    expect(hub.stops).toEqual([key, key]);
    expect(posts()).toEqual([':octagonal_sign: <@UBEA0002> stopped the turn.']);
  });
});

describe('setDrivers', () => {
  const access = (user: string, text: string) => say(user, `!access ${text}`);

  it('the same value does nothing', async () => {
    await access('U1', 'open');
    expect(posts()).toHaveLength(0);
    expect(client.of('reactions.add')).toHaveLength(0);
    expect(ephemerals('U1')).toEqual(['Runs as <@U1>. Everyone in this thread can drive.']);
  });

  it('restricting adds the lock and posts nothing; opening removes it and posts S3b', async () => {
    await access('U1', 'owner');
    expect(lock('reactions.add')).toEqual([{ channel: 'C1', timestamp: root.ts, name: 'lock' }]);
    expect(posts()).toHaveLength(0);
    await access('UA', 'open');
    expect(lock('reactions.remove')).toEqual([{ channel: 'C1', timestamp: root.ts, name: 'lock' }]);
    expect(posts()).toEqual(['<@UA> (admin) opened this session to everyone in this thread. It keeps running as <@U1>.']);
    expect(hub.delivered).toHaveLength(0);
  });

  it('adding people posts S3 once naming them; removing posts nothing', async () => {
    await access('U1', 'owner');
    await access('U1', `add <@UBEA0002> <@UCY00003>`);
    await access('U1', `remove <@UBEA0002>`);
    expect(posts()).toEqual(['<@U1> let <@UBEA0002> and <@UCY00003> drive this session. It keeps running as <@U1>.']);
    expect(store.access.drivers(key)).toEqual(['UCY00003']);
    expect(lock('reactions.add')).toHaveLength(1);
  });

  it('an open request whose requester now drives is answered and delivered, not announced again', async () => {
    await access('U1', 'owner');
    await say('UBEA0002', `<@${BOT}> fix the login`, true);
    await access('U1', `<@UBEA0002> <@UCY00003>`);
    expect(client.of('chat.update')[0].text).toBe('<@U1> let <@UBEA0002> drive this session. It keeps running as <@U1>.');
    expect(posts().at(-1)).toBe('<@U1> let <@UCY00003> drive this session. It keeps running as <@U1>.');
    expect(hub.delivered.map((d) => d.msg.text)).toEqual(['fix the login']);
    expect(store.access.request(key, 'UBEA0002')?.state).toBe('closed');
  });
});

describe('new sessions', () => {
  it('spawn copies the parent’s drivers, with the marker', async () => {
    store.access.writeDrivers(key, ['UBEA0002']);
    const r = await router.spawn(key, { task: 'port it', brief: 'b.md' }, wc());
    expect(store.access.drivers(r.key)).toEqual(['UBEA0002']);
    expect(lock('reactions.add')).toEqual([{ channel: 'C1', timestamp: '2.0', name: 'lock' }]);
  });

  it('under accessDefault owner a new session starts with only its owner, with the marker', async () => {
    store.access.setAccessDefault('owner');
    const m = msg();
    await router.route(m, ctx(), true);
    expect(store.access.drivers(`C1:${m.ts}`)).toEqual([]);
    expect(lock('reactions.add')).toEqual([{ channel: 'C1', timestamp: m.ts, name: 'lock' }]);
  });
});

describe('one gate for everything that writes to a session', () => {
  it('a participant’s `!secret` and `!var` answer S8 and reach neither; a driver’s are handled, never delivered', async () => {
    const seen: string[] = [];
    const command = async (text: string) => (seen.push(text), true);
    router = createRouter({ ...deps(), secrets: { command } as unknown as SecretsUi, variables: { command } as unknown as VariablesUi });
    store.access.writeDrivers(key, ['UBEA0002']);
    await say('UCY00003', '!secret API_KEY');
    await say('UCY00003', '!var REGION=eu');
    await say('UBEA0002', '!secret API_KEY');
    expect(ephemerals('UCY00003')).toEqual([
      'Only people who can drive this session can use `!secret`.',
      'Only people who can drive this session can use `!var`.',
    ]);
    expect(seen).toEqual(['!secret API_KEY']);
    expect(hub.delivered).toHaveLength(0);
    expect(store.access.held(key)).toHaveLength(0);
  });

  it('an owner no longer in the people table can do nothing in their session', async () => {
    store.db.prepare('DELETE FROM people WHERE slack_user_id = ?').run('U1');
    await say('U1', 'go on');
    await say('U1', `<@${BOT}> go on`, true);
    await router.action(encodeActionId(key, 'p1', 'allow'), 'U1', wc(), 'C1');
    await router.stop({ channel: 'C1', thread_ts: root.ts, user: 'U1' }, 'ev-gone', wc());
    await router.access.click(encodeAccessId(key, 'open'), { user: { id: 'U1' }, trigger_id: 't', container: { channel_id: 'C1', thread_ts: root.ts } }, wc());
    expect([hub.delivered, hub.actions, hub.stops, client.of('views.open')].map((c) => c.length)).toEqual([0, 0, 0, 0]);
    expect(ephemerals('U1')).toEqual([expect.stringMatching(/not enabled/), expect.stringMatching(/not enabled/)]);
  });
});

describe('setDrivers refuses', () => {
  const access = (user: string, text: string) => say(user, `!access ${text}`);

  it('more than MAX_DRIVERS people, before asking who they are', async () => {
    await access('U1', Array.from({ length: 51 }, (_, i) => `<@UX${String(i).padStart(6, '0')}>`).join(' '));
    expect(ephemerals('U1')).toEqual(['At most 50 people can be named.']);
    expect(store.access.drivers(key)).toBe('*');
  });

  it('add or remove on an open session: the usage, and nothing changes', async () => {
    await access('U1', 'add <@UBEA0002>');
    expect(ephemerals('U1')[0]).toMatch(/^`!access`/);
    expect(store.access.drivers(key)).toBe('*');
    expect(posts()).toHaveLength(0);
  });

  it('Allow for a requester who is no longer a member: told to the clicker, the request stays open', async () => {
    store.access.writeDrivers(key, []);
    await say('UBEA0002', `<@${BOT}> fix the login`, true);
    store.db.prepare('DELETE FROM people WHERE slack_user_id = ?').run('UBEA0002');
    await router.access.click(encodeAccessId(key, 'allow', 'UBEA0002'), { user: { id: 'U1' }, channel: { id: 'C1' } }, wc());
    expect(ephemerals('U1')).toEqual(['<@UBEA0002> can’t be added: only full members of this workspace can drive.']);
    expect(store.access.drivers(key)).toEqual([]);
    expect(store.access.request(key, 'UBEA0002')?.state).toBe('open');
    expect(hub.delivered).toHaveLength(0);
  });
});

describe('the request row is the guard', () => {
  beforeEach(() => store.access.writeDrivers(key, []));

  it('two mentions at once post one request', async () => {
    await Promise.all([say('UBEA0002', `<@${BOT}> fix it`, true), say('UBEA0002', `<@${BOT}> please`, true)]);
    expect(posts()).toHaveLength(1);
    expect(store.access.held(key)).toHaveLength(2);
  });

  it('a request whose post failed is dropped, so the next mention asks again', async () => {
    const postMessage = client.chat.postMessage;
    client.chat.postMessage = async () => {
      throw new Error('slack down');
    };
    await say('UBEA0002', `<@${BOT}> fix it`, true);
    expect(store.access.request(key, 'UBEA0002')).toBeUndefined();
    expect(ephemerals('UBEA0002')).toHaveLength(0);
    client.chat.postMessage = postMessage;
    await say('UBEA0002', `<@${BOT}> please`, true);
    expect(posts()).toHaveLength(1);
    expect(store.access.request(key, 'UBEA0002')?.state).toBe('open');
  });
});

describe('context order', () => {
  it('a delivery that carried the newest 40 held messages deletes the older ones too', async () => {
    store.access.writeDrivers(key, []);
    for (let i = 0; i < 45; i++) await say('UBEA0002', `note ${i}`);
    expect(store.access.held(key)).toHaveLength(40);
    await say('U1', 'go');
    const context = hub.delivered[0].msg.linked!.at(-1)!;
    expect(context.ok && context.messages).toHaveLength(40);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_context').get()).toEqual({ n: 0 });
  });
});
