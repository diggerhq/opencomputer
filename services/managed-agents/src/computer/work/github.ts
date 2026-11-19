// The Work index's GitHub client (tech design 3.6, "GitHub access"): the few REST calls an advance,
// a build and the history need, and one GraphQL query for pull request state.
//
// - Tokens come from the Account object's `mintGitHubInstallationToken`. Contents are read with a
//   token narrowed to the knowledge repository and `contents: read`. Pull request state is read
//   with `pull_requests: read` narrowed to the repositories of the batch asked, and only for
//   repositories of the installation's own account (other links are `unreadable`). Finding a
//   renamed repository by its id, and listing the repositories an installation grants (the
//   repository picker), use `metadata: read`. Each token is held in memory until five minutes
//   before it expires.
// - Every request is aborted after REQUEST_TIMEOUT_MS, the body included.
// - Quota: the installation's limit is shared with the organization's agents. Every response's
//   rate-limit headers are kept per resource (`core`, `graphql`); `spare()` is false under a fifth
//   of the limit, and background work stops. A rate limit is a pause of that resource only
//   (`GitHubPaused`), not an error: nothing more is asked of it until the pause ends. A 403 is a
//   rate limit when it has `retry-after`, no requests left, or a body naming a rate, abuse or
//   secondary limit (at least DEFAULT_PAUSE_MS then); it is permanent only when the body says the
//   integration cannot reach the resource. Any other 403 is temporary.
// - Permanent failures (installation removed, repository deleted or no longer granted, branch
//   gone, a permission the installation lacks) are `GitHubGone` with the problem the screens show.
//   The index retries them slowly, so a fixed setting heals by itself.
// - A request GitHub answered through a redirect (a renamed repository) sets `moved`.

import type { GitHubTokenMint } from "../../protocol.js";
import type { Clock, Fetch } from "./platform.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "opencomputer-managed-agents";
/** A token is minted again this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Background work stops under this share of the limit remaining. */
const SPARE_SHARE = 0.2;
export const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 60 * 60_000;
/** Every GitHub request, its body included, is aborted after this. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** GitHub's largest page for lists. */
export const PER_PAGE_MAX = 100;
/** A commit's files: 300 a page, ten pages at most. */
export const COMMIT_FILES_PAGE = 300;
const COMMIT_FILE_PAGES = 10;

/** Why the repository cannot be read; shown as `repository.problem`. A stable code. */
export type RepositoryProblem =
  | "installation_removed"
  | "installation_suspended"
  | "repository_not_found"
  | "branch_not_found"
  | "access_denied"
  | "github_app_not_configured";

export type RateResource = "core" | "graphql";

/** A permanent failure: the repository setting needs a person. `message` is for people. */
export class GitHubGone extends Error {
  constructor(readonly problem: RepositoryProblem, message: string = problem) {
    super(message);
  }
}

/** GitHub asked us to wait (rate limit or abuse limit) on one resource; retry after `until`. */
export class GitHubPaused extends Error {
  constructor(readonly until: number, readonly resource: RateResource = "core") {
    super(`GitHub paused ${resource} requests until ${new Date(until).toISOString()}`);
  }
}

/** A temporary failure: GitHub unreachable or slow, 5xx, an unexplained 403, a malformed answer. */
export class GitHubUnavailable extends Error {}

/** What the client needs of the Account object. */
export interface TokenMinter {
  mintGitHubInstallationToken(input: {
    installationId: string;
    permissions?: Record<string, "read" | "write">;
    repositories?: string[];
  }): Promise<GitHubTokenMint>;
  /** The installation's GitHub account (`accountLogin`), or null when it is not connected. */
  getGitHubInstallation(installationId: string): Promise<{ accountLogin: string } | null> | { accountLogin: string } | null;
  /** The organization's installations (the repository picker lists the active ones). */
  listGitHubInstallations(): Promise<AccountInstallation[]> | AccountInstallation[];
}

/** An installation as the Account object holds it, the fields the Work index reads. */
export interface AccountInstallation {
  /** The Account object's id for it. */
  id: string;
  /** GitHub's id for it, which its settings page is named by. */
  githubInstallationId: number;
  accountLogin: string;
  /** GitHub's `Organization` or `User`. */
  accountType: string;
  state: string;
}

/** A repository an installation grants, as the picker lists it. */
export interface GrantedRepository {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  /** The last push, ISO; null for a repository never pushed to. */
  pushedAt: string | null;
}

export interface WorkRepo {
  installationId: string;
  owner: string;
  name: string;
  branch: string;
  /** GitHub's id for the repository, which survives renames; absent in settings stored before it. */
  id?: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string | null;
  /** The author date, ISO; null when GitHub gave none. */
  at: string | null;
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
  /** Oldest first; at most a page of them. */
  commits: CommitInfo[];
  /** At most COMPARE_FILES_MAX; check `files.length` before trusting it as complete. */
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

interface Answer {
  status: number;
  headers: Headers;
  body: string;
}

type TokenKind = { kind: "contents" } | { kind: "metadata" } | { kind: "pulls"; repositories: string[] };

export interface WorkGitHubOptions {
  repo: WorkRepo;
  account: TokenMinter;
  fetch: Fetch;
  clock: Clock;
}

/** One knowledge repository's GitHub access. */
export class WorkGitHub {
  readonly repo: WorkRepo;
  private readonly account: TokenMinter;
  private readonly fetcher: Fetch;
  private readonly clock: Clock;
  private readonly tokens = new Map<string, HeldToken>();
  private readonly quota = new Map<string, Quota>();
  private readonly pausedUntil = new Map<RateResource, number>();
  private login: string | null = null;
  /** Calls made, for tests and telemetry. */
  calls = 0;
  /** Set when GitHub answered through a redirect: the repository was renamed or moved. */
  moved = false;

  constructor(options: WorkGitHubOptions) {
    this.repo = options.repo;
    this.account = options.account;
    this.fetcher = options.fetch;
    this.clock = options.clock;
  }

  /** Until when GitHub asked us to wait on `resource`; 0 when it did not. */
  paused(resource: RateResource = "core"): number {
    const until = this.pausedUntil.get(resource) ?? 0;
    return until > this.clock.now() ? until : 0;
  }

  /** Whether background work may spend quota: not paused, and more than a fifth of the limit left. */
  spare(resource: RateResource = "core"): boolean {
    if (this.paused(resource)) return false;
    const q = this.quota.get(resource);
    if (!q || q.reset <= this.clock.now()) return true;
    return q.remaining >= q.limit * SPARE_SHARE;
  }

  /** The installation's account login (the owner a knowledge repository and a readable PR must have). */
  async accountLogin(): Promise<string> {
    if (this.login !== null) return this.login;
    const installation = await this.account.getGitHubInstallation(this.repo.installationId);
    if (!installation) throw new GitHubGone("installation_removed", "The GitHub installation is not connected to this organization.");
    this.login = installation.accountLogin;
    return this.login;
  }

  // ---------------------------------------------------------------- tokens

  private async token(want: TokenKind): Promise<string> {
    const key = want.kind === "pulls" ? `pulls:${want.repositories.join(",")}` : want.kind;
    const held = this.tokens.get(key);
    if (held && held.expiresAt - TOKEN_MARGIN_MS > this.clock.now()) return held.token;
    const resource: RateResource = want.kind === "pulls" ? "graphql" : "core";
    const minted = await this.account.mintGitHubInstallationToken({
      installationId: this.repo.installationId,
      ...(want.kind === "contents"
        ? { permissions: { contents: "read" }, repositories: [this.repo.name] }
        : want.kind === "metadata"
          ? { permissions: { metadata: "read" } }
          : { permissions: { pull_requests: "read" }, repositories: want.repositories }),
    });
    if (minted.outcome === "not_connected") throw new GitHubGone("installation_removed", "The GitHub installation is not connected to this organization.");
    if (minted.outcome === "app_not_configured") throw new GitHubGone("github_app_not_configured", "The GitHub App is not configured.");
    if (minted.outcome === "failed") {
      if (minted.code === "installation_not_found") throw new GitHubGone("installation_removed", minted.message);
      if (minted.code === "installation_suspended") throw new GitHubGone("installation_suspended", minted.message);
      // A narrowed mint for a repository the installation no longer grants is refused with 422.
      if (minted.code === "github_permission_missing") {
        throw new GitHubGone(want.kind === "contents" ? "repository_not_found" : "access_denied", minted.message);
      }
      if (minted.code === "mint_rate_limited") throw this.pause(resource, (minted.retryAfterSeconds ?? 60) * 1000);
      throw new GitHubUnavailable(minted.message);
    }
    const expiresAt = Date.parse(minted.expiresAt);
    this.tokens.set(key, { token: minted.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.clock.now() + 30 * 60_000 });
    return minted.token;
  }

  private pause(resource: RateResource, ms: number): GitHubPaused {
    const until = Math.max(this.pausedUntil.get(resource) ?? 0, this.clock.now() + Math.min(Math.max(ms, 1000), MAX_PAUSE_MS));
    this.pausedUntil.set(resource, until);
    return new GitHubPaused(until, resource);
  }

  // ---------------------------------------------------------------- transport

  /**
   * One request, its body read, within REQUEST_TIMEOUT_MS. Answers 2xx, 304 and 404 to the caller;
   * a rate limit is a pause, 401 drops the token, a 403 the integration may not see is
   * `access_denied`, the rest temporary.
   */
  private async request(
    path: string,
    init: { token?: TokenKind; accept?: string; etag?: string; method?: string; body?: unknown } = {},
  ): Promise<Answer> {
    const resource: RateResource = path === "/graphql" ? "graphql" : "core";
    const paused = this.paused(resource);
    if (paused) throw new GitHubPaused(paused, resource);
    const want = init.token ?? { kind: "contents" };
    const token = await this.token(want);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: init.accept ?? "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
    };
    if (init.etag) headers["if-none-match"] = init.etag;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    this.calls += 1;
    const controller = new AbortController();
    const late = new GitHubUnavailable(`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} s.`);
    let answer: Answer;
    const cancel = this.clock.timeout(REQUEST_TIMEOUT_MS, () => controller.abort(late));
    try {
      answer = await new Promise<Answer>((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(late), { once: true });
        this.fetcher(`${GITHUB_API}${path}`, {
          method: init.method ?? "GET",
          headers,
          signal: controller.signal,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        })
          .then(async (response) => {
            if (response.redirected) this.moved = true;
            resolve({ status: response.status, headers: response.headers, body: await response.text() });
          })
          .catch(reject);
      });
    } catch (error) {
      if (error === late) throw late;
      throw new GitHubUnavailable("GitHub is unreachable.");
    } finally {
      cancel();
    }
    this.noteQuota(answer.headers);
    const { status } = answer;
    if ((status >= 200 && status < 300) || status === 304 || status === 404) return answer;
    const retryAfter = Number.parseInt(answer.headers.get("retry-after") ?? "", 10);
    const exhausted = answer.headers.get("x-ratelimit-remaining") === "0";
    const message = messageOf(answer.body);
    const limited = /rate limit|abuse|secondary/i.test(message);
    if (status === 429 || (status === 403 && (Number.isFinite(retryAfter) || exhausted || limited))) {
      if (Number.isFinite(retryAfter)) throw this.pause(resource, Math.max(retryAfter * 1000, limited ? DEFAULT_PAUSE_MS : 0));
      const reset = Number.parseInt(answer.headers.get("x-ratelimit-reset") ?? "", 10);
      if (exhausted && Number.isFinite(reset)) throw this.pause(resource, Math.max(reset * 1000 - this.clock.now(), limited ? DEFAULT_PAUSE_MS : 0));
      throw this.pause(resource, DEFAULT_PAUSE_MS);
    }
    if (status === 401) {
      this.tokens.clear();
      throw new GitHubUnavailable("GitHub refused the token.");
    }
    if (status === 403 && /resource not accessible by integration/i.test(message)) {
      throw new GitHubGone("access_denied", "The GitHub App installation cannot read the repository's contents.");
    }
    throw new GitHubUnavailable(`GitHub answered ${status}${message ? `: ${message.slice(0, 200)}` : ""}.`);
  }

  private noteQuota(headers: Headers): void {
    const limit = Number.parseInt(headers.get("x-ratelimit-limit") ?? "", 10);
    const remaining = Number.parseInt(headers.get("x-ratelimit-remaining") ?? "", 10);
    const reset = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;
    const resource = headers.get("x-ratelimit-resource") ?? "core";
    this.quota.set(resource, { limit, remaining, reset: Number.isFinite(reset) ? reset * 1000 : this.clock.now() + 3_600_000 });
  }

  private json<T>(answer: Answer): T {
    try {
      return JSON.parse(answer.body) as T;
    } catch {
      throw new GitHubUnavailable("GitHub returned a malformed response.");
    }
  }

  private repoPath(rest: string): string {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}${rest}`;
  }

  /** A 404 on the repository's resources: the repository itself, or only the thing asked for. */
  private async gone(): Promise<GitHubGone> {
    const answer = await this.request(this.repoPath(""));
    if (answer.status === 404) return new GitHubGone("repository_not_found", "The repository does not exist or the installation does not grant it.");
    return new GitHubGone("branch_not_found", `The repository has no branch ${this.repo.branch}.`);
  }

  // ---------------------------------------------------------------- calls

  /**
   * The repositories the installation grants, PER_PAGE_MAX a page, at most `max` (in GitHub's
   * order). The one call that reads the installation, not `repo`. `truncated` when it grants more.
   */
  async grantedRepositories(max: number): Promise<{ repositories: GrantedRepository[]; truncated: boolean }> {
    const repositories: GrantedRepository[] = [];
    let total: number | null = null;
    let full = false;
    for (let page = 1; repositories.length < max; page++) {
      const answer = await this.request(`/installation/repositories?per_page=${PER_PAGE_MAX}&page=${page}`, { token: { kind: "metadata" } });
      if (answer.status === 404) throw new GitHubGone("installation_removed", "The GitHub installation is not connected to this organization.");
      const body = this.json<{ total_count?: unknown; repositories?: unknown }>(answer);
      const list = Array.isArray(body.repositories) ? body.repositories : [];
      if (typeof body.total_count === "number") total = body.total_count;
      repositories.push(...list.map(grantedOf).filter((r): r is GrantedRepository => r !== null));
      full = list.length >= PER_PAGE_MAX;
      if (!full) break;
    }
    return { repositories: repositories.slice(0, max), truncated: total !== null ? total > max : full && repositories.length >= max };
  }

  /** The repository as GitHub names it now, its id and default branch (setRepository's check). */
  async repository(): Promise<{ id: number | null; owner: string; name: string; defaultBranch: string }> {
    const answer = await this.request(this.repoPath(""));
    if (answer.status === 404) throw new GitHubGone("repository_not_found", "The repository does not exist or the installation does not grant it.");
    return repositoryOf(this.json(answer));
  }

  /** A repository by its id, wherever it is now (after a rename); null when the installation cannot see it. */
  async locate(id: number): Promise<{ id: number | null; owner: string; name: string; defaultBranch: string } | null> {
    const answer = await this.request(`/repositories/${id}`, { token: { kind: "metadata" } });
    if (answer.status === 404) return null;
    return repositoryOf(this.json(answer));
  }

  /** The branch's head commit; "unchanged" when `etag` still matches (a 304 costs no quota). */
  async head(etag?: string): Promise<{ sha: string; etag: string | null } | "unchanged"> {
    const answer = await this.request(this.repoPath(`/git/ref/heads/${this.repo.branch.split("/").map(encodeURIComponent).join("/")}`), etag ? { etag } : {});
    if (answer.status === 304) return "unchanged";
    if (answer.status === 404) throw await this.gone();
    const body = this.json<{ object?: { sha?: unknown; type?: unknown } }>(answer);
    if (typeof body.object?.sha !== "string") throw new GitHubUnavailable("GitHub returned an invalid ref.");
    return { sha: body.object.sha, etag: answer.headers.get("etag") };
  }

  /**
   * `base...head`, one page of PER_PAGE_MAX commits (the oldest) and at most 300 files; null when
   * GitHub no longer knows `base` (a rewritten history).
   */
  async compare(base: string, head: string): Promise<Comparison | null> {
    const answer = await this.request(this.repoPath(`/compare/${base}...${head}?per_page=${PER_PAGE_MAX}`));
    if (answer.status === 404) return null;
    const body = this.json<{ status?: unknown; total_commits?: unknown; commits?: unknown; files?: unknown }>(answer);
    const status = body.status;
    if (status !== "ahead" && status !== "behind" && status !== "diverged" && status !== "identical") throw new GitHubUnavailable("GitHub returned an invalid comparison.");
    return {
      status,
      totalCommits: typeof body.total_commits === "number" ? body.total_commits : 0,
      commits: Array.isArray(body.commits) ? body.commits.map(commitOf).filter((c): c is CommitInfo => c !== null) : [],
      files: Array.isArray(body.files) ? body.files.map(fileOf).filter((f): f is FileChange => f !== null) : [],
    };
  }

  /**
   * One commit with its files. GitHub lists 300 files a page, up to 3000: a larger commit (an
   * import) takes a call per 300 files.
   */
  async commit(sha: string): Promise<CommitInfo & { files: FileChange[] }> {
    let commit: CommitInfo | null = null;
    const files: FileChange[] = [];
    for (let page = 1; page <= COMMIT_FILE_PAGES; page++) {
      const answer = await this.request(this.repoPath(`/commits/${sha}${page > 1 ? `?page=${page}` : ""}`));
      if (answer.status === 404) throw new GitHubUnavailable(`GitHub has no commit ${sha}.`);
      const body = this.json<{ files?: unknown }>(answer);
      commit ??= commitOf(body);
      if (!commit) throw new GitHubUnavailable("GitHub returned an invalid commit.");
      const list = Array.isArray(body.files) ? body.files : [];
      files.push(...list.map(fileOf).filter((f): f is FileChange => f !== null));
      if (list.length < COMMIT_FILES_PAGE) break;
    }
    return { ...commit!, files };
  }

  /** A tree's entries, not recursive (a commit sha names its root tree); null when there is no such tree. */
  async tree(sha: string): Promise<{ sha: string; entries: TreeEntry[]; truncated: boolean } | null> {
    const answer = await this.request(this.repoPath(`/git/trees/${sha}`));
    if (answer.status === 404) return null;
    const body = this.json<{ sha?: unknown; tree?: unknown; truncated?: unknown }>(answer);
    const entries: TreeEntry[] = [];
    for (const raw of Array.isArray(body.tree) ? body.tree : []) {
      const e = raw as { path?: unknown; type?: unknown; sha?: unknown };
      if (typeof e.path === "string" && typeof e.sha === "string" && (e.type === "blob" || e.type === "tree" || e.type === "commit")) {
        entries.push({ name: e.path, type: e.type, sha: e.sha });
      }
    }
    return { sha: typeof body.sha === "string" ? body.sha : sha, entries, truncated: body.truncated === true };
  }

  /** A blob's text (UTF-8). */
  async blob(sha: string): Promise<string> {
    const answer = await this.request(this.repoPath(`/git/blobs/${sha}`));
    if (answer.status === 404) throw new GitHubUnavailable(`GitHub has no blob ${sha}.`);
    const body = this.json<{ content?: unknown; encoding?: unknown }>(answer);
    if (typeof body.content !== "string") throw new GitHubUnavailable("GitHub returned an invalid blob.");
    if (body.encoding !== "base64") return body.content;
    const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /** Commits that touched `path` (a file or a directory), newest first, from `sha`, dated `until` or before; one page. */
  async commits(input: { sha: string; path: string; page: number; perPage: number; until?: string }): Promise<CommitInfo[]> {
    const query = new URLSearchParams({ sha: input.sha, path: input.path, per_page: String(Math.min(input.perPage, PER_PAGE_MAX)), page: String(input.page) });
    if (input.until) query.set("until", input.until);
    const answer = await this.request(this.repoPath(`/commits?${query}`));
    if (answer.status === 404) return [];
    const body = this.json<unknown>(answer);
    return Array.isArray(body) ? body.map(commitOf).filter((c): c is CommitInfo => c !== null) : [];
  }

  /**
   * Pull request state for GitHub pull request URLs, in one GraphQL query (at most 50 per call),
   * with a token narrowed to their repositories. A URL outside the installation's account, or one
   * the token cannot read, is `unreadable`; a URL that is not a GitHub pull request is left out.
   */
  async pulls(urls: string[]): Promise<Map<string, { state: PullState; title: string } | "unreadable">> {
    const out = new Map<string, { state: PullState; title: string } | "unreadable">();
    const login = (await this.accountLogin()).toLowerCase();
    const targets: { url: string; pr: { owner: string; name: string; number: number } }[] = [];
    for (const url of urls) {
      const pr = pullOf(url);
      if (!pr) continue;
      if (pr.owner.toLowerCase() === login) targets.push({ url, pr });
      else out.set(url, "unreadable");
    }
    if (!targets.length) return out;
    const repositories = [...new Set(targets.map((t) => t.pr.name.toLowerCase()))].sort();
    const fields = targets.map(
      (t, i) => `p${i}: repository(owner: ${JSON.stringify(t.pr.owner)}, name: ${JSON.stringify(t.pr.name)}) { pullRequest(number: ${t.pr.number}) { state isDraft title } }`,
    );
    let answer: Answer;
    try {
      answer = await this.request("/graphql", { token: { kind: "pulls", repositories }, method: "POST", body: { query: `query {\n${fields.join("\n")}\n}` } });
    } catch (error) {
      // The installation lacks the permission, or no longer grants one of the repositories.
      if (error instanceof GitHubGone && error.problem === "access_denied") {
        for (const t of targets) out.set(t.url, "unreadable");
        return out;
      }
      throw error;
    }
    if (answer.status === 404) throw new GitHubUnavailable("GitHub has no GraphQL endpoint.");
    const body = this.json<{ data?: Record<string, { pullRequest?: { state?: unknown; isDraft?: unknown; title?: unknown } | null } | null> | null; errors?: unknown }>(answer);
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

/** `https://github.com/{owner}/{name}/pull/{n}`, or null. Linear: no nested quantifiers. */
export function pullOf(url: string): { owner: string; name: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(url);
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null;
}

/** GitHub's `message` in an error body, or "". */
function messageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed?.message === "string" ? parsed.message : "";
  } catch {
    return body.slice(0, 500);
  }
}

function repositoryOf(raw: unknown): { id: number | null; owner: string; name: string; defaultBranch: string } {
  const body = raw as { id?: unknown; name?: unknown; owner?: { login?: unknown }; default_branch?: unknown };
  if (typeof body?.name !== "string" || typeof body.owner?.login !== "string") throw new GitHubUnavailable("GitHub returned an invalid repository.");
  return {
    id: typeof body.id === "number" ? body.id : null,
    owner: body.owner.login,
    name: body.name,
    defaultBranch: typeof body.default_branch === "string" ? body.default_branch : "main",
  };
}

function grantedOf(raw: unknown): GrantedRepository | null {
  const r = raw as { id?: unknown; name?: unknown; owner?: { login?: unknown }; private?: unknown; default_branch?: unknown; pushed_at?: unknown };
  if (typeof r?.id !== "number" || typeof r.name !== "string" || typeof r.owner?.login !== "string") return null;
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    private: r.private === true,
    defaultBranch: typeof r.default_branch === "string" ? r.default_branch : "main",
    pushedAt: typeof r.pushed_at === "string" && Number.isFinite(Date.parse(r.pushed_at)) ? r.pushed_at : null,
  };
}

function commitOf(raw: unknown): CommitInfo | null {
  const c = raw as { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown; email?: unknown; date?: unknown } } };
  if (typeof c?.sha !== "string" || typeof c.commit?.message !== "string") return null;
  const author = c.commit.author;
  const at = typeof author?.date === "string" && Number.isFinite(Date.parse(author.date)) ? author.date : null;
  return {
    sha: c.sha,
    message: c.commit.message,
    authorName: typeof author?.name === "string" ? author.name : "",
    authorEmail: typeof author?.email === "string" ? author.email : null,
    at,
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
