/**
 * Why a computer ended `failed` (work 111). The lifecycle names the reason
 * where it fails the computer; the dashboard, the Slack notice, the
 * operator's status and the logs all read the code, and none parses the
 * error's text.
 */

/**
 * Each a distinction somebody acts on differently:
 * - `capacity`: every placement was refused for capacity or quota.
 * - `unavailable`: calls to the cloud kept failing in a way worth retrying.
 * - `inconsistent`: a resource is not what the row says (another owner's tag, another zone, gone).
 * - `not_configured`: settings are missing.
 * - `internal`: anything else, a refusal by the cloud or a bug.
 */
export const FAILURE_CODES = ["capacity", "unavailable", "inconsistent", "not_configured", "internal"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

interface FailureCopy {
  /** What happened, whose side it is on and that the files are safe: no cloud, region, size or resource names. */
  message: string;
  /** What the person can do, on the Computer page (which has the button to try again). */
  next: string;
  /** The same in a Slack thread; `PAGE` stands for where the Computer page is. */
  nextInSlack: string;
}

const OURS = "This is on our side, not your plan or billing, and your files are safe.";
const PAGE = "{page}";

const COPY: Record<FailureCode, FailureCopy> = {
  // A customer read a terser sentence as an unpaid bill (work 106).
  capacity: {
    message: `Our cloud provider has no machine free for your computer right now. ${OURS}`,
    next: "Try again later.",
    nextInSlack: `Open ${PAGE} to try again later.`,
  },
  unavailable: {
    message: `We could not start your computer because of a temporary problem. ${OURS}`,
    next: "Try again in a few minutes.",
    nextInSlack: `Open ${PAGE} to try again in a few minutes.`,
  },
  inconsistent: {
    message: `Your computer's resources are in a state we did not expect. ${OURS}`,
    next: "Trying again will not fix it: contact support.",
    nextInSlack: "Trying again will not fix it: contact support.",
  },
  not_configured: { message: "Computers are not available yet.", next: "", nextInSlack: "" },
  internal: {
    message: `Your computer could not start because of a problem we did not expect. ${OURS}`,
    next: "Try again, and contact support if it keeps happening.",
    nextInSlack: `Open ${PAGE} to try again, and contact support if it keeps happening.`,
  },
};

/** A code this version does not know (a newer one wrote it), or none: the general sentence. */
function copy(code: string | null): FailureCopy {
  return COPY[(FAILURE_CODES as readonly string[]).includes(code ?? "") ? (code as FailureCode) : "internal"];
}

/** The dashboard's sentence for a failed computer. */
export function failureMessage(code: string | null): string {
  const { message, next } = copy(code);
  return [message, next].filter(Boolean).join(" ");
}

/** What a thread is told, once, when its message waits on a failed computer. `origin`: the dashboard's. */
export function failureNotice(code: string | null, origin: string): string {
  const { message, nextInSlack } = copy(code);
  const page = `the Computer page on ${origin.replace(/^https?:\/\//, "")}`;
  return [message, "Your message is waiting.", nextInSlack.replace(PAGE, page)].filter(Boolean).join(" ");
}
