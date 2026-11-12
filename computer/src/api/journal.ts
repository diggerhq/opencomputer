// A session's journal (work 084, "One writer, one log"): one JSONL file per
// session, `<dataDir>/journals/<cs_…>/<cs_…>.jsonl` (journal-dir.ts), written only by the process that
// holds its flock (journal-lock.ts): the runner while it runs, the host's
// session-writer otherwise. Three kinds of line:
//
//   {"k":"epoch","sessionId","epoch","startSeq","through","at"}   a writer's term began (and on each new epoch); `through`: the DO's events it commits, written before it
//   {"id":"ev_…","seq",…}                                one public Event envelope, exactly as served
//   {"k":"idem","id","op","hash","result","seq","at"}    an idempotency record (24 h; read-methods.ts)
//
// Invariants:
// - `seq` is gapless from the open: it continues at max(local tail, the DO's
//   lastSeq) + 1. A higher epoch than the file's truncates at the first event
//   with seq ≥ epochStartSeq (default lastSeq + 1; the DO's copy wins),
//   appends the DO's `tail` verbatim, then the new epoch's line (the commit record, fsynced; the `epoch` frame,
//   /tmp recovery-fix: no relabelling, no seq collisions); a lower epoch is
//   refused (`stale_epoch`): a fenced writer never writes.
// - An event is one write(2) of one line on an fd held open, no fsync, before
//   anyone sees it (SessionLog fans out after `append` returns).
// - Reads go through a sparse index (seq → offset every INDEX_EVERY events) and
//   a turn index (each turn's first event), so a cursor or a tail seeks.
// - An open reads from the checkpoint (journal-checkpoint.ts) when one matches
//   the file, else from the start, in chunks, handing each event to the
//   caller's fold as it goes (nothing is kept but the indexes and the lines
//   past the new epoch's first seq, which a cut may drop). A checkpoint that
//   holds events a new epoch cuts is not used; one the cut lands below is
//   removed before the cut.
// - `redact` is applied to every string of `data` before the line is written.
// - Files are 0660 in the session's setgid 02770 directory (journal-dir.ts), so
//   the host (sp-host, in group agent) and the runner (agent) can both open
//   each other's files.
// - The file is opened once, without following a link, and must be a regular
//   file; the lock is taken on that descriptor's file, not on the name. A line
//   that names another session is not read (103, trust rule 4): it is skipped
//   by every scan, and cut when it is the file's tail.

import { closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, writeSync } from 'node:fs';
import type { ApiActor, JournalEvent } from '../protocol.js';
import { isSessionId, mintId } from '../session-ids.js';
import { type Checkpoint, lineHash, readCheckpoint, removeCheckpoint, writeCheckpoint } from './journal-checkpoint.js';
import { JournalError, OPEN, openRegular } from './journal-dir.js';
import { scanRange } from './journal-file.js';
import { FileLock, LockError } from './journal-lock.js';
import { saveResult } from './subagent-results.js';

const INDEX_EVERY = 64;
const IDEM_TTL_MS = 24 * 3600_000;
/** A checkpoint is due once the file grew this much past the last one, and at least twice that one's size. */
const CHECKPOINT_MIN_BYTES = 1 << 20;

export interface JournalOpen {
  sessionId: string;
  epoch: number;
  /** The DO's lastSeq (start, deliver, RunnerApi). */
  lastSeq: number;
  /** The first seq of `epoch` when the file has none of it; default lastSeq + 1. A higher epoch truncates at it. */
  epochStartSeq?: number;
  /** The DO's events from epochStartSeq on (the `epoch` frame), appended verbatim under a new epoch. */
  tail?: JournalEvent[];
  /** A caller that folds the log: `restore` gets a checkpoint's fold state (false: not usable, read the file whole), `apply` each event after it in seq order with its line's bytes. */
  fold?: { restore(state: unknown): boolean; apply(e: JournalEvent, bytes: number): void };
  /** Wait this long for the lock; 0: fail at once with `locked`. */
  waitMs?: number;
  redact?: (s: string) => string;
  now?: () => number;
}

export interface IdemRecord {
  /** sha256(member|op|key), hex: the key itself is never stored. */
  id: string;
  op: string;
  /** sha256 of the normalised params. */
  hash: string;
  result: unknown;
  /** lastSeq when the result was recorded. */
  seq: number;
  at: number;
}

interface EpochLine {
  k: 'epoch';
  sessionId: string;
  epoch: number;
  startSeq: number;
  /** The last of the DO's events committed with this line (written before it); 0: none. */
  through: number;
  at: number;
}

/** One parsed line and where it sits. */
interface Line {
  start: number;
  end: number;
  v: Record<string, unknown>;
}

/** What an open knows of the file: from its checkpoint, then from each line read past it. */
interface Known {
  epoch: number;
  startSeq: number;
  through: number;
  /** The highest event seq, and the last in file order. */
  tail: number;
  lastSeq: number;
  index: Array<[number, number]>;
  turns: Array<{ turnId: string; seq: number }>;
  idem: Map<string, IdemRecord>;
  /** The end of the last line taken, and where that line starts. */
  end: number;
  lastLine: number;
  /** The checkpoint this started from: its offset and size (0: none). */
  ckptAt: number;
  ckptBytes: number;
}

const unknown = (): Known => ({ epoch: 0, startSeq: 0, through: 0, tail: 0, lastSeq: 0, index: [], turns: [], idem: new Map(), end: 0, lastLine: 0, ckptAt: 0, ckptBytes: 0 });

function fromCheckpoint(ck: Checkpoint, now: number, bytes: number): Known {
  const idem = new Map<string, IdemRecord>();
  for (const r of ck.idem as IdemRecord[]) if (now - r.at < IDEM_TTL_MS) idem.set(r.id, r);
  const { epoch, startSeq, through, tail, lastSeq, index, turns, offset, lastLine } = ck;
  return { epoch, startSeq, through, tail, lastSeq, index, turns, idem, end: offset, lastLine, ckptAt: offset, ckptBytes: bytes };
}

const isEvent = (v: Record<string, unknown>): v is Record<string, unknown> & JournalEvent => typeof v.seq === 'number' && v.k === undefined;

function redactAll(v: unknown, r: (s: string) => string): unknown {
  if (typeof v === 'string') return r(v);
  if (Array.isArray(v)) return v.map((x) => redactAll(x, r));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactAll(x, r)]));
  return v;
}

export { ensureJournalDir, ensureSessionJournalDir, JournalError, journalPath } from './journal-dir.js';
export { forgetJournalFile, readJournalFile } from './journal-file.js';

export class Journal {
  private fd: number;
  private seq: number;
  private bytes: number;
  /** [seq, offset of its line] every INDEX_EVERY events, ascending. */
  private index: Array<[number, number]>;
  private turnIndex: Array<{ turnId: string; seq: number }>;
  private turnSeen: Set<string>;
  private idem: Map<string, IdemRecord>;
  /** The highest event seq on file (`seq` may be past it: the DO's lastSeq), where the last line starts, the epoch line's `through`. */
  private tailSeq: number;
  private lastLine: number;
  private through: number;
  /** The offset and size of the latest checkpoint (0: none). */
  private ckptAt: number;
  private ckptBytes: number;
  private ackedSeq = 0;
  private closed = false;
  readonly epoch: number;
  readonly epochStartSeq: number;

  private constructor(
    readonly file: string,
    readonly sessionId: string,
    private lock: FileLock,
    private o: JournalOpen,
    fd: number,
    seq: number,
    k: Known,
  ) {
    this.fd = fd;
    this.seq = seq;
    this.bytes = k.end;
    this.epoch = o.epoch;
    this.epochStartSeq = k.startSeq;
    this.index = k.index;
    this.turnIndex = k.turns;
    this.turnSeen = new Set(k.turns.map((t) => t.turnId));
    this.idem = k.idem;
    this.tailSeq = k.tail;
    this.lastLine = k.lastLine;
    this.through = k.through;
    this.ckptAt = k.ckptAt;
    this.ckptBytes = k.ckptBytes;
  }

  /** Take the lock and open `file` for `o.sessionId` under `o.epoch`. */
  static async open(file: string, o: JournalOpen): Promise<Journal> {
    if (!isSessionId(o.sessionId)) throw new JournalError('bad_id', `not a session id: ${o.sessionId}`);
    const fd = openRegular(file, OPEN.append);
    // The umask may have masked the group's write bit; only the creator (the owner) can fix it.
    try {
      fchmodSync(fd, 0o660);
    } catch {}
    let lock: FileLock;
    try {
      lock = await FileLock.take(file, o.waitMs ?? 0, undefined, fd);
    } catch (e) {
      closeSync(fd);
      const locked = e instanceof LockError && e.code === 'locked';
      throw new JournalError(locked ? 'locked' : 'lock_failed', (e as Error).message);
    }
    try {
      return Journal.loadFd(file, fd, o, lock);
    } catch (e) {
      closeSync(fd);
      await lock.release();
      throw e;
    }
  }

  private static loadFd(file: string, fd: number, o: JournalOpen, lock: FileLock): Journal {
    const now = o.now ?? Date.now;
    const t = now();
    const size = fstatSync(fd).size;
    const from = o.epochStartSeq ?? o.lastSeq + 1;
    const read = readCheckpoint(file, fd, size, { sessionId: o.sessionId, fold: !!o.fold });
    const ck = read.ck;
    // A checkpoint holding events at or past a new epoch's first seq would keep what the cut drops: read whole then.
    const usable = ck && !(o.epoch > ck.epoch && ck.tail >= from) && (!o.fold || o.fold.restore(ck.fold));
    const k = usable ? fromCheckpoint(ck, t, read.bytes) : unknown();
    const take = (l: Line) => {
      (k.end = l.end), (k.lastLine = l.start);
      const v = l.v;
      if (isEvent(v)) {
        Journal.indexInto(k, v, l.start);
        k.lastSeq = v.seq;
        o.fold?.apply(v, l.end - l.start);
      } else if (v.k === 'idem' && t - (v.at as number) < IDEM_TTL_MS) k.idem.set(v.id as string, v as unknown as IdemRecord);
    };
    // Lines from the first event at or past `from` on, while a higher epoch may cut them (the DO's copy wins).
    let held = null as Line[] | null;
    let validEnd = k.end;
    scanRange(fd, k.end, size, (v, start, end) => {
      const l = { v, start, end };
      validEnd = end;
      if (v.k === 'epoch') {
        (k.epoch = v.epoch as number), (k.startSeq = v.startSeq as number), (k.through = (v.through as number) ?? 0);
        if (held && k.epoch >= o.epoch) {
          const h: Line[] = held;
          held = null;
          for (const x of h) take(x);
        }
      } else if (isEvent(v)) {
        k.tail = Math.max(k.tail, v.seq);
        if (!held && o.epoch > k.epoch && v.seq >= from) held = [];
      }
      if (held) held.push(l);
      else take(l);
    }, o.sessionId);
    if (o.epoch < k.epoch) throw new JournalError('stale_epoch', `epoch ${o.epoch} is older than the journal's ${k.epoch}`);
    let cut = validEnd;
    if (k.epoch && o.epoch > k.epoch) {
      if (held?.length) cut = held[0].start;
      k.tail = Math.min(k.tail, from - 1);
    } else for (const h of held ?? []) take(h);
    if (cut < size) {
      if (read.offset > cut) removeCheckpoint(file);
      ftruncateSync(fd, cut);
    }
    k.end = cut;
    const seq = Math.max(k.tail, o.lastSeq);
    const j = new Journal(file, o.sessionId, lock, o, fd, seq, k);
    if (o.epoch !== k.epoch) {
      const s = o.epochStartSeq ?? (k.epoch === 0 && o.lastSeq === 0 ? 1 : seq + 1);
      // Crash-safe (review r2 P1-2): the DO's events first, then the epoch line as the commit record, each synced.
      // A crash before the epoch line leaves the file at its old epoch (the events past the cut are the DO's, and a
      // rerun cuts at `s` again), so the gateway's next `epoch` adopts it once more.
      const through = j.appendTail(o.tail, s, k.tail);
      if (through) fsyncSync(fd);
      j.writeLine({ k: 'epoch', sessionId: o.sessionId, epoch: o.epoch, startSeq: s, through, at: now() } satisfies EpochLine);
      fsyncSync(fd);
      (j as { epochStartSeq: number }).epochStartSeq = s;
      j.through = through;
    } else if (o.tail?.length && k.tail < o.tail[o.tail.length - 1].seq) {
      // Same epoch, but the file lacks some of its events (an adoption torn by an older build, a lost write): take
      // the DO's from the local tail on. Never synthesized: only the log's own events repair a journal.
      if (j.appendTail(o.tail, k.startSeq, k.tail)) fsyncSync(fd);
    }
    return j;
  }

  /** Append the DO's `events` with seq ≥ `from` past `after`, ascending; returns the last seq written (0: none). */
  private appendTail(events: JournalEvent[] | undefined, from: number, after: number): number {
    let written = after;
    for (const e of events ?? []) {
      if (e.seq < from || e.seq <= written) continue; // ascending, and never below the epoch's first seq
      if (written >= from - 1 && e.seq > written + 1) console.warn(`journal ${this.sessionId}: the log's events jump from ${written} to ${e.seq}`);
      const at = this.writeLine(e);
      this.indexEvent(e, at);
      this.o.fold?.apply(e, this.bytes - at);
      written = e.seq;
      this.seq = Math.max(this.seq, e.seq);
    }
    if (events && written < this.seq) console.warn(`journal ${this.sessionId}: epoch ${this.epoch} tail ends at ${written}, lastSeq ${this.seq}: a gap`);
    return written > after ? written : 0;
  }

  /** The sparse index and the turn index, past one event (at open, before the Journal exists). */
  private static indexInto(k: Pick<Known, 'index' | 'turns'> & { seen?: Set<string> }, e: JournalEvent, offset: number) {
    const last = k.index[k.index.length - 1];
    if (!last || e.seq - last[0] >= INDEX_EVERY) k.index.push([e.seq, offset]);
    if (e.turnId) {
      k.seen ??= new Set(k.turns.map((t) => t.turnId));
      if (!k.seen.has(e.turnId)) k.seen.add(e.turnId), k.turns.push({ turnId: e.turnId, seq: e.seq });
    }
  }

  private indexEvent(e: JournalEvent, offset: number) {
    Journal.indexInto({ index: this.index, turns: this.turnIndex, seen: this.turnSeen }, e, offset);
    this.tailSeq = Math.max(this.tailSeq, e.seq);
  }

  private writeLine(v: object): number {
    if (this.closed) throw new JournalError('closed', 'the journal was released');
    const line = `${JSON.stringify(v)}\n`;
    const start = this.bytes;
    this.bytes += writeSync(this.fd, line);
    this.lastLine = start;
    return start;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.bytes;
  }

  /** Record one event; returns it as served. Bytes of its line: `size` before and after. */
  append(type: string, data: unknown, meta: { turnId?: string | null; actor?: ApiActor | null } = {}): JournalEvent {
    const now = (this.o.now ?? Date.now)();
    const a = meta.actor;
    const event: JournalEvent = {
      id: mintId('ev'),
      seq: this.seq + 1,
      createdAt: new Date(now).toISOString(),
      sessionId: this.sessionId,
      turnId: meta.turnId ?? null,
      type,
      // The public Actor's name is a string; an unnamed one shows its id.
      actor: a ? { id: a.id, name: a.name ?? a.id, via: a.via, client: a.client } : null,
      data: this.o.redact ? redactAll(data, this.o.redact) : data,
    };
    const offset = this.writeLine(event);
    this.seq = event.seq;
    this.indexEvent(event, offset);
    return event;
  }

  /** Keep a subagent's whole result beside the journal (subagent-results.ts), redacted as events are; before its `subagent.ended`. Throws on a write error. */
  keepResult(subagentId: string, text: string): void {
    if (this.closed) throw new JournalError('closed', 'the journal is released');
    saveResult(this.file, subagentId, this.o.redact ? this.o.redact(text) : text);
  }

  /** Whether a checkpoint is due: the file grew CHECKPOINT_MIN_BYTES past the last one, and twice its size. */
  get checkpointDue(): boolean {
    return !this.closed && this.bytes - this.ckptAt >= Math.max(CHECKPOINT_MIN_BYTES, 2 * this.ckptBytes);
  }

  /**
   * Write a checkpoint of the file as it stands, with the caller's fold state
   * (the fold of every event on file now). Best effort: a failure is logged and
   * the next open reads further back.
   */
  checkpoint(fold: unknown): void {
    if (this.closed || this.bytes === 0) return;
    try {
      const now = (this.o.now ?? Date.now)();
      this.ckptBytes = writeCheckpoint(
        this.file,
        {
          sessionId: this.sessionId,
          offset: this.bytes,
          lastLine: this.lastLine,
          hash: lineHash(this.fd, this.lastLine, this.bytes),
          epoch: this.epoch,
          startSeq: this.epochStartSeq,
          through: this.through,
          tail: this.tailSeq,
          lastSeq: this.tailSeq,
          index: this.index,
          turns: this.turnIndex,
          idem: [...this.idem.values()].filter((r) => now - r.at < IDEM_TTL_MS),
        },
        fold,
      );
      this.ckptAt = this.bytes;
    } catch (e) {
      console.warn(`journal ${this.sessionId}: checkpoint not written: ${(e as Error).message}`);
    }
  }

  /** Events with seq > after, at most `limit`, from disk. */
  read(after: number, limit = 500): JournalEvent[] {
    if (after >= this.seq || limit <= 0) return [];
    let lo = 0;
    let hi = this.index.length - 1;
    let from = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.index[mid][0] <= after + 1) (from = this.index[mid][1]), (lo = mid + 1);
      else hi = mid - 1;
    }
    const out: JournalEvent[] = [];
    scanRange(this.fd, from, this.bytes, (v) => {
      if (!isEvent(v) || v.seq <= after) return;
      out.push(v);
      if (out.length >= limit) return false;
    }, this.sessionId);
    return out;
  }

  /** The turn index: each turn's id and the seq of its first event, in order. */
  turns(): ReadonlyArray<{ turnId: string; seq: number }> {
    return this.turnIndex;
  }

  /** The cursor before the last `n` turns (lastSeq when there are none). */
  tailTurnsAfter(n: number): number {
    if (n <= 0 || !this.turnIndex.length) return this.seq;
    const t = this.turnIndex[Math.max(0, this.turnIndex.length - n)];
    return t.seq - 1;
  }

  readTailTurns(n: number, limit = 10_000): JournalEvent[] {
    return this.read(this.tailTurnsAfter(n), limit);
  }

  idemGet(id: string): IdemRecord | undefined {
    const r = this.idem.get(id);
    if (r && (this.o.now ?? Date.now)() - r.at >= IDEM_TTL_MS) {
      this.idem.delete(id);
      return undefined;
    }
    return r;
  }

  idemPut(r: Omit<IdemRecord, 'at'>): void {
    const rec: IdemRecord = { ...r, at: (this.o.now ?? Date.now)() };
    this.writeLine({ k: 'idem', ...rec });
    this.idem.set(r.id, rec);
  }

  /** The DO stored every event of `epoch` up to `seq` (memory only: nothing is trimmed yet). */
  ack(epoch: number, seq: number): void {
    if (epoch === this.epoch && seq > this.ackedSeq) this.ackedSeq = Math.min(seq, this.seq);
  }

  get acked(): number {
    return this.ackedSeq;
  }

  unackedAfter(seq = this.ackedSeq, limit = 500): JournalEvent[] {
    return this.read(seq, limit);
  }

  /** Close the file and drop the lock; a successor may open it once this resolves. */
  async release(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    await this.lock.release();
  }
}
