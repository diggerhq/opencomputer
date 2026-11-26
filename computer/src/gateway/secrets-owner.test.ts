// A session's own secrets and variables are its owner's alone (owner-first): only the session's
// Slack owner sets, replaces or removes them, through `!secret rm`, the secret form and `!var`.
// Drivers and admins keep their own scopes (`me`, and `workspace` for admins).

import { beforeEach, describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { SlackPerson, SlackSessionSpec } from '../protocol.js';
import { Store } from './db.js';
import type { Hub } from './hosts.js';
import type { Msg } from './routing.js';
import { createSecretsUi, ownerOnlyText } from './secrets-ui.js';
import { createVariablesUi } from './variables-ui.js';
import { Vault } from './vault.js';

const KEY = 'a'.repeat(64);
const person = (id: string, admin = false): SlackPerson => ({ slackUserId: id, dir: id.toLowerCase(), gitName: id, gitEmail: `${id}@example.com`, ...(admin ? { admin } : {}) });
const OWNER = person('U_OWNER');
const DRIVER = person('U_DRIVER');
const ADMIN = person('U_ADMIN', true);
const spec: SlackSessionSpec = { key: 'C1:1.1', kind: 'thread', channel: 'C1', threadTs: '1.1', owner: OWNER, title: 't', mode: 'default' };
const meta = JSON.stringify({ k: spec.key, ch: 'C1', th: '1.1' });

let vault: Vault;
let ephemerals: string[];
let modals: Array<{ blocks: Array<{ block_id?: string; element?: { options?: Array<{ value: string }> } }> }>;
let secrets: ReturnType<typeof createSecretsUi>;
let variables: ReturnType<typeof createVariablesUi>;

const client = {
  chat: {
    postEphemeral: async (a: { text: string }) => (ephemerals.push(a.text), { ok: true }),
    postMessage: async () => ({ ok: true }),
    update: async () => ({ ok: true }),
  },
  views: { open: async (a: { view: (typeof modals)[number] }) => (modals.push(a.view), { ok: true }) },
} as unknown as WebClient;
const m = (user: string): Msg => ({ channel: 'C1', ts: '2.1', thread_ts: '1.1', user, text: '' });
const form = (name: string, value: string, scope: string) => ({
  private_metadata: meta,
  state: { values: { name: { v: { value: name } }, value: { v: { value } }, scope: { v: { selected_option: { value: scope } } }, opts: { v: { selected_options: [] } } } },
});
const rows = (scope: 'session' | 'user' | 'workspace', owner: string) => vault.list([{ scope, owner }]).map((r) => r.name);

beforeEach(() => {
  const store = new Store(':memory:');
  for (const p of [OWNER, DRIVER, ADMIN]) store.putPerson(p);
  store.putSession(spec);
  vault = new Vault(store.db, KEY);
  ephemerals = [];
  modals = [];
  const hub = { pushSecrets: () => 0 };
  secrets = createSecretsUi({ store, vault, hub, deliver: async () => {} });
  variables = createVariablesUi({ store, vault, hub: hub as unknown as Hub });
});

describe("session secrets and variables are the owner's", () => {
  it('the form: the owner sets the session scope; a driver or admin is refused and nothing is stored', () => {
    expect('done' in secrets.submit(form('TOKEN', 'v1', 'session'), OWNER.slackUserId)).toBe(true);
    for (const who of [DRIVER, ADMIN]) expect(secrets.submit(form('TOKEN', 'v2', 'session'), who.slackUserId)).toEqual({ errors: { scope: ownerOnlyText(spec) } });
    expect(secrets.submit(form('NEW', 'v3', 'session'), DRIVER.slackUserId)).toEqual({ errors: { scope: ownerOnlyText(spec) } });
    expect(rows('session', spec.key)).toEqual(['TOKEN']);
    expect(vault.forSession(spec.key, OWNER.slackUserId).find((s) => s.name === 'TOKEN')?.value).toBe('v1');
    // Their own scope stays theirs.
    expect('done' in secrets.submit(form('MINE', 'v4', 'user'), DRIVER.slackUserId)).toBe(true);
  });

  it('the form offers the session scope only to the owner', async () => {
    const scopes = async (who: SlackPerson) => {
      await secrets.open('s:' + Buffer.from(JSON.stringify({ k: spec.key, n: 'X' })).toString('base64url'), { user: { id: who.slackUserId }, trigger_id: 't', channel: { id: 'C1' }, container: {} }, client);
      return modals.at(-1)?.blocks.find((b) => b.block_id === 'scope')?.element?.options?.map((o) => o.value);
    };
    expect(await scopes(OWNER)).toEqual(['session', 'user']);
    expect(await scopes(DRIVER)).toEqual(['user']);
    expect(await scopes(ADMIN)).toEqual(['user', 'workspace']);
  });

  it('!secret rm: only the owner removes a session secret, whoever set it', async () => {
    vault.set('session', spec.key, 'BY_DRIVER', 'x1', false, DRIVER.slackUserId);
    for (const who of [DRIVER, ADMIN]) {
      await secrets.command('!secret rm BY_DRIVER session', m(who.slackUserId), who, spec, client);
      expect(ephemerals.at(-1)).toBe(ownerOnlyText(spec));
    }
    expect(rows('session', spec.key)).toEqual(['BY_DRIVER']);
    await secrets.command('!secret rm BY_DRIVER', m(OWNER.slackUserId), OWNER, spec, client);
    expect(ephemerals.at(-1)).toMatch(/^Removed `BY_DRIVER`/);
    expect(rows('session', spec.key)).toEqual([]);
  });

  it('!var set and rm: only the owner writes the session scope; others keep `me`', async () => {
    const say = async (who: SlackPerson, text: string) => {
      await variables.command(text, m(who.slackUserId), who, spec, client);
      return ephemerals.at(-1);
    };
    expect(await say(DRIVER, '!var REGION eu-west-1')).toBe(ownerOnlyText(spec));
    expect(await say(ADMIN, '!var REGION eu-west-1 session')).toBe(ownerOnlyText(spec));
    expect(rows('session', spec.key)).toEqual([]);
    expect(await say(OWNER, '!var REGION eu-west-1')).toMatch(/^Set `REGION`/);
    expect(await say(DRIVER, '!var rm REGION')).toBe(ownerOnlyText(spec));
    expect(rows('session', spec.key)).toEqual(['REGION']);
    expect(await say(DRIVER, '!var REGION us-east-1 me')).toMatch(/^Set `REGION`/);
    expect(await say(OWNER, '!var rm REGION')).toMatch(/^Removed `REGION`/);
    expect(rows('session', spec.key)).toEqual([]);
  });
});
