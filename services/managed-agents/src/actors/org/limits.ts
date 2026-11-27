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

// Attachments (work 126, section 8): the limits Org owns. The count per message is the edge's and the SDK's.
/** Bytes of one attachment: well under what a store takes in one PUT (5 GiB). */
export const ATTACHMENT_BYTES_MAX = 1024 * 1024 * 1024;
/** Bytes of one session's attachments, counted from the declared size at create so parallel uploads cannot overshoot. */
export const ATTACHMENT_SESSION_BYTES_MAX = 5 * 1024 * 1024 * 1024;
/** Bytes of one organization's attachments; past it `attachment_quota` names `organization`. */
export const ATTACHMENT_ORG_BYTES_MAX = 20 * 1024 * 1024 * 1024;
/** An `uploading` row this old is swept: the common interrupted upload is a laptop that resumes next morning. */
export const ATTACHMENT_UPLOADING_TTL_MS = DAY_MS;
/** A `ready` row this old whose session does not exist in Org is swept (a draft cleared without sending). */
export const ATTACHMENT_ORPHAN_TTL_MS = DAY_MS;
/** A `deleted` row is kept this long so a late reference answers `410`, not `404`. */
export const ATTACHMENT_DELETED_KEEP_MS = RETAIN_MS;
