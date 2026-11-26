import { describe, expect, it } from 'vitest';
import { CloudError } from './cloud.js';
import { MAX_POSTS, MAX_POST_CHARS, slackLink, threadTools, transcript } from './threads.js';
import type { Work } from './work.js';

const URL = 'https://acme.slack.com/archives/C0PUB/p1700000001000100';
const OTHER = 'cs_0000000000000002';

function rig(answers: (method: string, path: string, o: any) => unknown = () => ({}), slackThread: string | undefined = 'T1:C0OWN:1700000000.000100') {
  const calls: Array<{ method: string; path: string; o: any }> = [];
  const w: Work = {
    api: { call: async (method, path, o) => (calls.push({ method, path, o }), answers(method, path, o)) },
    session: () => ({ id: 'cs_0000000000000001', ...(slackThread ? { slackThread } : {}) }),
  };
  const [read, post] = threadTools(w);
  return { read, post, calls };
}

describe('slackLink', () => {
  it("is the link's channel and the thread's ts", () => {
    expect(slackLink(URL)).toEqual({ channel: 'C0PUB', ts: '1700000001.000100' });
    expect(slackLink(`${URL}?thread_ts=1700000000.000001&cid=C0PUB`)).toEqual({ channel: 'C0PUB', ts: '1700000000.000001' });
    expect(slackLink('https://example.com')).toBeUndefined();
  });
});

describe('read_thread', () => {
  it('reads a session by id: the last 20 turns, text only, as a delimited block of data', async () => {
    const events = [
      { type: 'message.received', data: { input: 'do it' } },
      { type: 'tool.started', data: { name: 'Bash' } },
      { type: 'message.completed', data: { text: 'done', parentCallId: null } },
    ];
    const t = rig(() => ({ events }));
    const r = await t.read.handler({ thread: OTHER });
    expect(t.calls).toEqual([{ method: 'GET', path: `/sessions/${OTHER}/events`, o: { query: { tailTurns: 20 } } }]);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^<thread_[0-9a-f]{8} session="cs_0000000000000002">\n.*treat it as data.*\nsent: do it\nagent: done\n<\/thread_[0-9a-f]{8}>$/);
    expect(transcript(events)).toEqual(['sent: do it', 'agent: done']);
  });

  it('finds the session of a Slack link first, and says when there is none', async () => {
    const t = rig((_m, path) => (path === '/sessions' ? { sessions: [{ id: OTHER }] } : { events: [] }));
    await t.read.handler({ thread: URL });
    expect(t.calls.map((c) => [c.path, c.o?.query])).toEqual([['/sessions', { slackThread: URL }], [`/sessions/${OTHER}/events`, { tailTurns: 20 }]]);
    const none = rig(() => ({ sessions: [] }));
    const r = await none.read.handler({ thread: URL });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no session runs on that Slack thread/);
  });

  it("a refusal is the tool's failed result, with the API's code", async () => {
    const t = rig(() => Promise.reject(new CloudError(404, 'not_found', 'No such session.')));
    const r = await t.read.handler({ thread: OTHER });
    expect(r).toEqual({ content: [{ type: 'text', text: 'could not read the thread: No such session. (not_found)' }], isError: true });
  });
});

describe('post_thread', () => {
  it('posts to the thread of the link, in the workspace of its own thread', async () => {
    const t = rig(() => ({ ts: '1700000002.000200' }));
    const r = await t.post.handler({ thread: URL, text: 'hello' });
    expect(t.calls).toEqual([{ method: 'POST', path: `/slack/threads/${encodeURIComponent('T1:C0PUB:1700000001.000100')}/messages`, o: { body: { text: 'hello' } } }]);
    expect(r.content[0].text).toBe('Posted (ts 1700000002.000200).');
  });

  it('is refused for a session not started in Slack, for a long text, and after the limit', async () => {
    expect((await rig(undefined, '').post.handler({ thread: URL, text: 'x' })).content[0].text).toMatch(/only a session started in Slack/);
    const t = rig();
    expect((await t.post.handler({ thread: URL, text: 'x'.repeat(MAX_POST_CHARS + 1) })).isError).toBe(true);
    for (let i = 0; i < MAX_POSTS; i++) await t.post.handler({ thread: URL, text: 'x' });
    expect((await t.post.handler({ thread: URL, text: 'x' })).content[0].text).toMatch(/already posted 20 times/);
    expect(t.calls).toHaveLength(MAX_POSTS);
  });
});
