import type { Http, Query } from "./http.js";

export interface RepoDefaults {
  /** Branch namespace for agent pushes; default `oc/{session}/`. No protected/base push. */
  branchNamespace?: string;
  /** GitHub permission ceiling (e.g. `contents:read`, `pull_requests:write`) this repo
   *  may ever authorize — a ceiling; OpenComputer still mints the minimum per operation. */
  allow?: string[];
}

export interface CreateRepoParams {
  provider?: "github"; // default: github
  owner: string;
  repo: string;
  /** Optional handle for your own reference; identity is (provider, owner, repo). */
  name?: string;
  /** Optional explicit GitHub connection id. Defaults to your org's connection. */
  connection?: string;
  defaults?: RepoDefaults;
}

export interface UpdateRepoParams {
  defaults?: RepoDefaults;
  name?: string;
  connection?: string;
}

export interface Repo {
  id: string; // repo_…
  provider: string;
  owner: string;
  repo: string;
  name?: string;
  /** The GitHub connection that authorizes this repo (auth lives there, not here). */
  connectionId?: string;
  defaults?: RepoDefaults;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * How OpenComputer mints GitHub tokens for your org. Created by **installing the
 * OpenComputer GitHub App** (recommended) — bring-your-own App + broker are coming soon.
 * No GitHub credential is ever returned.
 */
export interface Connection {
  id: string; // conn_…
  provider: string;
  /** `oc_app` today; `byo_app_key` / `byo_broker` coming soon. */
  type: "oc_app" | "byo_app_key" | "byo_broker";
  status: "active" | "suspended" | "revoked";
  /** The GitHub org/user the App is installed on. */
  accountLogin: string;
  createdAt?: string;
}

export interface Page<T> { data: T[]; nextCursor?: string | null; }

/**
 * Repos — repository identity + policy (the "where" a session works), analogous to
 * {@link Agents}. Auth comes from your GitHub {@link Connection}; no credential is passed
 * here. Register once and reference from `sources: [{ repo, ref, sha }]`, or reference
 * `"owner/repo"` directly. See the [Repos guide](https://docs.opencomputer.dev/agent-sessions/repos).
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

/** GitHub integration surface (`oc.github`). v1: list your connected installs. */
export class GitHub {
  readonly connections: Connections;
  constructor(http: Http) {
    this.connections = new Connections(http);
  }
}

/** Connected GitHub Apps (installs) for your org. Created via the install flow, not the API. */
export class Connections {
  constructor(private readonly http: Http) {}
  list(): Promise<Page<Connection>> {
    return this.http.request("GET", "/github/connections");
  }
}
