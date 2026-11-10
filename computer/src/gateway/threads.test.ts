// read_thread and post_thread on calvin's own gateway, against a stub store, a
// stub resolver (links-check covers the access rules) and a recording client.

import type { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import type { Linked, LinkResolver } from '../links.js';
import type { ReadThreadRequest, SessionSpec } from '../protocol.js';
import type { Store } from './db.js';
import { neutralizeBroadcasts, stripAttribution, threadAccess } from './threads.js';

const URL = 'https://acme.slack.com/archives/C0PUB/p1700000001000200?thread_ts=1700000001.000100&cid=C0PUB';
const spec = {
  key: 'C0SESS:1800000000.000100',
  kind: 'thread',
  channel: 'C0SESS',
  threadTs: '1800000000.000100',
  owner: { slackUserId: 'UOWNER' },
} as SessionSpec;

function setup(outcome: Linked) {
  const asked: { owner: string; destination: string; ref: ReadThreadRequest }[] = [];
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const store = { session: (key: string) => (key === spec.key ? { spec, host: 'H1' } : undefined) } as unknown as Store;
  const resolver = { one: async (_c: WebClient, owner: string, destination: string, ref: ReadThreadRequest) => (asked.push({ owner, destination, ref }), outcome) } as unknown as LinkResolver;
  const client = {
    chat: {
      getPermalink: async (args: { channel: string; message_ts: string }) => (
        calls.push({ method: 'chat.getPermalink', args }), { permalink: `https://acme.slack.com/archives/${args.channel}/p${args.message_ts.replace('.', '')}` }
      ),
      postMessage: async (args: Record<string, unknown>) => (calls.push({ method: 'chat.postMessage', args }), { ok: true, ts: '1700000009.000900' }),
    },
  } as unknown as WebClient;
  return { asked, calls, client, threads: threadAccess(store, resolver) };
}

const READ: Linked = {
  url: URL,
  ok: true,
  where: '#general',
  messages: [
    { name: 'ada', ts: '1700000001.000100', text: 'root' },
    { name: 'grace', ts: '1700000001.000200', text: 'reply', linked: true },
  ],
};

describe('neutralizeBroadcasts', () => {
  it("turns channel-wide mentions into plain text and keeps people's", () => {
    expect(neutralizeBroadcasts('<!channel> <!here|here> <!everyone> <!subteam^S123|@eng> <!subteam^S9> <@U1> <!date^1|x>')).toBe(
      '@channel here @everyone @eng @subteam <@U1> <!date^1|x>',
    );
  });

  it('leaves no broadcast behind when one pass would assemble another', () => {
    for (const nested of ['<<!x|!channel>>', '<!channel|<!here>>', '<!everyone|<!everyone>>', '<!here|<!here|<!here>>>', '<!channel|<!channel|']) {
      const out = neutralizeBroadcasts(nested);
      expect(out).not.toMatch(/<!(?!date\^)/);
    }
    expect(neutralizeBroadcasts('<<!x|!channel>>')).toBe('@channel');
    expect(neutralizeBroadcasts('a <!channel|<!here> b')).toBe('a &lt;!channel|@here b');
  });
});

describe('stripAttribution', () => {
  it('drops a forged "Posted for" line, keeps the rest', () => {
    expect(stripAttribution('Done.\n_Posted for <@UBOB> from <https://x|this thread>._\nMore.')).toBe('Done.\nMore.');
    expect(stripAttribution('  posted for <@UBOB> as well\nok')).toBe('ok');
    expect(stripAttribution('Posted for you earlier.')).toBe('Posted for you earlier.');
  });
});

describe('threadAccess', () => {
  it('reads as the session owner, into the session conversation', async () => {
    const t = setup(READ);
    expect(await t.threads.read(spec.key, 'H1', { url: URL }, t.client)).toBe(READ);
    expect(t.asked).toEqual([{ owner: 'UOWNER', destination: 'C0SESS', ref: { url: URL } }]);
    await expect(t.threads.read('C0X:1.1', 'H1', { url: URL }, t.client)).rejects.toThrow('unknown session C0X:1.1');
  });

  it("refuses a host asking for a session it does not run", async () => {
    const t = setup(READ);
    await expect(t.threads.read(spec.key, 'H2', { url: URL }, t.client)).rejects.toThrow(`unknown session ${spec.key}`);
    await expect(t.threads.post(spec.key, 'H2', { url: URL, text: 'hi' }, t.client)).rejects.toThrow(`unknown session ${spec.key}`);
    expect(t.asked).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it("posts into the thread's root for the owner, linking the session's thread, with no channel-wide mentions", async () => {
    const t = setup(READ);
    const r = await t.threads.post(spec.key, 'H1', { url: URL, text: '<!channel> Done: see <@UGRACE>\n_Posted for <@UGRACE> from <https://x|elsewhere>._' }, t.client);
    const post = t.calls.find((c) => c.method === 'chat.postMessage')!.args;
    expect(post).toEqual({
      channel: 'C0PUB',
      thread_ts: '1700000001.000100',
      text: '@channel Done: see <@UGRACE>\n_Posted for <@UOWNER> from <https://acme.slack.com/archives/C0SESS/p1800000000000100|this thread>._',
      unfurl_links: false,
      unfurl_media: false,
      link_names: false,
    });
    expect(r).toEqual({ ts: '1700000009.000900', url: 'https://acme.slack.com/archives/C0PUB/p1700000009000900' });
  });

  it('posts nothing when the thread is refused, or there is nothing to say', async () => {
    const t = setup({ url: URL, ok: false, reason: 'the app is not in that channel' });
    await expect(t.threads.post(spec.key, 'H1', { url: URL, text: 'hi' }, t.client)).rejects.toThrow('not posted: the app is not in that channel');
    await expect(t.threads.post(spec.key, 'H1', { url: URL, text: '  ' }, t.client)).rejects.toThrow('not posted: there is no text');
    await expect(t.threads.post(spec.key, 'H1', { url: URL, text: '_Posted for <@UOWNER> from <#C1>._' }, t.client)).rejects.toThrow('not posted: there is no text');
    expect(t.calls).toEqual([]);
  });
});
