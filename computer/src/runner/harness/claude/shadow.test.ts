import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompactionFact } from '../../compaction.js';
import type { HarnessSpec } from './process.js';
import type { Inbox } from './inbox.js';
import { DEFAULT_SHADOW, ShadowCompaction, type ShadowState, shadowConfig, shadowDue } from './shadow.js';

const deleted: string[] = [];
let deleteFails: Error | undefined;
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<object>()),
  deleteSession: async (id: string) => {
    if (deleteFails) throw deleteFails;
    deleted.push(id);
  },
}));
vi.mock('../../../log.js', () => ({ log: { info: () => {}, warn: (...a: unknown[]) => void warned.push(a.join(' ')), error: () => {} } }));
const warned: string[] = [];

const NOW = 10 * 60 * 60_000;
const state = (over: Partial<ShadowState> = {}): ShadowState => ({
  kind: 'turn',
  ctxTokens: 130_000,
  busy: false,
  promptOpen: false,
  background: false,
  attempts: [],
  now: NOW,
  ...over,
});

describe('shadowDue', () => {
  it('starts after a turn above the threshold, or idle above the lower one', () => {
    expect(shadowDue(DEFAULT_SHADOW, state())).toEqual({ start: true });
    expect(shadowDue(DEFAULT_SHADOW, state({ ctxTokens: 110_000 }))).toEqual({ start: false, why: 'small' });
    expect(shadowDue(DEFAULT_SHADOW, state({ kind: 'idle', ctxTokens: 70_000 }))).toEqual({ start: true });
    expect(shadowDue(DEFAULT_SHADOW, state({ kind: 'idle', ctxTokens: 50_000 }))).toEqual({ start: false, why: 'small' });
  });

  it('never while anything is going on', () => {
    expect(shadowDue(DEFAULT_SHADOW, state({ busy: true }))).toMatchObject({ why: 'busy' });
    expect(shadowDue(DEFAULT_SHADOW, state({ promptOpen: true }))).toMatchObject({ why: 'prompt' });
    expect(shadowDue(DEFAULT_SHADOW, state({ background: true }))).toMatchObject({ why: 'background' });
  });

  it('at most one attempt per 2 min and 3 per hour', () => {
    expect(shadowDue(DEFAULT_SHADOW, state({ attempts: [NOW - 60_000] }))).toMatchObject({ why: 'cooldown' });
    expect(shadowDue(DEFAULT_SHADOW, state({ attempts: [NOW - 50 * 60_000, NOW - 30 * 60_000, NOW - 10 * 60_000] }))).toMatchObject({
      why: 'hourly',
    });
    expect(shadowDue(DEFAULT_SHADOW, state({ attempts: [NOW - 70 * 60_000, NOW - 30 * 60_000, NOW - 10 * 60_000] }))).toEqual({ start: true });
  });

  it('SP_COMPACT_AT sets the threshold; 0 turns it off', () => {
    expect(shadowConfig({ SP_COMPACT_AT: '40000' })).toMatchObject({ compactAt: 40_000, idleAt: 40_000 });
    expect(shadowDue(shadowConfig({ SP_COMPACT_AT: '0' }), state())).toMatchObject({ why: 'off' });
    expect(shadowConfig({})).toBe(DEFAULT_SHADOW);
  });
});

/** A Query whose messages the test feeds. */
function fakeQuery() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const q = {
    interrupted: 0,
    closed: () => closed,
    feed(m: unknown) {
      queue.push(m);
      wake?.();
    },
    async next(): Promise<IteratorResult<unknown>> {
      while (!queue.length && !closed) await new Promise<void>((r) => (wake = r));
      return closed ? { done: true, value: undefined } : { done: false, value: queue.shift() };
    },
    async interrupt() {
      q.interrupted++;
    },
    close() {
      closed = true;
      wake?.();
    },
  };
  return q;
}

function setup() {
  const facts: CompactionFact[] = [];
  const statuses: string[] = [];
  const forks: { inbox: Inbox; extra: Partial<HarnessSpec>; q: ReturnType<typeof fakeQuery> }[] = [];
  const adopted: string[] = [];
  const adoptedCtx: number[] = [];
  const host = {
    info: { cwd: '/w', sdkSessionId: 'live-1' },
    isBusy: false,
    openPrompt: undefined as string | undefined,
    hooks: { turns: { compacted: (f: CompactionFact) => void facts.push(f) } },
    harness(inbox: Inbox, extra: Partial<HarnessSpec>) {
      const q = fakeQuery();
      forks.push({ inbox, extra, q });
      return q as unknown as Query;
    },
    adopt(_q: Query, _inbox: Inbox, id: string, ctx: number) {
      adopted.push(id);
      adoptedCtx.push(ctx);
      host.info.sdkSessionId = id;
    },
    setStatus: (s: string) => void statuses.push(s),
  };
  const shadow = new ShadowCompaction(
    host,
    () => ({ ...DEFAULT_SHADOW, settleMs: 10, deleteAfterMs: [5, 50] }),
    () => Date.now(),
  );
  const started = async (settle = true) => {
    shadow.turnEnded(130_000, settle);
    await vi.advanceTimersByTimeAsync(10);
    return forks.at(-1)!;
  };
  return { host, shadow, facts, statuses, forks, adopted, adoptedCtx, started };
}

const boundary = { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 130_000, post_tokens: 9_000 } };
const summary = { type: 'user', message: { content: 'This session is being continued from a previous conversation… summary' } };
const done = { type: 'result', subtype: 'success' };

describe('ShadowCompaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    deleted.length = 0;
    warned.length = 0;
    deleteFails = undefined;
  });
  afterEach(() => vi.useRealTimers());

  it('forks the conversation, compacts it, and swaps it in when nothing arrived', async () => {
    const t = setup();
    const f = await t.started();
    expect(f.extra.forkTo).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.extra.deny?.()).toBe(true); // permissions denied while it runs
    expect(t.statuses).toEqual(['processing']);
    f.q.feed(boundary);
    f.q.feed(summary);
    f.q.feed(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adopted).toEqual([f.extra.forkTo]);
    expect(f.extra.deny?.()).toBe(false); // the swapped-in harness asks as usual
    expect(f.q.closed()).toBe(false);
    expect(t.statuses).toEqual(['processing', 'active']);
    expect(t.facts).toEqual([
      expect.objectContaining({
        trigger: 'shadow',
        outcome: 'swapped',
        reason: 'turn',
        before_tokens: 130_000,
        post_tokens: 9_000,
        summary_chars: summary.message.content.length,
      }),
    ]);
    expect(deleted).toEqual([]);
  });

  it('after a swap the session has the compacted count and no idle trigger left over from the long conversation', async () => {
    const t = setup();
    const f = await t.started();
    f.q.feed(boundary);
    f.q.feed(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adoptedCtx).toEqual([9_000]);
    await vi.advanceTimersByTimeAsync(DEFAULT_SHADOW.idleMs + 1000);
    expect(t.forks).toHaveLength(1);
    // The next turn ends idle-sized: the idle trigger uses the compacted count, not 130k.
    t.shadow.turnEnded(9_500);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.forks).toHaveLength(1);
  });

  it('a turn that took a message mid-way arms no settle trigger (the harness may hold it over); idle still runs', async () => {
    const t = setup();
    await t.started(false);
    expect(t.forks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_SHADOW.idleMs);
    expect(t.forks).toHaveLength(1);
  });

  it('a transcript that cannot be deleted is logged; one already gone is not', async () => {
    const t = setup();
    const f = await t.started();
    deleteFails = new Error('EACCES: permission denied');
    f.q.feed({ type: 'result', subtype: 'error_during_execution' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(warned).toEqual([expect.stringContaining(`${f.extra.forkTo}: delete failed: EACCES`), expect.stringContaining('delete failed')]);
    warned.length = 0;
    await vi.advanceTimersByTimeAsync(DEFAULT_SHADOW.cooldownMs);
    const g = await t.started();
    deleteFails = new Error('Session x not found in any project directory');
    g.q.feed({ type: 'result', subtype: 'error_during_execution' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(warned).toEqual([]);
  });

  it('a message first: the fork is interrupted, closed, deleted, never adopted', async () => {
    const t = setup();
    const f = await t.started();
    f.q.feed(boundary);
    t.shadow.cancel(); // Session.send, synchronously before its first await
    f.q.feed(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.adopted).toEqual([]);
    expect(f.q.interrupted).toBe(1);
    expect(f.q.closed()).toBe(true);
    expect(deleted).toEqual([f.extra.forkTo, f.extra.forkTo]); // once at close, once past the process's kill deadline
    expect(t.facts).toEqual([expect.objectContaining({ outcome: 'discarded', between_turns: true })]);
    expect(t.statuses).toEqual(['processing']); // the arriving turn owns the status now
  });

  it('never swaps under a running turn or an open prompt', async () => {
    const t = setup();
    const f = await t.started();
    t.host.openPrompt = 'p1'; // a background agent asked something
    f.q.feed(boundary);
    f.q.feed(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.adopted).toEqual([]);
    expect(deleted).toContain(f.extra.forkTo);
    expect(t.facts).toEqual([expect.objectContaining({ outcome: 'discarded' })]);
  });

  it('a fork that ends without compacting fails and is deleted', async () => {
    const t = setup();
    const f = await t.started();
    f.q.feed({ type: 'result', subtype: 'error_during_execution' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.adopted).toEqual([]);
    expect(deleted).toContain(f.extra.forkTo);
    expect(t.facts).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    expect(t.statuses).toEqual(['processing', 'active']);
  });

  it('one fork at a time, none while a turn runs', async () => {
    const t = setup();
    t.host.isBusy = true;
    t.shadow.turnEnded(130_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.forks).toHaveLength(0);
    t.host.isBusy = false;
    await t.started();
    t.shadow.turnEnded(130_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.forks).toHaveLength(1);
  });
});
