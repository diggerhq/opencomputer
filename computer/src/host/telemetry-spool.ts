// The host's telemetry spool (work 054, "Pipeline"): validated records wait
// on disk until the collector has them, so a host restart or a collector or
// network outage of hours loses nothing.
//
//   <dir>/open.ndjson                                  records being appended, one JSON object per line
//   <dir>/seg-<sealed ms>-<boot>-<seq>-<n>.ndjson      sealed batches, oldest first by name
//
// A sealed segment is one batch to the collector: it gets the next `batch_seq`
// of this process's `host_boot_id` when sealed, and is deleted only once the
// collector accepted it (or rejected it for good). So a missing sequence number
// in Tinybird is a lost batch even when nothing was counted.
//
// Invariants: no method throws. Disk use is capped at `maxBytes`; beyond it
// the oldest sealed segment is deleted and its records counted `buffer_full`.
// An open segment left by a previous process is sealed under this one's boot.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Batch } from '../telemetry/emitter.js';
import type { DropReason } from '../telemetry/envelope.js';

export interface SpoolOptions {
  dir: string;
  /** Disk cap for all segments (default 100 MB). */
  maxBytes?: number;
  /** Seal the open segment once it holds this many records (default 200). */
  batchRecords?: number;
  /** Called for records that will never leave. */
  onDrop?: (reason: DropReason, count: number) => void;
  /** Called when a segment was sealed because it filled up. */
  onFull?: () => void;
  now?: () => number;
}

export interface Segment {
  file: string;
  bootId: string;
  seq: number;
  records: number;
}

const OPEN = 'open.ndjson';
const SEGMENT = /^seg-(\d{13})-([0-9a-f]{8})-(\d{8})-(\d+)\.ndjson$/;
const pad = (n: number, w: number) => String(n).padStart(w, '0');

type Line = { e: Batch['events'][number] } | { t: Batch['turns'][number] };

export class Spool {
  readonly bootId = randomUUID().slice(0, 8);
  private seq = 0;
  private openRecords = 0;
  private bytes = 0;
  /** Seal times only increase, so name order is age order even if the wall clock steps back. */
  private lastSealAt = 0;
  private readonly max: number;
  private readonly batch: number;

  constructor(private o: SpoolOptions) {
    this.max = o.maxBytes ?? 100 << 20;
    this.batch = o.batchRecords ?? 200;
    try {
      mkdirSync(o.dir, { recursive: true });
      for (const f of readdirSync(o.dir)) {
        if (f !== OPEN && !SEGMENT.test(f)) continue;
        this.bytes += size(path.join(o.dir, f));
        this.lastSealAt = Math.max(this.lastSealAt, Number(f.match(SEGMENT)?.[1] ?? 0));
      }
      const left = this.read(path.join(o.dir, OPEN));
      this.openRecords = left.length;
      this.seal();
    } catch {
      // An unusable directory: appends fail and are counted.
    }
  }

  /** Bytes on disk, open segment included. */
  get spooledBytes() {
    return this.bytes;
  }

  /** Add a batch to the open segment; seals it at `batchRecords`. */
  append(b: Batch): void {
    const n = b.events.length + b.turns.length;
    if (!n) return;
    const lines: Line[] = [...b.events.map((e) => ({ e })), ...b.turns.map((t) => ({ t }))];
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    try {
      appendFileSync(path.join(this.o.dir, OPEN), text);
    } catch {
      this.drop('send_failed', n);
      return;
    }
    this.bytes += Buffer.byteLength(text);
    this.openRecords += n;
    if (this.openRecords >= this.batch) {
      this.seal();
      this.o.onFull?.();
    }
    this.trim();
  }

  /** Close the open segment as this boot's next batch. No-op when it is empty. */
  seal(): void {
    if (!this.openRecords) return;
    const at = Math.max(this.o.now?.() ?? Date.now(), this.lastSealAt + 1);
    const name = `seg-${pad(at, 13)}-${this.bootId}-${pad(++this.seq, 8)}-${this.openRecords}.ndjson`;
    try {
      renameSync(path.join(this.o.dir, OPEN), path.join(this.o.dir, name));
      this.openRecords = 0;
      this.lastSealAt = at;
    } catch {
      this.seq--;
    }
  }

  /** Sealed segments, oldest first. */
  segments(): Segment[] {
    try {
      return readdirSync(this.o.dir)
        .filter((f) => SEGMENT.test(f))
        .sort()
        .map((file) => {
          const m = file.match(SEGMENT)!;
          return { file, bootId: m[2], seq: Number(m[3]), records: Number(m[4]) };
        });
    } catch {
      return [];
    }
  }

  /** A sealed segment's records as one batch; unreadable lines are counted `invalid`. */
  load(s: Segment): Batch {
    const out: Batch = { events: [], turns: [] };
    for (const l of this.read(path.join(this.o.dir, s.file))) {
      if ('e' in l) out.events.push(l.e);
      else out.turns.push(l.t);
    }
    return out;
  }

  /** Delete a segment; with a reason, its records are counted as dropped. */
  remove(s: Segment, reason?: DropReason): void {
    const p = path.join(this.o.dir, s.file);
    const n = size(p);
    try {
      rmSync(p, { force: true });
      this.bytes = Math.max(0, this.bytes - n);
    } catch {
      return;
    }
    if (reason) this.drop(reason, s.records);
  }

  private trim() {
    while (this.bytes > this.max) {
      const oldest = this.segments()[0];
      if (!oldest) {
        // One open segment over the cap on its own: seal it so it can go.
        if (!this.openRecords) return;
        this.seal();
        if (this.openRecords) return; // could not seal; the next append retries
        continue;
      }
      this.remove(oldest, 'buffer_full');
    }
  }

  private read(file: string): Line[] {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: Line[] = [];
    let bad = 0;
    for (const l of text.split('\n')) {
      if (!l) continue;
      try {
        const v = JSON.parse(l);
        if (v && typeof v === 'object' && ('e' in v || 't' in v)) out.push(v);
        else bad++;
      } catch {
        bad++;
      }
    }
    if (bad) this.drop('invalid', bad);
    return out;
  }

  private drop(reason: DropReason, n: number) {
    try {
      this.o.onDrop?.(reason, n);
    } catch {
      // The caller's counter must not break the spool.
    }
  }
}

function size(p: string) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}
