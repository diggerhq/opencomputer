// Delivery's contract (tracks and threads, spec sections 35.3, 36.5 and 40.6): what Delivery's
// callers pass. `poke` and `status` are in ../actor/contracts.ts.

import type { OrgRpc } from "../actor/contracts.js";

export const DELIVERY_KINDS = ["wake", "slack"] as const;

/** The kinds of occurrence that wake a track's agent or a parent session (section 40.6). */
export const WAKE_KINDS = ["turn.completed", "turn.failed", "ask.opened", "result.changed", "thread.done", "thread.placed", "track.quiet"];
/** The kinds the Slack echo acts on; every other is passed over. */
export const SLACK_KINDS = ["turn.refused", "machine.changed"];

export const PAGE = 100;
export const POLL_MS = 60_000;
export const WAKE_DEBOUNCE_MS = 20_000;
/**
 * A wake's or a Slack echo's waits between tries; past the last it goes to the dead list (section
 * 18.6). Short, so one that keeps failing holds its group minutes, not hours.
 */
export const RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000];
/**
 * What Delivery(wake) asks of Org beyond ../actor/contracts.ts: the sessions occurrence `n` wakes,
 * its thread's track's agent and its parent, before the rule that an agent is not woken by its own act.
 */
export interface OrgForDelivery extends OrgRpc {
  wakeTargets(n: number): Promise<string[]>;
}
