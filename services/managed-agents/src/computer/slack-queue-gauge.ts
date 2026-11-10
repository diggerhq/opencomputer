// The Slack queue gauge that `sessionlog.append` and `computer.write` carry (work 084
// instrumentation): rows pending or running, and how long the oldest pending row has waited.
// It is read on the journal's hot path, so both reads are index-only on `slack_queue_state`.
// The count walks only the waiting rows, never the up-to-1000 failed ones; the MIN is one
// index seek. test/computer-api-telemetry.test.ts checks the plans with EXPLAIN QUERY PLAN.

import type { SlackQueueNow } from "./telemetry/api.js";

/** Run in the Computer DO's schema setup, after slack_queue exists. */
export const SLACK_QUEUE_STATE_INDEX = "CREATE INDEX IF NOT EXISTS slack_queue_state ON slack_queue (state, available_at)";

export const SLACK_QUEUE_WAITING_SQL = "SELECT COUNT(*) AS n FROM slack_queue WHERE state IN ('pending', 'running')";
export const SLACK_QUEUE_OLDEST_SQL = "SELECT MIN(available_at) AS at FROM slack_queue WHERE state = 'pending'";

export function slackQueueNow(sql: SqlStorage, now = Date.now()): SlackQueueNow {
  const n = [...sql.exec<{ n: number }>(SLACK_QUEUE_WAITING_SQL)][0]?.n ?? 0;
  const at = n > 0 ? ([...sql.exec<{ at: number | null }>(SLACK_QUEUE_OLDEST_SQL)][0]?.at ?? null) : null;
  return { rows: Number(n), oldestMs: at != null ? Math.max(0, now - Number(at)) : null };
}
