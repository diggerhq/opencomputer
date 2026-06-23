import type { Http } from "./http.js";
import type { Credential } from "./types.js";

export interface CreateCredentialParams {
  /** The model provider this key is for (`anthropic` for the `claude` runtime, `openai` for `codex`). Defaults to `anthropic`. */
  provider?: "anthropic" | "openai" | (string & {});
  /** Write-only — never returned by the API. */
  key: string;
  name?: string;
  /** Make this the org default for its provider (sent as `is_default`). */
  isDefault?: boolean;
}

/** Provider keys (e.g. Anthropic, OpenAI), stored in the secret store; sessions run on them. */
export class Credentials {
  constructor(private readonly http: Http) {}

  create(params: CreateCredentialParams): Promise<Credential> {
    return this.http.request("POST", "/credentials", { body: params });
  }
  async list(): Promise<Credential[]> {
    const r = await this.http.request<{ data?: Credential[] } | Credential[]>("GET", "/credentials");
    return Array.isArray(r) ? r : r.data ?? [];
  }
  delete(id: string): Promise<void> {
    return this.http.request("DELETE", `/credentials/${id}`);
  }
  setDefault(params: { credential: string; provider?: string }): Promise<void> {
    return this.http.request("PUT", "/credentials/default", { body: params });
  }
}
