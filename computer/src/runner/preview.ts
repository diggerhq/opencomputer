// preview and unpreview (work 074): a session gives a server it started a
// public URL on opencomputer.app, and takes it down. The request goes
// runner → host → gateway, which registers the name and answers; the host
// then waits for the port to answer (host/preview-probe.ts) before the tool
// returns, so the URL works when the model pastes it.
//
// The tool result is JSON, `{ url, listening, hint? }`; a refusal (a name
// taken, previews not ready) is a tool error carrying the gateway's sentence.

import { tool } from './tool.js';
import { z } from 'zod';
import type { PreviewRequest, PreviewToolResult } from '../protocol.js';

export const PREVIEW_TOOL = 'mcp__calvin__preview';

/** What the process hosting the session wires: the host and gateway answer both. */
export interface PreviewHooks {
  preview(req: PreviewRequest): Promise<PreviewToolResult>;
  unpreview(name: string): Promise<void>;
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });
const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function previewTools(hooks: PreviewHooks) {
  const preview = tool(
    'preview',
    'Give an HTTP server running here a public URL on opencomputer.app: call it right after starting a dev server or any HTTP server the person should see, and say the URL in the thread.\n' +
      'Anyone who has the URL can open it, and it works only while the server runs; plain HTTP on the port only (no TLS, no other protocols).',
    {
      port: z.number().int().min(1).max(65535).describe('The port the server listens on (on localhost)'),
      name: z
        .string()
        .optional()
        .describe('A chosen name, one DNS label (lowercase letters, digits, hyphens), which anyone can guess. Omit for a generated one, or the port\'s existing one'),
    },
    async ({ port, name }) => {
      const n = name?.trim();
      if (n && !NAME.test(n)) return text(`\`${n}\` is not a valid name: one DNS label of lowercase letters, digits and hyphens`, true);
      try {
        const r = await hooks.preview({ port, ...(n && { name: n }) });
        return text(JSON.stringify({ url: r.url, name: r.name, listening: r.listening, ...(r.hint && { hint: r.hint }) }));
      } catch (e) {
        return text(errorOf(e), true);
      }
    },
    { alwaysLoad: true },
  );
  const unpreview = tool(
    'unpreview',
    'Take down a public preview URL by its name (the label before .opencomputer.app), when the person asks or its server is gone for good.\n' +
      'Only this organization\'s names; the URL stops working within seconds.',
    { name: z.string().describe('The preview\'s name, e.g. `demo` for https://demo.opencomputer.app') },
    async ({ name }) => {
      try {
        await hooks.unpreview(name.trim());
        return text('{}');
      } catch (e) {
        return text(errorOf(e), true);
      }
    },
    { alwaysLoad: true },
  );
  return [preview, unpreview];
}
