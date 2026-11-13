import { describe, expect, it } from 'vitest';
import net from 'node:net';
import type { HostCredentials, HostToRunner, Person, RunnerModel } from '../protocol.js';
import { gatewayUpdates } from './gateway-updates.js';

/** A runner's end as the host sees it: a socket whose writes are kept as parsed messages. */
function runner(key: string, owner?: Person) {
  const sent: HostToRunner[] = [];
  const sock = new net.Socket();
  Object.assign(sock, { writable: true, write: (d: string) => (sent.push(JSON.parse(d)), true) });
  return { key, sock, owner, sent };
}
const person = (slackUserId: string, gitName = 'A', gitEmail = 'a@x'): Person => ({ slackUserId, dir: slackUserId, gitName, gitEmail });
const creds = (slackBotToken: string): HostCredentials => ({ slackBotToken, slackBotUserId: 'B' });
const model = (profile: string): RunnerModel => ({ profile, key: 'k', harness: {}, endpoint: { unixSocket: '/s' }, placeholder: 'ph' });
/** model-access.ts's shape: Slack's fields, plus the session's model (a spare's is key ''). */
const shaped = (key: string, c: HostCredentials): HostCredentials => ({ ...c, model: model(key || 'spare') });

function setup() {
  const a = runner('a', person('U1'));
  const spare = runner('');
  const prepared: Person[] = [];
  let filled = 0;
  const org = gatewayUpdates({
    runners: () => [a],
    spares: () => [spare],
    forRunner: shaped,
    fillPool: () => filled++,
    prepare: (p) => prepared.push(p),
  });
  return { a, spare, org, prepared, fill: () => filled };
}

describe('gateway updates (welcome, credentials, people)', () => {
  it('welcome: credentials to runners and spares shaped per session, then the pool fills', () => {
    const t = setup();
    t.org.welcome({ t: 'welcome', protocol: 1, credentials: creds('xoxb'), people: [person('U1')] });
    expect(t.org.creds?.slackBotToken).toBe('xoxb');
    expect(t.org.people.map((p) => p.slackUserId)).toEqual(['U1']);
    expect(t.a.sent).toEqual([{ t: 'credentials', credentials: { slackBotToken: 'xoxb', slackBotUserId: 'B', model: model('a') } }]);
    expect(t.spare.sent).toEqual([{ t: 'credentials', credentials: shaped('', creds('xoxb')) }]);
    expect(t.fill()).toBe(1);
  });

  it('a welcome without Slack values (multi-workspace gateway) leaves live runners theirs; spares still take it', () => {
    const t = setup();
    t.org.welcome({ t: 'welcome', protocol: 1, credentials: creds(''), people: [] });
    expect(t.a.sent).toEqual([]);
    expect(t.spare.sent.length).toBe(1);
  });

  it('credentials: every runner and spare gets them, shaped, and the pool fills', () => {
    const t = setup();
    t.org.credentials({ t: 'credentials', credentials: creds('new') });
    expect(t.org.creds?.slackBotToken).toBe('new');
    expect(t.a.sent[0]).toMatchObject({ t: 'credentials', credentials: { slackBotToken: 'new', model: { profile: 'a' } } });
    expect(t.spare.sent).toEqual([{ t: 'credentials', credentials: shaped('', creds('new')) }]);
    expect(t.fill()).toBe(1);
  });

  it('people: a changed owner reaches the session, and only new members are prepared', () => {
    const t = setup();
    t.org.welcome({ t: 'welcome', protocol: 1, credentials: creds('xoxb'), people: [person('U1')] });
    t.a.sent.length = 0;
    t.org.peopleChanged({ t: 'people', people: [person('U1', 'Ann', 'ann@x'), person('U2')] });
    expect(t.a.sent).toEqual([{ t: 'owner', owner: person('U1', 'Ann', 'ann@x') }]);
    expect(t.a.owner).toEqual(person('U1', 'Ann', 'ann@x'));
    expect(t.prepared.map((p) => p.slackUserId)).toEqual(['U2']);
    // The same people again: nothing to say, nobody to prepare.
    t.a.sent.length = 0;
    t.org.peopleChanged({ t: 'people', people: [person('U1', 'Ann', 'ann@x'), person('U2')] });
    expect(t.a.sent).toEqual([]);
    expect(t.prepared.length).toBe(1);
  });
});
