// The hello's listing of the journals on this host's disk (work 084): for each
// session directory, its journal's epoch, the epoch's first seq and the last
// seq, so the gateway sends `epoch` where the log is ahead.
//
// Invariants:
// - A hello goes out per gateway connect: a file unchanged since the last
//   (inode, size, mtime) is not read again (past journal-file.ts's 512 files
//   its least recently read state is gone and each hello would rescan them,
//   084 perf fix 6).
// - Only `journals/<id>/<id>.jsonl` is a journal (journal-dir.ts), and only
//   when it is a regular file: the stat does not follow a link (work 103).

import { lstatSync } from 'node:fs';
import { listJournals } from '../api/journal-dir.js';
import { readJournalFile } from '../api/journal.js';
import type { JournalReport } from '../protocol.js';

/** A lister over `journals`; `epochOf` is the epoch the host holds for a session, when it is ahead of the file's. */
export function journalReports(journals: string, epochOf: (sessionId: string) => number | undefined): () => JournalReport[] {
  /** The last hello's view, by session. */
  let onDisk = new Map<string, { stat: string; report: JournalReport | null }>();
  return () => {
    const seen = new Map<string, { stat: string; report: JournalReport | null }>();
    for (const { sessionId, file } of listJournals(journals)) {
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      const stat = `${st.ino}:${st.size}:${st.mtimeMs}`;
      const was = onDisk.get(sessionId);
      if (was?.stat === stat) {
        seen.set(sessionId, was);
        continue;
      }
      const { epoch, startSeq, lastSeq } = readJournalFile(file, Number.MAX_SAFE_INTEGER, 0);
      // Epoch 0 with events: an adoption into a new file torn before its epoch line (the gateway resends `epoch`).
      const report = epoch ? { sessionId, epoch, startSeq, lastSeq } : lastSeq ? { sessionId, epoch: 0, startSeq: 0, lastSeq } : null;
      seen.set(sessionId, { stat, report });
    }
    onDisk = seen;
    return [...seen.values()].flatMap(({ report: r }) => (!r ? [] : !r.epoch ? [r] : [{ ...r, epoch: Math.max(r.epoch, epochOf(r.sessionId) ?? 0) }]));
  };
}
