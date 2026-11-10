// Runtime billing for computer sessions (work 052): a session's working time
// is billed to the same `agent_runtime` usage as a serverless agent session
// (2026-10-11: "time it according to session time or working time,
// same as agent runtime which serverless agents perform").
//
// Working time is from a report of `starting` or `busy` until the next
// `idle`, `stopped` or `error` report for that session, or until the host's
// socket goes away (closed, replaced by a reconnect, or found missing by the
// checkpoint). Idle and parked time are never billed: nothing runs then, and
// a parked computer has no host to report anything.
//
// Rows, in the ComputerDurableObject's SQLite:
//   runtime_open      one per session working now: its segment, when the
//                     current piece started, and the piece number
//   runtime_segments  closed pieces, each delivered once to the public edge
//                     (src/edge/runtime-usage.ts), retried with backoff
//
// A long turn bills progressively: every CHECKPOINT_MS the open piece is
// closed and the next one starts where it ended, so an hour-long turn is
// twelve five-minute charges rather than one at the end (and a lost Durable
// Object never loses more than one piece). A piece's ID is
// `<segment>:<piece>`, written with ON CONFLICT DO NOTHING and posted as the
// idempotency key, so neither a repeated close nor a retried delivery bills
// twice.
//
// Warm pool computers (`pool-…`) never bill: the caller says so through
// `billable()`, and nothing opens.

import {
  type AgentRuntimeUsage,
  type AgentRuntimeUsageConfig,
  agentRuntimeUsageConfigured,
  agentRuntimeUsageRetryAt,
  postAgentRuntimeUsage,
} from "../edge/runtime-usage.js";
import type { CalvinSessionStatus } from "./protocol.js";

/** How long a working piece runs before it is closed and billed, and the next one opened. */
export const CHECKPOINT_MS = 5 * 60_000;

export type RuntimeCloseReason = "idle" | "stopped" | "error" | "host_disconnected" | "host_reconnected" | "checkpoint";

export const RUNTIME_BILLING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS runtime_open (
    runner_key TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL,
    piece INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runtime_segments (
    id TEXT PRIMARY KEY,
    runner_key TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    quantity_seconds INTEGER NOT NULL,
    close_reason TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    next_delivery_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runtime_segments_pending ON runtime_segments (delivery_status, next_delivery_at);
`;

export interface RuntimeSegment {
  id: string;
  runnerKey: string;
  startedAt: number;
  endedAt: number;
  quantitySeconds: number;
  closeReason: RuntimeCloseReason;
  deliveryStatus: "pending" | "delivered";
  deliveryAttempts: number;
}

export interface ComputerRuntimeBillingDeps {
  sql: SqlStorage;
  /** False for warm pool computers and objects not bound to an organization: nothing opens. */
  billable: () => boolean;
  /** Attribution for one segment, as the edge's usage endpoint wants it. */
  usage: (segment: RuntimeSegment) => Omit<AgentRuntimeUsage, "quantitySeconds" | "startedAtMs" | "endedAtMs" | "closeReason" | "idempotencyKey">;
  config: () => AgentRuntimeUsageConfig;
  fetcher?: typeof fetch;
}

type OpenRow = { key: string; segmentId: string; piece: number; startedAt: number };

const WORKING: ReadonlySet<CalvinSessionStatus> = new Set(["starting", "busy"]);

export class ComputerRuntimeBilling {
  constructor(private readonly deps: ComputerRuntimeBillingDeps) {
    deps.sql.exec(RUNTIME_BILLING_SCHEMA);
  }

  /** A session report: working statuses open a segment (once), the others close it. */
  report(key: string, status: CalvinSessionStatus, at: number): void {
    if (WORKING.has(status)) this.open(key, at);
    else this.close(key, status as RuntimeCloseReason, at);
  }

  /** Every working session stops being billed: the host is gone or starting over. */
  closeAll(reason: RuntimeCloseReason, at: number): void {
    for (const row of this.openRows()) this.close(row.key, reason, at);
  }

  /** Closes and bills every piece that has run CHECKPOINT_MS, and starts the next one where it ended. */
  checkpoint(at: number): void {
    for (const row of this.openRows()) {
      if (at - row.startedAt < CHECKPOINT_MS) continue;
      this.closePiece(row, "checkpoint", at);
      this.deps.sql.exec("UPDATE runtime_open SET piece = ?, started_at = ? WHERE runner_key = ?", row.piece + 1, at, row.key);
    }
  }

  /** Sessions being billed now. */
  working(): string[] {
    return this.openRows().map((row) => row.key);
  }

  /** When the alarm should next look: a checkpoint, or a pending delivery (only when delivery is configured). */
  nextDueAt(): number | null {
    const sql = this.deps.sql;
    const open = [...sql.exec<{ at: number | null }>("SELECT MIN(started_at) AS at FROM runtime_open")][0]?.at;
    const pending = agentRuntimeUsageConfigured(this.deps.config())
      ? [...sql.exec<{ at: number | null }>("SELECT MIN(next_delivery_at) AS at FROM runtime_segments WHERE delivery_status = 'pending'")][0]?.at
      : null;
    const candidates = [open === null || open === undefined ? null : open + CHECKPOINT_MS, pending ?? null].filter(
      (at): at is number => at !== null,
    );
    return candidates.length ? Math.min(...candidates) : null;
  }

  /** Posts due segments to the edge; failures wait their backoff. Returns how many were delivered. */
  async deliver(now: number): Promise<number> {
    const config = this.deps.config();
    if (!agentRuntimeUsageConfigured(config)) return 0;
    const due = this.segments(`WHERE delivery_status = 'pending' AND next_delivery_at <= ? ORDER BY created_at, id LIMIT 20`, now);
    let delivered = 0;
    for (const segment of due) {
      try {
        await postAgentRuntimeUsage(
          config,
          {
            ...this.deps.usage(segment),
            quantitySeconds: segment.quantitySeconds,
            startedAtMs: segment.startedAt,
            endedAtMs: segment.endedAt,
            closeReason: segment.closeReason,
            idempotencyKey: segment.id,
          },
          this.deps.fetcher,
        );
        this.deps.sql.exec("UPDATE runtime_segments SET delivery_status = 'delivered', last_error = NULL WHERE id = ?", segment.id);
        delivered += 1;
      } catch (error) {
        const attempts = segment.deliveryAttempts + 1;
        this.deps.sql.exec(
          "UPDATE runtime_segments SET delivery_attempts = ?, next_delivery_at = ?, last_error = ? WHERE id = ?",
          attempts,
          agentRuntimeUsageRetryAt(attempts, Date.now()),
          (error instanceof Error ? error.message : String(error)).slice(0, 500),
          segment.id,
        );
        console.warn(JSON.stringify({ level: "warn", event: "computer.runtime_usage_delivery_failed", segmentId: segment.id, attempts }));
      }
    }
    // Delivered rows are history only; keep a month for operators.
    this.deps.sql.exec("DELETE FROM runtime_segments WHERE delivery_status = 'delivered' AND created_at < ?", now - 30 * 24 * 3600_000);
    return delivered;
  }

  /** Closed segments, oldest first (operators and tests). */
  segments(where = "ORDER BY created_at, runner_key, id", ...binds: unknown[]): RuntimeSegment[] {
    return [...this.deps.sql.exec<{
      id: string;
      runnerKey: string;
      startedAt: number;
      endedAt: number;
      quantitySeconds: number;
      closeReason: RuntimeCloseReason;
      deliveryStatus: "pending" | "delivered";
      deliveryAttempts: number;
    }>(
      `SELECT id, runner_key AS runnerKey, started_at AS startedAt, ended_at AS endedAt, quantity_seconds AS quantitySeconds,
              close_reason AS closeReason, delivery_status AS deliveryStatus, delivery_attempts AS deliveryAttempts
       FROM runtime_segments ${where}`,
      ...binds,
    )].map((row) => ({ ...row, startedAt: Number(row.startedAt), endedAt: Number(row.endedAt), quantitySeconds: Number(row.quantitySeconds), deliveryAttempts: Number(row.deliveryAttempts) }));
  }

  private open(key: string, at: number): void {
    if (!this.deps.billable()) return;
    this.deps.sql.exec(
      "INSERT OR IGNORE INTO runtime_open (runner_key, segment_id, piece, started_at) VALUES (?, ?, 0, ?)",
      key,
      `crt_${crypto.randomUUID().replaceAll("-", "")}`,
      at,
    );
  }

  private close(key: string, reason: RuntimeCloseReason, at: number): void {
    const row = this.openRows(key)[0];
    if (!row) return;
    this.closePiece(row, reason, at);
    this.deps.sql.exec("DELETE FROM runtime_open WHERE runner_key = ?", key);
  }

  private closePiece(row: OpenRow, reason: RuntimeCloseReason, at: number): void {
    const endedAt = Math.max(row.startedAt, at);
    this.deps.sql.exec(
      `INSERT INTO runtime_segments (id, runner_key, started_at, ended_at, quantity_seconds, close_reason, next_delivery_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      `${row.segmentId}:${row.piece}`,
      row.key,
      row.startedAt,
      endedAt,
      // Like the session lease: whole seconds, rounded up, at least one.
      Math.max(1, Math.ceil((endedAt - row.startedAt) / 1_000)),
      reason,
      endedAt,
      endedAt,
    );
  }

  private openRows(key?: string): OpenRow[] {
    const query = "SELECT runner_key AS key, segment_id AS segmentId, piece, started_at AS startedAt FROM runtime_open";
    const rows = key === undefined ? this.deps.sql.exec<OpenRow>(query) : this.deps.sql.exec<OpenRow>(`${query} WHERE runner_key = ?`, key);
    return [...rows].map((row) => ({ ...row, piece: Number(row.piece), startedAt: Number(row.startedAt) }));
  }
}
