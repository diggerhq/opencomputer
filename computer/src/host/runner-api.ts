// A runner's API (work 084): what makes a runner the session's writer. The
// host mints a `RunnerApi` for each launch and claim of a session with a `cs_`
// id (its journal, epoch, lastSeq, an API socket next to the runner's control
// socket, a random token), and keeps it, so a restarted host can dial the
// runners it rediscovers.
//
// Invariants:
// - A runner's API socket is `<runners>/<runner id>.api.sock`; the host's own
//   session-writer listens on `<runners>/<cs_ id>.api.sock` (a `cs_` id never
//   looks like a runner's hex id). rediscover (runner-sockets.ts) skips both.
// - The token is 32 random bytes, one per launch or claim; it is kept in a
//   0600 file in a 0700 directory of the host's own (never the runners'), and
//   forgotten when its runner exits.
// - A runner reporting running subagents is not idle (subagentsRunning).
// - runners.json (run state, read back once when a restarted host builds this)
//   is written off the host loop: one async tmp-write-and-rename at a time,
//   sets and deletes meanwhile coalesce into the next one. A write still due
//   when the process exits is done synchronously in its `exit` handler, so
//   only a kill or a power loss in the few ms of a write loses the latest
//   change (that runner is then not re-dialed by the next host, as for a
//   runner that died with it).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunnerApi, SessionReport } from '../protocol.js';
import { RUNNERS_DIR } from '../ipc.js';

/** The suffix of every API socket; rediscover skips these. */
export const API_SOCK = '.api.sock';
export const apiSocketFor = (name: string, dir = RUNNERS_DIR) => path.join(dir, `${name}${API_SOCK}`);
export const mintToken = () => randomBytes(32).toString('base64url');

/** Stores with a write still due, flushed synchronously when the process exits. */
const unsaved = new Set<() => void>();
let exitHooked = false;

/** Every live runner's RunnerApi by runner id, on disk. */
export function runnerApis(file: string) {
  let all: Record<string, RunnerApi> = {};
  try {
    all = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  /** A change not yet on its way to disk; a write in flight. */
  let dirty = false;
  let writing: Promise<void> | undefined;
  const flushSync = () => {
    unsaved.delete(flushSync);
    dirty = false;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.sync.tmp`, JSON.stringify(all), { mode: 0o600 });
      renameSync(`${file}.sync.tmp`, file);
    } catch {}
  };
  const write = async () => {
    while (dirty) {
      dirty = false;
      const text = JSON.stringify(all);
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(`${file}.tmp`, text, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      } catch {}
    }
    unsaved.delete(flushSync);
    writing = undefined;
  };
  const save = () => {
    dirty = true;
    unsaved.add(flushSync);
    if (!exitHooked) {
      exitHooked = true;
      process.once('exit', () => {
        for (const f of [...unsaved]) f();
      });
    }
    writing ??= write();
  };
  return {
    /** Resolves when what was set so far is on disk (tests). */
    settled: async () => {
      while (writing) await writing;
    },
    get: (runnerId: string): RunnerApi | undefined => all[runnerId],
    set(runnerId: string, api: RunnerApi) {
      all[runnerId] = api;
      save();
    },
    delete(runnerId: string) {
      if (!(runnerId in all)) return;
      delete all[runnerId];
      save();
    },
    /** Keep only these runners' (after rediscovery: the others died with the previous host's runs). */
    retain(live: Set<string>) {
      const before = Object.keys(all).length;
      all = Object.fromEntries(Object.entries(all).filter(([id]) => live.has(id)));
      if (Object.keys(all).length !== before) save();
    },
  };
}

export type RunnerApis = ReturnType<typeof runnerApis>;

/**
 * Whether a runner reports running subagents, which keep it from idle exit
 * (background ones outlive their turn). An older runner (absent) has none.
 */
export function subagentsRunning(report: SessionReport | undefined): boolean {
  return (report?.subagents ?? 0) > 0;
}
