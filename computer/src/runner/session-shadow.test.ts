// Session and the fork compaction together (shadow.ts): the harness is a fake
// the test feeds, Slack is the printing fake; nothing is spawned.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSlack } from '../dev/fake-slack.js';
import type { HarnessSpec } from './harness/claude/process.js';
import { configureShadow, DEFAULT_SHADOW } from './harness/claude/shadow.js';

/** A harness the test feeds; `forkTo` tells a fork from the live one. */
function fakeQuery(spec: HarnessSpec) {
  const queue: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  const q = {
    spec,
    closed: false,
    interrupted: 0,
    feed(m: object) {
      queue.push(m as SDKMessage);
      wake?.();
    },
    [Symbol.asyncIterator]() {
      return q;
    },
    async next(): Promise<IteratorResult<SDKMessage>> {
      while (!queue.length && !q.closed) await new Promise<void>((r) => (wake = r));
      return q.closed ? { done: true, value: undefined } : { done: false, value: queue.shift()! };
    },
    async interrupt() {
      q.interrupted++;
    },
    close() {
      q.closed = true;
      wake?.();
    },
    initializationResult: async () => ({}),
    setModel: async () => {},
    setPermissionMode: async () => {},
  };
  return q;
}
type Fake = ReturnType<typeof fakeQuery>;
const harnesses: Fake[] = [];
vi.mock('./harness/claude/process.js', () => ({
  startHarness: (_inbox: unknown, spec: HarnessSpec) => harnesses[harnesses.push(fakeQuery(spec)) - 1] as unknown as Query,
}));
vi.mock('./skills.js', () => ({ ensureSkills: () => [] }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({ ...(await orig<object>()), deleteSession: async () => {} }));

const { Session } = await import('./session.js');

const start = (read: number) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } } },
});
const text = (t: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
});
const result = { type: 'result', subtype: 'success', total_cost_usd: 0.01 };
const requesting = { type: 'system', subtype: 'status', status: 'requesting' };

async function setup() {
  harnesses.length = 0;
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'calvin-shadow-'));
  const s = new Session(
    { key: 'k', kind: 'thread', channel: 'C', threadTs: '1.0', userId: 'U', cwd, title: 't', mode: 'bypassPermissions', sdkSessionId: 'live-1' },
    fakeSlack(() => {}),
    () => {},
  );
  const live = () => harnesses[0];
  const fork = () => harnesses.find((h) => h.spec.forkTo);
  const settle = async () => void (await vi.advanceTimersByTimeAsync(DEFAULT_SHADOW.settleMs + 10));
  return { s, live, fork, settle };
}

describe('Session with the fork compaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    configureShadow({ ...DEFAULT_SHADOW, compactAt: 1_000, idleAt: 1_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
    configureShadow(DEFAULT_SHADOW);
  });

  it('a steer during a text-only answer: no fork after the turn; the harness starting the held-over turn makes the session busy', async () => {
    const { s, live, fork, settle } = await setup();
    await s.send('do it', 'U');
    live().feed(start(5_000));
    live().feed(text('Rivers are'));
    await vi.advanceTimersByTimeAsync(0);
    await s.send('then say BANANA', 'U'); // priority next; no tool boundary is coming
    live().feed(result);
    await settle();
    expect(fork()).toBeUndefined();
    expect(s.isBusy).toBe(false);
    live().feed(requesting); // the harness starts the held-over turn on its own
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isBusy).toBe(true);
    live().feed(start(5_200));
    live().feed(result);
    await settle();
    expect(fork()).toBeDefined(); // nothing held over this time
  });

  it('a fork in flight when a turn begins is discarded; the live harness and its turn are untouched', async () => {
    const { s, live, fork, settle } = await setup();
    await s.send('do it', 'U');
    live().feed(start(5_000));
    live().feed(result);
    await settle();
    const f = fork()!;
    expect(s.shadow.running).toBe(true);
    live().feed(start(5_100)); // a turn the harness started by itself (a steer the runner never saw go in)
    await vi.advanceTimersByTimeAsync(0);
    expect(s.shadow.running).toBe(false);
    expect(f.closed).toBe(true);
    expect(f.interrupted).toBe(1);
    expect(live().closed).toBe(false);
    expect(s.isBusy).toBe(true);
    expect(s.info.sdkSessionId).toBe('live-1');
  });

  it('a swap replaces the harness, persists the fork id and resets the context count', async () => {
    const { s, live, fork, settle } = await setup();
    await s.send('do it', 'U');
    live().feed(start(5_000));
    live().feed(result);
    await settle();
    const f = fork()!;
    f.feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5_000, post_tokens: 900 } });
    f.feed({ type: 'result', subtype: 'success' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.info.sdkSessionId).toBe(f.spec.forkTo);
    expect(live().closed).toBe(true);
    expect(s.statusLine()).toContain('ctx 900');
    await vi.advanceTimersByTimeAsync(DEFAULT_SHADOW.idleMs + 1000); // no fork of the compacted conversation
    expect(harnesses).toHaveLength(2);
  });
});
