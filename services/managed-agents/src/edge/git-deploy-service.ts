/**
 * Project deployment sources: a GitHub repository and branch a project
 * deploys from. Pushes to the branch publish a build to the project's
 * development environment; pull requests against the branch publish an
 * isolated preview under the `pr-<number>` alias, addressable as
 * `<agent>@pr-<number>` from sessions, the playground, and the API.
 *
 * Source configuration and build history live in D1 so a GitHub webhook,
 * which only names an installation and a repository, can find the owning
 * account without touching every Account Durable Object.
 */
import type {
  GitHubInstallation,
  GitHubTokenMint,
  Project,
  ProjectResourceManifest,
  RegisterDeploymentInput,
} from "../protocol.js";
import type { RequestIdentity } from "./auth.js";
import {
  createGitHubCheckRun,
  createGitHubPullRequestComment,
  getGitHubBranchHead,
  getGitHubPullRequestHead,
  getGitHubRepository,
  GitHubMintError,
  listGitHubInstallationRepositories,
  listGitHubPullRequestFiles,
  listGitHubRepositoryBranches,
  parseGitHubRepositoryCursor,
  updateGitHubCheckRun,
  verifyGitHubWebhookSignature,
  type GitHubRepositoryPage,
} from "./github.js";
import { json, problem, readBoundedJson } from "./http.js";
import { databaseObjectName, type DatabaseNamespace } from "./database-contract.js";
import { environmentOfMode, isProjectEnvironmentName } from "./project-scope.js";
import {
  admitDeploymentModels,
} from "./deployment-admission.js";
import {
  taskAuthorized,
  templateDeployments,
  triggerTask,
  uploadArtifact,
  validTemplateBundle,
  type StoredArtifact,
  type TemplateEnv,
} from "./template-service.js";

export type GitDeployEnv = TemplateEnv & {
  OC_GITHUB_APP_WEBHOOK_SECRET?: string;
  DATABASES?: DatabaseNamespace;
};

type AccountStub = ReturnType<Env["ACCOUNTS"]["getByName"]>;

const BUILD_TASK_ID = "deploy-serverless-agent-git-build";
const MAX_LISTED_BUILDS = 50;
// A build the runner never reports back on stays `building` forever (the
// task's onFailure can itself fail, e.g. misconfigured env, or the run is
// lost). 90 min covers the worst case of 3 × 20-min attempts plus backoff.
const BUILD_STALE_MS = 90 * 60 * 1000;
const BUILD_STALE_ERROR = "Build timed out waiting for the runner.";
const MAX_BRANCH_LENGTH = 255;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
// Repository listings change rarely but each read costs a token mint plus a
// GitHub page fetch, which is the Settings page's slowest load. Stale rows
// are still served when GitHub itself fails; installation_repositories and
// repository webhook events purge the cache outright.
const REPOSITORY_CACHE_TTL_MS = 15 * 60 * 1000;

interface SourceRow {
  project_id: string;
  account_id: string;
  installation_id: string;
  github_installation_id: number;
  repository_id: number;
  repository_full_name: string;
  branch: string;
  source_path: string | null;
  previews_enabled: number;
  created_at: string;
  updated_at: string;
}

interface BuildRow {
  id: string;
  project_id: string;
  account_id: string;
  kind: string;
  alias: string;
  ref: string;
  commit_sha: string;
  pull_request_number: number | null;
  pull_request_title: string | null;
  pull_request_url: string | null;
  state: string;
  trigger_run_id: string | null;
  error_message: string | null;
  installation_id: string | null;
  repository_full_name: string | null;
  source_updated_at: string | null;
  check_run_id: number | null;
  created_at: string;
  updated_at: string;
}

export type GitBuildKind = "branch" | "preview";
export type GitBuildState =
  | "queued"
  | "building"
  | "ready"
  | "failed"
  | "superseded"
  | "removed";

/** Git sources still call the main branch `development`; single-mode projects do not. */
export function gitDeploymentAlias(
  project: Pick<Project, "environmentMode">,
  alias: string,
): string {
  return project.environmentMode === "single" && alias === "development"
    ? "default"
    : alias;
}

/** A build is pinned to the source that queued it: connection, repository, and source revision. */
function buildMatchesSource(build: BuildRow, source: SourceRow): boolean {
  return (
    build.installation_id === source.installation_id &&
    build.repository_full_name === source.repository_full_name &&
    build.source_updated_at === source.updated_at
  );
}

function projectArchived(project: Project | null): boolean {
  return !project || Boolean(project.archivedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function appUrl(env: Pick<GitDeployEnv, "OPENCOMPUTER_APP_URL">): string {
  return (env.OPENCOMPUTER_APP_URL ?? "https://app.opencomputer.dev").replace(
    /\/$/,
    "",
  );
}

export function previewAlias(pullRequestNumber: number): string {
  return `pr-${String(pullRequestNumber)}`;
}

export function isPreviewAlias(alias: string): boolean {
  return /^pr-[1-9][0-9]{0,8}$/.test(alias);
}

function previewUrl(
  env: Pick<GitDeployEnv, "OPENCOMPUTER_APP_URL">,
  projectId: string,
  alias: string,
): string {
  return `${appUrl(env)}/projects/${encodeURIComponent(projectId)}?environment=${encodeURIComponent(alias)}`;
}

function validBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BRANCH_LENGTH &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".lock") &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(value) &&
    !value.includes("@{")
  );
}

/** Repo-relative directory the template compiles from, or null for the root. */
export function normalizeSourcePath(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") return null;
  if (
    trimmed.length > 500 ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[\x00-\x1f\x7f]/.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function validRepositoryFullName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value) &&
    !value.endsWith(".git")
  );
}

function sourceView(
  row: SourceRow,
  installation: GitHubInstallation | null,
): Record<string, unknown> {
  return {
    projectId: row.project_id,
    connectionId: row.installation_id,
    repository: {
      id: row.repository_id,
      fullName: row.repository_full_name,
      url: `https://github.com/${row.repository_full_name}`,
    },
    branch: row.branch,
    path: row.source_path,
    previewsEnabled: row.previews_enabled === 1,
    connection: installation
      ? {
          id: installation.id,
          accountLogin: installation.accountLogin,
          state: installation.state,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildView(env: GitDeployEnv, row: BuildRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    alias: row.alias,
    ref: row.ref,
    commitSha: row.commit_sha,
    ...(row.pull_request_number
      ? {
          pullRequest: {
            number: row.pull_request_number,
            title: row.pull_request_title ?? "",
            url: row.pull_request_url ?? "",
          },
        }
      : {}),
    state: row.state,
    ...(row.error_message ? { error: row.error_message } : {}),
    ...(row.kind === "preview" && row.state === "ready"
      ? { previewUrl: previewUrl(env, row.project_id, row.alias) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadSource(
  env: GitDeployEnv,
  projectId: string,
): Promise<SourceRow | null> {
  return env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM project_git_sources WHERE project_id = ?",
  )
    .bind(projectId)
    .first<SourceRow>();
}

/** Fails builds the runner never reported on once they outlive the
 * task's worst-case runtime; called on every build list so a lost run
 * cannot wedge a project in `building` forever. */
export async function sweepStaleGitBuilds(
  env: Pick<GitDeployEnv, "SERVERLESS_AGENTS_DB"> &
    Partial<Pick<GitDeployEnv, "ACCOUNTS" | "OPENCOMPUTER_APP_URL">>,
  projectId: string,
): Promise<void> {
  const stale = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT id FROM project_git_builds
     WHERE project_id = ? AND state IN ('queued', 'building')
       AND created_at < datetime('now', ?)`,
  )
    .bind(projectId, `-${Math.round(BUILD_STALE_MS / 60000)} minutes`)
    .all<{ id: string }>();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE project_git_builds SET state = 'failed', error_message = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND state IN ('queued', 'building')
       AND created_at < datetime('now', ?)`,
  )
    .bind(
      BUILD_STALE_ERROR,
      projectId,
      `-${Math.round(BUILD_STALE_MS / 60000)} minutes`,
    )
    .run();
  if (env.ACCOUNTS) {
    const fullEnv = { ...env, ACCOUNTS: env.ACCOUNTS };
    for (const row of stale.results) {
      await reflectBuildCheck(fullEnv, row.id);
    }
  }
}

async function listBuilds(
  env: GitDeployEnv,
  projectId: string,
): Promise<BuildRow[]> {
  await sweepStaleGitBuilds(env, projectId);
  const result = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT * FROM project_git_builds WHERE project_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(projectId, MAX_LISTED_BUILDS)
    .all<BuildRow>();
  return result.results;
}

/** Open previews: the newest build per preview alias that is not removed. */
function activePreviews(env: GitDeployEnv, builds: BuildRow[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const previews: Record<string, unknown>[] = [];
  for (const build of builds) {
    if (build.kind !== "preview" || seen.has(build.alias)) continue;
    seen.add(build.alias);
    if (build.state === "removed") continue;
    previews.push(buildView(env, build));
  }
  return previews;
}

async function statusBody(
  env: GitDeployEnv,
  account: AccountStub,
  projectId: string,
): Promise<Record<string, unknown>> {
  const source = await loadSource(env, projectId);
  const builds = await listBuilds(env, projectId);
  const installation = source
    ? await account.getGitHubInstallation(source.installation_id)
    : null;
  return {
    source: source ? sourceView(source, installation) : null,
    builds: builds.map((row) => buildView(env, row)),
    previews: activePreviews(env, builds),
  };
}

function mintProblem(minted: GitHubTokenMint): Response | null {
  if (minted.outcome === "minted") return null;
  if (minted.outcome === "not_connected") {
    return problem(
      404,
      "github_connection_not_found",
      "GitHub connection not found",
    );
  }
  if (minted.outcome === "app_not_configured") {
    return problem(
      503,
      "github_app_not_configured",
      "The managed OpenComputer GitHub App is not configured",
    );
  }
  if (minted.code === "installation_not_found") {
    return problem(404, "github_connection_not_found", minted.message);
  }
  if (minted.code === "installation_suspended") {
    return problem(409, "installation_suspended", minted.message);
  }
  return problem(502, "github_unavailable", minted.message);
}

function buildCheckName(kind: GitBuildKind): string {
  return kind === "preview" ? "OpenComputer preview" : "OpenComputer deploy";
}

/** A checks:write token for the installation, or null when the app is not granted it. */
async function mintChecksToken(
  env: Pick<GitDeployEnv, "ACCOUNTS">,
  accountId: string,
  installationId: string,
): Promise<string | null> {
  const minted = await env.ACCOUNTS.getByName(accountId)
    .mintGitHubInstallationToken({
      installationId,
      permissions: { checks: "write" },
    })
    .catch(() => null);
  if (!minted || minted.outcome !== "minted") return null;
  return minted.token;
}

/** The check run opened for a build, or null when checks are unavailable. */
async function createBuildCheck(
  env: GitDeployEnv,
  source: SourceRow,
  input: { kind: GitBuildKind; alias: string; commitSha: string },
): Promise<number | null> {
  const token = await mintChecksToken(
    env,
    source.account_id,
    source.installation_id,
  );
  if (!token) return null;
  try {
    return await createGitHubCheckRun({
      token,
      fullName: source.repository_full_name,
      headSha: input.commitSha,
      name: buildCheckName(input.kind),
      ...(input.kind === "preview"
        ? { detailsUrl: previewUrl(env, source.project_id, input.alias) }
        : {}),
      output: {
        title:
          input.kind === "preview"
            ? `Preview ${input.alias} queued`
            : `Deploy ${input.alias} queued`,
        summary: `Commit ${input.commitSha.slice(0, 7)}`,
      },
    });
  } catch {
    return null;
  }
}

/** A completed "skipped" check recording why an event queued no build. */
async function skippedBuildCheck(
  env: GitDeployEnv,
  source: SourceRow,
  kind: GitBuildKind,
  commitSha: string,
  reason: string,
): Promise<void> {
  const token = await mintChecksToken(
    env,
    source.account_id,
    source.installation_id,
  );
  if (!token) return;
  await createGitHubCheckRun({
    token,
    fullName: source.repository_full_name,
    headSha: commitSha,
    name: buildCheckName(kind),
    status: "completed",
    conclusion: "skipped",
    output: {
      title: `Skipped — ${reason}`,
      summary: `Commit ${commitSha.slice(0, 7)}`,
    },
  }).catch(() => undefined);
}

/** Mirrors a build's current state onto its check run; never fails the caller. Returns true only when an update was applied — false when there is no check run or it could not be written, so a preview can fall back to announcing through the PR comment. */
async function reflectBuildCheck(
  env: Pick<GitDeployEnv, "SERVERLESS_AGENTS_DB" | "ACCOUNTS"> &
    Partial<Pick<GitDeployEnv, "OPENCOMPUTER_APP_URL">>,
  buildId: string,
): Promise<boolean> {
  const build = await loadBuild(env, buildId);
  if (
    !build?.check_run_id ||
    !build.installation_id ||
    !build.repository_full_name
  ) {
    return false;
  }
  const shortSha = build.commit_sha.slice(0, 7);
  let update:
    | {
        status: "queued" | "in_progress" | "completed";
        conclusion?: "success" | "failure" | "cancelled";
        detailsUrl?: string;
        output: { title: string; summary: string };
      }
    | undefined;
  switch (build.state) {
    case "queued":
      update = {
        status: "queued",
        output: { title: "Build queued", summary: `Commit ${shortSha}` },
      };
      break;
    case "building":
      update = {
        status: "in_progress",
        output: {
          title: "Building agent bundle",
          summary: `Commit ${shortSha}`,
        },
      };
      break;
    case "ready":
      update = {
        status: "completed",
        conclusion: "success",
        ...(build.kind === "preview"
          ? { detailsUrl: previewUrl(env, build.project_id, build.alias) }
          : {}),
        output: {
          title:
            build.kind === "preview"
              ? `Preview ready: ${build.alias}`
              : `Deployment ready: ${build.alias}`,
          summary:
            build.kind === "preview"
              ? previewUrl(env, build.project_id, build.alias)
              : `Commit ${shortSha}`,
        },
      };
      break;
    case "failed":
      update = {
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Build failed",
          summary: (build.error_message ?? "").slice(0, 500),
        },
      };
      break;
    case "superseded":
      update = {
        status: "completed",
        conclusion: "cancelled",
        output: {
          title: "Superseded by a newer commit",
          summary: `Commit ${shortSha}`,
        },
      };
      break;
    case "removed":
      update = {
        status: "completed",
        conclusion: "cancelled",
        output: { title: "Preview removed", summary: `Commit ${shortSha}` },
      };
      break;
    default:
      return false;
  }
  const token = await mintChecksToken(
    env,
    build.account_id,
    build.installation_id,
  );
  if (!token) return false;
  return updateGitHubCheckRun({
    token,
    fullName: build.repository_full_name,
    checkRunId: build.check_run_id,
    ...update,
  })
    .then(() => true)
    .catch(() => false);
}

/** Paths a push event touched across its commits; empty when GitHub did not say. */
export function pushChangedPaths(payload: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  const collect = (commit: unknown): void => {
    if (!isRecord(commit)) return;
    for (const key of ["added", "modified", "removed"] as const) {
      const list = commit[key];
      if (!Array.isArray(list)) continue;
      for (const file of list) {
        if (typeof file === "string") paths.add(file);
      }
    }
  };
  if (Array.isArray(payload.commits)) payload.commits.forEach(collect);
  collect(payload.head_commit);
  return paths;
}

/** A configured directory that none of the push's touched files live under. */
export function sourcePathUntouched(
  source: Pick<SourceRow, "source_path">,
  paths: Set<string>,
): boolean {
  if (!source.source_path || paths.size === 0) return false;
  const prefix = `${source.source_path}/`;
  for (const file of paths) {
    if (file.startsWith(prefix)) return false;
  }
  return true;
}

/** Whether a pull request's changed files reach the configured directory; unreachable GitHub counts as touched so a transient outage cannot skip a deploy. */
async function pullRequestTouchesSource(
  env: GitDeployEnv,
  source: SourceRow,
  pullRequestNumber: number,
): Promise<boolean> {
  if (!source.source_path) return true;
  const minted = await env.ACCOUNTS.getByName(source.account_id)
    .mintGitHubInstallationToken({
      installationId: source.installation_id,
      permissions: { pull_requests: "read" },
    })
    .catch(() => null);
  if (!minted || minted.outcome !== "minted") return true;
  try {
    const files = await listGitHubPullRequestFiles({
      token: minted.token,
      fullName: source.repository_full_name,
      pullRequestNumber,
    });
    return files.some((file) => file.startsWith(`${source.source_path}/`));
  } catch {
    return true;
  }
}

async function startBuild(
  env: GitDeployEnv,
  source: SourceRow,
  input: {
    kind: GitBuildKind;
    alias: string;
    ref: string;
    commitSha: string;
    pullRequest?: { number: number; title: string; url: string };
  },
): Promise<BuildRow> {
  const id = `gitb_${crypto.randomUUID().replaceAll("-", "")}`;
  const timestamp = new Date().toISOString();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `INSERT INTO project_git_builds
     (id, project_id, account_id, kind, alias, ref, commit_sha,
      pull_request_number, pull_request_title, pull_request_url,
      state, installation_id, repository_full_name, source_updated_at,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      source.project_id,
      source.account_id,
      input.kind,
      input.alias,
      input.ref,
      input.commitSha,
      input.pullRequest?.number ?? null,
      input.pullRequest?.title.slice(0, 500) ?? null,
      input.pullRequest?.url ?? null,
      source.installation_id,
      source.repository_full_name,
      source.updated_at,
      timestamp,
      timestamp,
    )
    .run();
  const checkRunId = await createBuildCheck(env, source, input);
  if (checkRunId !== null) {
    await env.SERVERLESS_AGENTS_DB.prepare(
      "UPDATE project_git_builds SET check_run_id = ? WHERE id = ?",
    )
      .bind(checkRunId, id)
      .run();
  }
  // A newer commit for the same alias makes every earlier in-flight build
  // moot; retire them so a slow older build cannot land after this one.
  const retiring = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT id FROM project_git_builds
     WHERE project_id = ? AND alias = ? AND id <> ? AND created_at <= ?
       AND state IN ('queued', 'building')`,
  )
    .bind(source.project_id, input.alias, id, timestamp)
    .all<{ id: string }>();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE project_git_builds
     SET state = 'superseded', error_message = 'Superseded by a newer commit', updated_at = ?
     WHERE project_id = ? AND alias = ? AND id <> ? AND created_at <= ?
       AND state IN ('queued', 'building')`,
  )
    .bind(timestamp, source.project_id, input.alias, id, timestamp)
    .run();
  for (const row of retiring.results) await reflectBuildCheck(env, row.id);
  try {
    const runId = await triggerTask(env, BUILD_TASK_ID, { buildId: id }, id);
    await env.SERVERLESS_AGENTS_DB.prepare(
      "UPDATE project_git_builds SET trigger_run_id = ?, state = 'building', updated_at = ? WHERE id = ?",
    )
      .bind(runId, new Date().toISOString(), id)
      .run();
    await reflectBuildCheck(env, id);
  } catch (error) {
    await env.SERVERLESS_AGENTS_DB.prepare(
      "UPDATE project_git_builds SET state = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        error instanceof Error ? error.message : "Build could not start",
        new Date().toISOString(),
        id,
      )
      .run();
    await reflectBuildCheck(env, id);
  }
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM project_git_builds WHERE id = ?",
  )
    .bind(id)
    .first<BuildRow>();
  if (!row) throw new Error("Build row was not recorded");
  return row;
}

async function deployBranchHead(
  env: GitDeployEnv,
  account: AccountStub,
  source: SourceRow,
): Promise<Response> {
  const minted = await account.mintGitHubInstallationToken({
    installationId: source.installation_id,
    permissions: { metadata: "read" },
  });
  const failure = mintProblem(minted);
  if (failure || minted.outcome !== "minted") return failure!;
  let head: Awaited<ReturnType<typeof getGitHubBranchHead>>;
  try {
    head = await getGitHubBranchHead({
      token: minted.token,
      fullName: source.repository_full_name,
      branch: source.branch,
    });
  } catch (error) {
    if (error instanceof GitHubMintError) {
      return problem(
        error.code === "installation_not_found" ? 404 : 502,
        error.code === "installation_not_found"
          ? "branch_not_found"
          : "github_unavailable",
        error.code === "installation_not_found"
          ? `Branch ${source.branch} was not found in ${source.repository_full_name}`
          : error.message,
      );
    }
    throw error;
  }
  const build = await startBuild(env, source, {
    kind: "branch",
    alias: "development",
    ref: `refs/heads/${source.branch}`,
    commitSha: head.commitSha,
  });
  return json({ build: buildView(env, build) }, 202);
}

async function putSource(
  request: Request,
  env: GitDeployEnv,
  identity: RequestIdentity,
  account: AccountStub,
  project: Project,
): Promise<Response> {
  const body = await readBoundedJson(request, 16 * 1024);
  const connectionId = body?.connectionId;
  const repository = body?.repository;
  const branch = body?.branch;
  if (
    typeof connectionId !== "string" ||
    !connectionId ||
    !isRecord(repository) ||
    typeof repository.id !== "number" ||
    !Number.isInteger(repository.id) ||
    repository.id <= 0 ||
    !validRepositoryFullName(repository.fullName) ||
    !validBranch(branch)
  ) {
    return problem(
      400,
      "invalid_deployment_source",
      "Expected connectionId, repository { id, fullName }, and branch",
    );
  }
  const sourcePath = normalizeSourcePath(body?.path);
  if (sourcePath === undefined) {
    return problem(
      400,
      "invalid_deployment_source",
      "Expected path to be a repo-relative directory without '..'",
    );
  }
  const previewsEnabled =
    body?.previewsEnabled === undefined ? true : body.previewsEnabled === true;
  const installation = await account.getGitHubInstallation(connectionId);
  if (!installation || installation.state !== "active") {
    return problem(
      404,
      "github_connection_not_found",
      "GitHub connection not found",
    );
  }
  const minted = await account.mintGitHubInstallationToken({
    installationId: connectionId,
    permissions: { metadata: "read" },
  });
  const failure = mintProblem(minted);
  if (failure || minted.outcome !== "minted") return failure!;
  try {
    // The webhook is keyed by GitHub's repository id, so the id must be the
    // one GitHub holds for this name as seen by this installation.
    const known = await getGitHubRepository({
      token: minted.token,
      fullName: repository.fullName,
    });
    if (known.id !== repository.id) {
      return problem(
        400,
        "invalid_deployment_source",
        `Repository ${repository.fullName} does not have id ${String(repository.id)}`,
      );
    }
    await getGitHubBranchHead({
      token: minted.token,
      fullName: repository.fullName,
      branch,
    });
  } catch (error) {
    if (error instanceof GitHubMintError) {
      return problem(
        error.code === "installation_not_found" ? 404 : 502,
        error.code === "installation_not_found"
          ? "branch_not_found"
          : "github_unavailable",
        error.code === "installation_not_found"
          ? `Branch ${branch} was not found in ${repository.fullName}, or the installation cannot read it`
          : error.message,
      );
    }
    throw error;
  }
  const timestamp = new Date().toISOString();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `INSERT INTO project_git_sources
     (project_id, account_id, installation_id, github_installation_id,
      repository_id, repository_full_name, branch, source_path, previews_enabled,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       installation_id = excluded.installation_id,
       github_installation_id = excluded.github_installation_id,
       repository_id = excluded.repository_id,
       repository_full_name = excluded.repository_full_name,
       branch = excluded.branch,
       source_path = excluded.source_path,
       previews_enabled = excluded.previews_enabled,
       updated_at = excluded.updated_at`,
  )
    .bind(
      project.id,
      identity.accountId,
      connectionId,
      installation.githubInstallationId,
      repository.id,
      repository.fullName,
      branch,
      sourcePath,
      previewsEnabled ? 1 : 0,
      timestamp,
      timestamp,
    )
    .run();
  const source = await loadSource(env, project.id);
  if (!source) throw new Error("Deployment source was not recorded");
  const deployed = await deployBranchHead(env, account, source);
  if (!deployed.ok) return deployed;
  return json(await statusBody(env, account, project.id));
}

async function listBranches(
  url: URL,
  account: AccountStub,
): Promise<Response> {
  const connectionId = url.searchParams.get("connectionId");
  const repository = url.searchParams.get("repository");
  if (!connectionId || !validRepositoryFullName(repository)) {
    return problem(
      400,
      "invalid_branch_listing",
      "Expected connectionId and repository query parameters",
    );
  }
  const minted = await account.mintGitHubInstallationToken({
    installationId: connectionId,
    permissions: { metadata: "read" },
  });
  const failure = mintProblem(minted);
  if (failure || minted.outcome !== "minted") return failure!;
  try {
    return json({
      branches: await listGitHubRepositoryBranches({
        token: minted.token,
        fullName: repository,
      }),
    });
  } catch (error) {
    if (error instanceof GitHubMintError) {
      return problem(502, "github_unavailable", error.message);
    }
    throw error;
  }
}

export async function cachedRepositoryPage(
  env: Pick<GitDeployEnv, "SERVERLESS_AGENTS_DB">,
  githubInstallationId: number,
  page: number,
): Promise<{ body: GitHubRepositoryPage; fresh: boolean } | null> {
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT body_json, fetched_at FROM project_git_repo_cache
     WHERE github_installation_id = ? AND page = ?`,
  )
    .bind(githubInstallationId, page)
    .first<{ body_json: string; fetched_at: string }>();
  if (!row) return null;
  const body = JSON.parse(row.body_json) as GitHubRepositoryPage;
  return {
    body,
    fresh: Date.now() - Date.parse(row.fetched_at) < REPOSITORY_CACHE_TTL_MS,
  };
}

/** Records a listing page fetched from GitHub. */
export async function rememberRepositoryPage(
  env: Pick<GitDeployEnv, "SERVERLESS_AGENTS_DB">,
  githubInstallationId: number,
  page: number,
  body: GitHubRepositoryPage,
): Promise<void> {
  await env.SERVERLESS_AGENTS_DB.prepare(
    `INSERT INTO project_git_repo_cache
       (github_installation_id, page, body_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(github_installation_id, page) DO UPDATE SET
       body_json = excluded.body_json, fetched_at = excluded.fetched_at`,
  )
    .bind(
      githubInstallationId,
      page,
      JSON.stringify(body),
      new Date().toISOString(),
    )
    .run();
}

/** Drops every cached listing page for an installation. */
export async function purgeGitHubRepositoryCache(
  env: Pick<GitDeployEnv, "SERVERLESS_AGENTS_DB">,
  githubInstallationId: number,
): Promise<void> {
  await env.SERVERLESS_AGENTS_DB.prepare(
    "DELETE FROM project_git_repo_cache WHERE github_installation_id = ?",
  )
    .bind(githubInstallationId)
    .run();
}

async function listRepositories(
  url: URL,
  env: GitDeployEnv,
  account: AccountStub,
): Promise<Response> {
  const connectionId = url.searchParams.get("connectionId");
  const page = parseGitHubRepositoryCursor(url.searchParams.get("cursor"));
  if (!connectionId || page === null) {
    return problem(
      400,
      "invalid_repository_listing",
      "Expected a connectionId query parameter and a cursor issued by this listing",
    );
  }
  const installation = await account.getGitHubInstallation(connectionId);
  if (!installation) {
    return problem(404, "installation_not_found", "GitHub connection not found");
  }
  const cached = await cachedRepositoryPage(
    env,
    installation.githubInstallationId,
    page,
  );
  if (cached?.fresh) return json(cached.body);
  const minted = await account.mintGitHubInstallationToken({
    installationId: connectionId,
    permissions: { metadata: "read" },
  });
  const failure = mintProblem(minted);
  if (failure || minted.outcome !== "minted") {
    return cached ? json(cached.body) : failure!;
  }
  try {
    const body = await listGitHubInstallationRepositories({
      token: minted.token,
      page,
      perPage: 100,
    });
    await rememberRepositoryPage(
      env,
      installation.githubInstallationId,
      page,
      body,
    );
    return json(body);
  } catch (error) {
    if (error instanceof GitHubMintError) {
      return cached
        ? json(cached.body)
        : problem(502, "github_unavailable", error.message);
    }
    throw error;
  }
}

async function removePreview(
  env: GitDeployEnv,
  account: AccountStub,
  projectId: string,
  alias: string,
): Promise<number> {
  await account.removeProjectAlias({ projectId, alias });
  const affected = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT id FROM project_git_builds
     WHERE project_id = ? AND alias = ? AND state <> 'removed'`,
  )
    .bind(projectId, alias)
    .all<{ id: string }>();
  const result = await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE project_git_builds SET state = 'removed', updated_at = ?
     WHERE project_id = ? AND alias = ? AND state <> 'removed'`,
  )
    .bind(new Date().toISOString(), projectId, alias)
    .run();
  for (const row of affected.results) await reflectBuildCheck(env, row.id);
  return result.meta.changes;
}

/** Authenticated project routes under `/v1/projects/:id/deployment-source`. */
export async function routeGitDeployRequest(
  request: Request,
  env: GitDeployEnv,
  identity: RequestIdentity,
  account: AccountStub,
  project: Project,
  suffix: string | undefined,
): Promise<Response> {
  if (!suffix) {
    if (request.method === "GET") {
      return json(await statusBody(env, account, project.id));
    }
    if (identity.projectId) {
      return problem(
        403,
        "forbidden",
        "Project tokens cannot manage deployment sources",
      );
    }
    if (request.method === "PUT") {
      return putSource(request, env, identity, account, project);
    }
    if (request.method === "DELETE") {
      const result = await env.SERVERLESS_AGENTS_DB.prepare(
        "DELETE FROM project_git_sources WHERE project_id = ?",
      )
        .bind(project.id)
        .run();
      return result.meta.changes
        ? new Response(null, { status: 204 })
        : problem(404, "deployment_source_not_found", "No deployment source");
    }
    return problem(405, "method_not_allowed", "Unsupported request");
  }
  if (suffix === "repositories" && request.method === "GET") {
    if (identity.projectId) {
      return problem(403, "forbidden", "Project tokens cannot list repositories");
    }
    return listRepositories(new URL(request.url), env, account);
  }
  if (suffix === "branches" && request.method === "GET") {
    if (identity.projectId) {
      return problem(403, "forbidden", "Project tokens cannot list branches");
    }
    return listBranches(new URL(request.url), account);
  }
  if (suffix === "deploy" && request.method === "POST") {
    if (identity.projectId) {
      return problem(403, "forbidden", "Project tokens cannot start builds");
    }
    const source = await loadSource(env, project.id);
    if (!source) {
      return problem(
        404,
        "deployment_source_not_found",
        "Connect a repository and branch first",
      );
    }
    return deployBranchHead(env, account, source);
  }
  const preview = suffix.match(/^previews\/([^/]+)$/);
  if (preview?.[1] && request.method === "DELETE") {
    if (identity.projectId) {
      return problem(403, "forbidden", "Project tokens cannot remove previews");
    }
    const alias = decodeURIComponent(preview[1]);
    if (!isPreviewAlias(alias)) {
      return problem(400, "invalid_preview", "Expected a pr-<number> alias");
    }
    const removed = await removePreview(env, account, project.id, alias);
    return removed
      ? new Response(null, { status: 204 })
      : problem(404, "preview_not_found", "Preview not found");
  }
  return problem(404, "not_found", "Deployment source route not found");
}

interface WebhookRepository {
  id: number;
  full_name: string;
}

function webhookRepository(value: unknown): WebhookRepository | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.full_name !== "string"
  ) {
    return null;
  }
  return { id: value.id, full_name: value.full_name };
}

async function sourcesForRepository(
  env: GitDeployEnv,
  githubInstallationId: number,
  repositoryId: number,
): Promise<SourceRow[]> {
  const result = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM project_git_sources WHERE github_installation_id = ? AND repository_id = ?",
  )
    .bind(githubInstallationId, repositoryId)
    .all<SourceRow>();
  return result.results;
}

/**
 * GitHub App webhook receiver. `push` to a configured branch deploys it;
 * `pull_request` events against a configured branch open, refresh, or
 * remove a preview. Events for unconfigured repositories are acknowledged
 * and dropped.
 */
export async function receiveGitHubWebhook(
  request: Request,
  env: GitDeployEnv,
): Promise<Response> {
  if (!env.OC_GITHUB_APP_WEBHOOK_SECRET) {
    return problem(
      503,
      "github_webhooks_not_configured",
      "GitHub webhook secret is not configured",
    );
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) {
    return problem(413, "payload_too_large", "Webhook payload too large");
  }
  const raw = await readBounded(request, MAX_WEBHOOK_BYTES);
  if (!raw) {
    return problem(413, "payload_too_large", "Webhook payload too large");
  }
  if (
    !(await verifyGitHubWebhookSignature(
      env.OC_GITHUB_APP_WEBHOOK_SECRET,
      raw,
      request.headers.get("x-hub-signature-256"),
    ))
  ) {
    return problem(401, "invalid_signature", "Webhook signature mismatch");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return problem(400, "invalid_payload", "Webhook payload is not JSON");
  }
  if (!isRecord(payload)) {
    return problem(400, "invalid_payload", "Webhook payload is not an object");
  }
  const event = request.headers.get("x-github-event");
  const installation = isRecord(payload.installation)
    ? payload.installation.id
    : undefined;
  // Membership and repository lifecycle events change what a listing shows;
  // they carry no configured repository, so they are handled here, before the
  // repository lookup below scopes events to configured sources.
  if (
    typeof installation === "number" &&
    (event === "installation_repositories" ||
      event === "installation" ||
      event === "repository")
  ) {
    await purgeGitHubRepositoryCache(env, installation);
    return json({ handled: true });
  }
  const repository = webhookRepository(payload.repository);
  if (typeof installation !== "number" || !repository) {
    return json({ handled: false });
  }
  const sources = await sourcesForRepository(env, installation, repository.id);
  if (sources.length === 0) return json({ handled: false });

  if (event === "push") {
    const ref = payload.ref;
    const after = payload.after;
    if (
      typeof ref !== "string" ||
      typeof after !== "string" ||
      !/^[0-9a-f]{40}$/.test(after) ||
      payload.deleted === true
    ) {
      return json({ handled: false });
    }
    let started = 0;
    const touchedPaths = pushChangedPaths(payload);
    for (const source of sources) {
      if (ref !== `refs/heads/${source.branch}`) continue;
      if (await sourceProjectArchived(env, source)) continue;
      if (!(await stillCurrentHead(env, source, { branch: source.branch }, after)))
        continue;
      if (sourcePathUntouched(source, touchedPaths)) {
        await skippedBuildCheck(
          env,
          source,
          "branch",
          after,
          `No changes under ${source.source_path}`,
        );
        continue;
      }
      await startBuild(env, source, {
        kind: "branch",
        alias: "development",
        ref,
        commitSha: after,
      });
      started++;
    }
    return json({ handled: true, builds: started });
  }

  if (event === "pull_request") {
    const action = payload.action;
    const pullRequest = payload.pull_request;
    if (
      typeof action !== "string" ||
      !isRecord(pullRequest) ||
      typeof pullRequest.number !== "number" ||
      !isRecord(pullRequest.base) ||
      typeof pullRequest.base.ref !== "string" ||
      !isRecord(pullRequest.head) ||
      typeof pullRequest.head.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(pullRequest.head.sha)
    ) {
      return json({ handled: false });
    }
    const number = pullRequest.number;
    const alias = previewAlias(number);
    const baseRef = pullRequest.base.ref;
    // Previews run with the project's development credentials, so only code
    // pushed to the repository itself (by someone with write access) is built;
    // pull requests from forks never get a preview.
    const headRepositoryId = isRecord(pullRequest.head.repo)
      ? pullRequest.head.repo.id
      : undefined;
    const fromFork = headRepositoryId !== repository.id;
    let handled = 0;
    for (const source of sources) {
      if (action === "closed") {
        // Cleanup ignores the current branch/preview settings: the preview may
        // have been created before the source was reconfigured.
        handled += await removePreview(
          env,
          env.ACCOUNTS.getByName(source.account_id),
          source.project_id,
          alias,
        );
        continue;
      }
      if (source.previews_enabled !== 1 || baseRef !== source.branch) continue;
      if (action === "opened" || action === "synchronize" || action === "reopened") {
        if (fromFork || (await sourceProjectArchived(env, source))) continue;
        if (
          !(await stillCurrentHead(
            env,
            source,
            { pullRequestNumber: number },
            pullRequest.head.sha,
          ))
        )
          continue;
        if (!(await pullRequestTouchesSource(env, source, number))) {
          await skippedBuildCheck(
            env,
            source,
            "preview",
            pullRequest.head.sha,
            `No changes under ${source.source_path}`,
          );
          continue;
        }
        await startBuild(env, source, {
          kind: "preview",
          alias,
          ref: `refs/pull/${String(number)}/head`,
          commitSha: pullRequest.head.sha,
          pullRequest: {
            number,
            title:
              typeof pullRequest.title === "string" ? pullRequest.title : "",
            url:
              typeof pullRequest.html_url === "string"
                ? pullRequest.html_url
                : `https://github.com/${repository.full_name}/pull/${String(number)}`,
          },
        });
        handled++;
      }
    }
    return json({ handled: handled > 0 });
  }
  return json({ handled: false });
}

/**
 * Whether `commitSha` is still the tip of the branch or pull request. GitHub
 * may deliver events late or out of order; a stale event must not queue a
 * build (and supersede the build for the real tip) for a commit the ref has
 * already moved past. GitHub being unreachable counts as current so a
 * transient outage cannot drop a legitimate deploy.
 */
async function stillCurrentHead(
  env: GitDeployEnv,
  source: SourceRow,
  target: { branch: string } | { pullRequestNumber: number },
  commitSha: string,
): Promise<boolean> {
  const minted = await env.ACCOUNTS.getByName(
    source.account_id,
  ).mintGitHubInstallationToken({
    installationId: source.installation_id,
    permissions:
      "branch" in target ? { metadata: "read" } : { pull_requests: "read" },
  });
  if (minted.outcome !== "minted") return true;
  try {
    const head =
      "branch" in target
        ? await getGitHubBranchHead({
            token: minted.token,
            fullName: source.repository_full_name,
            branch: target.branch,
          })
        : await getGitHubPullRequestHead({
            token: minted.token,
            fullName: source.repository_full_name,
            pullRequestNumber: target.pullRequestNumber,
          });
    return head.commitSha === commitSha;
  } catch (error) {
    if (error instanceof GitHubMintError) return true;
    throw error;
  }
}

async function sourceProjectArchived(
  env: GitDeployEnv,
  source: SourceRow,
): Promise<boolean> {
  const project = await env.ACCOUNTS.getByName(source.account_id).getProject(
    source.project_id,
  );
  return projectArchived(project);
}

/** Reads at most `limit` bytes of the body; null once the body exceeds it. */
async function readBounded(
  request: Request,
  limit: number,
): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

async function loadBuild(
  env: Pick<GitDeployEnv, "SERVERLESS_AGENTS_DB">,
  id: string,
): Promise<BuildRow | null> {
  return env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM project_git_builds WHERE id = ?",
  )
    .bind(id)
    .first<BuildRow>();
}

/** What the Trigger.dev task needs to check out the commit: a short-lived, read-only clone credential. */
async function buildPlan(env: GitDeployEnv, id: string): Promise<Response> {
  const build = await loadBuild(env, id);
  if (!build) return problem(404, "build_not_found", "Build not found");
  if (build.state !== "queued" && build.state !== "building") {
    return problem(409, "build_not_active", `Build is ${build.state}`);
  }
  const source = await loadSource(env, build.project_id);
  if (!source) {
    await markBuildFailed(env, id, "The deployment source was removed");
    return problem(409, "deployment_source_removed", "The deployment source was removed");
  }
  if (!buildMatchesSource(build, source)) {
    await markBuildFailed(env, id, "The deployment source changed after this build was queued");
    return problem(409, "deployment_source_changed", "The deployment source changed");
  }
  const account = env.ACCOUNTS.getByName(build.account_id);
  if (projectArchived(await account.getProject(build.project_id))) {
    await markBuildFailed(env, id, "Project is archived");
    return problem(409, "project_archived", "Project is archived");
  }
  const minted = await account.mintGitHubInstallationToken({
    installationId: source.installation_id,
    permissions: { contents: "read", metadata: "read" },
  });
  const failure = mintProblem(minted);
  if (failure || minted.outcome !== "minted") return failure!;
  return json({
    repositoryUrl: `https://github.com/${source.repository_full_name}.git`,
    fullName: source.repository_full_name,
    ref: build.ref,
    commitSha: build.commit_sha,
    path: source.source_path,
    token: minted.token,
    tokenExpiresAt: minted.expiresAt,
  });
}

async function markBuildFailed(
  env: GitDeployEnv,
  id: string,
  message: string,
): Promise<void> {
  const updated = await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE project_git_builds SET state = 'failed', error_message = ?, updated_at = ?
     WHERE id = ? AND state IN ('queued', 'building')`,
  )
    .bind(message.slice(0, 4_000), new Date().toISOString(), id)
    .run();
  if (updated.meta.changes) await reflectBuildCheck(env, id);
}

async function announcePreview(
  env: GitDeployEnv,
  account: AccountStub,
  source: SourceRow,
  build: BuildRow,
  forceComment = false,
): Promise<void> {
  if (build.kind !== "preview" || !build.pull_request_number) return;
  // A check run already links the preview URL; only comment when checks are
  // unavailable or the update failed, so the URL still reaches the PR.
  if (!forceComment && build.check_run_id) return;
  const minted = await account.mintGitHubInstallationToken({
    installationId: source.installation_id,
    permissions: { pull_requests: "write" },
  });
  if (minted.outcome !== "minted") return;
  const url = previewUrl(env, build.project_id, build.alias);
  await createGitHubPullRequestComment({
    token: minted.token,
    fullName: source.repository_full_name,
    pullRequestNumber: build.pull_request_number,
    body: [
      `**OpenComputer preview ready** for \`${build.commit_sha.slice(0, 7)}\``,
      "",
      `Preview: ${url}`,
      "",
      `Sessions can target this preview as \`<agent>@${build.alias}\`. The preview is removed when the pull request closes.`,
    ].join("\n"),
  }).catch(() => undefined);
}

async function completeBuild(
  request: Request,
  env: GitDeployEnv,
  id: string,
): Promise<Response> {
  const input = await readBoundedJson(request, 24 * 1024 * 1024);
  if (!isRecord(input) || !validTemplateBundle(input.bundle)) {
    return problem(400, "invalid_template_bundle", "Compiled bundle is invalid");
  }
  const build = await loadBuild(env, id);
  if (!build) return problem(404, "build_not_found", "Build not found");
  if (build.state !== "queued" && build.state !== "building") {
    return json({ id, state: build.state });
  }
  if (!env.BLUE_RUNTIME_IMAGE_ARN || !env.BLUE_RUNTIME_IMAGE_VERSION) {
    await markBuildFailed(env, id, "Managed-agent runtime image is not configured");
    return problem(503, "runtime_not_configured", "Managed-agent runtime image is not configured");
  }
  const source = await loadSource(env, build.project_id);
  if (!source) {
    await markBuildFailed(env, id, "The deployment source was removed");
    return problem(409, "deployment_source_removed", "The deployment source was removed");
  }
  if (!buildMatchesSource(build, source)) {
    await markBuildFailed(env, id, "The deployment source changed after this build was queued");
    return problem(409, "deployment_source_changed", "The deployment source changed");
  }
  const account = env.ACCOUNTS.getByName(build.account_id);
  const project = await account.getProject(build.project_id);
  if (!project) {
    await markBuildFailed(env, id, "Project no longer exists");
    return problem(404, "project_not_found", "Project not found");
  }
  if (project.archivedAt) {
    await markBuildFailed(env, id, "Project is archived");
    return problem(409, "project_archived", "Project is archived");
  }
  if (
    build.kind === "preview" &&
    input.bundle.artifacts.some((artifact) => (artifact.memory?.length ?? 0) > 0)
  ) {
    // Memory declarations activate through a project environment; a preview
    // alias is not one, so the deployment would be refused at registration.
    const message =
      "Previews are not available for projects that declare memory resources";
    await markBuildFailed(env, id, message);
    return problem(409, "preview_unsupported", message);
  }
  // Claim the build so a concurrent close (preview removed) or a newer commit
  // (superseded) is observed before any alias is published.
  const claimed = await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE project_git_builds SET state = 'building', updated_at = ?
     WHERE id = ? AND state IN ('queued', 'building')`,
  )
    .bind(new Date().toISOString(), id)
    .run();
  if (!claimed.meta.changes) {
    const current = await loadBuild(env, id);
    await reflectBuildCheck(env, id);
    return json({ id, state: current?.state ?? "removed" });
  }
  try {
    const storedArtifacts: StoredArtifact[] = [];
    for (const artifact of input.bundle.artifacts) {
      const stored = await uploadArtifact(
        env,
        build.account_id,
        `${id}--${artifact.localAgentId}`,
        artifact,
      );
      const { body: _body, ...metadata } = artifact;
      storedArtifacts.push({ ...metadata, artifact: stored });
    }
    // Last look before publishing: a newer commit queued meanwhile has
    // already retired this build, and a closed preview has removed it.
    const latest = await loadBuild(env, id);
    if (latest?.state !== "building") {
      await reflectBuildCheck(env, id);
      return json({ id, state: latest?.state ?? "removed" });
    }
    const defaultModel = storedArtifacts.some(
      (artifact) => artifact.models !== undefined,
    )
      ? await admitDeploymentModels(
          storedArtifacts.flatMap((artifact) => artifact.models ?? []),
          env,
        )
      : undefined;
    const deployments: RegisterDeploymentInput[] = await templateDeployments({
      installationId: id,
      accountId: build.account_id,
      project,
      artifacts: storedArtifacts,
      resources: input.bundle.resources as ProjectResourceManifest,
      imageArn: env.BLUE_RUNTIME_IMAGE_ARN,
      imageVersion: env.BLUE_RUNTIME_IMAGE_VERSION,
      alias: gitDeploymentAlias(project, build.alias),
      runtimeMode: "workerd-lazy-sandbox",
      ...(defaultModel ? { defaultModel } : {}),
    });
    const environment = environmentOfMode(
      project.environmentMode,
      gitDeploymentAlias(project, build.alias),
    );
    for (const deployment of deployments) {
      // As a direct deploy does (POST /v1/deployments): migrate the project
      // database first, then activate, then put the schedules on the clock.
      const database = deployment.projectDeployment?.resources.database;
      if (database && environment) {
        if (!env.DATABASES) throw new Error("The project database is not configured");
        const scope = {
          accountId: build.account_id,
          projectId: project.id,
          environment,
        } as const;
        await env.DATABASES.getByName(
          databaseObjectName(scope.accountId, scope.projectId, scope.environment),
        ).applyMigrations(scope, database.migrations);
      }
      await account.registerDeployment(deployment);
      if (deployment.projectDeployment && isProjectEnvironmentName(deployment.alias)) {
        await account.reconcileProjectSchedules({
          accountId: build.account_id,
          userId: `deployment-source:${project.id}`,
          projectId: project.id,
          environment: deployment.alias,
          edgeOrigin: new URL(request.url).origin,
          projectDeployment: deployment.projectDeployment,
        });
      }
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Deployment could not be activated";
    await markBuildFailed(env, id, message);
    return problem(500, "activation_failed", message);
  }
  const published = await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE project_git_builds SET state = 'ready', error_message = NULL, updated_at = ?
     WHERE id = ? AND state = 'building'`,
  )
    .bind(new Date().toISOString(), id)
    .run();
  if (!published.meta.changes) {
    // The alias changed hands while we were registering: the preview was
    // closed, or a newer commit superseded this one. Undo what we published.
    const current = await loadBuild(env, id);
    if (current?.state === "removed") {
      await account.removeProjectAlias({ projectId: build.project_id, alias: build.alias });
    }
    await reflectBuildCheck(env, id);
    return json({ id, state: current?.state ?? "removed" });
  }
  const checkApplied = await reflectBuildCheck(env, id);
  await announcePreview(env, account, source, build, !checkApplied);
  return json({ id, state: "ready" });
}

/** Trigger.dev task routes under `/internal/git-builds/:id/...`, authenticated by the template task secret. */
export async function routeGitDeployTaskRequest(
  request: Request,
  env: GitDeployEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/internal\/git-builds\/([^/]+)\/(plan|complete|fail)$/);
  if (!match?.[1]) return null;
  if (!taskAuthorized(request, env)) {
    return problem(401, "unauthorized", "Template task authentication required");
  }
  const id = decodeURIComponent(match[1]);
  if (match[2] === "plan" && request.method === "GET") return buildPlan(env, id);
  if (match[2] === "complete" && request.method === "POST") {
    return completeBuild(request, env, id);
  }
  if (match[2] === "fail" && request.method === "POST") {
    const input = await readBoundedJson(request, 16_384);
    await markBuildFailed(
      env,
      id,
      typeof input?.message === "string" ? input.message : "Build failed",
    );
    return json({ id, state: "failed" });
  }
  return problem(405, "method_not_allowed", "Unsupported build task request");
}
