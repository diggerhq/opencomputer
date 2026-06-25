import type { Http, Query } from "./http.js";

export type GitHubPermission =
  | "contents:read" | "contents:write"
  | "pull_requests:read" | "pull_requests:write"
  | "issues:read" | "issues:write"
  | "statuses:read" | "statuses:write"
  | "checks:read" | "checks:write"
  | (string & {});

export interface RepoDefaults {
  /** Branch namespace for agent pushes; default `oc/{session}/`. No protected/base push. */
  branchNamespace?: string;
  /** GitHub permission ceiling (e.g. `contents:read`, `pull_requests:write`) this repo
   *  may ever authorize — a ceiling; each operation still requests the minimum token. */
  allow?: GitHubPermission[];
}

export interface CreateRepoParams {
  provider?: "github"; // default: github
  owner: string;
  repo: string;
  /** Optional handle for your own reference; identity is (provider, owner, repo). */
  name?: string;
  /** Optional explicit GitHub App id. Defaults to your org's default app, then the OC App. */
  appId?: string;
  defaults?: RepoDefaults;
}

export interface UpdateRepoParams {
  defaults?: RepoDefaults;
  name?: string;
  appId?: string;
}

export interface Repo {
  id: string; // repo_…
  provider: string;
  owner: string;
  repo: string;
  name?: string;
  /** The GitHub App that authorizes this repo (auth lives there, not here). */
  appId?: string;
  defaults?: RepoDefaults;
  createdAt?: string;
  updatedAt?: string;
}

export type GitHubAppMode = "oc_app" | "byo_stored_key" | "byo_broker" | (string & {});
export type GitHubAppStatus = "active" | "suspended" | "revoked" | (string & {});

/**
 * A GitHub App OpenComputer can use to mint short-lived, repo-scoped tokens. The built-in
 * OpenComputer App is `oc_app`; user-owned App modes are additive.
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
 * status and preflight; auth resolves through the App, and broker-mode Apps may have no
 * OpenComputer-visible installations.
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
 * Repos — repository identity + policy (the "where" a session works), analogous to
 * {@link Agents}. Auth resolves through a GitHub App; no credential is passed here.
 * Register once and reference from `sources: [{ repo, ref, sha }]`. A session can also
 * reference `"owner/repo"` directly without creating a Repo handle. See the
 * [Repos guide](https://docs.opencomputer.dev/agent-sessions/repos).
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

/** GitHub App installations visible to OpenComputer; optional for broker-mode Apps. */
export class GitHubInstallations {
  constructor(private readonly http: Http) {}
  list(params: ListGitHubInstallationsParams = {}): Promise<Page<GitHubInstallation>> {
    return this.http.request("GET", "/github/installations", { query: params as Query });
  }
}
