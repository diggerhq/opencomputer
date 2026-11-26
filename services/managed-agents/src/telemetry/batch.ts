// A Durable Object's open telemetry batch (work 084 perf review): events with no invocation
// emitter of their own (a journal batch's `sessionlog.append`, a spill's `sessionlog.spill`, an API
// write) join the batch open now instead of each taking an emitter and a Tinybird POST. A DO has no
// handle on "the current invocation" across the awaits these events follow (the append RPC, an R2
// put), so the batch is a window: the first event opens it, and it is sent BATCH_MS later through
// `waitUntil`, whichever invocations emitted into it.
//
// Invariants:
// - Each event is still its own record, as emitted (dumb dump): only the POST is shared.
// - Nothing awaits the batch; `emit` is synchronous and never throws.
// - At most one POST per BATCH_MS per object while events flow; a batch that reaches BATCH_MAX is
//   closed early (the next event opens another), so one window never nears the emitter's buffer cap.
// - Telemetry off: each event is validated and discarded at once; no timer is armed.

import type { Telemetry } from "./emitter.js";
import type { GatewayTelemetry } from "./gateway.js";

export const BATCH_MS = 1_000;
export const BATCH_MAX = 200;

export interface TelemetryBatchOptions {
  /** A fresh emitter for the next batch (the object's org and host on its events). */
  open: () => GatewayTelemetry;
  waitUntil: (promise: Promise<unknown>) => void;
  windowMs?: number;
  max?: number;
}

export class TelemetryBatch {
  private current: GatewayTelemetry | undefined;

  constructor(private readonly o: TelemetryBatchOptions) {}

  /** Hands `write` the open batch's emitter, opening one (sent after the window) if none is. */
  emit(write: (t: Telemetry) => void): void {
    try {
      const t = this.current ?? this.start();
      write(t);
      if (t.buffered >= (this.o.max ?? BATCH_MAX) && this.current === t) this.current = undefined;
    } catch {
      // Telemetry never fails the work it measures.
    }
  }

  private start(): GatewayTelemetry {
    const t = this.o.open();
    if (!t.enabled) {
      // Off: validated as it is written, discarded by `done`; nothing to wait for.
      queueMicrotask(() => this.o.waitUntil(t.done()));
      return t;
    }
    this.current = t;
    const sent = new Promise<void>((resolve) => setTimeout(resolve, this.o.windowMs ?? BATCH_MS)).then(() => {
      if (this.current === t) this.current = undefined;
      return t.done();
    });
    this.o.waitUntil(sent);
    return t;
  }
}
