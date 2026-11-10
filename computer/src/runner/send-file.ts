// send_file: the agent posts a file into its thread (a screenshot, a chart, a
// generated report), the way a person would drag one into the conversation.
// The runner offers it as an in-process MCP tool next to spawn_thread; the
// upload goes straight to Slack with the bot token (`files:write`).
//
// Only files under the session's workspace or the temp directory can be sent,
// so a prompt cannot talk the agent into posting host files such as
// credentials into a channel.

import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tool } from './tool.js';
import { z } from 'zod';

export const SEND_FILE_TOOL = 'mcp__calvin__send_file';
const MAX_BYTES = 100 * 1024 * 1024;
/** Bounds uploads per runner; a loop that posts files would flood the thread. */
const MAX_FILES = 50;

export interface FileUpload {
  path: string;
  filename: string;
  title?: string;
  comment?: string;
  altText?: string;
}

/** What a posted file was, for telemetry (work 063): never its name or content. */
export interface Posted {
  kind: 'image' | 'video' | 'pdf' | 'text' | 'other';
  bytes: number;
  source: 'tool' | 'script';
}

const KINDS: [Posted['kind'], RegExp][] = [
  ['image', /\.(png|jpe?g|gif|webp|svg|bmp)$/i],
  ['video', /\.(mp4|webm|mov|gif)$/i],
  ['pdf', /\.pdf$/i],
  ['text', /\.(txt|md|log|csv|json|ya?ml|html?)$/i],
];
export const kindOf = (file: string): Posted['kind'] => KINDS.find(([, re]) => re.test(file))?.[0] ?? 'other';

/** Resolves `file` to a real path inside one of `roots`, or throws why it cannot be sent. */
export async function checkSendable(cwd: string, file: string): Promise<{ abs: string; size: number }> {
  const abs = await realpath(path.resolve(cwd, file)).catch(() => {
    throw new Error(`no such file: ${file}`);
  });
  const roots = await Promise.all([cwd, os.tmpdir()].map((r) => realpath(r).catch(() => r)));
  if (!roots.some((r) => abs.startsWith(r + path.sep)))
    throw new Error(`only files inside the workspace (${cwd}) or ${os.tmpdir()} can be sent: ${file}`);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error(`not a regular file: ${file}`);
  if (st.size === 0) throw new Error(`file is empty: ${file}`);
  if (st.size > MAX_BYTES) throw new Error(`too large (${st.size} bytes, limit ${MAX_BYTES}): ${file}`);
  return { abs, size: st.size };
}

export interface SendArgs {
  path: string;
  comment?: string;
  title?: string;
  alt_text?: string;
}

/**
 * Posts one checked file; shared by the tool and the `calvin-send-file` command
 * (send-file-socket.ts), so both count against one limit. `leaks` names a secret
 * the file holds; `posted` reports each success (telemetry). Relative paths
 * resolve against `base`, the caller's directory. Never throws: every failure
 * is a reason the model or script can read.
 */
export function fileSender(
  cwd: string,
  upload: (f: FileUpload) => Promise<void>,
  leaks: (data: Buffer) => string | undefined = () => undefined,
  posted: (p: Posted) => void = () => {},
) {
  let sent = 0;
  return async ({ path: file, comment, title, alt_text }: SendArgs, base = cwd, source: Posted['source'] = 'tool'): Promise<{ ok: boolean; text: string }> => {
    const fail = (text: string) => ({ ok: false, text });
    if (sent >= MAX_FILES) return fail(`this session already sent ${MAX_FILES} files; ask the person before sending more`);
    sent++; // counted before the upload, so concurrent posts cannot pass the limit together
    try {
      const { abs, size } = await checkSendable(cwd, path.resolve(base, file.trim()));
      const leaked = leaks(await readFile(abs));
      if (leaked) return (sent--, fail(`the file contains the value of the secret $${leaked}; not posted`));
      await upload({ path: abs, filename: path.basename(abs), title, comment, altText: alt_text });
      posted({ kind: kindOf(abs), bytes: size, source });
      return { ok: true, text: `Posted ${path.basename(abs)} to the thread.` };
    } catch (e: any) {
      sent--;
      const code = e?.data?.error ?? e?.message ?? String(e);
      const hint = code === 'missing_scope' ? ' (the Slack app needs the files:write scope; reinstall it)' : '';
      return fail(`could not post the file: ${code}${hint}`);
    }
  };
}

export type FileSender = ReturnType<typeof fileSender>;

/** The tool over `send`. */
export function sendFileTool(send: FileSender) {
  return tool(
    'send_file',
    'Post a file into this Slack thread so the person sees it: an image (PNG, JPEG, GIF, WebP render inline), a PDF, a log, ' +
      'any file. Use it to show screenshots, rendered charts or diagrams, or generated artifacts. ' +
      'The file must be inside the workspace or the temp directory; save it there first. ' +
      'From a script that renders, `calvin-send-file <path> [comment]` posts the same way without a step of yours in between.',
    {
      path: z.string().describe('Path of the file, absolute or relative to the working directory'),
      comment: z.string().max(3000).optional().describe('Optional message posted with the file (Slack markdown)'),
      title: z.string().max(200).optional().describe('Optional title; defaults to the file name'),
      alt_text: z.string().max(1000).optional().describe('Optional description of an image, for screen readers'),
    },
    async (args) => {
      const r = await send(args);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
    { alwaysLoad: true },
  );
}
