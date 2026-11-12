// The one-off move of journals from the flat layout to a directory per session
// (work 103, C8). DELETED IN STEP 12 OF WORK 103 (this file and its calls in
// api-host.ts), once every computer has started a release with it.
//
//   journals/<id>.jsonl            ->  journals/<id>/<id>.jsonl
//   journals/<id>.jsonl.ckpt       ->  journals/<id>/<id>.jsonl.ckpt
//   journals/<id>.jsonl.results/   ->  journals/<id>/<id>.jsonl.results/
//
// Run by the host at start, before anything lists or reads a journal, and for
// one session before each open of its journal (adopt, the host's writer, mint).
//
// A runner that outlives the host's restart is the previous release's code. It
// holds the journal open (one descriptor, and the lock on it) and never opens
// it by name again, but it builds `<journal>.ckpt` and `<journal>.results/`
// from the flat name it was given at mint on every write, and nothing the host
// sends an attached runner makes it take another. So the host bends the flat
// names instead of reading two layouts:
// - results: while a writer holds the journal's lock, the flat `.results` is a
//   link to the nested directory, so what that runner saves lands where the
//   host reads. The link goes on the first pass that finds the lock free.
// - checkpoint: the runner replaces the flat name by rename, which no link
//   survives. A checkpoint is a cache checked against its journal by hash and
//   the journal only grows, so the older nested one stays right; the flat one
//   is taken on the next pass (the next open of the session, or host start).
//
// Invariants:
// - The journal moves by one rename (the inode stays, so that runner keeps
//   appending to the file it holds, and keeps its lock). Each pass moves
//   whatever is still flat: stopped anywhere and run again, it ends in the
//   same place; with nothing flat it does nothing.
// - Nothing of a journal is deleted. Where a session already has a nested
//   journal and a flat one appears (a release rolled back and forward), the
//   one further on by (epoch, last seq) is the journal and the other is kept
//   beside it as `<id>.jsonl.superseded`, which nothing reads.
// - A flat name that is a link the host did not make, or not the kind of file
//   its name says, is left where it is and never followed.
// - One session failing does not stop the others.

import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { ensureSessionJournalDir, journalPath, OPEN, openRegular } from '../api/journal-dir.js';
import { forgetJournalFile, readJournalFile } from '../api/journal.js';
import { log } from '../log.js';
import { isSessionId } from '../session-ids.js';

const FLAT = /^(.+)\.jsonl(|\.ckpt|\.ckpt\.tmp|\.results)$/;

const kindOf = (file: string) => {
  const st = lstatSync(file, { throwIfNoEntry: false });
  return !st ? undefined : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'other';
};

/** Whether a writer holds the journal's lock (journal-lock.ts). Unsure counts as held: the link then stays a pass longer. */
function held(journal: string): boolean {
  let fd: number;
  try {
    fd = openRegular(journal, OPEN.read);
  } catch {
    return false; // no journal: no writer
  }
  try {
    return spawnSync('/usr/bin/flock', ['-x', '-n', '-E', '75', '/dev/fd/3', 'true'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status !== 0;
  } finally {
    closeSync(fd);
  }
}

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

/** The newer checkpoint stays: a flat one written before the nested one (by a runner as it exited) is dropped. */
function moveCheckpoint(flat: string, nested: string): void {
  const have = lstatSync(nested, { throwIfNoEntry: false });
  if (have && have.mtimeMs > lstatSync(flat).mtimeMs) rmSync(flat, { force: true });
  else renameSync(flat, nested);
}

/**
 * Move what is flat of one session into its directory, and keep or drop the link for a runner from before the move
 * (see the header). Returns how many names it moved. Throws on the first name it cannot move.
 */
export function moveFlatSession(dataDir: string, sessionId: string): number {
  const nested = journalPath(dataDir, sessionId);
  const flat = path.join(dataDir, 'journals', `${sessionId}.jsonl`);
  const linkTo = path.join(sessionId, `${path.basename(nested)}.results`); // relative to journals/
  const kinds = ['', '.ckpt.tmp', '.ckpt', '.results'].map((part) => [part, kindOf(flat + part)] as const).filter(([, k]) => k !== undefined);
  if (!kinds.length) return 0;
  let moved = 0;
  let live: boolean | undefined;
  const writerLives = () => (live ??= held(nested));
  for (const [part, kind] of kinds) {
    const from = flat + part;
    if (part === '.results' && kind === 'link' && readlinkSync(from) === linkTo) {
      if (!writerLives()) rmSync(from, { force: true }); // that runner ended: nothing writes the flat name any more
      continue;
    }
    if (kind !== (part === '.results' ? 'dir' : 'file')) {
      log.warn(`journal move: ${from} is not a ${part === '.results' ? 'directory' : 'regular file'}, left in place`);
      continue;
    }
    ensureSessionJournalDir(dataDir, sessionId);
    if (part === '') moveJournal(from, nested);
    else if (part === '.ckpt.tmp') {
      if (!writerLives()) rmSync(from, { force: true }); // a checkpoint write that never finished (a live runner's may be under way)
      continue;
    } else if (part === '.ckpt') moveCheckpoint(from, nested + part);
    else moveResults(from, nested + part);
    moved++;
  }
  // A runner from before the move still writes: its results go through the flat name into the nested directory.
  if (moved && kindOf(`${flat}.results`) === undefined && writerLives()) {
    mkdirSync(`${nested}.results`, { recursive: true, mode: 0o770 });
    chmodSync(`${nested}.results`, 0o770); // as subagent-results.ts makes it: the runner is another uid of the group
    symlinkSync(linkTo, `${flat}.results`);
  }
  return moved;
}

/** Move every flat journal under `<dataDir>/journals` into its session's directory. Returns how many names it moved. */
export function moveFlatJournals(dataDir: string): number {
  let names: string[];
  try {
    names = readdirSync(path.join(dataDir, 'journals'));
  } catch {
    return 0;
  }
  const ids = new Set(names.flatMap((n) => FLAT.exec(n)?.[1] ?? []).filter(isSessionId));
  let moved = 0;
  for (const id of ids) moved += moveFlatSessionLogged(dataDir, id);
  if (moved) log.info(`journal move: ${moved} flat journal file(s) moved into their session's directory`);
  return moved;
}

/** `moveFlatSession`, a failure logged instead of thrown: the open that follows reads what did move. */
export function moveFlatSessionLogged(dataDir: string, sessionId: string): number {
  try {
    return moveFlatSession(dataDir, sessionId);
  } catch (e) {
    log.warn(`journal move: ${sessionId}: ${(e as Error).message}`);
    return 0;
  }
}
