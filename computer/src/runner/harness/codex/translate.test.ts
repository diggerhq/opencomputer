import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../types.js';
import { errorRecords, Translator, usageOf } from './translate.js';

/** What Codex sent in a recorded transcript (testdata/), translated. */
function replay(name: string) {
  const rec = readFileSync(path.join(import.meta.dirname, 'testdata', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const t = new Translator();
  t.follow(rec.find((r) => r.m?.result?.thread).m.result.thread.id);
  return rec.filter((r) => r.dir === 'in' && r.m.method).flatMap((r) => t.translate(r.m.method, r.m.params));
}
const bodies = (es: HarnessEvent[]) => es.filter((e) => e.t !== 'live');

const T = 'th';
const U = 'tu';
const p = (x: object) => ({ threadId: T, turnId: U, ...x });

describe('Translator', () => {
  it('a turn with thinking and a reply: start, first token, blocks closed with their text, usage, done', () => {
    expect(bodies(replay('ok'))).toEqual([
      { t: 'request', phase: 'start' },
      { t: 'request', phase: 'first_token' },
      { t: 'block', phase: 'start', id: 'rs_1', kind: 'thinking' },
      { t: 'block', phase: 'end', id: 'rs_1', kind: 'thinking' },
      { t: 'thinking', delta: 'Thinking about it' },
      { t: 'block', phase: 'start', id: 'msg_1', kind: 'text' },
      { t: 'block', phase: 'end', id: 'msg_1', kind: 'text' },
      { t: 'text', delta: 'Hello from mock' },
      { t: 'message' },
      { t: 'request', phase: 'end', usage: { input: 1000, output: 7, cacheRead: 200, cacheWrite: 0 } },
      { t: 'turn_ended', reason: 'done', usage: { input: 1000, output: 7, cacheRead: 200, cacheWrite: 0 } },
    ]);
    expect(replay('ok').filter((e) => e.t === 'live')).toEqual([
      { t: 'live', kind: 'thinking', id: 'rs_1', delta: 'Thinking about it' },
      { t: 'live', kind: 'text', id: 'msg_1', delta: 'Hello ' },
      { t: 'live', kind: 'text', id: 'msg_1', delta: 'from mock' },
    ]);
  });

  it("a dynamic tool call is Calvin's tool by its Claude name; a shell command is Bash; each a response of its own", () => {
    const tool = bodies(replay('tool'));
    expect(tool).toContainEqual({ t: 'tool', id: 'call_1', name: 'mcp__calvin__read_thread', input: { url: 'https://x.slack.com/archives/C1/p1' } });
    expect(tool.filter((e) => e.t === 'request' && e.phase === 'first_token')).toHaveLength(2);
    const exec = bodies(replay('exec'));
    expect(exec).toContainEqual(expect.objectContaining({ t: 'tool', id: 'call_1', name: 'Bash' }));
    expect(exec).toContainEqual(expect.objectContaining({ t: 'tool_result', id: 'call_1', ok: true }));
    expect(exec.at(-1)).toMatchObject({ t: 'turn_ended', reason: 'done', usage: { input: 2000, cacheRead: 400 } });
  });

  it('a usage limit, a refused model, an interrupt', () => {
    const limit = bodies(replay('limit'));
    expect(limit.filter((e) => e.t === 'limit' || e.t === 'error')).toEqual([{ t: 'limit', kind: 'rate' }]);
    expect(limit.at(-1)).toMatchObject({ t: 'turn_ended', reason: 'error', detail: 'usageLimitExceeded' });
    const bad = bodies(replay('badmodel'));
    expect(bad.filter((e) => e.t === 'error')).toEqual([expect.objectContaining({ kind: 'model', code: 'model_not_found' })]);
    expect(bodies(replay('interrupt')).at(-1)).toMatchObject({ t: 'turn_ended', reason: 'interrupted' });
  });

  it("drops other threads (subagents) and anything outside the session's turn", () => {
    const t = new Translator();
    t.follow(T);
    expect(t.translate('item/started', p({ item: { id: 'x', type: 'agentMessage' } }))).toEqual([]);
    expect(t.translate('turn/started', { threadId: 'other', turn: { id: U } })).toEqual([]);
    expect(t.translate('turn/started', { threadId: T, turn: { id: U } })).toEqual([{ t: 'request', phase: 'start' }]);
    expect(t.translate('item/started', { threadId: T, turnId: 'old', item: { id: 'x', type: 'agentMessage' } })).toEqual([]);
  });

  it('closes blocks left open at the turn end, and reports a failed turn once', () => {
    const t = new Translator();
    t.follow(T);
    t.translate('turn/started', { threadId: T, turn: { id: U } });
    t.translate('item/started', p({ item: { id: 'm', type: 'agentMessage' } }));
    t.translate('item/agentMessage/delta', p({ itemId: 'm', delta: 'part' }));
    t.translate(
      'item/started',
      p({
        item: {
          id: 'f',
          type: 'fileChange',
          changes: [
            { path: 'a', diff: '+1', kind: { type: 'add' } },
            { path: 'b', diff: '-1', kind: { type: 'update' } },
          ],
        },
      }),
    );
    const out = t.translate('turn/completed', {
      threadId: T,
      turn: { id: U, status: 'failed', error: { message: 'boom', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } } },
    });
    expect(out).toEqual([
      { t: 'block', phase: 'end', id: 'm', kind: 'text' },
      { t: 'text', delta: 'part' },
      { t: 'block', phase: 'end', id: 'f', kind: 'tool' },
      { t: 'block', phase: 'end', id: 'f#1', kind: 'tool' },
      { t: 'error', kind: 'network', code: 'httpConnectionFailed', message: 'boom' },
      { t: 'text', delta: 'boom' },
      { t: 'turn_ended', reason: 'error', detail: 'httpConnectionFailed', usage: { input: 0 } },
    ]);
  });

  it('an error Codex retries is not a record', () => {
    const t = new Translator();
    t.follow(T);
    t.translate('turn/started', { threadId: T, turn: { id: U } });
    expect(t.translate('error', p({ willRetry: true, error: { message: 'reconnecting' } }))).toEqual([]);
  });

  it('usage counts cached input apart; errors map to limits and kinds', () => {
    expect(usageOf({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 })).toEqual({ input: 6, output: 2, cacheRead: 4, cacheWrite: 0 });
    expect(errorRecords('contextWindowExceeded', 'full')[0]).toEqual({ t: 'limit', kind: 'context' });
    expect(errorRecords('usageLimitExceeded', 'x', 5)[0]).toEqual({ t: 'limit', kind: 'rate', resetAt: 5 });
    expect(errorRecords('unauthorized', 'no')[0]).toMatchObject({ t: 'error', kind: 'auth' });
    expect(errorRecords('other', 'odd')[0]).toEqual({ t: 'error', kind: 'model', code: 'other', message: 'odd' });
  });
});
