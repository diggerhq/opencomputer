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
   *  may ever authorize — a ceiling; OpenComputer still mints the minimum per operation. */
  allow?: GitHubPermission[];
}

export interface CreateRepoParams {
  provider?: "github"; // default: github
  owner: string;
  repo: string;
  /** Optional handle for your own reference; identity is (provider, owner, repo). */
  name?: string;
  /** Optional explicit GitHub App installation id. Usually resolved from owner/repo. */
  installationId?: string;
  defaults?: RepoDefaults;
}

export interface UpdateRepoParams {
  defaults?: RepoDefaults;
  name?: string;
  installationId?: string;
}

export interface Repo {
  id: string; // repo_…
  provider: string;
  owner: string;
  repo: string;
  name?: string;
  /** The GitHub App installation that authorizes this repo (auth lives there, not here). */
  installationId?: string;
  defaults?: RepoDefaults;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * An installation of the OpenComputer GitHub App on a GitHub user/org. OpenComputer uses
 * this to mint short-lived, repo-scoped tokens just in time; no token is ever returned.
 */
export interface GitHubInstallation {
  id: string; // ghi_…
  status: "active" | "suspended" | "revoked";
  /** The GitHub org/user the App is installed on. */
  accountLogin: string;
  /** GitHub's raw installation id, when exposed for audit/debug. */
  githubInstallationId?: number;
  repositorySelection?: "all" | "selected";
  createdAt?: string;
}

export interface Page<T> { data: T[]; nextCursor?: string | null; }

/**
 * Repos — repository identity + policy (the "where" a session works), analogous to
 * {@link Agents}. Auth comes from a GitHub App installation; no credential is passed here.
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

/** GitHub integration surface (`oc.github`). v1: list OpenComputer App installations. */
export class GitHub {
  readonly installations: GitHubInstallations;
  constructor(http: Http) {
    this.installations = new GitHubInstallations(http);
  }
}

/** OpenComputer GitHub App installations available to your org. */
export class GitHubInstallations {
  constructor(private readonly http: Http) {}
  list(): Promise<Page<GitHubInstallation>> {
    return this.http.request("GET", "/github/installations");
  }
}
