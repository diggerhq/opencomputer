// Who may set what on the self-host gateway: workspace (org) secrets and
// variables are admin-only, base URLs are never secrets, and a session-scope
// base-URL variable is set only by the session's owner.

import type { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import type { SlackPerson, SlackSessionSpec } from '../protocol.js';
import { createSecretsUi, type SubmittedView } from './secrets-ui.js';
import { fakeClient, fakeStore, owner } from './test-fakes.js';
import { createVariablesUi } from './variables-ui.js';
import { Vault } from './vault.js';
import type { Msg } from './routing.js';

const admin: SlackPerson = { slackUserId: 'UADMIN', dir: 'admin', gitName: 'Admin', gitEmail: 'admin@example.com', admin: true };
const member: SlackPerson = { slackUserId: 'UMEM', dir: 'member', gitName: 'Member', gitEmail: 'member@example.com' };
const spec: SlackSessionSpec = { key: 'C1:1.2', kind: 'thread', channel: 'C1', threadTs: '1.2', owner, title: 't', mode: 'default' };
const msg = (user: string): Msg => ({ channel: 'C1', ts: '1.3', thread_ts: '1.2', user }) as Msg;

function setup() {
  const store = fakeStore(admin, member);
  store.putSession(spec);
  const vault = new Vault(store.db, 'c'.repeat(64));
  const hub = { pushSecrets: () => 0 } as any;
  const secrets = createSecretsUi({ store, vault, hub, deliver: async () => {} });
  const variables = createVariablesUi({ store, vault, hub });
  const client = fakeClient();
  const said = () => String(client.of('chat.postEphemeral').at(-1)?.text ?? '');
  return { store, vault, secrets, variables, client: client as unknown as WebClient & typeof client, said };
}

const view = (name: string, scope: string): SubmittedView => ({
  private_metadata: '{}',
  state: { values: { name: { v: { value: name } }, value: { v: { value: 'fixture-value' } }, scope: { v: { selected_option: { value: scope } } } } },
});

describe('organization (workspace) secrets on self-host', () => {
  it('only an admin can set one', () => {
    const { secrets, vault } = setup();
    expect(secrets.submit(view('ORG_KEY', 'workspace'), member.slackUserId)).toEqual({ errors: { scope: 'Only admins can set workspace secrets.' } });
    expect(vault.list([{ scope: 'workspace', owner: '' }])).toEqual([]);
    expect('done' in secrets.submit(view('ORG_KEY', 'workspace'), admin.slackUserId)).toBe(true);
    expect(vault.list([{ scope: 'workspace', owner: '' }]).map((r) => r.name)).toEqual(['ORG_KEY']);
  });

  it('only an admin can remove one', async () => {
    const { secrets, vault, client, said } = setup();
    vault.set('workspace', '', 'ORG_KEY', 'v', false, admin.slackUserId);
    await secrets.command('!secret rm ORG_KEY workspace', msg(member.slackUserId), member, undefined, client);
    expect(said()).toMatch(/only an admin can remove it/);
    expect(vault.list([{ scope: 'workspace', owner: '' }])).toHaveLength(1);
    await secrets.command('!secret rm ORG_KEY workspace', msg(admin.slackUserId), admin, undefined, client);
    expect(said()).toMatch(/Removed/);
    expect(vault.list([{ scope: 'workspace', owner: '' }])).toHaveLength(0);
  });

  it('only an admin can set an organization variable', async () => {
    const { variables, vault, client, said } = setup();
    await variables.command('!var ORG_NAME example workspace', msg(member.slackUserId), member, undefined, client);
    expect(said()).toMatch(/Only admins/);
    expect(vault.variables([{ scope: 'workspace', owner: '' }])).toEqual([]);
  });
});

describe('base URLs', () => {
  it('are never secrets, at any scope', async () => {
    const { secrets, client, said } = setup();
    for (const scope of ['user', 'workspace'])
      expect(secrets.submit(view('OPENAI_BASE_URL', scope), admin.slackUserId)).toMatchObject({ errors: { name: expect.stringMatching(/base URL/) } });
    await secrets.command('!secret OPENAI_API_BASE', msg(owner.slackUserId), owner, spec, client);
    expect(said()).toMatch(/base URL/);
  });

  it("at session scope, only the session's owner sets one as a variable", async () => {
    const { variables, vault, client, said } = setup();
    const session = () => vault.variables([{ scope: 'session', owner: spec.key }]).map((r) => `${r.name}=${r.value}`);
    await variables.command('!var OPENAI_BASE_URL https://elsewhere.example', msg(member.slackUserId), member, spec, client);
    expect(said()).toMatch(/Only the session's owner/);
    await variables.command('!var OPENAI_BASE_URL https://elsewhere.example', msg(admin.slackUserId), admin, spec, client);
    expect(said()).toMatch(/Only the session's owner/);
    expect(session()).toEqual([]);
    await variables.command('!var OPENAI_BASE_URL https://proxy.example', msg(owner.slackUserId), owner, spec, client);
    expect(session()).toEqual(['OPENAI_BASE_URL=https://proxy.example']);
  });

  it('anyone may set one for their own sessions (user scope)', async () => {
    const { variables, vault, client } = setup();
    await variables.command('!var OPENAI_BASE_URL https://mine.example me', msg(member.slackUserId), member, spec, client);
    expect(vault.variables([{ scope: 'user', owner: member.slackUserId }]).map((r) => r.name)).toEqual(['OPENAI_BASE_URL']);
  });

  it('other variables at session scope are unchanged: anyone in the session sets them', async () => {
    const { variables, vault, client } = setup();
    await variables.command('!var REGION eu-west-1', msg(member.slackUserId), member, spec, client);
    expect(vault.variables([{ scope: 'session', owner: spec.key }]).map((r) => r.name)).toEqual(['REGION']);
  });
});
