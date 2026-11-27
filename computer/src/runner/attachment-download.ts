// One attachment's bytes to disk. attachments.ts owns the rules (what is
// fetched, inlined or left for later, and the note the model reads); this file
// owns the transfer: a response streamed to `<file>.part` and renamed into
// place only when complete, so a file is there at all only when it is whole.
// Every chunk pushes the stall deadline back, so a slow but live download of a
// big file finishes while a stalled one does not hold up the message; the byte
// count holds the size cap whatever the source declared.
//
// A background download (the file arrives after the message went to the model)
// is tracked here: a failure leaves the reason in `<file>.error`, and a runner
// that exits interrupts every one (`interruptDownloads`), so the model never
// waits on a file nothing is downloading.
//
// Credentials never enter this file: `Open` is the source's own fetch, with its
// own headers and host rules (attachments.ts), and a Response is all it yields.

import { createWriteStream } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { log } from '../log.js';

export interface Limits {
  /** Largest file downloaded. */
  maxBytes: number;
  /** A download that sends nothing for this long is dropped. */
  stallMs: number;
  /** Files up to this size arrive before the message; larger ones download in the background. */
  waitBytes: number;
}

export const LIMITS: Limits = { maxBytes: 1024 * 1024 * 1024, stallMs: 60_000, waitBytes: 5 * 1024 * 1024 };

/** A source's fetch: resolves with a response whose body is the file (status checked), or throws the reason. */
export type Open = (signal: AbortSignal) => Promise<Response>;

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

/**
 * Downloads `file` in the background: settles when it is at `file` or `<file>.error` says why not. `name` labels the log line.
 */
export function background(open: Open, file: string, name: string, limits: Limits): Promise<void> {
  const stop = new AbortController();
  const pending = download(open, file, limits, stop.signal)
    .then(
      () => {},
      async (e) => {
        log.warn(`attachment ${name} failed: ${e?.message ?? e}`);
        await writeFile(`${file}.error`, `${e?.message ?? e}\n`).catch(() => {});
      },
    )
    .finally(() => inflight.delete(pending));
  inflight.set(pending, stop);
  return pending;
}

/** Streams one file to `<file>.part`, renames it to `file` and returns its size. */
export async function download(open: Open, file: string, limits: Limits, stop?: AbortSignal): Promise<number> {
  const abort = new AbortController();
  stop?.addEventListener('abort', () => abort.abort(stop.reason), { once: true });
  let stall: NodeJS.Timeout | undefined;
  const alive = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(new Error('download stalled')), limits.stallMs);
  };
  alive();
  try {
    const r = await open(abort.signal);
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
