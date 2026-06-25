import type { Http, Query } from "./http.js";

/**
 * How OpenComputer obtains GitHub tokens for a repo. OpenComputer never stores a
 * GitHub credential — it calls your **token broker** to mint a short-lived,
 * narrowly-scoped installation token just in time for each operation, runs the
 * operation in an isolated job, and discards the token.
 *
 * `token_broker` registers a *connection*: your broker authorizes OpenComputer's
 * (signature-verified) requests for this repo, per your broker's own policy. No
 * standing GitHub credential is given to OpenComputer; only the broker URL +
 * repo identity are recorded.
 */
export type RepoAuth = {
  type: "token_broker";
  /** Your broker endpoint. OpenComputer signs requests to it with its published JWKS. */
  brokerUrl: string;
};

export interface RepoDefaults {
  /** Branch namespace for agent pushes; default `oc/{session}/`. No protected/base push. */
  branchNamespace?: string;
  /** Operation classes this repo may ever authorize (a ceiling; the broker still decides per call). */
  allow?: string[];
}

export interface CreateRepoParams {
  provider?: "github"; // default: github
  owner: string;
  repo: string;
  /** Optional handle for your own reference; identity is (provider, owner, repo). */
  name?: string;
  auth: RepoAuth;
  defaults?: RepoDefaults;
}

export interface UpdateRepoParams {
  auth?: RepoAuth;
  defaults?: RepoDefaults;
  name?: string;
}

export interface Repo {
  id: string; // repo_…
  provider: string;
  owner: string;
  repo: string;
  name?: string;
  /** The broker endpoint (not a secret). No GitHub token is ever returned or stored. */
  brokerUrl?: string;
  defaults?: RepoDefaults;
  createdAt?: string;
  updatedAt?: string;
}

export interface Page<T> { data: T[]; nextCursor?: string | null; }

/**
 * Repos — a reusable, registered connection to a repository (the "where" a session
 * works), analogous to {@link Agents} (the "what" it runs). Register once; reference
 * from many sessions via `sources: [{ repo, ref, sha }]`. Sessions can also use a repo
 * inline without registering — see {@link CreateSessionParams.sources}.
 */
export class Repos {
  constructor(private readonly http: Http) {}

  /** Get-or-create, owner-scoped, idempotent by (provider, owner, repo). */
  create(params: CreateRepoParams): Promise<Repo> {
    return this.http.request("POST", "/repos", { body: params, idempotent: true });
  }
  get(idOrSlug: string): Promise<Repo> {
    return this.http.request("GET", `/repos/${encodeURIComponent(idOrSlug)}`);
  }
  update(id: string, params: UpdateRepoParams): Promise<Repo> {
    return this.http.request("PATCH", `/repos/${id}`, { body: params });
  }
  list(params: { limit?: number; cursor?: string } = {}): Promise<Page<Repo>> {
    return this.http.request("GET", "/repos", { query: params as Query });
  }
}
