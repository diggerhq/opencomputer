// A journal's checkpoint (084 perf fix 1): `<journal>.ckpt` beside the file,
// what an open would know after reading the journal up to `offset`: the
// epoch line's fields, the seq indexes, the live idempotency records and the
// writer's fold, so an open (Journal.load) or an unlocked reader
// (journal-file.ts) reads only the bytes after it, not the whole history.
//
// Two lines: the header (everything but the fold, which journal-file.ts
// reads alone) and the fold's state, opaque here (Fold.snapshot).
//
// Invariants:
// - The journal is the truth; a checkpoint is a cache of a prefix of it. It is
//   used only when its `lastLine` still hashes the same (sha256 of the bytes of
//   the line ending at `offset`) and `offset` is within the file; anything
//   else (missing, torn, unparseable, another session's, an older format) reads
//   the journal whole, as before checkpoints existed.
// - Only the journal's lock holder writes it, whole, to a temp file renamed
//   over the old one: a reader sees the old checkpoint or the new, never half.
//   No fsync: a checkpoint lost or torn by a crash is just not used.
// - A writer that cuts the journal below a checkpoint's offset removes the
//   checkpoint first (Journal.load).

import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';

/** Bumped whenever the header's meaning changes; an older checkpoint is ignored. */
const VERSION = 1;

export interface CheckpointHeader {
  v: number;
  sessionId: string;
  /** Bytes of the journal covered: every complete line before this offset. */
  offset: number;
  /** Where the line ending at `offset` starts, and the sha256 (hex) of its bytes. */
  lastLine: number;
  hash: string;
  /** The latest epoch line before `offset`: epoch, startSeq, through (0: none). */
  epoch: number;
  startSeq: number;
  through: number;
  /** The highest seq of an event before `offset`, and the last one in file order (the same in a file Journal wrote). */
  tail: number;
  lastSeq: number;
  /** [seq, offset of its line] every INDEX_EVERY events, ascending. */
  index: Array<[number, number]>;
  /** Each turn's id and the seq of its first event, in order. */
  turns: Array<{ turnId: string; seq: number }>;
  /** Idempotency records still live when it was written. */
  idem: unknown[];
}

export interface Checkpoint extends CheckpointHeader {
  /** The writer's fold state (absent when read without it). */
  fold?: unknown;
}

export const checkpointPath = (journal: string) => `${journal}.ckpt`;

export function lineHash(fd: number, start: number, end: number): string {
  const b = Buffer.allocUnsafe(end - start);
  const n = end > start ? readSync(fd, b, 0, b.length, start) : 0;
  return createHash('sha256').update(b.subarray(0, n)).digest('hex');
}

/**
 * The checkpoint of the journal open on `fd` (`size` bytes), if one is there and
 * still matches the file; `fold` false skips parsing the fold's line. `offset`
 * is the offset of the checkpoint read, used or not (0: none), `bytes` its size.
 */
export function readCheckpoint(journal: string, fd: number, size: number, o: { sessionId?: string; fold: boolean }): { ck?: Checkpoint; offset: number; bytes: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(checkpointPath(journal));
  } catch {
    return { offset: 0, bytes: 0 };
  }
  const r = readHeader(buf, fd, size, o);
  return { ...r, bytes: buf.length };
}

function readHeader(buf: Buffer, fd: number, size: number, o: { sessionId?: string; fold: boolean }): { ck?: Checkpoint; offset: number } {
  const nl = buf.indexOf(10);
  let h: CheckpointHeader;
  try {
    h = JSON.parse(buf.toString('utf8', 0, nl < 0 ? buf.length : nl));
  } catch {
    return { offset: 0 };
  }
  if (!h || typeof h !== 'object') return { offset: 0 };
  const offset = typeof h.offset === 'number' ? h.offset : 0;
  const shaped = h.v === VERSION && Array.isArray(h.index) && Array.isArray(h.turns) && Array.isArray(h.idem) && typeof h.lastLine === 'number';
  if (!shaped || (o.sessionId && h.sessionId !== o.sessionId) || offset <= h.lastLine || offset > size || lineHash(fd, h.lastLine, offset) !== h.hash) return { offset };
  if (!o.fold) return { ck: h, offset };
  if (nl < 0) return { offset };
  try {
    return { ck: { ...h, fold: JSON.parse(buf.toString('utf8', nl + 1)) }, offset };
  } catch {
    return { offset };
  }
}

/** Write a checkpoint atomically beside `journal`; returns its bytes. Throws on a write error (the caller logs it). */
export function writeCheckpoint(journal: string, h: Omit<CheckpointHeader, 'v'>, fold: unknown): number {
  const file = checkpointPath(journal);
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify({ v: VERSION, ...h })}\n${JSON.stringify(fold ?? null)}\n`;
  rmSync(tmp, { force: true }); // a temp left by another uid (runner or host): ours instead
  const fd = openSync(tmp, 'w', 0o660);
  try {
    // As the journal's own mode: the umask may have masked the group bit (the other writer reads and replaces it).
    try {
      fchmodSync(fd, 0o660);
    } catch {}
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return Buffer.byteLength(body);
}

export function removeCheckpoint(journal: string): void {
  rmSync(checkpointPath(journal), { force: true });
}
