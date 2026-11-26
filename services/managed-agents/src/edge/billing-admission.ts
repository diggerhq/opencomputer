export interface ManagedAgentBillingAdmission {
  allowed: boolean;
  isHalted: boolean;
  haltedAt: number | null;
  reason: "insufficient_credits" | null;
  /** Pro/Max. Absent from billing services that predate model fallback. */
  paid?: boolean;
  /** "fallback": credits are exhausted on a paid plan. */
  modelAccess?: "full" | "fallback" | null;
  /**
   * The Autumn usage plan: "max" ($200), "pro" ($20, being retired), "base"
   * (free); null when the organization has none. Absent from billing
   * services that predate it.
   */
  usagePlan?: "base" | "pro" | "max" | null;
  /**
   * Why the organization is halted: "credits_exhausted" (the credit rule),
   * "trial_days" | "trial_minutes" | "trial_tokens" (the trial ended),
   * "credits_empty" (a plan's minutes and credits are used), "payment" (past
   * due beyond grace), "lapsed" (no plan). null when not halted. Absent from
   * billing services that predate it.
   */
  haltReason?: string | null;
  /**
   * The limit the organization is about to hit (work 086):
   * "trial_minutes" | "trial_days" | "trial_tokens" | "allowance_80" |
   * "credits_low" | "payment_failed". null when none is near or the
   * organization is halted. Absent from billing services that predate it.
   */
  warning?: string | null;
  /** When the current run of warnings began (unix seconds): with `warning`, one warning to tell once. */
  warningSince?: number | null;
  /** When a free organization's trial ends (unix seconds; may be past); null when paid or no trial. Absent from billing services that predate it. */
  trialEndsAt?: number | null;
}

export interface ManagedModelBilling {
  paid: boolean;
  fallback: boolean;
  /** Halted and not on the fallback: model calls are refused. */
  stopped: boolean;
}

export interface ManagedAgentBillingService {
  checkAdmission(orgID: string): Promise<ManagedAgentBillingAdmission>;
}

export interface AutonomousBillingEnv {
  OPENCOMPUTER_BILLING?: ManagedAgentBillingService;
}

export class AutonomousBillingAdmissionError extends Error {
  constructor(
    readonly code: "insufficient_credits" | "billing_admission_unavailable",
    message: string,
    /** Refused: why the organization is halted, when billing says. */
    readonly haltReason: string | null = null,
  ) {
    super(message);
    this.name = "AutonomousBillingAdmissionError";
  }
}

/**
 * Autonomous sources do not pass through the public API's credit gate. Check
 * the public edge's authoritative D1 projection before creating any session.
 * Development configs without the binding preserve their existing behavior.
 */
export async function requireAutonomousBillingAdmission(
  env: AutonomousBillingEnv,
  orgID: string,
): Promise<void> {
  await autonomousBillingAdmission(env, orgID);
}

/**
 * The same admission, returning what billing answered so a caller can act on
 * more than allowed/denied (the computer notes a paid organization's
 * `modelAccess: "fallback"`). Null: no binding (development), admitted.
 * Throws AutonomousBillingAdmissionError exactly as above.
 */
export async function autonomousBillingAdmission(
  env: AutonomousBillingEnv,
  orgID: string,
): Promise<ManagedAgentBillingAdmission | null> {
  if (!env.OPENCOMPUTER_BILLING) return null;

  let admission: ManagedAgentBillingAdmission;
  try {
    admission = await env.OPENCOMPUTER_BILLING.checkAdmission(orgID);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.admission_unavailable",
        orgId: orgID,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new AutonomousBillingAdmissionError(
      "billing_admission_unavailable",
      "Billing admission is temporarily unavailable",
    );
  }

  if (!admission.allowed) {
    console.log(
      JSON.stringify({
        level: "warn",
        event: "billing.admission_denied",
        orgId: orgID,
        reason: admission.reason,
        haltedAt: admission.haltedAt,
      }),
    );
    throw new AutonomousBillingAdmissionError(
      "insufficient_credits",
      "Insufficient prepaid credits",
      admission.haltReason ?? null,
    );
  }
  return admission;
}

/**
 * Per-dispatch model billing state. Fails open to the org's selected model:
 * the managed key's cap remains the backstop.
 */
export async function managedModelBilling(
  env: AutonomousBillingEnv,
  orgID: string,
): Promise<ManagedModelBilling> {
  if (!env.OPENCOMPUTER_BILLING) return { paid: false, fallback: false, stopped: false };
  try {
    const admission = await env.OPENCOMPUTER_BILLING.checkAdmission(orgID);
    return {
      paid: admission.paid === true,
      fallback: admission.paid === true && admission.modelAccess === "fallback",
      stopped: !admission.allowed,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing.model_access_unavailable",
        orgId: orgID,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { paid: false, fallback: false, stopped: false };
  }
}
