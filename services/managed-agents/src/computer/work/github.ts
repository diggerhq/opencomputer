// The Work index's GitHub client (tech design 3.6, "GitHub access"): the few REST calls an advance,
// a build and the history need, and one GraphQL query for pull request state.
//
// - Tokens come from the Account object's `mintGitHubInstallationToken`. Contents are read with a
//   token narrowed to the knowledge repository and `contents: read`; pull request state, which
//   lives in other repositories, with `pull_requests: read` across the installation. Each is held
//   in memory until five minutes before it expires.
// - Quota: the installation's limit is shared with the organization's agents. Every response's
//   rate-limit headers are kept per resource (`core`, `graphql`); `spare()` is false under a fifth
//   of the limit, and background work stops. A 403 or 429 with `retry-after` (or no requests
//   left) is a pause (`GitHubPaused`), not an error: nothing more is asked until it ends.
// - Permanent failures (installation removed, repository deleted or no longer granted, branch
//   gone, a permission the installation lacks) are `GitHubGone` with the problem the screens show.

import type { GitHubTokenMint } from "../../protocol.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "opencomputer-managed-agents";
/** A token is minted again this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Background work stops under this share of the limit remaining. */
const SPARE_SHARE = 0.2;
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

/** Why the repository cannot be read; shown as `repository.problem`. */
export type RepositoryProblem =
  | "installation_removed"
  | "installation_suspended"
  | "repository_not_found"
  | "branch_not_found"
  | "access_denied"
  | "github_app_not_configured";

/** A permanent failure: the repository setting needs a person. */
export class GitHubGone extends Error {
  constructor(readonly problem: RepositoryProblem, message: string = problem) {
    super(message);
  }
}

/** GitHub asked us to wait (rate limit or abuse limit); retry after `until`. */
export class GitHubPaused extends Error {
  constructor(readonly until: number) {
    super(`GitHub paused requests until ${new Date(until).toISOString()}`);
  }
}

/** A temporary failure: GitHub unreachable, 5xx, a malformed answer. */
export class GitHubUnavailable extends Error {}

/** What the client needs of the Account object. */
export interface TokenMinter {
  mintGitHubInstallationToken(input: {
    installationId: string;
    permissions?: Record<string, "read" | "write">;
    repositories?: string[];
  }): Promise<GitHubTokenMint>;
}

export interface WorkRepo {
  installationId: string;
  owner: string;
  name: string;
  branch: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string | null;
  /** The author date, ISO. */
  at: string;
}

export interface FileChange {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  previousFilename: string | null;
  /** The blob sha at the head side (absent for a removal). */
  sha: string | null;
}

export interface Comparison {
  status: "ahead" | "behind" | "diverged" | "identical";
  totalCommits: number;
  commits: CommitInfo[];
  files: FileChange[];
}

export interface TreeEntry {
  name: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export type PullState = "open" | "draft" | "merged" | "closed";

interface Quota {
  limit: number;
  remaining: number;
  /** ms epoch. */
  reset: number;
}

interface HeldToken {
  token: string;
  expiresAt: number;
}

export interface WorkGitHubOptions {
  repo: WorkRepo;
  account: TokenMinter;
  fetch?: typeof fetch;
  now?: () => number;
}

/** One knowledge repository's GitHub access. */
export class WorkGitHub {
  readonly repo: WorkRepo;
  private readonly account: TokenMinter;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<"contents" | "pulls", HeldToken>();
  private readonly quota = new Map<string, Quota>();
  private pausedUntil = 0;
  /** Calls made, for tests and telemetry. */
  calls = 0;

  constructor(options: WorkGitHubOptions) {
    this.repo = options.repo;
    this.account = options.account;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** Until when GitHub asked us to wait; 0 when it did not. */
  paused(): number {
    return this.pausedUntil > this.now() ? this.pausedUntil : 0;
  }

  /** Whether background work may spend quota: not paused, and more than a fifth of the limit left. */
  spare(resource: "core" | "graphql" = "core"): boolean {
    if (this.paused()) return false;
    const q = this.quota.get(resource);
    if (!q || q.reset <= this.now()) return true;
    return q.remaining >= q.limit * SPARE_SHARE;
  }

  // ---------------------------------------------------------------- tokens

  private async token(kind: "contents" | "pulls"): Promise<string> {
    const held = this.tokens.get(kind);
    if (held && held.expiresAt - TOKEN_MARGIN_MS > this.now()) return held.token;
    const minted = await this.account.mintGitHubInstallationToken({
      installationId: this.repo.installationId,
      ...(kind === "contents"
        ? { permissions: { contents: "read" }, repositories: [this.repo.name] }
        : { permissions: { pull_requests: "read" } }),
    });
    if (minted.outcome === "not_connected") throw new GitHubGone("installation_removed", "The GitHub connection is gone.");
    if (minted.outcome === "app_not_configured") throw new GitHubGone("github_app_not_configured", "The GitHub App is not configured.");
    if (minted.outcome === "failed") {
      if (minted.code === "installation_not_found") throw new GitHubGone("installation_removed", minted.message);
      if (minted.code === "installation_suspended") throw new GitHubGone("installation_suspended", minted.message);
      // A narrowed mint for a repository the installation no longer grants is refused with 422.
      if (minted.code === "github_permission_missing") throw new GitHubGone(kind === "contents" ? "repository_not_found" : "access_denied", minted.message);
      if (minted.code === "mint_rate_limited") throw this.pause((minted.retryAfterSeconds ?? 60) * 1000);
      throw new GitHubUnavailable(minted.message);
    }
    const expiresAt = Date.parse(minted.expiresAt);
    this.tokens.set(kind, { token: minted.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 30 * 60_000 });
    return minted.token;
  }

  private pause(ms: number): GitHubPaused {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(Math.max(ms, 1000), MAX_PAUSE_MS));
    return new GitHubPaused(this.pausedUntil);
  }

  // ---------------------------------------------------------------- transport

  /**
   * One request. Answers 2xx, 304 and 404 to the caller; a rate limit is a pause, 401 drops the
   * token, other 403s are `access_denied`, the rest temporary.
   */
  private async request(
    path: string,
    init: { kind?: "contents" | "pulls"; accept?: string; etag?: string; method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const paused = this.paused();
    if (paused) throw new GitHubPaused(paused);
    const kind = init.kind ?? "contents";
    const token = await this.token(kind);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: init.accept ?? "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
    };
    if (init.etag) headers["if-none-match"] = init.etag;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    this.calls += 1;
    try {
      response = await this.fetcher(`${GITHUB_API}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new GitHubUnavailable("GitHub is unreachable.");
    }
    this.noteQuota(response);
    if (response.ok || response.status === 304 || response.status === 404) return response;
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const limited = response.headers.get("x-ratelimit-remaining") === "0";
    if (response.status === 429 || (response.status === 403 && (Number.isFinite(retryAfter) || limited))) {
      if (Number.isFinite(retryAfter)) throw this.pause(retryAfter * 1000);
      const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
      throw this.pause(Number.isFinite(reset) ? reset * 1000 - this.now() : DEFAULT_PAUSE_MS);
    }
    if (response.status === 401) {
      this.tokens.delete(kind);
      throw new GitHubUnavailable("GitHub refused the token.");
    }
    if (response.status === 403) throw new GitHubGone("access_denied", "GitHub refused access to the repository.");
    throw new GitHubUnavailable(`GitHub answered ${response.status}.`);
  }

  private noteQuota(response: Response): void {
    const limit = Number.parseInt(response.headers.get("x-ratelimit-limit") ?? "", 10);
    const remaining = Number.parseInt(response.headers.get("x-ratelimit-remaining") ?? "", 10);
    const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;
    const resource = response.headers.get("x-ratelimit-resource") ?? "core";
    this.quota.set(resource, { limit, remaining, reset: Number.isFinite(reset) ? reset * 1000 : this.now() + 3_600_000 });
  }

  private async json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubUnavailable("GitHub returned a malformed response.");
    }
  }

  private repoPath(rest: string): string {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}${rest}`;
  }

  /** A 404 on the repository's resources: the repository itself, or only the thing asked for. */
  private async gone(): Promise<GitHubGone> {
    const response = await this.request(this.repoPath(""));
    if (response.status === 404) return new GitHubGone("repository_not_found", "The repository is gone or no longer granted.");
    return new GitHubGone("branch_not_found", `The branch ${this.repo.branch} is gone.`);
  }

  // ---------------------------------------------------------------- calls

  /** The repository as GitHub names it, and its default branch (setRepository's check). */
  async repository(): Promise<{ owner: string; name: string; defaultBranch: string }> {
    const response = await this.request(this.repoPath(""));
    if (response.status === 404) throw new GitHubGone("repository_not_found", "The repository is gone or no longer granted.");
    const body = await this.json<{ name?: unknown; owner?: { login?: unknown }; default_branch?: unknown }>(response);
    if (typeof body.name !== "string" || typeof body.owner?.login !== "string") throw new GitHubUnavailable("GitHub returned an invalid repository.");
    return { owner: body.owner.login, name: body.name, defaultBranch: typeof body.default_branch === "string" ? body.default_branch : "main" };
  }

  /** The branch's head commit; "unchanged" when `etag` still matches (a 304 costs no quota). */
  async head(etag?: string): Promise<{ sha: string; etag: string | null } | "unchanged"> {
    const response = await this.request(this.repoPath(`/git/ref/heads/${this.repo.branch.split("/").map(encodeURIComponent).join("/")}`), etag ? { etag } : {});
    if (response.status === 304) return "unchanged";
    if (response.status === 404) throw await this.gone();
    const body = await this.json<{ object?: { sha?: unknown; type?: unknown } }>(response);
    if (typeof body.object?.sha !== "string") throw new GitHubUnavailable("GitHub returned an invalid ref.");
    return { sha: body.object.sha, etag: response.headers.get("etag") };
  }

  /** `base...head`; null when GitHub no longer knows `base` (a rewritten history). */
  async compare(base: string, head: string): Promise<Comparison | null> {
    const response = await this.request(this.repoPath(`/compare/${base}...${head}?per_page=250`));
    if (response.status === 404) return null;
    const body = await this.json<{ status?: unknown; total_commits?: unknown; commits?: unknown; files?: unknown }>(response);
    const status = body.status;
    if (status !== "ahead" && status !== "behind" && status !== "diverged" && status !== "identical") throw new GitHubUnavailable("GitHub returned an invalid comparison.");
    return {
      status,
      totalCommits: typeof body.total_commits === "number" ? body.total_commits : 0,
      commits: Array.isArray(body.commits) ? body.commits.map(commitOf).filter((c): c is CommitInfo => c !== null) : [],
      files: Array.isArray(body.files) ? body.files.map(fileOf).filter((f): f is FileChange => f !== null) : [],
    };
  }

  /** One commit with its files. */
  async commit(sha: string): Promise<CommitInfo & { files: FileChange[] }> {
    const response = await this.request(this.repoPath(`/commits/${sha}`));
    if (response.status === 404) throw new GitHubUnavailable(`GitHub has no commit ${sha}.`);
    const body = await this.json<{ files?: unknown }>(response);
    const commit = commitOf(body);
    if (!commit) throw new GitHubUnavailable("GitHub returned an invalid commit.");
    return { ...commit, files: Array.isArray(body.files) ? body.files.map(fileOf).filter((f): f is FileChange => f !== null) : [] };
  }

  /** A tree's entries, not recursive; null when there is no such tree. */
  async tree(sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean } | null> {
    const response = await this.request(this.repoPath(`/git/trees/${sha}`));
    if (response.status === 404) return null;
    const body = await this.json<{ tree?: unknown; truncated?: unknown }>(response);
    const entries: TreeEntry[] = [];
    for (const raw of Array.isArray(body.tree) ? body.tree : []) {
      const e = raw as { path?: unknown; type?: unknown; sha?: unknown };
      if (typeof e.path === "string" && typeof e.sha === "string" && (e.type === "blob" || e.type === "tree" || e.type === "commit")) {
        entries.push({ name: e.path, type: e.type, sha: e.sha });
      }
    }
    return { entries, truncated: body.truncated === true };
  }

  /** A blob's text (UTF-8). */
  async blob(sha: string): Promise<string> {
    const response = await this.request(this.repoPath(`/git/blobs/${sha}`));
    if (response.status === 404) throw new GitHubUnavailable(`GitHub has no blob ${sha}.`);
    const body = await this.json<{ content?: unknown; encoding?: unknown }>(response);
    if (typeof body.content !== "string") throw new GitHubUnavailable("GitHub returned an invalid blob.");
    if (body.encoding !== "base64") return body.content;
    const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /** Commits that touched `path` (a file or a directory), newest first, from `sha`. */
  async commits(input: { sha: string; path: string; page: number; perPage: number }): Promise<CommitInfo[]> {
    const query = new URLSearchParams({ sha: input.sha, path: input.path, per_page: String(input.perPage), page: String(input.page) });
    const response = await this.request(this.repoPath(`/commits?${query}`));
    if (response.status === 404) return [];
    const body = await this.json<unknown>(response);
    return Array.isArray(body) ? body.map(commitOf).filter((c): c is CommitInfo => c !== null) : [];
  }

  /**
   * Pull request state for GitHub pull request URLs, in one GraphQL query (at most 50 per call).
   * A URL the installation cannot read is `unreadable`; a URL that is not a GitHub pull request is
   * left out.
   */
  async pulls(urls: string[]): Promise<Map<string, { state: PullState; title: string } | "unreadable">> {
    const out = new Map<string, { state: PullState; title: string } | "unreadable">();
    const targets = urls.map((url) => ({ url, pr: pullOf(url) })).filter((t): t is { url: string; pr: { owner: string; name: string; number: number } } => t.pr !== null);
    if (!targets.length) return out;
    const fields = targets.map(
      (t, i) => `p${i}: repository(owner: ${JSON.stringify(t.pr.owner)}, name: ${JSON.stringify(t.pr.name)}) { pullRequest(number: ${t.pr.number}) { state isDraft title } }`,
    );
    const response = await this.request("/graphql", { kind: "pulls", method: "POST", body: { query: `query {\n${fields.join("\n")}\n}` } });
    if (response.status === 404) throw new GitHubUnavailable("GitHub has no GraphQL endpoint.");
    const body = await this.json<{ data?: Record<string, { pullRequest?: { state?: unknown; isDraft?: unknown; title?: unknown } | null } | null> | null; errors?: unknown }>(response);
    if (!body.data && body.errors) throw new GitHubUnavailable("GitHub refused the pull request query.");
    targets.forEach((t, i) => {
      const pr = body.data?.[`p${i}`]?.pullRequest;
      if (!pr || typeof pr.state !== "string") {
        out.set(t.url, "unreadable");
        return;
      }
      const state: PullState = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft === true ? "draft" : "open";
      out.set(t.url, { state, title: typeof pr.title === "string" ? pr.title : "" });
    });
    return out;
  }
}

/** `https://github.com/{owner}/{name}/pull/{n}`, or null. */
export function pullOf(url: string): { owner: string; name: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(url);
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null;
}

function commitOf(raw: unknown): CommitInfo | null {
  const c = raw as { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown; email?: unknown; date?: unknown } } };
  if (typeof c?.sha !== "string" || typeof c.commit?.message !== "string") return null;
  const author = c.commit.author;
  return {
    sha: c.sha,
    message: c.commit.message,
    authorName: typeof author?.name === "string" ? author.name : "",
    authorEmail: typeof author?.email === "string" ? author.email : null,
    at: typeof author?.date === "string" ? author.date : new Date(0).toISOString(),
  };
}

function fileOf(raw: unknown): FileChange | null {
  const f = raw as { filename?: unknown; status?: unknown; previous_filename?: unknown; sha?: unknown };
  if (typeof f?.filename !== "string" || typeof f.status !== "string") return null;
  return {
    filename: f.filename,
    status: f.status as FileChange["status"],
    previousFilename: typeof f.previous_filename === "string" ? f.previous_filename : null,
    sha: typeof f.sha === "string" && f.status !== "removed" ? f.sha : null,
  };
}
