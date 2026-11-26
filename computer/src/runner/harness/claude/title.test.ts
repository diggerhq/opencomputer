import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { transcript } from './title.js';

const msg = (type: SessionMessage['type'], content: unknown, parent: string | null = null): SessionMessage =>
  ({ type, uuid: 'u', session_id: 's', message: { content }, parent_tool_use_id: parent, parent_agent_id: null }) as SessionMessage;

describe('transcript', () => {
  it('counts what people said; tool results, tool calls and subagents are not conversation', () => {
    const t = transcript([
      msg('user', 'fix the login page'),
      msg('assistant', [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1' }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      msg('user', 'inside a subagent', 'task-1'),
      msg('user', [{ type: 'text', text: 'and the signup page' }]),
    ]);
    expect(t.said).toBe(2);
    expect(t.text).toBe('Person: fix the login page\n\nAgent: On it.\n\nPerson: and the signup page');
  });

  it('is cut to a few thousand characters', () => {
    expect(transcript([msg('user', 'x'.repeat(10_000))]).text.length).toBe(4000);
  });
});
