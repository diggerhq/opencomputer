// Session against a fake harness and a recording Slack client: when the turn's
// message opens (work 068, "something visible at push") and how its opening
// card flips, and that the end of a turn doesn't hold up the next one.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The harness the Session starts: yields what a test feeds it. */
class FakeQuery {
  private buf: SDKMessage[] = [];
  private wake?: () => void;
  private err?: Error;
  feed(...ms: unknown[]) {
    this.buf.push(...(ms as SDKMessage[]));
    this.wake?.();
  }
  /** The harness process dies. */
  fail(e: Error) {
    this.err = e;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.buf.length) yield this.buf.shift()!;
      if (this.err) throw this.err;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
  initializationResult = () => new Promise(() => {});
  interrupt = async () => {};
  close() {}
}
const harness = vi.hoisted(() => ({ q: undefined as unknown as { feed(...ms: unknown[]): void; fail(e: Error): void } }));
vi.mock('./harness/claude/process.js', () => ({ startHarness: () => (harness.q = new FakeQuery()) }));
vi.mock('./harness/claude/mcp.js', () => ({ calvinServer: () => ({}) }));

const { Session, SILENT } = await import('./session.js');

type Call = { method: string; args: Record<string, unknown>; ts: string };

/** A Slack client that records every call; `hold` makes a method wait until released. */
function slack() {
  const calls: Call[] = [];
  const held = new Map<string, () => void>();
  const holds = new Set<string>();
  let n = 0;
  const node = (names: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, k) => (k === 'then' ? undefined : node([...names, String(k)])),
      apply: async (_, __, [args]) => {
        const method = names.join('.');
        const ts = `1.${++n}`;
        calls.push({ method, args, ts });
        if (holds.has(method)) await new Promise<void>((r) => held.set(method, r));
        if (method === 'users.info') return { ok: true, user: { profile: { display_name: 'tester' } } };
        return { ok: true, ts };
      },
    });
  return {
    calls,
    client: node([]) as WebClient,
    hold: (m: string) => holds.add(m),
    release: (m: string) => (holds.delete(m), held.get(m)?.()),
    of: (m: string) => calls.filter((c) => c.method === m),
  };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const chunks = (calls: Call[]) => calls.flatMap((c) => (c.args.chunks as Record<string, unknown>[] | undefined) ?? []);

function session(opts: { fresh?: boolean } = {}) {
  const s = slack();
  const busy: boolean[] = [];
  const cwd = mkdtempSync(path.join(tmpdir(), 'session-test-'));
  const info = { key: 'k', kind: 'thread' as const, channel: 'C1', threadTs: '1.0', userId: 'U1', cwd, title: 't', mode: 'default' as const };
  const sess = new Session(opts.fresh ? info : { ...info, sdkSessionId: 'sdk-1' }, s.client, () => {}, { busy: (b) => void busy.push(b) });
  return { ...s, sess, busy };
}

const ev = (event: Record<string, unknown>) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const start = (index: number, block: Record<string, unknown>) => ev({ type: 'content_block_start', index, content_block: block });
const textBlock = (index: number, text: string) => [
  start(index, { type: 'text', text: '' }),
  ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
  ev({ type: 'content_block_stop', index }),
];
const result = (subtype = 'success') => ({ type: 'result', subtype, total_cost_usd: 0 });
const messageStart = ev({ type: 'message_start', message: { usage: {} } });

afterEach(() => vi.restoreAllMocks());

describe('Session: the message opens at push (work 068)', () => {
  it('an addressed turn opens its stream with a `Started` card before any model event', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    expect(t.of('chat.startStream')).toHaveLength(1);
    expect(chunks(t.of('chat.startStream'))).toEqual([{ type: 'task_update', id: expect.stringMatching(/^run-/), title: 'Started', status: 'in_progress' }]);
  });

  it('a fresh session opens it below the intro', async () => {
    const t = session({ fresh: true });
    await t.sess.send('hi', 'U1');
    await settle();
    const order = t.calls.map((c) => c.method).filter((m) => m.startsWith('chat.'));
    expect(order.slice(0, 2)).toEqual(['chat.postMessage', 'chat.startStream']);
  });

  it('text first: the card completes as `✓ Started` before the text, never "Thought"', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.feed(messageStart, ...textBlock(0, 'Hello.'), result());
    await settle();
    const all = chunks(t.calls);
    const runId = all[0].id;
    expect(all.filter((c) => c.id === runId).map((c) => [c.title, c.status])).toEqual([
      ['Started', 'in_progress'],
      ['Started', 'complete'],
    ]);
    expect(all.findIndex((c) => c.status === 'complete')).toBeLessThan(all.findIndex((c) => c.type === 'markdown_text'));
    expect(t.of('chat.startStream')).toHaveLength(1);
    expect(t.of('chat.stopStream')).toHaveLength(1);
  });

  it('thinking first: the card becomes the thinking card at once, and ends as "Thought for"', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.feed(
      messageStart,
      start(0, { type: 'thinking' }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } }),
    );
    await settle(700); // one flush (600 ms): a 300 ms card delay would miss it
    const runId = chunks(t.calls)[0].id;
    harness.q.feed(ev({ type: 'content_block_stop', index: 0 }), ...textBlock(1, 'Done.'), result());
    await settle();
    const card = chunks(t.calls).filter((c) => c.id === runId);
    expect(card.map((c) => c.title)).toEqual(['Started', 'Thinking… · pondering', 'Thought for 1s']);
  });

  it('a visible tool first: the card becomes the tool card', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.feed(messageStart, start(0, { type: 'tool_use', id: 'tu1', name: 'Bash' }));
    await settle(700);
    const all = chunks(t.calls);
    expect(all.at(-1)).toMatchObject({ id: all[0].id, title: 'Bash…', status: 'in_progress' });
  });

  it('a hidden tool first shows no card; the card waits for the first visible thing', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.feed(messageStart, start(0, { type: 'tool_use', id: 'tu1', name: 'ToolSearch' }));
    await settle(700);
    expect(chunks(t.calls)).toHaveLength(1);
  });

  it('a turn that fails before any token: the card errors with the reason', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.feed(result('error_max_turns'));
    await settle();
    const all = chunks(t.calls);
    expect(all.at(-1)).toMatchObject({ id: all[0].id, title: 'Started', status: 'error', details: 'error_max_turns' });
  });

  it('a harness crash before any token: the card errors as crashed, not `✓ Started`', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.fail(new Error('exit 1'));
    await settle();
    const all = chunks(t.calls);
    expect(all.at(-1)).toMatchObject({ id: all[0].id, title: 'Started', status: 'error', details: 'crashed' });
  });

  it('the first real thing after the card goes out at once, not a flush interval later', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.feed(messageStart, start(0, { type: 'tool_use', id: 'tu1', name: 'Bash' }));
    await settle(50);
    expect(t.of('chat.appendStream').map((c) => chunks([c])[0])).toMatchObject([{ title: 'Bash…' }]);
  });

  it('a silent turn deletes the opened message, with no footer', async () => {
    const t = session();
    await t.sess.send('hi', 'U1');
    await settle();
    harness.q.feed(messageStart, ...textBlock(0, SILENT), result());
    await settle();
    expect(t.of('chat.delete').map((c) => c.args.ts)).toEqual(t.of('chat.startStream').map((c) => c.ts));
    expect(t.of('chat.stopStream').every((c) => !c.args.blocks)).toBe(true);
  });

  it('a message not addressed to the agent opens nothing at push', async () => {
    const t = session();
    await t.sess.send('hi', 'U1', [], false);
    await settle();
    expect(t.of('chat.startStream')).toHaveLength(0);
  });

  it('a steer while busy opens nothing; an unclaimed card is done, not "continues below"', async () => {
    const t = session();
    await t.sess.send('first', 'U1');
    await settle();
    await t.sess.send('steer', 'U1');
    await settle();
    expect(t.of('chat.startStream')).toHaveLength(1);
    expect(chunks(t.calls).at(-1)).toMatchObject({ title: 'Started', status: 'complete' });
  });
});

describe('Session: the end of a turn is off the pump (work 068 2f)', () => {
  it("the next turn's events run while chat.stopStream is in flight; its message posts after", async () => {
    const t = session();
    await t.sess.send('one', 'U1');
    await settle();
    t.hold('chat.stopStream');
    harness.q.feed(messageStart, ...textBlock(0, 'One.'), result());
    await settle();
    expect(t.sess.isBusy).toBe(false);
    expect(t.busy).toEqual([true]); // busy(false) waits for the close
    await t.sess.send('two', 'U1');
    harness.q.feed(messageStart, ...textBlock(0, 'Two.'));
    await settle();
    expect(t.sess.isBusy).toBe(true);
    expect(t.of('chat.startStream')).toHaveLength(1); // the second message waits for the first to close
    t.release('chat.stopStream');
    await settle();
    const order = t.calls.map((c) => c.method).filter((m) => m === 'chat.startStream' || m === 'chat.stopStream');
    expect(order).toEqual(['chat.startStream', 'chat.stopStream', 'chat.startStream']);
    expect(t.busy).toEqual([true, true]); // the first close finished mid-turn two: no busy(false) for it
    // …and its stopStream (sent before turn two began, so it says active) doesn't leave turn two looking idle.
    const last = t.calls.filter((c) => c.method === 'agents.sessions.setStatus' || c.args.session_status).at(-1)!;
    expect(last.args.status).toBe('processing');
  });

  it('a silent close landing during the next turn leaves its working status alone', async () => {
    const t = session();
    await t.sess.send('one', 'U1');
    await settle();
    t.hold('chat.delete');
    harness.q.feed(messageStart, ...textBlock(0, SILENT), result());
    await settle();
    await t.sess.send('two', 'U1');
    t.release('chat.delete');
    await settle();
    expect(t.sess.isBusy).toBe(true);
    expect(t.of('agents.sessions.setStatus').map((c) => c.args.status)).not.toContain('active');
  });

  it("a close that starts once the next turn runs doesn't say active at all", async () => {
    const t = session();
    await t.sess.send('one', 'U1');
    await settle();
    harness.q.feed(messageStart, ...textBlock(0, 'One.'));
    await settle(700);
    t.hold('chat.appendStream');
    harness.q.feed(...textBlock(1, ' More.'));
    await settle(700); // an append in flight: turn one's stopStream queues behind it
    harness.q.feed(result());
    await settle();
    await t.sess.send('two', 'U1');
    t.release('chat.appendStream');
    await settle();
    expect(t.of('chat.stopStream')[0].args.session_status).toBeUndefined();
  });

  it('overlapping closes land in order; busy(false) only once every close has', async () => {
    const t = session();
    await t.sess.send('one', 'U1');
    await settle();
    t.hold('chat.stopStream');
    harness.q.feed(messageStart, ...textBlock(0, 'One.'), result());
    await settle();
    await t.sess.send('two', 'U1', [], false); // not addressed, stays silent
    harness.q.feed(messageStart, ...textBlock(0, SILENT), result());
    await settle();
    expect(t.busy).toEqual([true, true]);
    t.release('chat.stopStream');
    await settle();
    expect(t.busy).toEqual([true, true, false]);
  });
});
