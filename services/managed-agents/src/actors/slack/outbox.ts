// What the Slack actor owes itself: an item from Slack, processed in its thread's order.

import { owed } from "../../durable/outbox.js";
import { type Sql } from "../../durable/sql.js";

/** A Slack item's waits between tries (five in all), then the dead list. */
const PROCESS_SCHEDULE = [2_000, 4_000, 8_000, 16_000];

/** An item from Slack owed a `process` call, in its thread's order (40.11 step 2), in the caller's transaction. */
export function oweProcess(tx: Sql, threadKey: string, job: unknown): void {
  owed.add(tx, { group: `thread:${threadKey}`, call: "process", body: job, schedule: PROCESS_SCHEDULE });
}

/** A post's waits between tries (a rate limit's Retry-After when longer), about nine minutes in all, then the dead list. */
export const POST_SCHEDULE = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** A Slack Web API call owed in a thread's order (a notice, the status taken off), in the caller's transaction. */
export function owePost(tx: Sql, threadKey: string, method: string, body: Record<string, unknown>): void {
  owed.add(tx, { group: postGroup(threadKey), call: "post", body: { method, body }, schedule: POST_SCHEDULE });
}

/** The owed group of a thread's posts. */
export const postGroup = (threadKey: string): string => `post:${threadKey}`;
