// When a computer parks (work 052, decision 10). Free organizations park
// after 30 minutes (COMPUTER_PARK_AFTER_MINUTES) with no running session and
// no message (2026-10-11); paid ones never
// park. A free organization in its trial stays on like a paid one until the
// trial ends, and once billing refuses it (trial over, credits gone) it parks
// without waiting to be idle (work 092, 2026-10-29).
// Warm pool computers (pool.ts) never park: they exist to be claimed
// ready. Pure: the Durable Object gathers the inputs and acts on the answer.

export const IDLE_PARK_MS = 30 * 60_000;

/** COMPUTER_PARK_AFTER_MINUTES, if it is a whole number of minutes from 5 to 1440; else the default. */
export function idleParkMs(minutes: string | undefined): number {
  const n = Number(minutes);
  return Number.isInteger(n) && n >= 5 && n <= 1440 ? n * 60_000 : IDLE_PARK_MS;
}

export interface ParkingInput {
  plan: "free" | "paid";
  /** Unpaid long enough (unpaidStage `park`): a paid computer parks without waiting to be idle (preview traffic would keep it up forever), only for work in flight. */
  unpaid?: boolean;
  /** A free organization's trial end (epoch ms); before it the computer stays on. */
  trialEndsAt?: number | null;
  /** A free organization billing refuses (trial over, credits gone): it parks without waiting to be idle, only for work in flight. */
  halted?: boolean;
  /** A warm pool computer, not yet claimed. */
  pool?: boolean;
  /** The lifecycle state; only a `ready` computer parks. */
  state: string;
  /** Session statuses are trusted only while the host is connected to report them. */
  hostConnected: boolean;
  /** Sessions whose last report was `starting` or `busy`. */
  busySessions: number;
  /** Deliveries queued or sent and not yet answered. */
  pendingDispatches: number;
  /** Last message, session report or wake. */
  lastActivityAt: number;
  now: number;
  /** How long a free computer stays idle before it parks; default IDLE_PARK_MS. */
  idleMs?: number;
}

/** Whether to park now, and when to look again (null: nothing to look at until something changes). */
export function parkingDecision(input: ParkingInput): { park: boolean; recheckAt: number | null } {
  if (input.state !== "ready" || input.pool) return { park: false, recheckAt: null };
  const idleMs = input.idleMs ?? IDLE_PARK_MS;
  // Plans change: look again later rather than never.
  if (input.plan === "paid" && !input.unpaid) return { park: false, recheckAt: input.now + idleMs };
  const halted = input.plan === "free" && input.halted === true;
  const trialEndsAt = input.trialEndsAt ?? null;
  // In its trial: on until the trial ends, looked at again by then.
  if (input.plan === "free" && !halted && trialEndsAt !== null && input.now < trialEndsAt) {
    return { park: false, recheckAt: Math.min(input.now + idleMs, trialEndsAt) };
  }
  const busy = (input.hostConnected && input.busySessions > 0) || input.pendingDispatches > 0;
  if (busy) return { park: false, recheckAt: input.now + idleMs };
  if (input.unpaid || halted) return { park: true, recheckAt: null };
  const idleUntil = input.lastActivityAt + idleMs;
  if (input.now >= idleUntil) return { park: true, recheckAt: null };
  return { park: false, recheckAt: idleUntil };
}

// Unpaid computers (work 086). A paid organization's
// computer stays on, even halted; once billing has refused it for 7 days its
// VM goes: the computer parks, which deletes the VM and NIC and keeps both
// disks, so it wakes as it was on the first message after payment. The
// installer is warned on day 6, and the VM never goes sooner than a day after
// the warning (a computer first seen past day 7 is warned, then parked a day
// later). Free computers park when idle anyway; nothing changes for them.

const DAY_MS = 24 * 60 * 60_000;
export const UNPAID_WARN_MS = 6 * DAY_MS;
export const UNPAID_PARK_MS = 7 * DAY_MS;
export const UNPAID_NOTICE_MS = DAY_MS;

export interface UnpaidInput {
  /** Since when billing refuses the organization (halted and not on the fallback model); null when it does not. */
  haltedAt: number | null;
  /** When the installer was warned of this halt; null when not yet (a warning for an earlier halt does not count). */
  warnedAt: number | null;
  now: number;
}

/** Where an unpaid computer stands: `warn` the installer now, `park` it now, or nothing yet. */
export function unpaidStage(input: UnpaidInput): "none" | "warn" | "wait" | "park" {
  const { haltedAt, now } = input;
  if (haltedAt === null || now < haltedAt + UNPAID_WARN_MS) return "none";
  const warnedAt = input.warnedAt !== null && input.warnedAt >= haltedAt ? input.warnedAt : null;
  if (warnedAt === null) return "warn";
  return now >= Math.max(haltedAt + UNPAID_PARK_MS, warnedAt + UNPAID_NOTICE_MS) ? "park" : "wait";
}

/**
 * Whether a day-6 warning counts as given: delivered, or nobody to deliver it
 * to (no installer or no bot token: the clock runs without a warning). A
 * known installer whose DM failed is warned again on a later check, and the
 * VM stays until a warning gets through.
 */
export function unpaidWarningGiven(input: { reachable: boolean; sent: boolean }): boolean {
  return input.sent || !input.reachable;
}

/** Whole days since the halt, for `billing.vm_terminated`. */
export function daysUnpaid(haltedAt: number, now: number): number {
  return Math.floor((now - haltedAt) / DAY_MS);
}

/** The installer's day-6 DM. */
export function unpaidWarning(origin: string): string {
  return `:warning: Your organization's computer has been paused for 6 days because billing stopped it. Tomorrow its VM shuts down; its disk is kept, so it comes back as it was once billing is sorted at ${origin}/billing.`;
}
