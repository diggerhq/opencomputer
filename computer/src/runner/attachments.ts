// Files attached to Slack messages. Each one is downloaded with the bot token
// into a per-session temp directory (outside the repo, so it never shows in a
// diff); images also go to the model inline, the way a pasted screenshot does
// in the terminal. The model can open anything else from its path with Read.
// Downloads stream to disk, so a large screen recording costs no memory; only
// images small enough to inline are read back into memory.
//
// Small files arrive before the message goes to the model. Larger ones (or ones
// Slack gives no size for) download in the background so a big video does not
// hold up the reply: the model gets the path at once, the file appears there
// only when complete (it is written to `<path>.part` and renamed), and a
// failure leaves the reason in `<path>.error`. A runner that exits interrupts
// its background downloads, so the model never waits on a file nothing is
// downloading. (An idle exit comes hours after the last message; a download
// stalls out in a minute.)

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { log } from '../log.js';
import type { SlackFile } from '../protocol.js';

export type { SlackFile };

export interface Attachment {
  name: string;
  path: string;
  mimetype: string;
  image?: { media_type: string; data: string };
  /** Why the download failed; set only when `path` is empty. */
  error?: string;
  /** Set while the file downloads in the background; settles when it is at `path` or `<path>.error` is written. */
  pending?: Promise<void>;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024; // API limit per image

export interface Limits {
  /** Largest file downloaded; Slack's own upload limit. */
  maxBytes: number;
  /** A download that sends nothing for this long is dropped. */
  stallMs: number;
  /** Files up to this size arrive before the message; larger ones download in the background. */
  waitBytes: number;
}
/** Background downloads in flight, with the controller that interrupts each. */
const inflight = new Map<Promise<void>, AbortController>();

/** Resolves once no background download is in flight. */
async function downloadsSettled() {
  while (inflight.size) await Promise.all(inflight.keys());
}

/** Stops every background download; each leaves `<path>.error` saying so. Resolves once they have. */
export function interruptDownloads() {
  for (const c of inflight.values()) c.abort(new Error('interrupted: the session stopped before the download finished; ask for the file again'));
  return downloadsSettled();
}

const LIMITS: Limits = { maxBytes: 1024 * 1024 * 1024, stallMs: 60_000, waitBytes: 5 * 1024 * 1024 };

export async function fetchAttachments(files: SlackFile[] | undefined, token: string | undefined, sessionKey: string, limits = LIMITS) {
  if (!files?.length) return [];
  const dir = path.join(os.tmpdir(), 'slack-presence', sessionKey.replace(/[^a-zA-Z0-9]+/g, '-'));
  await mkdir(dir, { recursive: true });
  const out: Attachment[] = [];
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private;
    const name = path.basename(f.name ?? f.id);
    try {
      if (!url || !token) throw new Error('no download URL or token');
      if ((f.size ?? 0) > limits.maxBytes) throw new Error(`too large (${f.size} bytes)`);
      const file = path.join(dir, `${f.id}-${name}`);
      const mimetype = f.mimetype ?? 'application/octet-stream';
      if (f.size === undefined || f.size > limits.waitBytes) {
        const stop = new AbortController();
        const pending = download(url, token, file, mimetype, limits, stop.signal)
          .then(
            () => {},
            async (e) => {
              log.warn(`attachment ${name} failed: ${e?.message ?? e}`);
              await writeFile(`${file}.error`, `${e?.message ?? e}\n`).catch(() => {});
            },
          )
          .finally(() => inflight.delete(pending));
        inflight.set(pending, stop);
        out.push({ name, path: file, mimetype, pending });
        continue;
      }
      const bytes = await download(url, token, file, mimetype, limits);
      out.push({
        name,
        path: file,
        mimetype,
        ...(IMAGE_TYPES.has(mimetype) && bytes <= MAX_INLINE_IMAGE
          ? { image: { media_type: mimetype, data: (await readFile(file)).toString('base64') } }
          : {}),
      });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      log.warn(`attachment ${name} failed: ${error}`);
      out.push({ name, path: '', mimetype: f.mimetype ?? '?', error });
    }
  }
  return out;
}

/**
 * Streams one Slack file to `<file>.part`, renames it to `file` and returns its size. Every chunk pushes the
 * stall deadline back, so a slow but live download of a big file finishes while
 * a stalled one does not hold up the message. Slack's declared size is checked
 * before the call; the byte count holds the cap when it is missing or wrong.
 */
async function download(url: string, token: string, file: string, mimetype: string, limits: Limits, stop?: AbortSignal) {
  const abort = new AbortController();
  stop?.addEventListener('abort', () => abort.abort(stop.reason), { once: true });
  let stall: NodeJS.Timeout | undefined;
  const alive = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(new Error('download stalled')), limits.stallMs);
  };
  alive();
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // Without files:read Slack answers with its HTML login page instead of the file.
    if ((r.headers.get('content-type') ?? '').startsWith('text/html') && mimetype !== 'text/html')
      throw new Error('got an HTML page (missing files:read scope?)');
    if (!r.body) throw new Error('empty response');
    let bytes = 0;
    const part = `${file}.part`;
    const sink = createWriteStream(part);
    try {
      await pipeline(
        Readable.fromWeb(r.body as WebReadableStream),
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            if (bytes > limits.maxBytes) throw new Error(`too large (over ${limits.maxBytes} bytes)`);
            alive();
            yield chunk;
          }
        },
        sink,
      );
    } catch (e) {
      // The sink may still be opening the file; delete it only once it is closed.
      if (!sink.closed) await new Promise((done) => sink.once('close', done));
      await rm(part, { force: true });
      throw e;
    }
    await rename(part, file);
    return bytes;
  } finally {
    clearTimeout(stall);
    abort.abort(); // releases the connection when we stopped early
  }
}

/** Message content for the SDK: the user's text, a note per file, and inline images. */
export function userContent(text: string, atts: Attachment[]) {
  if (!atts.length) return text;
  const notes = atts.map((a) =>
    !a.path
      ? `[attached ${a.name}: could not be downloaded${a.error ? ` (${a.error})` : ''}]`
      : a.pending
        ? `[attached file ${a.name} (${a.mimetype}) downloading to ${a.path}: it appears there when complete; if the download fails, ${a.path}.error says why]`
        : `[attached ${a.image ? 'image' : 'file'} ${a.name} (${a.mimetype}) saved at ${a.path}]`,
  );
  return [
    { type: 'text' as const, text: [text, ...notes].filter(Boolean).join('\n') },
    ...atts.flatMap((a) =>
      a.image ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: a.image.media_type as any, data: a.image.data } }] : [],
    ),
  ];
}
