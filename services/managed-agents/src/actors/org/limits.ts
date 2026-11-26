// Org's limits and timings (spec 44).

export const FEED_ROWS_MAX = 2_000;
export const PUSH_BYTES_MAX = 256 * 1024;
export const DAY_MS = 24 * 60 * 60 * 1_000;
export const RETAIN_MS = 30 * DAY_MS;
export const IDEM_TTL_MS = DAY_MS;
export const AGENT_THREADS_MAX = 10;

/** A wake waits this long for more of the same target's occurrences, then goes as one turn. */
export const WAKE_DEBOUNCE_MS = 20_000;
/**
 * A wake's or a Slack echo's waits between tries; past the last it goes to the dead list. Short, so
 * one that keeps failing holds its group minutes, not hours.
 */
export const NOTICE_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000];
