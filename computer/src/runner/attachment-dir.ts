// Where a session's attachments live, and the bound on it. The directory is
// `~/attachments/<session-key>`: on the home volume, which is all of a sandbox
// that outlives its container (host/sandbox/podman-args.ts mounts it at
// /home/agent; /tmp is the container's own and goes with it), so a path the
// conversation named still holds the file after the container is recreated.
// It is outside every repository, so a file never shows in a diff.
//
// The bound: a long session's files would otherwise fill the volume. When the
// directory holds more than the cap, the files a message named longest ago go
// first (a file's mtime is the last time a message named it: `touch`), never
// one of the message being handled or one still downloading. An evicted API
// attachment comes back at the next resume (attachments.ts `restoreAttachments`);
// an evicted Slack file does not, and the model finds nothing at its path.
// The check runs when a message brings files, so a background download that
// lands later is counted at the next one.

import { readdir, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

/** Every session's attachments on this machine. */
export const attachmentsRoot = (home = os.homedir()) => path.join(home, 'attachments');

/** One session's attachments. */
export const attachmentsDir = (sessionKey: string, home?: string) => path.join(attachmentsRoot(home), sessionKey.replace(/[^a-zA-Z0-9]+/g, '-'));

/** A message named `file` again: it is the most recently used. */
export const touch = (file: string) => {
  const now = new Date();
  return utimes(file, now, now).catch(() => {});
};

interface Held {
  file: string;
  bytes: number;
  mtimeMs: number;
}

/** The files in `dir` with their sizes; a missing directory holds none. */
async function held(dir: string): Promise<Held[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const all = await Promise.all(
    names.map(async (n) => {
      const file = path.join(dir, n);
      const s = await stat(file).catch(() => undefined);
      return s?.isFile() ? { file, bytes: s.size, mtimeMs: s.mtimeMs } : undefined;
    }),
  );
  return all.filter((h) => h !== undefined);
}

/** The bytes `dir` holds now. */
export const usage = async (dir: string) => (await held(dir)).reduce((n, h) => n + h.bytes, 0);

/**
 * Holds `dir` to `maxBytes`: removes the `.part` of a download nothing is running (a runner that died left it), then,
 * while over the cap, the least recently named files outside `keep`. `busy` says whether a path is downloading now.
 */
export async function evict(dir: string, keep: Set<string>, maxBytes: number, busy: (file: string) => boolean) {
  let total = 0;
  const idle: Held[] = [];
  for (const h of await held(dir)) {
    if (h.file.endsWith('.part')) {
      if (busy(h.file.slice(0, -'.part'.length))) total += h.bytes;
      else await rm(h.file, { force: true });
      continue;
    }
    total += h.bytes;
    if (!keep.has(h.file) && !h.file.endsWith('.error')) idle.push(h);
  }
  for (const h of idle.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    await rm(h.file, { force: true });
    total -= h.bytes;
    log.info(`attachments: evicted ${path.basename(h.file)} (${h.bytes} bytes) to stay under ${maxBytes}`);
  }
}
