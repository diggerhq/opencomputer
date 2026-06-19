import type { Http } from "./http.js";
import type { Credential } from "./types.js";

export interface CreateCredentialParams {
  /** Defaults to `anthropic`. */
  provider?: "anthropic" | (string & {});
  /** Write-only — never returned by the API. */
  key: string;
  name?: string;
}

/** Provider keys (e.g. Anthropic), stored in the secret store; sessions run on them. */
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
