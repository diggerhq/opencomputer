// The host's record of a thread's sandbox (work 103, C2): one file per
// thread, `$SP_DATA/state/sandboxes/<id>.json`, in a directory only the host
// can read. It says which container, volume and run directory (all named by
// `id`) belong to which person's thread.
//
// Invariants:
// - What the host knows of a sandboxed thread comes from here, never from the
//   workspace, the runner's report or a socket's name (trust rule 2).
// - Written whole to a temporary file and renamed; all read into memory when
//   the store is opened (host start). Deleted only when the thread is pruned.
// - At most one record per person and key: `find` is how a thread gets its
//   sandbox back.
// - A record's file that is there but did not load is still a record of its
//   id: `unread` names it, and whoever removes what has no record (sweep.ts)
//   asks it too. Which thread it was is not known, so a start refuses a
//   thread that has files and no record while there is one (start.ts).

import path from 'node:path';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { log } from '../../log.js';

export interface SandboxRecord {
  /** The runner id: the suffix of the container, the volume and the run directory. */
  id: string;
  /** `person.dir`. */
  person: string;
  /** The session key, as `SessionSpec.key`. */
  key: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601; set at every start. */
  usedAt: string;
  /** The fork's repositories (`ForkInfo.repos`). Absent until they were first added. */
  repos?: Record<string, { branch: string; from: string; base: string; fetchError?: string }>;
  /**
   * Step 10: the container under this id was a spare, bound to the thread, and its claim is not known to have been answered
   * (spares.ts). Whatever is under this id is then not the thread's runner: it is never taken back and never started again;
   * the thread's next start removes it, home and all, and creates anew (start.ts). Gone once the claim was answered.
   */
  unclaimed?: true;
}

export interface Records {
  all(): SandboxRecord[];
  get(id: string): SandboxRecord | undefined;
  find(person: string, key: string): SandboxRecord | undefined;
  /** Replace the record with this id, on disk and in memory. */
  write(r: SandboxRecord): void;
  delete(id: string): void;
  /** The ids whose file is there and is not a record that loaded: nothing of theirs is anyone's to remove. */
  unread(): string[];
}

const ID = /^[0-9a-f]{16}$/;
const valid = (r: Partial<SandboxRecord> | null, id: string): r is SandboxRecord =>
  !!r && r.id === id && typeof r.person === 'string' && typeof r.key === 'string' && typeof r.createdAt === 'string' && typeof r.usedAt === 'string';

/** The records in `dir` (`$SP_DATA/state/sandboxes`), read now. A file that is not a record is logged, left alone and counted (`unread`). */
export function sandboxRecords(dir: string): Records {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const byId = new Map<string, SandboxRecord>();
  const unread = new Set<string>();
  for (const f of readdirSync(dir)) {
    const id = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || !ID.test(id)) continue; // a temporary file a killed host left, or not ours
    try {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      if (!valid(r, id)) throw new Error('not a sandbox record');
      byId.set(id, r);
    } catch (e) {
      unread.add(id);
      log.warn(`sandbox record ${f} not read: ${(e as Error)?.message ?? e}; its container and home are kept`);
    }
  }
  const file = (id: string) => {
    if (!ID.test(id)) throw new Error(`bad sandbox id: ${id}`);
    return path.join(dir, `${id}.json`);
  };
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    find: (person, key) => [...byId.values()].find((r) => r.person === person && r.key === key),
    write(r) {
      const to = file(r.id);
      const tmp = `${to}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(r, null, 1) + '\n', { mode: 0o600 });
      renameSync(tmp, to);
      byId.set(r.id, r);
      unread.delete(r.id);
    },
    delete(id) {
      rmSync(file(id), { force: true });
      byId.delete(id);
      unread.delete(id);
    },
    unread: () => [...unread],
  };
}
