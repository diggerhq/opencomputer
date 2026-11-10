// A tool Calvin serves to the model, in no harness's terms (work 082): its
// name, description and zod input shape, and a handler returning an MCP tool
// result. Each harness serves the list its own way: Claude Code as an
// in-process MCP server (harness/claude/mcp.ts), Codex as dynamic tools
// (harness/codex/serve.ts), through `jsonSchema` and `invoke` here, so both
// see the same schema and the same validation.

import { z } from 'zod';

/** What a tool call answers: MCP's text content, failed when `isError`. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface CalvinTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  handler(args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
  /** Always in the model's tool list, never deferred behind a tool search. */
  alwaysLoad?: boolean;
}

export function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  extras: { alwaysLoad?: boolean } = {},
): CalvinTool<S> {
  return { name, description, inputSchema, handler, ...extras };
}

/** The tool's input as JSON Schema, as an MCP server lists it. */
export function jsonSchema(t: CalvinTool): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(t.inputSchema), { io: 'input' }) as Record<string, unknown>;
  return schema;
}

/** Run the tool on input the model wrote: invalid input or a thrown handler is a failed result, never a throw. */
export async function invoke(t: CalvinTool, raw: unknown): Promise<ToolResult> {
  const parsed = z.object(t.inputSchema).safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return { content: [{ type: 'text', text: `Invalid arguments for tool ${t.name}: ${issues}` }], isError: true };
  }
  try {
    return await t.handler(parsed.data);
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error)?.message ?? String(e) }], isError: true };
  }
}
