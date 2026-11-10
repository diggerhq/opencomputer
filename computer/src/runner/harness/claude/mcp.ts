// Calvin's tools (../../tools.ts) as the in-process `calvin` MCP server
// Claude Code is started with.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CalvinTools } from '../types.js';
import { calvinTools } from '../../tools.js';

export function calvinServer({ cwd, hooks, sendFile, postCard }: CalvinTools) {
  return createSdkMcpServer({
    name: 'calvin',
    tools: calvinTools(cwd, hooks, sendFile, postCard).map((t) =>
      tool(t.name, t.description, t.inputSchema, async (args) => ({ ...(await t.handler(args)) }), t.alwaysLoad ? { alwaysLoad: true } : undefined),
    ),
  });
}
