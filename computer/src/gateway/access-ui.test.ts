// `!access`, the Access button and the access modal's submission (work 112,
// "Controls"), through the router on routing.test.ts's fakes. U1 owns the
// session; UBEA0002 is a member, UADMIN01 a member admin, UOUT0009 not in the
// people table.

import { beforeEach, describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { encodeAccessId } from '../access-views.js';
import type { Store } from './db.js';
import type { Hub } from './hosts.js';
import { type Ctx, createRouter, type Msg } from './routing.js';
import { BOT, fakeClient, fakeHub, fakeStore } from './test-fakes.js';

const B = 'UBEA0002';
const ADMIN = 'UADMIN01';
const OUT = 'UOUT0009';
const person = (id: string, admin = false) => ({ slackUserId: id, dir: id.toLowerCase(), gitName: id, gitEmail: `${id}@example.com`, ...(admin ? { admin } : {}) });

let store: ReturnType<typeof fakeStore>;
let hub: ReturnType<typeof fakeHub>;
let client: ReturnType<typeof fakeClient>;
let router: ReturnType<typeof createRouter>;
let n = 0;
let root: Msg;
let key: string;

const msg = (over: Partial<Msg> = {}): Msg => ({ channel: 'C1', ts: `1.${++n}`, user: 'U1', text: `<@${BOT}> do it`, ...over });
const ctx = (): Ctx => ({ client: client as unknown as WebClient, botUserId: BOT, teamId: 'T1', eventId: `ev-${++n}` });
const wc = () => client as unknown as WebClient;
const access = (user: string, text: string) => router.route(msg({ user, thread_ts: root.ts, text: `!access${text ? ` ${text}` : ''}` }), ctx(), false);
const answers = (user: string) => client.of('chat.postEphemeral').filter((a) => a.user === user);
const submission = (who: string, people: string[] = [], k = key) => ({
  private_metadata: JSON.stringify({ key: k }),
  state: { values: { who: { v: { selected_option: { value: who } } }, people: { v: { selected_users: people } } } },
});

beforeEach(async () => {
  store = fakeStore(person(B), person(ADMIN, true));
  hub = fakeHub();
  client = fakeClient();
  router = createRouter({ store: store as unknown as Store, hub: hub as unknown as Hub, mode: 'default', models: () => ({ claude: { mode: 'profile', profile: 'p', vars: {}, key: 'k' } }) });
  root = msg();
  key = `C1:${root.ts}`;
  await router.route(root, ctx(), true);
  hub.delivered.length = 0;
  client.calls.length = 0;
});

describe('!access', () => {
  it('shows the state line in the thread, with Change… for someone who can grant; never delivered', async () => {
    store.access.writeDrivers(key, [B]);
    await access('U1', '');
    await access(B, '');
    const [owner] = answers('U1');
    expect(owner).toMatchObject({ channel: 'C1', thread_ts: root.ts, text: `Runs as <@U1>. They and <@${B}> can drive.` });
    expect(JSON.stringify(owner.blocks)).toContain(encodeAccessId(key, 'open'));
    expect(JSON.stringify(answers(B)[0].blocks)).not.toContain('Change');
    expect(hub.delivered).toHaveLength(0);
  });

  it('an outsider gets no answer; an unknown form gets the usage', async () => {
    await access(OUT, '');
    await access('U1', 'sideways');
    expect(answers(OUT)).toHaveLength(0);
    expect(answers('U1')[0].text).toMatch(/^`!access`/);
  });

  it('a change by someone who cannot grant answers S11 and changes nothing', async () => {
    store.access.writeDrivers(key, [B]);
    await access(B, 'open');
    expect(answers(B).map((a) => a.text)).toEqual(['Only <@U1> or an admin can change who drives this session.']);
    expect(store.access.drivers(key)).toEqual([B]);
  });

  it('naming someone who is not a member changes nothing', async () => {
    await access('U1', `<@${B}> <@${OUT}>`);
    expect(answers('U1').map((a) => a.text)).toEqual([`<@${OUT}> can’t be added: only full members of this workspace can drive.`]);
    expect(store.access.drivers(key)).toBe('*');
  });

  it('a change by the owner is made, then answered with the new state', async () => {
    await access('U1', `<@${B}>`);
    expect(store.access.drivers(key)).toEqual([B]);
    expect(answers('U1').map((a) => a.text)).toEqual([`Runs as <@U1>. They and <@${B}> can drive.`]);
  });

  it('outside a session (mentioned, as any message there): S12; the default by an admin works anywhere, by anyone else S15', async () => {
    const top = (user: string, text: string) => router.route(msg({ user, text: `<@${BOT}> !access ${text}` }), ctx(), true);
    await top('U1', 'owner');
    await top('U1', 'default owner');
    await top(ADMIN, 'default owner');
    expect(answers('U1').map((a) => a.text)).toEqual(['There is no session in this thread.', 'Only an admin can change the default.']);
    expect(answers(ADMIN).map((a) => a.text)).toEqual(['New sessions now start with only their owner driving.']);
    expect(store.access.accessDefault()).toBe('owner');
  });
});

describe('the Access button', () => {
  const open = (user: string, k = key) =>
    router.access.click(encodeAccessId(k, 'open'), { user: { id: user }, trigger_id: 'trig', container: { channel_id: 'C1', thread_ts: root.ts } }, wc());

  it('opens the modal for the owner, and a read-only one for a participant; nothing for an outsider', async () => {
    store.access.writeDrivers(key, []);
    await open('U1');
    await open(B);
    await open(OUT);
    const [mine, theirs] = client.of('views.open');
    expect(client.of('views.open')).toHaveLength(2);
    expect(mine).toMatchObject({ trigger_id: 'trig', view: { callback_id: 'access', submit: { text: 'Save' } } });
    expect((theirs.view as { submit?: unknown }).submit).toBeUndefined();
  });

  it('answers S12 for a session that does not exist', async () => {
    await open('U1', 'C1:9.9');
    expect(answers('U1')).toMatchObject([{ channel: 'C1', thread_ts: root.ts, text: 'There is no session in this thread.' }]);
    expect(client.of('views.open')).toHaveLength(0);
  });
});

describe('the modal’s submission', () => {
  it('refuses someone who cannot grant on `who`', async () => {
    expect(await router.access.submit(submission('open'), B, wc())).toEqual({ errors: { who: 'Only <@U1> or an admin can change who drives this session.' } });
  });

  it('names a picked non-member on `people`', async () => {
    expect(await router.access.submit(submission('people', [OUT]), 'U1', wc())).toEqual({
      errors: { people: `${OUT} can’t be added: only full members of this workspace can drive.` },
    });
  });

  it('a valid submission changes drivers at once; done() finishes the announcing', async () => {
    const r = await router.access.submit(submission('people', [B, 'U1']), ADMIN, wc());
    expect(store.access.drivers(key)).toEqual([B]);
    await (r as { done(): Promise<void> }).done();
    expect(store.access.drivers(key)).toEqual([B]);
    expect(client.of('chat.postMessage')).toHaveLength(0); // '*' to a list: nobody gains
  });

  it('ignores a submission for an unknown session', async () => {
    expect(await router.access.submit(submission('open', [], 'C1:9.9'), 'U1', wc())).toBeUndefined();
  });
});
