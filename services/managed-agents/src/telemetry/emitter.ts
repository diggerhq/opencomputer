// Copied from diggerhq/calvin src/telemetry/emitter.ts at 017d8db (calvin#44, work 054);
// keep identical until work 050 P3 shares the protocol package.

// The telemetry emitter (work 054, "Pipeline"): one per process (runner,
// host) or per invocation (gateway). `emit`, `start`/`end` and `turn` are
// synchronous: validate, stamp, push into a bounded buffer. `flush` hands the
// buffer to `send`, which is the only thing that differs between processes
// (a socket write, a disk spool, an HTTP POST).
//
// Invariants: no public function throws or rejects, whatever `send`, `now`
// or `mono` do; telemetry never fails the work it measures. Every record that
// does not leave is counted by reason and reported as `telemetry.dropped` on
// the next flush. Without `send` the emitter validates and discards, so tests
// exercise the boundary with telemetry off.

import type { DataOf, EventName, ServiceName } from './catalog.js';
import {
  type DropReason,
  type Dimensions,
  type ErrorType,
  type Outcome,
  SCHEMA_VERSION,
  type TelemetryEvent,
  type TurnInput,
  type TurnRow,
  tbTime,
  uuidv7,
} from './envelope.js';
import { checkEvent, checkTurn } from './validate.js';

export interface Batch {
  events: TelemetryEvent[];
  turns: TurnRow[];
}

export interface TelemetryOptions {
  service: ServiceName;
  version: string;
  region: string;
  /** Where batches go. Absent: validate and discard (telemetry off). */
  send?: (batch: Batch) => void | Promise<void>;
  /** Wall clock, ms since epoch. */
  now?: () => number;
  /** Monotonic clock, ms, for span durations. */
  mono?: () => number;
  /** Fields stamped on every event unless the call sets them (host_id, substrate, …). */
  base?: Dimensions;
  synthetic?: boolean;
  /** Records held before the oldest is dropped (`buffer_full`). */
  maxBuffer?: number;
}

/** What a call may set beside the stamped fields. */
export interface EventFields<N extends EventName> extends Dimensions {
  duration_ms?: number;
  outcome?: Outcome;
  error_type?: ErrorType;
  error_code?: string;
  tool_call_id?: string;
  tool_name?: string;
  capability?: TelemetryEvent['capability'];
  synthetic?: boolean;
  data?: DataOf<N>;
}

export interface Span<N extends EventName> {
  /** Emit the event with `duration_ms` since `start`. A second call is ignored. */
  end(more?: EventFields<N>): void;
}

export interface Telemetry {
  emit<N extends EventName>(name: N, fields?: EventFields<N>): void;
  start<N extends EventName>(name: N, fields?: EventFields<N>): Span<N>;
  turn(row: TurnInput): void;
  /** Wait (at most `waitMs`) for open spans, then send everything buffered. Never rejects. */
  flush(waitMs?: number): Promise<void>;
  /** Records waiting to be sent. */
  readonly buffered: number;
  /** Records dropped since start, by reason. */
  readonly dropped: Readonly<Partial<Record<DropReason, number>>>;
}

const safe = <T>(f: () => T, fallback: T): T => {
  try {
    return f();
  } catch {
    return fallback;
  }
};

export function createTelemetry(o: TelemetryOptions): Telemetry {
  const now = () => safe(o.now ?? Date.now, Date.now());
  const mono = () => safe(o.mono ?? (() => performance.now()), 0);
  const max = o.maxBuffer ?? 2000;
  let events: TelemetryEvent[] = [];
  let turns: TurnRow[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const pending: Partial<Record<DropReason, number>> = {};
  let open = 0;
  let opened: (() => void)[] = [];

  const drop = (reason: DropReason, n = 1) => {
    dropped[reason] = (dropped[reason] ?? 0) + n;
    pending[reason] = (pending[reason] ?? 0) + n;
  };
  const room = () => {
    while (events.length + turns.length >= max) {
      if (events.length) events.shift();
      else turns.shift();
      drop('buffer_full');
    }
  };

  const build = <N extends EventName>(name: N, f: EventFields<N> | undefined, at: number) => ({
    ...o.base,
    ...f,
    schema_version: SCHEMA_VERSION,
    event_id: uuidv7(at),
    event_name: name,
    occurred_at: tbTime(at),
    service_name: o.service,
    service_version: o.version,
    region: o.region,
    synthetic: f?.synthetic ?? o.synthetic ?? false,
    data: f?.data ?? {},
  });

  const push = (input: unknown) => {
    const c = checkEvent(input);
    if (!c.ok) return drop('invalid');
    if (c.clamped) drop('clock');
    room();
    events.push(c.value);
  };

  const t: Telemetry = {
    emit(name, fields) {
      safe(() => push(build(name, fields, now())), undefined);
    },
    start(name, fields) {
      const began = mono();
      let done = false;
      open++;
      return {
        end(more) {
          if (done) return;
          done = true;
          open--;
          safe(() => push(build(name, { ...fields, ...more, duration_ms: mono() - began } as EventFields<typeof name>, now())), undefined);
          if (open === 0) for (const r of opened.splice(0)) r();
        },
      };
    },
    turn(row) {
      safe(() => {
        const c = checkTurn({ region: o.region, ...row, schema_version: SCHEMA_VERSION });
        if (!c.ok) return drop('invalid');
        if (c.clamped) drop('clock');
        room();
        turns.push(c.value);
      }, undefined);
    },
    async flush(waitMs = 0) {
      try {
        if (open > 0 && waitMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            opened.push(() => (clearTimeout(timer), resolve()));
          });
          opened = [];
        }
        for (const [reason, count] of Object.entries(pending) as [DropReason, number][]) {
          delete pending[reason];
          push(build('telemetry.dropped', { data: { reason, count } }, now()));
        }
        if (!events.length && !turns.length) return;
        const batch = { events, turns };
        events = [];
        turns = [];
        if (!o.send) return;
        try {
          await o.send(batch);
        } catch {
          drop('send_failed', batch.events.length + batch.turns.length);
        }
      } catch {
        // A bug here must not reach the caller; the next flush reports what was counted.
      }
    },
    get buffered() {
      return events.length + turns.length;
    },
    get dropped() {
      return { ...dropped };
    },
  };
  return t;
}
