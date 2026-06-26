import type { Http, Query } from "./http.js";

export interface CreateRepoParams {
  provider?: "github"; // default: github
  owner: string;
  repo: string;
  /** Optional handle for your own reference; identity is (provider, owner, repo). */
  name?: string;
}

export interface UpdateRepoParams {
  name?: string;
}

export interface Repo {
  id: string; // repo_…
  provider: string;
  owner: string;
  repo: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * How a GitHub App mints operation-scoped tokens:
 * - `oc_app`: the built-in OpenComputer App owns the key and mints. Default if you register
 *   nothing.
 * - `byo_stored_key`: your own GitHub App; OpenComputer stores the App private key encrypted
 *   and mints with it. Register it directly ({@link GitHubApps.register}) or one-click via the
 *   manifest flow ({@link GitHubApps.createManifest} / {@link GitHubApps.completeManifest}).
 * - `byo_broker`: your backend owns the key and returns short-lived tokens — registrable now,
 *   but token minting through a broker is still coming, so it is not yet used for operations.
 * Left as an open string so future modes don't break clients.
 */
export type GitHubAppMode = "oc_app" | "byo_stored_key" | "byo_broker" | (string & {});
export type GitHubAppStatus = "active" | "suspended" | "revoked" | (string & {});

/**
 * A GitHub App authority for repo operations. The built-in OpenComputer App (`oc_app`) is
 * always present; registering your own adds `byo_stored_key` / `byo_broker` apps. The Repo and
 * Source shapes are identical regardless of which App authorizes them.
 */
export interface GitHubApp {
  id: string; // gha_…
  provider: "github" | (string & {});
  mode: GitHubAppMode;
  status: GitHubAppStatus;
  /** The GitHub numeric App id (App-key modes). Not a secret. */
  githubAppId?: string;
  appSlug?: string;
  appName?: string;
  isDefault?: boolean;
  createdAt?: string;
}

/**
 * Register your own GitHub App. `byo_stored_key` needs the GitHub numeric App id + the App
 * private key (PEM) — OpenComputer encrypts the key at rest and never returns it. `byo_broker`
 * needs your HTTPS mint endpoint + a shared secret. Set `isDefault` to make it the App used
 * when a repo doesn't pin one.
 */
export interface RegisterGitHubAppParams {
  mode: "byo_stored_key" | "byo_broker";
  /** byo_stored_key: the GitHub numeric App id. */
  githubAppId?: string;
  /** byo_stored_key: the App private key, PEM (PKCS#1 or PKCS#8). Encrypted at rest. */
  privateKey?: string;
  /** byo_broker: your HTTPS token-mint endpoint. */
  brokerUrl?: string;
  /** byo_broker: shared secret OpenComputer presents to your broker. Encrypted at rest. */
  brokerSecret?: string;
  appName?: string;
  appSlug?: string;
  isDefault?: boolean;
}

/** Update a registered App. Setting `privateKey` / `brokerSecret` rotates that secret in place. */
export interface UpdateGitHubAppParams {
  status?: GitHubAppStatus;
  appName?: string;
  appSlug?: string;
  isDefault?: boolean;
  privateKey?: string;
  brokerUrl?: string;
  brokerSecret?: string;
}

/** Parameters for building a GitHub App-creation manifest. */
export interface CreateAppManifestParams {
  /** Where GitHub returns `?code=&state=` after the App is created (must be https). */
  redirectUrl: string;
  /** Suggested App name (GitHub requires global uniqueness; the user can change it). */
  name?: string;
  /** App homepage URL; defaults to the redirect URL's origin. */
  url?: string;
  /** Org login to create an org-owned App; omit for a user-owned App. */
  organization?: string;
}

/** The manifest + where to submit it. POST `manifest` (JSON) as form field `field` to `postUrl`. */
export interface AppManifest {
  manifest: Record<string, unknown>;
  postUrl: string;
  field: "manifest";
  /** CSRF/correlation token — echo it from your redirect handler and verify it matches. */
  state: string;
}

/** Complete the manifest flow: exchange the `code` GitHub returned for a registered App. */
export interface CompleteAppManifestParams {
  /** The one-time `code` GitHub appended to your redirect URL (~1h TTL, single use). */
  code: string;
  isDefault?: boolean;
}

/**
 * A GitHub App installation visible to OpenComputer. Installations are useful for setup
 * status and preflight. In preview this may be empty for orgs using only the OpenComputer
 * App; it surfaces bring-your-own App installations once those modes are available.
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

/**
 * GitHub Apps available to your org — the built-in OpenComputer App plus any you register.
 * Use your own App (`byo_stored_key`) so PRs, comments, and statuses come from your App
 * identity; register it directly with {@link register}, or one-click with {@link createManifest}
 * + {@link completeManifest}.
 */
export class GitHubApps {
  constructor(private readonly http: Http) {}

  list(params: { limit?: number; cursor?: string } = {}): Promise<Page<GitHubApp>> {
    return this.http.request("GET", "/github/apps", { query: params as Query });
  }

  /** Register your own GitHub App (`byo_stored_key` or `byo_broker`). Secrets are encrypted at
   *  rest and never returned. */
  register(params: RegisterGitHubAppParams): Promise<GitHubApp> {
    return this.http.request("POST", "/github/apps", { body: params });
  }

  /** Update an App: rename, change status, set as default, or rotate the key/secret. */
  update(id: string, params: UpdateGitHubAppParams): Promise<GitHubApp> {
    return this.http.request("PATCH", `/github/apps/${encodeURIComponent(id)}`, { body: params });
  }

  /** Remove a registered App, its installations, and its encrypted secrets. */
  delete(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.http.request("DELETE", `/github/apps/${encodeURIComponent(id)}`);
  }

  /**
   * Step 1 of the one-click flow: build a GitHub App-creation manifest pre-scoped to what
   * OpenComputer needs. Render a form that POSTs `result.manifest` (JSON) as field
   * `result.field` to `result.postUrl`; GitHub creates the App and redirects to your
   * `redirectUrl` with a `code`.
   */
  createManifest(params: CreateAppManifestParams): Promise<AppManifest> {
    return this.http.request("POST", "/github/apps/manifest", { body: params });
  }

  /**
   * Step 2 of the one-click flow: exchange the `code` GitHub returned for a registered App.
   * OpenComputer captures the new App's private key server-side, encrypts it, and registers
   * the App as `byo_stored_key`. The key is never exposed to your code.
   */
  completeManifest(params: CompleteAppManifestParams): Promise<GitHubApp> {
    return this.http.request("POST", "/github/apps/manifest/conversions", { body: params });
  }
}

/** GitHub App installations visible to OpenComputer. In preview this may be empty for orgs
 *  using only the OpenComputer App; it surfaces BYO installations once available. */
export class GitHubInstallations {
  constructor(private readonly http: Http) {}
  list(params: ListGitHubInstallationsParams = {}): Promise<Page<GitHubInstallation>> {
    return this.http.request("GET", "/github/installations", { query: params as Query });
  }
}
