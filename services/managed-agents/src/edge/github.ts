import type { GitHubAppPermission } from "../protocol.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "opencomputer-managed-agents";
const APP_JWT_BACKDATE_SECONDS = 60;
const APP_JWT_TTL_SECONDS = 540;

export const GITHUB_PERMISSION_KEYS = new Set([
  "actions",
  "checks",
  "contents",
  "issues",
  "metadata",
  "pull_requests",
]);

export type GitHubPermissions = Record<string, GitHubAppPermission>;

export type GitHubMintErrorCode =
  | "github_unavailable"
  | "github_permission_missing"
  | "installation_not_found"
  | "installation_ambiguous"
  | "installation_suspended"
  | "mint_rate_limited"
  | "app_auth_failed"
  | "mint_failed";

export class GitHubMintError extends Error {
  readonly code: GitHubMintErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    code: GitHubMintErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function parseGitHubPermissions(value: unknown): GitHubPermissions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > GITHUB_PERMISSION_KEYS.size) {
    return null;
  }
  const permissions: GitHubPermissions = {};
  for (const [name, level] of entries) {
    if (
      !GITHUB_PERMISSION_KEYS.has(name) ||
      (level !== "read" && level !== "write") ||
      (name === "metadata" && level !== "read")
    ) {
      return null;
    }
    permissions[name] = level;
  }
  return Object.fromEntries(
    Object.entries(permissions).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function pemBody(pem: string, label: string): Uint8Array | null {
  const match = pem.match(
    new RegExp(
      `-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`,
    ),
  );
  if (!match?.[1]) return null;
  const binary = atob(match[1].replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const octetString = [0x04, ...derLength(pkcs1.length)];
  const version = [0x02, 0x01, 0x00];
  const contentLength =
    version.length + algorithm.length + octetString.length + pkcs1.length;
  return Uint8Array.from([
    0x30,
    ...derLength(contentLength),
    ...version,
    ...algorithm,
    ...octetString,
    ...pkcs1,
  ]);
}

export async function importGitHubAppKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.includes("-----BEGIN")
    ? pem
    : (() => {
        try {
          return atob(pem.replace(/\s+/g, ""));
        } catch {
          return pem;
        }
      })();
  const pkcs8 =
    pemBody(normalized, "PRIVATE KEY") ??
    (() => {
      const pkcs1 = pemBody(normalized, "RSA PRIVATE KEY");
      return pkcs1 ? pkcs1ToPkcs8(pkcs1) : null;
    })();
  if (!pkcs8) {
    throw new GitHubMintError(
      "app_auth_failed",
      "The GitHub App private key is not a valid PEM",
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function gitHubAppJwt(
  appId: number,
  key: CryptoKey,
): Promise<string> {
  const encoder = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        iat: now - APP_JWT_BACKDATE_SECONDS,
        exp: now + APP_JWT_TTL_SECONDS,
        iss: String(appId),
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function retryAfterSeconds(response: Response): number | undefined {
  const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter)) {
    return Math.min(Math.max(retryAfter, 1), 600);
  }
  const reset = Number.parseInt(
    response.headers.get("x-ratelimit-reset") ?? "",
    10,
  );
  if (
    response.headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(reset)
  ) {
    return Math.min(
      Math.max(reset - Math.floor(Date.now() / 1000), 1),
      600,
    );
  }
  return undefined;
}

export interface MintedInstallationToken {
  token: string;
  expiresAt: string;
}

export interface GitHubInstallationSummary {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
  appId: number;
}

export async function exchangeGitHubUserCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<string> {
  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": GITHUB_USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
      }),
    });
  } catch {
    throw new GitHubMintError("github_unavailable", "GitHub is unreachable", {
      retryable: true,
    });
  }
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
  } | null;
  if (!response.ok || typeof body?.access_token !== "string") {
    throw new GitHubMintError(
      "app_auth_failed",
      "GitHub rejected the installation authorization",
    );
  }
  return body.access_token;
}

function gitHubHeaders(authorization: string): Record<string, string> {
  return {
    authorization,
    accept: "application/vnd.github+json",
    "user-agent": GITHUB_USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

export async function getGitHubInstallation(
  appJwt: string,
  installationId: number,
): Promise<GitHubInstallationSummary> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
      headers: gitHubHeaders(`Bearer ${appJwt}`),
    });
  } catch {
    throw new GitHubMintError("github_unavailable", "GitHub is unreachable", {
      retryable: true,
    });
  }
  if (response.status === 404) {
    throw new GitHubMintError(
      "installation_not_found",
      "The GitHub installation no longer exists",
    );
  }
  if (!response.ok) {
    throw new GitHubMintError(
      response.status >= 500 ? "github_unavailable" : "mint_failed",
      `GitHub installation lookup failed with ${response.status}`,
      { retryable: response.status >= 500 },
    );
  }
  const body = (await response.json()) as {
    id?: unknown;
    app_id?: unknown;
    account?: { id?: unknown; login?: unknown; type?: unknown };
    repository_selection?: unknown;
    suspended_at?: unknown;
  };
  if (
    typeof body.id !== "number" ||
    typeof body.app_id !== "number" ||
    typeof body.account?.id !== "number" ||
    typeof body.account.login !== "string"
  ) {
    throw new GitHubMintError(
      "mint_failed",
      "GitHub returned an invalid installation response",
    );
  }
  return {
    installationId: body.id,
    appId: body.app_id,
    accountId: body.account.id,
    accountLogin: body.account.login,
    accountType:
      typeof body.account.type === "string" ? body.account.type : "",
    repositorySelection:
      body.repository_selection === "selected" ? "selected" : "all",
    suspended: typeof body.suspended_at === "string",
  };
}

export async function getGitHubUserInstallation(
  userToken: string,
  installationId: number,
): Promise<GitHubInstallationSummary> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/user/installations/${installationId}`, {
      headers: gitHubHeaders(`Bearer ${userToken}`),
    });
  } catch {
    throw new GitHubMintError("github_unavailable", "GitHub is unreachable", {
      retryable: true,
    });
  }
  if (response.status === 404 || response.status === 403) {
    throw new GitHubMintError(
      "installation_not_found",
      "The authorizing GitHub user cannot access this installation",
    );
  }
  if (!response.ok) {
    throw new GitHubMintError(
      response.status >= 500 ? "github_unavailable" : "app_auth_failed",
      `GitHub user installation lookup failed with ${response.status}`,
      { retryable: response.status >= 500 },
    );
  }
  const body = (await response.json()) as {
    id?: unknown;
    app_id?: unknown;
    account?: { id?: unknown; login?: unknown; type?: unknown };
    repository_selection?: unknown;
    suspended_at?: unknown;
  };
  if (
    typeof body.id !== "number" ||
    typeof body.app_id !== "number" ||
    typeof body.account?.id !== "number" ||
    typeof body.account.login !== "string"
  ) {
    throw new GitHubMintError(
      "app_auth_failed",
      "GitHub returned an invalid authorized installation response",
    );
  }
  return {
    installationId: body.id,
    appId: body.app_id,
    accountId: body.account.id,
    accountLogin: body.account.login,
    accountType:
      typeof body.account.type === "string" ? body.account.type : "",
    repositorySelection:
      body.repository_selection === "selected" ? "selected" : "all",
    suspended: typeof body.suspended_at === "string",
  };
}

export async function listGitHubUserInstallations(
  userToken: string,
): Promise<GitHubInstallationSummary[]> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/user/installations?per_page=100`, {
      headers: gitHubHeaders(`Bearer ${userToken}`),
    });
  } catch {
    throw new GitHubMintError("github_unavailable", "GitHub is unreachable", {
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new GitHubMintError(
      response.status >= 500 ? "github_unavailable" : "app_auth_failed",
      `GitHub user installation listing failed with ${response.status}`,
      { retryable: response.status >= 500 },
    );
  }
  const body = (await response.json()) as {
    installations?: Array<{
      id?: unknown;
      app_id?: unknown;
      account?: { id?: unknown; login?: unknown; type?: unknown };
      repository_selection?: unknown;
      suspended_at?: unknown;
    }>;
  };
  if (!Array.isArray(body.installations)) {
    throw new GitHubMintError(
      "app_auth_failed",
      "GitHub returned an invalid installation list",
    );
  }
  return body.installations.flatMap((installation) => {
    if (
      typeof installation.id !== "number" ||
      typeof installation.app_id !== "number" ||
      typeof installation.account?.id !== "number" ||
      typeof installation.account.login !== "string"
    ) {
      return [];
    }
    return [{
      installationId: installation.id,
      appId: installation.app_id,
      accountId: installation.account.id,
      accountLogin: installation.account.login,
      accountType:
        typeof installation.account.type === "string"
          ? installation.account.type
          : "",
      repositorySelection:
        installation.repository_selection === "selected" ? "selected" : "all",
      suspended: typeof installation.suspended_at === "string",
    }];
  });
}

export async function waitForGitHubUserInstallation(
  userToken: string,
  installationId: number,
  options: { attempts?: number; initialDelayMs?: number } = {},
): Promise<GitHubInstallationSummary> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 250);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const installation = (await listGitHubUserInstallations(userToken)).find(
      (candidate) => candidate.installationId === installationId,
    );
    if (installation) return installation;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, initialDelayMs * 2 ** attempt),
      );
    }
  }
  throw new GitHubMintError(
    "installation_not_found",
    "The authorizing GitHub user cannot access this installation",
  );
}

export async function mintGitHubInstallationToken(input: {
  appJwt: string;
  installationId: number;
  /** Omitted: every permission the installation grants. */
  permissions?: GitHubPermissions;
  /** Bare repository names within the installation's account; omitted: all it grants. */
  repositories?: string[];
}): Promise<MintedInstallationToken> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/app/installations/${input.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.appJwt}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": GITHUB_USER_AGENT,
          "x-github-api-version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({
          ...(input.permissions ? { permissions: input.permissions } : {}),
          ...(input.repositories?.length ? { repositories: input.repositories } : {}),
        }),
      },
    );
  } catch {
    throw new GitHubMintError("github_unavailable", "GitHub is unreachable", {
      retryable: true,
    });
  }
  if (response.status === 201) {
    const body = (await response.json()) as {
      token?: unknown;
      expires_at?: unknown;
    };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new GitHubMintError(
        "mint_failed",
        "GitHub returned an invalid installation token response",
      );
    }
    return { token: body.token, expiresAt: body.expires_at };
  }
  if (response.status === 401) {
    throw new GitHubMintError(
      "app_auth_failed",
      "GitHub rejected the App credential",
    );
  }
  if (response.status === 404) {
    throw new GitHubMintError(
      "installation_not_found",
      "The GitHub installation no longer exists",
    );
  }
  if (response.status === 403) {
    const retryAfter = retryAfterSeconds(response);
    if (retryAfter !== undefined) {
      throw new GitHubMintError(
        "mint_rate_limited",
        "GitHub rate limited installation token creation",
        { retryable: true, retryAfterSeconds: retryAfter },
      );
    }
    throw new GitHubMintError(
      "installation_suspended",
      "The GitHub installation is unavailable or suspended",
    );
  }
  if (response.status === 422) {
    throw new GitHubMintError(
      "github_permission_missing",
      "The installation has not granted a requested permission",
    );
  }
  throw new GitHubMintError(
    response.status >= 500 ? "github_unavailable" : "mint_failed",
    `GitHub installation token creation failed with ${response.status}`,
    { retryable: response.status >= 500 },
  );
}

export interface GitHubRepositorySummary {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  /**
   * Only with `details: true` (the computer's repository index, work 056);
   * the public repository-listing routes leave them out.
   */
  description?: string;
  language?: string;
  pushedAt?: string;
}

export interface GitHubRepositoryPage {
  repositories: GitHubRepositorySummary[];
  /** The next page, or `null` when this page ends the installation's grant. */
  nextCursor: string | null;
}

/** At most this many repositories per page, GitHub's own ceiling. */
export const GITHUB_REPOSITORY_PAGE_LIMIT = 100;

/**
 * The page a cursor names. Cursors are opaque to callers; here they are the
 * one-based page number GitHub pages the installation grant by. Anything
 * else is refused rather than read as page one, so a corrupted cursor cannot
 * silently restart a traversal.
 */
export function parseGitHubRepositoryCursor(cursor: string | null): number | null {
  if (cursor === null || cursor === "") return 1;
  if (!/^[1-9][0-9]{0,5}$/.test(cursor)) return null;
  return Number.parseInt(cursor, 10);
}

/**
 * Reads one page of the repositories an installation token can reach, live
 * from GitHub. The token is the caller's: minted for this read with
 * `metadata: read`, never stored. GitHub's selection is the boundary; the
 * page is what it says right now, so a changed selection shows on the next
 * read.
 */
export async function listGitHubInstallationRepositories(input: {
  token: string;
  page: number;
  perPage: number;
  details?: boolean;
}): Promise<GitHubRepositoryPage> {
  const perPage = Math.min(Math.max(input.perPage, 1), GITHUB_REPOSITORY_PAGE_LIMIT);
  const url = new URL(`${GITHUB_API}/installation/repositories`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(input.page));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: gitHubHeaders(`Bearer ${input.token}`),
    });
  } catch {
    throw new GitHubMintError("github_unavailable", "GitHub is unreachable", {
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new GitHubMintError(
      "github_unavailable",
      `GitHub repository listing failed with ${response.status}`,
      { retryable: response.status >= 500 },
    );
  }
  const body = (await response.json().catch(() => null)) as {
    total_count?: unknown;
    repositories?: unknown;
  } | null;
  if (
    !body ||
    typeof body.total_count !== "number" ||
    !Array.isArray(body.repositories)
  ) {
    throw new GitHubMintError(
      "github_unavailable",
      "GitHub returned an invalid repository listing",
    );
  }
  const repositories = body.repositories.flatMap((value: unknown) => {
    const repository = value as {
      id?: unknown;
      full_name?: unknown;
      private?: unknown;
      default_branch?: unknown;
      archived?: unknown;
      description?: unknown;
      language?: unknown;
      pushed_at?: unknown;
    };
    if (
      typeof repository.id !== "number" ||
      typeof repository.full_name !== "string"
    ) {
      return [];
    }
    return [{
      id: repository.id,
      fullName: repository.full_name,
      private: repository.private === true,
      defaultBranch:
        typeof repository.default_branch === "string"
          ? repository.default_branch
          : "",
      archived: repository.archived === true,
      ...(input.details && typeof repository.description === "string" && repository.description
        ? { description: repository.description }
        : {}),
      ...(input.details && typeof repository.language === "string" && repository.language
        ? { language: repository.language }
        : {}),
      ...(input.details && typeof repository.pushed_at === "string" ? { pushedAt: repository.pushed_at } : {}),
    }];
  });
  return {
    repositories,
    nextCursor:
      input.page * perPage < body.total_count ? String(input.page + 1) : null,
  };
}

export interface GitHubBranchSummary {
  name: string;
  commitSha: string;
}

async function gitHubJson<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...gitHubHeaders(`Bearer ${token}`),
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new GitHubMintError("github_unavailable", "GitHub is unreachable", {
      retryable: true,
    });
  }
  if (response.status === 404) {
    throw new GitHubMintError(
      "installation_not_found",
      "GitHub could not find the requested repository resource",
    );
  }
  if (!response.ok) {
    throw new GitHubMintError(
      "github_unavailable",
      `GitHub request failed with ${response.status}`,
      { retryable: response.status >= 500 },
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new GitHubMintError(
      "github_unavailable",
      "GitHub returned a malformed response",
      { retryable: true },
    );
  }
}

const GITHUB_BRANCH_PAGE_SIZE = 100;
const GITHUB_BRANCH_PAGE_LIMIT = 10;

/**
 * Branches of a repository the token can read (`metadata: read`), following
 * GitHub's pages up to `GITHUB_BRANCH_PAGE_LIMIT` (1000 branches).
 */
export async function listGitHubRepositoryBranches(input: {
  token: string;
  fullName: string;
}): Promise<GitHubBranchSummary[]> {
  const branches: GitHubBranchSummary[] = [];
  for (let page = 1; page <= GITHUB_BRANCH_PAGE_LIMIT; page++) {
    const body = await gitHubJson<unknown>(
      input.token,
      `/repos/${input.fullName}/branches?per_page=${String(GITHUB_BRANCH_PAGE_SIZE)}&page=${String(page)}`,
    );
    if (!Array.isArray(body)) {
      throw new GitHubMintError(
        "github_unavailable",
        "GitHub returned an invalid branch listing",
      );
    }
    for (const value of body as unknown[]) {
      const branch = value as { name?: unknown; commit?: { sha?: unknown } };
      if (typeof branch.name === "string" && typeof branch.commit?.sha === "string") {
        branches.push({ name: branch.name, commitSha: branch.commit.sha });
      }
    }
    if (body.length < GITHUB_BRANCH_PAGE_SIZE) break;
  }
  return branches;
}

export interface GitHubRepositoryIdentity {
  id: number;
  fullName: string;
  defaultBranch: string;
}

/** The repository GitHub knows under `fullName`, as the token sees it. */
export async function getGitHubRepository(input: {
  token: string;
  fullName: string;
}): Promise<GitHubRepositoryIdentity> {
  const body = await gitHubJson<{
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  }>(input.token, `/repos/${input.fullName}`);
  if (typeof body.id !== "number" || typeof body.full_name !== "string") {
    throw new GitHubMintError(
      "github_unavailable",
      "GitHub returned an invalid repository",
    );
  }
  return {
    id: body.id,
    fullName: body.full_name,
    defaultBranch:
      typeof body.default_branch === "string" ? body.default_branch : "",
  };
}

/** The commit currently at the tip of a branch. */
export async function getGitHubBranchHead(input: {
  token: string;
  fullName: string;
  branch: string;
}): Promise<GitHubBranchSummary> {
  const body = await gitHubJson<{ name?: unknown; commit?: { sha?: unknown } }>(
    input.token,
    `/repos/${input.fullName}/branches/${encodeURIComponent(input.branch)}`,
  );
  if (typeof body.name !== "string" || typeof body.commit?.sha !== "string") {
    throw new GitHubMintError(
      "github_unavailable",
      "GitHub returned an invalid branch",
    );
  }
  return { name: body.name, commitSha: body.commit.sha };
}

/** The current head commit of a pull request (`pull_requests: read`). */
export async function getGitHubPullRequestHead(input: {
  token: string;
  fullName: string;
  pullRequestNumber: number;
}): Promise<{ commitSha: string; state: string }> {
  const body = await gitHubJson<{ state?: unknown; head?: { sha?: unknown } }>(
    input.token,
    `/repos/${input.fullName}/pulls/${String(input.pullRequestNumber)}`,
  );
  if (typeof body.state !== "string" || typeof body.head?.sha !== "string") {
    throw new GitHubMintError(
      "github_unavailable",
      "GitHub returned an invalid pull request",
    );
  }
  return { commitSha: body.head.sha, state: body.state };
}

/** Posts a comment on a pull request (`pull_requests: write`). */
export async function createGitHubPullRequestComment(input: {
  token: string;
  fullName: string;
  pullRequestNumber: number;
  body: string;
}): Promise<void> {
  await gitHubJson(
    input.token,
    `/repos/${input.fullName}/issues/${String(input.pullRequestNumber)}/comments`,
    { method: "POST", body: { body: input.body } },
  );
}

export interface GitHubCheckRunOutput {
  title: string;
  summary?: string;
}

/** The id of the check run created on a commit (`checks: write`). */
export async function createGitHubCheckRun(input: {
  token: string;
  fullName: string;
  headSha: string;
  name: string;
  status?: "queued" | "completed";
  conclusion?: "skipped";
  detailsUrl?: string;
  output: GitHubCheckRunOutput;
}): Promise<number | null> {
  const body = await gitHubJson<{ id?: unknown }>(
    input.token,
    `/repos/${input.fullName}/check-runs`,
    {
      method: "POST",
      body: {
        name: input.name,
        head_sha: input.headSha,
        status: input.status ?? "queued",
        ...(input.conclusion ? { conclusion: input.conclusion } : {}),
        ...(input.status === "completed"
          ? { completed_at: new Date().toISOString() }
          : {}),
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        output: {
          title: input.output.title,
          summary: input.output.summary ?? "",
        },
      },
    },
  );
  return typeof body.id === "number" ? body.id : null;
}

/** Mirrors a build's state onto its check run (`checks: write`). */
export async function updateGitHubCheckRun(input: {
  token: string;
  fullName: string;
  checkRunId: number;
  status: "queued" | "in_progress" | "completed";
  conclusion?:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped";
  detailsUrl?: string;
  output: GitHubCheckRunOutput;
}): Promise<void> {
  await gitHubJson(
    input.token,
    `/repos/${input.fullName}/check-runs/${String(input.checkRunId)}`,
    {
      method: "PATCH",
      body: {
        status: input.status,
        ...(input.status === "in_progress"
          ? { started_at: new Date().toISOString() }
          : {}),
        ...(input.status === "completed"
          ? { completed_at: new Date().toISOString() }
          : {}),
        ...(input.conclusion ? { conclusion: input.conclusion } : {}),
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        output: {
          title: input.output.title,
          summary: input.output.summary ?? "",
        },
      },
    },
  );
}

const GITHUB_PULL_FILES_PAGE_SIZE = 100;
/** The pulls API stops listing after 3000 files. */
const GITHUB_PULL_FILES_PAGE_LIMIT = 30;

/** Files a pull request changes (`pull_requests: read`). */
export async function listGitHubPullRequestFiles(input: {
  token: string;
  fullName: string;
  pullRequestNumber: number;
}): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= GITHUB_PULL_FILES_PAGE_LIMIT; page++) {
    const body = await gitHubJson<unknown>(
      input.token,
      `/repos/${input.fullName}/pulls/${String(input.pullRequestNumber)}/files?per_page=${String(GITHUB_PULL_FILES_PAGE_SIZE)}&page=${String(page)}`,
    );
    if (!Array.isArray(body)) {
      throw new GitHubMintError(
        "github_unavailable",
        "GitHub returned an invalid pull request file listing",
      );
    }
    for (const value of body as unknown[]) {
      const file = value as { filename?: unknown };
      if (typeof file.filename === "string") files.push(file.filename);
    }
    if (body.length < GITHUB_PULL_FILES_PAGE_SIZE) break;
  }
  return files;
}

/** Verifies GitHub's `X-Hub-Signature-256` over the raw webhook body. */
export async function verifyGitHubWebhookSignature(
  secret: string,
  body: ArrayBuffer,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, body)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const expected = signatureHeader.slice("sha256=".length).toLowerCase();
  if (expected.length !== digest.length) return false;
  let difference = 0;
  for (let index = 0; index < digest.length; index++) {
    difference |= digest.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
