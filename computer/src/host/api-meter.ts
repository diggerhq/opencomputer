// The host's computer-API telemetry (work 084 instrumentation; contract:
// /tmp/build084/instrumentation-catalog.md, v2 "dumb dump"): one event per unit
// of work, emitted into the host spool through the host's emitter. The units
// are the relay's events on wire.sock (`wire.*`), opc's events (`cli.*`), the
// mirror's batches and acks, epoch adoptions, held frames and stale-epoch drops.
// `api.sample` adds, once a minute, gauges read at that moment. Every aggregate
// is a query.
//
// Invariants:
// - Nothing here blocks or awaits on a path it measures; the minute's journal
//   size is read asynchronously off its own timer (left out past a second).
// - No counter is kept or reset: the state is point-in-time gauges and what a
//   unit needs to describe itself.
// - Everything the relay sends is checked again here (api/wire-events.ts,
//   api/cli-telemetry.ts): an unknown name, key or value drops the event whole.
// - A stale-epoch drop is reported once per session and epoch (a runner stuck
//   on an old epoch must not become one event per frame).

import { lstat, readdir } from 'node:fs/promises';
import { checkCliForward } from '../api/cli-telemetry.js';
import { journalIn } from '../api/journal-dir.js';
import { checkWireEvent } from '../api/wire-events.js';
import { isSessionId } from '../session-ids.js';
import type { Telemetry } from '../telemetry/emitter.js';
import { MirrorMeter } from './mirror-meter.js';

/** The api-host's gauges at sample time. */
export interface ApiGauges {
  v4: boolean;
  runnerWriters: number;
  hostWriters: number;
  heldFrames: number;
  mirrorSpooledBytes: number;
}

export interface Adoption {
  sessionId: string;
  epoch: number;
  startSeq: number;
  tailEvents: number;
  torn: boolean;
  heldFrames: number;
  retiredRunner: boolean;
  attempt: number;
  ms: number;
  ok: boolean;
}

export interface ApiMeterOptions {
  /** `<dataDir>/journals`. */
  journals: string;
  intervalMs?: number;
  now?: () => number;
}

export function apiMeter(t: Telemetry, o: ApiMeterOptions) {
  const now = o.now ?? Date.now;
  let gauges: () => ApiGauges = () => ({ v4: false, runnerWriters: 0, hostWriters: 0, heldFrames: 0, mirrorSpooledBytes: 0 });
  const staleSeen = new Map<string, number>();
  /** Sessions whose held frames made the host ask for the epoch frame; cleared by the adoption. */
  const asked = new Set<string>();

  const mirror = new MirrorMeter(
    (b) =>
      t.emit('mirror.batch', {
        session_key: b.sessionId,
        ...(b.turnId ? { turn_id: b.turnId } : {}),
        ...(b.surface ? { surface: b.surface } : {}),
        data: {
          events: b.events, first_seq: b.firstSeq, last_seq: b.lastSeq, resent: b.resent, urgent: b.urgent,
          ...(b.oldestAgeMs !== undefined ? { oldest_age_ms: b.oldestAgeMs } : {}),
          ...(b.newestAgeMs !== undefined ? { newest_age_ms: b.newestAgeMs } : {}),
          ...(b.heldMs !== undefined ? { held_ms: b.heldMs } : {}),
        },
      }),
    (a) =>
      t.emit('mirror.ack', {
        session_key: a.sessionId,
        data: { seq: a.seq, batches: a.batches, events: a.events, commit_ms: a.commitMs, ...(a.ageMs !== undefined ? { age_ms: a.ageMs } : {}) },
      }),
    now,
  );

  /** One `telemetry` frame from the relay (wire.sock): a relay event or an opc event. Anything off is dropped. */
  function wire(name: string, fields: Record<string, unknown>) {
    const w = checkWireEvent(name, fields);
    if (w) {
      const { session_key, person_id, duration_ms, outcome, error_code } = w.envelope;
      return t.emit(w.name, {
        surface: 'cli',
        ...(session_key ? { session_key } : {}),
        ...(person_id ? { person_id } : {}),
        ...(duration_ms !== undefined ? { duration_ms } : {}),
        ...(outcome ? { outcome } : {}),
        ...(error_code ? { error_code } : {}),
        data: w.data,
      });
    }
    const c = checkCliForward(name, fields);
    if (!c) return;
    t.emit(c.name, {
      surface: 'cli',
      person_id: c.person_id,
      ...(c.session_key ? { session_key: c.session_key } : {}),
      ...(c.turn_id ? { turn_id: c.turn_id } : {}),
      data: c.data,
    }, c.at);
  }

  async function journalBytes(): Promise<number | undefined> {
    const read = (async () => {
      let total = 0;
      // One directory per session (journal-dir.ts); lstat: a link a session planted is not measured.
      for (const n of await readdir(o.journals)) {
        if (!isSessionId(n)) continue;
        const st = await lstat(journalIn(o.journals, n)).catch(() => undefined);
        if (st?.isFile()) total += st.size;
      }
      return total;
    })().catch(() => undefined);
    const late = new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000).unref?.());
    return Promise.race([read, late]);
  }

  /** Gauges now, on a v4 host only. */
  async function sample() {
    const g = gauges();
    if (!g.v4) return;
    const bytes = await journalBytes();
    t.emit('api.sample', {
      data: {
        host_protocol: 4,
        open_journals: g.runnerWriters + g.hostWriters,
        runner_writers: g.runnerWriters,
        host_writers: g.hostWriters,
        ...(bytes !== undefined ? { journal_bytes: bytes } : {}),
        mirror_spooled_bytes: g.mirrorSpooledBytes,
        mirror_unacked_max: mirror.unackedMax(),
        held_frames: g.heldFrames,
      },
    });
  }

  const timer = setInterval(() => void sample().catch(() => {}), o.intervalMs ?? 60_000);
  timer.unref?.();

  return {
    mirror,
    wire,
    sample,
    /** api-host's gauges, read at each sample. */
    setGauges(fn: () => ApiGauges) {
      gauges = fn;
    },
    /** A frame of `sessionId` was held for an epoch adoption; the returned function says it went (`api.held`). */
    held(sessionId: string): () => void {
      const t0 = now();
      return () => t.emit('api.held', { session_key: sessionId, duration_ms: Math.max(0, now() - t0), data: { asked: asked.has(sessionId) } });
    },
    /** The host asked the gateway for `sessionId`'s epoch frame (its held frames waited past the deadline). */
    asked(sessionId: string) {
      asked.add(sessionId);
    },
    /** A runner frame at an epoch below the known one was dropped (`api.stale_epoch`, once per session and epoch). */
    staleDrop(sessionId: string, epoch: number, known: number) {
      if (staleSeen.get(sessionId) === epoch) return;
      staleSeen.set(sessionId, epoch);
      if (staleSeen.size > 1000) staleSeen.delete(staleSeen.keys().next().value as string);
      t.emit('api.stale_epoch', { session_key: sessionId, data: { epoch, known } });
    },
    adopted(a: Adoption) {
      if (a.ok) asked.delete(a.sessionId);
      t.emit('api.epoch_adopted', {
        session_key: a.sessionId,
        duration_ms: a.ms,
        outcome: a.ok ? 'completed' : 'failed',
        data: { epoch: a.epoch, start_seq: a.startSeq, tail_events: a.tailEvents, torn: a.torn, held_frames: a.heldFrames, retired_runner: a.retiredRunner, attempt: a.attempt },
      });
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export type ApiMeter = ReturnType<typeof apiMeter>;
