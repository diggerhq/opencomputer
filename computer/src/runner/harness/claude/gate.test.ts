import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { GateAsk, GateDecision } from '../types.js';
import { claudeGate, gateKind } from './gate.js';

const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }];
const opts = (o: object = {}) => ({ signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1', suggestions, ...o });
const through = async (d: GateDecision, o: object = {}) => {
  let seen: GateAsk | undefined;
  const r = await claudeGate(async (_n, _i, ask) => ((seen = ask), d))('Bash', { command: 'ls' }, opts(o) as never);
  return { r, seen: seen! };
};

describe('claudeGate', () => {
  it('asks with the call id, the sentence, and whether an allow can be remembered', async () => {
    const { seen } = await through({ behavior: 'allow', updatedInput: {} }, { title: 'Claude wants to run ls', description: 'in ~' });
    expect(seen).toMatchObject({ id: 'tu1', kind: 'command', title: 'Claude wants to run ls', description: 'in ~', canRemember: true });
    expect((await through({ behavior: 'allow', updatedInput: {} }, { suppressAlwaysAllowRule: true })).seen.canRemember).toBe(false);
    expect((await through({ behavior: 'allow', updatedInput: {} }, { suggestions: [] })).seen.canRemember).toBe(false);
  });

  it("an allow; remembered, it hands back Claude Code's suggestions; with a mode, it sets the session's", async () => {
    expect((await through({ behavior: 'allow', updatedInput: { command: 'ls' } })).r).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect((await through({ behavior: 'allow', updatedInput: {}, remember: true })).r).toEqual({ behavior: 'allow', updatedInput: {}, updatedPermissions: suggestions });
    expect((await through({ behavior: 'allow', updatedInput: {}, mode: 'acceptEdits' })).r).toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('a deny, interrupting when asked to', async () => {
    expect((await through({ behavior: 'deny', message: 'no' })).r).toEqual({ behavior: 'deny', message: 'no' });
    expect((await through({ behavior: 'deny', message: 'stop', interrupt: true })).r).toEqual({ behavior: 'deny', message: 'stop', interrupt: true });
  });

  it('names the kind of call from the tool name', () => {
    expect(['Bash', 'Edit', 'Write', 'ExitPlanMode', 'AskUserQuestion', 'mcp__calvin__send_file'].map(gateKind)).toEqual([
      'command',
      'edit',
      'edit',
      'plan',
      'question',
      'tool',
    ]);
  });
});
