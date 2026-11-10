import { canonicalEnvironments } from "./project-scope.js";
import type {
  AgentArtifactReference,
  DeploymentUpload,
  GitHubConnectionDefinition,
  HttpConnectionDefinition,
  Project,
  ProjectDeploymentReference,
  DeploymentEgress,
  DeploymentRegion,
  DeploymentRuntimeMode,
  ProjectResourceManifest,
  RegisterDeploymentInput,
} from "../protocol.js";
import type { ResolvedModel } from "../runtime/reactive-agent.js";
import { json, problem, readBoundedJson } from "./http.js";
import type { RequestIdentity } from "./auth.js";
import { parseMemoryDeclarations } from "./memory-activation.js";
import { parseDeploymentRegion } from "../deployment-region.js";
import { parseDeploymentEgress } from "../deployment-egress.js";
import { parseFixedIps } from "./egress-exits.js";
import type { MemoryDeclaration } from "./memory-contract.js";
import {
  admitDeploymentModels,
  parseModelSelections,
  type DeploymentAdmissionEnv,
} from "./deployment-admission.js";
import {
  templateMirrorHeadSha,
  type CodeStorageConfiguration,
} from "../templates/code-storage.js";

/**
 * Compiler/bundle generation. Cached `template_versions` rows are keyed by
 * (repository, commit, generation), so bumping this rebuilds every template
 * on its next inspection without touching the rows older generations wrote.
 * Generation 1: bundles without per-artifact `models`.
 */
export const TEMPLATE_BUILD_GENERATION = 2;

export type TemplateEnv = Omit<Env, "OPENCOMPUTER_APP_URL"> &
  DeploymentAdmissionEnv & {
  DEPLOYMENTS?: Fetcher;
  OPENCOMPUTER_APP_URL?: string;
  BLUE_RUNTIME_IMAGE_ARN?: string;
  BLUE_RUNTIME_IMAGE_VERSION?: string;
  TRIGGER_SECRET_KEY?: string;
  TRIGGER_API_URL?: string;
  OPENCOMPUTER_TEMPLATE_TASK_SECRET?: string;
  CODE_STORAGE_ORG?: string;
  PIERRE_PRIVATE_KEY?: string;
  CODE_STORAGE_API_BASE_URL?: string;
  CODE_STORAGE_STORAGE_BASE_URL?: string;
};

interface VersionRow {
  id: string;
  registration_id: string;
  repository_url: string;
  repository_full_name: string;
  commit_sha: string;
  build_generation: number;
  mirror_repo_id: string;
  template_json: string;
  agents_json: string;
  requirements_json: string;
  artifacts_json: string;
  resources_json: string;
  created_at: string;
}

interface InstallationRow {
  id: string;
  version_id: string;
  account_id: string;
  user_id: string;
  idempotency_key: string;
  project_id: string;
  project_agent_id: string;
  project_repo_id: string | null;
  state: string;
  trigger_run_id: string | null;
  error_stage: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface RegistrationRow {
  id: string;
  state: string;
  error: string | null;
  trigger_run_id: string | null;
  updated_at: string;
}

type InstallationWithBundle = InstallationRow & {
  artifacts_json: string;
  resources_json: string;
};

export interface BuildArtifact {
  localAgentId: string;
  name: string;
  digest: string;
  size: number;
  contentType: string;
  body: string;
  connections: string[];
  httpConnections: HttpConnectionDefinition[];
  githubConnections?: GitHubConnectionDefinition[];
  /** Memory resources the compiled agent declares (work 026, C3); absent from older bundles. */
  memory?: MemoryDeclaration[];
  /** Models the compiled agent declares via `useModel()`; absent from generation-1 bundles. */
  models?: ResolvedModel[];
  /** The agent's `opencomputer.toml` region (work 057); absent means the default. */
  region?: DeploymentRegion;
  /** The agent's `opencomputer.toml` egress allowlist (work 057); absent means open. */
  egress?: DeploymentEgress;
  /** The agent's `[egress] fixed_ips` exit region (work 073). */
  fixedIps?: string;
}

export interface StoredArtifact extends Omit<BuildArtifact, "body"> {
  artifact: AgentArtifactReference;
}

export interface BuildBundle {
  schema: 1;
  template: Record<string, unknown>;
  agents: Array<{ id: string; name: string }>;
  artifacts: BuildArtifact[];
  resources: ProjectResourceManifest;
  requirements: {
    secrets: Array<Record<string, unknown> & { localAgentId?: string }>;
    runtimeVariables: Array<
      Record<string, unknown> & { localAgentId?: string }
    >;
    connections: Array<Record<string, unknown> & { id: string }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedRepository(value: unknown): {
  url: string;
  fullName: string;
} | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0]!) ||
    !/^[A-Za-z0-9._-]+$/.test(parts[1]!) ||
    parts[1]!.endsWith(".git")
  ) {
    return null;
  }
  return {
    url: `https://github.com/${parts[0]}/${parts[1]}`,
    fullName: `${parts[0]}/${parts[1]}`.toLowerCase(),
  };
}

function safeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function cloudAgentId(
  project: Project,
  localId: string,
  firstId: string,
): string {
  return localId === firstId
    ? project.agentId
    : `${project.agentId}--${localId}`;
}

function inspection(version: VersionRow): Record<string, unknown> {
  const template = safeJson<Record<string, unknown>>(version.template_json);
  const agents = safeJson<Array<{ id: string; name: string }>>(
    version.agents_json,
  );
  const requirements = safeJson<BuildBundle["requirements"]>(
    version.requirements_json,
  );
  return {
    id: version.id,
    status: "ready",
    repository: {
      url: version.repository_url,
      fullName: version.repository_full_name,
      defaultBranch: "main",
      commitSha: version.commit_sha,
    },
    template,
    agents,
    requirements: {
      secrets: requirements.secrets.map(
        ({ localAgentId: agentId, ...item }) => ({
          ...item,
          ...(agentId ? { agentId } : {}),
        }),
      ),
      runtimeVariables: requirements.runtimeVariables.map(
        ({ localAgentId: agentId, ...item }) => ({
          ...item,
          ...(agentId ? { agentId } : {}),
        }),
      ),
      connections: requirements.connections.map((item) => ({
        ...item,
        provider: typeof item.provider === "string" ? item.provider : item.id,
        permissions: Array.isArray(item.permissions) ? item.permissions : [],
      })),
    },
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function installation(
  env: TemplateEnv,
  row: InstallationRow,
): Record<string, unknown> {
  return {
    id: row.id,
    inspectionId: row.version_id,
    projectId: row.project_id,
    projectAgentId: row.project_agent_id,
    projectUrl: `${(env.OPENCOMPUTER_APP_URL ?? "https://app.opencomputer.dev").replace(/\/$/, "")}/projects/${encodeURIComponent(row.project_id)}`,
    state: row.state,
    ...(row.error_stage && row.error_message
      ? { error: { stage: row.error_stage, message: row.error_message } }
      : {}),
  };
}

export async function triggerTask(
  env: TemplateEnv,
  taskId: string,
  payload: Record<string, string>,
  idempotencyKey: string,
): Promise<string> {
  if (!env.TRIGGER_SECRET_KEY) throw new Error("Trigger.dev is not configured");
  const response = await fetch(
    `${(env.TRIGGER_API_URL ?? "https://api.trigger.dev").replace(/\/$/, "")}/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TRIGGER_SECRET_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload, options: { idempotencyKey } }),
    },
  );
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || typeof body?.id !== "string") {
    throw new Error("Trigger.dev did not accept the template task");
  }
  return body.id;
}

export function codeStorageConfigurationFromEnv(
  env: Pick<
    TemplateEnv,
    | "CODE_STORAGE_ORG"
    | "PIERRE_PRIVATE_KEY"
    | "CODE_STORAGE_API_BASE_URL"
    | "CODE_STORAGE_STORAGE_BASE_URL"
  >,
): CodeStorageConfiguration | null {
  if (!env.CODE_STORAGE_ORG || !env.PIERRE_PRIVATE_KEY) return null;
  return {
    organization: env.CODE_STORAGE_ORG,
    privateKey: env.PIERRE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ...(env.CODE_STORAGE_API_BASE_URL
      ? { apiBaseUrl: env.CODE_STORAGE_API_BASE_URL }
      : {}),
    ...(env.CODE_STORAGE_STORAGE_BASE_URL
      ? { storageBaseUrl: env.CODE_STORAGE_STORAGE_BASE_URL }
      : {}),
  };
}

/**
 * Best-effort staleness check behind a cached inspection: pull the template's
 * mirror upstream and, when HEAD moved past the served version, put the
 * registration back into `preparing` and fire the sync task so the next
 * inspection rebuilds at the new commit. Runs under `ctx.waitUntil`, so any
 * failure is swallowed — a broken check must never fail the inspection itself.
 */
async function refreshStaleTemplateVersion(
  env: TemplateEnv,
  version: VersionRow,
): Promise<void> {
  try {
    const configuration = codeStorageConfigurationFromEnv(env);
    if (!configuration) return;
    const headSha = await templateMirrorHeadSha(
      version.repository_full_name,
      configuration,
    );
    if (!headSha || headSha === version.commit_sha) return;
    const timestamp = new Date().toISOString();
    const claimed = await env.SERVERLESS_AGENTS_DB.prepare(
      `UPDATE template_registrations
       SET state = 'preparing', error = NULL, updated_at = ?
       WHERE repository_full_name = ? AND state != 'preparing'`,
    )
      .bind(timestamp, version.repository_full_name)
      .run();
    if (claimed.meta.changes !== 1) return;
    const registration = await env.SERVERLESS_AGENTS_DB.prepare(
      "SELECT id FROM template_registrations WHERE repository_full_name = ?",
    )
      .bind(version.repository_full_name)
      .first<{ id: string }>();
    if (!registration) return;
    try {
      const runId = await triggerTask(
        env,
        "sync-serverless-agent-template",
        {
          registrationId: registration.id,
          repositoryUrl: version.repository_url,
        },
        `${registration.id}:${timestamp}`,
      );
      await env.SERVERLESS_AGENTS_DB.prepare(
        "UPDATE template_registrations SET trigger_run_id = ?, updated_at = ? WHERE id = ?",
      )
        .bind(runId, timestamp, registration.id)
        .run();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Template synchronization failed";
      await env.SERVERLESS_AGENTS_DB.prepare(
        "UPDATE template_registrations SET state = 'failed', error = ?, updated_at = ? WHERE id = ?",
      )
        .bind(message, timestamp, registration.id)
        .run();
    }
  } catch {
    // A failed staleness check must never break the inspection response.
  }
}

const TERMINAL_TRIGGER_FAILURES = new Set([
  "CANCELED",
  "INTERRUPTED",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
]);

async function triggerRunFailure(
  env: TemplateEnv,
  runId: string,
): Promise<string | null> {
  if (!env.TRIGGER_SECRET_KEY) return null;
  const response = await fetch(
    `${(env.TRIGGER_API_URL ?? "https://api.trigger.dev").replace(/\/$/, "")}/api/v3/runs/${encodeURIComponent(runId)}`,
    { headers: { authorization: `Bearer ${env.TRIGGER_SECRET_KEY}` } },
  ).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const status = typeof body?.status === "string" ? body.status : null;
  return status && TERMINAL_TRIGGER_FAILURES.has(status)
    ? `Trigger.dev run ended with ${status}`
    : null;
}

export function taskAuthorized(request: Request, env: TemplateEnv): boolean {
  const expected = env.OPENCOMPUTER_TEMPLATE_TASK_SECRET ?? "";
  const actual =
    request.headers.get("x-opencomputer-template-task-secret") ?? "";
  if (!expected || expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

export async function uploadArtifact(
  env: TemplateEnv,
  accountId: string,
  key: string,
  artifact: BuildArtifact,
): Promise<AgentArtifactReference> {
  if (!env.DEPLOYMENTS) throw new Error("Deployment storage is not configured");
  const bytes = new TextEncoder().encode(artifact.body);
  if (
    bytes.byteLength !== artifact.size ||
    !/^[0-9a-f]{64}$/.test(artifact.digest)
  ) {
    throw new Error("Compiled template artifact metadata is invalid");
  }
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== artifact.digest)
    throw new Error("Compiled template artifact digest mismatch");
  const response = await env.DEPLOYMENTS.fetch(
    "https://blue-deployments/v1/deployment-uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        agentId: key,
        digest: artifact.digest,
        size: artifact.size,
        contentType: artifact.contentType,
      }),
    },
  );
  if (!response.ok)
    throw new Error("Could not allocate template artifact storage");
  const upload = (await response.json()) as DeploymentUpload;
  const stored = await fetch(upload.uploadUrl, {
    method: upload.method,
    headers: upload.headers,
    body: bytes,
  });
  if (!stored.ok)
    throw new Error("Could not store the compiled template artifact");
  return upload.artifact;
}

export function validTemplateBundle(value: unknown): value is BuildBundle {
  if (!isRecord(value)) return false;
  return (
    value.schema === 1 &&
    isRecord(value.template) &&
    Array.isArray(value.agents) &&
    value.agents.length > 0 &&
    value.agents.length <= 32 &&
    value.agents.every(
      (agent) =>
        isRecord(agent) &&
        typeof agent.id === "string" &&
        typeof agent.name === "string",
    ) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.length === value.agents.length &&
    value.artifacts.every(
      (artifact) =>
        isRecord(artifact) &&
        typeof artifact.localAgentId === "string" &&
        typeof artifact.name === "string" &&
        typeof artifact.digest === "string" &&
        typeof artifact.size === "number" &&
        typeof artifact.contentType === "string" &&
        typeof artifact.body === "string" &&
        Array.isArray(artifact.connections) &&
        Array.isArray(artifact.httpConnections) &&
        (artifact.githubConnections === undefined ||
          Array.isArray(artifact.githubConnections)) &&
        (artifact.memory === undefined || parseMemoryDeclarations(artifact.memory) !== null) &&
        (artifact.models === undefined || parseModelSelections(artifact.models) !== null) &&
        parseDeploymentRegion(artifact.region) !== null &&
        parseDeploymentEgress(artifact.egress) !== null &&
        parseFixedIps(artifact.fixedIps) !== null,
    ) &&
    isRecord(value.resources) &&
    isRecord(value.requirements) &&
    Array.isArray(value.requirements.secrets) &&
    Array.isArray(value.requirements.runtimeVariables) &&
    Array.isArray(value.requirements.connections)
  );
}

export async function inspectTemplate(
  request: Request,
  env: TemplateEnv,
  context?: ExecutionContext,
): Promise<Response> {
  const input = await readBoundedJson(request, 16_384);
  const repository = normalizedRepository(
    isRecord(input) ? input.repositoryUrl : undefined,
  );
  if (!repository) {
    return problem(
      400,
      "invalid_template_repository",
      "Expected a root public GitHub repository URL",
    );
  }
  // Authors can force a rebuild at the current upstream HEAD with
  // {"refresh": true} in the body (or ?refresh=1); otherwise a cached version
  // is served while a background check re-syncs when upstream moved.
  const refresh =
    (isRecord(input) && input.refresh === true) ||
    new URL(request.url).searchParams.get("refresh") === "1";
  const existing = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT id, state, error, trigger_run_id, updated_at
     FROM template_registrations WHERE repository_full_name = ?`,
  )
    .bind(repository.fullName)
    .first<RegistrationRow>();
  const ready = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT * FROM template_versions
     WHERE repository_full_name = ? AND build_generation = ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(repository.fullName, TEMPLATE_BUILD_GENERATION)
    .first<VersionRow>();
  // The cached version is served only while no (re)build is in flight:
  // a `preparing` registration always means a newer bundle is on the way, so
  // polling callers must keep getting 202 until it lands.
  if (ready && !refresh && existing?.state !== "preparing") {
    context?.waitUntil(refreshStaleTemplateVersion(env, ready));
    return json(inspection(ready));
  }
  const timestamp = new Date().toISOString();
  const registrationId =
    existing?.id ?? `tplreg_${crypto.randomUUID().replaceAll("-", "")}`;
  let restartCrashedRun = false;
  if (
    existing?.state === "preparing" &&
    existing.trigger_run_id &&
    Date.now() - Date.parse(existing.updated_at) >= 10_000
  ) {
    const failure = await triggerRunFailure(env, existing.trigger_run_id);
    if (failure) {
      const claimed = await env.SERVERLESS_AGENTS_DB.prepare(
        `UPDATE template_registrations
         SET error = ?, updated_at = ?
         WHERE id = ? AND state = 'preparing' AND trigger_run_id = ? AND updated_at = ?`,
      )
        .bind(
          failure,
          timestamp,
          existing.id,
          existing.trigger_run_id,
          existing.updated_at,
        )
        .run();
      restartCrashedRun = claimed.meta.changes === 1;
    }
  }
  if (!existing) {
    await env.SERVERLESS_AGENTS_DB.prepare(
      `INSERT INTO template_registrations
       (id, repository_url, repository_full_name, state, created_at, updated_at)
       VALUES (?, ?, ?, 'preparing', ?, ?)`,
    )
      .bind(
        registrationId,
        repository.url,
        repository.fullName,
        timestamp,
        timestamp,
      )
      .run();
  }
  // A `ready` registration whose cached version predates the current build
  // generation is rebuilt in place; the stale rows stay for prior installs.
  const rebuild = existing?.state === "failed" || existing?.state === "ready";
  if (rebuild) {
    await env.SERVERLESS_AGENTS_DB.prepare(
      `UPDATE template_registrations
       SET state = 'preparing', error = NULL, updated_at = ?
       WHERE id = ?`,
    )
      .bind(timestamp, registrationId)
      .run();
  }
  if (!existing || rebuild || restartCrashedRun) {
    try {
      const runId = await triggerTask(
        env,
        "sync-serverless-agent-template",
        { registrationId, repositoryUrl: repository.url },
        rebuild || restartCrashedRun
          ? `${registrationId}:${timestamp}`
          : registrationId,
      );
      await env.SERVERLESS_AGENTS_DB.prepare(
        "UPDATE template_registrations SET trigger_run_id = ?, updated_at = ? WHERE id = ?",
      )
        .bind(runId, timestamp, registrationId)
        .run();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Template synchronization failed";
      await env.SERVERLESS_AGENTS_DB.prepare(
        "UPDATE template_registrations SET state = 'failed', error = ?, updated_at = ? WHERE id = ?",
      )
        .bind(message, timestamp, registrationId)
        .run();
      return problem(503, "template_service_unavailable", message);
    }
  }
  return json(
    {
      id: registrationId,
      status: "preparing",
      repositoryUrl: repository.url,
      retryAfterMs: 1_500,
    },
    { status: 202, headers: { "retry-after": "2" } },
  );
}

async function createInstallation(
  request: Request,
  env: TemplateEnv,
  identity: RequestIdentity,
): Promise<Response> {
  const input = await readBoundedJson(request, 16_384);
  if (
    !isRecord(input) ||
    typeof input.inspectionId !== "string" ||
    typeof input.projectName !== "string" ||
    !input.projectName.trim() ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim()
  ) {
    return problem(
      400,
      "invalid_template_installation",
      "Expected inspectionId, projectName, and idempotencyKey",
    );
  }
  const prior = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM template_installations WHERE account_id = ? AND idempotency_key = ?",
  )
    .bind(identity.accountId, input.idempotencyKey)
    .first<InstallationRow>();
  if (prior) return json(installation(env, prior));
  const version = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM template_versions WHERE id = ?",
  )
    .bind(input.inspectionId)
    .first<VersionRow>();
  if (!version)
    return problem(
      404,
      "template_inspection_not_found",
      "Template inspection not found or not ready",
    );
  const projectName = input.projectName.trim().slice(0, 80);
  const baseSlug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "template";
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const projectId = `prj_${crypto.randomUUID().replaceAll("-", "")}`;
  const project = await env.ACCOUNTS.getByName(
    identity.accountId,
  ).createProject({
    id: projectId,
    name: projectName,
    slug: `${baseSlug}-${suffix}`,
  });
  const timestamp = new Date().toISOString();
  const id = `tplinst_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.SERVERLESS_AGENTS_DB.prepare(
    `INSERT INTO template_installations
     (id, version_id, account_id, user_id, idempotency_key, project_id, project_agent_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_configuration', ?, ?)`,
  )
    .bind(
      id,
      version.id,
      identity.accountId,
      identity.userId,
      input.idempotencyKey,
      project.id,
      project.agentId,
      timestamp,
      timestamp,
    )
    .run();
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM template_installations WHERE id = ?",
  )
    .bind(id)
    .first<InstallationRow>();
  return json(installation(env, row!), 201);
}

async function getInstallation(
  env: TemplateEnv,
  identity: RequestIdentity,
  id: string,
): Promise<Response> {
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT * FROM template_installations WHERE id = ? AND account_id = ?",
  )
    .bind(id, identity.accountId)
    .first<InstallationRow>();
  return row
    ? json(installation(env, row))
    : problem(
        404,
        "template_installation_not_found",
        "Template installation not found",
      );
}

/**
 * The deployment registrations an installed template makes: one per
 * compiled agent, all members of one project deployment, each carrying
 * what its artifact declares, memory resources included, so the promotion
 * applies the memory configuration and sessions can bind it.
 */
export async function templateDeployments(input: {
  installationId: string;
  accountId: string;
  project: Project;
  artifacts: Array<Omit<BuildArtifact, "body"> & { artifact: AgentArtifactReference }>;
  resources: ProjectResourceManifest;
  imageArn: string;
  imageVersion: string;
  runtimeMode: DeploymentRuntimeMode;
  /** Validated platform default; required when any artifact declares `models`. */
  defaultModel?: ResolvedModel;
  /** Deployment alias; defaults to the project's canonical environment. */
  alias?: string;
}): Promise<RegisterDeploymentInput[]> {
  const { project, artifacts } = input;
  if (
    artifacts.some((artifact) => artifact.models !== undefined) &&
    !input.defaultModel
  ) {
    throw new Error("Template models were not admitted before registration");
  }
  const alias =
    input.alias ??
    canonicalEnvironments(project.environmentMode)[0] ??
    "development";
  const firstId = artifacts[0]!.localAgentId;
  const members = artifacts.map((artifact) => ({
    localId: artifact.localAgentId,
    agentId: cloudAgentId(project, artifact.localAgentId, firstId),
    artifactDigest: artifact.digest,
  }));
  const rosterDigest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(members)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const projectDeploymentBase = {
    id: `tpldep_${input.installationId}`,
    digest: rosterDigest,
    agents: members,
    resources: input.resources,
  };
  return artifacts.map((artifact) => {
    const reference: ProjectDeploymentReference = {
      ...projectDeploymentBase,
      localAgentId: artifact.localAgentId,
    };
    return {
      agentId: cloudAgentId(project, artifact.localAgentId, firstId),
      accountId: input.accountId,
      name: artifacts.length === 1 ? project.name : artifact.name,
      alias,
      connections: artifact.connections,
      httpConnections: artifact.httpConnections,
      ...(artifact.githubConnections?.length
        ? { githubConnections: artifact.githubConnections }
        : {}),
      ...(artifact.memory?.length ? { memory: artifact.memory } : {}),
      ...(artifact.models !== undefined && input.defaultModel
        ? { models: artifact.models, defaultModel: input.defaultModel }
        : {}),
      runtimeMode: input.runtimeMode,
      ...(artifact.region ? { region: artifact.region } : {}),
      ...(artifact.egress ? { egress: parseDeploymentEgress(artifact.egress)! } : {}),
      ...(artifact.fixedIps ? { fixedIps: artifact.fixedIps } : {}),
      artifact: artifact.artifact,
      imageArn: input.imageArn,
      imageVersion: input.imageVersion,
      projectDeployment: reference,
    };
  });
}

async function activateInstallation(
  env: TemplateEnv,
  row: InstallationWithBundle,
): Promise<void> {
  if (!env.BLUE_RUNTIME_IMAGE_ARN || !env.BLUE_RUNTIME_IMAGE_VERSION) {
    throw new Error("Managed-agent runtime image is not configured");
  }
  const account = env.ACCOUNTS.getByName(row.account_id);
  const accountRpc: unknown = account;
  const templateAccount = accountRpc as {
    getProject(id: string): Promise<Project | null>;
    registerDeployment(input: RegisterDeploymentInput): Promise<unknown>;
  };
  const project = await templateAccount.getProject(row.project_id);
  if (!project) throw new Error("Template project no longer exists");
  const artifacts = safeJson<StoredArtifact[]>(row.artifacts_json);
  const declaredModels = artifacts.flatMap((artifact) => artifact.models ?? []);
  const defaultModel = artifacts.some((artifact) => artifact.models !== undefined)
    ? await admitDeploymentModels(declaredModels, env)
    : undefined;
  const deployments = await templateDeployments({
    installationId: row.id,
    accountId: row.account_id,
    project,
    artifacts,
    resources: safeJson<ProjectResourceManifest>(row.resources_json),
    imageArn: env.BLUE_RUNTIME_IMAGE_ARN,
    imageVersion: env.BLUE_RUNTIME_IMAGE_VERSION,
    runtimeMode: "workerd-lazy-sandbox",
    ...(defaultModel ? { defaultModel } : {}),
  });
  for (const deployment of deployments) {
    await templateAccount.registerDeployment(deployment);
  }
}

async function finalizeInstallation(
  env: TemplateEnv,
  identity: RequestIdentity,
  id: string,
): Promise<Response> {
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT i.*, v.artifacts_json, v.resources_json
     FROM template_installations i JOIN template_versions v ON v.id = i.version_id
     WHERE i.id = ? AND i.account_id = ?`,
  )
    .bind(id, identity.accountId)
    .first<InstallationWithBundle>();
  if (!row)
    return problem(
      404,
      "template_installation_not_found",
      "Template installation not found",
    );
  if (row.state !== "awaiting_configuration")
    return json(installation(env, row));
  const timestamp = new Date().toISOString();
  await env.SERVERLESS_AGENTS_DB.prepare(
    "UPDATE template_installations SET state = 'creating_project', updated_at = ? WHERE id = ? AND state = 'awaiting_configuration'",
  )
    .bind(timestamp, id)
    .run();
  try {
    await activateInstallation(env, row);
    await env.SERVERLESS_AGENTS_DB.prepare(
      `UPDATE template_installations
       SET state = 'ready', error_stage = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Template deployment could not be activated";
    await env.SERVERLESS_AGENTS_DB.prepare(
      "UPDATE template_installations SET state = 'failed', error_stage = 'activation', error_message = ?, updated_at = ? WHERE id = ?",
    )
      .bind(message, new Date().toISOString(), id)
      .run();
    return getInstallation(env, identity, id);
  }
  try {
    const runId = await triggerTask(
      env,
      "install-serverless-agent-template",
      { installationId: id },
      id,
    );
    await env.SERVERLESS_AGENTS_DB.prepare(
      "UPDATE template_installations SET trigger_run_id = ?, updated_at = ? WHERE id = ?",
    )
      .bind(runId, new Date().toISOString(), id)
      .run();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Project repository creation could not start";
    await env.SERVERLESS_AGENTS_DB.prepare(
      "UPDATE template_installations SET error_stage = 'repository', error_message = ?, updated_at = ? WHERE id = ?",
    )
      .bind(message, new Date().toISOString(), id)
      .run();
  }
  return getInstallation(env, identity, id);
}

async function completeRegistration(
  request: Request,
  env: TemplateEnv,
  registrationId: string,
): Promise<Response> {
  const input = await readBoundedJson(request, 24 * 1024 * 1024);
  if (
    !isRecord(input) ||
    !isRecord(input.repository) ||
    !validTemplateBundle(input.bundle)
  ) {
    return problem(
      400,
      "invalid_template_bundle",
      "Compiled template bundle is invalid",
    );
  }
  const repository = input.repository;
  if (
    typeof repository.url !== "string" ||
    typeof repository.fullName !== "string" ||
    repository.defaultBranch !== "main" ||
    typeof repository.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(repository.commitSha) ||
    typeof repository.mirrorRepoId !== "string"
  ) {
    return problem(
      400,
      "invalid_template_source",
      "Template source identity is invalid",
    );
  }
  const registration = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT repository_full_name FROM template_registrations WHERE id = ?",
  )
    .bind(registrationId)
    .first<{ repository_full_name: string }>();
  if (
    !registration ||
    registration.repository_full_name !== repository.fullName.toLowerCase()
  ) {
    return problem(
      409,
      "template_source_mismatch",
      "Template source does not match its registration",
    );
  }
  const versionId = `tplver_${repository.commitSha}_g${TEMPLATE_BUILD_GENERATION}`;
  const existing = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT id FROM template_versions
     WHERE repository_full_name = ? AND commit_sha = ? AND build_generation = ?`,
  )
    .bind(
      registration.repository_full_name,
      repository.commitSha,
      TEMPLATE_BUILD_GENERATION,
    )
    .first<{ id: string }>();
  if (!existing) {
    const storedArtifacts: StoredArtifact[] = [];
    for (const artifact of input.bundle.artifacts) {
      const stored = await uploadArtifact(
        env,
        "template-cache",
        `${versionId}--${artifact.localAgentId}`,
        artifact,
      );
      const { body: _body, ...metadata } = artifact;
      storedArtifacts.push({ ...metadata, artifact: stored });
    }
    const timestamp = new Date().toISOString();
    await env.SERVERLESS_AGENTS_DB.prepare(
      `INSERT INTO template_versions
       (id, registration_id, repository_url, repository_full_name, commit_sha, build_generation,
        mirror_repo_id, template_json, agents_json, requirements_json, artifacts_json,
        resources_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        versionId,
        registrationId,
        repository.url,
        registration.repository_full_name,
        repository.commitSha,
        TEMPLATE_BUILD_GENERATION,
        repository.mirrorRepoId,
        JSON.stringify(input.bundle.template),
        JSON.stringify(input.bundle.agents),
        JSON.stringify(input.bundle.requirements),
        JSON.stringify(storedArtifacts),
        JSON.stringify(input.bundle.resources),
        timestamp,
      )
      .run();
  }
  await env.SERVERLESS_AGENTS_DB.prepare(
    "UPDATE template_registrations SET state = 'ready', error = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), registrationId)
    .run();
  return json({ id: versionId, state: "ready" });
}

async function failRegistration(
  request: Request,
  env: TemplateEnv,
  registrationId: string,
): Promise<Response> {
  const input = await readBoundedJson(request, 8_192);
  if (
    !isRecord(input) ||
    typeof input.message !== "string" ||
    !input.message.trim()
  ) {
    return problem(400, "invalid_template_failure", "Expected an error message");
  }
  const timestamp = new Date().toISOString();
  await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE template_registrations
     SET state = 'failed', error = ?, updated_at = ?
     WHERE id = ? AND state = 'preparing'`,
  )
    .bind(input.message.trim().slice(0, 4_000), timestamp, registrationId)
    .run();
  const registration = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT state FROM template_registrations WHERE id = ?",
  )
    .bind(registrationId)
    .first<{ state: string }>();
  return registration
    ? json({ id: registrationId, state: registration.state })
    : problem(
        404,
        "template_registration_not_found",
        "Template registration not found",
      );
}

async function installationPlan(
  env: TemplateEnv,
  id: string,
): Promise<Response> {
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT v.mirror_repo_id, v.commit_sha
     FROM template_installations i JOIN template_versions v ON v.id = i.version_id
     WHERE i.id = ?`,
  )
    .bind(id)
    .first<{ mirror_repo_id: string; commit_sha: string }>();
  return row
    ? json({ mirrorRepoId: row.mirror_repo_id, commitSha: row.commit_sha })
    : problem(
        404,
        "template_installation_not_found",
        "Template installation not found",
      );
}

async function completeInstallation(
  request: Request,
  env: TemplateEnv,
  id: string,
): Promise<Response> {
  const input = await readBoundedJson(request, 16_384);
  if (!isRecord(input) || typeof input.projectRepoId !== "string") {
    return problem(400, "invalid_project_repository", "Expected projectRepoId");
  }
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT i.*, v.artifacts_json, v.resources_json
     FROM template_installations i JOIN template_versions v ON v.id = i.version_id
     WHERE i.id = ?`,
  )
    .bind(id)
    .first<
      InstallationRow & { artifacts_json: string; resources_json: string }
    >();
  if (!row)
    return problem(
      404,
      "template_installation_not_found",
      "Template installation not found",
    );
  if (row.state !== "ready") await activateInstallation(env, row);
  await env.SERVERLESS_AGENTS_DB.prepare(
    `UPDATE template_installations
     SET state = 'ready', project_repo_id = ?, error_stage = NULL, error_message = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(input.projectRepoId, new Date().toISOString(), id)
    .run();
  return json({ id, state: "ready" });
}

export async function routeTemplateTaskRequest(
  request: Request,
  env: TemplateEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/template-")) return null;
  if (!taskAuthorized(request, env))
    return problem(
      401,
      "unauthorized",
      "Template task authentication required",
    );
  const registration = url.pathname.match(
    /^\/internal\/template-registrations\/([^/]+)\/complete$/,
  );
  if (registration?.[1] && request.method === "POST") {
    return completeRegistration(
      request,
      env,
      decodeURIComponent(registration[1]),
    );
  }
  const failedRegistration = url.pathname.match(
    /^\/internal\/template-registrations\/([^/]+)\/fail$/,
  );
  if (failedRegistration?.[1] && request.method === "POST") {
    return failRegistration(
      request,
      env,
      decodeURIComponent(failedRegistration[1]),
    );
  }
  const plan = url.pathname.match(
    /^\/internal\/template-installations\/([^/]+)\/plan$/,
  );
  if (plan?.[1] && request.method === "GET") {
    return installationPlan(env, decodeURIComponent(plan[1]));
  }
  const complete = url.pathname.match(
    /^\/internal\/template-installations\/([^/]+)\/complete$/,
  );
  if (complete?.[1] && request.method === "POST") {
    return completeInstallation(request, env, decodeURIComponent(complete[1]));
  }
  return problem(404, "not_found", "Template task route not found");
}

export async function routeTemplateRequest(
  request: Request,
  env: TemplateEnv,
  identity: RequestIdentity,
  context?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname === "/v1/template-inspections" &&
    request.method === "POST"
  ) {
    return inspectTemplate(request, env, context);
  }
  if (
    url.pathname === "/v1/template-installations" &&
    request.method === "POST"
  ) {
    return createInstallation(request, env, identity);
  }
  const match = url.pathname.match(/^\/v1\/template-installations\/([^/]+)$/);
  if (match?.[1] && request.method === "GET") {
    return getInstallation(env, identity, decodeURIComponent(match[1]));
  }
  const finalize = url.pathname.match(
    /^\/v1\/template-installations\/([^/]+)\/finalize$/,
  );
  if (finalize?.[1] && request.method === "POST") {
    return finalizeInstallation(env, identity, decodeURIComponent(finalize[1]));
  }
  return null;
}
