// The relay's telemetry (work 084 instrumentation, catalog v2 "dumb dump"):
// one event per unit of work, sent to the host over wire.sock the moment it
// happens (`telemetry`, name `wire.*`); the host checks it against
// api/wire-events.ts and emits it into its spool. Every aggregate is a query.
//
// The one unit that needs a little state is a write batch (`wire.flush`): what
// one connection handed to its socket in the `windowMs` after the batch's first
// frame. A streaming turn's deltas arrive one by one, so "one pump" would be one
// event per delta; the window makes the batch the unit (about one event a
// second per active connection, none when idle). opc `telemetry` frames the
// connection refused (too large, over its rate) are counted here too, never
// one event each (084 perf fix 3).
//
// Invariants: never blocks a frame (an integer add, a clock read); a send with
// the host away is dropped, not queued (host-link.ts); no field carries a
// member's content, a path or a message.

import type { WireEventName, WireFields } from '../api/wire-events.js';

export type WireEmit = (name: WireEventName, fields: WireFields) => void;

export const FLUSH_WINDOW_MS = 1000;

/** One connection's current write batch; emits `wire.flush` when the window closes (or the connection does). */
export class FlushWindow {
  private frames = 0;
  private bytes = 0;
  private events = 0;
  private deltas = 0;
  private oldestCreatedMs: number | undefined;
  private waitMax = 0;
  private paused = false;
  private merged = 0;
  private duplicates = 0;
  private refusedFrames = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private ship: (fields: WireFields) => void,
    /** Bytes still waiting in the connection's outbox (read when the batch closes). */
    private queued: () => number,
    private windowMs = FLUSH_WINDOW_MS,
    private now: () => number = Date.now,
  ) {}

  /** A frame handed to the socket. */
  frame(bytes: number) {
    this.frames++;
    this.bytes += bytes;
    this.open();
  }

  /** A recorded event handed to the socket; `createdMs` when it is live (not replay). */
  event(createdMs: number | undefined, waitedMs: number) {
    this.events++;
    if (createdMs !== undefined && Number.isFinite(createdMs) && (this.oldestCreatedMs === undefined || createdMs < this.oldestCreatedMs)) this.oldestCreatedMs = createdMs;
    if (waitedMs > this.waitMax) this.waitMax = waitedMs;
  }

  delta(waitedMs: number) {
    this.deltas++;
    if (waitedMs > this.waitMax) this.waitMax = waitedMs;
  }

  pause() {
    this.paused = true;
    this.open();
  }

  merge() {
    this.merged++;
    this.open();
  }

  duplicate() {
    this.duplicates++;
    this.open();
  }

  /** An opc `telemetry` frame dropped unread (too large or over the rate). */
  refused() {
    this.refusedFrames++;
    this.open();
  }

  /** Close the batch now (the connection ends). */
  close() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.flush();
  }

  private open() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.windowMs);
    this.timer.unref?.();
  }

  private flush() {
    this.timer = undefined;
    const fields: WireFields = {
      frames: this.frames, bytes: this.bytes, events: this.events, deltas: this.deltas,
      wait_ms_max: Math.ceil(this.waitMax), queued_bytes: this.queued(), paused: this.paused, merged: this.merged, duplicates: this.duplicates,
    };
    if (this.oldestCreatedMs !== undefined) fields.oldest_age_ms = Math.max(0, this.now() - this.oldestCreatedMs);
    if (this.refusedFrames) fields.telemetry_refused = this.refusedFrames;
    this.frames = this.bytes = this.events = this.deltas = this.waitMax = this.merged = this.duplicates = this.refusedFrames = 0;
    this.oldestCreatedMs = undefined;
    this.paused = false;
    this.ship(fields);
  }
}
