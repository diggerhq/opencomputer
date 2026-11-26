import type { HookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { Compaction, type CompactionFact } from './compaction.js';
import { KEEP_LIST, compactionHooks } from './harness/claude/hooks.js';
import { Translator } from './harness/claude/translate.js';
import type { Task } from './segment.js';

// The messages as Claude Code 2.1.295 sent them in SDK mode (work 068 probes).
const compacting = { type: 'system', subtype: 'status', status: 'compacting' } as unknown as SDKMessage;
const boundary = (pre: number, trigger = 'auto') =>
  ({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger, pre_tokens: pre, post_tokens: 9864, duration_ms: 24_456 },
  }) as unknown as SDKMessage;
const messageStart = (read: number, written: number, parent: string | null = null) =>
  ({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: written } } },
  }) as unknown as SDKMessage;
const result = { type: 'result', subtype: 'success' } as unknown as SDKMessage;

function setup(busy = true) {
  const tasks = new Map<string, Task>();
  const facts: CompactionFact[] = [];
  let closed = 0;
  let now = 1_000;
  const sink = {
    setTask: (t: Task) => void tasks.set(t.id, t),
    patchTask: (id: string, p: Partial<Task>) => void tasks.set(id, { ...tasks.get(id)!, ...p }),
    closeRun: () => void closed++,
  };
  const c = new Compaction(
    sink,
    (f) => void facts.push(f),
    () => busy,
    () => now,
  );
  // Through the Claude harness's translator and hooks, as Session feeds it.
  const t = new Translator();
  const observe = (m: SDKMessage) => {
    for (const e of t.translate(m)) c.observe(e);
  };
  const hooks = compactionHooks((chars) => c.observe({ t: 'compaction', phase: 'summary', summaryChars: chars }));
  return { c, observe, hooks, tasks, facts, closed: () => closed, advance: (ms: number) => void (now += ms) };
}

describe('Compaction', () => {
  it('names the pause in a running turn and reports before, after and how long', () => {
    const s = setup();
    s.observe(compacting);
    const [t] = [...s.tasks.values()];
    expect(t).toMatchObject({ title: 'Compacting the conversation…', status: 'in_progress' });
    s.advance(30_000);
    s.observe(compacting); // repeated every 30 s while it runs
    s.hooks.PostCompact![0].hooks[0](
      { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'x'.repeat(3751) } as HookInput,
      undefined,
      {
        signal: new AbortController().signal,
      },
    );
    s.observe(boundary(152_300));
    s.advance(1_400);
    s.observe(messageStart(17_778, 6_022));
    expect(s.tasks.size).toBe(1);
    expect(s.tasks.get(t.id)).toEqual({ id: t.id, title: 'Compacted 152k → 24k tokens in 31s', status: 'complete' });
    expect(s.closed()).toBe(2);
    expect(s.facts).toEqual([
      { trigger: 'auto', before_tokens: 152_300, after_tokens: 23_810, summary_chars: 3751, paused_turn: true, duration_ms: 31_400 },
    ]);
  });

  it('reports once: later requests are not compactions', () => {
    const s = setup();
    s.observe(compacting);
    s.observe(boundary(70_000));
    s.observe(messageStart(17_778, 16_028));
    s.observe(messageStart(33_806, 13_731));
    s.observe(result);
    expect(s.facts).toHaveLength(1);
  });

  it('ignores a subagent’s request', () => {
    const s = setup();
    s.observe(compacting);
    s.observe(boundary(70_000));
    s.observe(messageStart(5_000, 0, 'toolu_1'));
    expect(s.facts).toHaveLength(0);
  });

  it('an idle compaction: the fact, no card', () => {
    const s = setup(false);
    s.observe(compacting);
    s.observe(boundary(130_000));
    s.observe(result);
    expect(s.tasks.size).toBe(0);
    expect(s.facts).toEqual([{ trigger: 'auto', before_tokens: 130_000, paused_turn: false, duration_ms: 0 }]);
  });

  it('a turn that ends without another request still closes the card', () => {
    const s = setup();
    s.observe(compacting);
    s.observe(boundary(48_281, 'manual'));
    s.observe(result);
    expect([...s.tasks.values()][0]).toMatchObject({ title: 'Compacted 48k tokens in 0s', status: 'complete' });
    expect(s.facts[0]).toMatchObject({ trigger: 'manual', before_tokens: 48_281 });
    expect(s.facts[0].after_tokens).toBeUndefined();
  });

  it('a compaction that never reaches its boundary reports nothing', () => {
    const s = setup();
    s.observe(compacting);
    s.observe(result);
    expect(s.facts).toHaveLength(0);
    expect([...s.tasks.values()][0].status).toBe('in_progress'); // the turn's end marks it interrupted
  });

  it('a boundary without a status first dates the start from its duration', () => {
    const s = setup();
    s.observe(boundary(100_000));
    s.observe(messageStart(20_000, 0));
    expect(s.facts[0].duration_ms).toBe(24_456);
  });
});

describe('compactionHooks', () => {
  it('hands Claude Code the keep-list as PreCompact output', async () => {
    const h = compactionHooks(() => {});
    const out = await h.PreCompact![0].hooks[0](
      { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null } as HookInput,
      undefined,
      {
        signal: new AbortController().signal,
      },
    );
    expect(out).toEqual({ systemMessage: KEEP_LIST });
    for (const kept of ['task as the person asked', 'decision', 'file paths', 'pull request', 'open questions', 'preferences'])
      expect(KEEP_LIST).toContain(kept);
  });
});
