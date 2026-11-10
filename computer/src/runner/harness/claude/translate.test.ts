import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { isModelDenied, isOutOfCredits, Translator } from './translate.js';

const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] }, ...extra }) as unknown as SDKMessage;

describe('isOutOfCredits', () => {
  it("is the SDK's billing error", () => {
    expect(isOutOfCredits(assistant('', { error: 'billing_error' }))).toBe(true);
  });

  it("is OpenRouter's key limit, rendered as a 402", () => {
    expect(isOutOfCredits(assistant('API Error: 402 This request requires more credits, or fewer max_tokens.'))).toBe(true);
  });

  it("is not another failure, a reply that mentions 402, or a subagent's call", () => {
    expect(isOutOfCredits(assistant('API Error: 429 rate limited', { error: 'rate_limit' }))).toBe(false);
    expect(isOutOfCredits(assistant('The endpoint answers API Error: 402 when the key runs out.'))).toBe(false);
    expect(isOutOfCredits(assistant('API Error: 402 requires more credits', { parent_tool_use_id: 'toolu_1' }))).toBe(false);
  });
});

const tr = (...ms: object[]) => {
  const t = new Translator();
  return ms.flatMap((m) => t.translate(m as SDKMessage));
};
const ev = (event: object, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event });

describe('Translator', () => {
  it('a streamed text block: start, live deltas, end and the whole text; the final assistant message adds no fallback', () => {
    expect(
      tr(
        ev({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } } }),
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
        ev({ type: 'content_block_stop', index: 0 }),
        assistant('Hello'),
      ),
    ).toEqual([
      { t: 'request', phase: 'first_token', usage: { input: 3, output: 0, cacheRead: 10, cacheWrite: 2 } },
      { t: 'block', phase: 'start', id: '0', index: 0, kind: 'text' },
      { t: 'live', kind: 'text', id: '0', delta: 'Hel' },
      { t: 'live', kind: 'text', id: '0', delta: 'lo' },
      { t: 'block', phase: 'end', id: '0', index: 0, kind: 'text' },
      { t: 'text', delta: 'Hello' },
      { t: 'message' },
    ]);
  });

  it("a tool block's streamed input is tool_input on the block's call id (work 084 A1)", () => {
    expect(
      tr(
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Write' } }),
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }),
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } }),
      ),
    ).toEqual([
      { t: 'block', phase: 'start', id: 'tu1', index: 1, kind: 'tool', name: 'Write' },
      { t: 'tool_input', id: 'tu1', delta: '{"file_path":' },
    ]);
  });

  it('an unstreamed answer falls back to its text; a tool call is a record with its input', () => {
    const m = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } };
    expect(tr(m)).toEqual([{ t: 'message' }, { t: 'text', delta: 'Let me look.' }, { t: 'tool', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]);
  });

  it("a subagent's stream is dropped; its messages and tool calls carry the parent", () => {
    const sub = { type: 'assistant', parent_tool_use_id: 'task1', message: { content: [{ type: 'text', text: 'inner' }, { type: 'tool_use', id: 'tu2', name: 'Read', input: {} }] } };
    expect(tr(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'task1'), sub)).toEqual([
      { t: 'message', parent: 'task1' },
      { t: 'tool', id: 'tu2', name: 'Read', input: {}, parent: 'task1' },
    ]);
  });

  it('tool results: ok unless is_error; subagent results are dropped', () => {
    const user = (parent: string | null) => ({
      type: 'user',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'fine' }, { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }] },
    });
    expect(tr(user(null))).toEqual([
      { t: 'tool_result', id: 'tu1', ok: true, output: 'fine' },
      { t: 'tool_result', id: 'tu2', ok: false, output: 'boom' },
    ]);
    expect(tr(user('task1'))).toEqual([]);
  });

  it('a refused model is an error record with its code', () => {
    expect(tr(assistant('model not allowed', { error: 'model_not_found' }))).toContainEqual({ t: 'error', kind: 'model', code: 'model_not_found', message: 'model not allowed' });
    expect(isModelDenied(assistant('', { error: 'model_not_found', parent_tool_use_id: 'task1' }))).toBe(false);
  });

  it("a tool call's block is the call's id, start and end", () => {
    expect(
      tr(ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu9', name: 'Bash' } }), ev({ type: 'content_block_stop', index: 2 })),
    ).toEqual([
      { t: 'block', phase: 'start', id: 'tu9', index: 2, kind: 'tool', name: 'Bash' },
      { t: 'block', phase: 'end', id: 'tu9', index: 2, kind: 'tool' },
    ]);
  });

  it('out of credits: a limit record, and no fallback text', () => {
    expect(tr(assistant('API Error: 402 requires more credits'))).toEqual([{ t: 'message' }, { t: 'limit', kind: 'credits' }]);
  });

  it('results end the turn with their subtype as detail, usage, API time and the running cost', () => {
    expect(tr({ type: 'result', subtype: 'success', usage: { input_tokens: 5, output_tokens: 7 }, duration_api_ms: 900, total_cost_usd: 0.2 })).toEqual([
      { t: 'turn_ended', reason: 'done', usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 }, apiMs: 900, costTotalUsd: 0.2 },
    ]);
    // A stop or a failure: Session and TurnEvents tell which by whether they stopped it.
    expect(tr({ type: 'result', subtype: 'error_during_execution' })[0]).toMatchObject({ reason: 'error', detail: 'error_during_execution' });
    expect(tr({ type: 'result', subtype: 'error_max_turns' })[0]).toMatchObject({ reason: 'error', detail: 'error_max_turns' });
  });

  it('system messages: init, requesting, compaction start and end', () => {
    expect(
      tr(
        { type: 'system', subtype: 'init', session_id: 's1', model: 'opus' },
        { type: 'system', subtype: 'status', status: 'requesting' },
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150_000, duration_ms: 4_000 } },
      ),
    ).toEqual([
      { t: 'session', ref: { harness: 'claude', id: 's1' }, model: 'opus' },
      { t: 'request', phase: 'start' },
      { t: 'compaction', phase: 'start' },
      { t: 'compaction', phase: 'end', trigger: 'auto', before: 150_000, durationMs: 4_000 },
    ]);
  });

  it("a hook's summary comes out ahead of the next message, in order", () => {
    const t = new Translator();
    t.summarized(1234);
    expect(t.translate({ type: 'system', subtype: 'status', status: 'requesting' } as unknown as SDKMessage)).toEqual([
      { t: 'compaction', phase: 'summary', summaryChars: 1234 },
      { t: 'request', phase: 'start' },
    ]);
    expect(t.translate({ type: 'system', subtype: 'status', status: 'requesting' } as unknown as SDKMessage)).toEqual([{ t: 'request', phase: 'start' }]);
  });

  it("an adopted fork drops its hook's summary: the session never saw that compaction start", () => {
    const t = new Translator();
    t.summarized(1234);
    t.dropHeld();
    expect(t.translate({ type: 'system', subtype: 'status', status: 'requesting' } as unknown as SDKMessage)).toEqual([{ t: 'request', phase: 'start' }]);
  });

  it('subagent lifecycle: only local agents start; updates and notifications map to states', () => {
    const sys = (o: object) => ({ type: 'system', ...o });
    expect(
      tr(
        sys({ subtype: 'task_started', task_id: 'a', task_type: 'local_bash', description: 'x' }),
        sys({ subtype: 'task_started', task_id: 'b', task_type: 'local_agent', description: 'Research', subagent_type: 'Explore' }),
        sys({ subtype: 'task_progress', task_id: 'b', summary: 'reading', usage: { tool_uses: 2, total_tokens: 900 } }),
        sys({ subtype: 'task_updated', task_id: 'b', patch: { status: 'killed' } }),
        sys({ subtype: 'task_notification', task_id: 'b', status: 'completed', summary: 'found it', usage: { tool_uses: 3, total_tokens: 1000, duration_ms: 5000 } }),
      ),
    ).toEqual([
      { t: 'task', id: 'b', state: 'started', title: 'Research', agentType: 'Explore', background: false },
      { t: 'task', id: 'b', state: 'progress', doing: 'reading', tools: 2, tokens: 900 },
      { t: 'task', id: 'b', state: 'stopped' },
      { t: 'task', id: 'b', state: 'done', result: 'found it', tools: 3, tokens: 1000, durationMs: 5000 },
    ]);
  });
});
