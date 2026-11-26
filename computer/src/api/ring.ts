// The writer's recent events in memory (work 084): a ring over the journal's
// seq, bounded by bytes (4 MB by default), so an attach from a recent cursor
// and a live subscriber's catch-up never touch the disk. Older cursors fall
// through to the journal (SessionLog / Hub decide).
//
// Invariants: the ring holds a gapless run of seqs ending at the last event
// pushed; it drops from the front only, and keeps at least the newest event
// whatever its size. `since(after)` answers only if every event after `after`
// is here, else undefined.

import type { JournalEvent } from '../protocol.js';

export const RING_BYTES = 4 << 20;

export class Ring {
  private events: JournalEvent[] = [];
  private sizes: number[] = [];
  /** Bytes pushed since the ring began, through each event (for O(1) backlog sizes). */
  private cum: number[] = [];
  private total = 0;
  private head = 0;
  private held = 0;

  constructor(private maxBytes = RING_BYTES) {}

  /** Append the next event (seq = last + 1) and its line's size. A gap clears the ring first. */
  push(e: JournalEvent, bytes: number): void {
    if (this.count && e.seq !== this.last + 1) this.clear();
    this.events.push(e);
    this.sizes.push(bytes);
    this.cum.push((this.total += bytes));
    this.held += bytes;
    while (this.count > 1 && this.held > this.maxBytes) {
      this.held -= this.sizes[this.head];
      this.head++;
    }
    // Compact the arrays once the dropped prefix is as long as what is kept.
    if (this.head > 1024 && this.head * 2 > this.events.length) {
      this.events = this.events.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.cum = this.cum.slice(this.head);
      this.head = 0;
    }
  }

  clear(): void {
    this.events = [];
    this.sizes = [];
    this.cum = [];
    this.head = 0;
    this.held = 0;
  }

  get count(): number {
    return this.events.length - this.head;
  }

  /** The oldest seq held; 0 when empty. */
  get first(): number {
    return this.count ? this.events[this.head].seq : 0;
  }

  /** The newest seq held; 0 when empty. */
  get last(): number {
    return this.count ? this.events[this.events.length - 1].seq : 0;
  }

  get bytes(): number {
    return this.held;
  }

  /** Whether `since(after)` can answer. */
  covers(after: number): boolean {
    return this.count > 0 && after + 1 >= this.first && after <= this.last;
  }

  /** Events with seq > after, at most `limit`, if the ring holds all of them; undefined otherwise. */
  since(after: number, limit = Number.POSITIVE_INFINITY): JournalEvent[] | undefined {
    if (!this.covers(after)) return undefined;
    const from = this.head + (after + 1 - this.first);
    return this.events.slice(from, Math.min(this.events.length, from + limit));
  }

  /** Bytes of the events with seq > after that the ring holds (all of them when it covers `after`). O(1). */
  bytesAfter(after: number): number {
    if (!this.count || after >= this.last) return 0;
    if (after < this.first) return this.held;
    return this.total - this.cum[this.head + (after - this.first)];
  }
}
