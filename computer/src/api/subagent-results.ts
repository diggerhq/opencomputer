// Subagents' whole results (084 perf fix 7). `subagent.ended` carries the
// first 8 KiB of a subagent's result (`resultTruncated`); the whole of a longer
// one is a file beside the journal, `<journal>.results/<sa_id>`, which
// `subagents.get` reads, whichever process writes the session now.
//
// Invariants:
// - Written by the journal's lock holder, redacted as the journal's events
//   are, before the `subagent.ended` naming it is appended: an event that says
//   truncated has its whole result on disk, unless the write failed (then
//   `subagents.get` answers the 8 KiB, as for a result written by an older
//   build).
// - Whole or absent: a temp file renamed over, 0660 in a 0770 directory like
//   the journal, as the runner and the host's writer run as different users.
// - Never in memory past the call that reads it; never deleted (journals are not).

import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { isId } from '../session-ids.js';
import { OPEN, openRegular, readRegular } from './journal-dir.js';

const dirOf = (journal: string) => `${journal}.results`;

export function saveResult(journal: string, subagentId: string, text: string): void {
  if (!isId('sa', subagentId)) throw new Error(`not a subagent id: ${subagentId}`);
  const dir = dirOf(journal);
  mkdirSync(dir, { recursive: true, mode: 0o770 });
  try {
    chmodSync(dir, 0o770); // the umask may have masked the group bits
  } catch {} // made by the other writer, who owns it
  if (!lstatSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`); // a link planted in the session's directory (journal-dir.ts)
  const file = path.join(dir, subagentId);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openRegular(tmp, OPEN.create);
  try {
    try {
      fchmodSync(fd, 0o660);
    } catch {}
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** The whole result of `subagentId`, if it is on disk. */
export function loadResult(journal: string, subagentId: string): string | undefined {
  if (!isId('sa', subagentId)) return undefined;
  try {
    return readRegular(path.join(dirOf(journal), subagentId)).toString('utf8');
  } catch {
    return undefined;
  }
}
