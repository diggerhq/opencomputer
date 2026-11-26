// What the Slack actor owes itself: an item from Slack, processed in its thread's order.

import { owed } from "../../durable/outbox.js";
import { type Sql } from "../../durable/sql.js";

/** A Slack item's waits between tries (five in all), then the dead list. */
const PROCESS_SCHEDULE = [2_000, 4_000, 8_000, 16_000];

/** An item from Slack owed a `process` call, in its thread's order (40.11 step 2), in the caller's transaction. */
export function oweProcess(tx: Sql, threadKey: string, job: unknown): void {
  owed.add(tx, { group: `thread:${threadKey}`, call: "process", body: job, schedule: PROCESS_SCHEDULE });
}
