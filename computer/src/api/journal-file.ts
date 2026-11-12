// Reading a session journal without its lock (the host's spool overflow, the
// boot scan, a session's file epoch), for a process that does not write it.
//
// Invariants:
// - Each file is scanned once, incrementally: the reader keeps per file the
//   bytes scanned, the epoch and last seq seen, and a sparse index (seq →
//   offset every INDEX_EVERY events). A call reads only the bytes appended
//   since the last one, plus at most `limit` events from the indexed offset.
//   It never reads the whole file per batch (review r1 performance P1-2).
// - A file's first scan starts at its checkpoint (journal-checkpoint.ts) when
//   one matches the file, so it reads only the bytes after it.
// - A file that shrank, or whose last scanned bytes changed (a writer cut it
//   under a new epoch and wrote past the old end), is rescanned from the start; `forgetJournalFile` drops a file's state outright (the host
//   calls it when it rewrites a journal itself).
// - Only complete lines count: a torn last line is read once it is whole.
// - The file is in a directory its session can write (work 103, trust rule 4):
//   it is opened without following a link and must be a regular file, else it
//   reads as no journal; a line naming a session other than the directory's
//   is skipped.

import { closeSync, fstatSync, readSync } from 'node:fs';
import type { JournalEvent } from '../protocol.js';
import { readCheckpoint } from './journal-checkpoint.js';
import { OPEN, openRegular, sessionOfJournal } from './journal-dir.js';

const INDEX_EVERY = 64;
const CHUNK = 256 * 1024;
/** Files whose state is kept (the least recently read go first). */
const MAX_FILES = 512;

interface FileState {
  ino: number;
  /** Bytes scanned: every complete line before this offset is in the state. */
  scanned: number;
  epoch: number;
  /** The latest epoch line's first seq, and the last seq it committed (`through`; 0 on lines written before it existed). */
  startSeq: number;
  through: number;
  lastSeq: number;
  index: Array<[number, number]>;
  /** The last bytes before `scanned`: if they changed, the file was cut and rewritten in place. */
  mark: Buffer;
}

const MARK = 64;

const files = new Map<string, FileState>();

/** Forget what was read of `file` (it was rewritten). */
export function forgetJournalFile(file: string): void {
  files.delete(file);
}

type OnLine = (v: Record<string, unknown>, offset: number, end: number) => boolean | void;

/** A line that says whose it is, and it is not `sessionId`'s. */
const foreign = (v: Record<string, unknown>, sessionId: string | undefined) => !!sessionId && typeof v.sessionId === 'string' && v.sessionId !== sessionId;

/** Each complete line of `buf` (as parsed JSON) with its offset from `base` and its end; returns the offset after the last newline. */
function eachLine(buf: Buffer, base: number, f: OnLine, sessionId?: string): number {
  let at = 0;
  for (let nl = buf.indexOf(10, at); nl >= 0; at = nl + 1, nl = buf.indexOf(10, at)) {
    if (nl === at) continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(buf.toString('utf8', at, nl));
    } catch {
      continue; // a line we cannot parse is skipped, never fatal
    }
    if (foreign(v, sessionId)) continue;
    if (f(v, base + at, base + nl + 1) === false) return base + nl + 1;
  }
  return base + at;
}

const isEvent = (v: Record<string, unknown>): v is Record<string, unknown> & JournalEvent => typeof v.seq === 'number' && v.k === undefined;

/** Read `fd` from `from` to `to` in chunks, handing complete lines to `f` (but none naming a session other than `sessionId`, when given); stops when `f` returns false. Returns the offset reached. */
export function scanRange(fd: number, from: number, to: number, f: OnLine, sessionId?: string): number {
  const buf = Buffer.allocUnsafe(CHUNK);
  let carry = Buffer.alloc(0);
  let pos = from;
  let base = from;
  let stopped = false;
  while (pos < to && !stopped) {
    const n = readSync(fd, buf, 0, Math.min(CHUNK, to - pos), pos);
    if (n <= 0) break;
    pos += n;
    const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    const lastNl = chunk.lastIndexOf(10);
    if (lastNl < 0) {
      carry = Buffer.from(chunk);
      continue;
    }
    const end = eachLine(chunk.subarray(0, lastNl + 1), base, (v, o, e) => {
      if (f(v, o, e) === false) return (stopped = true), false;
    }, sessionId);
    if (stopped) return end;
    base += lastNl + 1;
    carry = Buffer.from(chunk.subarray(lastNl + 1));
  }
  return base;
}

/** Bring `file`'s state up to date with what it holds now. */
function refresh(file: string, fd: number, sessionId: string | undefined): FileState {
  const st = fstatSync(fd);
  let s = files.get(file);
  if (!s || s.ino !== st.ino || st.size < s.scanned || !markHolds(fd, s)) {
    const { ck } = readCheckpoint(file, fd, st.size, { sessionId, fold: false });
    s = ck
      ? { ino: st.ino, scanned: ck.offset, epoch: ck.epoch, startSeq: ck.startSeq, through: ck.through, lastSeq: ck.lastSeq, index: ck.index, mark: markAt(fd, ck.offset) }
      : { ino: st.ino, scanned: 0, epoch: 0, startSeq: 0, through: 0, lastSeq: 0, index: [], mark: Buffer.alloc(0) };
  }
  files.delete(file);
  files.set(file, s);
  if (files.size > MAX_FILES) files.delete(files.keys().next().value as string);
  if (st.size > s.scanned) {
    const state = s;
    state.scanned = scanRange(fd, state.scanned, st.size, (v, offset) => {
      if (v.k === 'epoch') (state.epoch = v.epoch as number), (state.startSeq = v.startSeq as number), (state.through = (v.through as number) ?? 0);
      else if (isEvent(v)) {
        // A rewritten tail (an older file's state we never saw cut) restarts the index past it.
        while (state.index.length && state.index[state.index.length - 1][0] >= v.seq) state.index.pop();
        const last = state.index[state.index.length - 1];
        if (!last || v.seq - last[0] >= INDEX_EVERY) state.index.push([v.seq, offset]);
        state.lastSeq = v.seq;
      }
    }, sessionId);
    state.mark = markAt(fd, state.scanned);
  }
  return s;
}

/** The MARK bytes before `offset`. */
function markAt(fd: number, offset: number): Buffer {
  const n = Math.min(MARK, offset);
  const b = Buffer.alloc(n);
  readSync(fd, b, 0, n, offset - n);
  return b;
}

function markHolds(fd: number, s: FileState): boolean {
  const n = s.mark.length;
  if (!n) return s.scanned === 0;
  const b = Buffer.alloc(n);
  return readSync(fd, b, 0, n, s.scanned - n) === n && b.equals(s.mark);
}

export interface JournalFileRead {
  epoch: number;
  /** The epoch line's first seq and the last seq it committed: `through > lastSeq` is an adoption torn before its events landed. */
  startSeq: number;
  through: number;
  lastSeq: number;
  events: JournalEvent[];
}

/** Read every event with seq > after (at most `limit`) from a journal file without its lock, and the file's epoch. */
export function readJournalFile(file: string, after: number, limit = 500): JournalFileRead {
  let fd: number;
  try {
    fd = openRegular(file, OPEN.read);
  } catch {
    return { epoch: 0, startSeq: 0, through: 0, lastSeq: 0, events: [] };
  }
  try {
    const sessionId = sessionOfJournal(file);
    const s = refresh(file, fd, sessionId);
    const events: JournalEvent[] = [];
    const head = { epoch: s.epoch, startSeq: s.startSeq, through: s.through, lastSeq: s.lastSeq };
    if (limit <= 0 || after >= s.lastSeq) return { ...head, events };
    let from = 0;
    for (let lo = 0, hi = s.index.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (s.index[mid][0] <= after + 1) (from = s.index[mid][1]), (lo = mid + 1);
      else hi = mid - 1;
    }
    scanRange(fd, from, s.scanned, (v) => {
      if (!isEvent(v) || v.seq <= after) return;
      // A newer epoch may have rewritten seqs we already passed: keep the latest copy of each.
      while (events.length && events[events.length - 1].seq >= v.seq) events.pop();
      events.push(v);
      if (events.length >= limit) return false;
    }, sessionId);
    return { ...head, events };
  } finally {
    closeSync(fd);
  }
}
