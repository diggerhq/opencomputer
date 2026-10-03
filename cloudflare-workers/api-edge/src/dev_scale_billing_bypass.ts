export interface DevScaleBillingBypassEnv {
  WORKER_ENV?: string;
  DEV_SCALE_BILLING_BYPASS_ORG_ID?: string;
  DEV_SCALE_BILLING_BYPASS_AGENT_ID?: string;
}

export const DEV_SCALE_ADMISSION_HEADER = "x-opencomputer-scale-admission";
export const DEV_SCALE_ADMISSION_VALUE = "create-only-v1";

/**
 * A deliberately narrow escape hatch for the mo-dev durable-admission test.
 * Production and ordinary session creates remain on the billing path even if
 * only some of this configuration is copied accidentally.
 */
export async function shouldBypassDevScaleBilling(
  request: Request,
  env: DevScaleBillingBypassEnv,
  orgID: string,
): Promise<boolean> {
  if (env.WORKER_ENV !== "mo-dev") return false;
  if (!env.DEV_SCALE_BILLING_BYPASS_ORG_ID || !env.DEV_SCALE_BILLING_BYPASS_AGENT_ID) {
    return false;
  }
  if (orgID !== env.DEV_SCALE_BILLING_BYPASS_ORG_ID) return false;
  if (request.headers.get(DEV_SCALE_ADMISSION_HEADER) !== DEV_SCALE_ADMISSION_VALUE) {
    return false;
  }
  try {
    const body = (await request.clone().json()) as { agentId?: unknown };
    return body.agentId === env.DEV_SCALE_BILLING_BYPASS_AGENT_ID;
  } catch {
    return false;
  }
}
