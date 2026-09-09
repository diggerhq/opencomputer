// Which runtime serves a create, and how a customer moves between them.
//
// Before this, the answer was one D1 column: orgs.runtime, set by us, one org
// at a time. That works for a handful of design partners and does not work for
// a migration — every customer who wants to move has to ask, and every customer
// we move has to be moved back by hand if it goes badly.
//
// So the column now expresses a PIN, and the calling SDK's major version
// decides for everyone who is not pinned:
//
//   orgs.runtime = 'microvm'  ->  MicroVM, whatever SDK is calling
//   orgs.runtime = 'qemu'     ->  QEMU, whatever SDK is calling
//   orgs.runtime NULL or ''   ->  the SDK decides: 1.x+ MicroVM, 0.x QEMU
//
// The unpinned case is the new one and it is the whole point: `npm i
// @opencomputer/sdk@1` is the migration, and pinning the previous major is the
// rollback. Neither needs us.
//
// The pins are not vestigial. 'microvm' is how an org that has FINISHED
// migrating stays migrated even when one script in their fleet is still on an
// old version — without it, a single stale dependency would quietly start
// creating sandboxes on the other runtime, against templates that do not exist
// there. 'qemu' is the opt-out for an org that needs something MicroVM does not
// have yet (checkpoints, fork) and should not be moved by upgrading a package.

/**
 * Header the SDK sends its own version in (sdks/typescript/src/version.ts).
 * Duplicated rather than imported: the Worker does not depend on the SDK
 * package, and runtime_gate.test.ts pins the string on this side.
 */
export const SDK_VERSION_HEADER = "x-oc-sdk-version";

/** orgs.runtime value routing to the AWS MicroVM backend. */
export const RUNTIME_MICROVM = "microvm";

/** orgs.runtime value pinning an org to the QEMU worker fleet. */
export const RUNTIME_QEMU = "qemu";

/**
 * Default major at which an SDK routes to MicroVM.
 *
 * 1, because every version @opencomputer/sdk has ever published is 0.x — so the
 * first stable release is also, for free, an exact split between "everything
 * that exists today" and "the new one". The docs call this platform generation
 * v2; the package major is 1. They are not the same number and nothing here
 * should assume they are.
 *
 * Overridable (SDK_RUNTIME_MIN_MAJOR) because the version this ships under is a
 * release decision that can change after this code is written, and getting it
 * wrong should cost an env var rather than a re-release of the SDK.
 */
export const DEFAULT_MIN_SDK_MAJOR = 1;

/**
 * Major version from the SDK's x-oc-sdk-version header, or 0.
 *
 * 0 for absent, malformed, or non-numeric — every one of which means "an SDK
 * that does not announce itself", which is exactly the population that must
 * keep landing on QEMU. Unparseable input therefore has to fail toward the old
 * runtime, never toward the new one.
 */
export function sdkMajor(header: string | null | undefined): number {
  if (!header) return 0;
  const major = Number.parseInt(header.trim().split(".")[0] ?? "", 10);
  // A 0.x SDK reports 0, which is also what an unreadable header reports. That
  // is deliberate and not a collision worth removing: both mean "not a caller we
  // route to MicroVM", and the threshold is >= 1.
  return Number.isFinite(major) && major > 0 ? major : 0;
}

export interface RuntimeGateEnv {
  /** "0" disables SDK-version routing; every unpinned org stays on QEMU. */
  SDK_RUNTIME_GATE?: string;
  /** Major at and above which an SDK routes to MicroVM. Default 2. */
  SDK_RUNTIME_MIN_MAJOR?: string;
}

function minMajor(env: RuntimeGateEnv): number {
  const configured = Number.parseInt(env.SDK_RUNTIME_MIN_MAJOR ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MIN_SDK_MAJOR;
}

/**
 * The runtime this create belongs on: "microvm", "qemu", or "" (the QEMU
 * fleet, unstated — what the cap token has always carried for an unset org).
 *
 * "" and "qemu" are both the fleet and are deliberately NOT collapsed: the
 * value is echoed into the capability token, and rewriting an org's unset
 * runtime to an explicit "qemu" would make the token claim a decision nobody
 * made. Only the MicroVM answer is ever synthesised here.
 */
export function effectiveRuntime(
  env: RuntimeGateEnv,
  orgRuntime: string | null | undefined,
  sdkVersionHeader: string | null | undefined,
): string {
  const pinned = (orgRuntime ?? "").trim();
  if (pinned) return pinned; // pin wins, in both directions
  if (env.SDK_RUNTIME_GATE === "0") return "";
  return sdkMajor(sdkVersionHeader) >= minMajor(env) ? RUNTIME_MICROVM : "";
}

// ── which runtime an EXISTING sandbox is on ──────────────────────────────────

// Prefixes internal/api/microvm_common.go writes into sandboxes_index.worker_id
// (microvmWorkerPrefix and legacyWorkerPrefix). A sandbox's worker_id names the
// box that holds it, so it is the only per-sandbox record of which runtime that
// sandbox actually landed on — D1 has no runtime column on the sandbox row.
const MICROVM_WORKER_PREFIXES = ["vmhost:", "microvm:"];

/**
 * Whether an existing sandbox is MicroVM-backed, from its worker_id.
 *
 * Routing a request for a LIVE sandbox by its org's runtime was correct only
 * while an org was entirely on one runtime. Under SDK-version routing a mixed
 * org is the steady state, not a migration window — the same org creates
 * MicroVM sandboxes from a v2 service and QEMU sandboxes from a v1 one, for as
 * long as the migration takes. Asking the sandbox rather than the org is what
 * keeps both working: a QEMU box never gets dialled as if it had a MicroVM
 * proxy, and a MicroVM box never pays the VmSession DO's 400ms entry grace
 * waiting for a channel that cannot exist.
 *
 * `undefined` (worker_id not yet known — an in-flight create, or a route cached
 * before this field was recorded) returns false, which routes through the
 * generic path. That path works for both runtimes; it is merely slower.
 */
export function isMicrovmWorkerID(workerID: string | null | undefined): boolean {
  if (!workerID) return false;
  return MICROVM_WORKER_PREFIXES.some((p) => workerID.startsWith(p));
}
