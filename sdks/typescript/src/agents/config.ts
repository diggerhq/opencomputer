import type { Http } from "./http.js";

/** Non-secret bindings and the fail-closed outbound host policy for a Flue agent. */
export interface FlueAgentConfig {
  vars: Record<string, string>;
  egressAllowlist: string[];
  /** True after a config write because vars are baked into the next deployment. */
  deploymentRequired?: boolean;
}

/** Replacement config. Read first when you want merge semantics. */
export interface PutFlueAgentConfigParams {
  vars?: Record<string, string>;
  egressAllowlist?: string[];
}

/** Write-only secret metadata. The value is never returned. */
export interface FlueAgentSecret {
  name: string;
  last4: string;
  updatedAt: string;
  syncStatus: "synced" | "pending_deploy" | "error";
}

/** Flue Worker config and write-only secret bindings (`oc.agents.config`). */
export class AgentConfigResource {
  constructor(private readonly http: Http) {}

  get(agentId: string): Promise<FlueAgentConfig> {
    return this.http.request("GET", `/agents/${agentId}/config`);
  }

  /** Replace non-secret vars and the outbound allowlist. Omitted fields become empty. */
  put(agentId: string, params: PutFlueAgentConfigParams): Promise<FlueAgentConfig> {
    return this.http.request("PUT", `/agents/${agentId}/config`, { body: params });
  }

  /** List names/status only; OpenComputer never returns secret values. */
  async listSecrets(agentId: string): Promise<FlueAgentSecret[]> {
    const result = await this.http.request<{ data: FlueAgentSecret[] }>("GET", `/agents/${agentId}/secrets`);
    return result.data;
  }

  /** Create or rotate a secret. A deployed Worker is updated in place when possible. */
  setSecret(agentId: string, name: string, value: string): Promise<FlueAgentSecret> {
    return this.http.request("PUT", `/agents/${agentId}/secrets/${encodeURIComponent(name)}`, { body: { value } });
  }

  deleteSecret(agentId: string, name: string): Promise<void> {
    return this.http.request("DELETE", `/agents/${agentId}/secrets/${encodeURIComponent(name)}`);
  }
}
