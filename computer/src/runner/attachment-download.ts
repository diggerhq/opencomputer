// One attachment's bytes to disk. attachments.ts owns the rules (what is
// fetched, inlined or left for later, and the note the model reads); this file
// owns the transfer: a response streamed to `<file>.part` and renamed into
// place only when complete, so a file is there at all only when it is whole.
// Every chunk pushes the stall deadline back, so a slow but live download of a
// big file finishes while a stalled one does not hold up the message; the byte
// count holds the size cap whatever the source declared.
//
// Two requests for one file share one transfer (`transfer`, by path): the same
// attachment named by two messages, or a message and the restore at resume.
// A transfer that outlasts its message's wait goes on in the background
// (`later`): when it settles the caller is told, a failure also leaves the
// reason in `<file>.error`, and a success removes an `.error` an earlier try
// left. A runner that exits interrupts every transfer (`interruptDownloads`),
// so the model never waits on a file nothing is downloading.
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
  /** How long a message waits for its files; a download still running then goes on in the background. */
  waitMs: number;
  /** The bound on a session's attachment directory (attachment-dir.ts). */
  dirBytes: number;
}

const GIB = 1024 * 1024 * 1024;
export const LIMITS: Limits = { maxBytes: GIB, stallMs: 60_000, waitMs: 15_000, dirBytes: 5 * GIB };

/** A source's fetch: resolves with a response whose body is the file (status checked), or throws the reason. */
export type Open = (signal: AbortSignal) => Promise<Response>;

/** One file on its way to disk: `done` is its size once it is at its path. */
export interface Transfer {
  done: Promise<number>;
  stop: AbortController;
  /** Set once it went to the background: settles when the caller was told. */
  late?: Promise<void>;
  /** Settles when nothing of it is left to do. */
  settled: Promise<void>;
}

/** Transfers in flight, by the path each lands at. */
const inflight = new Map<string, Transfer>();

/** Whether `file` is being downloaded now. */
export const downloading = (file: string) => inflight.has(file);

/** Stops every transfer; each one in the background leaves `<path>.error` saying so. Resolves once they have. */
export async function interruptDownloads() {
  for (const t of inflight.values()) t.stop.abort(new Error('interrupted: the session stopped before the download finished; ask for the file again'));
  while (inflight.size) await Promise.all([...inflight.values()].map((t) => t.settled));
}

/** The transfer of `file`: the one in flight if there is one, else a new one from `open`. */
export function transfer(open: Open, file: string, limits: Limits): Transfer {
  const have = inflight.get(file);
  if (have) return have;
  const stop = new AbortController();
  const done = download(open, file, limits, stop.signal).then(async (bytes) => {
    await rm(`${file}.error`, { force: true }).catch(() => {}); // an earlier try's reason no longer holds
    return bytes;
  });
  const t: Transfer = { done, stop, settled: Promise.resolve() };
  t.settled = done
    .then(
      () => {},
      () => {},
    )
    .then(() => t.late)
    .finally(() => inflight.get(file) === t && inflight.delete(file));
  inflight.set(file, t);
  return t;
}

/**
 * `t` goes on in the background, once however many ask: when it settles `told` hears (with the reason, if it failed),
 * and a failure leaves the reason in `<file>.error` too. `name` labels the log line. Never rejects.
 */
export function later(t: Transfer, file: string, name: string, told: (error?: string) => void = () => {}): Promise<void> {
  const tell = (error?: string) => {
    try {
      told(error);
    } catch (e) {
      log.warn(`attachment ${name}: the note was not delivered:`, e);
    }
  };
  t.late ??= t.done.then(
    () => tell(),
    async (e) => {
      const error = String(e?.message ?? e);
      log.warn(`attachment ${name} failed: ${error}`);
      await writeFile(`${file}.error`, `${error}\n`).catch(() => {});
      tell(error);
    },
  );
  return t.late;
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
