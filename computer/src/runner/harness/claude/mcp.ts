// Calvin's tools (../../tools.ts) as the in-process `calvin` MCP server
// Claude Code is started with.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CalvinTools } from '../types.js';
import { calvinTools } from '../../tools.js';

export function calvinServer({ cwd, hooks, sendFile, postCard }: CalvinTools) {
  return createSdkMcpServer({
    name: 'calvin',
    tools: calvinTools(cwd, hooks, sendFile, postCard).map((t) =>
      tool(t.name, t.description, t.inputSchema, async (args, extra) => ({ ...(await t.handler(args, toolCall(extra))) }), t.alwaysLoad ? { alwaysLoad: true } : undefined),
    ),
  });
}

/** The tool call's id, which Claude Code sends in the request's `_meta`. */
function toolCall(extra: unknown) {
  const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.['claudecode/toolUseId'];
  return typeof id === 'string' ? { id } : undefined;
}
