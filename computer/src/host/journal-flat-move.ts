// The one-off move of journals from the flat layout to a directory per session
// (work 103, C8). DELETED IN STEP 12 OF WORK 103, once every computer has
// started a release with it.
//
//   journals/<id>.jsonl            ->  journals/<id>/<id>.jsonl
//   journals/<id>.jsonl.ckpt       ->  journals/<id>/<id>.jsonl.ckpt
//   journals/<id>.jsonl.results/   ->  journals/<id>/<id>.jsonl.results/
//
// Run by the host at start, before anything lists or reads a journal.
//
// Invariants:
// - Every step is one rename (the inode stays, so a runner that outlived the
//   host keeps appending to the file it holds open, and keeps its lock), and
//   each pass moves whatever is still flat: stopped anywhere and run again, it
//   ends in the same place; with nothing flat it does nothing.
// - Nothing of a journal is deleted. Where a session already has a nested
//   journal and a flat one appears (a runner from before the move that opened
//   its path again, or a release rolled back and forward), the one further on
//   by (epoch, last seq) is the journal and the other is kept beside it as
//   `<id>.jsonl.superseded`, which nothing reads.
// - A flat name that is a link, or not the kind of file its name says, is left
//   where it is and never followed. A checkpoint is a cache checked against
//   its journal by hash, so the flat one simply replaces the nested one.
// - One session failing does not stop the others.

import { lstatSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ensureSessionJournalDir, journalPath } from '../api/journal-dir.js';
import { forgetJournalFile, readJournalFile } from '../api/journal.js';
import { log } from '../log.js';
import { isSessionId } from '../session-ids.js';

const FLAT = /^(.+)\.jsonl(|\.ckpt|\.ckpt\.tmp|\.results)$/;

const kindOf = (file: string) => {
  const st = lstatSync(file, { throwIfNoEntry: false });
  return !st ? undefined : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
};

/** Further on: the higher epoch, then the higher last seq. */
function ahead(a: string, b: string): boolean {
  const [x, y] = [a, b].map((f) => readJournalFile(f, Number.MAX_SAFE_INTEGER, 0));
  forgetJournalFile(a);
  forgetJournalFile(b);
  return x.epoch !== y.epoch ? x.epoch > y.epoch : x.lastSeq > y.lastSeq;
}

function moveJournal(flat: string, nested: string): void {
  const aside = `${nested}.superseded`;
  if (kindOf(nested) !== undefined) {
    if (!ahead(flat, nested)) {
      renameSync(flat, aside);
      return;
    }
    renameSync(nested, aside);
  }
  renameSync(flat, nested);
}

function moveResults(flat: string, nested: string): void {
  if (kindOf(nested) === undefined) {
    renameSync(flat, nested);
    return;
  }
  for (const n of readdirSync(flat)) renameSync(path.join(flat, n), path.join(nested, n));
  rmdirSync(flat);
}

/** Move every flat journal under `<dataDir>/journals` into its session's directory. Returns how many names it moved. */
export function moveFlatJournals(dataDir: string): number {
  const dir = path.join(dataDir, 'journals');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let moved = 0;
  for (const name of names) {
    const m = FLAT.exec(name);
    if (!m || !isSessionId(m[1])) continue;
    const [, sessionId, part] = m;
    const flat = path.join(dir, name);
    try {
      const kind = kindOf(flat);
      if (kind !== (part === '.results' ? 'dir' : 'file')) {
        log.warn(`journal move: ${flat} is not a ${part === '.results' ? 'directory' : 'regular file'}, left in place`);
        continue;
      }
      if (part === '.ckpt.tmp') {
        rmSync(flat, { force: true }); // a checkpoint write that never finished
        continue;
      }
      ensureSessionJournalDir(dataDir, sessionId);
      const nested = journalPath(dataDir, sessionId) + part;
      if (part === '') moveJournal(flat, nested);
      else if (part === '.results') moveResults(flat, nested);
      else renameSync(flat, nested);
      moved++;
    } catch (e) {
      log.warn(`journal move: ${flat}: ${(e as Error).message}`);
    }
  }
  if (moved) log.info(`journal move: ${moved} flat journal file(s) moved into their session's directory`);
  return moved;
}
