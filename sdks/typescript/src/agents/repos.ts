import type { Http, Query } from "./http.js";

export interface CreateRepoParams {
  provider?: "github"; // default: github
  owner: string;
  repo: string;
  /** Optional handle for your own reference; identity is (provider, owner, repo). */
  name?: string;
  /** The GitHub App this repo resolves to (↔ `app_id` on the wire). Optional;
   *  defaults to your org's default App, then the OpenComputer App. */
  appId?: string;
}

export interface UpdateRepoParams {
  name?: string;
  /** The GitHub App this repo resolves to (↔ `app_id` on the wire). */
  appId?: string;
}

export interface Repo {
  id: string; // repo_…
  provider: string;
  owner: string;
  repo: string;
  name?: string;
  /** The GitHub App this repo resolves to (auth lives there, not here). */
  appId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * How a GitHub App mints operation-scoped tokens:
 * - `oc_app`: OpenComputer owns the App key and mints.
 * - `byo_stored_key`: you own the App; OpenComputer stores the key encrypted and mints.
 * - `byo_broker`: your backend owns the App key/lifecycle and returns short-lived tokens.
 */
export type GitHubAppMode = "oc_app" | "byo_stored_key" | "byo_broker" | (string & {});
export type GitHubAppStatus = "active" | "suspended" | "revoked" | (string & {});

/**
 * A GitHub App authority for repo operations. The built-in OpenComputer App is `oc_app`;
 * user-owned App modes are additive and keep the Repo/Source shape unchanged.
 */
export interface GitHubApp {
  id: string; // gha_…
  provider: "github" | (string & {});
  mode: GitHubAppMode;
  status: GitHubAppStatus;
  appSlug?: string;
  appName?: string;
  isDefault?: boolean;
  createdAt?: string;
}

/**
 * A GitHub App installation visible to OpenComputer. Installations are useful for setup
 * status and preflight. `byo_broker` Apps may have no OpenComputer-visible installations
 * because your backend owns that lifecycle.
 */
export interface GitHubInstallation {
  id: string; // ghi_…
  appId: string; // gha_…
  status: GitHubAppStatus;
  /** The GitHub org/user the App is installed on. */
  accountLogin: string;
  /** GitHub's raw installation id, when exposed for audit/debug. */
  githubInstallationId?: number;
  repositorySelection?: "all" | "selected";
  createdAt?: string;
}

export interface Page<T> { data: T[]; nextCursor?: string | null; }

export interface ListGitHubInstallationsParams {
  appId?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Repos — provider-neutral repository identity (the "where" a session works).
 * Auth for GitHub repos resolves through a GitHub App; no credential is passed here.
 * Register once and reference from `sources: [{ repo, ref, sha }]`. A session can also
 * reference `"owner/repo"` directly without creating a Repo handle. See the
 * [Repos & GitHub guide](https://docs.opencomputer.dev/agent-sessions/repos).
 */
export class Repos {
  constructor(private readonly http: Http) {}

  /** Get-or-create, owner-scoped, idempotent by (provider, owner, repo). */
  create(params: CreateRepoParams): Promise<Repo> {
    return this.http.request("POST", "/repos", { body: params, idempotent: true });
  }
  get(id: string): Promise<Repo> {
    return this.http.request("GET", `/repos/${encodeURIComponent(id)}`);
  }
  update(id: string, params: UpdateRepoParams): Promise<Repo> {
    return this.http.request("PATCH", `/repos/${id}`, { body: params });
  }
  list(params: { limit?: number; cursor?: string } = {}): Promise<Page<Repo>> {
    return this.http.request("GET", "/repos", { query: params as Query });
  }
}

/** GitHub integration surface (`oc.github`). */
export class GitHub {
  readonly apps: GitHubApps;
  readonly installations: GitHubInstallations;
  constructor(http: Http) {
    this.apps = new GitHubApps(http);
    this.installations = new GitHubInstallations(http);
  }
}

/** GitHub Apps available to your org. BYO App registration methods are additive later. */
export class GitHubApps {
  constructor(private readonly http: Http) {}
  list(params: { limit?: number; cursor?: string } = {}): Promise<Page<GitHubApp>> {
    return this.http.request("GET", "/github/apps", { query: params as Query });
  }
}

/** GitHub App installations visible to OpenComputer; optional for `byo_broker` Apps. */
export class GitHubInstallations {
  constructor(private readonly http: Http) {}
  list(params: ListGitHubInstallationsParams = {}): Promise<Page<GitHubInstallation>> {
    return this.http.request("GET", "/github/installations", { query: params as Query });
  }
}
