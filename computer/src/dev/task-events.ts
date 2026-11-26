// Prints the SDK's task_* system events for a prompt, to see what subagents report.
//   npx tsx src/dev/task-events.ts "<prompt>"
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const t0 = Date.now();
const q = query({
  prompt: process.argv[2] ?? 'Spawn one subagent that runs `ls` and reports the file count.',
  options: {
    cwd: mkdtempSync(path.join(os.tmpdir(), 'task-events-')),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    agentProgressSummaries: true,
    settingSources: [],
  },
});
for await (const m of q) {
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (m.type === 'system' && m.subtype !== 'init') console.log(`+${s}s`, JSON.stringify(m).slice(0, 700));
  else if (m.type === 'result') console.log(`+${s}s RESULT`, m.subtype);
  else if (m.type === 'assistant' && !m.parent_tool_use_id)
    for (const b of m.message.content as any[]) if (b.type === 'tool_use') console.log(`+${s}s tool_use`, b.name, b.id);
}
