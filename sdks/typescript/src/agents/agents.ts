import type { Http, Query } from "./http.js";
import type { Agent, Limits } from "./types.js";

export interface CreateAgentParams {
  name: string;
  prompt: string;
  model: string;
  runtime?: string;
  /** Anthropic key, stored as a sealed credential. Or pass `credential`, or rely on the org default. */
  key?: string;
  credential?: string;
  limits?: Limits;
}

export interface UpdateAgentParams {
  prompt?: string;
  model?: string;
  key?: string;
  credential?: string;
  limits?: Limits;
}

export interface Page<T> { data: T[]; nextCursor?: string | null; }

/** Reusable agents — the "what" a session runs. */
export class Agents {
  constructor(private readonly http: Http) {}

  create(params: CreateAgentParams): Promise<Agent> {
    return this.http.request("POST", "/agents", { body: params });
  }
  get(id: string): Promise<Agent> {
    return this.http.request("GET", `/agents/${id}`);
  }
  update(id: string, params: UpdateAgentParams): Promise<Agent> {
    return this.http.request("PATCH", `/agents/${id}`, { body: params });
  }
  list(params: { limit?: number; cursor?: string } = {}): Promise<Page<Agent>> {
    return this.http.request("GET", "/agents", { query: params as Query });
  }
}
