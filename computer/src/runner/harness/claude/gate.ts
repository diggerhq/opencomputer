// Calvin's gate (../types.ts) as Claude Code's canUseTool: the ask from its
// options, the decision as a PermissionResult. Remembering an allow is Claude
// Code's own suggestion of rules, handed back as it came.

import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { Gate, GateKind } from '../types.js';

/** What kind of call a Claude Code tool name is. */
export function gateKind(name: string): GateKind {
  if (name === 'Bash') return 'command';
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return 'edit';
  if (name === 'ExitPlanMode') return 'plan';
  return name === 'AskUserQuestion' ? 'question' : 'tool';
}

export function claudeGate(gate: Gate): CanUseTool {
  return async (name, input, o): Promise<PermissionResult> => {
    const d = await gate(name, input, {
      id: o.toolUseID,
      kind: gateKind(name),
      signal: o.signal,
      title: o.title,
      description: o.description,
      canRemember: !!o.suggestions?.length && !o.suppressAlwaysAllowRule,
    });
    if (d.behavior === 'deny') return { behavior: 'deny', message: d.message, ...(d.interrupt ? { interrupt: true } : {}) };
    const updatedPermissions: PermissionUpdate[] | undefined = d.mode
      ? [{ type: 'setMode', mode: d.mode, destination: 'session' }]
      : d.remember
        ? o.suggestions
        : undefined;
    return { behavior: 'allow', updatedInput: d.updatedInput, ...(updatedPermissions ? { updatedPermissions } : {}) };
  };
}
