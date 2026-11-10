// The Computer DO's computer-API telemetry (work 084 instrumentation; the contract is
// /tmp/build084/instrumentation-catalog.md, "blue and edge"). ComputerSessionsApi and
// ComputerKeys call one-line hooks here; this class keeps the event shapes out of them.
//
// Dumb dump (2026-10-26): one event per real unit of work, no in-memory sums, histograms or
// windows; Tinybird aggregates.
//
//   sessionlog.append    per journal batch appended to a SessionLog (Q2, Q3 commit lag)
//   sessionlog.recovery  per 4010 gap close, stale-epoch resend, recover-alarm decision,
//                        recovery, epoch send and tail-read retry (Q6)
//   computer.write       per API write sent to the host: held, idempotent replay, time to answer (Q6, Q8)
//   computer.unavailable per outage: the first 503 computer_unavailable → the host's hello (Q4)
//   ticket.minted        per ticket request: minted or why not, and the time (Q5)
//   keys.synced, keys.revoked  per key write to KV and per revoke (Q9)
//
// Invariants:
// - The batch is the unit, never the journal event: `journaled` is one event whatever the batch holds.
// - No hook throws, awaits or delays the work it measures: `emit` writes into the DO's open
//   telemetry batch (batch.ts: one POST per window, via `waitUntil`), and every hook catches its own failure.
// - Ids only (org, cs_, turn, key id); never content, a key's secret or hash, or a ticket.
// - The only state: when the current outage's first 503 went (a timestamp, not a counter).

import type { AppendResult } from "../session-log-contract.js";
import type { EventName } from "./catalog.js";
import type { EventFields, Telemetry } from "./emitter.js";

/** Hands `write` an emitter whose batch is sent later (the DO's open batch, through `waitUntil`). */
export type EmitTelemetry = (write: (t: Telemetry) => void) => void;

export type ApiSurface = "slack" | "api" | "cli";

/** The surface of a session row's origin (`origin_type`): opc is the CLI. */
export function surfaceOfOrigin(originType: string | null | undefined): ApiSurface {
  return originType === "slack" ? "slack" : originType === "opc" ? "cli" : "api";
}

const TURN_ENDINGS = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);

/** The parts of a journal event the batch's event reads. */
export interface JournaledEvent {
  turnId: string | null;
  type: string;
  createdAt: string;
}

export interface JournaledBatch {
  sessionId: string;
  epoch: number;
  events: readonly JournaledEvent[];
  /** The DO → SessionLog `append` round trip, ms. */
  appendMs: number;
  /** Frame received → this batch's turn on the session's chain (earlier batches still appending), ms. */
  chainWaitMs?: number;
  /** Frame received → the append RPC sent (chain wait and the epoch read), ms. */
  preMs?: number;
  /** The append answered → the row updated and the ack sent, ms. */
  postMs?: number;
  /** Frame received → ack sent; absent when not acked. */
  ackMs?: number;
  result: AppendResult;
}

/** The Slack queue at a moment: rows pending or running, and how long the oldest pending one has waited. */
export interface SlackQueueNow {
  rows: number;
  oldestMs: number | null;
}

export type RecoveryKind = "gap_4010" | "stale_epoch" | "recover_alarm" | "session_recovered" | "epoch_sent" | "tail_retry";

export interface ApiTelemetryOptions {
  emit: EmitTelemetry;
  /** The session's surface (a row read). */
  surfaceOf: (sessionId: string) => ApiSurface;
  /** The DO's Slack queue now (one COUNT over a small table); absent outside the DO. */
  slackQueue?: () => SlackQueueNow;
  now?: () => number;
}

export class ApiTelemetry {
  private readonly now: () => number;
  /** When the current outage's first 503 computer_unavailable went. */
  private outageAt: number | null = null;

  constructor(private readonly o: ApiTelemetryOptions) {
    this.now = o.now ?? Date.now;
  }

  /**
   * One journal batch's append (Q2, Q3): `sessionlog.append`. Commit lag is the runner's
   * `createdAt` → now (after the SessionLog answered), so it carries the two clocks' skew.
   */
  journaled(batch: JournaledBatch): void {
    try {
      const now = this.now();
      const r = batch.result;
      let lagMax = 0;
      let lagMin = Number.POSITIVE_INFINITY;
      let ended = false;
      const turns = new Set<string>();
      for (const e of batch.events) {
        if (e.turnId) turns.add(e.turnId);
        if (TURN_ENDINGS.has(e.type)) ended = true;
        const at = Date.parse(e.createdAt);
        if (Number.isFinite(at)) {
          lagMax = Math.max(lagMax, now - at);
          lagMin = Math.min(lagMin, now - at);
        }
      }
      const st = r.ok ? r.stats : undefined;
      const turnId = turns.size === 1 ? [...turns][0]! : undefined;
      this.one("sessionlog.append", {
        surface: this.o.surfaceOf(batch.sessionId),
        session_key: batch.sessionId,
        ...(turnId ? { turn_id: turnId } : {}),
        duration_ms: Math.round(batch.appendMs),
        outcome: r.ok ? "completed" : "failed",
        ...(r.ok ? {} : { error_type: "unknown" as const, error_code: r.reason }),
        data: {
          epoch: batch.epoch,
          events: batch.events.length,
          turns: turns.size,
          ended,
          append_ms: Math.round(batch.appendMs),
          commit_lag_ms_max: Math.max(0, Math.round(lagMax)),
          commit_lag_ms_min: Number.isFinite(lagMin) ? Math.max(0, Math.round(lagMin)) : 0,
          ...(r.ok ? {} : { refused: r.reason }),
          ...ms("do_chain_wait_ms", batch.chainWaitMs),
          ...ms("do_pre_ms", batch.preMs),
          ...ms("do_post_ms", batch.postMs),
          ...ms("do_ack_ms", batch.ackMs),
          ...this.queue(),
          ...(st
            ? {
                store_ms: Math.round(st.storeMs),
                rows: st.rows,
                dupes: st.dupes,
                mismatches: st.mismatches,
                bytes: st.bytes,
                spills_sync: st.syncSpills,
                spill_sync_bytes: st.syncSpillBytes,
                spill_sync_ms: Math.round(st.syncSpillMs),
                spills_due: st.spillsDue,
                refolded: st.refolded,
                refold_ms: Math.round(st.refoldMs),
                storage_bytes: st.storageBytes,
              }
            : {}),
        },
      });
    } catch {
      // Telemetry never fails the journal.
    }
  }

  // ---------------------------------------------------------------- rare events

  /** One recovery-path occurrence (Q6). */
  recovery(kind: RecoveryKind, fields: { sessionId?: string; reason?: string; ms?: number; ok?: boolean; data?: Record<string, number | boolean | string> } = {}): void {
    this.one("sessionlog.recovery", {
      ...(fields.sessionId ? { session_key: fields.sessionId } : {}),
      ...(fields.ms !== undefined ? { duration_ms: Math.round(fields.ms) } : {}),
      ...(fields.ok !== undefined ? { outcome: fields.ok ? "completed" : "failed" } : {}),
      data: { kind, ...(fields.reason ? { reason: fields.reason } : {}), ...fields.data },
    });
  }

  /** One API write sent (or not) to the host (Q6 held writes, Q8 the gateway's share). */
  write(fields: {
    sessionId: string;
    surface: ApiSurface;
    method: string;
    hostMs: number;
    /** In the DO before the frame went to the host, beyond any hold. */
    doMs?: number;
    held: boolean;
    heldMs: number;
    replayed: boolean;
    timedOut: boolean;
    errorCode?: string;
  }): void {
    this.one("computer.write", {
      surface: fields.surface,
      session_key: fields.sessionId,
      duration_ms: Math.round(fields.hostMs),
      outcome: fields.errorCode ? "failed" : "completed",
      ...(fields.errorCode ? { error_type: fields.timedOut ? "timeout" : "unknown", error_code: errorCode(fields.errorCode) } : {}),
      data: {
        method: fields.method,
        held: fields.held,
        held_ms: Math.round(fields.heldMs),
        replayed: fields.replayed,
        timed_out: fields.timedOut,
        ...ms("do_ms", fields.doMs),
        ...this.queue(),
      },
    });
  }

  /** A 503 computer_unavailable: the first one opens an outage (each is also its request's `httpapi.request`). */
  unavailable(): void {
    if (this.outageAt === null) this.outageAt = this.now();
  }

  /** The host said hello: the outage (if any) ends with `computer.unavailable`. */
  hostBack(): void {
    const at = this.outageAt;
    if (at === null) return;
    this.outageAt = null;
    const wait = Math.max(0, Math.round(this.now() - at));
    this.one("computer.unavailable", { duration_ms: wait, data: { wait_ms: wait } });
  }

  /** One ticket request (Q5): minted, or the refusal's reason. */
  ticket(fields: { surface: ApiSurface; ms: number; result: string; sessions?: number; keyWritten?: boolean }): void {
    this.one("ticket.minted", {
      surface: fields.surface,
      duration_ms: Math.round(fields.ms),
      outcome: fields.result === "minted" ? "completed" : "failed",
      ...(fields.result === "minted" ? {} : { error_type: "unknown", error_code: errorCode(fields.result) }),
      data: { result: fields.result, ...(fields.sessions !== undefined ? { sessions: fields.sessions } : {}), ...(fields.keyWritten !== undefined ? { key_written: fields.keyWritten } : {}) },
    });
  }

  /** One key written to KV (Q9). `trigger`: sync (the dashboard) | observe (a request) | ensure (a ticket) | rewrite (a new tunnel). */
  keySynced(fields: { keyId: string; trigger: "sync" | "observe" | "ensure" | "rewrite"; ms: number; ok: boolean; kvWrites: number }): void {
    this.one("keys.synced", {
      duration_ms: Math.round(fields.ms),
      outcome: fields.ok ? "completed" : "failed",
      ...(fields.ok ? {} : { error_type: "unknown" }),
      data: { key_id: fields.keyId, trigger: fields.trigger, ok: fields.ok, kv_writes: fields.kvWrites },
    });
  }

  /** One revoke (Q9): `known` the computer had the key; `host_told` a v4 host was sent `revoked`. */
  keyRevoked(fields: { keyId: string; ms: number; known: boolean; hostTold: boolean; ok: boolean }): void {
    this.one("keys.revoked", {
      duration_ms: Math.round(fields.ms),
      outcome: fields.ok ? "completed" : "failed",
      ...(fields.ok ? {} : { error_type: "unknown" }),
      data: { key_id: fields.keyId, known: fields.known, host_told: fields.hostTold },
    });
  }

  /** The Slack queue's rows waiting now: does this work run while Slack messages wait on the same DO? */
  private queue(): Record<string, number> {
    try {
      const q = this.o.slackQueue?.();
      if (!q) return {};
      return { slack_queue_rows: q.rows, ...(q.oldestMs !== null ? { slack_queue_oldest_ms: Math.max(0, Math.round(q.oldestMs)) } : {}) };
    } catch {
      return {};
    }
  }

  private one<N extends EventName>(name: N, fields: EventFields<N>): void {
    try {
      this.o.emit((t) => t.emit(name, fields));
    } catch {
      // Never into the DO.
    }
  }
}

/** A duration field, whole ms, when measured. */
function ms(name: string, value: number | undefined): Record<string, number> {
  return value === undefined || !Number.isFinite(value) ? {} : { [name]: Math.max(0, Math.round(value)) };
}

/** An API error code as the validator takes it (`[a-z][a-z0-9_.]*`); anything else is `other`. */
function errorCode(code: string): string {
  return /^[a-z][a-z0-9_.]{0,63}$/.test(code) ? code : "other";
}
