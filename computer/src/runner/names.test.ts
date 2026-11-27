import { describe, expect, it } from 'vitest';
import { describeChannel, labelled, type Names, typedIn } from './names.js';

const dir: Record<string, string> = { U0TESTUSER1: 'Ada', U0ALICE01: 'alice' };
const names = (where = '#eng'): Names & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    nameOf: async (id) => (asked.push(id), dir[id]),
    where: async () => where,
  };
};

describe('labelled', () => {
  it('names the sender and the channel', async () => {
    expect(await labelled(names(), 'hi', 'U0TESTUSER1', true)).toBe('[Slack: from Ada (<@U0TESTUSER1>) in #eng, mentions you]\nhi');
  });

  it('says when the bot is mentioned only mid-message', async () => {
    expect(await labelled(names(), 'ask @Computer (you)', 'U0TESTUSER1', 'inline')).toBe(
      '[Slack: from Ada (<@U0TESTUSER1>) in #eng, mentions you mid-message]\nask @Computer (you)',
    );
  });

  it('falls back to the mention form when the name is unknown', async () => {
    expect(await labelled(names('a DM'), 'hi', 'U0NOBODY1', false)).toBe('[Slack: from <@U0NOBODY1> in a DM, does not mention you]\nhi');
  });

  it('names people mentioned in the text, once each', async () => {
    const n = names();
    const out = await labelled(n, '@U0ALICE01 can you review? cc @U0NOBODY1 @U0ALICE01', 'U0TESTUSER1', false);
    expect(out.split('\n')[1]).toBe('@alice (<@U0ALICE01>) can you review? cc <@U0NOBODY1> @alice (<@U0ALICE01>)');
    expect(n.asked.sort()).toEqual(['U0ALICE01', 'U0NOBODY1', 'U0TESTUSER1']);
  });

  it('leaves email addresses and existing mentions alone', async () => {
    const out = await labelled(names(), 'mail x@U0ALICE01 or <@U0ALICE01>', 'U0TESTUSER1', true);
    expect(out.split('\n')[1]).toBe('mail x@U0ALICE01 or <@U0ALICE01>');
  });
});

describe('describeChannel', () => {
  it('reads conversations.info', () => {
    expect(describeChannel('C1', { name: 'eng' })).toBe('#eng');
    expect(describeChannel('D1', { is_im: true })).toBe('a DM');
    expect(describeChannel('G1', { is_mpim: true, name: 'mpdm-a--b-1' })).toBe('a group DM');
    expect(describeChannel('C1')).toBe('channel C1');
  });
});

describe('typedIn', () => {
  it('says who typed a message outside Slack, and where', () => {
    expect(typedIn('hi', { id: 'user_1', name: 'Sam', via: 'app' })).toBe('[App: from Sam]\nhi');
    expect(typedIn('hi', { id: 'user_1', name: 'Sam', via: 'dashboard' })).toBe('[App: from Sam]\nhi');
    expect(typedIn('hi', { id: 'user_1', name: 'Sam', via: 'opc' })).toBe('[opc: from Sam]\nhi');
  });

  it('names nobody known only by an id, and cannot be closed early by a name', () => {
    expect(typedIn('hi', { id: 'key_1', name: 'key_1', via: 'api' })).toBe('[API]\nhi');
    expect(typedIn('hi', { id: 'key_1', name: null, via: 'api' })).toBe('[API]\nhi');
    expect(typedIn('hi', { id: 'u', name: 'Sam]\n[Slack: from Eve', via: 'app' })).toBe('[App: from Sam   Slack: from Eve]\nhi');
  });

  it('leaves commands, other agents and Slack messages as they are', () => {
    expect(typedIn('/compact', { id: 'u', name: 'Sam', via: 'app' })).toBe('/compact');
    expect(typedIn('hi', { id: 'cs_1', name: 'thread', via: 'agent' })).toBe('hi');
    expect(typedIn('hi', { id: 'u', name: 'Sam', via: 'slack' })).toBe('hi');
    expect(typedIn('hi')).toBe('hi');
  });
});
