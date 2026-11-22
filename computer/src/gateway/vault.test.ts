import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Person, SessionSpec } from '../protocol.js';
import { Vault, vaultSecretsFor } from './vault.js';

const KEY = 'a'.repeat(64);
const person = (p: Partial<Person>): Person => ({ dir: 'p', gitName: 'P', gitEmail: 'p@example.com', ...p });
const slack: SessionSpec = { key: 'C1:1.2', kind: 'thread', channel: 'C1', threadTs: '1.2', owner: person({ slackUserId: 'U1' }), title: 't', mode: 'default' };
const api = (owner: Person): SessionSpec => ({ key: 'cs_0000000000000001', kind: 'api', sessionId: 'cs_0000000000000001', owner, title: 't', mode: 'default' });

function vault() {
  const v = new Vault(new DatabaseSync(':memory:'), KEY);
  v.set('workspace', '', 'ORG_TOKEN', 'org-fixture', false, 'U9');
  v.set('workspace', '', 'SHARED', 'from-workspace', false, 'U9');
  v.set('user', 'U1', 'USER_KEY', 'user-fixture', false, 'U1');
  v.set('user', 'U1', 'SHARED', 'from-user', false, 'U1');
  v.set('session', 'cs_0000000000000001', 'SESSION_KEY', 'session-fixture', false, 'U1');
  v.set('session', 'C1:1.2', 'THREAD_KEY', 'thread-fixture', false, 'U1');
  return v;
}
const names = (s: { name: string; scope: string }[]) => s.map((x) => `${x.scope}:${x.name}`);

describe('vaultSecretsFor', () => {
  it('a Slack session: workspace, its owner and its own, narrowest winning (unchanged)', () => {
    expect(names(vaultSecretsFor(vault(), slack))).toEqual(['workspace:ORG_TOKEN', 'user:SHARED', 'session:THREAD_KEY', 'user:USER_KEY']);
  });

  it('an API session with no Slack identity: workspace and its own, no user scope', () => {
    const got = vaultSecretsFor(vault(), api(person({ userId: 'usr_1', dir: 'user-usr_1' })));
    expect(names(got)).toEqual(['workspace:ORG_TOKEN', 'session:SESSION_KEY', 'workspace:SHARED']);
    expect(got.find((x) => x.name === 'SHARED')?.value).toBe('from-workspace');
  });

  it("an API session whose owner has a Slack identity: that person's user scope too", () => {
    const got = vaultSecretsFor(vault(), api(person({ userId: 'usr_1', slackUserId: 'U1' })));
    expect(names(got)).toEqual(['workspace:ORG_TOKEN', 'session:SESSION_KEY', 'user:SHARED', 'user:USER_KEY']);
  });
});
