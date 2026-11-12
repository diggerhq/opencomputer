// Where journals live, and how a file there is opened (work 084; one
// directory per session since work 103, C8):
//
//   <dataDir>/journals/                 02750, the host's
//     <cs_…>/                           02770, made by the host (ensureSessionJournalDir)
//       <cs_…>.jsonl                    the journal (journal.ts)
//       <cs_…>.jsonl.ckpt               its checkpoint (journal-checkpoint.ts)
//       <cs_…>.jsonl.results/<sa_…>     subagents' whole results (subagent-results.ts)
//
// A session's directory is the one thing of the journals its sandbox mounts,
// so a session sees and writes only its own.
//
// Invariants:
// - The host makes a session's directory, in a parent it can write; the
//   runner never does. Both write inside it: the directory is setgid and
//   group-writable and files are 0660, so the host (sp-host, in group agent)
//   and the runner (agent) open each other's files. Modes are set outright,
//   because mkdir's is masked by the umask and drops setgid; a chmod of a
//   directory another uid owns fails and is ignored.
// - What a session can write is never trusted to be what its name says
//   (103, trust rule 4): every open here is O_NOFOLLOW and the result must be
//   a regular file (`openRegular`; O_NONBLOCK so a planted FIFO cannot hold
//   the caller), and a session's directory must be a directory, not a link.
// - Readers list sessions by directory name (`listJournals`): a file directly
//   in `journals/` is not a journal (journal-flat-move.ts moves the old ones).

import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isSessionId } from '../session-ids.js';

export const JOURNALS_DIR = 'journals';

export class JournalError extends Error {
  constructor(
    readonly code: 'locked' | 'stale_epoch' | 'closed' | 'bad_id' | 'lock_failed' | 'not_regular',
    message: string,
  ) {
    super(message);
  }
}

/** The journal of `sessionId` in a journals directory: `<journals>/<sessionId>/<sessionId>.jsonl`. */
export const journalIn = (journals: string, sessionId: string) => path.join(journals, sessionId, `${sessionId}.jsonl`);

/** `<dataDir>/journals/<sessionId>/<sessionId>.jsonl`. Pure: `ensureSessionJournalDir` makes the directory. */
export function journalPath(dataDir: string, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new JournalError('bad_id', `not a session id: ${sessionId}`);
  return journalIn(path.join(dataDir, JOURNALS_DIR), sessionId);
}

function ensureDir(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true, mode });
  try {
    chmodSync(dir, mode);
  } catch {}
}

/** Create `<dataDir>/journals` (02750: only the host makes sessions' directories in it). Returns it. */
export function ensureJournalDir(dataDir: string): string {
  const dir = path.join(dataDir, JOURNALS_DIR);
  ensureDir(dir, 0o2750);
  return dir;
}

/** Create the directory of `sessionId`'s journal (02770: files keep its group). The host calls it before a journal is opened by anyone. Returns it. */
export function ensureSessionJournalDir(dataDir: string, sessionId: string): string {
  const dir = path.dirname(journalPath(dataDir, sessionId));
  ensureJournalDir(dataDir);
  ensureDir(dir, 0o2770);
  if (!lstatSync(dir).isDirectory()) throw new JournalError('not_regular', `not a directory: ${dir}`);
  return dir;
}

/** Every session with a directory in `journals` and where its journal is (the file may not exist). */
export function listJournals(journals: string): Array<{ sessionId: string; file: string }> {
  let names: string[];
  try {
    names = readdirSync(journals);
  } catch {
    return [];
  }
  return names.filter(isSessionId).map((sessionId) => ({ sessionId, file: journalIn(journals, sessionId) }));
}

/** The session a journal file belongs to by where it is: its directory's name, when that is a session id. */
export function sessionOfJournal(file: string): string | undefined {
  const name = path.basename(path.dirname(file));
  return isSessionId(name) ? name : undefined;
}

export const OPEN = {
  read: constants.O_RDONLY,
  /** Read and append, created when missing. */
  append: constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
  /** A new file to write; fails when the name is taken. */
  create: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
};

/** Open `file` without following a link at its name; throws unless it is a regular file. */
export function openRegular(file: string, flags: number, mode = 0o660): number {
  const fd = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  throw new JournalError('not_regular', `not a regular file: ${file}`);
}

/** The whole of a regular file (as `openRegular` takes it). */
export function readRegular(file: string): Buffer {
  const fd = openRegular(file, OPEN.read);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
