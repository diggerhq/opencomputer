// The knowledge repository setting (spec 35.1 `meta.knowledge`, 37: `GET`/`PUT /work/repository`,
// `GET /work/repositories`), held by Org. The Work board that used to hold it is retired (spec 43);
// the setting and the picker keep their contract.
//
// - The setting is `meta.knowledge`, the stored repository as JSON. Computer reads `owner/name`
//   from it through `forHost`.
// - `PUT` checks the choice against GitHub (the installation's account is the owner, the repository
//   and the branch exist) and stores the names GitHub gives. `GET /work/repositories` lists what
//   the organization's active installations grant, a page at a time, read from GitHub every call.
// - Tokens come from the Account object, narrowed: `contents: read` to the chosen repository for the
//   check, `metadata: read` for the listing. Nothing is held between calls.

import type { GitHubTokenMint } from "../../protocol.js";
import type { Refusal, Reply } from "../../durable/rpc-reply.js";
import type { Sql } from "../../durable/sql.js";
import { owed } from "../../durable/outbox.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "opencomputer-managed-agents";
/** Every GitHub request, its body included, is aborted after this. */
const REQUEST_TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
/** The last page a listing reads: 10,000 repositories an installation. */
export const GRANTED_PAGES_MAX = 100;

/** Why the repository cannot be read. A stable code. */
export type RepositoryProblem =
  | "installation_removed"
  | "installation_suspended"
  | "repository_not_found"
  | "branch_not_found"
  | "access_denied"
  | "github_app_not_configured";

/** The setting as stored: what the Work index stored under `repo`, the same shape. */
export interface StoredRepository {
  installationId: string;
  owner: string;
  name: string;
  branch: string;
  /** GitHub's id for the repository, which survives renames. */
  id?: number;
}

/** The knowledge repository setting, as the API shows it. */
export interface Repository {
  installationId: string;
  owner: string;
  name: string;
  branch: string;
  problem: RepositoryProblem | null;
  problemMessage: string | null;
}

/** What `PUT /work/repository` asks for; the branch defaults to the repository's default branch. */
export interface RepositoryChoice {
  installationId: string;
  owner: string;
  name: string;
  branch?: string;
}

/** A repository an installation grants, as the picker lists it. */
export interface GrantedRepository {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

/** One of the organization's active GitHub installations, with a page of what it grants. */
export interface GrantingInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
  settingsUrl: string;
  repositories: GrantedRepository[];
  nextPage: number | null;
  truncated: boolean;
  problem: RepositoryProblem | null;
  problemMessage: string | null;
}

export interface RepositoriesQuery {
  installationId?: string;
  page?: number;
}

/** What Org needs of the Account object. */
export interface TokenMinter {
  mintGitHubInstallationToken(input: { installationId: string; permissions?: Record<string, "read" | "write">; repositories?: string[] }): Promise<GitHubTokenMint>;
  getGitHubInstallation(installationId: string): Promise<{ accountLogin: string } | null> | { accountLogin: string } | null;
  listGitHubInstallations(): Promise<AccountInstallation[]> | AccountInstallation[];
}

export interface AccountInstallation {
  id: string;
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  state: string;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// ------------------------------------------------------------------ the setting in Org's SQL

export function storedRepository(sql: Sql): StoredRepository | null {
  const raw = sql.exec<{ knowledge: string | null }>("SELECT knowledge FROM meta WHERE k = 1")[0]!.knowledge;
  return raw ? (JSON.parse(raw) as StoredRepository) : null;
}

export const shown = (repo: StoredRepository | null): Repository | null =>
  repo && { installationId: repo.installationId, owner: repo.owner, name: repo.name, branch: repo.branch, problem: null, problemMessage: null };

/** `owner/name`, as a host's workspace definition names it. */
export const fullName = (repo: StoredRepository | null): string | null => (repo ? `${repo.owner}/${repo.name}` : null);

/** Stores the setting; when the repository a host sees changed, Computer is owed `changed`. */
export function storeRepository(sql: Sql, repo: StoredRepository): void {
  const before = fullName(storedRepository(sql));
  sql.transaction(() => {
    sql.exec("UPDATE meta SET knowledge = ? WHERE k = 1", JSON.stringify(repo));
    if (before !== fullName(repo)) owed.add(sql, { group: "changed", key: "changed:org", call: "Computer.changed", body: {} });
  });
}

// ------------------------------------------------------------------ requests

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Invalid = { status: 400; error: { code: "invalid_request"; message: string; field: string } };
const invalid = (message: string, field: string): Invalid => ({ status: 400, error: { code: "invalid_request", message, field } });

export function repositoryChoice(body: unknown): { value: RepositoryChoice } | { error: Invalid } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: invalid("The body must be a JSON object.", "") };
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["installationId", "owner", "name", "branch"].includes(key)) return { error: invalid(`Unknown field ${key}.`, key) };
  }
  const { installationId, owner, name, branch } = input;
  const installation =
    typeof installationId === "number" && Number.isSafeInteger(installationId) && installationId > 0
      ? String(installationId)
      : typeof installationId === "string" && INSTALLATION_ID.test(installationId)
        ? installationId
        : null;
  if (installation === null) return { error: invalid("installationId is the GitHub installation's id.", "installationId") };
  if (typeof owner !== "string" || !OWNER.test(owner)) return { error: invalid("owner is a GitHub account login.", "owner") };
  if (typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") return { error: invalid("name is a GitHub repository name.", "name") };
  if (branch !== undefined && branch !== null && (typeof branch !== "string" || !branchName(branch))) return { error: invalid("branch is a branch name.", "branch") };
  return { value: { installationId: installation, owner, name, ...(typeof branch === "string" ? { branch } : {}) } };
}

/** `GET /work/repositories`' query: `installation` and `page`, a later page only of one installation. */
export function repositoriesQuery(query: URLSearchParams): { value: RepositoriesQuery } | { error: Invalid } {
  for (const name of new Set(query.keys())) {
    if (name !== "installation" && name !== "page") return { error: invalid(`Unknown query parameter ${name}.`, name) };
  }
  const installation = query.get("installation");
  const rawPage = query.get("page");
  if (installation !== null && !INSTALLATION_ID.test(installation)) return { error: invalid("installation is an installation id.", "installation") };
  if (rawPage !== null && (!/^[1-9]\d{0,2}$/.test(rawPage) || Number(rawPage) > GRANTED_PAGES_MAX)) return { error: invalid(`page is 1 to ${GRANTED_PAGES_MAX}.`, "page") };
  if (rawPage !== null && rawPage !== "1" && installation === null) return { error: invalid("A later page is of one installation.", "installation") };
  return { value: { ...(installation !== null ? { installationId: installation } : {}), ...(rawPage !== null ? { page: Number(rawPage) } : {}) } };
}

/** A name `git check-ref-format --branch` accepts, at most 255 characters. */
export function branchName(name: string): boolean {
  if (name.length < 1 || name.length > 255 || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x21 || c === 0x7f || "~^:?*[\\".includes(name[i]!)) return false;
  }
  return name.split("/").every((segment) => !segment.startsWith(".") && !segment.endsWith(".lock"));
}

// ------------------------------------------------------------------ GitHub

/** A permanent refusal: the choice names something the installation cannot reach. */
class Gone extends Error {
  constructor(readonly problem: RepositoryProblem, message: string) {
    super(message);
  }
}

/** A temporary failure; `retryAfterMs` when GitHub asked us to wait. */
class Unavailable extends Error {
  constructor(readonly retryAfterMs = 5_000) {
    super("GitHub could not be reached.");
  }
}

const NOT_CONNECTED = "The GitHub installation is not connected to this organization.";
const NO_REPOSITORY = "The repository does not exist or the installation does not grant it.";

async function token(account: TokenMinter, installationId: string, want: { permissions: Record<string, "read">; repositories?: string[] }): Promise<string> {
  const minted = await account.mintGitHubInstallationToken({ installationId, ...want });
  if (minted.outcome === "minted") return minted.token;
  if (minted.outcome === "not_connected") throw new Gone("installation_removed", NOT_CONNECTED);
  if (minted.outcome === "app_not_configured") throw new Gone("github_app_not_configured", "The GitHub App is not configured.");
  if (minted.code === "installation_not_found") throw new Gone("installation_removed", minted.message);
  if (minted.code === "installation_suspended") throw new Gone("installation_suspended", minted.message);
  // A narrowed mint for a repository the installation does not grant is refused with 422.
  if (minted.code === "github_permission_missing") throw new Gone(want.repositories ? "repository_not_found" : "access_denied", minted.message);
  throw new Unavailable(minted.code === "mint_rate_limited" ? (minted.retryAfterSeconds ?? 60) * 1000 : 5_000);
}

/** One GET: the parsed body, or null on 404. A rate limit is `Unavailable` with its wait. */
async function get<T>(fetch: Fetch, bearer: string, path: string): Promise<T | null> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/vnd.github+json", "user-agent": USER_AGENT, "x-github-api-version": GITHUB_API_VERSION },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw new Unavailable();
  }
  if (res.status === 404) return null;
  if (res.status >= 200 && res.status < 300) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Unavailable();
    }
  }
  const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter)) throw new Unavailable(Math.max(1000, retryAfter * 1000));
  if (res.status === 403 && /resource not accessible by integration/i.test(text)) throw new Gone("access_denied", "The GitHub App installation cannot read the repository's contents.");
  throw new Unavailable(res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" ? 60_000 : 5_000);
}

const unavailable = (error: unknown): Refusal => ({
  ok: false,
  code: "unavailable",
  status: 503,
  message: "GitHub could not be reached. Try again shortly.",
  retryAfterMs: error instanceof Unavailable ? error.retryAfterMs : 5_000,
});

/** Checks the choice against GitHub and answers what to store: the names GitHub gives, the branch it has. */
export async function checkChoice(account: TokenMinter, fetch: Fetch, choice: RepositoryChoice): Promise<Reply<{ repository: StoredRepository }>> {
  try {
    const installation = await account.getGitHubInstallation(choice.installationId);
    if (!installation) throw new Gone("installation_removed", NOT_CONNECTED);
    const login = installation.accountLogin;
    if (login.toLowerCase() !== choice.owner.toLowerCase()) {
      return { ok: false, status: 400, code: "invalid_request", message: `The installation is on the GitHub account ${login}; owner must be ${login}.`, field: "owner", reason: "owner_mismatch" };
    }
    const bearer = await token(account, choice.installationId, { permissions: { contents: "read" }, repositories: [choice.name] });
    const repoPath = `/repos/${encodeURIComponent(choice.owner)}/${encodeURIComponent(choice.name)}`;
    const found = await get<{ id?: unknown; name?: unknown; owner?: { login?: unknown }; default_branch?: unknown }>(fetch, bearer, repoPath);
    if (!found) throw new Gone("repository_not_found", NO_REPOSITORY);
    if (typeof found.name !== "string" || typeof found.owner?.login !== "string") throw new Unavailable();
    const branch = choice.branch ?? (typeof found.default_branch === "string" ? found.default_branch : "main");
    const ref = await get(fetch, bearer, `${repoPath}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
    if (!ref) throw new Gone("branch_not_found", `The repository has no branch ${branch}.`);
    return {
      ok: true,
      repository: { installationId: choice.installationId, owner: found.owner.login, name: found.name, branch, ...(typeof found.id === "number" ? { id: found.id } : {}) },
    };
  } catch (error) {
    if (!(error instanceof Gone)) return unavailable(error);
    const field = error.problem === "branch_not_found" ? "branch" : error.problem === "repository_not_found" ? "name" : "installationId";
    return { ok: false, status: 400, code: "invalid_request", message: error.message, field, reason: error.problem };
  }
}

/** The organization's active installations (or the one asked for), each with a page of what it grants. */
export async function listGranted(account: TokenMinter, fetch: Fetch, query: RepositoriesQuery): Promise<Reply<{ installations: GrantingInstallation[] }>> {
  const page = query.page ?? 1;
  try {
    const active = (await account.listGitHubInstallations()).filter((i) => i.state === "active" && (query.installationId === undefined || String(i.id) === query.installationId));
    const installations = await Promise.all(
      active.map(async (i): Promise<GrantingInstallation> => {
        const organization = i.accountType.toLowerCase() === "organization";
        const base = {
          id: String(i.id),
          accountLogin: i.accountLogin,
          accountType: organization ? "Organization" : "User",
          settingsUrl: organization
            ? `https://github.com/organizations/${encodeURIComponent(i.accountLogin)}/settings/installations/${i.githubInstallationId}`
            : `https://github.com/settings/installations/${i.githubInstallationId}`,
        };
        try {
          const bearer = await token(account, base.id, { permissions: { metadata: "read" } });
          const body = await get<{ total_count?: unknown; repositories?: unknown }>(fetch, bearer, `/installation/repositories?per_page=${PER_PAGE}&page=${page}`);
          if (!body) throw new Gone("installation_removed", NOT_CONNECTED);
          const list = Array.isArray(body.repositories) ? body.repositories : [];
          const more = typeof body.total_count === "number" ? page * PER_PAGE < body.total_count : list.length >= PER_PAGE;
          const nextPage = more && page < GRANTED_PAGES_MAX ? page + 1 : null;
          const repositories = list.map(grantedOf).filter((r): r is GrantedRepository => r !== null).sort(byPushed);
          return { ...base, repositories, truncated: more && nextPage === null, nextPage, problem: null, problemMessage: null };
        } catch (error) {
          if (!(error instanceof Gone)) throw error;
          return { ...base, repositories: [], truncated: false, nextPage: null, problem: error.problem, problemMessage: error.message };
        }
      }),
    );
    return { ok: true, installations };
  } catch (error) {
    return unavailable(error);
  }
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

/** Most recently pushed first; never pushed last. */
function byPushed(a: GrantedRepository, b: GrantedRepository): number {
  if (a.pushedAt !== b.pushedAt) {
    if (a.pushedAt === null) return 1;
    if (b.pushedAt === null) return -1;
    return Date.parse(b.pushedAt) - Date.parse(a.pushedAt);
  }
  return a.name.localeCompare(b.name);
}
