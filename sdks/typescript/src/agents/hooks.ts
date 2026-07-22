import type { Http, Query } from "./http.js";
import type { Page } from "./agents.js";

export type HookStatus = "active" | "expired" | "revoked";
export type HookRevokedReason = "manual" | "secret_exposure";

export interface AgentHook {
  id: string;
  agentId: string;
  name: string;
  status: HookStatus;
  secretLast4: string;
  revokedReason: HookRevokedReason | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateAgentHookParams {
  name: string;
  expiresAt?: string | null;
}

export interface ListAgentHooksParams {
  includeRevoked?: boolean;
  cursor?: string;
  limit?: number;
}

export interface CreatedAgentHook {
  hook: AgentHook;
  /** Complete secret URL. Returned once, only by create. */
  hookUrl: string;
}

/** Named, independently revocable URLs that can only start this agent. */
export class AgentHooks {
  constructor(private readonly http: Http) {}

  create(agentId: string, params: CreateAgentHookParams): Promise<CreatedAgentHook> {
    return this.http.request("POST", `/agents/${agentId}/hooks`, { body: params });
  }

  list(agentId: string, params: ListAgentHooksParams = {}): Promise<Page<AgentHook>> {
    return this.http.request("GET", `/agents/${agentId}/hooks`, {
      query: params as Query,
    });
  }

  get(agentId: string, hookId: string): Promise<AgentHook> {
    return this.http.request("GET", `/agents/${agentId}/hooks/${hookId}`);
  }

  delete(agentId: string, hookId: string): Promise<void> {
    return this.http.request("DELETE", `/agents/${agentId}/hooks/${hookId}`);
  }
}
