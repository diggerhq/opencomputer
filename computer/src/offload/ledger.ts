// The offload service's job ledger (work 136): JSON lines in its
// StateDirectory (`jobs.jsonl`), one whole row per change, the last row of an
// id winning. What the reaper trusts: a MicroVM is live only while a row says so.
//
// Invariants:
// - A job's row is written, and fsynced, before RunMicrovm is called, so a
//   crash between the two leaves a row the reaper can match by job tag or
//   deadline (and the clientToken makes a retry the same MicroVM).
// - Opening compacts: one row per id, terminal rows older than 7 days dropped,
//   written to a temporary file and renamed.
// - A line that does not parse (a torn last write) is skipped and counted, never fatal.

import path from 'node:path';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { type Fence, type JobState, type OffloadSize, TERMINAL } from '../offload-protocol.js';

export interface JobRow {
  id: string;
  fence: Fence;
  state: JobState;
  size: OffloadSize;
  cmd: string;
  artifacts: string[];
  /** The job's limit in minutes, already capped. */
  minutes: number;
  sourceBytes: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Unix ms after which the MicroVM is the reaper's whatever the state says. Set when it is launched. */
  deadline?: number;
  microvmId?: string;
  exitCode?: number;
  error?: string;
  artifactSha256?: string;
  artifactBytes?: number;
  agentState?: string;
}

const KEEP_MS = 7 * 24 * 3600_000;

export interface Ledger {
  get(id: string): JobRow | undefined;
  all(): JobRow[];
  /** Write the row whole; `sync`: fsync before returning (before RunMicrovm). */
  put(r: JobRow, sync?: boolean): void;
  /** Lines skipped at open. */
  skipped: number;
  close(): void;
}

/** The rows of the ledger in `dir`, last per id, read without writing (the reaper's, beside a running service); and lines skipped. */
export function readLedger(dir: string): { rows: Map<string, JobRow>; skipped: number } {
  const file = path.join(dir, 'jobs.jsonl');
  const rows = new Map<string, JobRow>();
  let skipped = 0;
  if (!existsSync(file)) return { rows, skipped };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as JobRow;
      if (typeof r?.id !== 'string' || typeof r.state !== 'string' || typeof r.fence !== 'object') throw new Error('not a row');
      rows.set(r.id, r);
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

/** The service's ledger in `dir`, compacted now. One process opens it; others `readLedger`. */
export function openLedger(dir: string, now = Date.now()): Ledger {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'jobs.jsonl');
  const { rows, skipped } = readLedger(dir);
  for (const [id, r] of rows) if (TERMINAL.has(r.state) && now - (r.endedAt ?? r.createdAt) > KEEP_MS) rows.delete(id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, [...rows.values()].map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
  renameSync(tmp, file);
  const fd = openSync(file, 'a', 0o600);
  return {
    get: (id) => rows.get(id),
    all: () => [...rows.values()],
    put(r, sync = false) {
      rows.set(r.id, r);
      writeSync(fd, JSON.stringify(r) + '\n');
      if (sync) fsyncSync(fd);
    },
    skipped,
    close: () => closeSync(fd),
  };
}
