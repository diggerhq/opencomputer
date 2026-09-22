import { WorkerEntrypoint } from "cloudflare:workers";

import {
  getManagedAgentBillingAdmission,
  type ManagedAgentBillingAdmission,
  type ManagedAgentCreditGateEnv,
} from "./managed_agent_credit_gate";

/** Private RPC surface consumed through a Cloudflare service binding. */
export class ManagedAgentBillingService extends WorkerEntrypoint<ManagedAgentCreditGateEnv> {
  async checkAdmission(orgID: string): Promise<ManagedAgentBillingAdmission> {
    return getManagedAgentBillingAdmission(this.env, orgID);
  }
}
