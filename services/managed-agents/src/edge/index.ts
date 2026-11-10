import type {
  ManagedAgentIdentity,
  AgentInputValue,
  AgentSummary,
  AgentDeployment,
  CompleteSlackConnectionInput,
  CompleteConnectionInput,
  Connection,
  ConnectionRequestInput,
  SessionConnectionRequestInput,
  CreateSlackConnectionInput,
  CreateSlackConnectionResult,
  CreateDeploymentUploadInput,
  CreateProjectInput,
  Project,
  ProjectServiceAttachment,
  ProjectEnvironmentName,
  ProjectDeploymentReference,
  InitializeSessionOutcome,
  InitializeSessionResult,
  RegisterDeploymentInput,
  GitHubConnectionDefinition,
  GitHubConnectionStatus,
  HttpConnectionDefinition,
  SessionMemoryBinding,
  SessionSnapshot,
  SessionCreation,
  SessionSummary,
  TurnReceipt,
  MemoryAdmissionState,
  StartConnectionInput,
  SlackConnection,
  SlackSetup,
  SlackSetupResult,
  ModelAccessBinding,
  ModelAccessConnection,
  ModelRoute,
  WorkerdSessionLease,
  OutcomeEventType,
  WorkspaceArtifact,
  WorkspaceExport,
} from "../protocol.js";
import {
  connectionSupportsProtocol,
  resolveModelRoute as resolveConfiguredModelRoute,
  managedResponsesModel,
} from "./model-route.js";
import { OUTCOME_EVENT_TYPES } from "../protocol.js";
import {
  parseDeploymentRegion,
  SUPPORTED_REGIONS,
  regionHeaders,
  regionPlacement,
} from "../deployment-region.js";
import { EGRESS_MAX_ENTRIES, parseDeploymentEgress } from "../deployment-egress.js";
import {
  ModelValidationError,
  deploymentAllowsGatewayModel,
  openRouterModelCatalog,
  parseManagedModel,
  sameModel,
  validateModels,
} from "./model-catalog.js";
import {
  admitDeploymentModels,
  parseModelSelections,
} from "./deployment-admission.js";
import { Cron } from "croner";
import {
  GITHUB_REPOSITORY_PAGE_LIMIT,
  GitHubMintError,
  listGitHubInstallationRepositories,
  parseGitHubPermissions,
  parseGitHubRepositoryCursor,
} from "./github.js";
import {
  assertGoogleScopes,
  exchangeGoogleCode,
  GMAIL_SCOPES,
  googleAuthorizationUrl,
  refreshGoogleCredential,
  requestGoogleApi,
  resolveGoogleIdentity,
  type GoogleOAuthConfig,
  type OAuthCredential,
} from "../connections/google.js";
import {
  codexAccountId,
  codexAuthorizationUrl,
  codexComputeResidency,
  exchangeCodexCode,
  refreshCodexCredential,
  type CodexOAuthConfig,
} from "../connections/codex.js";
import {
  disconnectManagedGithubConnection,
  disconnectManagedGoogleConnection,
  disconnectManagedLinearConnection,
  linkManagedGithubConnection,
  linkManagedGoogleConnection,
  linkManagedLinearConnection,
  managedGithubConnection,
  managedGoogleAccountDisplayName,
  managedGoogleConnection,
  managedLinearConnection,
  proxyManagedGithubAccountRequest,
  proxyManagedGoogleAccountRequest,
  proxyManagedLinearAccountRequest,
  type ComposioConnectionConfiguration,
} from "../connections/composio.js";
import {
  connectionService,
  googleServiceForScopes,
  requestedConnectionLabel,
  selectManagedProviderConnection,
  selectManagedGoogleConnection,
} from "../connections/selection.js";
import { parseSlackEventCallback } from "../channels/slack-events.js";
import {
  createSlackAppFromManifest,
  exchangeSlackOAuthCode,
  resolveSlackInstallation,
  SlackApiError,
  verifySlackInstallation,
} from "../channels/slack-api.js";
import {
  slackAuthorizationUrl,
  slackCreationFailure,
  slackExchangeFailure,
  slackSetupError,
  slackSetupReturnUrl,
  validateSlackOAuthGrant,
} from "../channels/slack-setup.js";
import { channelAdapter } from "../channels/registry.js";
import type {
  InboundChannelMessage,
  InboundDecision,
  InboundQuestionAnswer,
} from "../channels/registry.js";
import { slackTimestampIso } from "../channels/slack-adapter.js";
import {
  configureNumber,
  listNumbers,
  TwilioSetupError,
  verifyCredential,
} from "../channels/twilio-setup.js";
import {
  fetchRecording,
  transcribeRecording,
} from "../channels/twilio-transcribe.js";
import {
  DEFAULT_VOICEMAIL_GREETING,
  parseRecording,
  voicemailPrompt,
} from "../channels/twilio-voice.js";
import {
  hostedSlackManifest,
  normalizeSlackAppName,
} from "../channels/slack-manifest.js";
import { channelPrincipalId } from "../channels/principal.js";
import {
  LINEAR_WEBHOOK_PATTERN,
  receiveLinearWebhook,
} from "./linear-webhook-route.js";
import {
  renderConnectionCallback,
  type ConnectionCallbackOptions,
} from "./connection-callback.js";
import {
  handleLinearConnectionRoute,
  linearAuthorizationCallback,
} from "./linear-connection-routes.js";
import {
  AccountDurableObject,
  SLACK_MANUAL_COMPLETION_BLOCKED,
  type ApprovalRecord,
  type SlackExchangeOutcome,
  type SlackSetupCreationClaim,
  type SlackSetupCreationOutcome,
  type SlackSetupRecord,
} from "./account-do.js";
import {
  json,
  problem,
  readBoundedJson,
  readBoundedText,
  readJson,
} from "./http.js";
import {
  canonicalEnvironments,
  environmentOfMode,
  isProjectEnvironmentMode,
  isProjectEnvironmentName,
  resolveProjectScope,
  type ProjectScopeError,
  type ResolveProjectScopeOptions,
  type ResolvedProjectScope,
} from "./project-scope.js";
import {
  WORKSPACE_EXPORT_ERRORS,
  type WorkspaceExportErrorCode,
  type WorkspaceExportResult,
  exportableWorkspacePath,
  isWorkspaceExportErrorCode,
  workspaceExportExpectation,
  workspaceExportFingerprint,
} from "../platform/workspace-export.js";
import {
  SESSION_RESULT_DATA_LIMIT,
  type JsonValue,
  type ResultCommitInput,
  type RuntimeGeneration,
} from "../protocol.js";
import { isModalSandboxId } from "../platform/modal-sandbox.js";
import {
  deploymentPool,
  sessionRunsOnWorkerd,
} from "./runtime-launch.js";
import {
  configuredManagedRuntimeProfileAssignment,
  managedRuntimeProfile,
  runtimeDeploymentForProfile,
  type ManagedRuntimeProfile,
} from "./runtime-profiles.js";
import {
  WEBHOOK_BODY_LIMIT,
  normalizeWebhookInput,
  parseWebhookIdentitySource,
  webhookDeliveryIdentity,
} from "./webhook-input.js";
import {
  STRUCTURED_INPUT_LIMIT,
  TURN_PAYLOAD_LIMIT,
  payloadLength,
  structuredInputLength,
} from "./structured-input.js";
import {
  authConfiguration,
  authenticateRequest,
  type ManagedAgentAuthEnv,
  type RequestIdentity,
} from "./auth.js";
import {
  IDEMPOTENCY_CONFLICT,
  INVALID_LABELS,
  WORKSPACE_EXPORT_CONFLICT,
  PUBLICATION_UNCONFIRMED,
  SESSION_ENDED,
  SessionDurableObject,
} from "./session-do.js";
import { parseLabelPatch, parseLabelSelector, parseLabels } from "./session-labels.js";
import { startSandboxSessionRuntime } from "./sandbox-runtime-start.js";
import { sweepIdleSandboxes } from "./sandbox-sweep.js";
import { parseTurnAnswers, questionAdmissionProblem } from "./questions.js";
import { parseLinearConnectionPrincipal } from "./linear-contract.js";
import { parseSessionListQuery } from "./session-listing.js";
import {
  codexUsageLimited,
  proxyModelRequest,
  type ModelGatewayProtocol,
} from "./model-gateway.js";
import {
  managedModelBilling,
  type ManagedAgentBillingService,
} from "./billing-admission.js";
import {
  managedFallbackTarget,
  shouldRetryOnFallback,
  type ManagedModelFallbackTarget,
} from "./managed-model-fallback.js";
import {
  DeploymentPoolDurableObject,
  workerdModelConfiguration,
} from "./deployment-pool-do.js";
import { MemoryDurableObject } from "./memory-do.js";
import {
  isDatabaseNotProvisionedError,
  ProjectDatabaseDurableObject,
} from "./database-do.js";
import {
  databaseObjectName,
  validateDatabaseParameters,
  type DatabaseNamespace,
} from "./database-contract.js";
import {
  MEMORY_INVENTORY_PATTERN,
  MEMORY_ROUTE_PATTERN,
  routeProjectMemory,
  routeProjectMemoryInventory,
} from "./memory-routes.js";
import { parseMemoryDeclarations } from "./memory-activation.js";
import { MEMORY_ADMISSION_PENDING, MEMORY_ADMISSION_REJECTED } from "./memory-session.js";
import {
  parseMemoryBindings,
  sameMemoryBindings,
  validateMemoryBindings,
} from "./memory-bindings.js";
import { memoryObjectName, type DocumentMeta, type MemoryBinding, type MemoryEnvironment, type MemoryNamespace, type MemoryProjection } from "./memory-contract.js";
import {
  inspectTemplate,
  routeTemplateRequest,
  routeTemplateTaskRequest,
} from "./template-service.js";
import { automationRepositoryCredential } from "./automation-repository.js";
import { egressIpsResponse, fixedIpsRegions, egressPolicyResponse, parseFixedIps } from "./egress-exits.js";
import {
  receiveGitHubWebhook,
  routeGitDeployRequest,
  routeGitDeployTaskRequest,
} from "./git-deploy-service.js";
import { projectRepositoryArchive } from "../templates/code-storage.js";
import { ComputerDurableObject } from "../computer/durable-object.js";
import {
  COMPUTER_GRANT_HINT,
  computerGrantedConnections,
  computerReachableConnections,
} from "./computer-grants.js";
import { SessionLogDurableObject } from "../computer/session-log.js";
import type { ComputerEdgeEnv } from "../computer/config.js";
import {
  type Latency,
  latencyTelemetry,
  requestRegion,
  upstreamTiming,
} from "./latency.js";
import { computerModelKeyChanged, routeComputerDashboard, routeComputerPublic } from "../computer/routes.js";
import { routeComputerServiceConnections } from "./computer-service-connections.js";
import { COMPUTER_PRINCIPAL, isComputerGrantRoute } from "./computer-principal.js";

export {
  AccountDurableObject,
  ComputerDurableObject,
  DeploymentPoolDurableObject,
  MemoryDurableObject,
  ProjectDatabaseDurableObject,
  SessionDurableObject,
  SessionLogDurableObject,
};

const MICROVM_STATES = new Set([
  "running",
  "suspending",
  "suspended",
  "resuming",
  "terminated",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectOwnsAgent(project: Project, agentId: string): boolean {
  return (
    agentId === project.agentId || agentId.startsWith(`${project.agentId}--`)
  );
}

function initialProjectAgentName(projectName: string): string {
  return projectName.slice(0, 80);
}

async function agentsForProject(
  account: DurableObjectStub<AccountDurableObject>,
  project: Project,
): Promise<AgentSummary[]> {
  // Keep the RPC surface narrow; expanding the complete Account DO stub here
  // exceeds TypeScript's recursive instantiation limit.
  const deploymentResolver = account as unknown as {
    resolveDeployment(agentReference: string): Promise<AgentDeployment | null>;
  };
  const activeDeployments = await Promise.all(
    canonicalEnvironments(project.environmentMode).map((environment) =>
      deploymentResolver.resolveDeployment(`${project.agentId}@${environment}`),
    ),
  );
  const activeRoster = [
    ...new Set(
      activeDeployments.flatMap((deployment) =>
        deployment?.projectDeployment?.agents.map((agent) => agent.agentId) ?? [],
      ),
    ),
  ];
  const visibleAgentIds = new Set(
    activeRoster.length ? activeRoster : [project.agentId],
  );
  const agentsById = new Map(
    (await account.listAgents())
      .filter((agent: AgentSummary) => visibleAgentIds.has(agent.id))
      .map((agent: AgentSummary) => [agent.id, agent]),
  );
  const agents = [...visibleAgentIds]
    .map((agentId) => agentsById.get(agentId))
    .filter((agent): agent is AgentSummary => Boolean(agent))
    .map((agent: AgentSummary) =>
      agent.id === project.agentId &&
      agent.name === `Hello ${project.name}`.slice(0, 80)
        ? { ...agent, name: initialProjectAgentName(project.name) }
        : agent,
    );
  if (!agents.some((agent) => agent.id === project.agentId)) {
    agents.unshift({
      id: project.agentId,
      name: initialProjectAgentName(project.name),
      activeDeploymentId: "",
      activeAlias: canonicalEnvironments(project.environmentMode)[0] ?? null,
      deploymentCount: 0,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  }
  return agents;
}

function scopeProblem(error: ProjectScopeError, projectId?: string): Response {
  return problem(
    error.status,
    error.code,
    error.message,
    projectId ? { projectId } : {},
  );
}

/**
 * Resolves a caller's environment choice for a project route. On failure the
 * typed problem response is ready to return; callers add CORS if the route
 * does.
 */
function projectScope(
  project: Pick<Project, "id" | "environmentMode">,
  requested: unknown,
  options?: ResolveProjectScopeOptions,
): { ok: true; scope: ResolvedProjectScope } | { ok: false; response: Response } {
  const resolution = resolveProjectScope(project, requested, options);
  return resolution.ok
    ? resolution
    : { ok: false, response: scopeProblem(resolution.error, project.id) };
}

/**
 * The same for agent-keyed routes (`agentId` + `environment`). An agent that
 * belongs to no project keeps the legacy Development/Production contract: it
 * predates projects, and no project record exists to say otherwise.
 */
async function agentScope(
  account: DurableObjectStub<AccountDurableObject>,
  agentId: string,
  requested: unknown,
  options?: ResolveProjectScopeOptions,
): Promise<
  | { ok: true; scope: ResolvedProjectScope; project: Project | null }
  | { ok: false; response: Response }
> {
  const project = await account.projectForAgent(agentId);
  const resolved = projectScope(
    project ?? { id: `project:${agentId}`, environmentMode: "legacy" },
    requested,
    options,
  );
  return resolved.ok ? { ...resolved, project } : resolved;
}

async function projectResponse(
  account: DurableObjectStub<AccountDurableObject>,
  project: Project,
  providedAgents?: AgentSummary[],
): Promise<Record<string, unknown>> {
  const agents = providedAgents ?? (await agentsForProject(account, project));
  const environmentNames = canonicalEnvironments(project.environmentMode);
  // Keep the RPC surface narrow; expanding the complete Account DO stub here
  // exceeds TypeScript's recursive instantiation limit.
  const accountRpc: unknown = account;
  const deploymentResolver = accountRpc as {
    resolveDeployment(agentReference: string): Promise<AgentDeployment | null>;
  };
  const activeDeployments = await Promise.all(
    agents.flatMap((agent) =>
      environmentNames.map((environment) =>
        deploymentResolver.resolveDeployment(`${agent.id}@${environment}`),
      ),
    ),
  );
  const environments = agents.flatMap((agent, index) =>
    environmentNames.map((name, environmentIndex) => {
      const active =
        activeDeployments[index * environmentNames.length + environmentIndex];
      return {
        name,
        agentId: agent.id,
        activeDeploymentId: active?.id,
        updatedAt: active?.createdAt ?? project.updatedAt,
      };
    }),
  );
  return {
    ...project,
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
    environments,
  };
}

async function templateSourceForProject(
  env: Env & PlatformEnv,
  accountId: string,
  projectId: string,
): Promise<
  { repositoryUrl: string; commitSha: string; cloneReady: boolean } | undefined
> {
  const source = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT v.repository_url, v.commit_sha, i.project_repo_id
     FROM template_installations i
     JOIN template_versions v ON v.id = i.version_id
     WHERE i.account_id = ? AND i.project_id = ? AND i.state = 'ready'
     ORDER BY i.updated_at DESC
     LIMIT 1`,
  )
    .bind(accountId, projectId)
    .first<{
      repository_url: string;
      commit_sha: string;
      project_repo_id: string | null;
    }>();
  return source
    ? {
        repositoryUrl: source.repository_url,
        commitSha: source.commit_sha,
        cloneReady: Boolean(source.project_repo_id),
      }
    : undefined;
}

interface PlatformEnv extends ManagedAgentAuthEnv {
  DO_FIRST_SESSION_SPIKE?: string;
  WORKERD_PREWARM_TARGET?: string;
  WORKERD_RUNTIME?: Fetcher;
  BLUE_RUNTIME_IMAGE_ARN?: string;
  BLUE_RUNTIME_IMAGE_VERSION?: string;
  MANAGED_RUNTIME_PROFILES?: string;
  MANAGED_RUNTIME_PROFILE_ASSIGNMENTS?: string;
  OPENROUTER_API_KEY?: string;
  MANAGED_FALLBACK_MODEL?: string;
  MANAGED_FALLBACK_OPENROUTER_API_KEY?: string;
  OPENCOMPUTER_BILLING?: ManagedAgentBillingService;
  BLUE_DEFAULT_MODEL?: string;
  DEPLOYMENTS?: Fetcher;
  RUNTIMES?: Fetcher;
  POOLS?: DurableObjectNamespace<DeploymentPoolDurableObject>;
  /** The Memory DO namespace, held as its contract (`MemoryOperations`), never as the class. */
  MEMORY?: MemoryNamespace;
  /** One provisioning/MCP coordinator Durable Object per project environment. */
  DATABASES?: DatabaseNamespace;
  BLUE_CHANNEL_ENCRYPTION_KEY?: string;
  /**
   * The public OAuth callback Slack sends installations back to. Set, it is
   * declared in every generated manifest and enables the automated setup
   * routes; unset, those routes answer 503 and the manual flow is unchanged.
   */
  BLUE_SLACK_OAUTH_REDIRECT_URI?: string;
  BLUE_GOOGLE_CLIENT_ID?: string;
  BLUE_GOOGLE_CLIENT_SECRET?: string;
  COMPOSIO_API_KEY?: string;
  COMPOSIO_APP_NAME?: string;
  COMPOSIO_GOOGLE_CLIENT_ID?: string;
  COMPOSIO_GOOGLE_CLIENT_SECRET?: string;
  COMPOSIO_GOOGLE_OAUTH_REDIRECT_URI?: string;
  COMPOSIO_CONNECTION_CALLBACK_URL?: string;
  COMPOSIO_GMAIL_AUTH_CONFIG_ID?: string;
  COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID?: string;
  COMPOSIO_GOOGLEDRIVE_AUTH_CONFIG_ID?: string;
  COMPOSIO_GOOGLESHEETS_AUTH_CONFIG_ID?: string;
  COMPOSIO_GITHUB_AUTH_CONFIG_ID?: string;
  COMPOSIO_LINEAR_AUTH_CONFIG_ID?: string;
  OPENCOMPUTER_APP_URL?: string;
  CODE_STORAGE_ORG?: string;
  PIERRE_PRIVATE_KEY?: string;
  CODE_STORAGE_API_BASE_URL?: string;
  CODE_STORAGE_STORAGE_BASE_URL?: string;
  OC_MANAGED_CRED_HMAC_SECRET?: string;
  BLUE_SESSION_INDEX_ADMIN_SECRET?: string;
  /** Bearer tokens the fixed egress exits poll their policy with (work 073). */
  EGRESS_FETCH_TOKENS?: string;
  /** The artifact bucket's region, for the exits' platform hosts (work 073). */
  BLUE_AWS_REGION?: string;
  BLUE_CODEX_CLIENT_ID?: string;
  BLUE_CODEX_CLIENT_SECRET?: string;
  BLUE_CODEX_AUTHORIZE_URL?: string;
  BLUE_CODEX_TOKEN_URL?: string;
  BLUE_CODEX_COMPLETIONS_URL?: string;
  BLUE_CODEX_SCOPES?: string;
}

function doFirstSessionSpike(env: Env): boolean {
  return (env as Env & PlatformEnv).DO_FIRST_SESSION_SPIKE === "true";
}

async function accountManagedRuntimeProfile(
  env: Env & PlatformEnv,
  account: DurableObjectStub<AccountDurableObject>,
  accountId: string,
): Promise<ManagedRuntimeProfile | null> {
  const assignment = await account.getManagedRuntimeProfile();
  return managedRuntimeProfile(
    env,
    assignment
      ? assignment.profileId
      : configuredManagedRuntimeProfileAssignment(env, accountId),
  );
}

async function projectSourceArchive(
  env: Env & PlatformEnv,
  accountId: string,
  projectId: string,
): Promise<Response> {
  const source = await env.SERVERLESS_AGENTS_DB.prepare(
    `SELECT project_repo_id
     FROM template_installations
     WHERE account_id = ? AND project_id = ? AND state = 'ready'
       AND project_repo_id IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
  )
    .bind(accountId, projectId)
    .first<{ project_repo_id: string }>();
  if (!source) {
    return problem(
      404,
      "project_source_not_found",
      "This project does not have downloadable source",
    );
  }
  if (!env.CODE_STORAGE_ORG || !env.PIERRE_PRIVATE_KEY) {
    return problem(
      503,
      "project_source_unavailable",
      "Project source is temporarily unavailable",
    );
  }
  const archive = await projectRepositoryArchive({
    projectRepoId: source.project_repo_id,
    configuration: {
      organization: env.CODE_STORAGE_ORG,
      privateKey: env.PIERRE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      ...(env.CODE_STORAGE_API_BASE_URL
        ? { apiBaseUrl: env.CODE_STORAGE_API_BASE_URL }
        : {}),
      ...(env.CODE_STORAGE_STORAGE_BASE_URL
        ? { storageBaseUrl: env.CODE_STORAGE_STORAGE_BASE_URL }
        : {}),
    },
  });
  const headers = new Headers(archive.headers);
  headers.set("cache-control", "private, no-store");
  headers.set(
    "content-disposition",
    `attachment; filename="opencomputer-${projectId}.tar.gz"`,
  );
  return new Response(archive.body, {
    status: archive.status,
    statusText: archive.statusText,
    headers,
  });
}

const MANAGED_MODEL_PROVIDER = "openrouter";
const MANAGED_CREDENTIAL_REPLAY_WINDOW_SEC = 60;
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

async function validateClaudeSetupToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply OK" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function validateOpenAICompatibleApiKey(
  baseUrl: string,
  apiKey: string,
): Promise<"valid" | "rejected" | "unavailable"> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "valid";
    return response.status === 401 || response.status === 403
      ? "rejected"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length || left.length % 2 !== 0) return false;
  const leftBytes = Uint8Array.from(left.match(/.{2}/g) ?? [], (value) =>
    Number.parseInt(value, 16),
  );
  const rightBytes = Uint8Array.from(right.match(/.{2}/g) ?? [], (value) =>
    Number.parseInt(value, 16),
  );
  return (
    leftBytes.length === rightBytes.length &&
    crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The operator credential for the session index and projection routes:
 * the account named in the query, or the response that refuses it.
 */
async function operatorAdminAccount(
  request: Request,
  env: Env & PlatformEnv,
): Promise<{ accountId: string } | Response> {
  if (request.method !== "POST") {
    return problem(405, "method_not_allowed", "Method not allowed");
  }
  const configured = env.BLUE_SESSION_INDEX_ADMIN_SECRET;
  if (!configured) {
    return problem(
      503,
      "not_configured",
      "Operator administration is not configured",
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const [providedHash, configuredHash] = await Promise.all([
    sha256Hex(provided),
    sha256Hex(configured),
  ]);
  if (!provided || !timingSafeEqualHex(providedHash, configuredHash)) {
    return problem(401, "unauthorized", "Invalid operator credential");
  }
  const accountId = new URL(request.url).searchParams.get("account_id");
  if (
    !accountId ||
    accountId.length > 200 ||
    !/^[A-Za-z0-9_-]+$/.test(accountId)
  ) {
    return problem(400, "invalid_account_id", "A valid account_id is required");
  }
  return { accountId };
}

/**
 * An operator reads or wakes an organization's computer (work 092): why it
 * is up or parked, and a wake without the customer messaging it. 404: the
 * organization has no computer; a wake never creates one.
 */
async function operatorComputer(
  request: Request,
  env: Env & PlatformEnv & ComputerEdgeEnv,
  action: "status" | "wake",
): Promise<Response> {
  const admin = await operatorAdminAccount(request, env);
  if (admin instanceof Response) return admin;
  const namespace = env.COMPUTERS as DurableObjectNamespace<ComputerDurableObject> | undefined;
  if (!namespace) return problem(503, "not_configured", "Computers are not configured");
  const computer = namespace.getByName(admin.accountId);
  if (action === "status") {
    const status = await computer.operatorStatus(admin.accountId);
    return status ? json(status) : problem(404, "no_computer", "This organization has no computer");
  }
  const woken = await computer.operatorWake(admin.accountId);
  if (!woken) return problem(404, "no_computer", "This organization has no computer");
  if (woken.reply.status >= 400) {
    return json({ ...woken.status, error: woken.reply.error ?? "wake failed" }, { status: woken.reply.status });
  }
  return json(woken.status, { status: woken.reply.status });
}

async function backfillSessionIndex(
  request: Request,
  env: Env & PlatformEnv,
): Promise<Response> {
  const admin = await operatorAdminAccount(request, env);
  if (admin instanceof Response) return admin;
  const indexed = await env.ACCOUNTS.getByName(
    admin.accountId,
  ).backfillSessionCreations(admin.accountId);
  return json({ account_id: admin.accountId, indexed });
}

/**
 * One reconciliation pass of an account's session projection, on demand.
 * The same pass runs from the Account object's alarm; this route lets an
 * operator run it now and read the counts.
 */
async function reconcileSessionProjection(
  request: Request,
  env: Env & PlatformEnv,
): Promise<Response> {
  const admin = await operatorAdminAccount(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const olderThan = url.searchParams.get("older_than_ms");
  const olderThanMs = olderThan === null ? undefined : Number.parseInt(olderThan, 10);
  if (olderThanMs !== undefined && (!Number.isFinite(olderThanMs) || olderThanMs < 0)) {
    return problem(400, "invalid_threshold", "older_than_ms must be a non-negative integer");
  }
  const outcome = await env.ACCOUNTS.getByName(admin.accountId).reconcileSessionPublications({
    ...(olderThanMs === undefined ? {} : { olderThanMs }),
  });
  return json({ account_id: admin.accountId, ...outcome });
}

async function setAccountManagedRuntimeProfile(
  request: Request,
  env: Env & PlatformEnv,
): Promise<Response> {
  const admin = await operatorAdminAccount(request, env);
  if (admin instanceof Response) return admin;
  const body = await readBoundedJson(request, 4_096);
  const profileId = body?.profileId;
  if (profileId !== null && typeof profileId !== "string") {
    return problem(
      400,
      "invalid_runtime_profile",
      "profileId must be a configured profile name or null",
    );
  }
  let profile: ManagedRuntimeProfile | null;
  try {
    profile = managedRuntimeProfile(env, profileId);
  } catch {
    return problem(
      400,
      "invalid_runtime_profile",
      "The requested managed runtime profile is not configured",
    );
  }
  const assignment = await env.ACCOUNTS.getByName(
    admin.accountId,
  ).setManagedRuntimeProfile(profile?.id ?? null);
  console.log(
    JSON.stringify({
      level: "info",
      event: "account.managed_runtime_profile_changed",
      accountId: admin.accountId,
      profileId: assignment.profileId,
      updatedAt: assignment.updatedAt,
    }),
  );
  return json({
    accountId: admin.accountId,
    profileId: assignment.profileId,
    customized: Boolean(profile),
    displayName: profile?.displayName ?? "OpenComputer default",
    updatedAt: assignment.updatedAt,
  });
}

function accountIdFromManagedOwner(ownerId: string): string | null {
  const match = ownerId.match(/^oc-org:([A-Za-z0-9_-]+)$/);
  return match?.[1] ?? null;
}

async function managedCredentialHandoff(
  request: Request,
  env: Env & PlatformEnv,
): Promise<Response> {
  const secret = env.OC_MANAGED_CRED_HMAC_SECRET;
  if (!secret) {
    return problem(
      503,
      "managed_credential_unavailable",
      "Managed model credential hand-off is not configured",
    );
  }
  const timestamp = request.headers.get("x-oc-managed-ts") ?? "";
  const signature = request.headers.get("x-oc-managed-sig") ?? "";
  const timestampNumber = Number(timestamp);
  if (
    !timestamp ||
    !Number.isFinite(timestampNumber) ||
    Math.abs(Math.floor(Date.now() / 1_000) - timestampNumber) >
      MANAGED_CREDENTIAL_REPLAY_WINDOW_SEC
  ) {
    return problem(401, "unauthorized", "Stale or missing timestamp");
  }

  const url = new URL(request.url);
  const rawBody =
    request.method === "GET" || request.method === "DELETE"
      ? ""
      : await request.text();
  const expected = await hmacSha256Hex(
    secret,
    `${timestamp}.${request.method}.${url.pathname}${url.search}.${rawBody}`,
  );
  if (!signature || !timingSafeEqualHex(expected, signature)) {
    return problem(401, "unauthorized", "Signature mismatch");
  }

  if (request.method === "POST") {
    let body: {
      owner_id?: string;
      provider?: string;
      key?: string;
      or_key_hash?: string;
      operation_id?: string;
    };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return problem(400, "invalid_request", "Invalid JSON body");
    }
    const accountId = body.owner_id
      ? accountIdFromManagedOwner(body.owner_id)
      : null;
    if (
      !accountId ||
      body.provider !== MANAGED_MODEL_PROVIDER ||
      !body.key?.trim() ||
      !body.or_key_hash ||
      !body.operation_id
    ) {
      return problem(
        400,
        "invalid_request",
        "owner_id, openrouter provider, key, or_key_hash, and operation_id are required",
      );
    }
    const managedCredentialId = await env.ACCOUNTS.getByName(
      accountId,
    ).bindManagedModelCredential({
      provider: MANAGED_MODEL_PROVIDER,
      key: body.key,
      orKeyHash: body.or_key_hash,
      operationId: body.operation_id,
    });
    await computerModelKeyChanged(env, accountId);
    return json({ managed_credential_id: managedCredentialId });
  }

  const ownerId = url.searchParams.get("owner_id") ?? "";
  const accountId = accountIdFromManagedOwner(ownerId);
  if (!accountId) {
    return problem(400, "invalid_request", "owner_id is required");
  }
  const account = env.ACCOUNTS.getByName(accountId);
  if (request.method === "GET") {
    const orKeyHash = url.searchParams.get("or_key_hash") ?? "";
    if (!orKeyHash) {
      return problem(400, "invalid_request", "or_key_hash is required");
    }
    const credential = await account.getManagedModelCredentialByHash(
      MANAGED_MODEL_PROVIDER,
      orKeyHash,
    );
    return json({ managed_credential_id: credential?.id ?? null });
  }
  if (request.method === "DELETE") {
    const deleted = await account.deleteManagedModelCredential(
      MANAGED_MODEL_PROVIDER,
    );
    await computerModelKeyChanged(env, accountId);
    return json({ deleted });
  }
  return problem(405, "method_not_allowed", "Method not allowed");
}

interface RawSlackEvent {
  id: string;
  data: Record<string, unknown>;
}

/**
 * The Durable Object that holds a connection's route. Naming it by provider and
 * connection gives each connection its own object, so one account can hold a
 * Slack connection and a Twilio one at the same time. Slack's names are
 * unchanged, so routes written before this keep resolving.
 */
function channelRouteName(provider: string, connectionId: string): string {
  return `${provider}:${connectionId}`;
}

/** A path safe to log: a webhook URL's credential segment is never written. */
function loggablePath(pathname: string): string {
  return pathname.replace(/^(\/v1\/agent-webhooks\/[^/]+)\/.*$/, "$1/redacted");
}

function webhookRouteName(webhookId: string): string {
  return `agent-webhook:${webhookId}`;
}

function randomWebhookToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `ocwh_${encoded}`;
}

function googleConfig(env: Env & PlatformEnv): GoogleOAuthConfig | null {
  return env.BLUE_GOOGLE_CLIENT_ID
    ? {
        clientId: env.BLUE_GOOGLE_CLIENT_ID,
        clientSecret: env.BLUE_GOOGLE_CLIENT_SECRET,
      }
    : null;
}

// Codex (personal subscription) OAuth configuration. The authorized OpenAI
// consumer endpoints are deployment-provided; there is no hard-coded ChatGPT
// authorize/token/completions surface.
function codexConfig(env: Env & PlatformEnv): CodexOAuthConfig | null {
  const clientId = env.BLUE_CODEX_CLIENT_ID;
  const authorizeUrl = env.BLUE_CODEX_AUTHORIZE_URL;
  const tokenUrl = env.BLUE_CODEX_TOKEN_URL;
  const completionsUrl = env.BLUE_CODEX_COMPLETIONS_URL;
  if (!clientId || !authorizeUrl || !tokenUrl || !completionsUrl) return null;
  return {
    clientId,
    clientSecret: env.BLUE_CODEX_CLIENT_SECRET,
    authorizeUrl,
    tokenUrl,
    completionsUrl,
    scopes: env.BLUE_CODEX_SCOPES?.split(/\s+/).filter(Boolean) ?? [],
  };
}

function codexResponsesUrl(config: CodexOAuthConfig): string {
  const url = new URL(config.completionsUrl);
  if (url.pathname.endsWith("/responses")) return url.toString();
  if (!url.pathname.endsWith("/codex")) {
    throw new Error(
      "BLUE_CODEX_COMPLETIONS_URL must target the ChatGPT Codex backend",
    );
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
  return url.toString();
}

// The dashboard/CLI redirect back to OpenComputer after Codex authorization.
function modelAccessRedirectUri(env: Env & PlatformEnv): string | null {
  return env.OPENCOMPUTER_APP_URL
    ? new URL("/model-access/callback", env.OPENCOMPUTER_APP_URL).toString()
    : null;
}

function composioGoogleConfig(
  env: Env & PlatformEnv,
  service: string,
  requestUrl: string,
): ComposioConnectionConfiguration | null {
  if (!env.COMPOSIO_API_KEY) return null;
  const origin = new URL(requestUrl).origin;
  const authConfigIds: Record<string, string | undefined> = {
    gmail: env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
    calendar: env.COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID,
    drive: env.COMPOSIO_GOOGLEDRIVE_AUTH_CONFIG_ID,
    sheets: env.COMPOSIO_GOOGLESHEETS_AUTH_CONFIG_ID,
  };
  const callbackUrl = new URL(
    env.COMPOSIO_CONNECTION_CALLBACK_URL ??
      `${origin}/v1/connections/google/callback`,
  );
  callbackUrl.searchParams.set("service", service);
  return {
    apiKey: env.COMPOSIO_API_KEY,
    authConfigId: authConfigIds[service],
    oauthClientId: env.COMPOSIO_GOOGLE_CLIENT_ID,
    oauthClientSecret: env.COMPOSIO_GOOGLE_CLIENT_SECRET,
    oauthRedirectUri:
      env.COMPOSIO_GOOGLE_OAUTH_REDIRECT_URI ??
      `${origin}/v1/connections/google/oauth/callback`,
    callbackUrl: callbackUrl.toString(),
    appName: env.COMPOSIO_APP_NAME ?? "OpenComputer",
  };
}

function composioGithubConfig(
  env: Env & PlatformEnv,
  requestUrl: string,
): ComposioConnectionConfiguration | null {
  if (!env.COMPOSIO_API_KEY || !env.COMPOSIO_GITHUB_AUTH_CONFIG_ID) return null;
  const origin = new URL(requestUrl).origin;
  const callbackUrl = new URL(
    env.COMPOSIO_CONNECTION_CALLBACK_URL ??
      `${origin}/v1/connections/google/callback`,
  );
  callbackUrl.searchParams.set("service", "github");
  return {
    apiKey: env.COMPOSIO_API_KEY,
    authConfigId: env.COMPOSIO_GITHUB_AUTH_CONFIG_ID,
    callbackUrl: callbackUrl.toString(),
    appName: env.COMPOSIO_APP_NAME ?? "OpenComputer",
    scopes: ["repo"],
  };
}

function composioLinearConfig(
  env: Env & PlatformEnv,
  requestUrl: string,
): ComposioConnectionConfiguration | null {
  if (!env.COMPOSIO_API_KEY || !env.COMPOSIO_LINEAR_AUTH_CONFIG_ID) return null;
  const origin = new URL(requestUrl).origin;
  const callbackUrl = new URL(
    env.COMPOSIO_CONNECTION_CALLBACK_URL ??
      `${origin}/v1/connections/google/callback`,
  );
  callbackUrl.searchParams.set("service", "linear");
  return {
    apiKey: env.COMPOSIO_API_KEY,
    authConfigId: env.COMPOSIO_LINEAR_AUTH_CONFIG_ID,
    callbackUrl: callbackUrl.toString(),
    appName: env.COMPOSIO_APP_NAME ?? "OpenComputer",
    scopes: ["read", "write", "issues:create", "comments:create"],
  };
}

function providerForService(service: string): "google" | "github" | "linear" {
  if (service === "github" || service === "linear") return service;
  return "google";
}

function composioConfigForService(
  env: Env & PlatformEnv,
  service: string,
  requestUrl: string,
): ComposioConnectionConfiguration | null {
  if (service === "github") return composioGithubConfig(env, requestUrl);
  if (service === "linear") return composioLinearConfig(env, requestUrl);
  return composioGoogleConfig(env, service, requestUrl);
}

function composioConnectionUserId(
  identity: RequestIdentity,
  connectionId: string,
): string {
  return `blue:${identity.userId}:connection:${connectionId}`;
}

function connectionLabel(value: unknown): string | null {
  const label =
    typeof value === "string" ? value.trim().toLowerCase() : "default";
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(label) ? label : null;
}

function projectServiceAttachmentResponse(
  attachment: ProjectServiceAttachment,
): Omit<ProjectServiceAttachment, "connection"> & {
  connection: Omit<
    Connection,
    "ownerUserId" | "externalAccountId" | "agentId" | "alias" | "kind"
  >;
} {
  return {
    projectId: attachment.projectId,
    service: attachment.service,
    provider: attachment.provider,
    label: attachment.label,
    connectionId: attachment.connectionId,
    connection: {
      id: attachment.connection.id,
      provider: attachment.connection.provider,
      label: attachment.connection.label,
      displayName: attachment.connection.displayName,
      scopes: attachment.connection.scopes,
      status: attachment.connection.status,
      createdAt: attachment.connection.createdAt,
      updatedAt: attachment.connection.updatedAt,
    },
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

/**
 * Ask the provider whether a connection's consent has completed, and record it.
 *
 * Nothing writes a tool connection's status when someone authorizes it, so a
 * stored `pending` can outlive the consent indefinitely. This is the one place
 * that asks, shared by the listing and the provider's own callback.
 *
 * Returns the connection unchanged on any failure — a provider that is down
 * must never cost a caller their connection list, and must never be mistaken
 * for "this account no longer exists".
 */
/** Adds the connection a Connect Link resolves, for the provider's callback. */
function callbackUrlForConnection(
  callbackUrl: string | undefined,
  accountId: string,
  connectionId: string,
): string | undefined {
  if (!callbackUrl) return callbackUrl;
  try {
    const url = new URL(callbackUrl);
    url.searchParams.set("account", accountId);
    url.searchParams.set("connection", connectionId);
    return url.toString();
  } catch {
    return callbackUrl;
  }
}

async function reconcileToolConnection(
  env: Env,
  accountId: string,
  connection: Connection,
  requestUrl: string,
): Promise<Connection> {
  if (connection.kind !== "tool" || connection.status === "connected") {
    return connection;
  }
  const service =
    connection.provider === "github" || connection.provider === "linear"
      ? connection.provider
      : googleServiceForScopes(connection.scopes);
  if (!service) return connection;
  const configuration = composioConfigForService(
    env as Env & PlatformEnv,
    service,
    requestUrl,
  );
  if (!configuration) return connection;

  const account = env.ACCOUNTS.getByName(accountId);
  const userId = composioConnectionUserId(
    { kind: "user", accountId, userId: connection.ownerUserId },
    connection.id,
  );
  try {
    const managed =
      connection.provider === "github"
        ? await managedGithubConnection(configuration, userId)
        : connection.provider === "linear"
          ? await managedLinearConnection(configuration, userId)
          : await managedGoogleConnection(configuration, userId, service);
    if (managed.status !== "connected" || !managed.connectedAccountId) {
      return connection;
    }
    return await account.upsertManagedToolConnection({
      id: connection.id,
      provider: connection.provider,
      label: connection.label,
      ownerUserId: connection.ownerUserId,
      externalAccountId: managed.connectedAccountId,
      displayName: managed.displayName,
      scopes: managed.scopes,
      status: "connected",
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "managed_connection.reconcile_failed",
        connectionId: connection.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return connection;
  }
}

/** Stop live sessions after archive without making the state transition wait
 * on infrastructure. Configuration and provider grants stay intact so restore
 * is only a state change. A later archive request retries failed cleanup. */
async function stopArchivedProjectSessions(
  env: Env,
  identity: RequestIdentity,
  projectId: string,
): Promise<void> {
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const project = await account.getProject(projectId);
  if (!project?.archivedAt) return;
  let stoppedSessions = 0;
  const failures: string[] = [];

  // Sessions first, and the two runtimes have to be stopped differently.
  for (const sessionId of await account.liveSessionIdsForProject(project.id)) {
    try {
      if (!(await account.getProject(project.id))?.archivedAt) return;
      const session = env.SESSIONS.getByName(sessionId);

      // A MicroVM outlives the record that points at it, so it has to be
      // terminated explicitly. changeRuntimeState reports failure by
      // returning a problem response rather than by throwing, so the status
      // is the only evidence the VM actually went away — treating the call
      // as success would delete the project and leave the VM running, with
      // no owner, no route to it and nothing to show it is still billing.
      // A 409 is runtime_not_bound, meaning no VM was ever bound: that is a
      // session that never booted one, and every workerd session, which
      // binds a runtime but never a microvm_id.
      const terminated = await changeRuntimeState(
        env,
        identity,
        session,
        "terminate",
      );
      if (!terminated.ok && terminated.status !== 409) {
        failures.push(`session ${sessionId}: runtime terminate failed`);
        continue;
      }

      // Then end the record. For a workerd session this is the only thing
      // that stops its runtime — end() records the stop and drives it
      // through to terminate-computer — and for either kind it closes the
      // billing lease, cancels outstanding turns and drops runtime sockets.
      await session.end();
      stoppedSessions += 1;
    } catch (error) {
      failures.push(
        `session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      level: failures.length ? "warn" : "info",
      event: "project.archive_cleanup",
      projectId: project.id,
      slug: project.slug,
      stoppedSessions,
      failures,
    }),
  );
}

function projectArchived(project: Project): Response | null {
  return project.archivedAt
    ? problem(409, "project_archived", "Restore the project before starting new work")
    : null;
}

async function listManagedConnections(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  // A computer key sees only what people granted the computer (work 080),
  // listed as is: reconciling rows is for their owners' own listings.
  if (identity.principal === COMPUTER_PRINCIPAL) {
    return json({ connections: await computerReachableConnections(env, identity) });
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const connections = await account.listConnections(identity.userId);

  // Only rows that are not yet `connected` are re-checked. Detecting a revoked
  // grant would mean an upstream call per connection on a hot path, and worse,
  // a provider outage is indistinguishable from "no such account" — which would
  // mark every connection in every account unusable at once.
  const reconciled = await Promise.all(
    connections.map((connection: Connection) =>
      reconcileToolConnection(env, identity.accountId, connection, request.url),
    ),
  );

  const resolved = await Promise.all(
    reconciled.map(async (connection: Connection) => {
      if (
        connection.kind !== "tool" ||
        connection.provider !== "google" ||
        connection.status !== "connected" ||
        !connection.externalAccountId ||
        connection.displayName
      ) {
        return connection;
      }
      const service = googleServiceForScopes(connection.scopes);
      if (!service) return connection;
      const configuration = composioGoogleConfig(
        env as Env & PlatformEnv,
        service,
        request.url,
      );
      if (!configuration) return connection;
      const displayName = await managedGoogleAccountDisplayName(
        configuration,
        connection.externalAccountId,
        service,
      );
      return displayName
        ? await account.upsertManagedToolConnection({
            id: connection.id,
            provider: connection.provider,
            label: connection.label,
            ownerUserId: connection.ownerUserId,
            externalAccountId: connection.externalAccountId,
            displayName,
            scopes: connection.scopes,
            status: connection.status,
          })
        : connection;
    }),
  );
  return json({ connections: resolved });
}

function managedConnectionExpiry(value: string | undefined): string {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
      return parsed.toISOString();
    }
  }
  return new Date(Date.now() + 15 * 60_000).toISOString();
}

function connectionPageUrl(
  env: Env & PlatformEnv,
  service: string,
  label: string,
): string | null {
  if (!env.OPENCOMPUTER_APP_URL) return null;
  const url = new URL("/managed-agents/connections", env.OPENCOMPUTER_APP_URL);
  url.searchParams.set("service", service);
  url.searchParams.set("alias", label);
  return url.toString();
}

function channelConnectionPageUrl(
  env: Env & PlatformEnv,
  accountId: string,
  token: string,
): string | null {
  if (!env.OPENCOMPUTER_APP_URL) return null;
  return new URL(
    `/api/managed-agents/channel-connections/${encodeURIComponent(accountId)}/${token}`,
    env.OPENCOMPUTER_APP_URL,
  ).toString();
}

async function authenticateSessionRuntime(
  request: Request,
  env: Env,
  sessionId: string,
) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.headers.get("x-api-key");
  const session = env.SESSIONS.getByName(sessionId);
  if (!token || !(await session.authenticateRuntimeToken(token))) return null;
  return { session, snapshot: await session.snapshot() };
}

/**
 * The environment a session's credentials and configuration resolve in:
 * GitHub installation, model-access bindings, runtime variables, connection
 * secrets, and the environment its logs are filed under.
 *
 * It is the environment the session recorded at creation, never the
 * deployment row's alias: one artifact promoted to both environments keeps
 * the alias it was first registered with, so a production session of a
 * promoted artifact would otherwise be handed development credentials. The
 * alias is read only for a session that recorded no environment — created
 * before environments were session identity, or pinned to a deployment
 * promoted to neither or both environments without naming one — where it is
 * the only environment anyone stated.
 */
function sessionEnvironment(
  snapshot: Pick<SessionSnapshot, "environment">,
  deployment: Pick<AgentDeployment, "alias">,
): ProjectEnvironmentName {
  if (isProjectEnvironmentName(snapshot.environment)) {
    return snapshot.environment;
  }
  if (isProjectEnvironmentName(deployment.alias)) return deployment.alias;
  return "development";
}

async function runtimeModelGateway(
  request: Request,
  env: Env & PlatformEnv,
  sessionId: string,
  protocol: ModelGatewayProtocol,
  authenticated?: NonNullable<
    Awaited<ReturnType<typeof authenticateSessionRuntime>>
  >,
  latency: Latency = latencyTelemetry(env, "edge"),
): Promise<Response> {
  const runtime =
    authenticated ??
    (await latency.time(
      "model_gateway.authenticated",
      () => authenticateSessionRuntime(request, env, sessionId),
      () => ({ capability: false }),
    ));
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  if (
    !new Set(["connecting", "idle", "running"]).has(runtime.snapshot.status)
  ) {
    return problem(
      409,
      "session_not_active",
      "The session runtime is not active",
    );
  }
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  // One halt stops everything (work 086): a halted org's
  // in-flight session fails its next model call on every route. Paid orgs
  // halted on the credit rule are not stopped; they move to the fallback below.
  const billing = await latency.time(
    "model_gateway.billing_checked",
    () => managedModelBilling(env, runtime.snapshot.accountId),
    (checked) => ({ fallback: checked.fallback, stopped: checked.stopped }),
  );
  if (billing.stopped) {
    return problem(
      402,
      "insufficient_credits",
      "This organization's plan is out of work minutes or credits",
    );
  }

  // Resolve the effective model route for this dispatch (work 011). Agent code
  // chooses the model; OpenComputer resolves access. A connected, enabled,
  // eligible Codex subscription is preferred; otherwise the same requested
  // model falls back to Managed usage-based inference. Compatibility and
  // eligibility are checked per dispatch, not only at session start.
  const requestedModel = await requestedModelFromRequest(request, protocol);
  const route = await latency.time(
    "model_gateway.route_resolved",
    () => resolveModelAccessRoute(account, runtime, requestedModel, protocol),
    (resolved) => ({
      access: resolved.access.type,
      source: String(resolved.source),
    }),
  );
  if (route.incompatible) {
    return problem(
      409,
      "model_route_incompatible",
      "The configured connection does not support this OpenCode wire protocol",
    );
  }
  if (
    route.routeId &&
    route.access.type === "managed" &&
    route.fallback === "fail"
  ) {
    return problem(
      503,
      "model_access_unavailable",
      "The configured model connection is unavailable and the route is fail-closed",
    );
  }
  const deployment = await latency.time(
    "model_gateway.deployment_loaded",
    async () => await account.getDeployment(runtime.snapshot.deploymentId),
  );
  if (deployment?.models && !route.routeId) {
    if (!requestedModel) {
      return problem(400, "model_required", "The model request must include an exact model id");
    }
    const allowed = [
      ...deployment.models,
      ...(deployment.defaultModel ? [deployment.defaultModel] : []),
    ];
    if (!deploymentAllowsGatewayModel(allowed, requestedModel)) {
      return problem(
        409,
        "model_not_declared",
        `Model ${requestedModel.provider}/${requestedModel.model} is not declared by this deployment`,
      );
    }
    try {
      validateModels(
        [requestedModel],
        await latency.time("model_gateway.catalog_checked", () =>
          openRouterModelCatalog({
            cache: typeof caches === "undefined" ? undefined : caches.default,
          }),
        ),
      );
    } catch (error) {
      return problem(
        error instanceof ModelValidationError ? 409 : 503,
        error instanceof ModelValidationError
          ? "model_unavailable"
          : "model_catalog_unavailable",
        error instanceof Error ? error.message : "Model validation failed",
      );
    }
  }
  const providerCallId = crypto.randomUUID();
  // Set when a Codex seat at its usage limit falls back to Managed below.
  let pinnedManagedModel: { provider: string; model: string } | undefined;

  if (
    (route.access.type === "external_subscription" ||
      route.access.type === "external_api_key") &&
    route.connectionId &&
    route.provider
  ) {
    const connectionId = route.connectionId;
    const credential = await latency.time(
      "model_gateway.credential_resolved",
      () =>
        route.provider === "openai"
          ? usableCodexCredential(env as Env & PlatformEnv, account, connectionId)
          : account.modelAccessCredential(connectionId),
      () => ({ access: route.access.type }),
    );
    if (credential) {
      const routeEvent = {
        providerCallId,
        requested: requestedModel ?? null,
        effective: route.effective ?? requestedModel ?? null,
        runtime:
          route.provider === "openai"
            ? "codex"
            : route.provider === "anthropic"
              ? "claude"
              : "opencode",
        access: {
          type: route.access.type,
          connectionId: route.connectionId,
          connectionKind: route.connection?.kind,
        },
        source: route.source,
        routeId: route.routeId,
        routeRevision: route.routeRevision,
        fallback: route.fallback,
        openComputerModelChargeUsd: 0,
      };
      if (route.provider === "openrouter") {
        const baseUrl = route.connection?.baseUrl;
        if (!baseUrl) {
          return problem(409, "model_route_invalid", "The connection has no base URL");
        }
        const suffix =
          protocol === "responses"
            ? "/responses"
            : protocol === "anthropic_messages"
              ? "/messages"
              : "/chat/completions";
        let servedModel: string | undefined;
        const response = await proxyModelRequest(request, {
          apiKey: credential as string,
          customerId: runtime.snapshot.accountId,
          protocol,
          upstream: "openrouter",
          upstreamUrl: `${baseUrl.replace(/\/$/, "")}${suffix}`,
          upstreamModel: route.effective?.model,
          observeResponseModel(model) {
            servedModel = model;
          },
          timing: upstreamTiming(latency, "openrouter_connection", protocol),
        });
        await latency.time("model_gateway.route_recorded", () =>
          runtime.session.recordModelRouteResolved({
            ...routeEvent,
            effective: servedModel
              ? { provider: "openrouter", model: servedModel }
              : routeEvent.effective,
          }),
        );
        return response;
      }
      // Persist the effective route before dispatch (work 011). Zero
      // OpenComputer model charge on the subscription route; runtime compute
      // continues to bill normally. OpenRouter is recorded above after its
      // response metadata can identify a router's downstream model.
      await latency.time("model_gateway.route_recorded", () =>
        runtime.session.recordModelRouteResolved(routeEvent),
      );
      if (route.provider === "anthropic") {
        return proxyModelRequest(request, {
          apiKey: credential as string,
          customerId: runtime.snapshot.accountId,
          protocol,
          upstream: "anthropic",
          timing: upstreamTiming(latency, "anthropic", protocol),
          ...(route.effective ? { upstreamModel: route.effective.model } : {}),
        });
      }
      if (route.provider === "openai_compatible") {
        const baseUrl = route.connection?.baseUrl;
        if (!baseUrl) {
          return problem(409, "model_route_invalid", "The connection has no base URL");
        }
        const suffix =
          protocol === "responses"
            ? "/responses"
            : protocol === "anthropic_messages"
              ? "/messages"
              : "/chat/completions";
        return proxyModelRequest(request, {
          apiKey: credential as string,
          customerId: runtime.snapshot.accountId,
          protocol,
          upstream: "openai_compatible",
          upstreamUrl: `${baseUrl.replace(/\/$/, "")}${suffix}`,
          upstreamModel: route.effective?.model,
          timing: upstreamTiming(latency, "openai_compatible", protocol),
        });
      }
      const config = codexConfig(env as Env & PlatformEnv);
      if (!config) {
        return problem(
          503,
          "provider_unavailable",
          "Codex subscription dispatch is not configured",
        );
      }
      const codexCredential = credential as {
        accessToken: string;
        accountId: string;
      };
      // A plan at its usage limit falls back to Managed below (086), unless
      // the route is fail-closed; the body is kept for that second dispatch.
      const limitRetry = route.fallback === "fail" ? undefined : request.clone();
      const codexResponse = await proxyModelRequest(request, {
        apiKey: codexCredential.accessToken,
        customerId: runtime.snapshot.accountId,
        protocol,
        upstream: "codex",
        upstreamUrl: codexResponsesUrl(config),
        timing: upstreamTiming(latency, "codex", protocol),
        chatGptAccountId: codexCredential.accountId,
        codexComputeResidency:
          codexComputeResidency(codexCredential.accessToken) ?? undefined,
        sessionId: runtime.snapshot.id,
        ...(env.RUNTIMES && runtime.snapshot.microvmId
          ? {
              fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
                env.RUNTIMES!.fetch("https://blue-runtime/v1/codex-relay", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    accountId: runtime.snapshot.accountId,
                    microvmId: runtime.snapshot.microvmId,
                    sessionId: runtime.snapshot.id,
                    upstreamUrl: String(input),
                    headers: Object.fromEntries(new Headers(init?.headers)),
                    body: typeof init?.body === "string" ? init.body : "",
                  }),
                }),
            }
          : {}),
        ...(route.effective ? { upstreamModel: route.effective.model } : {}),
      });
      if (!limitRetry || !(await codexUsageLimited(codexResponse))) {
        return codexResponse;
      }
      await codexResponse.body?.cancel();
      await runtime.session.recordModelAccessFallback({
        providerCallId,
        requested: requestedModel ?? null,
        from: route.access.type,
        reason: "subscription_limit",
      });
      request = limitRetry;
      // Managed serves the route's pinned model, not the one the agent named.
      pinnedManagedModel = route.effective;
    } else {
      // The credential vanished between resolution and dispatch (e.g.
      // concurrent disconnect). Record the fallback and continue on Managed.
      if (route.fallback === "fail") {
        return problem(
          503,
          "model_access_unavailable",
          "The configured model connection is unavailable and the route is fail-closed",
        );
      }
      await runtime.session.recordModelAccessFallback({
        providerCallId,
        requested: requestedModel ?? null,
        from: route.access.type,
        reason: "subscription_unavailable",
      });
    }
  }

  const managedCredential = await latency.time(
    "model_gateway.credential_resolved",
    async () =>
      await account.resolveManagedModelCredential(MANAGED_MODEL_PROVIDER),
    () => ({ access: "managed" }),
  );
  const apiKey = managedCredential?.key ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return problem(
      503,
      "model_gateway_not_configured",
      "The model gateway is not configured",
    );
  }
  // Managed OpenRouter routes are recorded after initial response metadata is
  // available so router aliases can name the downstream model that served the
  // call. Failed or metadata-free responses retain the dispatched route.
  const routeEvent = {
    providerCallId,
    requested: requestedModel ?? null,
    effective: route.effective ?? requestedModel ?? null,
    runtime: requestedModel?.provider === "anthropic" ? "claude" : "codex",
    access: { type: "managed" },
    source: route.source,
    fallback: route.fallback,
    openComputerModelChargeUsd: null,
  };
  // Paid orgs whose credits are exhausted keep working on the open-weight
  // fallback model (`billing`, checked above).
  const fallbackTarget = managedFallbackTarget(env, billing);
  const dispatchFallback = async (
    fallbackRequest: Request,
    target: ManagedModelFallbackTarget,
  ): Promise<Response> => {
    await runtime.session.recordModelAccessFallback({
      providerCallId,
      requested: requestedModel ?? null,
      from: "managed",
      to: { provider: "openrouter", model: target.model },
      reason: "credits_exhausted",
    });
    let fallbackServedModel: string | undefined;
    const fallbackResponse = await proxyModelRequest(fallbackRequest, {
      apiKey: target.apiKey,
      customerId: runtime.snapshot.accountId,
      protocol,
      upstream: "openrouter",
      upstreamModel: target.model,
      observeResponseModel(model) {
        fallbackServedModel = model;
      },
      timing: upstreamTiming(latency, "openrouter_fallback", protocol),
    });
    await runtime.session.recordModelRouteResolved({
      ...routeEvent,
      effective: {
        provider: "openrouter",
        model: fallbackServedModel ?? target.model,
      },
      openComputerModelChargeUsd: 0,
    });
    return fallbackResponse;
  };
  if (billing.fallback && fallbackTarget) {
    return dispatchFallback(request, fallbackTarget);
  }
  const retryRequest = fallbackTarget ? request.clone() : undefined;
  const responsesModel = managedResponsesModel(requestedModel, pinnedManagedModel);
  let servedModel: string | undefined;
  const response = await proxyModelRequest(request, {
    apiKey,
    customerId: runtime.snapshot.accountId,
    protocol,
    upstream: "openrouter",
    ...(protocol === "chat_completions" && route.routeId && route.effective
      ? { upstreamModel: route.effective.model }
      : {}),
    ...(protocol === "anthropic_messages" && requestedModel
      ? { upstreamModel: `anthropic/${requestedModel.model}` }
      : {}),
    ...(protocol === "responses" && responsesModel
      ? { upstreamModel: responsesModel }
      : {}),
    observeResponseModel(model) {
      servedModel = model;
    },
    timing: upstreamTiming(latency, "openrouter", protocol),
  });
  if (
    retryRequest &&
    fallbackTarget &&
    shouldRetryOnFallback(response.status, billing)
  ) {
    await response.body?.cancel();
    return dispatchFallback(retryRequest, fallbackTarget);
  }
  await latency.time("model_gateway.route_recorded", () =>
    runtime.session.recordModelRouteResolved({
      ...routeEvent,
      effective: servedModel
        ? { provider: "openrouter", model: servedModel }
        : routeEvent.effective,
    }),
  );
  return response;
}

async function workerdCapabilityModelGateway(
  request: Request,
  env: Env & PlatformEnv,
  accountId: string,
  deploymentId: string,
  imageVersion: string,
  capabilityId: string,
  protocol: ModelGatewayProtocol,
  latency: Latency = latencyTelemetry(env, "edge"),
): Promise<Response> {
  const authenticated = await latency.time(
    "model_gateway.authenticated",
    () =>
      authenticateWorkerdModelGateway(
        request,
        env,
        accountId,
        deploymentId,
        imageVersion,
        capabilityId,
      ),
    () => ({ capability: true }),
  );
  if (authenticated instanceof Response) return authenticated;
  latency.base.session_key = authenticated.sessionId;
  return runtimeModelGateway(
    request,
    env,
    authenticated.sessionId,
    protocol,
    authenticated.runtime,
    latency,
  );
}

async function authenticateWorkerdModelGateway(
  request: Request,
  env: Env & PlatformEnv,
  accountId: string,
  deploymentId: string,
  imageVersion: string,
  capabilityId: string,
): Promise<
  | Response
  | {
      sessionId: string;
      runtime: NonNullable<
        Awaited<ReturnType<typeof authenticateSessionRuntime>>
      >;
    }
> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.headers.get("x-api-key");
  if (!token) {
    return problem(401, "invalid_model_gateway_capability", "Model gateway capability is invalid");
  }
  const account = env.ACCOUNTS.getByName(accountId);
  const deployment = await account.getDeployment(deploymentId);
  if (!deployment || deployment.imageVersion !== imageVersion || !env.POOLS) {
    return problem(401, "invalid_model_gateway_capability", "Model gateway capability is invalid");
  }
  const binding = await deploymentPool(
    env,
    accountId,
    deployment,
  ).authenticateWorkerdModelGateway(capabilityId, token);
  if (!binding) {
    return problem(401, "invalid_model_gateway_capability", "Model gateway capability is invalid");
  }
  const session = env.SESSIONS.getByName(binding.sessionId);
  const snapshot = await session.snapshot();
  if (
    snapshot.accountId !== accountId ||
    snapshot.deploymentId !== deploymentId
  ) {
    return problem(401, "invalid_model_gateway_capability", "Model gateway capability is invalid");
  }
  return { sessionId: binding.sessionId, runtime: { session, snapshot } };
}

async function resolveRuntimeModel(
  request: Request,
  env: Env & PlatformEnv,
  sessionId: string,
): Promise<Response> {
  // Phase timings: the runtime's "context" hook waits on this response and
  // OpenCode fails the turn when it takes five minutes (work 078 saw four).
  const startedAt = Date.now();
  const phases: Record<string, number> = {};
  const phase = (name: string): void => {
    phases[name] = Date.now() - startedAt;
  };
  const timed = (response: Response): Response => {
    if (Date.now() - startedAt > 2_000) {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "runtime.model_resolve_slow",
          sessionId,
          status: response.status,
          totalMs: Date.now() - startedAt,
          phases,
        }),
      );
    }
    return response;
  };
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  phase("authenticated");
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const body = await readJson(request);
  const requested = body?.model === undefined
    ? undefined
    : parseModelSelections([body.model]);
  if (requested === null) {
    return problem(400, "invalid_model_selection", "Expected an exact provider and model");
  }
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  phase("deployment");
  if (!deployment) {
    return timed(problem(409, "deployment_unavailable", "Pinned deployment is unavailable"));
  }
  const pinnedRoute = await runtime.session.pinModelRoute(null);
  phase("pinned_route");
  if (pinnedRoute) {
    return timed(
      json({
        model: { provider: "connection", model: pinnedRoute.model },
        source: pinnedRoute.agentId ? "agent_route" : "project_route",
        routeId: pinnedRoute.id,
        routeRevision: pinnedRoute.revision,
      }),
    );
  }
  const legacyDeployment =
    deployment.models === undefined && deployment.defaultModel === undefined;
  const selected =
    requested?.[0] ??
    deployment.defaultModel ??
    (legacyDeployment ? parseManagedModel(env.BLUE_DEFAULT_MODEL) : undefined);
  if (!selected) {
    return problem(409, "default_model_unavailable", "Deployment has no validated default model");
  }
  if (!legacyDeployment) {
    const allowed = requested
      ? deployment.models ?? []
      : deployment.defaultModel
        ? [deployment.defaultModel]
        : [];
    if (
      !allowed.some(
        (candidate: { provider: string; model: string }) =>
          sameModel(candidate, selected),
      )
    ) {
      return problem(
        409,
        "model_not_declared",
        `Model ${selected.provider}/${selected.model} is not declared by this deployment`,
      );
    }
  }
  try {
    const catalog = await openRouterModelCatalog({
      cache: typeof caches === "undefined" ? undefined : caches.default,
    });
    phase("catalog");
    validateModels([selected], catalog);
  } catch (error) {
    phase("catalog_failed");
    return timed(
      problem(
        error instanceof ModelValidationError ? 409 : 503,
        error instanceof ModelValidationError
          ? "model_unavailable"
          : "model_catalog_unavailable",
        error instanceof Error ? error.message : "Model validation failed",
      ),
    );
  }
  return timed(json({ model: selected }));
}

// Reads the requested model from the already-buffered chat-completion body
// without consuming the stream the gateway proxies. Returns undefined when the
// body is absent or not an object with a string `model`.
async function requestedModelFromRequest(
  request: Request,
  protocol: ModelGatewayProtocol,
): Promise<{ provider: string; model: string } | undefined> {
  try {
    const clone = request.clone();
    const body: unknown = await clone.json();
    if (!isRecord(body) || typeof body.model !== "string") return undefined;
    const raw = body.model;
    return protocol === "responses"
      ? { provider: "openai", model: raw }
      : protocol === "anthropic_messages"
        ? { provider: "anthropic", model: raw }
        : { provider: "openrouter", model: raw };
  } catch {
    return undefined;
  }
}

// Resolves the effective route for one model dispatch. Returns a Managed route
// unless an enabled, connected Codex subscription is bound for this project's
// environment and the requested model is an OpenAI model served by the Codex
// runtime. Never throws: any resolution problem resolves to Managed.
async function resolveModelAccessRoute(
  account: ReturnType<Env["ACCOUNTS"]["getByName"]>,
  runtime: {
    snapshot: Pick<SessionSnapshot, "accountId" | "agentId" | "deploymentId" | "environment">;
    session: { pinModelRoute(route: ModelRoute | null): Promise<ModelRoute | null> };
  },
  requested: { provider: string; model: string } | undefined,
  protocol: ModelGatewayProtocol,
): Promise<{
  access: { type: "managed" | "external_subscription" | "external_api_key" };
  connectionId?: string;
  provider?: ModelAccessConnection["provider"];
  connection?: ModelAccessConnection;
  effective?: { provider: string; model: string };
  routeId?: string;
  routeRevision?: number;
  fallback?: "fail" | "managed";
  source?: "agent_route" | "project_route" | "use_model" | "platform_default";
  incompatible?: boolean;
}> {
  try {
    const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
    const project = await account.projectForAgent(runtime.snapshot.agentId);
    if (!deployment || !project) return { access: { type: "managed" } };
    const environment = sessionEnvironment(runtime.snapshot, deployment);
    let configured = resolveConfiguredModelRoute({
      routes: await account.listModelRoutes(project.id, environment),
      agentId: runtime.snapshot.agentId,
      ...(requested ? { requested } : {}),
      ...(deployment.defaultModel ? { platformDefault: deployment.defaultModel } : {}),
    });
    const pinnedRoute = await runtime.session.pinModelRoute(
      configured?.route ?? null,
    );
    if (pinnedRoute) {
      configured = {
        source: pinnedRoute.agentId ? "agent_route" : "project_route",
        ...(requested ? { requested } : {}),
        effective: { provider: "connection", model: pinnedRoute.model },
        route: pinnedRoute,
      };
    } else if (configured?.route) {
      configured = requested
        ? { source: "use_model", requested, effective: requested }
        : deployment.defaultModel
          ? { source: "platform_default", effective: deployment.defaultModel }
          : null;
    }
    if (configured?.route) {
      const connection = await account.getModelAccessConnection(
        configured.route.connectionId,
      );
      if (!connection || connection.status !== "connected") {
        return {
          access: { type: "managed" },
          effective: configured.effective,
          routeId: configured.route.id,
        routeRevision: configured.route.revision,
        fallback: configured.route.fallback,
        source: configured.source,
      };
      }
      return {
        access: {
          type: connection.kind.endsWith("_subscription")
            ? "external_subscription"
            : "external_api_key",
        },
        connectionId: connection.id,
        provider: connection.provider,
        connection,
        effective: configured.effective,
        routeId: configured.route.id,
        routeRevision: configured.route.revision,
        fallback: configured.route.fallback,
        source: configured.source,
        incompatible: !connectionSupportsProtocol(connection.kind, protocol),
      };
    }
    if (
      !requested ||
      (requested.provider !== "openai" && requested.provider !== "anthropic")
    ) {
      return {
        access: { type: "managed" },
        effective: configured?.effective,
        source: configured?.source,
      };
    }
    const bindings = await account.listModelAccessBindings(
      project.id,
      environment,
    );
    const binding = bindings.find(
      (candidate: ModelAccessBinding) =>
        candidate.provider === requested.provider && candidate.enabled,
    );
    if (!binding) {
      return { access: { type: "managed" }, source: "use_model" };
    }
    const connection = await account.getModelAccessConnection(
      binding.connectionId,
    );
    if (!connection || connection.status !== "connected") {
      return { access: { type: "managed" }, source: "use_model" };
    }
    return {
      access: { type: "external_subscription" },
      connectionId: connection.id,
      provider: requested.provider,
      connection,
      effective: requested,
      source: "use_model",
    };
  } catch {
    return { access: { type: "managed" } };
  }
}

// Returns a usable access token for a connected Codex subscription. If the
// access token is close to expiry and a refresh credential exists, refreshes
// single-flight and persists the rotated access material. Never exposes refresh
// material to the dispatcher. Returns null only if no usable token could be
// produced (missing/expired credential with no successful refresh) so callers
// can fall back to Managed or fail.
async function usableCodexCredential(
  env: Env & PlatformEnv,
  account: ReturnType<Env["ACCOUNTS"]["getByName"]>,
  connectionId: string,
): Promise<{ accessToken: string; accountId: string } | null> {
  const config = codexConfig(env);
  const token = await account.modelAccessCredential(connectionId);
  if (!token) return null;
  if (!config) {
    const accountId = codexAccountId(token);
    return accountId ? { accessToken: token, accountId } : null;
  }
  const refresh = await account.modelAccessRefreshCredential(connectionId);
  if (!refresh) {
    const accountId = codexAccountId(token);
    return accountId ? { accessToken: token, accountId } : null;
  }
  try {
    const renewed = await refreshCodexCredential(config, {
      accessToken: token,
      refreshToken: refresh.refreshToken,
      tokenType: refresh.tokenType,
      expiresAt: 0,
      scopes: [],
    });
    await account.persistModelAccessRefresh({
      id: connectionId,
      accessToken: renewed.accessToken,
      refreshToken: renewed.refreshToken,
      tokenType: renewed.tokenType,
      expiresAt: renewed.expiresAt,
    });
    const accountId = codexAccountId(renewed.accessToken);
    return accountId
      ? { accessToken: renewed.accessToken, accountId }
      : null;
  } catch {
    // Refresh is best-effort at dispatch. If it fails we keep the current token
    // so the request can still be attempted once; the provider is the final
    // authority and may reject it, at which point the caller's fallback applies.
    const accountId = codexAccountId(token);
    return accountId ? { accessToken: token, accountId } : null;
  }
}

async function runtimeSessionResources(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response | null> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  return runtime ? json(await runtime.session.resources()) : null;
}

/**
 * The sandbox session runtime's memory, authenticated by the runtime token
 * (design 018, Boundaries). The Workerd host holds the session's grants and
 * calls the Memory DO itself; the sandbox runtime cannot reach a Durable
 * Object, so it recalls and saves through here with the session id the
 * admission issued the grants to. The outcomes are the Memory DO's own, so
 * the fixed memory tools return the same JSON on both runtimes.
 *
 *   GET  /v1/sessions/:id/memory       every binding with its projection
 *   POST /v1/sessions/:id/memory/save  { resource, text, summary?, expectedRevision }
 *   POST /v1/sessions/:id/memory/read  { resource, id }
 *   POST /v1/sessions/:id/memory/list  { resource, cursor? }
 */
async function runtimeSessionMemory(
  request: Request,
  env: Env,
  sessionId: string,
  operation: "recall" | "save" | "read" | "list",
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const { snapshot } = runtime;
  const bindings: SessionMemoryBinding[] = snapshot.memory ?? [];
  if (operation === "recall" && bindings.length === 0) return json({ bindings: [] });
  const platform = env as Env & PlatformEnv;
  if (!platform.MEMORY) {
    return problem(503, "memory_unavailable", "Project memory is not configured");
  }
  if (!snapshot.memoryObject || snapshot.memoryAdmission?.state !== "issued") {
    return problem(
      409,
      "memory_not_issued",
      snapshot.memoryAdmission?.state === "rejected"
        ? `Memory admission was rejected: ${snapshot.memoryAdmission.reason}`
        : "Memory grants have not been issued to this session",
    );
  }
  const memory = platform.MEMORY.getByName(snapshot.memoryObject);
  if (operation === "recall") {
    const recalled: Array<MemoryBinding & { projection: MemoryProjection }> = [];
    for (const binding of bindings) {
      const outcome = await memory.recall(sessionId, binding.resource);
      if (outcome.kind !== "projection") {
        return problem(
          409,
          "memory_recall_rejected",
          `Memory recall for ${binding.resource} was rejected: ${outcome.reason}`,
        );
      }
      const { writable: _writable, ...grant } = binding;
      recalled.push({ ...grant, projection: outcome.projection });
    }
    return json({ bindings: recalled });
  }
  const input = (await readJson(request)) ?? {};
  const resource = input.resource;
  if (typeof resource !== "string" || !bindings.some((binding) => binding.resource === resource)) {
    return json({ status: "rejected", reason: "not_bound", bound: bindings.map((b) => b.resource) });
  }
  switch (operation) {
    case "save": {
      if (
        typeof input.text !== "string" ||
        (input.summary !== undefined && typeof input.summary !== "string") ||
        typeof input.expectedRevision !== "string"
      ) {
        return problem(400, "invalid_memory_save", "memory save needs text and expectedRevision");
      }
      const result = await memory.save(
        sessionId,
        resource,
        { text: input.text, ...(input.summary !== undefined ? { summary: input.summary } : {}) },
        input.expectedRevision,
      );
      if (result.status === "saved") {
        const binding = bindings.find((candidate) => candidate.resource === resource);
        const documentId = binding?.scope === "document" ? binding.id : resource;
        await runtime.session.recordMemorySaved({
          resource,
          documentId,
          revision: result.revision,
          bytes: result.bytes,
        });
      }
      return json(result);
    }
    case "read": {
      if (typeof input.id !== "string") {
        return problem(400, "invalid_memory_read", "memory read needs id");
      }
      const outcome = await memory.readDocument(sessionId, resource, input.id);
      if (outcome.kind === "document") {
        const { id, title, text, summary, revision, updatedAt } = outcome.document;
        return json({ id, title, text, summary, revision, updatedAt });
      }
      return json({
        status: "rejected",
        reason: outcome.kind === "rejected" ? outcome.reason : "not_found",
      });
    }
    case "list": {
      if (input.cursor !== undefined && typeof input.cursor !== "string") {
        return problem(400, "invalid_memory_list", "memory list cursor must be a string");
      }
      const outcome = await memory.listCollection(sessionId, resource, input.cursor);
      if ("kind" in outcome) return json({ status: "rejected", reason: outcome.reason });
      return json({
        documents: outcome.documents.map(({ id, title, summary, revision, updatedAt }: DocumentMeta) => ({
          id,
          title,
          summary,
          revision,
          updatedAt,
        })),
        nextCursor: outcome.nextCursor,
      });
    }
  }
}

async function runtimeAgentVariables(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  const project = await account.projectForAgent(runtime.snapshot.agentId);
  if (!deployment || !project) {
    return problem(409, "runtime_scope_unavailable", "Runtime scope is unavailable");
  }
  const environment = sessionEnvironment(runtime.snapshot, deployment);
  const variables = await account.resolveAgentRuntimeVariables({
    projectId: project.id,
    environment,
    agentId: deployment.agentId,
  });
  const gitHubConnections = (deployment.githubConnections ?? []).filter(
    (connection: GitHubConnectionDefinition) =>
      deployment.connections.includes(connection.id),
  );
  // When the installation token will stop working. The computer refreshes it
  // before dispatching a command that would outlive it; the runtime calls
  // this route again for that, so the expiry travels beside the variables.
  let gitHub: { expiresAt: string } | undefined;
  if (gitHubConnections.length > 0) {
    const permissions: Record<string, "read" | "write"> = {};
    for (const connection of gitHubConnections) {
      for (const [name, level] of Object.entries(
        connection.provider.permissions,
      ) as Array<[string, "read" | "write"]>) {
        if (level === "write" || permissions[name] === undefined) {
          permissions[name] = level;
        }
      }
    }
    const minted = await account.mintGitHubToken({
      projectId: project.id,
      environment,
      permissions,
    });
    switch (minted.outcome) {
      case "minted":
        variables.GITHUB_TOKEN = minted.token;
        variables.GH_TOKEN = minted.token;
        gitHub = { expiresAt: minted.expiresAt };
        break;
      case "not_connected":
      case "app_not_configured":
        return problem(
          409,
          "github_not_connected",
          `GitHub is not connected to the ${environment} environment`,
        );
      case "failed":
        return problem(minted.retryable ? 503 : 409, minted.code, minted.message);
    }
  }
  if (Object.keys(variables).length > 128) {
    return problem(409, "runtime_variables_exceeded", "Too many runtime variables are configured");
  }
  if (new TextEncoder().encode(JSON.stringify(variables)).byteLength > 256 * 1024) {
    return problem(409, "runtime_variables_exceeded", "Runtime variables exceed the size limit");
  }
  return json({ variables, ...(gitHub ? { github: gitHub } : {}) });
}

function runtimeGenerationInput(value: unknown): RuntimeGeneration | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "microvm" &&
    typeof value.epoch === "number" &&
    Number.isInteger(value.epoch) &&
    value.epoch >= 0
  ) {
    return { kind: "microvm", epoch: value.epoch };
  }
  if (
    value.kind === "workerd" &&
    typeof value.bootId === "string" &&
    value.bootId.length > 0 &&
    value.bootId.length <= 128 &&
    typeof value.activation === "number" &&
    Number.isInteger(value.activation) &&
    value.activation >= 0
  ) {
    return { kind: "workerd", bootId: value.bootId, activation: value.activation };
  }
  return null;
}

/**
 * The result tool's commit (C1), from the runtime that executed the tool.
 * The answer is unambiguous on purpose: a 2xx with the receipt, a 409 with
 * a rejection code the model is told about, or a failure the host treats
 * as transport uncertainty and retries under the same `(turnId, callId)`.
 */
async function commitRuntimeSessionResult(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  // Abuse bound only; the Session object is the one place that applies
  // the result's own size limit and answers `result_too_large`.
  const input = await readBoundedJson(request, 8 * SESSION_RESULT_DATA_LIMIT);
  const generation = runtimeGenerationInput(input?.runtime);
  if (
    input === null ||
    typeof input.turnId !== "string" ||
    !input.turnId ||
    input.turnId.length > 256 ||
    typeof input.callId !== "string" ||
    !input.callId ||
    input.callId.length > 256 ||
    typeof input.tool !== "string" ||
    !input.tool ||
    input.tool.length > 256 ||
    !generation ||
    !("data" in input) ||
    (input.messageId !== undefined &&
      (typeof input.messageId !== "string" || input.messageId.length > 256))
  ) {
    return problem(
      400,
      "invalid_result_commit",
      "Expected turnId, callId, tool, runtime and data",
    );
  }
  const commit: ResultCommitInput = {
    turnId: input.turnId,
    callId: input.callId,
    tool: input.tool,
    runtime: generation,
    // Parsed from the request body, so JSON by construction.
    data: input.data as JsonValue,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
  const outcome = await runtime.session.commitResult(commit);
  if (outcome.status === "committed") return json(outcome);
  return problem(409, outcome.reason, outcome.message);
}

async function commitRuntimeAgentRender(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const input = await readJson(request);
  const model = input?.model;
  const renderInput = input?.input;
  if (
    typeof input?.renderId !== "string" ||
    typeof input.responseId !== "string" ||
    typeof input.providerTurn !== "number" ||
    !Number.isInteger(input.providerTurn) ||
    input.providerTurn < 1 ||
    typeof input.stateVersion !== "number" ||
    !Number.isInteger(input.stateVersion) ||
    input.stateVersion < 0 ||
    typeof input.instructionsHash !== "string" ||
    typeof input.instructions !== "string" ||
    input.instructions.length > 128 * 1024 ||
    !Array.isArray(input.enabledTools) ||
    !input.enabledTools.every((value: unknown) => typeof value === "string") ||
    (input.enabledSubagents !== undefined &&
      (!Array.isArray(input.enabledSubagents) ||
        input.enabledSubagents.length > 0)) ||
    !Array.isArray(input.requiredConnections) ||
    !input.requiredConnections.every(
      (value: unknown) => typeof value === "string",
    ) ||
    !Array.isArray(input.enabledMcpServers) ||
    !input.enabledMcpServers.every(
      (value: unknown) => typeof value === "string",
    ) ||
    !isRecord(renderInput) ||
    typeof renderInput.source !== "string" ||
    (renderInput.text !== undefined &&
      (typeof renderInput.text !== "string" ||
        renderInput.text.length > 128 * 1024)) ||
    !Array.isArray(input.tools) ||
    input.tools.length > 256 ||
    !input.tools.every(
      (value: unknown) =>
        isRecord(value) &&
        typeof value.name === "string" &&
        value.name.length <= 256 &&
        typeof value.description === "string" &&
        value.description.length <= 8 * 1024,
    ) ||
    typeof input.renderedAt !== "string" ||
    (model !== undefined &&
      (typeof model !== "object" ||
        model === null ||
        Array.isArray(model) ||
        typeof (model as Record<string, unknown>).provider !== "string" ||
        typeof (model as Record<string, unknown>).model !== "string"))
  ) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "runtime.agent_render_invalid",
        sessionId,
        shape: {
          renderId: typeof input?.renderId,
          responseId: typeof input?.responseId,
          providerTurn: input?.providerTurn,
          stateVersion: input?.stateVersion,
          instructionsHash: typeof input?.instructionsHash,
          instructions: typeof input?.instructions,
          instructionsLength:
            typeof input?.instructions === "string"
              ? input.instructions.length
              : undefined,
          enabledTools: Array.isArray(input?.enabledTools)
            ? input.enabledTools.length
            : typeof input?.enabledTools,
          requiredConnections: Array.isArray(input?.requiredConnections)
            ? input.requiredConnections.length
            : typeof input?.requiredConnections,
          enabledMcpServers: Array.isArray(input?.enabledMcpServers)
            ? input.enabledMcpServers.length
            : typeof input?.enabledMcpServers,
          input: isRecord(renderInput)
            ? {
                source: typeof renderInput.source,
                text: typeof renderInput.text,
              }
            : typeof renderInput,
          tools: Array.isArray(input?.tools)
            ? input.tools.map((tool: unknown) =>
                isRecord(tool)
                  ? {
                      name: typeof tool.name,
                      description: typeof tool.description,
                    }
                  : typeof tool,
              )
            : typeof input?.tools,
          model: isRecord(model)
            ? {
                provider: typeof model.provider,
                model: typeof model.model,
              }
            : typeof model,
          renderedAt: typeof input?.renderedAt,
        },
      }),
    );
    return problem(400, "invalid_agent_render", "Agent render is invalid");
  }
  return json(
    await runtime.session.commitAgentRender({
      renderId: input.renderId,
      responseId: input.responseId,
      providerTurn: input.providerTurn,
      stateVersion: input.stateVersion,
      instructionsHash: input.instructionsHash,
      instructions: input.instructions,
      enabledTools: input.enabledTools,
      requiredConnections: input.requiredConnections,
      enabledMcpServers: input.enabledMcpServers,
      input: renderInput as { source: string; text?: string },
      tools: input.tools as Array<{ name: string; description: string }>,
      ...(model
        ? {
            model: model as { provider: string; model: string },
          }
        : {}),
      renderedAt: input.renderedAt,
    }),
    201,
  );
}

async function listSessionConnections(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  const allowedProviders = new Set(deployment?.connections ?? []);
  const checkedAt = new Date();
  const pending = await account.claimPendingManagedConnections({
    ownerUserId: runtime.snapshot.userId,
    checkedAt: checkedAt.toISOString(),
    retryBefore: new Date(checkedAt.getTime() - 5_000).toISOString(),
  });
  const identity: RequestIdentity = {
    kind: "user",
    accountId: runtime.snapshot.accountId,
    organizationId: runtime.snapshot.accountId,
    userId: runtime.snapshot.userId,
  };
  await Promise.all(
    pending.map(async (connection: Connection) => {
      if (connection.provider === "github" || connection.provider === "linear") {
        const service = connection.provider;
        const configuration = composioConfigForService(
          env as Env & PlatformEnv,
          service,
          request.url,
        );
        if (!configuration) return;
        try {
          const userId = composioConnectionUserId(identity, connection.id);
          const managed =
            service === "github"
              ? await managedGithubConnection(configuration, userId)
              : await managedLinearConnection(configuration, userId);
          if (managed.status === "connected" && managed.connectedAccountId) {
            await account.upsertManagedToolConnection({
              id: connection.id,
              provider: service,
              label: connection.label,
              ownerUserId: runtime.snapshot.userId,
              externalAccountId: managed.connectedAccountId,
              scopes: managed.scopes,
            });
          }
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "session_connection.reconcile_failed",
              connectionId: connection.id,
              service,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return;
      }
      const service = googleServiceForScopes(connection.scopes);
      if (!service) return;
      const configuration = composioGoogleConfig(
        env as Env & PlatformEnv,
        service,
        request.url,
      );
      if (!configuration) return;
      try {
        const managed = await managedGoogleConnection(
          configuration,
          composioConnectionUserId(identity, connection.id),
          service,
        );
        if (managed.status === "connected" && managed.connectedAccountId) {
          await account.upsertManagedToolConnection({
            id: connection.id,
            provider: "google",
            label: connection.label,
            ownerUserId: runtime.snapshot.userId,
            externalAccountId: managed.connectedAccountId,
            displayName: managed.displayName,
            scopes: managed.scopes,
          });
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "session_connection.reconcile_failed",
            connectionId: connection.id,
            service,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }),
  );
  return json({
    connections: (await account.listConnections(runtime.snapshot.userId))
      .filter(
        (connection: Connection) =>
          connection.kind === "tool" &&
          allowedProviders.has(connection.provider ?? ""),
      )
      .map((connection: Connection) => ({
        id: connection.id,
        provider: connection.provider,
        label: connection.label,
        displayName: connection.displayName,
        scopes: connection.scopes,
        status: connection.status,
      })),
  });
}

async function requestSessionConnection(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const body = await readJson(request);
  const requestedService = body?.service;
  const service =
    typeof requestedService === "string"
      ? connectionService(requestedService)
      : null;
  const input: SessionConnectionRequestInput | null = service
    ? {
        service,
        label: typeof body?.label === "string" ? body.label : undefined,
        newAccount: body?.newAccount === true,
      }
    : null;
  if (!input?.service) {
    return problem(
      400,
      "invalid_connection_request",
      "Expected one of gmail, calendar, drive, sheets, github, or linear and an optional connection alias",
    );
  }
  const provider = ["gmail", "calendar", "drive", "sheets"].includes(
    input.service,
  )
    ? "google"
    : input.service;
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  let label = connectionLabel(input.label);
  if (input.newAccount && input.label === undefined) {
    const usedLabels = new Set(
      (await account.listConnections(runtime.snapshot.userId))
        .filter(
          (connection: Connection) =>
            connection.kind === "tool" && connection.provider === provider,
        )
        .map((connection: Connection) => connection.label),
    );
    let suffix = 2;
    while (usedLabels.has(`${input.service}-${suffix}`)) suffix += 1;
    label = `${input.service}-${suffix}`;
  }
  if (!label) {
    return problem(
      400,
      "invalid_connection_request",
      "Connection aliases must use lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  if (!deployment?.connections.includes(provider)) {
    return problem(
      409,
      "connection_not_declared",
      `${input.service} is not declared by this deployed agent`,
    );
  }
  if (
    !["gmail", "calendar", "drive", "sheets", "github", "linear"].includes(input.service)
  ) {
    return problem(
      400,
      "unsupported_connection_service",
      "Supported connection services are gmail, calendar, drive, sheets, github, and linear",
    );
  }
  const existing = await account.findUserConnection(
    runtime.snapshot.userId,
    provider,
    label,
  );
  if (existing?.status === "connected") {
    return json({
      status: "connected",
      connection: {
        id: existing.id,
        provider: existing.provider,
        label: existing.label,
        displayName: existing.displayName,
        scopes: existing.scopes,
        status: existing.status,
      },
    });
  }
  const connectUrl = connectionPageUrl(
    env as Env & PlatformEnv,
    input.service,
    label,
  );
  if (!connectUrl) {
    return problem(
      503,
      "connection_ui_unavailable",
      "The connection setup page is unavailable",
    );
  }
  const url = new URL(connectUrl);
  url.searchParams.set("connect", "1");
  const channel = await runtime.session.channelPrincipal();
  if (channel?.provider === "slack") {
    const token = crypto.randomUUID().replace(/-/g, "");
    const authorizationUrl = channelConnectionPageUrl(
      env as Env & PlatformEnv,
      runtime.snapshot.accountId,
      token,
    );
    if (!authorizationUrl) {
      return problem(
        503,
        "connection_ui_unavailable",
        "The connection setup page is unavailable",
      );
    }
    await account.issueChannelConnectionGrant({
      tokenHash: await sha256(token),
      connectionId: channel.connectionId,
      externalUserId: channel.externalUserId,
      principalUserId: runtime.snapshot.userId,
      service: input.service,
      label,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    await account.postSlackPrivateMessage(
      channel.connectionId,
      channel.externalUserId,
      `This agent needs access to ${input.service}. Connect ${input.service} securely: ${authorizationUrl}`,
    );
    return json({
      status: "requested",
      delivery: "private_message",
      service: input.service,
      label,
    });
  }
  return json({
    status: "requested",
    delivery: "inline",
    service: input.service,
    label,
    authorizationUrl: url.toString(),
  });
}

const FORBIDDEN_EGRESS_HEADERS = new Set([
  "api-key",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

const SECRET_ONLY_HEADERS = new Set([
  "api-key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);

/**
 * Origins a stored secret may be attached to.
 *
 * Returns null when the list is empty or any entry is not a bare public HTTPS
 * origin. A secret with no origin restriction has to be asked for explicitly
 * with "*", because the default a caller forgets is the one that leaks.
 */
function normalizedSecretOrigins(value: unknown): string[] | null {
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!values.length) return null;
  const normalized: string[] = [];
  for (const entry of values) {
    if (entry === "*") {
      normalized.push(entry);
      continue;
    }
    let origin: URL;
    try {
      origin = new URL(entry);
    } catch {
      return null;
    }
    if (
      origin.protocol !== "https:" ||
      origin.origin !== entry ||
      !egressOriginIsPublic(origin)
    ) {
      return null;
    }
    normalized.push(origin.origin);
  }
  return [...new Set(normalized)];
}

function egressOriginIsPublic(origin: URL): boolean {
  const hostname = origin.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:")
  ) {
    return false;
  }
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    ) {
      return false;
    }
  }
  return true;
}

const EGRESS_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function managedEgressRedirectTarget(
  definition: HttpConnectionDefinition,
  source: URL,
  response: Response,
): URL | null {
  if (!EGRESS_REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  let redirect: URL;
  try {
    redirect = new URL(location, source);
  } catch {
    return null;
  }
  if (
    !egressOriginIsPublic(redirect) ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  ) {
    return null;
  }
  return (definition.redirectOrigins ?? []).some(
    (allowed) =>
      redirect.origin === allowed.origin &&
      (!allowed.pathPrefix || redirect.pathname.startsWith(allowed.pathPrefix)),
  )
    ? redirect
    : null;
}

async function runtimeManagedEgress(
  request: Request,
  env: Env,
  sessionId: string,
  connectionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  const definition = deployment?.httpConnections.find(
    (connection: HttpConnectionDefinition) => connection.id === connectionId,
  );
  if (!deployment || !definition) {
    return problem(
      403,
      "connection_not_declared",
      "This connection is not declared by the deployment",
    );
  }
  const origin = new URL(definition.origin);
  if (!egressOriginIsPublic(origin)) {
    return problem(403, "egress_origin_blocked", "The connection origin is blocked");
  }
  const body = await readBoundedJson(request, 6 * 1024 * 1024);
  const method = typeof body?.method === "string" ? body.method.toUpperCase() : "GET";
  const path = typeof body?.path === "string" ? body.path : "";
  const requestBody = body?.body;
  if (
    !/^[A-Z]+$/.test(method) ||
    !path.startsWith("/") ||
    (requestBody !== undefined && typeof requestBody !== "string")
  ) {
    return problem(400, "invalid_egress_request", "Expected method, path, headers, and an optional string body");
  }
  const methods = definition.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!methods.includes(method)) {
    return problem(403, "egress_method_blocked", "The connection does not allow this method");
  }
  const target = new URL(path, origin);
  if (
    target.origin !== origin.origin ||
    (definition.pathPrefix && !target.pathname.startsWith(definition.pathPrefix))
  ) {
    return problem(403, "egress_path_blocked", "The connection does not allow this path");
  }
  const headers = new Headers();
  if (body?.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
    const entries = Object.entries(body.headers);
    if (entries.length > 64) {
      return problem(400, "invalid_egress_headers", "Too many request headers");
    }
    for (const [name, value] of entries) {
      if (typeof value !== "string" || FORBIDDEN_EGRESS_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      if (value.length > 16_384) {
        return problem(400, "invalid_egress_headers", "A request header is too large");
      }
      headers.set(name, value);
    }
  }
  const project = await account.projectForAgent(runtime.snapshot.agentId);
  const environment = sessionEnvironment(runtime.snapshot, deployment);
  if (!project) {
    return problem(409, "project_not_found", "The deployed agent is not attached to a project");
  }
  for (const [name, value] of Object.entries(definition.headers) as Array<
    [string, HttpConnectionDefinition["headers"][string]]
  >) {
    if (typeof value === "string") {
      headers.set(name, value);
      continue;
    }
    if (value.scope === "user") {
      // The credential of the person being acted for, so the upstream applies
      // its own permissions to them rather than to the whole installation.
      const [connectionId, actingUser] = await Promise.all([
        runtime.session.channelConnectionId(),
        runtime.session.actingUser(),
      ]);
      if (!connectionId || !actingUser) {
        return problem(
          409,
          "user_secret_unbound",
          `Secret ${value.name} is per-user, and this session is not acting for anyone`,
        );
      }
      const userSecret = await account.resolveUserSecret({
        connectionId,
        externalUserId: actingUser,
        name: value.name,
        origin: origin.origin,
      });
      if (userSecret === null) {
        // Deliberately not the installation's credential. Acting as somebody
        // who has not connected their account, using someone else's authority,
        // is the failure this scope exists to make impossible.
        return problem(
          409,
          "user_secret_unavailable",
          `Secret ${value.name} is not connected for this person`,
        );
      }
      headers.set(
        name,
        `${value.prefix ?? ""}${userSecret}${value.suffix ?? ""}`,
      );
      await runtime.session.shareSecretReference(value.name, "user");
      continue;
    }
    if (value.scope === "tenant") {
      // A per-installation credential. The tenant is a property of the
      // session, not of the request, so it cannot be influenced by anything
      // the agent says or sends.
      const connectionId = await runtime.session.channelConnectionId();
      if (!connectionId) {
        // No installation means no tenant, and there is nothing safe to
        // substitute: falling back to the project secret is precisely the
        // cross-tenant leak this scope exists to prevent.
        return problem(
          409,
          "tenant_secret_unbound",
          `Secret ${value.name} is per-installation, and this session does not belong to one`,
        );
      }
      const tenantSecret = await account.resolveInstallationSecret({
        connectionId,
        name: value.name,
        origin: origin.origin,
      });
      if (tenantSecret === null) {
        return problem(
          409,
          "tenant_secret_unavailable",
          `Secret ${value.name} is not set for this installation, or is not allowed for this connection`,
        );
      }
      headers.set(
        name,
        `${value.prefix ?? ""}${tenantSecret}${value.suffix ?? ""}`,
      );
      await runtime.session.shareSecretReference(value.name, "tenant");
      continue;
    }
    const secret = await account.resolveManagedSecret({
      projectId: project.id,
      environment,
      agentId: deployment.agentId,
      name: value.name,
      origin: origin.origin,
    });
    if (secret === null) {
      return problem(
        409,
        "secret_unavailable",
        `Secret ${value.name} is missing or is not allowed for this connection`,
      );
    }
    headers.set(name, `${value.prefix ?? ""}${secret}${value.suffix ?? ""}`);
    await runtime.session.shareSecretReference(value.name, "project");
  }
  const startedAt = Date.now();
  const logContext = {
    projectId: project.id,
    environment,
    agentId: deployment.agentId,
    deploymentId: deployment.id,
    sessionId,
  };
  await runtime.session.recordEgressEvent({
    type: "egress.request",
    connectionId,
    method,
    path: `${target.pathname}${target.search}`,
  });
  await account.appendAgentLog({
    ...logContext,
    timestamp: new Date().toISOString(),
    level: "info",
    event: "egress.request",
    data: {
      connectionId,
      method,
      path: `${target.pathname}${target.search}`,
    },
  });
  try {
    let upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : requestBody,
      redirect: "manual",
    });
    if (EGRESS_REDIRECT_STATUSES.has(upstream.status)) {
      const redirect =
        method === "GET" || method === "HEAD"
          ? managedEgressRedirectTarget(definition, target, upstream)
          : null;
      await upstream.body?.cancel();
      if (!redirect) {
        upstream = problem(
          502,
          "egress_redirect_blocked",
          "The upstream redirect is not allowed",
        );
      } else {
        // Caller-supplied and static connection headers never cross origins.
        // Managed secret headers are rebuilt for the redirect destination so
        // each secret must independently allow that exact origin.
        const redirectHeaders = new Headers();
        for (const [name, value] of Object.entries(definition.headers) as Array<
          [string, HttpConnectionDefinition["headers"][string]]
        >) {
          if (typeof value === "string") continue;
          const secret = await account.resolveManagedSecret({
            projectId: project.id,
            environment,
            agentId: deployment.agentId,
            name: value.name,
            origin: redirect.origin,
          });
          if (secret === null) {
            upstream = problem(
              409,
              "secret_unavailable",
              `Secret ${value.name} is missing or is not allowed for the redirect connection`,
            );
            break;
          }
          redirectHeaders.set(
            name,
            `${value.prefix ?? ""}${secret}${value.suffix ?? ""}`,
          );
          await runtime.session.shareSecretReference(value.name, "project");
        }
        if (upstream.status !== 409) {
          upstream = await fetch(redirect, {
            method,
            headers: redirectHeaders,
            redirect: "manual",
          });
          if (EGRESS_REDIRECT_STATUSES.has(upstream.status)) {
            await upstream.body?.cancel();
            upstream = problem(
              502,
              "egress_redirect_blocked",
              "The upstream redirected more than once",
            );
          }
        }
      }
    }
    await runtime.session.recordEgressEvent({
      type: "egress.response",
      connectionId,
      method,
      path: `${target.pathname}${target.search}`,
      status: upstream.status,
      durationMs: Date.now() - startedAt,
    });
    await account.appendAgentLog({
      ...logContext,
      timestamp: new Date().toISOString(),
      level: upstream.ok ? "info" : "warn",
      event: "egress.response",
      data: {
        connectionId,
        method,
        path: `${target.pathname}${target.search}`,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      },
    });
    return upstream;
  } catch (error) {
    await runtime.session.recordEgressEvent({
      type: "egress.failed",
      connectionId,
      method,
      path: `${target.pathname}${target.search}`,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    await account.appendAgentLog({
      ...logContext,
      timestamp: new Date().toISOString(),
      level: "error",
      event: "egress.failed",
      data: {
        connectionId,
        method,
        path: `${target.pathname}${target.search}`,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return problem(502, "egress_request_failed", "The upstream request failed");
  }
}

/**
 * Presents managed egress as a raw Streamable HTTP MCP endpoint. OpenCode's
 * MCP client speaks the protocol directly, while runtimeManagedEgress remains
 * the one place that resolves credentials, enforces the connection allowlist,
 * and records the request. The runtime bearer token authenticates this hop and
 * is deliberately stripped before the stored upstream headers are applied.
 */
async function runtimeManagedMcp(
  request: Request,
  env: Env,
  sessionId: string,
  connectionId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path?.startsWith("/")) {
    return problem(400, "invalid_mcp_path", "A managed MCP path is required");
  }
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? ""
      : await readBoundedText(request, 6 * 1024 * 1024);
  if (body === null) {
    return problem(413, "mcp_request_too_large", "The MCP request body is too large");
  }
  const headers = Object.fromEntries(request.headers);
  const authorization = request.headers.get("authorization");
  return runtimeManagedEgress(
    new Request(request.url, {
      method: "POST",
      headers: {
        ...(authorization ? { authorization } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: request.method,
        path,
        headers,
        ...(body ? { body } : {}),
      }),
    }),
    env,
    sessionId,
    connectionId,
  );
}

/**
 * The system database MCP. The runtime token selects the session; the edge
 * derives account, project, and environment and forwards only the MCP body to
 * that environment's dedicated database object.
 */
async function runtimeDatabaseMcp(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  if (runtime.snapshot.projectId.startsWith("project:")) {
    return problem(403, "database_project_required", "The session does not belong to a project");
  }
  const platform = env as Env & PlatformEnv;
  if (!platform.DATABASES) {
    return problem(503, "database_unavailable", "The project database is not configured");
  }
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  if (!deployment?.projectDeployment) {
    return problem(403, "database_not_declared", "The deployment is not a project deployment");
  }
  const environment = sessionEnvironment(runtime.snapshot, deployment);
  const body = await readBoundedText(request, 128 * 1024);
  if (body === null) {
    return problem(413, "database_mcp_request_too_large", "The database request is too large");
  }
  const database = platform.DATABASES.getByName(
    databaseObjectName(
      runtime.snapshot.accountId,
      runtime.snapshot.projectId,
      environment,
    ),
  );
  const response = await database.fetch("https://database.internal/mcp", {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      accept: request.headers.get("accept") ?? "application/json",
    },
    ...(body ? { body } : {}),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

function outboxText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!isRecord(content)) return null;
  const parts = [content.title, content.body, content.url].filter(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  return parts.length ? parts.join("\n\n").slice(0, 35_000) : null;
}

async function publishRuntimeOutbox(
  request: Request,
  env: Env,
  context: ExecutionContext,
  sessionId: string,
  outboxId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  const project = deployment?.projectDeployment as
    | ProjectDeploymentReference
    | undefined;
  const outbox = project?.resources.outboxes.find((item) => item.id === outboxId);
  const authorized = project?.resources.outboxRegistrations.some(
    (registration) =>
      registration.agentId === project.localAgentId &&
      registration.outboxId === outboxId,
  );
  if (!deployment || !project || !outbox || !authorized) {
    return problem(403, "outbox_not_registered", "Outbox is not registered to this agent");
  }
  const body = await readBoundedJson(request, 64 * 1024);
  const text = outboxText(body?.content);
  if (
    typeof body?.type !== "string" ||
    !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(body.type) ||
    typeof body.idempotencyKey !== "string" ||
    !body.idempotencyKey.trim() ||
    body.idempotencyKey.length > 256 ||
    !text
  ) {
    return problem(400, "invalid_outbox_item", "Expected type, content, and idempotencyKey");
  }
  const item = await account.createOutboxItem({
    agentId: deployment.agentId,
    alias: deployment.alias,
    deploymentId: deployment.id,
    sessionId,
    outboxId,
    eventType: body.type,
    idempotencyKey: body.idempotencyKey,
    content: body.content,
  });
  if (!item.duplicate) {
    const connection = await account.findSlackConnectionForAlias(
      deployment.agentId,
      deployment.alias,
      outbox.channelId,
    );
    const binding = connection
      ? await account.getSlackDestination(connection.id, outbox.destination)
      : null;
    if (connection?.status === "connected" && binding) {
      context.waitUntil(
        account
          .deliverOutboxItem({
            id: item.id,
            connectionId: connection.id,
            destination: outbox.destination,
            conversationId: binding.conversationId,
            text,
          })
          .catch(() => undefined),
      );
    }
  }
  return json(item, item.duplicate ? 200 : 202);
}

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;

const RECORDED_FOR_APPROVAL =
  "Recorded for approval. The person you are talking to sees a card with the " +
  "exact change and decides from there. Do not call this again, and do not " +
  "tell them it has been done.";

function approvalFacts(
  preview: unknown,
): Array<{ label: string; value: string }> {
  if (!isRecord(preview) || !Array.isArray(preview.facts)) return [];
  return preview.facts.flatMap((fact) =>
    isRecord(fact) &&
    typeof fact.label === "string" &&
    typeof fact.value === "string"
      ? [{ label: fact.label.slice(0, 120), value: fact.value.slice(0, 400) }]
      : [],
  );
}

/**
 * A gated tool proposing a write.
 *
 * Reached over the session's runtime token, the same way an outbox item is
 * published — the agent has no other credential the platform trusts.
 */
async function recordRuntimeApproval(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const body = await readBoundedJson(request, 64 * 1024);
  const preview = body?.preview;
  if (
    typeof body?.toolId !== "string" ||
    !body.toolId ||
    typeof body.idempotencyKey !== "string" ||
    !body.idempotencyKey.trim() ||
    body.idempotencyKey.length > 256 ||
    !isRecord(preview) ||
    typeof preview.title !== "string" ||
    !preview.title.trim()
  ) {
    return problem(
      400,
      "invalid_approval",
      "Expected toolId, a preview with a title, and idempotencyKey",
    );
  }

  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const deployment = await account.getDeployment(runtime.snapshot.deploymentId);
  const project = deployment?.projectDeployment as
    | ProjectDeploymentReference
    | undefined;
  if (!deployment || !project) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }
  const gated = project.resources.gatedTools?.some(
    (tool) =>
      tool.agentId === project.localAgentId && tool.toolId === body.toolId,
  );
  if (!gated) {
    return problem(
      403,
      "tool_not_gated",
      "This tool is not set up to ask for approval, so nothing was recorded " +
        "and nothing was changed. Tell the person the change was not made.",
    );
  }

  // Workerd sessions can propose but cannot carry the write out: `apply` is
  // dispatched over the session's runtime socket, and a workerd session has
  // none. Rather than show a card, take a click and silently never write —
  // the worst of the available outcomes — refuse before anything is recorded.
  if (
    runtime.snapshot.executionMode === "workerd" ||
    deployment.runtimeMode === "workerd-lazy-sandbox"
  ) {
    return problem(
      409,
      "approval_unsupported_runtime",
      "This agent runs on a runtime that cannot carry out approved writes " +
        "yet, so nothing was recorded and nothing was changed. Tell the " +
        "person the change could not be made.",
    );
  }

  // A proposal has to be addressed to somebody. A session started from the
  // playground, a schedule or a webhook has no conversation and nobody to
  // ask, and inventing a surface for it would be worse than saying so.
  const session = env.SESSIONS.getByName(sessionId);
  const delivery = await session.latestChannelDelivery();
  if (!delivery) {
    return problem(
      409,
      "approval_needs_a_conversation",
      "This tool can only be used in a conversation where somebody can " +
        "approve it. Nothing was changed. Tell the person the change has to " +
        "be made from a channel the agent is connected to.",
    );
  }
  const adapter = channelAdapter(delivery.provider);
  if (!adapter?.sendCard) {
    return problem(
      409,
      "provider_cannot_ask",
      `This conversation is on ${delivery.provider}, which has no way to show ` +
        "an approval. Nothing was changed. Tell the person the change needs " +
        "to be approved somewhere that can.",
    );
  }

  const approval = await account.createApproval({
    agentId: deployment.agentId,
    alias: deployment.alias,
    deploymentId: deployment.id,
    sessionId,
    turnId: delivery.turnId,
    toolId: body.toolId,
    toolInput: body.input ?? null,
    preview,
    connectionId: delivery.connectionId,
    provider: delivery.provider,
    deliveryRef: delivery.deliveryRef,
    ...(delivery.externalUserId
      ? { deciderPrincipal: delivery.externalUserId }
      : {}),
    idempotencyKey: body.idempotencyKey,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  });

  if (!approval.duplicate) {
    try {
      const messageId = await account.sendChannelCard(
        delivery.provider,
        delivery.connectionId,
        delivery.deliveryRef as Record<string, unknown>,
        {
          approvalId: approval.id,
          title: preview.title,
          ...(typeof preview.summary === "string"
            ? { summary: preview.summary }
            : {}),
          facts: approvalFacts(preview),
        },
      );
      await account.recordApprovalMessage(approval.id, messageId);
      // Arm the alarm that will close this out if nobody ever answers.
      await account.armApprovalExpiry();
    } catch (error: unknown) {
      // Nobody can decide on a card that was never posted, so the proposal
      // fails rather than sitting pending forever.
      await account.settleApproval({
        id: approval.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return problem(
        502,
        "approval_card_failed",
        "The approval could not be delivered to this conversation, so nobody " +
          "can approve it and nothing was changed. Tell the person to try " +
          "again shortly.",
      );
    }
  }

  return json(
    { ...approval, message: RECORDED_FOR_APPROVAL },
    approval.duplicate ? 200 : 202,
  );
}

/**
 * What was proposed, and what became of it.
 *
 * An approval that fails to deliver settles rather than sitting pending, and
 * until this existed there was no way to see the difference from outside.
 */
async function listEnvironmentApprovals(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId")?.trim() ?? "";
  if (!agentId) {
    return problem(
      400,
      "invalid_approval_environment",
      "Expected agentId and an explicit development or production environment",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const scoped = await agentScope(
    account,
    agentId,
    url.searchParams.get("environment"),
    { legacyDefault: "required" },
  );
  if (!scoped.ok) return scoped.response;
  const alias = scoped.scope.environment;
  const approvals = await account.listApprovals(agentId, alias);
  return json({
    approvals: approvals.map((approval: ApprovalRecord) => ({
      id: approval.id,
      toolId: approval.toolId,
      status: approval.status,
      input: approval.input,
      preview: approval.preview,
      provider: approval.provider,
      connectionId: approval.connectionId,
      ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
      ...(approval.externalMessageId
        ? { externalMessageId: approval.externalMessageId }
        : {}),
      ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {}),
      ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
      ...(approval.appliedAt ? { appliedAt: approval.appliedAt } : {}),
      ...(approval.result !== undefined ? { result: approval.result } : {}),
      ...(approval.error ? { error: approval.error } : {}),
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
    })),
  });
}

async function listEnvironmentOutboxes(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId")?.trim() ?? "";
  if (!agentId) {
    return problem(
      400,
      "invalid_outbox_environment",
      "Expected agentId and an explicit development or production environment",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const scoped = await agentScope(
    account,
    agentId,
    url.searchParams.get("environment"),
    { legacyDefault: "required" },
  );
  if (!scoped.ok) return scoped.response;
  const alias = scoped.scope.environment;
  const deployment = await account.resolveDeployment(`${agentId}@${alias}`);
  const project = deployment?.projectDeployment as
    | ProjectDeploymentReference
    | undefined;
  if (!deployment || !project) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }
  const registered = new Set(
    project.resources.outboxRegistrations
      .filter((registration) => registration.agentId === project.localAgentId)
      .map((registration) => registration.outboxId),
  );
  const items = await account.listOutboxItems(agentId, alias);
  const outboxes = await Promise.all(
    project.resources.outboxes
      .filter((outbox) => registered.has(outbox.id))
      .map(async (outbox) => {
        const channel = project.resources.channels.find(
          (candidate) => candidate.id === outbox.channelId,
        );
        const connection = await account.findSlackConnectionForAlias(
          agentId,
          alias,
          outbox.channelId,
        );
        const binding = connection
          ? await account.getSlackDestination(
              connection.id,
              outbox.destination,
            )
          : null;
        const readiness =
          connection?.status !== "connected"
            ? "channel_not_connected"
            : binding
              ? "ready"
              : "destination_not_bound";
        return {
          id: outbox.id,
          channelId: outbox.channelId,
          channelName: channel?.displayName ?? outbox.channelId,
          destination: outbox.destination,
          readiness,
          ...(binding ? { targetDisplayName: binding.displayName } : {}),
          items: items.filter(
            (item: { outboxId: string }) => item.outboxId === outbox.id,
          ),
        };
      }),
  );
  return json({
    agentId,
    environment: alias,
    deploymentId: deployment.id,
    outboxes,
  });
}

async function bindSlackDestination(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  connectionId: string,
  destination: string,
): Promise<Response> {
  const body = await readJson(request);
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(destination) ||
    typeof body?.conversationId !== "string" ||
    !/^[CG][A-Z0-9]+$/.test(body.conversationId)
  ) {
    return problem(400, "invalid_destination", "Expected a Slack conversation ID");
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const connection = await account.getSlackConnection(connectionId);
  if (!connection) return problem(404, "connection_not_found", "Connection not found");
  const deployment = await account.resolveDeployment(
    `${connection.agentId}@${connection.alias}`,
  );
  const projectDeployment = deployment?.projectDeployment as
    | ProjectDeploymentReference
    | undefined;
  const declared = projectDeployment?.resources.channels.some(
    (channel) => Boolean(channel.destinations[destination]),
  );
  if (!declared) {
    return problem(400, "destination_not_declared", "Destination is not declared by the deployment");
  }
  try {
    return json(
      await account.verifyAndBindSlackDestination({
        connectionId,
        destination,
        conversationId: body.conversationId,
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "slack.destination_verification_failed",
        connectionId,
        destination,
        requestId: request.headers.get("x-request-id"),
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return problem(
      409,
      "destination_verification_failed",
      error instanceof Error ? error.message : "Slack destination verification failed",
    );
  }
}

async function ingestRuntimeLogs(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const runtime = await authenticateSessionRuntime(request, env, sessionId);
  if (!runtime) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const body = await readBoundedJson(request, 1024 * 1024);
  const entries = Array.isArray(body?.entries) ? body.entries.slice(0, 100) : [];
  if (!entries.length) {
    return problem(400, "invalid_runtime_logs", "Expected at least one log entry");
  }
  let accepted = 0;
  const account = env.ACCOUNTS.getByName(runtime.snapshot.accountId);
  const [project, deployment] = await Promise.all([
    account.projectForAgent(runtime.snapshot.agentId),
    account.getDeployment(runtime.snapshot.deploymentId),
  ]);
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.message !== "string") continue;
    const level = entry.level === "debug" || entry.level === "warn" || entry.level === "error"
      ? entry.level
      : "info";
    const stream = entry.stream === "stderr" || entry.stream === "system"
      ? entry.stream
      : "stdout";
    const timestamp = new Date().toISOString();
    await runtime.session.recordRuntimeLog({
      level,
      stream,
      message: entry.message,
      timestamp,
    });
    if (project && deployment) {
      await account.appendAgentLog({
        timestamp,
        level: level === "debug" ? "info" : level,
        event: "runtime.log",
        projectId: project.id,
        environment: sessionEnvironment(runtime.snapshot, deployment),
        agentId: deployment.agentId,
        deploymentId: deployment.id,
        sessionId,
        data: {
          level,
          stream,
          message: entry.message.slice(0, 16_384),
          ...(typeof entry.timestamp === "string"
            ? { sourceTimestamp: entry.timestamp }
            : {}),
        },
      });
    }
    accepted += 1;
  }
  return json({ accepted }, 202);
}

async function claimChannelConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const body = await readJson(request);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!/^[a-f0-9]{32}$/i.test(token)) {
    return problem(
      400,
      "invalid_connection_grant",
      "Connection link is invalid",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const tokenHash = await sha256(token);
  const grant = await account.claimChannelConnectionGrant(tokenHash);
  if (!grant) {
    return problem(
      404,
      "connection_grant_not_found",
      "Connection link is invalid or expired",
    );
  }
  const connection = await account.getSlackConnection(grant.connectionId);
  if (!connection || connection.status !== "connected") {
    return problem(404, "channel_not_found", "Channel is no longer connected");
  }
  const response = await linkManagedConnection(
    new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: grant.service, label: grant.label }),
    }),
    env,
    {
      kind: "user",
      accountId: identity.accountId,
      organizationId: identity.accountId,
      userId: grant.principalUserId,
    },
  );
  const result = (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  const connectionStatus =
    typeof result?.status === "string" ? result.status : null;
  const authorizationUrl =
    typeof result?.authorizationUrl === "string"
      ? result.authorizationUrl
      : null;
  let hasAuthorizationUrl = false;
  if (authorizationUrl) {
    try {
      hasAuthorizationUrl = new URL(authorizationUrl).protocol === "https:";
    } catch {
      hasAuthorizationUrl = false;
    }
  }
  console.log(
    JSON.stringify({
      level: "info",
      event: "channel_connection.claim_result",
      service: grant.service,
      label: grant.label,
      responseStatus: response.status,
      connectionStatus,
      hasAuthorizationUrl,
    }),
  );
  const redirectMissing =
    response.ok && connectionStatus === "pending" && !hasAuthorizationUrl;
  if (!response.ok || redirectMissing) {
    await account.releaseChannelConnectionGrant(tokenHash);
  } else {
    await account.deleteChannelConnectionGrant(tokenHash);
  }
  if (redirectMissing) {
    return problem(
      502,
      "managed_connection_redirect_missing",
      "The connection provider did not return an authorization URL",
    );
  }
  return response;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function encodeAccountId(accountId: string): string {
  const bytes = new TextEncoder().encode(accountId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function sessionPath(pathname: string): {
  sessionId: string;
  suffix: string;
} | null {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)(\/.*)?$/);
  if (!match?.[1]) {
    return null;
  }
  return {
    sessionId: decodeURIComponent(match[1]),
    suffix: match[2] ?? "",
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  // The production managed-agents API is service-only. Same-origin backend
  // development still works, but browser code on other origins cannot call it
  // directly and must use the public OpenComputer edge.
  headers.delete("access-control-allow-origin");
  headers.delete("access-control-allow-headers");
  headers.delete("access-control-allow-methods");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function composioOAuthRedirect(request: Request): Response {
  const source = new URL(request.url);
  const target = new URL(
    "https://backend.composio.dev/api/v3.1/toolkits/auth/callback",
  );
  target.search = source.search;
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function composioConnectionCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("account");
  const connectionId = url.searchParams.get("connection");
  // Record the outcome while we are being told about it. Verified with the
  // provider rather than taken from the query string, so this is safe on an
  // unauthenticated route; the worst a forged call achieves is a re-check.
  if (accountId && connectionId && url.searchParams.get("status") === "success") {
    try {
      const stored = await env.ACCOUNTS.getByName(accountId).getConnection(
        connectionId,
      );
      if (stored) {
        await reconcileToolConnection(env, accountId, stored, request.url);
      }
    } catch (error) {
      // The page still renders: the person authorized successfully, and the
      // listing reconciles on its next read regardless.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "managed_connection.callback_reconcile_failed",
          connectionId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  const service = url.searchParams.get("service")?.toLowerCase();
  const provider =
    service === "gmail"
      ? "Gmail"
      : service === "calendar"
        ? "Google Calendar"
        : service === "drive"
          ? "Google Drive"
          : service === "sheets"
            ? "Google Sheets"
            : service === "github"
              ? "GitHub"
              : service === "linear"
                ? "Linear"
                : "Google";
  const appUrl = env.OPENCOMPUTER_APP_URL?.trim();
  return html(
    renderConnectionCallback({
      provider,
      status:
        url.searchParams.get("status") === "success" ? "success" : "error",
      ...(appUrl ? { dashboardUrl: new URL("/", appUrl).toString() } : {}),
    }),
    url.searchParams.get("status") === "success" ? 200 : 400,
  );
}

const GITHUB_CONNECT_STATE_TTL_SECONDS = 1800;

function oauthNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * `GET /v1/projects/<p>/github/repositories?environment=&cursor=&limit=`:
 * the repositories the environment's GitHub installation covers, read live
 * from GitHub with a token minted for this call carrying `metadata: read`
 * and nothing else. Nothing is persisted; GitHub's installation selection is
 * the boundary, and a changed selection shows on the next read. The caller
 * is the owner: project tokens are refused before this is reached.
 */
async function listProjectGitHubRepositories(
  url: URL,
  account: ReturnType<Env["ACCOUNTS"]["getByName"]>,
  project: Project,
): Promise<Response> {
  const projectId = project.id;
  const scoped = projectScope(project, url.searchParams.get("environment"), {
    legacyDefault: "required",
  });
  if (!scoped.ok) return scoped.response;
  const environment = scoped.scope.environment;
  const page = parseGitHubRepositoryCursor(url.searchParams.get("cursor"));
  if (page === null) {
    return problem(400, "invalid_cursor", "The cursor was not issued by this listing");
  }
  const requestedLimit = url.searchParams.get("limit");
  const limit =
    requestedLimit === null || requestedLimit === ""
      ? GITHUB_REPOSITORY_PAGE_LIMIT
      : /^[1-9][0-9]{0,2}$/.test(requestedLimit)
        ? Number.parseInt(requestedLimit, 10)
        : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > GITHUB_REPOSITORY_PAGE_LIMIT) {
    return problem(
      400,
      "invalid_limit",
      `limit must be an integer between 1 and ${String(GITHUB_REPOSITORY_PAGE_LIMIT)}`,
    );
  }
  const status = (await account.getGitHubStatus(projectId)).find(
    (candidate: GitHubConnectionStatus) => candidate.environment === environment,
  );
  if (!status || status.state === "not_connected" || status.state === "deleted") {
    return problem(
      404,
      "github_connection_not_found",
      `GitHub is not connected to the ${environment} environment`,
    );
  }
  if (status.state === "suspended") {
    return problem(
      409,
      "installation_suspended",
      "The GitHub installation is suspended",
    );
  }
  const minted = await account.mintGitHubToken({
    projectId,
    environment,
    permissions: { metadata: "read" },
  });
  switch (minted.outcome) {
    case "not_connected":
      return problem(
        404,
        "github_connection_not_found",
        `GitHub is not connected to the ${environment} environment`,
      );
    case "app_not_configured":
      return problem(
        503,
        "github_app_not_configured",
        "The managed OpenComputer GitHub App is not configured",
      );
    case "failed":
      if (minted.code === "installation_not_found") {
        return problem(404, "github_connection_not_found", minted.message);
      }
      if (minted.code === "installation_suspended") {
        return problem(409, "installation_suspended", minted.message);
      }
      return problem(502, "github_unavailable", minted.message);
    case "minted":
      break;
  }
  try {
    return json(
      await listGitHubInstallationRepositories({
        token: minted.token,
        page,
        perPage: limit,
      }),
    );
  } catch (error) {
    if (error instanceof GitHubMintError) {
      return problem(502, "github_unavailable", error.message);
    }
    throw error;
  }
}

/**
 * A provider callback's `state`: the account, so the public callback can name
 * the Durable Object that issued it, and a nonce whose hash that object holds.
 * Shared by the GitHub and Slack callbacks.
 */
function encodeOAuthState(accountId: string, nonce: string): string {
  return `${encodeAccountId(accountId)}.${nonce}`;
}

function decodeOAuthState(
  state: string,
): { accountId: string; nonce: string } | null {
  const separator = state.indexOf(".");
  if (separator <= 0) return null;
  const encoded = state.slice(0, separator);
  const nonce = state.slice(separator + 1);
  if (!/^[a-f0-9]{64}$/.test(nonce)) return null;
  try {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    const accountId = new TextDecoder().decode(bytes);
    return /^[A-Za-z0-9._:-]{1,200}$/.test(accountId)
      ? { accountId, nonce }
      : null;
  } catch {
    return null;
  }
}

/**
 * The environments a GitHub connect request covers. Omitted means every
 * scope the project has; each named one is resolved through the project's
 * mode, so an older CLI's Development on a single-mode project lands on its
 * one scope and Production is refused.
 */
function parseGitHubEnvironments(
  project: Pick<Project, "id" | "environmentMode">,
  value: unknown,
): { ok: true; environments: ProjectEnvironmentName[] } | { ok: false; response: Response } {
  if (value === undefined) {
    return { ok: true, environments: [...canonicalEnvironments(project.environmentMode)] };
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    return {
      ok: false,
      response: problem(
        400,
        "invalid_environment",
        "Expected development, production, or both environments",
      ),
    };
  }
  const environments = new Set<ProjectEnvironmentName>();
  for (const item of value) {
    const scoped = projectScope(project, item, { legacyDefault: "required" });
    if (!scoped.ok) return scoped;
    environments.add(scoped.scope.environment);
  }
  return { ok: true, environments: [...environments] };
}

async function gitHubAuthorizationCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const decoded = decodeOAuthState(url.searchParams.get("state") ?? "");
  if (!decoded) {
    return html(
      renderConnectionCallback({ provider: "GitHub", status: "error" }),
      400,
    );
  }
  const account = env.ACCOUNTS.getByName(decoded.accountId);
  const installationIdValue = url.searchParams.get("installation_id");
  const installationId = installationIdValue
    ? Number.parseInt(installationIdValue, 10)
    : undefined;
  const code = url.searchParams.get("code") ?? "";
  if (
    installationIdValue &&
    (!Number.isSafeInteger(installationId) || installationId! <= 0)
  ) {
    return html(
      renderConnectionCallback({ provider: "GitHub", status: "error" }),
      400,
    );
  }
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(code)) {
    return html(
      renderConnectionCallback({ provider: "GitHub", status: "error" }),
      400,
    );
  }
  const state = await account.consumeGitHubConnectState(
    await sha256(decoded.nonce),
  );
  if (!state) {
    return html(
      renderConnectionCallback({
        provider: "GitHub",
        status: "error",
      }),
      400,
    );
  }
  const installation = await account
    .bindGitHubInstallation({
      githubInstallationId: installationId,
      code,
      projectId: state.projectId,
      environments: state.environments,
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "github.installation_callback_failed",
          accountId: decoded.accountId,
          projectId: state.projectId,
          installationId,
          errorCode:
            error instanceof GitHubMintError ? error.code : "unexpected_error",
          ...(error instanceof GitHubMintError
            ? {}
            : {
                errorName:
                  error instanceof Error ? error.name : typeof error,
                errorMessage:
                  error instanceof Error
                    ? error.message.slice(0, 300)
                    : "Non-Error exception",
              }),
        }),
      );
      return null;
    });
  const appUrl = env.OPENCOMPUTER_APP_URL?.trim();
  return installation
    ? html(
        renderConnectionCallback({
          provider: "GitHub",
          status: "success",
          message:
            "OpenComputer can now reach the repositories you selected in GitHub. You can change that selection in GitHub at any time.",
          ...(appUrl ? gitHubNextStep(appUrl) : {}),
        }),
      )
    : html(
        renderConnectionCallback({
          provider: "GitHub",
          status: "error",
          ...(appUrl ? { dashboardUrl: new URL("/", appUrl).toString() } : {}),
        }),
        502,
      );
}

/**
 * Where the dashboard takes someone who has just connected GitHub: the
 * Computer (the Slack bot) checklist's step after GitHub, the first hand-off
 * in Slack. Project-scoped connects get the same page; the Slack bot
 * experience wins where the two would differ.
 */
function gitHubNextStep(
  appUrl: string,
): Pick<ConnectionCallbackOptions, "nextStep" | "dashboardUrl"> {
  return {
    dashboardUrl: new URL("/", appUrl).toString(),
    nextStep: {
      title: "Hand it your first task",
      description:
        "Mention @OpenComputer in any Slack channel, or DM it. Try: \u201cwhy is the checkout test flaky? Fix it and open a PR.\u201d Not in Slack yet? Your computer page has the one-click invite.",
      label: "Open your computer",
      href: new URL("/computer", appUrl).toString(),
    },
  };
}

async function createSession(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  context?: ExecutionContext,
  latency: Latency = latencyTelemetry(env, "edge"),
): Promise<Response> {
  const resolving = latency.start("session_create.resolved");
  const body = await readJson(request);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (idempotencyKey && idempotencyKey.length > 256) {
    return problem(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key is too long",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const scopedProject = identity.projectId
    ? await account.getProject(identity.projectId)
    : null;
  if (identity.projectId && !scopedProject) {
    return problem(
      403,
      "project_scope_invalid",
      "Project token is no longer valid",
    );
  }
  const memoryBindings = parseMemoryBindings(body?.memory);
  if ("error" in memoryBindings) {
    return problem(400, "invalid_memory_binding", memoryBindings.error);
  }
  const labels = parseLabels(body?.labels);
  if ("error" in labels) {
    return problem(400, "invalid_labels", labels.error);
  }
  let requestedAgent =
    typeof body?.agentId === "string"
      ? body.agentId
      : scopedProject
        ? `${scopedProject.agentId}@development`
        : "local/echo";
  const requestedDeployment =
    typeof body?.deploymentId === "string" ? body.deploymentId : undefined;
  // Both the explicit `environment` and the alias in `agent@alias` are the
  // caller's words; the owning project's mode decides what they mean. A
  // legacy project keeps its contract, including `resolveDeployment` reading
  // production into a bare agent id. A single-mode project has one scope:
  // a bare id, `default`, or an older CLI's `development` all name it, and
  // `production` is refused before anything is admitted.
  let explicitEnvironment: MemoryEnvironment | undefined;
  let aliasEnvironment: MemoryEnvironment | undefined;
  let targetMode: Project["environmentMode"] = "legacy";
  // A deployment pinned by id alone names no agent; the deployment's own
  // agent, and so its project's mode, decides what `environment` means.
  const pinnedDeployment =
    typeof body?.agentId !== "string" &&
    requestedDeployment !== undefined &&
    requestedDeployment !== "development"
      ? await account.getDeployment(requestedDeployment)
      : null;
  if (requestedAgent.startsWith("local/")) {
    const modeProject = pinnedDeployment
      ? ((await account.projectForAgent(pinnedDeployment.agentId)) ?? {
          id: `project:${pinnedDeployment.agentId}`,
          environmentMode: "legacy" as const,
        })
      : { id: requestedAgent, environmentMode: "legacy" as const };
    targetMode = modeProject.environmentMode;
    if (body?.environment !== undefined) {
      const scoped = projectScope(modeProject, body.environment, {
        legacyDefault: "required",
      });
      if (!scoped.ok) return scoped.response;
      explicitEnvironment = scoped.scope.environment;
    }
  } else {
    const separator = requestedAgent.lastIndexOf("@");
    const bareAgentId =
      separator > 0 ? requestedAgent.slice(0, separator) : requestedAgent;
    const rawAlias =
      separator > 0 ? requestedAgent.slice(separator + 1) : undefined;
    const targetProject =
      scopedProject ?? (await account.projectForAgent(bareAgentId));
    const modeProject = targetProject ?? {
      id: `project:${bareAgentId}`,
      environmentMode: "legacy" as const,
    };
    targetMode = modeProject.environmentMode;
    if (body?.environment !== undefined) {
      const scoped = projectScope(modeProject, body.environment, {
        legacyDefault: "required",
      });
      if (!scoped.ok) return scoped.response;
      explicitEnvironment = scoped.scope.environment;
    }
    if (rawAlias !== undefined) {
      if (targetMode === "legacy") {
        // A legacy deployment may live under any alias (`preview`, a ticket
        // id); only the two environment aliases carry a scope.
        if (rawAlias === "development" || rawAlias === "production") {
          aliasEnvironment = rawAlias;
        }
      } else {
        if (isProjectEnvironmentName(rawAlias)) {
          const scoped = projectScope(modeProject, rawAlias, {
            legacyDefault: "required",
          });
          if (!scoped.ok) return scoped.response;
          aliasEnvironment = scoped.scope.environment;
          if (aliasEnvironment !== rawAlias) {
            requestedAgent = `${bareAgentId}@${aliasEnvironment}`;
          }
        } else {
          // A preview names a deployment alias, not a second project scope.
          // Preserve it for deployment resolution while resources continue
          // to come from this project's one canonical environment.
          aliasEnvironment = "default";
        }
      }
    } else if (targetMode === "single") {
      aliasEnvironment = "default";
      requestedAgent = `${bareAgentId}@default`;
    } else {
      aliasEnvironment = "production";
    }
  }
  if (
    explicitEnvironment &&
    aliasEnvironment &&
    explicitEnvironment !== aliasEnvironment
  ) {
    return problem(
      400,
      "invalid_environment",
      `agentId names the ${aliasEnvironment} environment but environment is ${explicitEnvironment}`,
    );
  }
  const source =
    body?.source === "playground" ||
    body?.source === "channel" ||
    body?.source === "webhook"
      ? body.source
      : "api";
  // The caller's immutable intent: the alias it addressed, or the deployment
  // it pinned. A replay under the same key compares this, never what the
  // alias resolves to now, so a promotion between the first admission and a
  // retry does not turn an identical request into a refusal, and the
  // original deployment need not still be active for the replay to answer.
  const intent = creationIntent(requestedAgent, requestedDeployment);
  const platform = env as Env & PlatformEnv;
  const sessionId = idempotencyKey
    ? await idempotentSessionId(identity.accountId, idempotencyKey)
    : crypto.randomUUID();
  const deployment =
    requestedDeployment && requestedDeployment !== "development"
      ? (pinnedDeployment ?? (await account.getDeployment(requestedDeployment)))
      : requestedAgent.startsWith("local/")
        ? null
        : await account.resolveDeployment(requestedAgent);
  // Resolved before the first touch of the session object, which is what
  // places it: a regional deployment's sessions start in its region.
  const session = env.SESSIONS.getByName(
    sessionId,
    regionPlacement(deployment?.region),
  );
  const existing = idempotencyKey ? await session.snapshotOrNull() : null;
  if (existing) {
    return replayCreation({
      account,
      identity,
      scopedProject,
      session,
      sessionId,
      existing,
      intent,
      requestedEnvironment: explicitEnvironment ?? aliasEnvironment,
      memoryBindings: memoryBindings.bindings,
      platform,
    });
  }
  if (
    scopedProject &&
    (requestedAgent.startsWith("local/") ||
      !projectOwnsAgent(
        scopedProject,
        deployment?.agentId ?? requestedAgent.split("@")[0]!,
      ))
  ) {
    return problem(
      403,
      "project_scope_violation",
      "Token is scoped to another project",
    );
  }
  if (!requestedAgent.startsWith("local/") && !deployment) {
    return problem(
      404,
      "deployment_not_found",
      `No deployed agent matches ${requestedDeployment ?? requestedAgent}`,
    );
  }
  if (
    deployment &&
    !platform.RUNTIMES &&
    platform.BLUE_ENVIRONMENT !== "development"
  ) {
    return problem(
      503,
      "runtime_service_unavailable",
      "The managed-agent runtime service is not configured",
    );
  }
  const agentId = deployment?.agentId ?? requestedAgent;
  const deploymentId = deployment?.id ?? requestedDeployment ?? "development";
  const owningProject =
    scopedProject ?? (await account.projectForAgent(agentId));
  if (owningProject) {
    const archived = projectArchived(owningProject);
    if (archived) return archived;
  }
  const projectId =
    owningProject?.id ??
    `project:${agentId}`;
  const accountId = identity.accountId;
  // The session's environment is the request's, never the deployment
  // row's: one artifact promoted to both environments keeps the alias it
  // was first registered with. A pinned deployment without a named
  // environment takes the one environment it is currently promoted to.
  const pinned = Boolean(deployment && requestedDeployment && requestedDeployment !== "development");
  const promotedTo = async (environment: MemoryEnvironment): Promise<boolean> =>
    Boolean(deployment) &&
    (await account.resolveDeployment(`${deployment!.agentId}@${environment}`))?.id === deployment!.id;
  let environment: MemoryEnvironment | undefined = explicitEnvironment ?? aliasEnvironment;
  if (!environment && pinned) {
    const active: MemoryEnvironment[] = [];
    for (const candidate of canonicalEnvironments(targetMode)) {
      if (await promotedTo(candidate)) active.push(candidate);
    }
    if (active.length === 1) environment = active[0];
  }
  let memoryObject: string | undefined;
  if (memoryBindings.bindings.length) {
    if (!deployment || !environment) {
      return problem(
        400,
        "invalid_memory_binding",
        "Memory bindings need a deployed agent and an environment: name it as agent@environment or with environment next to deploymentId",
      );
    }
    if (!platform.MEMORY) {
      return problem(503, "memory_unavailable", "Project memory is not configured");
    }
    if (projectId.startsWith("project:")) {
      return problem(400, "invalid_memory_binding", "Memory bindings need an agent that belongs to a project");
    }
    memoryObject = memoryObjectName(accountId, projectId, environment);
  }
  if (memoryObject && deployment && pinned && !(await promotedTo(environment!))) {
    // Eligibility for a new session only: a pinned deployment binds the
    // memory of an environment it is currently promoted to.
    return problem(
      409,
      "deployment_not_promoted",
      `Deployment ${deployment.id} is not promoted to the ${environment} environment`,
    );
  }
  if (memoryObject && deployment) {
    // A new admission: the declarations gate the resources and the Memory
    // DO's current documents gate document bindings, before any session
    // exists. `issueGrants` re-checks atomically at admission.
    const invalid = await validateMemoryBindings(
      memoryBindings.bindings,
      deployment.memory ?? [],
      platform.MEMORY!.getByName(memoryObject),
    );
    if (invalid) return problem(400, "invalid_memory_binding", invalid);
  }
  let workerdLease: WorkerdSessionLease | null = null;
  let workerdPoolCheckoutMs = 0;
  const runtimeProfile = await accountManagedRuntimeProfile(
    platform,
    account,
    accountId,
  );
  const runtimeDeployment = deployment
    ? runtimeDeploymentForProfile(platform, deployment, runtimeProfile)
    : undefined;
  // A deployed agent's session runs on the Workerd runtime unless its
  // account is in the sandbox runtime gate, whatever runtime mode its
  // deployment was stored with; a session without a deployment starts no
  // runtime.
  const useWorkerd =
    deployment !== undefined && sessionRunsOnWorkerd(platform, accountId);
  latency.base.session_key = sessionId;
  resolving.end();
  if (
    deployment &&
    platform.POOLS &&
    useWorkerd
  ) {
    const checkoutStartedAt = performance.now();
    workerdLease = await latency.time(
      "session_create.pool_claimed",
      async () =>
        await deploymentPool(platform, accountId, deployment).claimWorkerd(
          sessionId,
          workerdModelConfiguration(deployment),
        ),
      (lease) => ({ leased: lease !== null }),
    );
    workerdPoolCheckoutMs =
      Math.round((performance.now() - checkoutStartedAt) * 100) / 100;
  }
  let outcome: InitializeSessionOutcome;
  try {
    outcome = await latency.time(
      "session_create.initialized",
      async () =>
        await session.initialize({
          id: sessionId,
          accountId,
          userId: identity.userId,
          agentId,
          deploymentId,
          creation: intent,
          executionMode: useWorkerd ? "workerd" : "microvm",
          ...(runtimeDeployment ? { deployment: runtimeDeployment } : {}),
          runtimeEdge: new URL(request.url).origin,
          ...(workerdLease ? { workerdLease } : {}),
          ...(deployment && useWorkerd
            ? { workerdPoolCheckoutMs }
            : {}),
          ...(environment ? { environment } : {}),
          ...(memoryObject
            ? { memory: memoryBindings.bindings, memoryObject }
            : {}),
          projectId,
          source,
          labels: labels.labels,
        }),
      (result) => ({ outcome: result.outcome }),
    );
  } catch (error) {
    if (workerdLease && deployment) {
      await returnWorkerdLease(platform, accountId, deployment, workerdLease);
    }
    throw error;
  }
  if (outcome.outcome === "existing") {
    // Requests under one key reached the Session object together and it
    // admitted exactly one; this one lost, before any side effect of its
    // own. The lease it claimed goes back to the pool, and it converges on
    // the admitted session as a replay, compared by intent like any retry,
    // so every caller holds the same session and the same deployment
    // whatever each of them resolved.
    if (workerdLease && deployment) {
      await returnWorkerdLease(platform, accountId, deployment, workerdLease);
    }
    if (!idempotencyKey) {
      throw new Error(`Session ${sessionId} already exists`);
    }
    return replayCreation({
      account,
      identity,
      scopedProject,
      session,
      sessionId,
      existing: outcome.session,
      intent,
      requestedEnvironment: explicitEnvironment ?? aliasEnvironment,
      memoryBindings: memoryBindings.bindings,
      platform,
    });
  }
  const initialized: InitializeSessionResult = outcome;
  if (initialized.unusedWorkerdLease && workerdLease && deployment) {
    await returnWorkerdLease(platform, accountId, deployment, workerdLease);
    workerdLease = null;
  }
  if (initialized.memoryAdmission?.state === "rejected") {
    // The Memory DO is the authority: it refused the grants (a document
    // vanished between the pre-check and admission, or the session id was
    // already closed). The session cannot be used; end it.
    await session.end().catch(() => undefined);
    return memoryAdmissionResponse(initialized.memoryAdmission)!;
  }

  if (
    deployment &&
    platform.POOLS &&
    platform.WORKERD_RUNTIME &&
    useWorkerd
  ) {
    const refill = refillWorkerdPool(
      platform,
      accountId,
      deployment,
      new URL(request.url).origin,
    );
    if (context) context.waitUntil(refill);
    else await refill;
  }

  // The first row is published before the response: a list read after the
  // 201 contains the session, so 201 is answered only once the projection
  // has acknowledged this session's revision. The Session object keeps its
  // pending publication as the durable fallback, and a failure here is a
  // retryable answer carrying the session's identity, never a success a
  // list read would contradict.
  const published = await latency.time(
    "session_create.published",
    () => publishSessionRow(session, sessionId),
    (ok) => ({ published: ok }),
  );
  if (!published) {
    return publicationUnconfirmed(sessionId);
  }

  const unconfirmed = memoryAdmissionResponse(initialized.memoryAdmission);
  if (unconfirmed) return unconfirmed;
  // A microvm session's runtime starts with the session, as clients expect
  // (the dashboard waits for `runtime.connected` before its first turn). The
  // start is claimed once, so the turn-submit start is a no-op after this.
  if (deployment && !useWorkerd && doFirstSessionSpike(env)) {
    const start = startDoFirstSessionRuntime(
      env,
      accountId,
      session,
      new URL(request.url).origin,
    );
    if (context) context.waitUntil(start);
    else await start;
  }
  return json({ ...initialized, deployment: deployment ?? undefined }, 201);
}

/** `agent@environment` as the caller meant it: a bare id addresses production; a local agent is itself. */
function canonicalAgentReference(reference: string): string {
  if (reference.startsWith("local/") || reference.includes("@")) return reference;
  return `${reference}@production`;
}

/**
 * A prewarmed lease that will not be used: its request lost the admission.
 * Returned to the pool it came from; a failure to return it is logged and
 * never fails the request. A return that never commits leaves the
 * capability bound, which the standby sweep does not cover; recovering
 * such an orphan is separate work.
 */
async function returnWorkerdLease(
  env: Env & PlatformEnv,
  accountId: string,
  deployment: AgentDeployment,
  lease: WorkerdSessionLease,
): Promise<void> {
  try {
    const returned = await deploymentPool(env, accountId, deployment).releaseWorkerd(
      lease,
      workerdModelConfiguration(deployment),
    );
    if (!returned) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "workerd_deployment_pool.lease_expired",
          deploymentId: deployment.id,
          runtimeSessionId: lease.runtimeSessionId,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "workerd_deployment_pool.release_failed",
        deploymentId: deployment.id,
        runtimeSessionId: lease.runtimeSessionId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** The immutable half of a creation's identity: the alias addressed, or the deployment pinned. */
function creationIntent(
  requestedAgent: string,
  requestedDeployment: string | undefined,
): SessionCreation {
  return requestedDeployment && requestedDeployment !== "development"
    ? { deploymentId: requestedDeployment }
    : { agent: canonicalAgentReference(requestedAgent) };
}

/**
 * A create under an `Idempotency-Key` whose session already exists. The
 * caller's intent is compared with what the session recorded at its first
 * admission, and the session's own deployment is answered, whatever the
 * alias resolves to now. Authorization is checked afresh; a pinned intent
 * matches when it names the deployment the session holds; a session created
 * before intent was recorded keeps the earlier rule, under which the alias
 * must still resolve to the deployment it pinned.
 */
async function replayCreation(input: {
  account: ReturnType<Env["ACCOUNTS"]["getByName"]>;
  identity: RequestIdentity;
  scopedProject: Project | null;
  session: DurableObjectStub<SessionDurableObject>;
  sessionId: string;
  existing: SessionSnapshot;
  intent: SessionCreation;
  requestedEnvironment: MemoryEnvironment | undefined;
  memoryBindings: MemoryBinding[];
  platform: Env & PlatformEnv;
}): Promise<Response> {
  const { existing, intent } = input;
  if (input.scopedProject && !projectOwnsAgent(input.scopedProject, existing.agentId)) {
    return problem(403, "project_scope_violation", "Token is scoped to another project");
  }
  const conflict = (message: string) => problem(409, "idempotency_conflict", message);
  if (existing.accountId !== input.identity.accountId || existing.userId !== input.identity.userId) {
    return conflict("Idempotency-Key was already used with different session input");
  }
  let sameTarget: boolean;
  if (intent.deploymentId) {
    sameTarget = intent.deploymentId === existing.deploymentId;
  } else if (existing.creation?.agent !== undefined) {
    sameTarget = existing.creation.agent === intent.agent;
  } else if (intent.agent!.startsWith("local/")) {
    sameTarget = existing.agentId === intent.agent;
  } else {
    const resolved = await input.account.resolveDeployment(intent.agent!);
    sameTarget = resolved?.id === existing.deploymentId;
  }
  if (!sameTarget) {
    return conflict("Idempotency-Key was already used with different session input");
  }
  const environment = input.requestedEnvironment ?? (intent.deploymentId ? existing.environment : undefined);
  if (existing.environment !== undefined && existing.environment !== environment) {
    return conflict(`Idempotency-Key was already used in the ${existing.environment} environment`);
  }
  let memoryObject: string | undefined;
  if (input.memoryBindings.length) {
    if (!environment) {
      return problem(
        400,
        "invalid_memory_binding",
        "Memory bindings need a deployed agent and an environment: name it as agent@environment or with environment next to deploymentId",
      );
    }
    if (!input.platform.MEMORY) {
      return problem(503, "memory_unavailable", "Project memory is not configured");
    }
    if (existing.projectId.startsWith("project:")) {
      return problem(400, "invalid_memory_binding", "Memory bindings need an agent that belongs to a project");
    }
    memoryObject = memoryObjectName(existing.accountId, existing.projectId, environment);
  }
  if (existing.memoryObject !== memoryObject) {
    return conflict("Idempotency-Key was already used with different session input");
  }
  if (!sameMemoryBindings(existing.memory ?? [], input.memoryBindings)) {
    return conflict("Idempotency-Key was already used with different memory bindings");
  }
  // A replay while the grants are still unconfirmed resumes the RPC
  // instead of returning the session early.
  const admission =
    existing.memoryAdmission?.state === "pending"
      ? await input.session.resumeMemoryAdmission()
      : existing.memoryAdmission;
  const refused = memoryAdmissionResponse(admission);
  if (refused) return refused;
  // The first attempt may have died between initializing the session and
  // publishing its row, or answered 503 because the projection did not
  // acknowledge it; the replay publishes again (the projection keeps the
  // newer revision, so this is idempotent) and answers success only once
  // held. Labels in the replay body are ignored: creation identity is the
  // immutable metadata.
  if (!(await publishSessionRow(input.session, input.sessionId))) {
    return publicationUnconfirmed(input.sessionId);
  }
  const deployment = (await input.account.getDeployment(existing.deploymentId)) ?? undefined;
  return json({ session: await input.session.snapshot(), deployment }, 200);
}

/**
 * The synchronous publication of a create request. True when the
 * projection acknowledged the session at its current revision; false when
 * it could not be reached or holds an older one, in which case the alarm
 * keeps delivering and the caller must not report success.
 */
async function publishSessionRow(
  session: DurableObjectStub<SessionDurableObject>,
  sessionId: string,
): Promise<boolean> {
  try {
    const outcome = await session.publishSummary();
    if (outcome.acknowledged) return true;
    console.error(
      JSON.stringify({
        level: "error",
        event: "session.publication_unconfirmed",
        sessionId,
        revision: outcome.revision,
        held: outcome.held,
      }),
    );
    return false;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "session.publication_deferred",
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/**
 * The retryable answer when a session's row is committed but not yet in
 * the list (C1): the identity is stable, the alarm delivers in the
 * background, and a replay of the create under the same Idempotency-Key,
 * or of the label patch, publishes again and answers success once held.
 */
function publicationUnconfirmed(sessionId: string): Response {
  return problem(
    503,
    "session_publication_unconfirmed",
    "The session is recorded but its list row is not confirmed yet; retry the request with the same Idempotency-Key",
    { sessionId },
  );
}

/**
 * The response a memory admission state forces, or null when the session is
 * usable. Pending is answered honestly: the grants were not confirmed, the
 * session alarm keeps trying, and a replay with the same Idempotency-Key
 * resumes the wait instead of returning early.
 */
function memoryAdmissionResponse(
  admission: MemoryAdmissionState | undefined,
): Response | null {
  if (!admission || admission.state === "issued") return null;
  if (admission.state === "pending") {
    return problem(
      503,
      "memory_admission_unconfirmed",
      "Memory grants could not be confirmed; retry the request with the same Idempotency-Key",
    );
  }
  const where = admission.resource
    ? ` (${admission.resource}${admission.id ? `/${admission.id}` : ""})`
    : "";
  return problem(
    400,
    "invalid_memory_binding",
    admission.reason === "not_found"
      ? `Memory document not found${where}`
      : admission.reason === "undeclared"
        ? `Memory resource is not declared for this environment${where}`
        : `Memory bindings were refused: ${admission.reason}`,
  );
}

async function startDoFirstSessionRuntime(
  env: Env,
  accountId: string,
  session: DurableObjectStub<SessionDurableObject>,
  edge: string,
): Promise<void> {
  const platform = env as Env & PlatformEnv;
  await startSandboxSessionRuntime(platform, {
    accountId,
    session,
    edge,
    async configuration(snapshot) {
      const account = env.ACCOUNTS.getByName(accountId);
      const deployment = await account.getDeployment(snapshot.deploymentId);
      if (!deployment) {
        throw new Error("The pinned deployment configuration is unavailable");
      }
      const runtimeProfile = await accountManagedRuntimeProfile(
        platform,
        account,
        accountId,
      );
      const projectId =
        (await account.listProjects()).find((project: Project) =>
          projectOwnsAgent(project, deployment.agentId),
        )?.id ?? `project:${deployment.agentId}`;
      return {
        projectId,
        deployment: runtimeDeploymentForProfile(platform, deployment, runtimeProfile),
      };
    },
  });
}

async function idempotentSessionId(
  accountId: string,
  idempotencyKey: string,
): Promise<string> {
  const digest = await sha256Hex(
    JSON.stringify(["session", accountId, idempotencyKey]),
  );
  return (
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-` +
    `${digest.slice(16, 20)}-${digest.slice(20, 32)}`
  );
}

function workerdPrewarmTarget(env: PlatformEnv): number {
  const configured = Number(env.WORKERD_PREWARM_TARGET ?? 3);
  return Number.isInteger(configured)
    ? Math.max(0, Math.min(20, configured))
    : 3;
}

async function refillWorkerdPool(
  env: Env & PlatformEnv,
  accountId: string,
  deployment: AgentDeployment,
  edgeOrigin: string,
): Promise<void> {
  if (!env.POOLS || !env.WORKERD_RUNTIME) return;
  const pool = deploymentPool(env, accountId, deployment);
  const slots = await pool.beginWorkerdFill(
    workerdPrewarmTarget(env),
    workerdModelConfiguration(deployment),
  );
  await Promise.all(
    slots.map(async (slot) => {
      try {
        const capability =
          await pool.createWorkerdModelGatewayCapability(slot);
        const response = await env.WORKERD_RUNTIME!.fetch(
          "https://workerd-runtime.invalid/sessions",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...regionHeaders(deployment.region),
            },
            body: JSON.stringify({
              deployment,
              modelGateway: {
                baseURL:
                  `${edgeOrigin.replace(/\/$/, "")}/v1/model-gateway-capabilities/` +
                  `${encodeURIComponent(accountId)}/${encodeURIComponent(deployment.id)}/` +
                  `${encodeURIComponent(deployment.imageVersion)}/${encodeURIComponent(capability.id)}/api/v1`,
                token: capability.token,
              },
            }),
          },
        );
        const body = (await response.json()) as { id?: unknown };
        const runtimeSessionId = response.headers.get("x-opencomputer-session");
        if (!response.ok || !runtimeSessionId || typeof body.id !== "string") {
          throw new Error(`Workerd pool fill returned ${response.status}`);
        }
        const activation = Number(
          response.headers.get("x-opencomputer-runtime-activation") ?? 0,
        );
        const initializationMs = Number(
          response.headers.get("x-opencomputer-runtime-init-ms") ?? 0,
        );
        const lease: WorkerdSessionLease = {
          runtimeSessionId,
          opencodeSessionId: body.id,
          modelGatewayCapabilityId: capability.id,
          runtimeBootId:
            response.headers.get("x-opencomputer-runtime-boot") ?? "",
          runtimeActivation: Number.isFinite(activation) ? activation : 0,
          runtimeInitMs: Number.isFinite(initializationMs) ? initializationMs : 0,
          createdAt: new Date().toISOString(),
        };
        if (!(await pool.completeWorkerdFill(slot, lease))) {
          throw new Error("Workerd pool slot was no longer claimable");
        }
        console.log(
          JSON.stringify({
            level: "info",
            event: "workerd_deployment_pool.ready",
            accountId,
            deploymentId: deployment.id,
            runtimeSessionId,
          }),
        );
      } catch (error) {
        await pool.failWorkerdFill(slot);
        console.error(
          JSON.stringify({
            level: "error",
            event: "workerd_deployment_pool.fill_failed",
            accountId,
            deploymentId: deployment.id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }),
  );
}

async function benchmarkWarmRuntime(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const platform = env as Env & PlatformEnv;
  if ((platform.BLUE_ENVIRONMENT as string) !== "mo-dev") {
    return problem(404, "not_found", "Route not found");
  }
  if (!platform.RUNTIMES) {
    return problem(503, "runtime_service_unavailable", "Runtime unavailable");
  }
  const input = await readJson(request);
  const agentId = typeof input?.agentId === "string" ? input.agentId : "";
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const deployment = agentId ? await account.resolveDeployment(agentId) : null;
  if (!deployment) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }
  const runtimeProfile = await accountManagedRuntimeProfile(
    platform,
    account,
    identity.accountId,
  );
  const runtimeDeployment = runtimeDeploymentForProfile(
    platform,
    deployment,
    runtimeProfile,
  );
  const coldSessionId = crypto.randomUUID();
  const coldSession = env.SESSIONS.getByName(coldSessionId);
  const coldInitialized = await coldSession.initialize({
    id: coldSessionId,
    accountId: identity.accountId,
    userId: identity.userId,
    agentId: deployment.agentId,
    deploymentId: deployment.id,
  });
  const coldStartedAt = Date.now();
  const coldResponse = await platform.RUNTIMES.fetch(
    "https://blue-runtime/v1/sessions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: identity.accountId,
        sessionId: coldSessionId,
        runtimeToken: coldInitialized.runtimeToken,
        projectId: `project:${deployment.agentId}`,
        edge: new URL(request.url).origin,
        deployment: runtimeDeployment,
      }),
    },
  );
  if (!coldResponse.ok) {
    await coldSession.end();
    return problem(502, "cold_start_failed", "Could not start cold runtime");
  }
  const cold = (await coldResponse.json()) as { microvmId?: unknown };
  if (typeof cold.microvmId !== "string") {
    await coldSession.end();
    return problem(502, "cold_start_failed", "Cold runtime was invalid");
  }
  const coldStartMs = Date.now() - coldStartedAt;
  await coldSession.bindMicrovm({
    microvmId: cold.microvmId,
    state: "running",
  });
  const coldReadyDeadline = Date.now() + 60_000;
  while ((await coldSession.snapshot()).status !== "idle") {
    if (Date.now() >= coldReadyDeadline) {
      await changeRuntimeState(env, identity, coldSession, "terminate");
      await coldSession.end();
      return problem(504, "cold_start_timeout", "Cold runtime did not connect");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const coldReadyMs = Date.now() - coldStartedAt;
  await changeRuntimeState(env, identity, coldSession, "terminate");
  await coldSession.end();

  const warmResponse = await platform.RUNTIMES.fetch(
    "https://blue-runtime/v1/warm-runtimes",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deployment: runtimeDeployment,
      }),
    },
  );
  if (!warmResponse.ok) {
    return problem(502, "warm_pool_failed", "Could not fill the warm pool");
  }
  const warm = (await warmResponse.json()) as {
    microvmId?: unknown;
    endpoint?: unknown;
    claimToken?: unknown;
    poolFillMs?: unknown;
  };
  if (
    typeof warm.microvmId !== "string" ||
    typeof warm.endpoint !== "string" ||
    typeof warm.claimToken !== "string"
  ) {
    return problem(502, "warm_pool_failed", "Warm runtime was invalid");
  }

  const sessionId = crypto.randomUUID();
  const session = env.SESSIONS.getByName(sessionId);
  const initialized = await session.initialize({
    id: sessionId,
    accountId: identity.accountId,
    userId: identity.userId,
    agentId: deployment.agentId,
    deploymentId: deployment.id,
  });
  if (initialized.outcome !== "created") {
    throw new Error(`Session ${sessionId} already exists`);
  }
  const claimResponse = await platform.RUNTIMES.fetch(
    "https://blue-runtime/v1/warm-runtimes/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: identity.accountId,
        projectId: `project:${deployment.agentId}`,
        sessionId,
        runtimeToken: initialized.runtimeToken,
        edge: new URL(request.url).origin,
        deployment: runtimeDeployment,
        microvmId: warm.microvmId,
        endpoint: warm.endpoint,
        claimToken: warm.claimToken,
      }),
    },
  );
  if (!claimResponse.ok) {
    await session.end();
    await platform.RUNTIMES.fetch(
      `https://blue-runtime/v1/sessions/${encodeURIComponent(sessionId)}/terminate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: identity.accountId,
          microvmId: warm.microvmId,
        }),
      },
    ).catch(() => undefined);
    return problem(502, "warm_claim_failed", "Could not claim warm runtime");
  }
  const claimed = (await claimResponse.json()) as { claimMs?: unknown };
  await session.bindMicrovm({ microvmId: warm.microvmId, state: "running" });

  const suspendStartedAt = Date.now();
  const suspended = await changeRuntimeState(env, identity, session, "suspend");
  const suspendMs = Date.now() - suspendStartedAt;
  if (!suspended.ok) return suspended;
  const resumeStartedAt = Date.now();
  const resumed = await changeRuntimeState(env, identity, session, "resume");
  const resumeMs = Date.now() - resumeStartedAt;
  if (!resumed.ok) return resumed;
  await changeRuntimeState(env, identity, session, "terminate");
  await session.end();

  return json({
    imageVersion: runtimeDeployment.imageVersion,
    coldStartMs,
    coldReadyMs,
    poolFillMs: warm.poolFillMs,
    claimMs: claimed.claimMs,
    suspendMs,
    resumeMs,
  });
}

function parseDeploymentInput(
  body: Record<string, unknown> | null,
  env: Env & PlatformEnv,
  accountId: string,
): RegisterDeploymentInput | null {
  const artifact =
    body?.artifact && typeof body.artifact === "object"
      ? (body.artifact as Record<string, unknown>)
      : null;
  if (
    typeof body?.agentId !== "string" ||
    typeof body.alias !== "string" ||
    typeof artifact?.bucket !== "string" ||
    typeof artifact.key !== "string" ||
    typeof artifact.digest !== "string" ||
    typeof artifact.size !== "number"
  ) {
    return null;
  }
  const imageArn =
    typeof body.imageArn === "string"
      ? body.imageArn
      : env.BLUE_RUNTIME_IMAGE_ARN;
  const imageVersion =
    typeof body.imageVersion === "string"
      ? body.imageVersion
      : env.BLUE_RUNTIME_IMAGE_VERSION;
  if (!imageArn || !imageVersion) return null;
  const httpConnections = parseHttpConnections(body.httpConnections);
  if (httpConnections === null) return null;
  const githubConnections = parseGitHubConnections(body.githubConnections);
  if (githubConnections === null) return null;
  if (
    githubConnections.some((github) =>
      httpConnections.some((http) => http.id === github.id),
    )
  ) {
    return null;
  }
  const connections = Array.isArray(body.connections)
    ? body.connections.filter(
        (connection): connection is string => typeof connection === "string",
      )
    : [];
  if (
    githubConnections.some((connection) => !connections.includes(connection.id))
  ) {
    return null;
  }
  const projectDeployment = parseProjectDeployment(body.projectDeployment);
  if (projectDeployment === null) return null;
  const memory = parseMemoryDeclarations(body.memory);
  if (memory === null) return null;
  const models = parseModelSelections(body.models);
  if (models === null) return null;
  const region = parseDeploymentRegion(body.region);
  if (region === null) return null;
  const egress = parseDeploymentEgress(body.egress);
  if (egress === null) return null;
  const fixedIps = parseFixedIps(body.fixedIps);
  if (fixedIps === null) return null;
  return {
    agentId: body.agentId,
    accountId,
    ...(region ? { region } : {}),
    ...(egress ? { egress } : {}),
    ...(fixedIps ? { fixedIps } : {}),
    ...(memory.length ? { memory } : {}),
    ...(models ? { models } : {}),
    name:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : undefined,
    alias: body.alias,
    runtimeMode: "workerd-lazy-sandbox",
    channels: Array.isArray(body.channels)
      ? body.channels.filter(
          (channel): channel is string => typeof channel === "string",
        )
      : [],
    connections,
    httpConnections,
    githubConnections,
    ...(projectDeployment ? { projectDeployment } : {}),
    imageArn,
    imageVersion,
    artifact: {
      bucket: artifact.bucket,
      key: artifact.key,
      digest: artifact.digest,
      size: artifact.size,
    },
  };
}

const CHANNEL_PROVIDERS = new Set(["slack", "twilio", "email"]);
const CHANNEL_EVENTS = new Set(["app_mention", "message.im", "message.inbound"]);

function parseProjectDeployment(
  value: unknown,
): ProjectDeploymentReference | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.resources)) return null;
  const resources = value.resources;
  if (
    typeof value.id !== "string" ||
    value.id.length > 256 ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.localAgentId !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.localAgentId) ||
    resources.version !== 1 ||
    !Array.isArray(value.agents) ||
    !value.agents.every(
      (agent) =>
        isRecord(agent) &&
        typeof agent.localId === "string" &&
        typeof agent.agentId === "string" &&
        typeof agent.artifactDigest === "string" &&
        /^[a-f0-9]{64}$/.test(agent.artifactDigest),
    ) ||
    !Array.isArray(resources.channels) ||
    !Array.isArray(resources.channelRegistrations) ||
    !Array.isArray(resources.outboxes) ||
    !Array.isArray(resources.outboxRegistrations) ||
    (resources.schedules !== undefined && !Array.isArray(resources.schedules)) ||
    // Older CLIs do not send this at all, so absent is fine and malformed is
    // not. A deployment rejected here fails with nothing to go on, which is
    // how the Twilio channel rollout lost an afternoon.
    (resources.gatedTools !== undefined &&
      (!Array.isArray(resources.gatedTools) ||
        resources.gatedTools.length > 256 ||
        !resources.gatedTools.every(
          (tool) =>
            isRecord(tool) &&
            typeof tool.agentId === "string" &&
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool.agentId) &&
            typeof tool.toolId === "string" &&
            /^[a-zA-Z0-9_-]{1,128}$/.test(tool.toolId),
        ))) ||
    (resources.database !== undefined &&
      (!isRecord(resources.database) ||
        !Array.isArray(resources.database.migrations) ||
        resources.database.migrations.length > 100 ||
        !resources.database.migrations.every(
          (migration) =>
            isRecord(migration) &&
            typeof migration.name === "string" &&
            /^\d{3,}_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?\.sql$/.test(migration.name) &&
            typeof migration.checksum === "string" &&
            /^[a-f0-9]{64}$/.test(migration.checksum) &&
            typeof migration.sql === "string" &&
            migration.sql.length > 0,
        ))) ||
    JSON.stringify(value).length > 1280 * 1024
  ) {
    return null;
  }
  const ids = new Set<string>();
  for (const channel of resources.channels) {
    if (
      !isRecord(channel) ||
      typeof channel.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(channel.id) ||
      ids.has(channel.id) ||
      typeof channel.type !== "string" ||
      !CHANNEL_PROVIDERS.has(channel.type) ||
      !Array.isArray(channel.events) ||
      !channel.events.every(
        (event) => typeof event === "string" && CHANNEL_EVENTS.has(event),
      ) ||
      !isRecord(channel.destinations)
    ) {
      return null;
    }
    // Slack is the only provider carrying OAuth scopes; the others authenticate
    // with a stored credential and have none to declare.
    if (
      channel.type === "slack" &&
      (!isRecord(channel.scopes) ||
        !Array.isArray(channel.scopes.bot) ||
        !channel.scopes.bot.every((scope) => typeof scope === "string"))
    ) {
      return null;
    }
    ids.add(channel.id);
  }
  const outboxIds = new Set<string>();
  for (const outbox of resources.outboxes) {
    if (
      !isRecord(outbox) ||
      typeof outbox.id !== "string" ||
      outboxIds.has(outbox.id) ||
      typeof outbox.channelId !== "string" ||
      !ids.has(outbox.channelId) ||
      typeof outbox.destination !== "string"
    ) {
      return null;
    }
    const channel = resources.channels.find(
      (candidate) => isRecord(candidate) && candidate.id === outbox.channelId,
    );
    if (!channel || !isRecord(channel.destinations[outbox.destination])) {
      return null;
    }
    outboxIds.add(outbox.id);
  }
  const scheduleKeys = new Set<string>();
  const schedules = resources.schedules ?? [];
  if (schedules.length > 100) return null;
  for (const schedule of schedules) {
    if (
      !isRecord(schedule) ||
      typeof schedule.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(schedule.id) ||
      typeof schedule.agentId !== "string" ||
      !value.agents.some(
        (agent) => isRecord(agent) && agent.localId === schedule.agentId,
      ) ||
      scheduleKeys.has(`${schedule.agentId}:${schedule.id}`) ||
      typeof schedule.cron !== "string" ||
      schedule.cron.trim().split(/\s+/).length !== 5 ||
      typeof schedule.timezone !== "string" ||
      !Array.isArray(schedule.enabled) ||
      !schedule.enabled.length ||
      !schedule.enabled.every(isProjectEnvironmentName) ||
      (schedule.overlap !== "skip" && schedule.overlap !== "allow") ||
      !isRecord(schedule.dispatch) ||
      (typeof schedule.dispatch.text !== "string" &&
        schedule.dispatch.payload === undefined) ||
      JSON.stringify(schedule.dispatch).length > 32 * 1024
    ) {
      return null;
    }
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: schedule.timezone,
      }).format();
      new Cron(schedule.cron, {
        timezone: schedule.timezone,
        paused: true,
      });
    } catch {
      return null;
    }
    scheduleKeys.add(`${schedule.agentId}:${schedule.id}`);
  }
  return {
    ...(value as unknown as ProjectDeploymentReference),
    resources: {
      ...(resources as unknown as ProjectDeploymentReference["resources"]),
      schedules: schedules as ProjectDeploymentReference["resources"]["schedules"],
    },
  };
}

function parseHttpConnections(value: unknown): HttpConnectionDefinition[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const definitions: HttpConnectionDefinition[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const input = item as Record<string, unknown>;
    if (
      typeof input.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id) ||
      ids.has(input.id) ||
      typeof input.origin !== "string"
    ) {
      return null;
    }
    let origin: URL;
    try {
      origin = new URL(input.origin);
    } catch {
      return null;
    }
    if (origin.protocol !== "https:" || origin.origin !== input.origin) {
      return null;
    }
    if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) {
      return null;
    }
    const headers: HttpConnectionDefinition["headers"] = {};
    const headerEntries = Object.entries(input.headers);
    if (headerEntries.length > 64) return null;
    for (const [name, value] of headerEntries) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
      if (typeof value === "string") {
        if (SECRET_ONLY_HEADERS.has(name.toLowerCase())) return null;
        if (value.length > 16_384) return null;
        headers[name] = value;
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const reference = value as Record<string, unknown>;
      if (
        reference.kind !== "secret" ||
        typeof reference.name !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference.name) ||
        // An unrecognised scope is refused rather than ignored: treating it as
        // project-wide would silently widen a credential the author meant to
        // confine to one installation.
        (reference.scope !== undefined &&
          reference.scope !== "tenant" &&
          reference.scope !== "user" &&
          reference.scope !== "project") ||
        (reference.prefix !== undefined && typeof reference.prefix !== "string") ||
        (reference.suffix !== undefined && typeof reference.suffix !== "string") ||
        (typeof reference.prefix === "string" && reference.prefix.length > 1_024) ||
        (typeof reference.suffix === "string" && reference.suffix.length > 1_024)
      ) {
        return null;
      }
      headers[name] = {
        kind: "secret",
        name: reference.name,
        ...(reference.scope === "tenant" || reference.scope === "user"
          ? { scope: reference.scope }
          : {}),
        ...(typeof reference.prefix === "string" ? { prefix: reference.prefix } : {}),
        ...(typeof reference.suffix === "string" ? { suffix: reference.suffix } : {}),
      };
    }
    const methods = input.methods === undefined
      ? undefined
      : Array.isArray(input.methods) && input.methods.every(
          (method): method is string =>
            typeof method === "string" && /^[A-Z]+$/.test(method),
        )
        ? [...new Set(input.methods)]
        : null;
    if (methods === null) return null;
    if (
      input.pathPrefix !== undefined &&
      (typeof input.pathPrefix !== "string" || !input.pathPrefix.startsWith("/"))
    ) {
      return null;
    }
    const redirectOrigins: NonNullable<
      HttpConnectionDefinition["redirectOrigins"]
    > = [];
    if (input.redirectOrigins !== undefined) {
      if (!Array.isArray(input.redirectOrigins) || input.redirectOrigins.length > 16) {
        return null;
      }
      const origins = new Set<string>();
      for (const item of input.redirectOrigins) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const redirect = item as Record<string, unknown>;
        if (typeof redirect.origin !== "string") return null;
        let redirectOrigin: URL;
        try {
          redirectOrigin = new URL(redirect.origin);
        } catch {
          return null;
        }
        if (
          redirectOrigin.protocol !== "https:" ||
          redirectOrigin.origin !== redirect.origin ||
          (redirect.pathPrefix !== undefined &&
            (typeof redirect.pathPrefix !== "string" ||
              !redirect.pathPrefix.startsWith("/")))
        ) {
          return null;
        }
        const pathPrefix =
          typeof redirect.pathPrefix === "string"
            ? redirect.pathPrefix
            : undefined;
        const policyKey = `${redirectOrigin.origin}\n${pathPrefix ?? ""}`;
        if (origins.has(policyKey)) return null;
        redirectOrigins.push({
          origin: redirectOrigin.origin,
          ...(pathPrefix ? { pathPrefix } : {}),
        });
        origins.add(policyKey);
      }
    }
    definitions.push({
      id: input.id,
      origin: origin.origin,
      headers,
      ...(methods ? { methods } : {}),
      ...(typeof input.pathPrefix === "string"
        ? { pathPrefix: input.pathPrefix }
        : {}),
      ...(redirectOrigins.length ? { redirectOrigins } : {}),
    });
    ids.add(input.id);
  }
  return definitions;
}

function parseGitHubConnections(
  value: unknown,
): GitHubConnectionDefinition[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const definitions: GitHubConnectionDefinition[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.provider)) return null;
    if (
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
      ids.has(item.id) ||
      item.provider.kind !== "github-app" ||
      !isRecord(item.provider.permissions)
    ) {
      return null;
    }
    const permissions = parseGitHubPermissions(item.provider.permissions);
    if (!permissions) return null;
    definitions.push({
      id: item.id,
      provider: {
        kind: "github-app",
        permissions,
      },
    });
    ids.add(item.id);
  }
  return definitions;
}

function parseDeploymentUpload(
  body: Record<string, unknown> | null,
): CreateDeploymentUploadInput | null {
  if (
    typeof body?.agentId !== "string" ||
    typeof body.digest !== "string" ||
    typeof body.size !== "number" ||
    typeof body.contentType !== "string"
  ) {
    return null;
  }
  return {
    agentId: body.agentId,
    digest: body.digest,
    size: body.size,
    contentType: body.contentType,
  };
}

/** How long a Playground session keeps its sandbox after a turn before suspending. */
const PLAYGROUND_IDLE_SUSPEND_SECONDS = 180;

async function changeRuntimeState(
  env: Env,
  identity: RequestIdentity,
  session: DurableObjectStub<SessionDurableObject>,
  action: "resume" | "suspend" | "terminate",
  edge?: string,
  context?: ExecutionContext,
): Promise<Response> {
  const platform = env as Env & PlatformEnv;
  const snapshot = await session.snapshot();
  if (!snapshot.microvmId) {
    return problem(409, "runtime_not_bound", "Session has no runtime");
  }
  // The Playground asks to suspend after every turn. A sandbox session holds
  // its runtime for a grace period instead, so the next turn, if it comes
  // soon, skips the boot from the snapshot; the session's idle timer
  // suspends it after that.
  if (
    action === "suspend" &&
    doFirstSessionSpike(env) &&
    isModalSandboxId(snapshot.microvmId) &&
    snapshot.microvmState === "running" &&
    (await session.deferIdleSuspend(PLAYGROUND_IDLE_SUSPEND_SECONDS))
  ) {
    return json(await session.snapshot(), 202);
  }
  // A sandbox runtime suspends by snapshot-and-terminate, so there is no
  // runtime to resume in place: reopen the start and boot a fresh one from
  // the snapshot (the DO-first start restores it). Callers wait for
  // `runtime.connected` as they do after a session create.
  if (
    action === "resume" &&
    doFirstSessionSpike(env) &&
    isModalSandboxId(snapshot.microvmId)
  ) {
    const origin = edge ?? (await session.runtimeEdgeOrigin());
    if (!origin) {
      return problem(502, "runtime_operation_failed", "The session has no runtime edge");
    }
    if (!(await session.releaseRuntimeForRestart())) {
      return problem(409, "runtime_not_suspended", "The session runtime is not suspended");
    }
    const start = startDoFirstSessionRuntime(
      env,
      identity.accountId,
      session,
      origin,
    );
    if (context) context.waitUntil(start);
    else await start;
    return json(await session.snapshot(), 202);
  }
  if (!platform.RUNTIMES) {
    return problem(
      503,
      "runtime_service_unavailable",
      "The managed-agent runtime service is not configured",
    );
  }
  if (action === "resume") {
    await session.updateMicrovmState({
      microvmId: snapshot.microvmId,
      state: "resuming",
    });
  } else if (action === "suspend") {
    await session.updateMicrovmState({
      microvmId: snapshot.microvmId,
      state: "suspending",
    });
  }
  let response: Response;
  try {
    response = await platform.RUNTIMES.fetch(
      `https://blue-runtime/v1/sessions/${encodeURIComponent(snapshot.id)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: identity.accountId,
          microvmId: snapshot.microvmId,
        }),
      },
    );
  } catch {
    if (snapshot.microvmState) {
      await session.updateMicrovmState({
        microvmId: snapshot.microvmId,
        state: snapshot.microvmState,
      });
    }
    return problem(
      502,
      "runtime_operation_failed",
      `The platform could not ${action} the session runtime`,
    );
  }
  if (!response.ok) {
    if (snapshot.microvmState) {
      await session.updateMicrovmState({
        microvmId: snapshot.microvmId,
        state: snapshot.microvmState,
      });
    }
    return problem(
      502,
      "runtime_operation_failed",
      `The platform could not ${action} the session runtime`,
    );
  }
  return json(
    await session.updateMicrovmState({
      microvmId: snapshot.microvmId,
      state:
        action === "resume"
          ? "running"
          : action === "suspend"
            ? "suspended"
            : "terminated",
    }),
  );
}

async function routeSession(
  request: Request,
  env: Env,
  path: { sessionId: string; suffix: string },
  identity: RequestIdentity,
  context?: ExecutionContext,
): Promise<Response> {
  const session = env.SESSIONS.getByName(path.sessionId);
  let indexedSession: SessionSummary | null = null;
  if (identity.kind !== "runtime") {
    const account = env.ACCOUNTS.getByName(identity.accountId);
    indexedSession = await account.getSession(path.sessionId);
    if (!indexedSession) {
      return problem(404, "session_not_found", "Session not found");
    }
    if (identity.projectId) {
      const project = await account.getProject(identity.projectId);
      const snapshot = await session.snapshot();
      if (!project || !projectOwnsAgent(project, snapshot.agentId)) {
        return problem(404, "session_not_found", "Session not found");
      }
    }
  }

  if (path.suffix === "/connect" && request.method === "GET") {
    return session.fetch(request);
  }

  if (
    request.method === "POST" &&
    (path.suffix === "/resume" ||
      path.suffix === "/suspend" ||
      path.suffix === "/terminate")
  ) {
    return changeRuntimeState(
      env,
      identity,
      session,
      path.suffix.slice(1) as "resume" | "suspend" | "terminate",
      new URL(request.url).origin,
      context,
    );
  }

  if (path.suffix === "" && request.method === "GET") {
    const snapshot = await session.snapshot();
    const memory = snapshot.memory ? await session.memoryBindings() : undefined;
    return json({
      ...snapshot,
      ...(memory ? { memory } : {}),
      ...(indexedSession ? { source: indexedSession.source } : {}),
    });
  }

  if (path.suffix === "/events" && request.method === "GET") {
    const url = new URL(request.url);
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    const cursor = Number.isFinite(after) && after >= 0 ? after : 0;
    return json({ events: await session.listEvents(cursor) });
  }

  if (path.suffix === "/resources" && request.method === "GET") {
    return json(await session.resources());
  }

  if (path.suffix === "/data" && request.method === "PUT") {
    const body = await readJson(request);
    if (typeof body?.key !== "string" || !("value" in body)) {
      return problem(400, "invalid_session_data", "Expected key and value");
    }
    return json(await session.putData(body.key, body.value));
  }

  if (path.suffix === "/files" && request.method === "POST") {
    const body = await readJson(request);
    if (
      typeof body?.name !== "string" ||
      typeof body.contentType !== "string" ||
      typeof body.size !== "number"
    ) {
      return problem(400, "invalid_session_file", "Expected file metadata");
    }
    return json(
      await session.shareFile({
        id:
          typeof body.id === "string" ? body.id : `file_${crypto.randomUUID()}`,
        name: body.name,
        contentType: body.contentType,
        size: body.size,
      }),
      201,
    );
  }

  if (path.suffix.startsWith("/workspace/")) {
    // Owner credentials only: file bytes and manifests never flow back into
    // the runtime, so the runtime token has no business here.
    if (identity.kind !== "user") {
      return problem(
        403,
        "forbidden",
        "Workspace files are read with an owner API key",
      );
    }
    return routeSessionWorkspace(request, env, path.suffix, session);
  }

  if (path.suffix === "/secrets" && request.method === "POST") {
    const body = await readJson(request);
    if (typeof body?.name !== "string") {
      return problem(400, "invalid_session_secret", "Expected a secret name");
    }
    return json(
      await session.shareSecretReference(
        body.name,
        body.source === "session" ? "session" : "project",
      ),
      201,
    );
  }

  if (path.suffix === "/interrupt" && request.method === "POST") {
    return json(await session.interrupt());
  }

  // Closes the open question without an answer (design 018); what it held
  // runs as ordinary turns. Interrupt and end never stand in for this.
  const dismiss = /^\/questions\/([^/]+)\/dismiss$/.exec(path.suffix);
  if (dismiss && request.method === "POST") {
    let questionId: string;
    try {
      questionId = decodeURIComponent(dismiss[1]!);
    } catch {
      return problem(400, "invalid_question", "Malformed question id");
    }
    if (parseTurnAnswers(questionId) == null) {
      return problem(400, "invalid_question", "Question id must be 1 to 256 characters");
    }
    try {
      return json(await session.dismissQuestion(questionId));
    } catch (error) {
      const questionProblem = questionAdmissionProblem(error);
      if (questionProblem) return questionProblem;
      throw error;
    }
  }

  if (path.suffix === "/labels" && request.method === "PATCH") {
    // Owner credentials only: the runtime token never writes labels, and no
    // tool path reaches this route.
    if (identity.kind !== "user") {
      return problem(403, "forbidden", "Labels are written with an owner API key");
    }
    const patch = parseLabelPatch(await readJson(request));
    if ("error" in patch) return problem(400, "invalid_labels", patch.error);
    let snapshot: SessionSnapshot;
    try {
      snapshot = await session.updateLabels(patch);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(INVALID_LABELS)) {
        return problem(
          400,
          "invalid_labels",
          error.message.slice(INVALID_LABELS.length + 2),
        );
      }
      if (error instanceof Error && error.message.startsWith(PUBLICATION_UNCONFIRMED)) {
        // Recorded, not yet listed: the alarm delivers, the caller retries.
        return publicationUnconfirmed(path.sessionId);
      }
      throw error;
    }
    const memory = snapshot.memory ? await session.memoryBindings() : undefined;
    return json({
      ...snapshot,
      ...(memory ? { memory } : {}),
      ...(indexedSession ? { source: indexedSession.source } : {}),
    });
  }

  if (path.suffix === "/end" && request.method === "POST") {
    // The Session object publishes its own `ended` row.
    const snapshot = await session.end();
    if (snapshot.memoryClosure === "pending") {
      // Ended locally, revocation not acknowledged: never report success.
      return problem(
        503,
        "session_end_unconfirmed",
        "The session is ended but its memory write access is not confirmed revoked; retry end, or freeze the document",
      );
    }
    return json(snapshot);
  }

  if (path.suffix === "/turns" && request.method === "POST") {
    if (indexedSession) {
      const project = await env.ACCOUNTS.getByName(identity.accountId).getProject(
        indexedSession.projectId,
      );
      if (project) {
        const archived = projectArchived(project);
        if (archived) return archived;
      }
    }
    const body = await readJson(request);
    // One rule for the key across create and turns (C2): the
    // `Idempotency-Key` header is accepted here as well as the body field.
    // Both present must agree; the fingerprint and conflict rules on the
    // key are unchanged, whichever carried it.
    const headerKey = request.headers.get("idempotency-key")?.trim();
    if (
      typeof body?.input !== "string" ||
      (body.idempotencyKey !== undefined &&
        typeof body.idempotencyKey !== "string") ||
      (body.mode !== undefined &&
        body.mode !== "queue" &&
        body.mode !== "steer" &&
        body.mode !== "interrupt")
    ) {
      return problem(
        400,
        "invalid_turn",
        "Expected input, optional idempotencyKey and payload, and queue, steer, or interrupt mode",
      );
    }
    if (
      typeof body.idempotencyKey === "string" &&
      headerKey &&
      body.idempotencyKey !== headerKey
    ) {
      return problem(
        400,
        "invalid_turn",
        "Idempotency-Key header and idempotencyKey body field must be equal when both are present",
      );
    }
    const idempotencyKey: string | undefined =
      (typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined) ??
      (headerKey || undefined);
    if (idempotencyKey !== undefined && (!idempotencyKey.trim() || idempotencyKey.length > 256)) {
      return problem(400, "invalid_turn", "Idempotency-Key must be 1 to 256 characters");
    }
    // The payload is the application's structured request context. It is
    // bounded here, where an application composes it; the agent reads it as
    // `useInput().payload` on a user-sourced input, next to the text.
    const payload = body.payload as AgentInputValue | undefined;
    if (payload !== undefined && payloadLength(payload) > TURN_PAYLOAD_LIMIT) {
      return problem(400, "invalid_payload", "payload cannot exceed 32 KB of JSON");
    }
    // The question this turn answers (design 018); validated here, judged
    // against the open question by the Session object.
    const answers = parseTurnAnswers(body.answers);
    if (answers === null) {
      return problem(400, "invalid_turn", "answers must be a question id of 1 to 256 characters");
    }
    let result: TurnReceipt;
    try {
      result = await session.enqueueTurn({
        input: body.input,
        idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
        mode: body.mode,
        ...(payload !== undefined
          ? { agentInput: { source: "user", text: body.input, payload } }
          : {}),
        ...(answers !== undefined ? { answers } : {}),
      });
    } catch (error) {
      const questionProblem = questionAdmissionProblem(error);
      if (questionProblem) return questionProblem;
      if (error instanceof Error && error.message.startsWith(IDEMPOTENCY_CONFLICT)) {
        return problem(
          409,
          "idempotency_conflict",
          "idempotencyKey was already used with different input, payload, or mode",
        );
      }
      if (error instanceof Error && error.message.startsWith(MEMORY_ADMISSION_PENDING)) {
        return problem(
          409,
          "memory_admission_pending",
          "Memory grants are not confirmed yet; retry the session creation with the same Idempotency-Key first",
        );
      }
      if (error instanceof Error && error.message.startsWith(MEMORY_ADMISSION_REJECTED)) {
        return problem(
          409,
          "memory_admission_rejected",
          "The session's memory bindings were refused and the session is ended; create a new session",
        );
      }
      if (error instanceof Error && error.message.startsWith(SESSION_ENDED)) {
        return problem(409, "session_ended", "The session has ended and accepts no new turns");
      }
      throw error;
    }
    if (doFirstSessionSpike(env)) {
      const start = startDoFirstSessionRuntime(
        env,
        identity.accountId,
        session,
        new URL(request.url).origin,
      );
      if (context) {
        context.waitUntil(start);
      } else {
        await start;
      }
    }
    return json(result, result.duplicate ? 200 : 202);
  }

  if (path.suffix === "/microvm" && request.method === "PUT") {
    const body = await readJson(request);
    if (
      typeof body?.microvmId !== "string" ||
      typeof body.state !== "string" ||
      !MICROVM_STATES.has(body.state)
    ) {
      return problem(400, "invalid_microvm", "Expected microvmId and state");
    }
    return json(
      await session.bindMicrovm({
        microvmId: body.microvmId,
        state: body.state,
      }),
    );
  }

  if (path.suffix === "/microvm" && request.method === "PATCH") {
    const body = await readJson(request);
    if (
      typeof body?.microvmId !== "string" ||
      typeof body.state !== "string" ||
      !MICROVM_STATES.has(body.state)
    ) {
      return problem(400, "invalid_microvm", "Expected microvmId and state");
    }
    return json(
      await session.updateMicrovmState({
        microvmId: body.microvmId,
        state: body.state,
      }),
    );
  }

  return problem(404, "not_found", "Session route not found");
}

/**
 * Workspace export: the files an agent wrote under `/workspace` and the
 * manifests of the ones the provider retained. Listing and exporting return
 * metadata only. New clients request a short-lived signed URL for the
 * immutable retained object, so its bytes never transit the control-plane
 * Workers, model, events or logs. The content route remains for older clients.
 */
async function routeSessionWorkspace(
  request: Request,
  env: Env,
  suffix: string,
  session: DurableObjectStub<SessionDurableObject>,
): Promise<Response> {
  const platform = env as Env & PlatformEnv;
  const snapshot = await session.snapshot();
  const scope = { accountId: snapshot.accountId, sessionId: snapshot.id };
  const call = async (
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Response> =>
    platform.RUNTIMES
      ? platform.RUNTIMES.fetch(`https://blue-runtime/v1/workspaces${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...scope, ...payload }),
        })
      : problem(
          503,
          "workspace_unavailable",
          "The managed-agent runtime service is not configured",
        );
  const upstreamFailure = async (
    response: Response,
  ): Promise<{ code: WorkspaceExportErrorCode; message: string }> => {
    const body = (await response.json().catch(() => null)) as
      | { code?: unknown; message?: unknown }
      | null;
    if (isWorkspaceExportErrorCode(body?.code) && WORKSPACE_EXPORT_ERRORS[body.code].status === response.status) {
      return { code: body.code, message: typeof body.message === "string" ? body.message : body.code };
    }
    if (response.status === 503) {
      return { code: "workspace_unavailable", message: "The managed-agent runtime service is not configured" };
    }
    return { code: "workspace_export_failed", message: "Workspace export is temporarily unavailable" };
  };
  const failure = (code: WorkspaceExportErrorCode, message: string, details: Record<string, unknown> = {}) =>
    problem(WORKSPACE_EXPORT_ERRORS[code].status, code, message, {
      retrySafe: WORKSPACE_EXPORT_ERRORS[code].retrySafe,
      ...details,
    });

  if (suffix === "/workspace/files" && request.method === "GET") {
    const cursor = new URL(request.url).searchParams.get("cursor");
    const response = await call("/list", cursor ? { cursor } : {});
    if (!response.ok) {
      const { code, message } = await upstreamFailure(response);
      return failure(code, message);
    }
    return json(await response.json());
  }

  if (
    suffix === "/workspace/download" &&
    (request.method === "POST" || request.method === "GET")
  ) {
    const requestedPath =
      request.method === "GET"
        ? new URL(request.url).searchParams.get("path")
        : (await readJson(request))?.path;
    const path = exportableWorkspacePath(requestedPath);
    if (!path) {
      return failure("artifact_path_invalid", "Expected a relative path to a regular file under /workspace");
    }
    const response = await call("/download", { path });
    if (!response.ok) {
      const { code, message } = await upstreamFailure(response);
      return failure(code, message);
    }
    const signed = (await response.json()) as Record<string, unknown>;
    let location: URL;
    try {
      location = new URL(String(signed.url));
    } catch {
      return failure("workspace_export_failed", "Workspace download is temporarily unavailable");
    }
    if (location.protocol !== "https:" || location.username || location.password) {
      return failure("workspace_export_failed", "Workspace download is temporarily unavailable");
    }
    const headers = {
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    };
    if (request.method === "GET") {
      return new Response(null, {
        status: 302,
        headers: { ...headers, location: location.toString() },
      });
    }
    return json({ ...signed, url: location.toString() }, { headers });
  }

  if (suffix === "/workspace/exports" && request.method === "GET") {
    return json({
      artifacts: await session.listWorkspaceArtifacts(),
      exports: await session.listWorkspaceExports(),
    });
  }

  if (suffix === "/workspace/exports" && request.method === "POST") {
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? null;
    if (idempotencyKey !== null && (!idempotencyKey || idempotencyKey.length > 256)) {
      return problem(400, "invalid_idempotency_key", "Idempotency-Key must be 1 to 256 characters");
    }
    const body = await readJson(request);
    const path = exportableWorkspacePath(body?.path);
    if (!path) {
      return failure(
        "artifact_path_invalid",
        "Expected a relative path to a regular file under /workspace",
      );
    }
    const expected = workspaceExportExpectation(body?.expected);
    if (expected === undefined) {
      return failure(
        "artifact_path_invalid",
        "expected.bytes must be a non-negative integer, expected.sha256 64 hex characters, expected.mediaType a media type",
      );
    }
    const requestDigest = await workspaceExportFingerprint({ path, expected });
    let admitted;
    try {
      admitted = await session.beginWorkspaceExport({
        idempotencyKey,
        requestDigest,
        path,
        expected,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(WORKSPACE_EXPORT_CONFLICT)) {
        return failure(
          "export_idempotency_conflict",
          "Idempotency-Key was already used for a different export request",
        );
      }
      throw error;
    }
    const answer = (
      record: { export: WorkspaceExport; artifact: WorkspaceArtifact | null },
      status: number,
    ): Response => {
      if (record.export.state === "delivered" || record.export.state === "snapshotting") {
        return json(record, status);
      }
      const error = record.export.error;
      const code = isWorkspaceExportErrorCode(error?.code) ? error.code : "workspace_export_failed";
      return failure(code, error?.message ?? "Workspace export failed", {
        exportId: record.export.id,
        retrySafe: error?.retrySafe ?? WORKSPACE_EXPORT_ERRORS[code].retrySafe,
      });
    };
    if (admitted.outcome === "in_flight") return answer(admitted, 202);
    if (admitted.outcome === "replayed") return answer(admitted, 200);
    const exportId = admitted.export.id;
    let response: Response;
    try {
      response = await call("/export", { path, ...(expected ? { expected } : {}) });
    } catch (error) {
      await session.failWorkspaceExport(exportId, {
        code: "workspace_export_failed",
        message: "Workspace export is temporarily unavailable",
        retrySafe: true,
      });
      throw error;
    }
    if (!response.ok) {
      const { code, message } = await upstreamFailure(response);
      const failed = await session.failWorkspaceExport(exportId, {
        code,
        message,
        retrySafe: WORKSPACE_EXPORT_ERRORS[code].retrySafe,
      });
      return answer({ export: failed, artifact: null }, 0);
    }
    const exported = (await response.json()) as WorkspaceExportResult;
    const completed = await session.completeWorkspaceExport(exportId, {
      path: exported.path,
      size: exported.size,
      sha256: exported.sha256,
      mediaType: exported.mediaType,
      snapshotId: exported.snapshotId,
      receipt: {
        bucket: exported.artifact.bucket,
        key: exported.artifact.key,
        etag: exported.artifact.etag,
        sourceEtag: exported.sourceEtag,
        sourceVersionId: exported.sourceVersionId,
      },
    });
    return json(completed, 201);
  }

  const exportMatch = suffix.match(/^\/workspace\/exports\/(wsexp_[^/]+)$/);
  if (exportMatch?.[1] && request.method === "GET") {
    const record = await session.getWorkspaceExport(exportMatch[1]);
    if (!record) return problem(404, "export_not_found", "Workspace export not found");
    return json(record);
  }

  const artifactMatch = suffix.match(
    /^\/workspace\/exports\/([^/]+)(\/(?:content|download))?$/,
  );
  if (artifactMatch?.[1] && request.method === "GET") {
    const artifact = await session.getWorkspaceArtifact(
      decodeURIComponent(artifactMatch[1]),
    );
    if (!artifact) {
      return problem(404, "artifact_not_found", "Workspace artifact not found");
    }
    if (!artifactMatch[2]) return json({ artifact });
    if (artifactMatch[2] === "/download") {
      const response = await call("/artifacts/download", {
        key: artifact.receipt.key,
        filename: artifact.path.split("/").pop() ?? artifact.id,
        mediaType: artifact.mediaType,
      });
      if (!response.ok) {
        const { code, message } = await upstreamFailure(response);
        return failure(code === "workspace_unavailable" ? code : "workspace_export_failed", message, {
          artifactId: artifact.id,
        });
      }
      const signed = (await response.json().catch(() => null)) as
        | { url?: unknown; expiresAt?: unknown }
        | null;
      if (typeof signed?.url !== "string" || typeof signed.expiresAt !== "string") {
        return failure("workspace_export_failed", "Workspace download is temporarily unavailable", {
          artifactId: artifact.id,
        });
      }
      let location: URL;
      try {
        location = new URL(signed.url);
      } catch {
        return failure("workspace_export_failed", "Workspace download is temporarily unavailable", {
          artifactId: artifact.id,
        });
      }
      if (location.protocol !== "https:" || location.username || location.password) {
        return failure("workspace_export_failed", "Workspace download is temporarily unavailable", {
          artifactId: artifact.id,
        });
      }
      return json(
        { url: location.toString(), expiresAt: signed.expiresAt },
        {
          status: 200,
          headers: {
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
          },
        },
      );
    }
    const response = await call("/artifacts/read", { key: artifact.receipt.key });
    if (!response.ok || !response.body) {
      const { code, message } = await upstreamFailure(response);
      return failure(code === "workspace_unavailable" ? code : "workspace_export_failed", message, {
        artifactId: artifact.id,
      });
    }
    const headers = new Headers({
      "content-type": artifact.mediaType,
      "content-length": String(artifact.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
        artifact.path.split("/").pop() ?? artifact.id,
      )}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-workspace-artifact-id": artifact.id,
      "x-workspace-artifact-sha256": artifact.sha256,
      "x-workspace-artifact-size": String(artifact.size),
    });
    return new Response(response.body, { status: 200, headers });
  }

  return problem(404, "not_found", "Session route not found");
}


/**
 * Step one of connecting Twilio: prove the credentials and show the operator
 * which of their numbers can take this work. Nothing is pointed at us yet, so
 * a wrong paste costs nothing.
 */
async function createTwilioConnectionRequest(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  if (!(env as Env & PlatformEnv).BLUE_CHANNEL_ENCRYPTION_KEY) {
    return problem(
      503,
      "twilio_connector_unavailable",
      "Channel credential encryption is not configured",
    );
  }
  const body = await readJson(request);
  const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
  const accountSid =
    typeof body?.accountSid === "string" ? body.accountSid.trim() : "";
  const authToken =
    typeof body?.authToken === "string" ? body.authToken.trim() : "";
  if (!agentId || !accountSid || !authToken) {
    return problem(
      400,
      "invalid_twilio_connection",
      "Expected an agent reference, an account SID, and an auth token",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const deployment = await account.resolveDeployment(agentId);
  if (!deployment) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }
  const projectDeployment = deployment.projectDeployment as
    | ProjectDeploymentReference
    | undefined;
  const declaredChannels =
    projectDeployment?.resources.channels.filter(
      (channel) => channel.type === "twilio",
    ) ?? [];
  const requestedChannel =
    typeof body?.channelId === "string" ? body.channelId.trim() : undefined;
  const declaredChannel = requestedChannel
    ? declaredChannels.find((channel) => channel.id === requestedChannel)
    : declaredChannels.length === 1
      ? declaredChannels[0]
      : undefined;
  if (requestedChannel && !declaredChannel) {
    return problem(400, "unknown_channel", "Twilio channel is not declared");
  }

  try {
    const credential = { accountSid, authToken };
    const { friendlyName } = await verifyCredential(credential);
    const numbers = await listNumbers(credential);
    const connectionId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replace(/-/g, "");
    await account.createTwilioConnection({
      id: connectionId,
      channelId: declaredChannel?.id ?? "twilio",
      agentId: deployment.agentId,
      alias: deployment.alias,
      accountSid,
      authToken,
      // Chosen in step two; stored empty so the connection cannot yet match a
      // delivery for a number nobody has picked.
      phoneNumber: "",
    });
    await env.ACCOUNTS.getByName(
      channelRouteName("twilio", connectionId),
    ).setChannelRoute({
      accountId: identity.accountId,
      connectionId,
      webhookTokenHash: await sha256(webhookToken),
      provider: "twilio",
    });
    return json(
      {
        connection: { id: connectionId, provider: "twilio", status: "pending" },
        account: { sid: accountSid, friendlyName },
        // Only numbers that can do both are useful: one that cannot take a
        // call cannot catch a missed one.
        numbers: numbers.filter(
          (number) => number.capabilities.sms && number.capabilities.voice,
        ),
        webhookToken,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TwilioSetupError) {
      return problem(400, error.code, error.message);
    }
    throw error;
  }
}

/**
 * Step two: the operator picks a number and this points it at us. Doing the
 * configuration here rather than handing over two URLs to paste is the whole
 * difference between a setup a plumber can finish and one they abandon.
 */
async function completeTwilioConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  connectionId: string,
): Promise<Response> {
  const body = await readJson(request);
  const numberSid =
    typeof body?.numberSid === "string" ? body.numberSid.trim() : "";
  const phoneNumber =
    typeof body?.phoneNumber === "string" ? body.phoneNumber.trim() : "";
  const webhookToken =
    typeof body?.webhookToken === "string" ? body.webhookToken.trim() : "";
  if (!numberSid || !phoneNumber || !webhookToken) {
    return problem(
      400,
      "invalid_twilio_completion",
      "Expected a number SID, its phone number, and the webhook token",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const connection = await account.getChannelConnection(connectionId);
  if (!connection || connection.provider !== "twilio") {
    return problem(404, "twilio_connection_not_found", "Connection not found");
  }
  const route = await env.ACCOUNTS.getByName(
    channelRouteName("twilio", connectionId),
  ).getChannelRoute();
  if (
    !route ||
    !timingSafeEqualHex(route.webhookTokenHash, await sha256(webhookToken))
  ) {
    return problem(401, "invalid_webhook_token", "Invalid webhook token");
  }
  const credential = await account.twilioCredential(connectionId);
  if (!credential) {
    return problem(
      404,
      "twilio_credentials_missing",
      "This connection has no stored credentials",
    );
  }
  const base = `/v1/webhooks/twilio/${encodeURIComponent(connectionId)}/${webhookToken}`;
  try {
    await configureNumber(credential, numberSid, {
      smsUrl: new URL(`${base}/sms`, request.url).toString(),
      voiceUrl: new URL(`${base}/voice`, request.url).toString(),
    });
  } catch (error) {
    if (error instanceof TwilioSetupError) {
      return problem(400, error.code, error.message);
    }
    throw error;
  }
  await account.activateTwilioConnection(connectionId, phoneNumber);
  return json({
    connection: {
      id: connectionId,
      provider: "twilio",
      status: "connected",
      phoneNumber,
    },
  });
}

// ---------------------------------------------------------------------------
// Automated Slack setup routes. HTTP concerns only: the provider calls live in
// channels/slack-api.ts, the rules in channels/slack-setup.ts, and every claim
// and commit in the Account DO.
// ---------------------------------------------------------------------------

const SLACK_SETUP_REQUEST_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const SLACK_OAUTH_CODE = /^[A-Za-z0-9._-]{1,512}$/;

interface SlackSetupConfig {
  redirectUri: string;
  appUrl?: string;
}

function slackSetupConfig(env: Env): SlackSetupConfig | null {
  const platform = env as Env & PlatformEnv;
  const redirectUri = platform.BLUE_SLACK_OAUTH_REDIRECT_URI?.trim();
  if (!redirectUri || !platform.BLUE_CHANNEL_ENCRYPTION_KEY) return null;
  const appUrl = platform.OPENCOMPUTER_APP_URL?.trim();
  return { redirectUri, ...(appUrl ? { appUrl } : {}) };
}

/**
 * The project a setup for this agent belongs to, or null when the identity
 * is scoped to a project that does not own the agent. Without a scope, the
 * owning project is looked up the way session creation does.
 */
async function slackSetupProjectId(
  account: DurableObjectStub<AccountDurableObject>,
  identity: RequestIdentity,
  agentId: string,
): Promise<string | null> {
  if (identity.projectId) {
    const project = await account.getProject(identity.projectId);
    return project && projectOwnsAgent(project, agentId) ? project.id : null;
  }
  const owner = (await account.listProjects()).find((project: Project) =>
    projectOwnsAgent(project, agentId),
  );
  return owner?.id ?? `project:${agentId}`;
}

async function ownedSlackSetup(
  account: DurableObjectStub<AccountDurableObject>,
  identity: RequestIdentity,
  id: string,
): Promise<SlackSetupRecord | Response> {
  const record = await account.getSlackSetup(id);
  if (!record) {
    return problem(404, "slack_setup_not_found", "Slack setup not found");
  }
  if (identity.projectId && identity.projectId !== record.setup.projectId) {
    return problem(404, "project_not_found", "Project not found");
  }
  return record;
}

/** Exported so the project guard can be exercised with a scoped identity. */
export async function handleSlackSetupRoute(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/channels/slack/setups") {
    if (request.method === "POST") return startSlackSetup(request, env, identity);
    if (request.method === "GET") return findSlackSetup(url, env, identity);
    return problem(405, "method_not_allowed", "Unsupported Slack setup request");
  }
  const match = url.pathname.match(
    /^\/v1\/channels\/slack\/setups\/([^/]+)(?:\/(authorize|cancel))?$/,
  );
  if (!match?.[1]) return null;
  const id = decodeURIComponent(match[1]);
  const account = env.ACCOUNTS.getByName(identity.accountId);
  if (!match[2] && request.method === "GET") {
    const owned = await ownedSlackSetup(account, identity, id);
    return owned instanceof Response ? owned : json({ setup: owned.setup });
  }
  if (match[2] === "authorize" && request.method === "POST") {
    return authorizeSlackSetup(env, identity, id);
  }
  if (match[2] === "cancel" && request.method === "POST") {
    const owned = await ownedSlackSetup(account, identity, id);
    if (owned instanceof Response) return owned;
    const cancelled = await account.cancelSlackSetup(id);
    if (cancelled.outcome === "connected") {
      return problem(
        409,
        "slack_setup_connected",
        "A connected setup cannot be cancelled; disconnect the connection instead",
      );
    }
    if (cancelled.outcome === "busy") {
      return problem(
        409,
        "slack_setup_busy",
        "This setup is talking to Slack right now; wait for it to finish, then cancel",
      );
    }
    if (cancelled.outcome === "missing") {
      return problem(404, "slack_setup_not_found", "Slack setup not found");
    }
    return json({ setup: cancelled.setup });
  }
  return problem(405, "method_not_allowed", "Unsupported Slack setup request");
}

async function findSlackSetup(
  url: URL,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const agentId = url.searchParams.get("agentId")?.trim() ?? "";
  const channelId = url.searchParams.get("channelId")?.trim() || undefined;
  if (!agentId) {
    return problem(
      400,
      "invalid_slack_setup_query",
      "Expected agentId and alias (development or production)",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  if (!(await slackSetupProjectId(account, identity, agentId))) {
    return problem(404, "project_not_found", "Project not found");
  }
  const scoped = await agentScope(account, agentId, url.searchParams.get("alias"), {
    legacyDefault: "required",
  });
  if (!scoped.ok) return scoped.response;
  const alias = scoped.scope.environment;
  const record = await account.findSlackSetupForTarget(agentId, alias, channelId);
  return json({ setup: record?.setup ?? null });
}

async function startSlackSetup(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const config = slackSetupConfig(env);
  if (!config) {
    return problem(
      503,
      "slack_setup_unavailable",
      "Automated Slack setup is not configured",
    );
  }
  const body = await readBoundedJson(request, 16 * 1024);
  const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
  const requestKey = typeof body?.requestKey === "string" ? body.requestKey : "";
  const rawName = typeof body?.name === "string" ? body.name : "";
  const requestedChannel =
    typeof body?.channelId === "string" ? body.channelId.trim() : "";
  const configurationToken =
    typeof body?.configurationToken === "string"
      ? body.configurationToken.trim()
      : undefined;
  if (
    !agentId ||
    agentId.includes("@") ||
    (body?.alias !== undefined && typeof body.alias !== "string") ||
    !SLACK_SETUP_REQUEST_KEY.test(requestKey) ||
    !rawName ||
    (configurationToken !== undefined &&
      (!configurationToken || configurationToken.length > 2048))
  ) {
    return problem(
      400,
      "invalid_slack_setup",
      "Expected agentId, alias, name, a requestKey of 16 to 128 URL-safe characters, and optionally a configurationToken",
    );
  }
  const name = normalizeSlackAppName(rawName);
  if (!name) {
    return problem(
      400,
      "invalid_slack_app_name",
      "Slack app names must be between 1 and 35 characters",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const projectId = await slackSetupProjectId(account, identity, agentId);
  if (!projectId) {
    return problem(404, "project_not_found", "Project not found");
  }
  const scoped = await agentScope(account, agentId, body?.alias, {
    legacyDefault: "required",
  });
  if (!scoped.ok) return scoped.response;
  const alias = scoped.scope.environment;
  const deployment = await account.resolveDeployment(`${agentId}@${alias}`);
  if (!deployment) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }
  const projectDeployment = deployment.projectDeployment as
    | ProjectDeploymentReference
    | undefined;
  const declaredChannels =
    projectDeployment?.resources.channels.filter(
      (channel) => channel.type === "slack",
    ) ?? [];
  const declaredChannel = requestedChannel
    ? declaredChannels.find((channel) => channel.id === requestedChannel)
    : declaredChannels.length === 1
      ? declaredChannels[0]
      : undefined;
  if (requestedChannel && !declaredChannel) {
    return problem(400, "unknown_channel", "Slack channel is not declared");
  }
  if (!requestedChannel && declaredChannels.length > 1) {
    return problem(400, "channel_required", "Select a declared Slack channel");
  }
  const channelId = declaredChannel?.id ?? "slack";

  let record: SlackSetupRecord;
  let created = false;
  const existing = await account.findSlackSetupByRequestKey(requestKey);
  if (existing) {
    const intent = existing.setup;
    if (
      intent.agentId !== agentId ||
      intent.alias !== alias ||
      intent.channelId !== channelId ||
      intent.name !== name ||
      intent.projectId !== projectId
    ) {
      return problem(
        409,
        "slack_setup_conflict",
        "This request key was used for a different Slack setup",
      );
    }
    record = existing;
  } else {
    const current = await account.findSlackConnectionForAlias(
      deployment.agentId,
      deployment.alias,
      channelId,
    );
    if (current?.status === "connected") {
      return problem(
        409,
        "slack_already_connected",
        "Slack is already connected to this deployment alias",
      );
    }
    const connectionId =
      current?.status === "pending" ? current.id : crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replace(/-/g, "");
    const webhookTokenHash = await sha256(webhookToken);
    const webhookUrl = new URL(
      `/v1/webhooks/slack/${encodeURIComponent(connectionId)}/${webhookToken}`,
      request.url,
    ).toString();
    const { manifest } = hostedSlackManifest(name, webhookUrl, {
      ...(declaredChannel
        ? { botScopes: declaredChannel.scopes.bot, events: declaredChannel.events }
        : {}),
      redirectUri: config.redirectUri,
    });
    const reservation = await account.reserveSlackSetup({
      id: crypto.randomUUID(),
      requestKey,
      projectId,
      ownerUserId: identity.userId,
      agentId: deployment.agentId,
      alias: deployment.alias,
      channelId,
      connectionId,
      webhookTokenHash,
      name,
      manifestJson: JSON.stringify(manifest),
    });
    if (reservation.outcome === "conflict") {
      return problem(
        409,
        "slack_setup_conflict",
        "This request key was used for a different Slack setup",
      );
    }
    if (reservation.outcome === "connected") {
      return problem(
        409,
        "slack_already_connected",
        "Slack is already connected to this deployment alias",
      );
    }
    if (reservation.outcome === "active") {
      return problem(
        409,
        "slack_setup_active",
        "Another Slack setup is in progress for this deployment; resume it",
        { setupId: reservation.record.setup.id },
      );
    }
    record = reservation.record;
    created = reservation.outcome === "created";
    if (created) {
      record = await publishSlackSetupRoute(env, identity.accountId, record);
    }
  }
  if (configurationToken && record.setup.phase === "prepared") {
    record = await runSlackSetupCreation(
      env,
      identity.accountId,
      record,
      configurationToken,
    );
  }
  return json({ setup: record.setup }, created ? 201 : 200);
}

/**
 * Publish the webhook route the manifest names, once, carrying the connection
 * revision the reservation observed. The route object refuses a publication
 * older than what it holds, and the DO records the result: a refusal, or a
 * connection that changed hands meanwhile, supersedes the setup.
 */
async function publishSlackSetupRoute(
  env: Env,
  accountId: string,
  record: SlackSetupRecord,
): Promise<SlackSetupRecord> {
  const account = env.ACCOUNTS.getByName(accountId);
  const applied = await env.ACCOUNTS.getByName(
    channelRouteName("slack", record.setup.connectionId),
  ).setChannelRoute({
    accountId,
    connectionId: record.setup.connectionId,
    webhookTokenHash: record.webhookTokenHash,
    provider: "slack",
    revision: record.connectionRevision,
  });
  await account.recordSlackSetupRoutePublication(record.setup.id, applied);
  return (await account.getSlackSetup(record.setup.id)) ?? record;
}

/**
 * Create the app, once. The claim is taken before the call, in the same
 * transaction as the ownership check, so a second submission joins rather
 * than repeats and a setup whose connection changed hands sends nothing. A
 * setup whose route was never published (its reservation's publisher did
 * not get that far) publishes it first; a route is never re-published. The
 * configuration token is used for this one call and dropped.
 */
async function runSlackSetupCreation(
  env: Env,
  accountId: string,
  record: SlackSetupRecord,
  configurationToken: string,
): Promise<SlackSetupRecord> {
  const account = env.ACCOUNTS.getByName(accountId);
  const id = record.setup.id;
  let claim: SlackSetupCreationClaim = await account.claimSlackSetupCreation(id);
  if (claim.status === "unpublished") {
    const published = await publishSlackSetupRoute(env, accountId, claim.record);
    if (published.setup.phase !== "prepared") return published;
    claim = await account.claimSlackSetupCreation(id);
  }
  if (claim.status === "missing") return record;
  if (claim.status !== "claimed") return claim.record;
  let outcome: SlackSetupCreationOutcome;
  try {
    outcome = {
      kind: "created",
      ...(await createSlackAppFromManifest(
        configurationToken,
        JSON.parse(record.manifestJson) as Record<string, unknown>,
      )),
    };
  } catch (error) {
    if (error instanceof SlackApiError) {
      const failure = slackCreationFailure(error);
      outcome = { kind: failure.outcome, error: failure.error };
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          event: "slack.setup.create_failed",
          setupId: id,
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      );
      outcome = {
        kind: "uncertain",
        error: slackSetupError(
          "slack_creation_uncertain",
          "The app creation attempt failed before Slack answered. Check your Slack app list before creating another; an existing app can be connected with manual setup.",
          false,
        ),
      };
    }
  }
  const committed = await account.commitSlackSetupCreation(
    id,
    claim.attemptId,
    outcome,
  );
  return committed ?? (await account.getSlackSetup(id)) ?? record;
}

async function authorizeSlackSetup(
  env: Env,
  identity: RequestIdentity,
  id: string,
): Promise<Response> {
  const config = slackSetupConfig(env);
  if (!config) {
    return problem(
      503,
      "slack_setup_unavailable",
      "Automated Slack setup is not configured",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const owned = await ownedSlackSetup(account, identity, id);
  if (owned instanceof Response) return owned;
  const { setup, clientId, botScopes } = owned;
  if (
    (setup.phase !== "app_created" && setup.phase !== "connected") ||
    !clientId
  ) {
    return problem(
      409,
      "slack_setup_not_authorizable",
      "This setup has no Slack app to install yet",
    );
  }
  const nonce = oauthNonce();
  const issued = await account.issueSlackOAuthState(id, await sha256(nonce));
  if (issued.status === "superseded") {
    return problem(
      409,
      "slack_setup_superseded",
      "The connection was changed another way; this setup can no longer install its app. Manage the connection from its current state, or use manual setup.",
    );
  }
  if (issued.status !== "issued") {
    return problem(
      409,
      "slack_setup_not_authorizable",
      "This setup has no Slack app to install yet",
    );
  }
  return json({
    authorizationUrl: slackAuthorizationUrl({
      clientId,
      scopes: botScopes,
      state: encodeOAuthState(identity.accountId, nonce),
      redirectUri: config.redirectUri,
      ...(setup.workspace ? { teamId: setup.workspace.id } : {}),
    }),
    expiresAt: issued.expiresAt,
  });
}

/** Only ever a server-generated dashboard location; the page itself when none is configured. */
function slackSetupRedirect(
  env: Env,
  setup: SlackSetup,
  result: SlackSetupResult,
): Response {
  const config = slackSetupConfig(env);
  if (!config?.appUrl) {
    return html(
      renderConnectionCallback({
        provider: "Slack",
        status: result === "connected" ? "success" : "error",
      }),
      result === "connected" ? 200 : 400,
    );
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: slackSetupReturnUrl(config.appUrl, setup, result),
      "cache-control": "no-store",
    },
  });
}

/**
 * Slack's OAuth callback. Public: the state names the account and a nonce
 * that account claims exactly once; everything after that is fenced on the
 * setup the state belongs to. A replay answers from the recorded result
 * without a second exchange; a malformed state gets the same page GitHub's
 * callback renders.
 */
async function slackAuthorizationCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const decoded = decodeOAuthState(url.searchParams.get("state") ?? "");
  const failed = () =>
    html(renderConnectionCallback({ provider: "Slack", status: "error" }), 400);
  if (!decoded) return failed();
  const account = env.ACCOUNTS.getByName(decoded.accountId);
  const nonceHash = await sha256(decoded.nonce);
  const claim = await account.claimSlackOAuthState(nonceHash);
  if (claim.status === "missing") return failed();
  const record = await account.getSlackSetup(claim.setupId);
  if (!record) return failed();
  const setupId = record.setup.id;
  const redirect = (result: SlackSetupResult, setup: SlackSetup = record.setup) =>
    slackSetupRedirect(env, setup, result);
  if (claim.status === "used") {
    return redirect(claim.resultCode ?? "authorization_expired");
  }
  if (claim.status === "expired") return redirect("authorization_expired");

  const denied = url.searchParams.get("error");
  const code = url.searchParams.get("code") ?? "";
  if (denied !== null || !code) {
    const setup = await account.recordSlackOAuthResult(
      nonceHash,
      setupId,
      "authorization_denied",
      slackSetupError(
        "slack_authorization_denied",
        "The Slack installation was declined. Authorize again when you are ready.",
        true,
      ),
    );
    return redirect("authorization_denied", setup ?? record.setup);
  }
  if (!SLACK_OAUTH_CODE.test(code)) {
    const setup = await account.recordSlackOAuthResult(
      nonceHash,
      setupId,
      "exchange_failed",
      slackSetupError(
        "slack_exchange_failed",
        "Slack returned an unusable authorization. Authorize again.",
        true,
      ),
    );
    return redirect("exchange_failed", setup ?? record.setup);
  }
  const config = slackSetupConfig(env);
  if (!config) return redirect("provider_unavailable");

  const attemptId = crypto.randomUUID();
  const claimed = await account.claimSlackExchange(setupId, attemptId, nonceHash);
  if (claimed !== "claimed") {
    return redirect(
      "superseded",
      (await account.getSlackSetup(setupId))?.setup ?? record.setup,
    );
  }
  let outcome: SlackExchangeOutcome;
  const credentials = await account.slackSetupExchangeCredentials(setupId);
  if (!credentials) {
    outcome = {
      kind: "failed",
      result: "exchange_failed",
      error: slackSetupError(
        "slack_exchange_failed",
        "This setup has no app credentials to complete the installation with.",
        false,
      ),
    };
  } else {
    try {
      const grant = await exchangeSlackOAuthCode({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        code,
        redirectUri: config.redirectUri,
      });
      const validated = validateSlackOAuthGrant(grant, {
        appId: credentials.appId,
        requiredScopes: credentials.botScopes,
      });
      if (!validated.ok) {
        outcome = { kind: "failed", ...validated.failure };
      } else if (
        credentials.teamId &&
        validated.grant.teamId !== credentials.teamId
      ) {
        outcome = {
          kind: "failed",
          ...slackExchangeFailure(
            new SlackApiError("oauth.v2.access", "rejected", "workspace_mismatch"),
          ),
        };
      } else {
        const installation = await verifySlackInstallation(
          validated.grant.accessToken,
          {
            appId: credentials.appId,
            teamId: validated.grant.teamId,
            botUserId: validated.grant.botUserId,
          },
        );
        outcome = {
          kind: "connected",
          botToken: validated.grant.accessToken,
          installation: {
            ...installation,
            ...(installation.teamName || !validated.grant.teamName
              ? {}
              : { teamName: validated.grant.teamName }),
          },
        };
      }
    } catch (error) {
      if (error instanceof SlackApiError) {
        outcome = { kind: "failed", ...slackExchangeFailure(error) };
      } else {
        console.error(
          JSON.stringify({
            level: "error",
            event: "slack.setup.exchange_failed",
            setupId,
            errorName: error instanceof Error ? error.name : typeof error,
          }),
        );
        outcome = {
          kind: "failed",
          result: "provider_unavailable",
          error: slackSetupError(
            "slack_provider_unavailable",
            "The installation could not be completed. Authorize again.",
            true,
          ),
        };
      }
    }
  }
  const commit = await account.commitSlackExchange(
    setupId,
    attemptId,
    nonceHash,
    outcome,
  );
  if (commit.result === "connected") return redirect("connected", commit.setup);
  if (commit.result === "superseded") return redirect("superseded", commit.setup);
  if (commit.result === "failed") {
    return redirect(
      outcome.kind === "failed" ? outcome.result : "exchange_failed",
      commit.setup,
    );
  }
  return redirect("superseded");
}

/** The manifest option for the configured OAuth callback, when there is one. */
function slackRedirectOption(
  env: PlatformEnv,
): { redirectUri?: string } {
  const redirectUri = env.BLUE_SLACK_OAUTH_REDIRECT_URI?.trim();
  return redirectUri ? { redirectUri } : {};
}

async function createSlackConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  if (!(env as Env & PlatformEnv).BLUE_CHANNEL_ENCRYPTION_KEY) {
    return problem(
      503,
      "slack_connector_unavailable",
      "Slack credential encryption is not configured",
    );
  }
  const body = await readJson(request);
  const input: CreateSlackConnectionInput | null =
    typeof body?.agentId === "string"
      ? {
          agentId: body.agentId.trim(),
          channelId:
            typeof body.channelId === "string"
              ? body.channelId.trim()
              : undefined,
          name: typeof body.name === "string" ? body.name : undefined,
          reconnect: body.reconnect === true,
        }
      : null;
  if (!input?.agentId) {
    return problem(
      400,
      "invalid_slack_connection",
      "Expected an agent reference",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const deployment = await account.resolveDeployment(input.agentId);
  if (!deployment) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }
  const projectDeployment = deployment.projectDeployment as
    | ProjectDeploymentReference
    | undefined;
  const declaredChannels =
    projectDeployment?.resources.channels.filter(
      (channel) => channel.type === "slack",
    ) ?? [];
  const declaredChannel = input.channelId
    ? declaredChannels.find((channel) => channel.id === input.channelId)
    : declaredChannels.length === 1
      ? declaredChannels[0]
      : undefined;
  if (input.channelId && !declaredChannel) {
    return problem(400, "unknown_channel", "Slack channel is not declared");
  }
  if (!input.channelId && declaredChannels.length > 1) {
    return problem(400, "channel_required", "Select a declared Slack channel");
  }
  const agent = (await account.listAgents()).find(
    (candidate: AgentSummary) => candidate.id === deployment.agentId,
  );
  const name = normalizeSlackAppName(
    input.name ?? declaredChannel?.displayName ?? agent?.name ?? "OpenComputer",
  );
  if (!name) {
    return problem(
      400,
      "invalid_slack_app_name",
      "Slack app names must be between 1 and 35 characters",
    );
  }
  // One transaction decides everything about the row: whether the target
  // already has a connected bot, whether an automated setup holds it, and
  // whether to reuse its pending row or create one. The handler never picks
  // an id, so two mints for one target cannot both create.
  const webhookToken = crypto.randomUUID().replace(/-/g, "");
  const webhookTokenHash = await sha256(webhookToken);
  const mint = await account.mintSlackConnection({
    agentId: deployment.agentId,
    alias: deployment.alias,
    channelId: declaredChannel?.id ?? "slack",
    appName: name,
    webhookTokenHash,
    reconnect: input.reconnect === true,
  });
  if (mint.outcome === "connected") {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "slack.connection_conflict",
        accountId: identity.accountId,
        agentId: deployment.agentId,
        alias: deployment.alias,
        requestId: request.headers.get("x-request-id"),
      }),
    );
    return problem(
      409,
      "slack_already_connected",
      "Slack is already connected to this deployment alias",
    );
  }
  if (mint.outcome === "setup_active") {
    return problem(
      409,
      "slack_setup_active",
      "An automated Slack setup is in progress for this deployment; resume it, or cancel it before setting up manually",
      { setupId: mint.setupId },
    );
  }
  const { connection, revision, created } = mint;
  const connectionId = connection.id;
  const published = await env.ACCOUNTS.getByName(
    channelRouteName("slack", connectionId),
  ).setChannelRoute({
    accountId: identity.accountId,
    connectionId,
    webhookTokenHash,
    provider: "slack",
    revision,
  });
  if (!published) {
    // A reservation overtook this mint: the row and the route are the
    // setup's now, and a manifest naming this URL would never receive an
    // event. Say which setup holds the connection instead of handing it out.
    const active = await account.findSlackSetupForTarget(
      deployment.agentId,
      deployment.alias,
      declaredChannel?.id ?? "slack",
    );
    return problem(
      409,
      "slack_setup_active",
      "An automated Slack setup took this connection while the manifest was being prepared; resume it, or cancel it and try again",
      active && active.setup.phase !== "connected"
        ? { setupId: active.setup.id }
        : {},
    );
  }
  const webhookUrl = new URL(
    `/v1/webhooks/slack/${encodeURIComponent(connectionId)}/${webhookToken}`,
    request.url,
  ).toString();
  return json(
    {
      connection,
      ...hostedSlackManifest(name, webhookUrl, {
        ...(declaredChannel
          ? {
              botScopes: declaredChannel.scopes.bot,
              events: declaredChannel.events,
            }
          : {}),
        ...slackRedirectOption(env as Env & PlatformEnv),
      }),
    } satisfies CreateSlackConnectionResult,
    created ? 201 : 200,
  );
}

async function completeSlackConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  connectionId: string,
): Promise<Response> {
  const body = await readJson(request);
  const input: CompleteSlackConnectionInput | null =
    typeof body?.botToken === "string" &&
    body.botToken.startsWith("xoxb-") &&
    typeof body.appId === "string" &&
    /^A[A-Z0-9]+$/.test(body.appId) &&
    typeof body.signingSecret === "string" &&
    /^[a-f0-9]{32}$/i.test(body.signingSecret)
      ? {
          botToken: body.botToken,
          appId: body.appId,
          signingSecret: body.signingSecret,
        }
      : null;
  if (!input) {
    return problem(
      400,
      "invalid_slack_credentials",
      "Expected a Slack App ID, Signing Secret, and Bot User OAuth Token",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  // One read, before any await: what this request may act on. Its writes,
  // the activation and the failed mark alike, apply only while the
  // connection is still at the revision seen here.
  const view = await account.slackConnectionView(connectionId);
  if (!view) {
    return problem(404, "slack_connection_not_found", "Connection not found");
  }
  const { connection, revision } = view;
  const blocked = () =>
    problem(
      409,
      "slack_manual_completion_blocked",
      "An automated Slack setup minted this connection's webhook, so a manually installed app would not receive events. Cancel the automated setup and use Reconnect to regenerate the manifest before completing manually.",
    );
  if (view.completionBlocked) return blocked();
  try {
    return json(
      await account.completeSlackConnection(
        connection.id,
        input.botToken,
        input.appId,
        input.signingSecret,
        revision,
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === SLACK_MANUAL_COMPLETION_BLOCKED) {
      return blocked();
    }
    await account.updateSlackConnectionStatus(connection.id, "failed", revision);
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack.connection_failed",
        connectionId: connection.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return problem(
      502,
      "slack_connection_failed",
      error instanceof Error ? error.message : "Slack connection failed",
    );
  }
}

async function startToolConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const body = await readJson(request);
  const input: StartConnectionInput | null =
    typeof body?.provider === "string" &&
    typeof body.agentId === "string" &&
    Array.isArray(body.scopes) &&
    body.scopes.every((scope) => typeof scope === "string") &&
    typeof body.redirectUri === "string" &&
    typeof body.codeChallenge === "string"
      ? {
          provider: body.provider,
          agentId: body.agentId,
          label: typeof body.label === "string" ? body.label : undefined,
          scopes: body.scopes as string[],
          redirectUri: body.redirectUri,
          codeChallenge: body.codeChallenge,
        }
      : null;
  if (!input) {
    return problem(
      400,
      "invalid_connection",
      "Expected provider, agent, scopes, redirect URI, and PKCE challenge",
    );
  }
  if (input.provider !== "google") {
    return problem(400, "unsupported_provider", "Provider is not supported");
  }
  const config = googleConfig(env as Env & PlatformEnv);
  if (!config) {
    return problem(
      503,
      "provider_unavailable",
      "Google connections are not configured",
    );
  }
  const allowedScopes = new Set<string>(GMAIL_SCOPES);
  const scopes = [...new Set(input.scopes)];
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !allowedScopes.has(scope))
  ) {
    return problem(
      400,
      "invalid_connection_scopes",
      "The requested Google scopes are not supported",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const deployment = await account.resolveDeployment(input.agentId);
  if (!deployment) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }
  if (!deployment.connections.includes(input.provider)) {
    return problem(
      409,
      "connection_not_declared",
      `Add the ${input.provider} connection to the agent and deploy it again`,
    );
  }
  const state = crypto.randomUUID().replace(/-/g, "");
  const connection = await account.createToolConnection({
    id: crypto.randomUUID(),
    provider: input.provider,
    label: input.label?.trim() || "default",
    ownerUserId: identity.userId,
    agentId: deployment.agentId,
    alias: deployment.alias,
    scopes,
    oauthStateHash: await sha256(state),
  });
  return json(
    {
      connection,
      authorizationUrl: googleAuthorizationUrl({
        config,
        redirectUri: input.redirectUri,
        scopes,
        state,
        codeChallenge: input.codeChallenge,
      }),
      state,
    },
    201,
  );
}

async function completeToolConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  connectionId: string,
): Promise<Response> {
  const body = await readJson(request);
  const input: CompleteConnectionInput | null =
    typeof body?.code === "string" &&
    typeof body.state === "string" &&
    typeof body.codeVerifier === "string" &&
    typeof body.redirectUri === "string"
      ? {
          code: body.code,
          state: body.state,
          codeVerifier: body.codeVerifier,
          redirectUri: body.redirectUri,
        }
      : null;
  if (!input) {
    return problem(400, "invalid_oauth_callback", "Invalid OAuth callback");
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const connection = await account.getConnectionForUser(
    connectionId,
    identity.userId,
  );
  if (!connection || connection.kind !== "tool") {
    return problem(404, "connection_not_found", "Connection not found");
  }
  const expectedState = await account.connectionOAuthStateHash(connection.id);
  if (
    !expectedState ||
    !constantTimeEqual(expectedState, await sha256(input.state))
  ) {
    return problem(401, "invalid_oauth_state", "OAuth state is invalid");
  }
  if (connection.provider !== "google") {
    return problem(400, "unsupported_provider", "Provider is not supported");
  }
  const config = googleConfig(env as Env & PlatformEnv);
  if (!config) {
    return problem(
      503,
      "provider_unavailable",
      "Google connections are not configured",
    );
  }
  try {
    const credential = await exchangeGoogleCode({
      config,
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
    });
    assertGoogleScopes(credential, connection.scopes);
    const googleIdentity = await resolveGoogleIdentity(credential);
    return json(
      await account.completeToolConnection({
        id: connection.id,
        externalAccountId: googleIdentity.id,
        displayName: googleIdentity.email,
        scopes: credential.scopes.length
          ? credential.scopes
          : connection.scopes,
        credential: JSON.stringify(credential),
      }),
    );
  } catch (error) {
    return problem(
      502,
      "connection_failed",
      error instanceof Error ? error.message : "Google connection failed",
    );
  }
}

async function managedConnectionStatus(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  service: string,
): Promise<Response> {
  const url = new URL(request.url);
  const requestedConnectionId = url.searchParams.get("connectionId");
  const label = connectionLabel(url.searchParams.get("label") ?? "default");
  if (!label) {
    return problem(
      400,
      "invalid_connection_label",
      "Connection aliases may contain letters, numbers, dots, dashes, and underscores",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const provider = providerForService(service);
  const cached = requestedConnectionId
    ? await account.getConnectionForUser(requestedConnectionId, identity.userId)
    : await account.findUserConnection(identity.userId, provider, label);
  if (!cached) {
    return problem(404, "connection_not_found", "Connection not found");
  }
  const configuration = composioConfigForService(
    env as Env & PlatformEnv,
    service,
    request.url,
  );
  if (!configuration) {
    return problem(
      503,
      "managed_connections_unavailable",
      "Managed connections are not configured",
    );
  }
  try {
    const userId = composioConnectionUserId(identity, cached.id);
    const connection =
      service === "github"
        ? await managedGithubConnection(configuration, userId)
        : service === "linear"
          ? await managedLinearConnection(configuration, userId)
          : await managedGoogleConnection(configuration, userId, service);
    if (connection.status === "connected" && connection.connectedAccountId) {
      await account.upsertManagedToolConnection({
        id: cached.id,
        provider,
        label: cached.label,
        ownerUserId: identity.userId,
        externalAccountId: connection.connectedAccountId,
        displayName: connection.displayName,
        scopes: connection.scopes,
      });
    }
    return json({
      ...connection,
      connectionId: cached.id,
      label: cached.label,
    });
  } catch (error) {
    if (cached?.status === "connected" && cached.externalAccountId) {
      return json({
        connectionId: cached.id,
        label: cached.label,
        service,
        toolkit: service,
        scopes: cached.scopes,
        status: "connected",
        connectedAccountId: cached.externalAccountId,
      });
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "managed_connection.lookup_failed",
        service,
        message: error instanceof Error ? error.message : "Connection failed",
      }),
    );
    return problem(
      502,
      "managed_connection_failed",
      error instanceof Error ? error.message : "Connection lookup failed",
    );
  }
}

async function linkManagedConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const body = await readJson(request);
  const service = typeof body?.service === "string" ? body.service : "";
  const reconnect = body?.reconnect === true;
  const label = connectionLabel(body?.label);
  if (!label) {
    return problem(
      400,
      "invalid_connection_label",
      "Connection aliases may contain letters, numbers, dots, dashes, and underscores",
    );
  }
  const provider = providerForService(service);
  const configuration = composioConfigForService(
    env as Env & PlatformEnv,
    service,
    request.url,
  );
  if (!configuration) {
    return problem(
      503,
      "managed_connections_unavailable",
      `Managed connections are not configured for ${service || "this service"}`,
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const existing = await account.findUserConnection(
    identity.userId,
    provider,
    label,
  );
  const connectionId = existing?.id ?? crypto.randomUUID();
  // Name the connection this link resolves, so the provider's callback can
  // record the result instead of leaving the row `pending` until something
  // else happens to look. These identifiers are not secret — the provider is
  // already given both as its user_id — and the callback verifies with the
  // provider rather than believing the query string, so a forged call can
  // only trigger a re-check.
  const linkConfiguration = {
    ...configuration,
    callbackUrl: callbackUrlForConnection(
      configuration.callbackUrl,
      identity.accountId,
      connectionId,
    ),
  };
  try {
    const userId = composioConnectionUserId(identity, connectionId);
    if (reconnect && existing) {
      if (provider === "github") {
        await disconnectManagedGithubConnection(configuration, userId);
      } else if (provider === "linear") {
        await disconnectManagedLinearConnection(configuration, userId);
      } else {
        await disconnectManagedGoogleConnection(
          configuration,
          userId,
          service,
        );
      }
      await account.upsertManagedToolConnection({
        id: existing.id,
        provider: existing.provider,
        label: existing.label,
        ownerUserId: existing.ownerUserId,
        scopes: existing.scopes,
        status: "pending",
        expiresAt: managedConnectionExpiry(undefined),
      });
    }
    const connection =
      service === "github"
        ? await linkManagedGithubConnection(linkConfiguration, userId)
        : service === "linear"
          ? await linkManagedLinearConnection(linkConfiguration, userId)
          : await linkManagedGoogleConnection(
              linkConfiguration,
              userId,
              service,
            );
    await account.upsertManagedToolConnection({
      id: connectionId,
      provider,
      label,
      ownerUserId: identity.userId,
      externalAccountId: connection.connectedAccountId,
      displayName: connection.displayName,
      scopes: connection.scopes,
      status: connection.status,
      expiresAt:
        connection.status === "pending"
          ? managedConnectionExpiry(connection.expiresAt)
          : undefined,
    });
    return json({ ...connection, connectionId, label }, 201);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "managed_connection.link_failed",
        service,
        authConfigId: configuration.authConfigId ?? null,
        message: error instanceof Error ? error.message : "Connection failed",
      }),
    );
    return problem(
      502,
      "managed_connection_failed",
      error instanceof Error ? error.message : "Connection failed",
    );
  }
}

async function disconnectManagedConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  service: string,
): Promise<Response> {
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) {
    return problem(
      400,
      "connection_id_required",
      "A connection ID is required",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const stored = await account.getConnectionForUser(
    connectionId,
    identity.userId,
  );
  if (!stored || !["google", "github", "linear"].includes(stored.provider)) {
    return problem(404, "connection_not_found", "Connection not found");
  }
  const configuration = composioConfigForService(
    env as Env & PlatformEnv,
    service,
    request.url,
  );
  if (!configuration) {
    return problem(
      503,
      "managed_connections_unavailable",
      `Managed connections are not configured for ${service || stored.provider}`,
    );
  }
  // Revoking withdraws consent for the whole application at the provider, so
  // it takes every connection sharing that external account with it. Someone
  // who connected two mailboxes from one Google account would lose both by
  // removing one. Revoke only when nothing else is using it.
  const siblings = stored.externalAccountId
    ? (await account.listConnections(identity.userId)).filter(
        (candidate: Connection) =>
          candidate.id !== connectionId &&
          candidate.kind === "tool" &&
          candidate.externalAccountId === stored.externalAccountId,
      )
    : [];
  const revoke = siblings.length === 0;
  try {
    const userId = composioConnectionUserId(identity, connectionId);
    const connection =
      stored.provider === "github"
        ? await disconnectManagedGithubConnection(configuration, userId, {
            revoke,
          })
        : stored.provider === "linear"
          ? await disconnectManagedLinearConnection(configuration, userId, {
              revoke,
            })
          : await disconnectManagedGoogleConnection(
              configuration,
              userId,
              service,
              { revoke },
            );
    await account.removeConnection(connectionId);
    return json({ ...connection, connectionId, label: stored.label });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "managed_connection.disconnect_failed",
        service,
        message: error instanceof Error ? error.message : "Disconnect failed",
      }),
    );
    return problem(
      502,
      "managed_connection_disconnect_failed",
      error instanceof Error ? error.message : "Connection disconnect failed",
    );
  }
}

async function proxyManagedConnection(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const body = await readJson(request);
  const input: ConnectionRequestInput | null =
    typeof body?.service === "string" && typeof body.path === "string"
      ? {
          service: body.service,
          label: typeof body.label === "string" ? body.label : undefined,
          method: typeof body.method === "string" ? body.method : undefined,
          path: body.path,
          headers:
            body.headers &&
            typeof body.headers === "object" &&
            !Array.isArray(body.headers)
              ? (body.headers as Record<string, string>)
              : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
        }
      : null;
  if (!input) {
    return problem(400, "invalid_connection_request", "Invalid API request");
  }
  input.service = connectionService(input.service);
  const provider = providerForService(input.service);
  const configuration = composioConfigForService(
    env as Env & PlatformEnv,
    input.service,
    request.url,
  );
  if (!configuration) {
    return problem(
      503,
      "managed_connections_unavailable",
      `Managed connections are not configured for ${input.service}`,
    );
  }
  let requestedLabel: string | undefined;
  if (input.label !== undefined) {
    const normalizedLabel = connectionLabel(input.label);
    if (!normalizedLabel) {
      return problem(
        400,
        "invalid_connection_label",
        "Connection alias is invalid",
      );
    }
    requestedLabel = normalizedLabel;
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  // The computer uses only what people granted it (work 080), never a
  // person's own connections.
  const computer = identity.principal === COMPUTER_PRINCIPAL;
  const connections = computer
    ? await computerGrantedConnections(env, identity, input.service, requestedLabel)
    : requestedLabel
    ? [
        await account.findUserConnection(
          identity.userId,
          provider,
          requestedLabel,
        ),
      ].filter((connection): connection is Connection => connection !== null)
    : await account.listConnections(identity.userId);
  const selection =
    provider === "google"
      ? selectManagedGoogleConnection(
          connections,
          input.service,
          requestedLabel,
        )
      : selectManagedProviderConnection(connections, provider, requestedLabel);
  if (selection.kind === "alias_required") {
    return problem(
      409,
      "connection_alias_required",
      `Multiple ${input.service} connections are available. Specify one of: ${selection.labels.join(", ")}`,
    );
  }
  if (selection.kind === "not_found") {
    return problem(
      404,
      "connection_not_found",
      (requestedLabel
        ? `No ${input.service} connection named ${requestedLabel} is connected`
        : `No ${input.service} connection is connected`) +
        (computer ? `. ${COMPUTER_GRANT_HINT}` : ""),
    );
  }
  const stored = selection.connection;
  try {
    return json(
      provider === "github"
        ? await proxyManagedGithubAccountRequest(
            configuration,
            stored.externalAccountId,
            input,
          )
        : provider === "linear"
          ? await proxyManagedLinearAccountRequest(
              configuration,
              stored.externalAccountId,
              input,
            )
          : await proxyManagedGoogleAccountRequest(
              configuration,
              stored.externalAccountId,
              input,
            ),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Connection request failed";
    console.error(
      JSON.stringify({
        level: "error",
        event: "managed_connection.proxy_failed",
        service: input.service,
        method: input.method ?? "GET",
        path: input.path,
        message,
      }),
    );
    return problem(
      message.includes("is not connected") ? 404 : 502,
      message.includes("is not connected")
        ? "connection_not_found"
        : "connection_request_failed",
      message,
    );
  }
}

async function proxyConnectionRequest(
  request: Request,
  env: Env,
  sessionId: string,
  provider: string,
): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  const session = env.SESSIONS.getByName(sessionId);
  if (!token || !(await session.authenticateRuntimeToken(token))) {
    return problem(401, "invalid_runtime_token", "Runtime token is invalid");
  }
  const snapshot = await session.snapshot();
  if (snapshot.status === "ended" || snapshot.status === "failed") {
    return problem(409, "session_not_active", "Session is not active");
  }
  const body = await readJson(request);
  const input: ConnectionRequestInput | null =
    typeof body?.service === "string" && typeof body.path === "string"
      ? {
          service: body.service,
          label: typeof body.label === "string" ? body.label : undefined,
          method: typeof body.method === "string" ? body.method : undefined,
          path: body.path,
          headers:
            body.headers &&
            typeof body.headers === "object" &&
            !Array.isArray(body.headers)
              ? (body.headers as Record<string, string>)
              : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
        }
      : null;
  if (!input) {
    return problem(400, "invalid_connection_request", "Invalid API request");
  }
  const requestedLabel = requestedConnectionLabel(input.label);
  if (input.label !== undefined && !requestedLabel) {
    return problem(
      400,
      "invalid_connection_label",
      "Connection aliases may contain letters, numbers, dots, dashes, and underscores",
    );
  }
  const account = env.ACCOUNTS.getByName(snapshot.accountId);
  // A session a Linear connection owns (design 018) calls Linear as that
  // connection's app user and never resolves a person's grant.
  const linearOwner = parseLinearConnectionPrincipal(snapshot.userId);
  if (linearOwner && provider === "linear") {
    return linearConnectionServiceRequest(env, snapshot, linearOwner.connectionId, input);
  }
  // Project attachments are service credentials, not session-principal grants.
  // Only a deployment which declared the exact service may consume them. The
  // principal remains the actor recorded on the session and in audit logs.
  const deployment = await account.getDeployment(snapshot.deploymentId);
  const declaresService = deployment?.connections.some(
    (service: string) => connectionService(service) === input.service,
  );
  const projectAttachments =
    snapshot.projectId && declaresService
      ? await account.listProjectServiceAttachments(snapshot.projectId, input.service)
      : [];
  if (projectAttachments.length > 0) {
    const attachedConnections = projectAttachments.map(
      (attachment: ProjectServiceAttachment) => attachment.connection,
    );
    const selection =
      provider === "google"
        ? selectManagedGoogleConnection(
            attachedConnections,
            input.service,
            requestedLabel ?? undefined,
          )
        : selectManagedProviderConnection(
            attachedConnections,
            provider,
            requestedLabel ?? undefined,
          );
    if (selection.kind === "alias_required") {
      return problem(
        409,
        "connection_alias_required",
        `Multiple ${input.service} project connections are available. Specify one of: ${selection.labels.join(", ")}`,
      );
    }
    if (selection.kind === "not_found") {
      return problem(
        404,
        "connection_not_found",
        `No connected ${input.service} project connection${requestedLabel ? ` named ${requestedLabel}` : ""} is available`,
      );
    }
    const configuration = composioConfigForService(
      env as Env & PlatformEnv,
      input.service,
      request.url,
    );
    if (!configuration) {
      return problem(
        503,
        "managed_connections_unavailable",
        `Managed connections are not configured for ${input.service}`,
      );
    }
    try {
      return json(
        provider === "github"
          ? await proxyManagedGithubAccountRequest(
              configuration,
              selection.connection.externalAccountId,
              { ...input, service: "github" },
            )
          : provider === "linear"
            ? await proxyManagedLinearAccountRequest(
                configuration,
                selection.connection.externalAccountId,
                { ...input, service: "linear" },
              )
            : await proxyManagedGoogleAccountRequest(
                configuration,
                selection.connection.externalAccountId,
                input,
              ),
      );
    } catch (error) {
      return problem(
        502,
        "connection_request_failed",
        error instanceof Error ? error.message : "Connection request failed",
      );
    }
  }
  const stored = await account.connectionSecretForDeployment({
    provider,
    deploymentId: snapshot.deploymentId,
    ownerUserId: snapshot.userId,
    label: requestedLabel,
  });
  if (!stored && provider === "google") {
    const label = requestedLabel;
    let managed = label
      ? await account.findUserConnection(snapshot.userId, "google", label)
      : null;
    const configuration = composioGoogleConfig(
      env as Env & PlatformEnv,
      input.service,
      request.url,
    );
    if (managed && managed.status !== "connected" && configuration) {
      try {
        const refreshed = await managedGoogleConnection(
          configuration,
          composioConnectionUserId(
            {
              kind: "user",
              accountId: snapshot.accountId,
              userId: snapshot.userId,
            },
            managed.id,
          ),
          input.service,
        );
        if (refreshed.status === "connected" && refreshed.connectedAccountId) {
          managed = await account.upsertManagedToolConnection({
            id: managed.id,
            provider: "google",
            label: managed.label,
            ownerUserId: snapshot.userId,
            externalAccountId: refreshed.connectedAccountId,
            displayName: refreshed.displayName,
            scopes: refreshed.scopes,
            status: refreshed.status,
          });
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "managed_connection.refresh_failed",
            sessionId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (
      managed?.status === "connected" &&
      managed.externalAccountId &&
      configuration
    ) {
      try {
        return json(
          await proxyManagedGoogleAccountRequest(
            configuration,
            managed.externalAccountId,
            input,
          ),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "managed_connection.proxy_failed",
            sessionId,
            service: input.service,
            method: input.method ?? "GET",
            path: input.path,
            message:
              error instanceof Error
                ? error.message
                : "Connection request failed",
          }),
        );
        return problem(
          502,
          "connection_request_failed",
          error instanceof Error ? error.message : "Connection request failed",
        );
      }
    }
  }
  if (!stored && provider === "github") {
    const label = requestedLabel;
    const connections = label
      ? [
          await account.findUserConnection(snapshot.userId, "github", label),
        ].filter((connection): connection is Connection => connection !== null)
      : await account.listConnections(snapshot.userId);
    let selection = selectManagedProviderConnection(
      connections,
      "github",
      label ?? undefined,
    );
    const configuration = composioGithubConfig(
      env as Env & PlatformEnv,
      request.url,
    );
    if (selection.kind === "alias_required") {
      return problem(
        409,
        "connection_alias_required",
        `Multiple github connections are available. Specify one of: ${selection.labels.join(", ")}`,
      );
    }
    if (selection.kind === "not_found" && label && configuration) {
      const pending = await account.findUserConnection(
        snapshot.userId,
        "github",
        label,
      );
      if (pending) {
        try {
          const refreshed = await managedGithubConnection(
            configuration,
            composioConnectionUserId(
              {
                kind: "user",
                accountId: snapshot.accountId,
                userId: snapshot.userId,
              },
              pending.id,
            ),
          );
          if (
            refreshed.status === "connected" &&
            refreshed.connectedAccountId
          ) {
            const connected = await account.upsertManagedToolConnection({
              id: pending.id,
              provider: "github",
              label: pending.label,
              ownerUserId: snapshot.userId,
              externalAccountId: refreshed.connectedAccountId,
              scopes: refreshed.scopes,
              status: "connected",
            });
            selection = {
              kind: "selected",
              connection: connected as Connection & {
                externalAccountId: string;
              },
            };
          }
        } catch {
          // The normal connection-not-found response below includes a reconnect URL.
        }
      }
    }
    if (selection.kind === "selected" && configuration) {
      try {
        return json(
          await proxyManagedGithubAccountRequest(
            configuration,
            selection.connection.externalAccountId,
            { ...input, service: "github" },
          ),
        );
      } catch (error) {
        return problem(
          502,
          "connection_request_failed",
          error instanceof Error ? error.message : "GitHub request failed",
        );
      }
    }
  }
  if (!stored && provider === "linear") {
    const label = requestedLabel;
    const connections = label
      ? [
          await account.findUserConnection(snapshot.userId, "linear", label),
        ].filter((connection): connection is Connection => connection !== null)
      : await account.listConnections(snapshot.userId);
    let selection = selectManagedProviderConnection(
      connections,
      "linear",
      label ?? undefined,
    );
    const configuration = composioLinearConfig(
      env as Env & PlatformEnv,
      request.url,
    );
    if (selection.kind === "alias_required") {
      return problem(
        409,
        "connection_alias_required",
        `Multiple linear connections are available. Specify one of: ${selection.labels.join(", ")}`,
      );
    }
    if (selection.kind === "not_found" && label && configuration) {
      const pending = await account.findUserConnection(
        snapshot.userId,
        "linear",
        label,
      );
      if (pending) {
        try {
          const refreshed = await managedLinearConnection(
            configuration,
            composioConnectionUserId(
              {
                kind: "user",
                accountId: snapshot.accountId,
                userId: snapshot.userId,
              },
              pending.id,
            ),
          );
          if (
            refreshed.status === "connected" &&
            refreshed.connectedAccountId
          ) {
            const connected = await account.upsertManagedToolConnection({
              id: pending.id,
              provider: "linear",
              label: pending.label,
              ownerUserId: snapshot.userId,
              externalAccountId: refreshed.connectedAccountId,
              scopes: refreshed.scopes,
              status: "connected",
            });
            selection = {
              kind: "selected",
              connection: connected as Connection & {
                externalAccountId: string;
              },
            };
          }
        } catch {
          // The normal connection-not-found response below includes a reconnect URL.
        }
      }
    }
    if (selection.kind === "selected" && configuration) {
      try {
        return json(
          await proxyManagedLinearAccountRequest(
            configuration,
            selection.connection.externalAccountId,
            { ...input, service: "linear" },
          ),
        );
      } catch (error) {
        return problem(
          502,
          "connection_request_failed",
          error instanceof Error ? error.message : "Linear request failed",
        );
      }
    }
  }
  if (!stored) {
    const connection =
      input.service || (provider === "google" ? "gmail" : provider);
    const label = requestedLabel;
    const connectUrl = connectionPageUrl(
      env as Env & PlatformEnv,
      connection,
      label ?? "default",
    );
    return problem(
      404,
      "connection_not_found",
      `No ${connection} connection${label ? ` named ${label}` : ""} is available. ` +
        `Connect one with \`opencomputer connection add ${connection}${label ? ` --alias ${label}` : ""}\`.` +
        (connectUrl ? ` Or visit ${connectUrl}.` : ""),
    );
  }
  if (provider !== "google") {
    return problem(400, "unsupported_provider", "Provider is not supported");
  }
  const config = googleConfig(env as Env & PlatformEnv);
  if (!config) {
    return problem(
      503,
      "provider_unavailable",
      "Google connections are not configured",
    );
  }
  let credential = JSON.parse(stored.credential) as OAuthCredential;
  const refreshed = await refreshGoogleCredential(config, credential);
  if (refreshed !== credential) {
    credential = refreshed;
    await account.updateConnectionCredential(
      stored.connection.id,
      JSON.stringify(credential),
    );
  }
  return json(await requestGoogleApi(credential, input));
}

async function linearConnectionServiceRequest(
  env: Env,
  snapshot: Pick<SessionSnapshot, "accountId" | "deploymentId" | "projectId" | "environment" | "agentId">,
  connectionId: string,
  input: ConnectionRequestInput,
): Promise<Response> {
  const account = env.ACCOUNTS.getByName(snapshot.accountId);
  const deployment = await account.getDeployment(snapshot.deploymentId);
  if (!deployment?.connections.includes("linear")) {
    return problem(409, "connection_not_declared", "linear is not declared by this deployed agent");
  }
  const result = await account.linearServiceRequest(connectionId, {
    method: input.method,
    path: input.path,
    body: input.body,
    session: {
      projectId: snapshot.projectId,
      ...(snapshot.environment ? { environment: snapshot.environment } : {}),
      agentId: snapshot.agentId,
    },
  });
  return result.outcome === "response"
    ? json(result.response)
    : problem(result.status, result.code, result.message);
}

function slackEventValue(data: Record<string, unknown>, key: string): unknown {
  const message =
    data.message && typeof data.message === "object"
      ? (data.message as Record<string, unknown>)
      : null;
  return data[key] ?? message?.[key];
}

function slackEventText(data: Record<string, unknown>): string | null {
  if (typeof data.message === "string") return data.message.trim() || null;
  const value = slackEventValue(data, "text");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function slackEventString(
  data: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = slackEventValue(data, key);
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function isSlackBotEvent(data: Record<string, unknown>): boolean {
  const sender =
    data.sender && typeof data.sender === "object"
      ? (data.sender as Record<string, unknown>)
      : null;
  return Boolean(
    slackEventValue(data, "bot_id") ||
    slackEventValue(data, "subtype") === "bot_message" ||
    sender?.is_bot === true ||
    sender?.isBot === true,
  );
}


/**
 * Everything that happens between "a person said something on a channel" and
 * "a turn is queued": find the conversation, resume or create its session,
 * choose the agent when several are registered, and enqueue.
 *
 * None of it is provider-specific. What the caller supplies is the normalized
 * message and how to deliver a reply; what stays outside is the parsing,
 * signature checking and progress reporting that only one provider knows how
 * to do.
 */
interface ChannelTurnInput {
  requestUrl: string;
  env: Env;
  context: ExecutionContext;
  accountId: string;
  connection: {
    id: string;
    agentId: string;
    alias: string;
    channelId: string;
  };
  provider: string;
  message: InboundChannelMessage;
  /** Which registration trigger this arrival satisfies. */
  trigger: "mention" | "direct-message" | "message";
  /** The prompt as the agent sees it, with any provider decoration removed. */
  text: string;
  /** Prefixed for the transcript, e.g. who spoke and where. */
  transcriptInput: string;
  /** Told to the person when several agents could answer and none was named. */
  onAmbiguousAgent: (options: string[]) => Promise<void>;
  /**
   * The provider's time for the message (a Slack `ts`, as ISO). Decides
   * answer versus steering while a holding question is open (design 018);
   * a Slack question does not hold, so there it is recorded, not compared.
   */
  providerTime?: string;
}

/** How long the declared channel says to hold the runtime after a message. */
function channelIdleSeconds(
  projectDeployment: ProjectDeploymentReference | undefined,
  channelId: string,
): number | undefined {
  const declared = projectDeployment?.resources.channels.find(
    (channel) => channel.id === channelId,
  ) as { idle?: { suspendAfterSeconds?: number } } | undefined;
  const seconds = declared?.idle?.suspendAfterSeconds;
  return typeof seconds === "number" && seconds > 0 ? seconds : undefined;
}

async function startChannelTurn(input: ChannelTurnInput): Promise<void> {
  const { env, context, connection, message } = input;
  const account = env.ACCOUNTS.getByName(input.accountId);
  const project = await account.projectForAgent(connection.agentId);
  if (project?.archivedAt) return;
  const principalUserId = await channelPrincipalId(
    input.provider,
    input.accountId,
    connection.id,
    message.externalUserId,
  );
  const identity: RequestIdentity = {
    kind: "user",
    userId: principalUserId,
    accountId: input.accountId,
  };

  let sessionId = await account.getChannelThreadSession(
    connection.id,
    message.conversationKey,
  );
  let session = sessionId ? env.SESSIONS.getByName(sessionId) : null;
  if (session) {
    const snapshot = await session.snapshot();
    if (
      snapshot.userId !== principalUserId ||
      snapshot.status === "ended" ||
      snapshot.status === "failed" ||
      snapshot.microvmState === "terminated"
    ) {
      session = null;
      sessionId = null;
    } else if (snapshot.microvmState === "suspended") {
      const resumed = await changeRuntimeState(env, identity, session, "resume");
      if (!resumed.ok) throw new Error("Could not resume the channel session");
    }
  }

  if (!session) {
    let selectedAgent = connection.agentId;
    const activeDeployment = await account.resolveDeployment(
      `${connection.agentId}@${connection.alias}`,
    );
    const projectDeployment = activeDeployment?.projectDeployment as
      | ProjectDeploymentReference
      | undefined;
    if (projectDeployment) {
      const eligible = projectDeployment.resources.channelRegistrations
        .filter(
          (registration) =>
            registration.channelId === connection.channelId &&
            registration.triggers.includes(input.trigger),
        )
        .map((registration) => registration.agentId);
      if (eligible.length === 1) {
        selectedAgent =
          projectDeployment.agents.find(
            (agent) => agent.localId === eligible[0],
          )?.agentId ?? selectedAgent;
      } else if (eligible.length > 1) {
        const normalized = input.text.toLowerCase();
        const selected = eligible.filter((agentId) =>
          new RegExp(`(^|[^a-z0-9-])${agentId}([^a-z0-9-]|$)`).test(normalized),
        );
        if (selected.length !== 1) {
          await input.onAmbiguousAgent(eligible);
          return;
        }
        selectedAgent =
          projectDeployment.agents.find(
            (agent) => agent.localId === selected[0],
          )?.agentId ?? selectedAgent;
      }
    }
    const createdResponse = await createSession(
      new Request(new URL("/v1/sessions", input.requestUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: `${selectedAgent}@${connection.alias}`,
          source: "channel",
        }),
      }),
      env,
      identity,
      context,
    );
    if (!createdResponse.ok) {
      throw new Error(
        `Could not create the channel session (${createdResponse.status})`,
      );
    }
    const created = (await createdResponse.json()) as InitializeSessionResult;
    sessionId = created.session.id;
    session = env.SESSIONS.getByName(sessionId);
    await account.setChannelThreadSession(
      connection.id,
      message.conversationKey,
      sessionId,
    );
  }

  const activeDeployment = await account.resolveDeployment(
    `${connection.agentId}@${connection.alias}`,
  );
  await session.enqueueChannelTurn(
    {
      input: input.transcriptInput,
      agentInput: {
        source: "channel",
        text: input.text,
        // The provider's own identifiers, passed through unchanged. An agent
        // behind a single workspace ignores them; an agent behind many reads
        // the tenant off them. Session ownership stays keyed by
        // `principalUserId` above, which is a one-way hash of the same facts —
        // these are for the agent to use, that is for keeping sessions apart.
        channel: {
          provider: input.provider,
          connectionId: connection.id,
          ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}),
          ...(message.conversationId
            ? { conversationId: message.conversationId }
            : {}),
          ...(message.externalUserId ? { userId: message.externalUserId } : {}),
        },
      },
      idempotencyKey: `${input.provider}:${message.id}`,
      ...(input.providerTime ? { providerTime: input.providerTime } : {}),
    },
    {
      provider: input.provider,
      connectionId: connection.id,
      externalUserId: message.externalUserId,
      deliveryRef: message.replyTarget,
      ...(() => {
        const seconds = channelIdleSeconds(
          activeDeployment?.projectDeployment as
            | ProjectDeploymentReference
            | undefined,
          connection.channelId,
        );
        return seconds ? { idleSuspendSeconds: seconds } : {};
      })(),
    },
  );
}

async function processSlackEvent(
  requestUrl: string,
  env: Env,
  context: ExecutionContext,
  accountId: string,
  connectionId: string,
  event: RawSlackEvent,
): Promise<void> {
  const account = env.ACCOUNTS.getByName(accountId);
  const connection = await account.getSlackConnection(connectionId);
  if (
    !connection ||
    connection.status !== "connected" ||
    isSlackBotEvent(event.data)
  ) {
    return;
  }
  const text = slackEventText(event.data);
  const channelId = slackEventString(event.data, "channel_id", "channel");
  const messageTimestamp = slackEventString(event.data, "timestamp", "ts");
  const threadTimestamp =
    slackEventString(event.data, "thread_ts", "thread_timestamp") ??
    messageTimestamp;
  const eventType = slackEventString(event.data, "type");
  const channelType = slackEventString(event.data, "channel_type");
  const externalUserId =
    slackEventString(event.data, "user") ??
    (event.data.sender &&
    typeof event.data.sender === "object" &&
    typeof (event.data.sender as Record<string, unknown>).id === "string"
      ? ((event.data.sender as Record<string, unknown>).id as string)
      : null);
  if (
    !text ||
    !channelId ||
    !threadTimestamp ||
    !externalUserId ||
    (eventType !== "app_mention" &&
      !(eventType === "message" && channelType === "im"))
  ) {
    return;
  }
  if (!(await account.claimChannelEvent(event.id))) return;
  await account.recordSlackEvent(connection.id);

  let phase = "progress";
  try {
    try {
      await account.setSlackStatus(connection.id, {
        channelId,
        threadTimestamp,
        status: { status: "Thinking..." },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "slack.progress_start_failed",
          connectionId: connection.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const names: { userName?: string; channelName?: string } = await account
      .resolveSlackNames(connection.id, {
        userId: externalUserId,
        // Direct messages have no conversation name to look up.
        ...(channelType === "im" ? {} : { channelId }),
      })
      .catch((): { userName?: string; channelName?: string } => ({}));
    const sender =
      event.data.sender && typeof event.data.sender === "object"
        ? (event.data.sender as Record<string, unknown>)
        : null;
    const senderName =
      (names.userName ? `${names.userName} (${externalUserId})` : null) ??
      (typeof sender?.name === "string" ? sender.name : null) ??
      (typeof sender?.id === "string" ? sender.id : null) ??
      (slackEventString(event.data, "user") ?? "Slack user");
    const channelLabel =
      channelType === "im"
        ? "a direct message"
        : names.channelName
          ? `#${names.channelName} (${channelId})`
          : channelId;
    phase = "session_turn";
    await startChannelTurn({
      requestUrl,
      env,
      context,
      accountId,
      connection: {
        id: connection.id,
        agentId: connection.agentId,
        alias: connection.alias,
        channelId: connection.channelId,
      },
      provider: "slack",
      message: {
        id: event.id,
        externalUserId,
        // The key that existing conversations are already bound under.
        conversationKey: `${externalUserId}:${threadTimestamp}`,
        // The thread is the conversation an agent keys its work by; the
        // team is the tenant. Both reach the agent as `channel.*`.
        conversationId: threadTimestamp,
        ...(connection.teamId ? { workspaceId: connection.teamId } : {}),
        replyTarget: { channelId, threadTimestamp },
        scope: {},
        data: event.data,
        text,
      },
      trigger: eventType === "app_mention" ? "mention" : "direct-message",
      // The message's own Slack time, recorded with the turn. A Slack
      // question does not hold (`questionMode: "flow"`): a typed message
      // runs as an ordinary turn whatever its time; only a consult holds.
      ...(() => {
        const providerTime = slackTimestampIso(messageTimestamp);
        return providerTime ? { providerTime } : {};
      })(),
      text: text.replace(/^<@[^>]+>\s*/, "").trim(),
      transcriptInput:
        `[Slack message from ${senderName} in ${channelLabel}]\n\n` +
        text.replace(/^<@[^>]+>\s*/, "").trim(),
      onAmbiguousAgent: async (options) => {
        await account.postSlackReply(connection.id, {
          channelId,
          threadTimestamp,
          text:
            "Which agent should handle this? Reply with one of: " +
            options.map((agentId) => `\`${agentId}\``).join(", "),
        });
      },
    });
  } catch (error) {
    await account.recordSlackError(connection.id, `ingress_${phase}_failed`);
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack.channel_event_failed",
        phase,
        connectionId: connection.id,
        slackEventId: event.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    await account
      .postSlackReply(connection.id, {
        channelId,
        threadTimestamp,
        text: "OpenComputer could not start this request. Please try again.",
      })
      .catch(() => undefined);
    await account.releaseChannelEvent(event.id);
    throw error;
  }
}

/**
 * Twilio delivers three different things to three paths, matching the three
 * fields its console asks for. Splitting them means each endpoint knows what it
 * is parsing instead of sniffing a payload, and the voice leg — the only one
 * that answers with TwiML rather than an acknowledgement — stays separate from
 * the rest.
 */
/**
 * A missed call is only worth as much as what the caller said. Without the
 * voicemail the first text is a generic apology; with it the agent can open by
 * naming the problem, which is most of the difference in whether anyone
 * replies. Failure returns null rather than throwing: an unreadable voicemail
 * is a worse first text, not a lost lead.
 */
async function transcribeVoicemail(
  env: Env,
  account: DurableObjectStub<AccountDurableObject>,
  connectionId: string,
  recordingUrl: string,
): Promise<string | null> {
  const ai = (env as Env & { AI?: { run(model: string, input: unknown): Promise<unknown> } }).AI;
  if (!ai) return null;
  try {
    const credential = await account.twilioCredential(connectionId);
    if (!credential) return null;
    const audio = await fetchRecording(recordingUrl, credential);
    return await transcribeRecording(ai, audio);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "twilio.transcription_failed",
        connectionId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

async function receiveTwilioWebhook(
  request: Request,
  env: Env,
  context: ExecutionContext,
  connectionId: string,
  webhookToken: string,
  kind: "sms" | "voice" | "recording",
): Promise<Response> {
  const routeAccount = env.ACCOUNTS.getByName(
    channelRouteName("twilio", connectionId),
  );
  const route = await routeAccount.getChannelRoute();
  const tokenMatches = route
    ? await timingSafeEqualHex(route.webhookTokenHash, await sha256(webhookToken))
    : false;
  if (!route || route.connectionId !== connectionId || !tokenMatches) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "twilio.webhook_route_rejected",
        connectionId,
        kind,
        routeFound: Boolean(route),
      }),
    );
    return problem(401, "invalid_webhook_token", "Invalid webhook token");
  }

  const payload = await request.text();
  const account = env.ACCOUNTS.getByName(route.accountId);
  const signatureValid = await account.verifyChannelRequest(
    "twilio",
    connectionId,
    {
      payload,
      headers: Object.fromEntries(request.headers),
      url: request.url,
    },
  );
  if (!signatureValid) {
    return problem(401, "invalid_twilio_signature", "Invalid Twilio signature");
  }

  if (kind === "voice") {
    // The caller is on the line. Answer, greet, record — never acknowledge and
    // hang up, which is what silence here would do to them.
    const recordingCallbackUrl = new URL(
      `/v1/webhooks/twilio/${encodeURIComponent(connectionId)}/${webhookToken}/recording`,
      request.url,
    ).toString();
    return new Response(
      voicemailPrompt({
        recordingCallbackUrl,
        greeting: DEFAULT_VOICEMAIL_GREETING,
      }),
      { headers: { "content-type": "text/xml; charset=utf-8" } },
    );
  }

  if (kind === "recording") {
    const recording = parseRecording(payload);
    if (!recording) return new Response(null, { status: 204 });
    const connection = await account.getChannelConnection(connectionId);
    if (connection && (await account.claimChannelEvent(recording.callSid))) {
      // Keyed on the caller's number, the same key an inbound text uses, so a
      // voicemail and the texts that follow it are one conversation rather
      // than two. The caller hung up before this fired, so transcribing first
      // costs a few seconds and buys a first text that names their problem.
      context.waitUntil(
        (async () => {
          const transcript = recording.recordingUrl
            ? await transcribeVoicemail(env, account, connectionId, recording.recordingUrl)
            : null;
          await startChannelTurn({
            requestUrl: request.url,
            env,
            context,
            accountId: route.accountId,
            connection: {
              id: connectionId,
              agentId: connection.agentId,
              alias: connection.alias,
              channelId: connection.channelId,
            },
            provider: "twilio",
            message: {
              id: recording.callSid,
              externalUserId: recording.from,
              conversationKey: recording.from,
              replyTarget: { to: recording.from, from: recording.to },
              scope: {},
              data: { callSid: recording.callSid },
              ...(transcript ? { text: transcript } : {}),
            },
            trigger: "message",
            text: transcript ?? "",
            transcriptInput: transcript
              ? `[Missed call from ${recording.from}. They left a voicemail:]\n\n${transcript}`
              : `[Missed call from ${recording.from}. No message was left.]`,
            onAmbiguousAgent: async () => undefined,
          });
        })().catch(async (error: unknown) => {
          await account.releaseChannelEvent(recording.callSid).catch(() => undefined);
          console.error(
            JSON.stringify({
              level: "error",
              event: "twilio.voicemail_failed",
              connectionId,
              callSid: recording.callSid,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }),
      );
    }
    // Twilio expects an empty TwiML document here, not JSON: this response
    // still controls a live call, and anything else is read as an error.
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
      headers: { "content-type": "text/xml; charset=utf-8" },
    });
  }

  const adapter = channelAdapter("twilio");
  if (!adapter) {
    return problem(503, "provider_unavailable", "Provider is not available");
  }
  const message = adapter.parseInbound(payload, request.headers);
  // A status callback or an empty body is not an error — answering with one
  // makes Twilio retry a delivery there was never anything to do with.
  if (!message) return new Response(null, { status: 204 });

  const connection = await account.getChannelConnection(connectionId);
  if (!connection || !adapter.matchesConnection(message, connection)) {
    return new Response(null, { status: 204 });
  }
  // Twilio redelivers on anything but a prompt 2xx, so the turn is started
  // after the response rather than before it.
  if (!(await account.claimChannelEvent(message.id))) {
    return new Response(null, { status: 204 });
  }
  context.waitUntil(
    startChannelTurn({
      requestUrl: request.url,
      env,
      context,
      accountId: route.accountId,
      connection: {
        id: connectionId,
        agentId: connection.agentId,
        alias: connection.alias,
        channelId: connection.channelId,
      },
      provider: "twilio",
      message,
      trigger: "message",
      text: message.text ?? "",
      transcriptInput: `[Text message from ${message.externalUserId}]\n\n${message.text ?? ""}`,
      onAmbiguousAgent: async (options) => {
        await account.sendChannelReply(
          "twilio",
          connectionId,
          message.replyTarget as Record<string, unknown>,
          "Which agent should handle this? Reply with one of: " +
            options.join(", "),
        );
      },
    }).catch(async (error: unknown) => {
      await account.releaseChannelEvent(message.id).catch(() => undefined);
      console.error(
        JSON.stringify({
          level: "error",
          event: "twilio.turn_failed",
          connectionId,
          messageId: message.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );
  return new Response(null, { status: 204 });
}

/**
 * Somebody clicked.
 *
 * A click is not a message: it names a record rather than continuing a
 * conversation, so it does not become a turn and does not go near
 * `startChannelTurn`.
 */
async function receiveSlackInteractivity(
  request: Request,
  env: Env,
  context: ExecutionContext,
  connectionId: string,
  webhookToken: string,
): Promise<Response> {
  const routeAccount = env.ACCOUNTS.getByName(
    channelRouteName("slack", connectionId),
  );
  const route = await routeAccount.getChannelRoute();
  const tokenMatches = route
    ? constantTimeEqual(route.webhookTokenHash, await sha256(webhookToken))
    : false;
  if (!route || route.connectionId !== connectionId || !tokenMatches) {
    return problem(401, "invalid_webhook_token", "Invalid webhook token");
  }

  // Interactivity is form-encoded with the payload in one field, unlike every
  // event Slack sends. The signature still covers the raw body.
  const payload = await request.text();
  const account = env.ACCOUNTS.getByName(route.accountId);
  const signatureValid = await account.verifyChannelRequest(
    "slack",
    connectionId,
    {
      payload,
      headers: Object.fromEntries(request.headers),
      url: request.url,
    },
  );
  if (!signatureValid) {
    return problem(401, "invalid_slack_signature", "Invalid Slack signature");
  }

  const encoded = new URLSearchParams(payload).get("payload");
  if (!encoded) return json({ ok: true });
  let body: unknown;
  try {
    body = JSON.parse(encoded) as unknown;
  } catch {
    return json({ ok: true });
  }

  const adapter = channelAdapter("slack");
  const answer = adapter?.parseQuestionAnswer?.(body, request.headers);
  if (answer) {
    const connection = await account.getSlackConnection(connectionId);
    if (!connection || !adapter?.matchesConnection(answer, connection)) {
      return json({ ok: true });
    }
    context.waitUntil(settleQuestionAnswer(env, route.accountId, connectionId, answer));
    return json({ ok: true });
  }
  const decision = adapter?.parseDecision?.(body, request.headers);
  // Every other button in the workspace reaches this URL too. Not ours is a
  // success, or Slack shows the user an error for something we do not own.
  if (!decision) return json({ ok: true });

  const connection = await account.getSlackConnection(connectionId);
  if (!connection || !adapter?.matchesConnection(decision, connection)) {
    return json({ ok: true });
  }

  context.waitUntil(
    settleDecision(env, context, route.accountId, connectionId, decision).catch(
      (error: unknown) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "approval.decision_failed",
            connectionId,
            approvalId: decision.approvalId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    ),
  );
  return json({ ok: true });
}

/**
 * Which session an approved write should run in.
 *
 * Pure on purpose. Choosing is a decision over a snapshot and every branch is
 * enumerable; running needs a microVM and cannot be exercised in a test. Welded
 * together, the testable half was hostage to the half that is not.
 */
export type ApplyTarget =
  | { kind: "use"; sessionId: string; userId: string }
  | { kind: "resume"; sessionId: string; userId: string }
  | { kind: "create" };

export function selectApplySession(
  approval: { sessionId?: string },
  snapshot: { status: string; microvmState: string; userId: string } | null,
): ApplyTarget {
  if (!approval.sessionId || !snapshot) return { kind: "create" };
  // A session that is over cannot be brought back, and a terminated runtime
  // has nothing left to send a frame to.
  if (
    snapshot.status === "ended" ||
    snapshot.status === "failed" ||
    snapshot.microvmState === "terminated"
  ) {
    return { kind: "create" };
  }
  // A runtime that is on its way down is not a runtime to send a write to.
  // Only `suspended` used to count, so a decision that arrived while the
  // session was winding down was dispatched into a runtime that stopped
  // mid-call: the egress went out, the answer came back to nobody, and the
  // approval sat in `applying` until the sweep gave up on it. Anything not
  // plainly running is resumed first, and a resume that fails falls through to
  // a fresh session.
  if (
    snapshot.microvmState === "suspended" ||
    snapshot.microvmState === "suspending" ||
    snapshot.microvmState === "resuming" ||
    snapshot.status === "suspending" ||
    snapshot.status === "suspended" ||
    snapshot.status === "resuming"
  ) {
    return { kind: "resume", sessionId: approval.sessionId, userId: snapshot.userId };
  }
  return { kind: "use", sessionId: approval.sessionId, userId: snapshot.userId };
}

/**
 * Send the approved write to a runtime and return.
 *
 * The answer comes back later as a `tool.applied` frame and settles the
 * approval from the account, so nothing is held open while a write runs. A
 * dispatch that cannot land leaves the approval `applying`, and the account's
 * sweep decides what to say about it.
 */
async function dispatchApprovedWrite(
  env: Env,
  context: ExecutionContext,
  accountId: string,
  approval: ApprovalRecord,
  decision: { id: string; decidedAt: string; decidedBy?: string },
): Promise<void> {
  const account = env.ACCOUNTS.getByName(accountId);
  const deployment = await account.getDeployment(approval.deploymentId);
  if (!deployment) {
    await account.completeApproval(approval.id, {
      ok: false,
      message: "The deployment is no longer available",
    });
    return;
  }

  const snapshot = approval.sessionId
    ? await env.SESSIONS.getByName(approval.sessionId)
        .snapshot()
        .catch(() => null)
    : null;
  const target = selectApplySession(approval, snapshot);
  const identity: RequestIdentity = {
    kind: "user",
    userId: target.kind === "create" ? `approval:${approval.id}` : target.userId,
    accountId,
  };

  let sessionId = target.kind === "create" ? undefined : target.sessionId;

  // An approved write runs as the person who approved it, so the session that
  // carries it must be acting for them. Reusing a conversation that is acting
  // for somebody else would mean either using the wrong credential or
  // retargeting a live session out from under a concurrent write — so when the
  // approver is not who that session is for, the write gets its own.
  if (sessionId && decision.decidedBy) {
    const actingUser = await env.SESSIONS.getByName(sessionId)
      .actingUser()
      .catch(() => null);
    if (actingUser && actingUser !== decision.decidedBy) sessionId = undefined;
  }

  if (sessionId && target.kind === "resume") {
    const resumed = await changeRuntimeState(
      env,
      identity,
      env.SESSIONS.getByName(target.sessionId),
      "resume",
    );
    if (!resumed.ok) sessionId = undefined;
  }

  if (!sessionId) {
    const created = await createSession(
      new Request("https://edge.internal/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: `${deployment.agentId}@${deployment.alias}`,
          source: "decision",
        }),
      }),
      env,
      identity,
      context,
    );
    if (!created.ok) {
      await account.completeApproval(approval.id, {
        ok: false,
        message: "Could not start a session for the write",
      });
      return;
    }
    sessionId = ((await created.json()) as InitializeSessionResult).session.id;
  }

  // The write runs in whichever session carries it, which may be one created
  // just now because the original could not be resumed. It still belongs to
  // the installation the proposal was made in, and per-installation
  // credentials resolve from that binding — without this, an approved write
  // would fail closed on every tenant-scoped secret.
  if (approval.connectionId) {
    await env.SESSIONS.getByName(sessionId).bindChannelConnection(
      approval.connectionId,
    );
  }
  // Set last, and always: this is what makes the write run with the approver's
  // own authority rather than the proposer's.
  if (decision.decidedBy) {
    await env.SESSIONS.getByName(sessionId).setActingUser(decision.decidedBy);
  }

  // Recorded before the frame is sent: a runtime that is not up yet picks the
  // work up when it connects, which is the ordinary case for a session created
  // to carry out a decision that arrived hours after the conversation.
  await account.recordApplyTarget(approval.id, sessionId);
  const outcome = await env.SESSIONS.getByName(sessionId).dispatchGatedTool({
    approvalId: approval.id,
    toolId: approval.toolId,
    toolInput: approval.input,
    ...(approval.turnId ? { turnId: approval.turnId } : {}),
    decision,
  });
  if (outcome.dispatched) return;
  if (outcome.reason === "send_failed") {
    await account.completeApproval(approval.id, {
      ok: false,
      message: "The write could not be sent to the runtime",
    });
  }
}

/**
 * A decision on a card posted by a shared app.
 *
 * Same as the per-connection route in every respect but one: the connection is
 * found from the `team_id` in the payload rather than from the URL, because a
 * distributed app has a single interactivity URL for every workspace.
 */
async function receiveSlackAppInteractivity(
  request: Request,
  env: Env,
  context: ExecutionContext,
  appId: string,
  webhookToken: string,
): Promise<Response> {
  const routeAccount = env.ACCOUNTS.getByName(
    channelAppRouteName("slack", appId),
  );
  const route = await routeAccount.getChannelAppRoute();
  const tokenMatches = route
    ? constantTimeEqual(route.webhookTokenHash, await sha256(webhookToken))
    : false;
  if (!route || route.appId !== appId || !tokenMatches) {
    return problem(401, "invalid_webhook_token", "Invalid webhook token");
  }

  // Interactivity is form-encoded with the payload in one field, and the
  // signature covers the raw body exactly as sent.
  const payload = await request.text();
  const account = env.ACCOUNTS.getByName(route.accountId);
  const signingSecret = await account.channelAppSigningSecret(appId);
  if (
    !signingSecret ||
    !(await channelAdapter("slack")?.verify({
      payload,
      headers: request.headers,
      url: request.url,
      secret: signingSecret,
    }))
  ) {
    return problem(401, "invalid_slack_signature", "Invalid Slack signature");
  }

  const encoded = new URLSearchParams(payload).get("payload");
  if (!encoded) return json({ ok: true });
  let body: unknown;
  try {
    body = JSON.parse(encoded) as unknown;
  } catch {
    return json({ ok: true });
  }

  const adapter = channelAdapter("slack");
  const answer = adapter?.parseQuestionAnswer?.(body, request.headers);
  if (answer) {
    const installation = answer.scope.teamId
      ? await account.findAppInstallation(appId, answer.scope.teamId)
      : undefined;
    if (!installation || installation.status !== "connected") return json({ ok: true });
    context.waitUntil(settleQuestionAnswer(env, route.accountId, installation.id, answer));
    return json({ ok: true });
  }
  const decision = adapter?.parseDecision?.(body, request.headers);
  if (!decision) return json({ ok: true });

  const workspaceId = decision.scope.teamId;
  const connection = workspaceId
    ? await account.findAppInstallation(appId, workspaceId)
    : undefined;
  if (!connection || connection.status !== "connected") {
    return json({ ok: true });
  }

  context.waitUntil(
    settleDecision(env, context, route.accountId, connection.id, decision).catch(
      (error: unknown) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "approval.app_decision_failed",
            appId,
            approvalId: decision.approvalId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    ),
  );
  return json({ ok: true });
}

/**
 * A click on a question card's option (slack-ux P2). The session is the one
 * the clicker's own messages in that thread go to, found the way the ingress
 * finds it (`<user>:<thread>`); the session admits the answer only when the
 * clicker is the person it talks to, and logs anyone else's click. Never
 * throws: Slack was already answered.
 */
async function settleQuestionAnswer(
  env: Env,
  accountId: string,
  connectionId: string,
  answer: InboundQuestionAnswer,
): Promise<void> {
  const thread = String(answer.replyTarget.threadTimestamp ?? "");
  const log = (reason: string, extra: Record<string, unknown> = {}) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "slack.question_answer_ignored",
        connectionId,
        questionId: answer.questionId,
        externalUserId: answer.externalUserId,
        reason,
        ...extra,
      }),
    );
  try {
    const account = env.ACCOUNTS.getByName(accountId);
    const sessionId = await account.getChannelThreadSession(
      connectionId,
      `${answer.externalUserId}:${thread}`,
    );
    if (!sessionId) {
      // No session is bound to this clicker in this thread:
      // the card belongs to someone else's session.
      log("no_session");
      return;
    }
    const session = env.SESSIONS.getByName(sessionId);
    const snapshot = await session.snapshot();
    if (snapshot.microvmState === "suspended" && snapshot.userId) {
      // As the ingress does for a typed message: the answer turn needs a
      // running computer on a sandbox session.
      await changeRuntimeState(
        env,
        { kind: "user", userId: snapshot.userId, accountId },
        session,
        "resume",
      );
    }
    const outcome = await session.answerQuestionFromChannel({
      questionId: answer.questionId,
      optionIndex: answer.optionIndex,
      externalUserId: answer.externalUserId,
      actionTimestamp: answer.actionTimestamp,
      connectionId,
      ...(typeof answer.scope.teamId === "string" ? { workspaceId: answer.scope.teamId } : {}),
      ...(thread ? { conversationId: thread } : {}),
    });
    if (outcome.outcome !== "admitted") log(outcome.outcome, { sessionId });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack.question_answer_failed",
        connectionId,
        questionId: answer.questionId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function settleDecision(
  env: Env,
  context: ExecutionContext,
  accountId: string,
  connectionId: string,
  decision: InboundDecision,
): Promise<void> {
  const account = env.ACCOUNTS.getByName(accountId);
  const existing = await account.getApproval(decision.approvalId);
  if (!existing || existing.connectionId !== connectionId) return;

  // Only the person the proposal was made to may answer it. A Slack thread is
  // visible to everyone in the channel, so without this anyone watching could
  // approve somebody else's write.
  if (
    existing.deciderPrincipal &&
    existing.deciderPrincipal !== decision.externalUserId
  ) {
    return;
  }

  if (new Date(existing.expiresAt).getTime() < Date.now()) {
    await account.settleApproval({
      id: existing.id,
      error: "The approval expired before it was decided",
    });
    return;
  }

  // A click on a card whose approval has already moved on. Returning silently
  // leaves a live-looking button that does nothing, which reads as the product
  // being broken — so say what the real state is and take the buttons away.
  if (existing.status !== "pending") {
    const settled: Record<string, "approved" | "denied" | "failed" | "unknown" | "applying"> = {
      approved: "approved",
      applying: "applying",
      applied: "approved",
      denied: "denied",
      failed: "failed",
      expired: "unknown",
      unknown: "unknown",
    };
    await account.rewriteApprovalCard(
      existing,
      settled[existing.status] ?? "unknown",
      existing.decidedBy,
    );
    return;
  }

  // Slack retries, and people double-click. Exactly one caller may win this,
  // and everything after it hangs off that.
  const outcome = await account.decideApproval({
    id: decision.approvalId,
    choice: decision.choice,
    decidedBy: decision.externalUserId,
  });
  if (!outcome.decided || !outcome.approval) return;
  const approval = outcome.approval;

  if (decision.choice === "denied") {
    await account.settleApproval({ id: approval.id, result: null });
    await account.rewriteApprovalCard(approval, "denied", decision.externalUserId);
    await account.notifyApprovalOutcome(approval, "did not approve");
    return;
  }

  // Claim the write before doing it, so a retried decision cannot run it
  // twice, and so a write that never reports back is visibly in flight rather
  // than indistinguishable from one that was never started.
  const started = await account.beginApply(approval.id);
  if (!started.started || !started.approval) return;

  // Say so before doing it. Finding a runtime to carry the write out can take
  // several seconds — the session has usually gone cold by the time anyone
  // decides — and until now the card sat unchanged through all of it, which
  // reads as a button that did nothing. This also retires the buttons, so the
  // wait cannot be mistaken for an unregistered click.
  await account.rewriteApprovalCard(
    started.approval,
    "applying",
    decision.externalUserId,
  );

  await dispatchApprovedWrite(env, context, accountId, started.approval, {
    id: approval.id,
    decidedAt: approval.decidedAt ?? new Date().toISOString(),
    ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {}),
  });
}

async function receiveSlackWebhook(
  request: Request,
  env: Env,
  context: ExecutionContext,
  connectionId: string,
  webhookToken: string,
): Promise<Response> {
  const routeAccount = env.ACCOUNTS.getByName(
    channelRouteName("slack", connectionId),
  );
  const route = await routeAccount.getChannelRoute();
  const tokenMatches = route
    ? constantTimeEqual(route.webhookTokenHash, await sha256(webhookToken))
    : false;
  if (!route || route.connectionId !== connectionId || !tokenMatches) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "slack.webhook_route_rejected",
        connectionId,
        routeFound: Boolean(route),
        connectionMatches: route?.connectionId === connectionId,
        tokenMatches,
      }),
    );
    return problem(401, "invalid_webhook_token", "Invalid webhook token");
  }
  const payload = await request.text();
  const body: unknown = JSON.parse(payload);
  // The provider-shaped half of ingress — handshake, parsing, signature — goes
  // through the adapter. What stays here is the part every provider shares:
  // route, match the connection, record the outcome, hand off asynchronously.
  const adapter = channelAdapter("slack");
  if (!adapter) {
    return problem(503, "provider_unavailable", "Provider is not available");
  }
  const handshake = adapter.handshake?.(body);
  if (handshake) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "slack.webhook_verification",
        connectionId,
        challengeValid: handshake.status === 200,
      }),
    );
    return handshake;
  }
  const callback = parseSlackEventCallback(body);
  if (!callback) return json({ ok: true });
  const account = env.ACCOUNTS.getByName(route.accountId);
  const connection = await account.getSlackConnection(route.connectionId);
  if (
    !connection ||
    connection.status !== "connected" ||
    connection.teamId !== callback.teamId ||
    (connection.appId && connection.appId !== callback.appId)
  ) {
    return json({ ok: true });
  }
  const signatureValid = await account.verifyChannelRequest(
    adapter.provider,
    connection.id,
    {
      payload,
      headers: Object.fromEntries(request.headers),
      url: request.url,
    },
  );
  await account.recordSlackVerification(connection.id, signatureValid);
  if (!signatureValid) {
    return problem(401, "invalid_slack_signature", "Invalid Slack signature");
  }

  context.waitUntil(
    processSlackEvent(
      request.url,
      env,
      context,
      route.accountId,
      route.connectionId,
      {
        id: callback.id,
        data: callback.data,
      },
    ).catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "slack.event_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );
  return json({ ok: true });
}

/**
 * Register a Slack app that a customer's own users install.
 *
 * The dashboard wizard connects one workspace, run by somebody with an
 * OpenComputer login. This is for the other shape: a company whose own
 * customers install a Slack app, none of whom will ever have an account here.
 * So it is API-key authenticated and takes the credentials they already hold.
 */
async function registerChannelApp(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response> {
  const body = await readBoundedJson(request, 16 * 1024);
  const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
  const externalAppId =
    typeof body?.appId === "string" ? body.appId.trim() : "";
  const signingSecret =
    typeof body?.signingSecret === "string" ? body.signingSecret.trim() : "";
  if (!agentId || !externalAppId || signingSecret.length < 16) {
    return problem(
      400,
      "invalid_channel_app",
      "Expected agentId, environment, appId and signingSecret",
    );
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const scoped = await agentScope(account, agentId, body?.environment, {
    legacyDefault: "required",
  });
  if (!scoped.ok) return scoped.response;
  const alias = scoped.scope.environment;
  const deployment = await account.resolveDeployment(`${agentId}@${alias}`);
  if (!deployment) {
    return problem(404, "deployment_not_found", "Deployment not found");
  }

  const id = `app_${await sha256(`${identity.accountId}:slack:${externalAppId}`)}`.slice(
    0,
    36,
  );
  const webhookToken = crypto.randomUUID().replace(/-/g, "");
  await account.createChannelApp({
    id,
    provider: "slack",
    externalAppId,
    agentId: deployment.agentId,
    alias: deployment.alias,
    signingSecret,
    label: typeof body?.label === "string" ? body.label : externalAppId,
  });
  await env.ACCOUNTS.getByName(channelAppRouteName("slack", id)).setChannelAppRoute(
    {
      accountId: identity.accountId,
      appId: id,
      webhookTokenHash: await sha256(webhookToken),
      provider: "slack",
    },
  );

  const base = new URL(request.url).origin;
  return json(
    {
      app: { id, appId: externalAppId, agentId: deployment.agentId, environment: alias },
      // Shown once. Both URLs go in the Slack app config, and every
      // workspace's traffic arrives on them.
      eventsUrl: `${base}/v1/webhooks/slack/app/${id}/${webhookToken}`,
      interactivityUrl: `${base}/v1/webhooks/slack/app/${id}/${webhookToken}/interactivity`,
    },
    201,
  );
}

/**
 * Record one workspace's install of a registered app.
 *
 * Idempotent on the workspace, so importing several hundred existing
 * installations is a loop that can be re-run after a failure.
 */
/**
 * Read, set and remove the credentials an installation uses.
 *
 * Values are write-only: they are stored encrypted and only ever leave as an
 * egress header the runtime never sees, so the list route returns names and
 * origins and nothing else.
 */
async function installationSecretsRequest(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  target: {
    appId: string;
    connectionId: string;
    /** Present for one person's credentials, absent for the installation's. */
    externalUserId?: string;
    name?: string;
  },
): Promise<Response> {
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const app = await account.getChannelApp(target.appId);
  if (!app) return problem(404, "channel_app_not_found", "App not found");

  // Membership rather than existence: a connection id alone would let a caller
  // write a secret onto an installation of some other app.
  const installations = await account.listAppInstallations(target.appId);
  if (!installations.some((installed: { id: string }) => installed.id === target.connectionId)) {
    return problem(
      404,
      "installation_not_found",
      "That installation does not belong to this app",
    );
  }

  if (!target.name) {
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", "Method not allowed");
    }
    return json({
      secrets: target.externalUserId
        ? await account.listUserSecrets(
            target.connectionId,
            target.externalUserId,
          )
        : await account.listInstallationSecrets(target.connectionId),
    });
  }

  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(target.name)) {
    return problem(
      400,
      "invalid_secret_name",
      "Secret names must use uppercase letters, numbers, and underscores",
    );
  }

  if (request.method === "PUT") {
    const body = await readBoundedJson(request, 128 * 1024);
    if (
      typeof body?.value !== "string" ||
      !body.value ||
      body.value.length > 64 * 1024
    ) {
      return problem(
        400,
        "invalid_secret",
        "Expected a non-empty value and at least one allowed HTTPS origin",
      );
    }
    const allowedOrigins = normalizedSecretOrigins(body?.allowedOrigins);
    if (!allowedOrigins) {
      return problem(
        400,
        "invalid_secret_origin",
        "Secret origins must be public HTTPS origins without paths",
      );
    }
    return json(
      target.externalUserId
        ? await account.putUserSecret({
            connectionId: target.connectionId,
            externalUserId: target.externalUserId,
            name: target.name,
            value: body.value,
            allowedOrigins,
          })
        : await account.putInstallationSecret({
            connectionId: target.connectionId,
            name: target.name,
            value: body.value,
            allowedOrigins,
          }),
    );
  }

  if (request.method === "DELETE") {
    const deleted = target.externalUserId
      ? await account.deleteUserSecret(
          target.connectionId,
          target.externalUserId,
          target.name,
        )
      : await account.deleteInstallationSecret(
          target.connectionId,
          target.name,
        );
    return deleted
      ? new Response(null, { status: 204 })
      : problem(404, "secret_not_found", "Secret not found");
  }

  return problem(405, "method_not_allowed", "Method not allowed");
}

async function createAppInstallation(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  appId: string,
): Promise<Response> {
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const app = await account.getChannelApp(appId);
  if (!app) return problem(404, "channel_app_not_found", "App not found");

  const body = await readBoundedJson(request, 16 * 1024);
  const botToken =
    typeof body?.botToken === "string" ? body.botToken.trim() : "";
  const channelId =
    typeof body?.channelId === "string" ? body.channelId.trim() : "slack";
  if (!botToken) {
    return problem(400, "invalid_installation", "Expected botToken");
  }

  // The token already says which workspace it belongs to, and the wizard has
  // always asked. Making every caller supply it as well turns a bulk import
  // into a join across two datasets, and lets a mismatched pair install one
  // customer's bot against another customer's tenant.
  let slackIdentity: Awaited<ReturnType<typeof resolveSlackInstallation>>;
  try {
    slackIdentity = await resolveSlackInstallation(botToken, app.externalAppId);
  } catch (error: unknown) {
    return problem(
      400,
      "installation_token_rejected",
      error instanceof Error ? error.message : "Slack rejected this bot token",
    );
  }
  const claimed =
    typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (claimed && claimed !== slackIdentity.teamId) {
    return problem(
      409,
      "installation_workspace_mismatch",
      `This token belongs to ${slackIdentity.teamId}, not ${claimed}`,
    );
  }
  const workspaceId = slackIdentity.teamId;
  const signingSecret = await account.channelAppSigningSecret(appId);
  if (!signingSecret) {
    return problem(409, "channel_app_incomplete", "App has no signing secret");
  }

  const installation = await account.upsertAppInstallation({
    appId,
    provider: "slack",
    agentId: app.agentId,
    alias: app.alias,
    channelId,
    workspaceId,
    botToken,
    signingSecret,
    ...(typeof body?.tenantId === "string" ? { tenantId: body.tenantId } : {}),
    ...(typeof body?.workspaceName === "string"
      ? { workspaceName: body.workspaceName }
      : slackIdentity.teamName
        ? { workspaceName: slackIdentity.teamName }
        : {}),
  });
  // Credentials can be set in the same call that records the install. A
  // tenant whose secrets arrive in a second request is a tenant that is live
  // and unconfigured in between, and this is the one moment the caller
  // certainly has them to hand.
  const secrets =
    body?.secrets && typeof body.secrets === "object" && !Array.isArray(body.secrets)
      ? (body.secrets as Record<string, unknown>)
      : {};
  const stored: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
      return problem(
        400,
        "invalid_secret_name",
        `Secret ${name} must use uppercase letters, numbers, and underscores`,
      );
    }
    const entry =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };
    if (
      typeof entry.value !== "string" ||
      !entry.value ||
      entry.value.length > 64 * 1024
    ) {
      return problem(400, "invalid_secret", `Secret ${name} needs a value`);
    }
    const allowedOrigins = normalizedSecretOrigins(entry.allowedOrigins);
    if (!allowedOrigins) {
      return problem(
        400,
        "invalid_secret_origin",
        `Secret ${name} needs at least one public HTTPS origin`,
      );
    }
    await account.putInstallationSecret({
      connectionId: installation.id,
      name,
      value: entry.value,
      allowedOrigins,
    });
    stored.push(name);
  }

  return json(
    {
      installation: { id: installation.id, workspaceId, appId },
      ...(stored.length ? { secrets: stored.sort() } : {}),
    },
    installation.created ? 201 : 200,
  );
}

function channelAppRouteName(provider: string, appId: string): string {
  return `${provider}-app:${appId}`;
}

/**
 * Events for a Slack app that many workspaces have installed.
 *
 * Identical to the per-connection route in every respect but one: the
 * connection is found from the `team_id` in the payload rather than from the
 * URL, because a distributed app has a single Request URL for all of them.
 */
async function receiveSlackAppWebhook(
  request: Request,
  env: Env,
  context: ExecutionContext,
  appId: string,
  webhookToken: string,
): Promise<Response> {
  const routeAccount = env.ACCOUNTS.getByName(
    channelAppRouteName("slack", appId),
  );
  const route = await routeAccount.getChannelAppRoute();
  const tokenMatches = route
    ? constantTimeEqual(route.webhookTokenHash, await sha256(webhookToken))
    : false;
  if (!route || route.appId !== appId || !tokenMatches) {
    return problem(401, "invalid_webhook_token", "Invalid webhook token");
  }

  const payload = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(payload) as unknown;
  } catch {
    return problem(400, "invalid_webhook_body", "Expected a JSON body");
  }
  const adapter = channelAdapter("slack");
  if (!adapter) {
    return problem(503, "provider_unavailable", "Provider is not available");
  }
  const handshake = adapter.handshake?.(body);
  if (handshake) return handshake;

  const account = env.ACCOUNTS.getByName(route.accountId);
  // One app, one signing secret, however many workspaces installed it. The
  // signature is checked before the workspace is looked up, so an unknown
  // team never causes a storage read.
  const signingSecret = await account.channelAppSigningSecret(appId);
  if (
    !signingSecret ||
    !(await adapter.verify({
      payload,
      headers: request.headers,
      url: request.url,
      secret: signingSecret,
    }))
  ) {
    return problem(401, "invalid_slack_signature", "Invalid Slack signature");
  }

  const callback = parseSlackEventCallback(body);
  if (!callback) return json({ ok: true });
  const connection = await account.findAppInstallation(appId, callback.teamId);
  // A workspace that uninstalled, or one we were never told about. Answering
  // with an error would make Slack redeliver it forever.
  if (!connection || connection.status !== "connected") {
    return json({ ok: true });
  }

  context.waitUntil(
    processSlackEvent(
      request.url,
      env,
      context,
      route.accountId,
      connection.id,
      { id: callback.id, data: callback.data },
    ).catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "slack.app_event_failed",
          appId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );
  return json({ ok: true });
}

/**
 * Accept a webhook delivery and answer before any session or runtime work.
 * The credential is the token, given either as the last path segment or as a
 * bearer header; both verify against the same hash. A body without `text`
 * or `payload` is admitted whole as `payload`. The Account DO stores the
 * input and enacts the session from its alarm (see
 * `enactProjectWebhookRequest`), so the 202 carries the session id the first
 * attempt will use and the request ledger holds the current one.
 */
async function receiveAgentWebhook(
  request: Request,
  env: Env,
  webhookId: string,
  pathToken?: string,
): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const headerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const token = pathToken ?? headerToken;
  const routeAccount = env.ACCOUNTS.getByName(webhookRouteName(webhookId));
  const route = await routeAccount.getWebhookRoute();
  const tokenMatches = route && token
    ? constantTimeEqual(route.tokenHash, await sha256(token))
    : false;
  if (!route || route.webhookId !== webhookId || !tokenMatches) {
    return problem(401, "invalid_webhook_credentials", "Webhook credentials are invalid");
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return problem(415, "unsupported_media_type", "Webhook requests must use application/json");
  }
  const body = await readBoundedJson(request, WEBHOOK_BODY_LIMIT);
  const normalized = normalizeWebhookInput(body);
  if (!normalized.ok) {
    return problem(400, "invalid_webhook_input", normalized.message);
  }
  const input = normalized.input;
  const account = env.ACCOUNTS.getByName(route.accountId);
  const webhook = await account.getProjectWebhook(webhookId);
  if (!webhook?.enabled) {
    return problem(404, "webhook_not_found", "Webhook is unavailable");
  }
  const project = await account.getProject(webhook.projectId);
  if (project) {
    const archived = projectArchived(project);
    if (archived) return archived;
  }
  const identity = await webhookDeliveryIdentity(request.headers, body, webhook.identity);
  const idempotencyKey = identity?.key;
  if (idempotencyKey && idempotencyKey.length > 256) {
    return problem(400, "invalid_idempotency_key", "Idempotency-Key is too long");
  }
  const deployment = await account.resolveDeployment(
    `${webhook.agentId}@${webhook.environment}`,
  );
  if (!deployment) {
    return problem(409, "webhook_target_unavailable", "The webhook target is not deployed");
  }
  const requestId = `whr_${crypto.randomUUID().replaceAll("-", "")}`;
  // Check the complete structured input, envelope included, against the
  // storage limit now: an acknowledged delivery must never be rejected later.
  const receivedAt = new Date().toISOString();
  if (
    structuredInputLength({
      source: "webhook",
      ...input,
      webhook: { id: webhookId, requestId, receivedAt },
    }) > STRUCTURED_INPUT_LIMIT
  ) {
    return problem(
      400,
      "invalid_webhook_input",
      "The delivery exceeds 256 KiB once wrapped as agent input",
    );
  }
  const claimed = await account.claimProjectWebhookRequest({
    id: requestId,
    webhookId,
    payloadHash: await sha256(JSON.stringify(body)),
    ...(identity ? { idempotencyKey: identity.key, identityDerived: identity.derived } : {}),
    input,
    deploymentId: deployment.id,
    edgeOrigin: new URL(request.url).origin,
    userId: webhook.createdBy,
    accountId: route.accountId,
  });
  if (claimed.conflict) {
    return problem(
      409,
      "idempotency_conflict",
      "Idempotency-Key was already used with different input",
    );
  }
  console.log(
    JSON.stringify({
      level: "info",
      event: claimed.duplicate ? "agent_webhook.duplicate" : "agent_webhook.received",
      webhookId,
      requestId: claimed.request.id,
      projectId: webhook.projectId,
      environment: webhook.environment,
      agentId: webhook.agentId,
      deploymentId: deployment.id,
      sessionId: claimed.request.sessionId,
      ...(claimed.rearmed ? { rearmed: true } : {}),
      ...(claimed.bodyMismatch ? { bodyMismatch: true } : {}),
    }),
  );
  return json({ request: claimed.request, duplicate: claimed.duplicate }, 202);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      const url = new URL(request.url);
      if (url.pathname === "/v1/github/callback" && request.method === "GET") {
        return await gitHubAuthorizationCallback(request, env);
      }
      if (url.pathname === "/v1/github/webhooks" && request.method === "POST") {
        return await receiveGitHubWebhook(request, env as Env & PlatformEnv);
      }
      if (
        url.pathname === "/v1/channels/slack/oauth/callback" &&
        request.method === "GET"
      ) {
        return await slackAuthorizationCallback(request, env);
      }
      if (url.pathname === "/v1/linear/oauth/callback" && request.method === "GET") {
        return await linearAuthorizationCallback(request, env, {
          encodeOAuthState,
          decodeOAuthState,
          html,
          projectOwnsAgent,
        });
      }
      if (url.pathname === "/internal/managed-credential") {
        return await managedCredentialHandoff(
          request,
          env as Env & PlatformEnv,
        );
      }
      // Fixed egress exits (work 073): the exits' policy poll, with their own
      // bearer token, and the public list of exit IPs.
      if (url.pathname === "/internal/egress/policy") {
        return await egressPolicyResponse(request, env);
      }
      if (url.pathname === "/v1/egress-ips" && request.method === "GET") {
        return withCors(egressIpsResponse());
      }
      if (url.pathname === "/internal/computer/status" || url.pathname === "/internal/computer/wake") {
        return await operatorComputer(
          request,
          env as Env & PlatformEnv & ComputerEdgeEnv,
          url.pathname.endsWith("/wake") ? "wake" : "status",
        );
      }
      if (url.pathname === "/internal/session-index/backfill") {
        return await backfillSessionIndex(request, env as Env & PlatformEnv);
      }
      if (url.pathname === "/internal/session-projection/reconcile") {
        return await reconcileSessionProjection(request, env as Env & PlatformEnv);
      }
      if (
        url.pathname === "/internal/account/runtime-profile" &&
        request.method === "POST"
      ) {
        return await setAccountManagedRuntimeProfile(
          request,
          env as Env & PlatformEnv,
        );
      }
      // The computer's Slack webhooks, OAuth callback and host WebSocket
      // (work 052) carry their own authentication, not the edge assertion.
      const computerPublicResponse = await routeComputerPublic(
        request,
        env as Env & ComputerEdgeEnv,
        context,
      );
      if (computerPublicResponse) return withCors(computerPublicResponse);
      const templateTaskResponse = await routeTemplateTaskRequest(
        request,
        env as Env & PlatformEnv,
      );
      if (templateTaskResponse) return templateTaskResponse;
      const gitBuildTaskResponse = await routeGitDeployTaskRequest(
        request,
        env as Env & PlatformEnv,
      );
      if (gitBuildTaskResponse) return gitBuildTaskResponse;
      const agentWebhookMatch = url.pathname.match(
        /^\/v1\/agent-webhooks\/([^/]+)(?:\/([^/]+))?$/,
      );
      if (
        agentWebhookMatch?.[1] &&
        /^wh_[a-f0-9]{32}$/.test(agentWebhookMatch[1]) &&
        request.method === "POST"
      ) {
        return withCors(
          await receiveAgentWebhook(
            request,
            env,
            agentWebhookMatch[1],
            agentWebhookMatch[2],
          ),
        );
      }
      const slackAppInteractivityMatch = url.pathname.match(
        /^\/v1\/webhooks\/slack\/app\/([^/]+)\/([^/]+)\/interactivity$/,
      );
      if (
        slackAppInteractivityMatch?.[1] &&
        slackAppInteractivityMatch[2] &&
        request.method === "POST"
      ) {
        return withCors(
          await receiveSlackAppInteractivity(
            request,
            env,
            context,
            decodeURIComponent(slackAppInteractivityMatch[1]),
            slackAppInteractivityMatch[2],
          ),
        );
      }

      // A distributed app's events: one URL, every workspace that installed it.
      // Matched before the per-connection route so `app` is never mistaken for
      // a connection id.
      const slackAppWebhookMatch = url.pathname.match(
        /^\/v1\/webhooks\/slack\/app\/([^/]+)\/([^/]+)$/,
      );
      if (
        slackAppWebhookMatch?.[1] &&
        slackAppWebhookMatch[2] &&
        request.method === "POST"
      ) {
        return withCors(
          await receiveSlackAppWebhook(
            request,
            env,
            context,
            decodeURIComponent(slackAppWebhookMatch[1]),
            slackAppWebhookMatch[2],
          ),
        );
      }

      // Slack posts interactivity to its own configured URL, form-encoded
      // rather than JSON, so it gets its own route instead of a branch inside
      // a handler whose contract is a JSON body.
      const slackInteractivityMatch = url.pathname.match(
        /^\/v1\/webhooks\/slack\/([^/]+)\/([^/]+)\/interactivity$/,
      );
      if (
        slackInteractivityMatch?.[1] &&
        slackInteractivityMatch[2] &&
        request.method === "POST"
      ) {
        return withCors(
          await receiveSlackInteractivity(
            request,
            env,
            context,
            decodeURIComponent(slackInteractivityMatch[1]),
            slackInteractivityMatch[2],
          ),
        );
      }
      const slackWebhookMatch = url.pathname.match(
        /^\/v1\/webhooks\/slack\/([^/]+)\/([^/]+)$/,
      );
      if (
        slackWebhookMatch?.[1] &&
        slackWebhookMatch[2] &&
        request.method === "POST"
      ) {
        return withCors(
          await receiveSlackWebhook(
            request,
            env,
            context,
            decodeURIComponent(slackWebhookMatch[1]),
            decodeURIComponent(slackWebhookMatch[2]),
          ),
        );
      }

      const linearWebhookMatch = url.pathname.match(LINEAR_WEBHOOK_PATTERN);
      if (
        linearWebhookMatch?.[1] &&
        linearWebhookMatch[2] &&
        request.method === "POST"
      ) {
        return withCors(
          await receiveLinearWebhook(
            request,
            env,
            decodeURIComponent(linearWebhookMatch[1]),
            decodeURIComponent(linearWebhookMatch[2]),
          ),
        );
      }

      const twilioWebhookMatch = url.pathname.match(
        /^\/v1\/webhooks\/twilio\/([^/]+)\/([^/]+)\/(sms|voice|recording)$/,
      );
      if (
        twilioWebhookMatch?.[1] &&
        twilioWebhookMatch[2] &&
        twilioWebhookMatch[3] &&
        request.method === "POST"
      ) {
        return withCors(
          await receiveTwilioWebhook(
            request,
            env,
            context,
            decodeURIComponent(twilioWebhookMatch[1]),
            decodeURIComponent(twilioWebhookMatch[2]),
            twilioWebhookMatch[3] as "sms" | "voice" | "recording",
          ),
        );
      }

      if (url.pathname === "/health" && request.method === "GET") {
        return withCors(
          json({
            ok: true,
            service: "managed-agents-edge",
            environment: env.BLUE_ENVIRONMENT,
          }),
        );
      }

      if (url.pathname === "/v1/auth/config" && request.method === "GET") {
        if ((env as Env & ManagedAgentAuthEnv).OC_MANAGED_AGENTS_ONLY === "true") {
          return withCors(problem(404, "not_found", "Route not found"));
        }
        const configuration = authConfiguration(env as Env & ManagedAgentAuthEnv);
        return withCors(
          configuration
            ? json(configuration)
            : problem(
                503,
                "auth_not_configured",
                "WorkOS authentication is not configured",
              ),
        );
      }

      if (
        url.pathname === "/v1/connections/google/oauth/callback" &&
        request.method === "GET"
      ) {
        return composioOAuthRedirect(request);
      }

      if (
        url.pathname === "/v1/connections/google/callback" &&
        request.method === "GET"
      ) {
        return await composioConnectionCallback(request, env);
      }

      const connectionProxyMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/connections\/([^/]+)\/fetch$/,
      );
      const runtimeVariablesMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/runtime-variables$/,
      );
      if (runtimeVariablesMatch?.[1] && request.method === "GET") {
        const sessionId = decodeURIComponent(runtimeVariablesMatch[1]);
        const response = await runtimeAgentVariables(request, env, sessionId);
        if (response.status === 409) {
          // A 409 fails the sandbox's run hook for good; which refusal it
          // was is otherwise invisible from the platform side.
          const body: unknown = await response.clone().json().catch(() => null);
          const error = isRecord(body) && isRecord(body.error) ? body.error : {};
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "edge.runtime_variables_refused",
              sessionId,
              code: error.code,
              message: error.message,
            }),
          );
        }
        return withCors(response);
      }
      if (
        connectionProxyMatch?.[1] &&
        connectionProxyMatch[2] &&
        request.method === "POST"
      ) {
        const sessionId = decodeURIComponent(connectionProxyMatch[1]);
        const provider = decodeURIComponent(connectionProxyMatch[2]);
        if (provider === "opencomputer") {
          const body = await readBoundedJson(request, 128 * 1024);
          if (body?.action === "list") {
            return withCors(
              await listSessionConnections(
                new Request(request.url, {
                  method: "GET",
                  headers: request.headers,
                }),
                env,
                sessionId,
              ),
            );
          }
          if (body?.action === "request") {
            return withCors(
              await requestSessionConnection(
                new Request(request.url, {
                  method: "POST",
                  headers: request.headers,
                  body: JSON.stringify({
                    service: body.service,
                    label: body.label,
                    newAccount: body.newAccount,
                  }),
                }),
                env,
                sessionId,
              ),
            );
          }
          return withCors(
            problem(
              400,
              "invalid_connection_action",
              "Expected a list or request connection action",
            ),
          );
        }
        return withCors(
          await proxyConnectionRequest(request, env, sessionId, provider),
        );
      }

      const egressProxyMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/egress\/([^/]+)\/fetch$/,
      );
      if (
        egressProxyMatch?.[1] &&
        egressProxyMatch[2] &&
        request.method === "POST"
      ) {
        return withCors(
          await runtimeManagedEgress(
            request,
            env,
            decodeURIComponent(egressProxyMatch[1]),
            decodeURIComponent(egressProxyMatch[2]),
          ),
        );
      }

      const managedMcpMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/mcp\/([^/]+)$/,
      );
      if (managedMcpMatch?.[1] && managedMcpMatch[2]) {
        return withCors(
          await runtimeManagedMcp(
            request,
            env,
            decodeURIComponent(managedMcpMatch[1]),
            decodeURIComponent(managedMcpMatch[2]),
          ),
        );
      }

      const databaseMcpMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/database\/mcp$/,
      );
      if (databaseMcpMatch?.[1]) {
        return withCors(
          await runtimeDatabaseMcp(
            request,
            env,
            decodeURIComponent(databaseMcpMatch[1]),
          ),
        );
      }

      const outboxPublishMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/outboxes\/([^/]+)\/items$/,
      );
      if (
        outboxPublishMatch?.[1] &&
        outboxPublishMatch[2] &&
        request.method === "POST"
      ) {
        return withCors(
          await publishRuntimeOutbox(
            request,
            env,
            context,
            decodeURIComponent(outboxPublishMatch[1]),
            decodeURIComponent(outboxPublishMatch[2]),
          ),
        );
      }

      const approvalRecordMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/approvals$/,
      );
      if (approvalRecordMatch?.[1] && request.method === "POST") {
        return withCors(
          await recordRuntimeApproval(
            request,
            env,
            decodeURIComponent(approvalRecordMatch[1]),
          ),
        );
      }

      const runtimeLogsMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/runtime-logs$/,
      );
      if (runtimeLogsMatch?.[1] && request.method === "POST") {
        return withCors(
          await ingestRuntimeLogs(
            request,
            env,
            decodeURIComponent(runtimeLogsMatch[1]),
          ),
        );
      }

      const sessionConnectionsMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/connections$/,
      );
      if (sessionConnectionsMatch?.[1] && request.method === "GET") {
        return withCors(
          await listSessionConnections(
            request,
            env,
            decodeURIComponent(sessionConnectionsMatch[1]),
          ),
        );
      }
      if (sessionConnectionsMatch?.[1] && request.method === "POST") {
        return withCors(
          await requestSessionConnection(
            request,
            env,
            decodeURIComponent(sessionConnectionsMatch[1]),
          ),
        );
      }

      const runtimeResourcesMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/resources$/,
      );
      if (runtimeResourcesMatch?.[1] && request.method === "GET") {
        const response = await runtimeSessionResources(
          request,
          env,
          decodeURIComponent(runtimeResourcesMatch[1]),
        );
        if (response) return withCors(response);
      }
      const runtimeMemoryMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/memory(?:\/(save|read|list))?$/,
      );
      if (
        runtimeMemoryMatch?.[1] &&
        request.method === (runtimeMemoryMatch[2] ? "POST" : "GET")
      ) {
        return withCors(
          await runtimeSessionMemory(
            request,
            env,
            decodeURIComponent(runtimeMemoryMatch[1]),
            (runtimeMemoryMatch[2] as "save" | "read" | "list" | undefined) ?? "recall",
          ),
        );
      }
      const runtimeRenderMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/renders$/,
      );
      if (runtimeRenderMatch?.[1] && request.method === "POST") {
        return withCors(
          await commitRuntimeAgentRender(
            request,
            env,
            decodeURIComponent(runtimeRenderMatch[1]),
          ),
        );
      }
      const runtimeResultMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/result$/,
      );
      if (runtimeResultMatch?.[1] && request.method === "POST") {
        return withCors(
          await commitRuntimeSessionResult(
            request,
            env,
            decodeURIComponent(runtimeResultMatch[1]),
          ),
        );
      }

      const runtimeModelGatewayMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/model-gateway\/api\/v1\/(chat\/completions|responses|messages)$/,
      );
      if (runtimeModelGatewayMatch?.[1] && runtimeModelGatewayMatch[2]) {
        if (request.method !== "POST") {
          return withCors(
            problem(405, "method_not_allowed", "Only POST is supported"),
          );
        }
        const sessionId = decodeURIComponent(runtimeModelGatewayMatch[1]);
        const protocol: ModelGatewayProtocol =
          runtimeModelGatewayMatch[2] === "responses"
            ? "responses"
            : runtimeModelGatewayMatch[2] === "messages"
              ? "anthropic_messages"
              : "chat_completions";
        const latency = latencyTelemetry(
          env,
          "edge",
          { session_key: sessionId },
          requestRegion(request),
        );
        const response = await latency.time(
          "model_gateway.responded",
          () =>
            runtimeModelGateway(
              request,
              env,
              sessionId,
              protocol,
              undefined,
              latency,
            ),
          (result) => ({ status: result.status, protocol, capability: false }),
        );
        latency.send(context);
        return withCors(response);
      }

      const prewarmedModelGatewayRouteMatch = url.pathname.match(
        /^\/v1\/model-gateway-capabilities\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/api\/v1\/(chat\/completions|responses|messages)$/,
      );
      if (
        prewarmedModelGatewayRouteMatch?.[1] &&
        prewarmedModelGatewayRouteMatch[2] &&
        prewarmedModelGatewayRouteMatch[3] &&
        prewarmedModelGatewayRouteMatch[4] &&
        prewarmedModelGatewayRouteMatch[5]
      ) {
        if (request.method !== "POST") {
          return withCors(
            problem(405, "method_not_allowed", "Only POST is supported"),
          );
        }
        const [, accountId, deploymentId, imageVersion, capabilityId, path] =
          prewarmedModelGatewayRouteMatch;
        const protocol: ModelGatewayProtocol =
          path === "responses"
            ? "responses"
            : path === "messages"
              ? "anthropic_messages"
              : "chat_completions";
        const latency = latencyTelemetry(
          env,
          "edge",
          {},
          requestRegion(request),
        );
        const response = await latency.time(
          "model_gateway.responded",
          () =>
            workerdCapabilityModelGateway(
              request,
              env,
              decodeURIComponent(accountId),
              decodeURIComponent(deploymentId),
              decodeURIComponent(imageVersion),
              decodeURIComponent(capabilityId),
              protocol,
              latency,
            ),
          (result) => ({ status: result.status, protocol, capability: true }),
        );
        latency.send(context);
        return withCors(response);
      }

      const runtimeModelResolveMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/models\/resolve$/,
      );
      if (runtimeModelResolveMatch?.[1] && request.method === "POST") {
        return withCors(
          await resolveRuntimeModel(
            request,
            env as Env & PlatformEnv,
            decodeURIComponent(runtimeModelResolveMatch[1]),
          ),
        );
      }

      // Template inspections are account-independent (the compiled version is
      // shared across accounts), so anonymous visitors can preview a template
      // before signing up. Installation stays authenticated.
      if (
        url.pathname === "/v1/public/template-inspections" &&
        request.method === "POST"
      ) {
        return withCors(
          await inspectTemplate(request, env as Env & PlatformEnv, context),
        );
      }

      const identity = url.pathname.startsWith("/v1/")
        ? await authenticateRequest(request, env as Env & ManagedAgentAuthEnv, url)
        : null;
      if (url.pathname.startsWith("/v1/") && !identity) {
        return withCors(
          problem(401, "unauthorized", "OpenComputer authentication required"),
        );
      }
      if (!identity) {
        return withCors(problem(404, "not_found", "Route not found"));
      }
      if (
        identity.principal === COMPUTER_PRINCIPAL &&
        isComputerGrantRoute(request.method, url.pathname)
      ) {
        return withCors(
          problem(
            403,
            "computer_key_forbidden",
            "The computer cannot connect, attach or grant credentials; a person does that from Slack or the dashboard.",
          ),
        );
      }

      if (
        url.pathname === "/v1/account/runtime-profile" &&
        request.method === "GET"
      ) {
        const platform = env as Env & PlatformEnv;
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const assignment = await account.getManagedRuntimeProfile();
        const profile = managedRuntimeProfile(
          platform,
          assignment
            ? assignment.profileId
            : configuredManagedRuntimeProfileAssignment(
                platform,
                identity.accountId,
              ),
        );
        return withCors(
          json({
            customized: Boolean(profile),
            displayName: profile?.displayName ?? "OpenComputer default",
          }),
        );
      }

      const templateRoute =
        (request.method === "POST" &&
          (url.pathname === "/v1/template-inspections" ||
            url.pathname === "/v1/template-installations")) ||
        (request.method === "GET" &&
          /^\/v1\/template-installations\/[^/]+$/.test(url.pathname)) ||
        (request.method === "POST" &&
          /^\/v1\/template-installations\/[^/]+\/finalize$/.test(
            url.pathname,
          ));
      if (templateRoute) {
        if (identity.projectId) {
          return withCors(
            problem(
              403,
              "forbidden",
              "Project tokens cannot install templates",
            ),
          );
        }
        const response = await routeTemplateRequest(
          request,
          env as Env & PlatformEnv,
          identity,
          context,
        );
        return withCors(
          response ?? problem(404, "not_found", "Template route not found"),
        );
      }

      if (
        url.pathname === "/v1/channel-connections/claim" &&
        request.method === "POST"
      ) {
        return withCors(await claimChannelConnection(request, env, identity));
      }

      const computerGrants = await routeComputerServiceConnections(request, env, identity);
      if (computerGrants) return withCors(computerGrants);

      const computerResponse = await routeComputerDashboard(
        request,
        env as Env & ComputerEdgeEnv,
        identity,
        (promise) => context.waitUntil(promise),
      );
      if (computerResponse) return withCors(computerResponse);

      if (url.pathname === "/v1/me" && request.method === "GET") {
        const body: ManagedAgentIdentity = {
          userId: identity.userId,
          accountId: identity.accountId,
          organizationId: identity.organizationId,
          role: identity.role,
        };
        return withCors(json(body));
      }

      const projectArchiveMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/(archive|restore)$/,
      );
      if (projectArchiveMatch?.[1] && request.method === "POST") {
        if (identity.projectId) {
          return withCors(
            problem(403, "forbidden", "Project tokens cannot change project archive state"),
          );
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.setProjectArchived(
          decodeURIComponent(projectArchiveMatch[1]),
          projectArchiveMatch[2] === "archive",
        );
        if (!project) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        if (project.archivedAt) {
          context.waitUntil(
            stopArchivedProjectSessions(env, identity, project.id).catch(
              (error: unknown) =>
                console.error(
                  JSON.stringify({
                    level: "error",
                    event: "project.archive_cleanup_failed",
                    projectId: project.id,
                    message: error instanceof Error ? error.message : String(error),
                  }),
                ),
            ),
          );
        }
        return withCors(json(await projectResponse(account, project)));
      }

      if (url.pathname === "/v1/projects" && request.method === "POST") {
        if (identity.projectId) {
          return withCors(
            problem(403, "forbidden", "Project tokens cannot create projects"),
          );
        }
        const body = (await readJson(request)) as CreateProjectInput | null;
        if (!body || typeof body.name !== "string") {
          return withCors(
            problem(400, "invalid_project", "Expected a project name"),
          );
        }
        if (
          body.environmentMode !== undefined &&
          !isProjectEnvironmentMode(body.environmentMode)
        ) {
          return withCors(
            problem(
              400,
              "invalid_environment_mode",
              "environmentMode must be single or legacy",
            ),
          );
        }
        const slug = (typeof body.slug === "string" ? body.slug : body.name)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "");
        const project = await env.ACCOUNTS.getByName(
          identity.accountId,
        ).createProject({
          id: `prj_${crypto.randomUUID().replaceAll("-", "")}`,
          name: body.name,
          slug,
          ...(body.environmentMode ? { environmentMode: body.environmentMode } : {}),
        });
        return withCors(
          json(
            await projectResponse(
              env.ACCOUNTS.getByName(identity.accountId),
              project,
            ),
            201,
          ),
        );
      }

      if (url.pathname === "/v1/projects" && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const projects = (await account.listProjects({
          archived: url.searchParams.get("archived") === "true",
        })).filter(
          (project: Project) =>
            !identity.projectId || project.id === identity.projectId,
        );
        return withCors(
          json({
            projects: await Promise.all(
              projects.map((project: Project) =>
                projectResponse(account, project),
              ),
            ),
          }),
        );
      }

      // A one-hour git credential for the organization's automations
      // repository (work 067), for `opencomputer push`. It holds every
      // automation's code, so a key scoped to one project gets none.
      if (
        url.pathname === "/v1/automations/repository/credentials" &&
        request.method === "POST"
      ) {
        if (identity.projectId) {
          return withCors(
            problem(
              403,
              "forbidden",
              "A project-scoped key cannot push to the automations repository",
            ),
          );
        }
        const platform = env as Env & PlatformEnv;
        if (!platform.CODE_STORAGE_ORG || !platform.PIERRE_PRIVATE_KEY) {
          return withCors(
            problem(
              503,
              "automation_repository_unavailable",
              "Automation repositories are not configured",
            ),
          );
        }
        return withCors(
          json(
            await automationRepositoryCredential(platform, {
              accountId: identity.accountId,
              userId: identity.userId,
            }),
          ),
        );
      }

      const projectSourceMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/source-archive$/,
      );
      if (projectSourceMatch?.[1] && request.method === "GET") {
        const projectId = decodeURIComponent(projectSourceMatch[1]);
        const project = await env.ACCOUNTS.getByName(
          identity.accountId,
        ).getProject(projectId);
        if (
          !project ||
          (identity.projectId && identity.projectId !== project.id)
        ) {
          return withCors(
            problem(404, "project_not_found", "Project not found"),
          );
        }
        try {
          return withCors(
            await projectSourceArchive(env, identity.accountId, project.id),
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "project.source_archive_failed",
              accountId: identity.accountId,
              projectId: project.id,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return withCors(
            problem(
              502,
              "project_source_unavailable",
              "Project source is temporarily unavailable",
            ),
          );
        }
      }

      if (url.pathname === "/v1/github" && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const app = await account.getGitHubApp();
        return withCors(json({
          connections: await account.listGitHubInstallations(),
          app: app ? { slug: app.slug } : null,
        }));
      }
      if (url.pathname === "/v1/github/connect" && request.method === "POST") {
        if (identity.projectId) {
          return withCors(problem(403, "forbidden", "Project tokens cannot manage GitHub connections"));
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const app = await account.getGitHubApp();
        if (!app) {
          return withCors(problem(503, "github_app_not_configured", "The managed OpenComputer GitHub App is not configured"));
        }
        const nonce = oauthNonce();
        await account.createGitHubConnectState({
          nonceHash: await sha256(nonce),
          ttlSeconds: GITHUB_CONNECT_STATE_TTL_SECONDS,
        });
        const encodedState = encodeOAuthState(identity.accountId, nonce);
        const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`);
        installUrl.searchParams.set("state", encodedState);
        const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
        authorizeUrl.searchParams.set("client_id", app.clientId);
        authorizeUrl.searchParams.set("state", encodedState);
        return withCors(json({ installUrl: installUrl.toString(), authorizeUrl: authorizeUrl.toString() }));
      }

      const deploymentSourceMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/deployment-source(?:\/(.+))?$/,
      );
      if (deploymentSourceMatch?.[1]) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(
          decodeURIComponent(deploymentSourceMatch[1]),
        );
        if (
          !project ||
          (identity.projectId && identity.projectId !== project.id)
        ) {
          return withCors(
            problem(404, "project_not_found", "Project not found"),
          );
        }
        return withCors(
          await routeGitDeployRequest(
            request,
            env as Env & PlatformEnv,
            identity,
            account,
            project,
            deploymentSourceMatch[2],
          ),
        );
      }

      const projectGitHubMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/github(?:\/(connect|attach|repositories))?$/,
      );
      if (projectGitHubMatch?.[1]) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(
          decodeURIComponent(projectGitHubMatch[1]),
        );
        if (
          !project ||
          (identity.projectId && identity.projectId !== project.id)
        ) {
          return withCors(
            problem(404, "project_not_found", "Project not found"),
          );
        }
        if (!projectGitHubMatch[2] && request.method === "GET") {
          const app = await account.getGitHubApp();
          return withCors(
            json({
              environments: await account.getGitHubStatus(project.id),
              connections: await account.listGitHubInstallations(),
              app: app ? { slug: app.slug } : null,
            }),
          );
        }
        if (identity.projectId) {
          return withCors(
            problem(
              403,
              "forbidden",
              "Project tokens cannot manage GitHub installations",
            ),
          );
        }
        if (projectGitHubMatch[2] === "repositories") {
          return withCors(
            request.method === "GET"
              ? await listProjectGitHubRepositories(url, account, project)
              : problem(405, "method_not_allowed", "Unsupported GitHub request"),
          );
        }
        if (projectGitHubMatch[2] === "connect" && request.method === "POST") {
          const body = await readBoundedJson(request, 16 * 1024);
          const parsedEnvironments = parseGitHubEnvironments(project, body?.environments);
          if (!parsedEnvironments.ok) return withCors(parsedEnvironments.response);
          const environments = parsedEnvironments.environments;
          const app = await account.getGitHubApp();
          if (!app) {
            return withCors(
              problem(
                503,
                "github_app_not_configured",
                "The managed OpenComputer GitHub App is not configured",
              ),
            );
          }
          const nonce = oauthNonce();
          await account.createGitHubConnectState({
            nonceHash: await sha256(nonce),
            projectId: project.id,
            environments,
            ttlSeconds: GITHUB_CONNECT_STATE_TTL_SECONDS,
          });
          const installUrl = new URL(
            `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
          );
          const encodedState = encodeOAuthState(identity.accountId, nonce);
          installUrl.searchParams.set("state", encodedState);
          const authorizeUrl = new URL(
            "https://github.com/login/oauth/authorize",
          );
          authorizeUrl.searchParams.set("client_id", app.clientId);
          authorizeUrl.searchParams.set("state", encodedState);
          return withCors(
            json({
              installUrl: installUrl.toString(),
              authorizeUrl: authorizeUrl.toString(),
            }),
          );
        }
        if (projectGitHubMatch[2] === "attach" && request.method === "POST") {
          const body = await readBoundedJson(request, 16 * 1024);
          const installationId = body?.connectionId;
          if (typeof installationId !== "string" || !installationId) {
            return withCors(problem(400, "invalid_github_attachment", "Expected a connectionId and environment"));
          }
          const scoped = projectScope(project, body?.environment, { legacyDefault: "required" });
          if (!scoped.ok) return withCors(scoped.response);
          const environment = scoped.scope.environment;
          return withCors(
            (await account.attachGitHub({ projectId: project.id, environment, installationId }))
              ? json({ attached: true }, 201)
              : problem(404, "github_connection_not_found", "GitHub connection not found"),
          );
        }
        if (!projectGitHubMatch[2] && request.method === "DELETE") {
          const scoped = projectScope(project, url.searchParams.get("environment"), {
            legacyDefault: "required",
          });
          if (!scoped.ok) return withCors(scoped.response);
          const environment = scoped.scope.environment;
          return withCors(
            (await account.detachGitHub({
              projectId: project.id,
              environment,
            }))
              ? new Response(null, { status: 204 })
              : problem(404, "github_not_connected", "Nothing is attached"),
          );
        }
        return withCors(
          problem(405, "method_not_allowed", "Unsupported GitHub request"),
        );
      }

      const projectMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)$/);
      if (projectMatch?.[1] && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(
          decodeURIComponent(projectMatch[1]),
        );
        if (
          !project ||
          (identity.projectId && identity.projectId !== project.id)
        ) {
          return withCors(
            problem(404, "project_not_found", "Project not found"),
          );
        }
        const projectAgents = await agentsForProject(account, project);
        const projectAgentIds = new Set(projectAgents.map((agent) => agent.id));
        // The newest page of the project's rows, from the projection: the
        // overview is a list read and never fans out to Session objects.
        const { sessions } = await account.listSessionSummaries({
          project: project.id,
          labels: [],
          limit: 100,
        });
        const deployments = (
          await Promise.all(
            projectAgents.map((agent) => account.listDeployments(agent.id)),
          )
        ).flat();
        const connections = (await account.listConnections()).filter(
          (connection: Connection) => projectAgentIds.has(connection.agentId),
        );
        const channels = (await account.listChannelConnections()).filter(
          (connection: SlackConnection) =>
            projectAgentIds.has(connection.agentId),
        );
        return withCors(
          json({
            project: await projectResponse(account, project, projectAgents),
            templateSource: await templateSourceForProject(
              env,
              identity.accountId,
              project.id,
            ),
            sessions,
            deployments,
            accessTokens: await account.listProjectAccessTokens(project.id),
            connections,
            channels,
            schedules: [],
            schema: {
              projectId: project.id,
              version: deployments.length,
              agents: projectAgents.map((agent) => {
                const latest = deployments.find(
                  (deployment: (typeof deployments)[number]) =>
                    deployment.agentId === agent.id,
                );
                return {
                  name: agent.name,
                  tools: latest?.connections ?? [],
                  connections: latest?.connections ?? [],
                };
              }),
              updatedAt: deployments[0]?.createdAt ?? project.updatedAt,
            },
          }),
        );
      }

      const projectDatabaseQueryMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/database\/query$/,
      );
      if (projectDatabaseQueryMatch?.[1]) {
        if (request.method !== "POST") {
          return withCors(
            problem(405, "method_not_allowed", "Database inspection uses POST"),
          );
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(
          decodeURIComponent(projectDatabaseQueryMatch[1]),
        );
        if (
          !project ||
          (identity.projectId && identity.projectId !== project.id)
        ) {
          return withCors(
            problem(404, "project_not_found", "Project not found"),
          );
        }
        const body = await readBoundedJson(request, 128 * 1024);
        const scopedDatabase = projectScope(project, body?.environment, {
          legacyDefault: "required",
        });
        if (!scopedDatabase.ok) return withCors(scopedDatabase.response);
        const environment = scopedDatabase.scope.environment;
        if (
          !project.environments.some(
            (candidate: {
              name: string;
              activeDeploymentId?: string | null;
            }) =>
              candidate.name === environment && candidate.activeDeploymentId,
          )
        ) {
          return withCors(
            problem(
              409,
              "database_not_deployed",
              `Deploy this project to ${environment} before inspecting its database`,
            ),
          );
        }
        if (typeof body?.sql !== "string") {
          return withCors(
            problem(400, "invalid_database_query", "Expected a SQL query"),
          );
        }
        let parameters;
        try {
          parameters = validateDatabaseParameters(body.parameters ?? []);
        } catch (error) {
          return withCors(
            problem(
              400,
              "invalid_database_query",
              error instanceof Error ? error.message : "Invalid query parameters",
            ),
          );
        }
        const platform = env as Env & PlatformEnv;
        if (!platform.DATABASES) {
          return withCors(
            problem(503, "database_unavailable", "Project database is unavailable"),
          );
        }
        try {
          const result = await platform.DATABASES.getByName(
            databaseObjectName(identity.accountId, project.id, environment),
          ).query(body.sql, parameters);
          return withCors(json({ environment, result }));
        } catch (error) {
          const notProvisioned = isDatabaseNotProvisionedError(error);
          console.error(
            JSON.stringify({
              level: "warn",
              event: "project.database_query_failed",
              accountId: identity.accountId,
              projectId: project.id,
              environment,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return withCors(
            problem(
              notProvisioned ? 409 : 400,
              notProvisioned
                ? "database_not_provisioned"
                : "database_query_failed",
              notProvisioned
                ? `Redeploy this project to ${environment} to provision its database`
                : error instanceof Error
                  ? error.message
                  : "Database query failed",
            ),
          );
        }
      }

      const projectTokensMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/tokens$/,
      );
      if (projectTokensMatch?.[1]) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(
          decodeURIComponent(projectTokensMatch[1]),
        );
        if (
          !project ||
          (identity.projectId && identity.projectId !== project.id)
        ) {
          return withCors(
            problem(404, "project_not_found", "Project not found"),
          );
        }
        if (request.method === "GET") {
          return withCors(
            json({
              tokens: await account.listProjectAccessTokens(project.id),
            }),
          );
        }
        if (request.method === "POST") {
          if (identity.projectId) {
            return withCors(
              problem(403, "forbidden", "Project tokens cannot create tokens"),
            );
          }
          const body = await readBoundedJson(request, 128 * 1024);
          const scopedToken = projectScope(project, body?.environment);
          if (!scopedToken.ok) return withCors(scopedToken.response);
          const environment = scopedToken.scope.environment;
          const secret = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
          const token = `blue.${encodeAccountId(identity.accountId)}.${secret}`;
          const created = await account.createProjectAccessToken({
            id: `tok_${crypto.randomUUID().replaceAll("-", "")}`,
            projectId: project.id,
            name:
              typeof body?.name === "string"
                ? body.name
                : environment === "default"
                  ? "Default"
                  : "Development",
            environment,
            prefix: `${token.slice(0, 18)}…`,
            tokenHash: await sha256(token),
            token,
          });
          return withCors(json(created, 201));
        }
      }

      const projectMemoryInventoryMatch = url.pathname.match(MEMORY_INVENTORY_PATTERN);
      if (projectMemoryInventoryMatch?.[1]) {
        return withCors(
          await routeProjectMemoryInventory(
            request,
            env as Env & PlatformEnv,
            identity,
            decodeURIComponent(projectMemoryInventoryMatch[1]),
          ),
        );
      }
      const projectMemoryMatch = url.pathname.match(MEMORY_ROUTE_PATTERN);
      if (projectMemoryMatch?.[1] && projectMemoryMatch[2]) {
        return withCors(
          await routeProjectMemory(request, env as Env & PlatformEnv, identity, {
            projectId: decodeURIComponent(projectMemoryMatch[1]),
            resource: decodeURIComponent(projectMemoryMatch[2]),
            ...(projectMemoryMatch[3]
              ? { documentId: decodeURIComponent(projectMemoryMatch[3]) }
              : {}),
          }),
        );
      }

      const projectSecretsMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/secrets(?:\/([^/]+))?$/,
      );
      const projectWebhooksMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/webhooks(?:\/([^/]+))?(?:\/(rotate-token|requests))?$/,
      );
      if (projectWebhooksMatch?.[1]) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const projectId = decodeURIComponent(projectWebhooksMatch[1]);
        const webhookId = projectWebhooksMatch[2]
          ? decodeURIComponent(projectWebhooksMatch[2])
          : undefined;
        const operation = projectWebhooksMatch[3];
        const project = await account.getProject(projectId);
        if (!project || (identity.projectId && identity.projectId !== project.id)) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        const requestedEnvironment = url.searchParams.get("environment");
        let environment: ProjectEnvironmentName | undefined;
        if (requestedEnvironment) {
          const scopedList = projectScope(project, requestedEnvironment);
          if (!scopedList.ok) return withCors(scopedList.response);
          environment = scopedList.scope.environment;
        }
        const requestedAgentId = url.searchParams.get("agentId")?.trim() || undefined;
        if (requestedAgentId && !projectOwnsAgent(project, requestedAgentId)) {
          return withCors(problem(403, "project_scope_violation", "Agent is outside this project"));
        }
        if (request.method === "GET" && !webhookId) {
          return withCors(json({
            webhooks: await account.listProjectWebhooks({
              projectId,
              ...(environment ? { environment } : {}),
              ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
            }),
          }));
        }
        if (request.method === "GET" && webhookId && operation === "requests") {
          const webhook = await account.getProjectWebhook(webhookId);
          if (!webhook || webhook.projectId !== projectId) {
            return withCors(problem(404, "webhook_not_found", "Webhook not found"));
          }
          return withCors(json({
            requests: await account.listProjectWebhookRequests({
              projectId,
              environment: webhook.environment,
              agentId: webhook.agentId,
              webhookId,
            }),
          }));
        }
        if (identity.projectId) {
          return withCors(problem(403, "forbidden", "Project access tokens cannot manage webhooks"));
        }
        if (request.method === "POST" && !webhookId) {
          const body = await readBoundedJson(request, 64 * 1024);
          const name = typeof body?.name === "string" ? body.name.trim() : "";
          const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
          if (!name || name.length > 80 || !agentId) {
            return withCors(problem(400, "invalid_webhook", "Expected name, agentId, and environment"));
          }
          const scopedWebhook = projectScope(project, body?.environment, {
            legacyDefault: "required",
          });
          if (!scopedWebhook.ok) return withCors(scopedWebhook.response);
          const webhookEnvironment = scopedWebhook.scope.environment;
          let identitySource: string | undefined;
          if (body?.identity !== undefined) {
            if (typeof body.identity !== "string") {
              return withCors(problem(400, "invalid_webhook", "identity must be a string"));
            }
            try {
              identitySource = parseWebhookIdentitySource(body.identity);
            } catch (error) {
              return withCors(problem(400, "invalid_webhook", error instanceof Error ? error.message : "Invalid identity"));
            }
          }
          if (!projectOwnsAgent(project, agentId)) {
            return withCors(problem(403, "project_scope_violation", "Agent is outside this project"));
          }
          const deployment = await account.resolveDeployment(`${agentId}@${webhookEnvironment}`);
          if (!deployment) {
            return withCors(problem(409, "webhook_target_unavailable", "Deploy the agent in this environment first"));
          }
          const id = `wh_${crypto.randomUUID().replaceAll("-", "")}`;
          const token = randomWebhookToken();
          const created = await account.createProjectWebhook({
            id,
            projectId,
            environment: webhookEnvironment,
            agentId,
            name,
            token,
            tokenHash: await sha256(token),
            createdBy: identity.userId,
            ...(identitySource ? { identity: identitySource } : {}),
          });
          await env.ACCOUNTS.getByName(webhookRouteName(id)).setWebhookRoute({
            accountId: identity.accountId,
            webhookId: id,
            tokenHash: await sha256(token),
          });
          return withCors(json({ webhook: created }, 201));
        }
        if (webhookId && request.method === "PATCH" && !operation) {
          const body = await readBoundedJson(request, 64 * 1024);
          const name = typeof body?.name === "string" ? body.name.trim() : undefined;
          const enabled = typeof body?.enabled === "boolean" ? body.enabled : undefined;
          let identitySource: string | null | undefined;
          if (body?.identity === null) identitySource = null;
          else if (typeof body?.identity === "string") {
            try {
              identitySource = parseWebhookIdentitySource(body.identity);
            } catch (error) {
              return withCors(problem(400, "invalid_webhook_update", error instanceof Error ? error.message : "Invalid identity"));
            }
          } else if (body?.identity !== undefined) {
            return withCors(problem(400, "invalid_webhook_update", "identity must be a string or null"));
          }
          if (
            (name !== undefined && (!name || name.length > 80)) ||
            (name === undefined && enabled === undefined && identitySource === undefined)
          ) {
            return withCors(problem(400, "invalid_webhook_update", "Expected a valid name, enabled state, or identity"));
          }
          const webhook = await account.updateProjectWebhook({
            id: webhookId,
            projectId,
            ...(name !== undefined ? { name } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
            ...(identitySource !== undefined ? { identity: identitySource } : {}),
          });
          return withCors(
            webhook
              ? json({ webhook })
              : problem(404, "webhook_not_found", "Webhook not found"),
          );
        }
        if (webhookId && request.method === "POST" && operation === "rotate-token") {
          const token = randomWebhookToken();
          const tokenHash = await sha256(token);
          const webhook = await account.rotateProjectWebhookToken({
            id: webhookId,
            projectId,
            tokenHash,
          });
          if (!webhook) {
            return withCors(problem(404, "webhook_not_found", "Webhook not found"));
          }
          await env.ACCOUNTS.getByName(webhookRouteName(webhookId)).setWebhookRoute({
            accountId: identity.accountId,
            webhookId,
            tokenHash,
          });
          return withCors(json({ webhook: { ...webhook, token } }));
        }
        if (webhookId && request.method === "DELETE" && !operation) {
          const deleted = await account.deleteProjectWebhook(webhookId, projectId);
          if (!deleted) {
            return withCors(problem(404, "webhook_not_found", "Webhook not found"));
          }
          await env.ACCOUNTS.getByName(webhookRouteName(webhookId)).clearWebhookRoute(webhookId);
          return withCors(new Response(null, { status: 204 }));
        }
      }
      // Event subscriptions (work 025): recorded turn outcomes of agents in
      // this project, delivered as queued turns to a session in the same
      // project. Immutable once created; deletion stops pending deliveries.
      const projectEventSubscriptionsMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/event-subscriptions(?:\/([^/]+))?$/,
      );
      if (projectEventSubscriptionsMatch?.[1]) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const projectId = decodeURIComponent(projectEventSubscriptionsMatch[1]);
        const subscriptionId = projectEventSubscriptionsMatch[2]
          ? decodeURIComponent(projectEventSubscriptionsMatch[2])
          : undefined;
        const project = await account.getProject(projectId);
        if (!project || (identity.projectId && identity.projectId !== project.id)) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        if (request.method === "GET" && !subscriptionId) {
          return withCors(
            json({ subscriptions: await account.listEventSubscriptions(project.id) }),
          );
        }
        if (request.method === "GET" && subscriptionId) {
          const subscription = await account.getEventSubscription(subscriptionId);
          return withCors(
            subscription && subscription.projectId === project.id
              ? json({ subscription })
              : problem(404, "event_subscription_not_found", "Event subscription not found"),
          );
        }
        if (request.method === "POST" && !subscriptionId) {
          const body = await readBoundedJson(request, 16 * 1024);
          const agentId =
            typeof body?.agentId === "string" && body.agentId.trim()
              ? body.agentId.trim()
              : undefined;
          const events = Array.isArray(body?.events)
            ? [...new Set(body.events as unknown[])]
            : [];
          const destination = isRecord(body?.destination) ? body.destination : null;
          const targetSessionId =
            destination?.type === "session" && typeof destination.sessionId === "string"
              ? destination.sessionId
              : "";
          const scopedSubscription =
            body?.environment === undefined
              ? undefined
              : projectScope(project, body.environment, { legacyDefault: "required" });
          if (
            (body?.agentId !== undefined && agentId === undefined) ||
            events.length === 0 ||
            !events.every(
              (event) =>
                typeof event === "string" &&
                (OUTCOME_EVENT_TYPES as readonly string[]).includes(event),
            ) ||
            !targetSessionId ||
            (scopedSubscription && !scopedSubscription.ok && scopedSubscription.response.status === 400)
          ) {
            return withCors(
              problem(
                400,
                "invalid_event_subscription",
                "Expected events from turn.completed, turn.failed, turn.cancelled, a session destination, an optional agentId and an optional environment (development or production)",
              ),
            );
          }
          if (scopedSubscription && !scopedSubscription.ok) {
            return withCors(scopedSubscription.response);
          }
          // Narrows the source sessions by their labels at admission; the
          // same key and value rules as session labels.
          const sourceLabels =
            body?.sourceLabels === undefined ? undefined : parseLabelSelector(body.sourceLabels);
          if (sourceLabels && "error" in sourceLabels) {
            return withCors(
              problem(400, "invalid_event_subscription", `Invalid sourceLabels: ${sourceLabels.error}`),
            );
          }
          const requestedEnvironment = scopedSubscription?.ok
            ? scopedSubscription.scope.environment
            : undefined;
          if (agentId && !projectOwnsAgent(project, agentId)) {
            return withCors(
              problem(403, "project_scope_violation", "Agent is outside this project"),
            );
          }
          // The destination is authorized here, by the project: it must be a
          // session of an agent in this project that can still take turns.
          const target = await account.getSession(targetSessionId);
          if (!target || !projectOwnsAgent(project, target.agentId)) {
            return withCors(
              problem(404, "destination_session_not_found", "Destination session not found in this project"),
            );
          }
          const targetSnapshot = await env.SESSIONS.getByName(targetSessionId).snapshotOrNull();
          if (!targetSnapshot || targetSnapshot.status === "ended") {
            return withCors(
              problem(409, "destination_session_ended", "Destination session has ended"),
            );
          }
          // The subscription's environment is the destination's own
          // recorded one (trusted session metadata, never a deployment
          // alias). A caller may name it, but only to confirm it.
          if (!targetSnapshot.environment) {
            return withCors(
              problem(
                409,
                "destination_environment_unknown",
                "Destination session has no recorded environment; create it as agent@environment",
              ),
            );
          }
          if (requestedEnvironment !== undefined && requestedEnvironment !== targetSnapshot.environment) {
            return withCors(
              problem(
                409,
                "destination_environment_mismatch",
                `Destination session belongs to the ${targetSnapshot.environment} environment, not ${String(requestedEnvironment)}`,
              ),
            );
          }
          const created = await account.createEventSubscription({
            id: `evs_${crypto.randomUUID().replaceAll("-", "")}`,
            projectId: project.id,
            environment: targetSnapshot.environment,
            ...(agentId ? { agentId } : {}),
            ...(sourceLabels ? { sourceLabels: sourceLabels.labels } : {}),
            events: events as OutcomeEventType[],
            destination: { type: "session", sessionId: targetSessionId },
            createdBy: identity.userId,
          });
          return withCors(json({ subscription: created }, 201));
        }
        if (request.method === "DELETE" && subscriptionId) {
          const deleted = await account.deleteEventSubscription(subscriptionId, project.id);
          return withCors(
            deleted
              ? new Response(null, { status: 204 })
              : problem(404, "event_subscription_not_found", "Event subscription not found"),
          );
        }
        return withCors(problem(405, "method_not_allowed", "Unsupported event subscription request"));
      }
      const projectRuntimeVariablesMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/runtime-variables(?:\/([^/]+))?$/,
      );
      if (projectRuntimeVariablesMatch?.[1]) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const projectId = decodeURIComponent(projectRuntimeVariablesMatch[1]);
        const project = await account.getProject(projectId);
        if (!project || (identity.projectId && identity.projectId !== project.id)) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        const environmentValue =
          request.method === "GET" || request.method === "DELETE"
            ? url.searchParams.get("environment")
            : undefined;
        if (request.method === "GET" && !projectRuntimeVariablesMatch[2]) {
          let environment: ProjectEnvironmentName | undefined;
          if (environmentValue) {
            const scopedList = projectScope(project, environmentValue);
            if (!scopedList.ok) return withCors(scopedList.response);
            environment = scopedList.scope.environment;
          }
          const agentId = url.searchParams.get("agentId") ?? undefined;
          return withCors(json({
            variables: await account.listAgentRuntimeVariables(
              projectId,
              environment,
              agentId,
            ),
          }));
        }
        if (identity.projectId) {
          return withCors(problem(403, "forbidden", "Project access tokens cannot manage runtime variables"));
        }
        const encodedName = projectRuntimeVariablesMatch[2];
        const name = encodedName ? decodeURIComponent(encodedName) : "";
        if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) {
          return withCors(problem(400, "invalid_runtime_variable_name", "Runtime variable names must use uppercase letters, numbers, and underscores"));
        }
        if (
          /^(OPENCOMPUTER_|BLUE_|OPENCODE_|AWS_|CLOUDFLARE_|LD_|DYLD_)/.test(name) ||
          ["PATH", "NODE_OPTIONS", "NODE_PATH", "GH_TOKEN", "GITHUB_TOKEN"].includes(name)
        ) {
          return withCors(problem(400, "reserved_runtime_variable_name", "This runtime variable name is reserved"));
        }
        if (request.method === "PUT") {
          const body = await readBoundedJson(request, 128 * 1024);
          const scopedPut = projectScope(project, body?.environment);
          if (!scopedPut.ok) return withCors(scopedPut.response);
          const environment = scopedPut.scope.environment;
          const agentId = typeof body?.agentId === "string" && body.agentId
            ? body.agentId
            : undefined;
          if (
            typeof body?.value !== "string" ||
            new TextEncoder().encode(body.value).byteLength > 64 * 1024
          ) {
            return withCors(problem(400, "invalid_runtime_variable", "Expected a value no larger than 64 KiB"));
          }
          return withCors(json(await account.putAgentRuntimeVariable({
            projectId,
            environment,
            ...(agentId ? { agentId } : {}),
            name,
            value: body.value,
          })));
        }
        if (request.method === "DELETE") {
          const scopedDelete = projectScope(project, environmentValue);
          if (!scopedDelete.ok) return withCors(scopedDelete.response);
          const environment = scopedDelete.scope.environment;
          const agentId = url.searchParams.get("agentId") ?? undefined;
          const deleted = await account.deleteAgentRuntimeVariable({
            projectId,
            environment,
            ...(agentId ? { agentId } : {}),
            name,
          });
          return withCors(deleted ? new Response(null, { status: 204 }) : problem(404, "runtime_variable_not_found", "Runtime variable not found"));
        }
      }
      if (projectSecretsMatch?.[1]) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const projectId = decodeURIComponent(projectSecretsMatch[1]);
        const project = await account.getProject(projectId);
        if (!project || (identity.projectId && identity.projectId !== project.id)) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        const environmentValue =
          request.method === "GET" || request.method === "DELETE"
            ? url.searchParams.get("environment")
            : undefined;
        if (request.method === "GET" && !projectSecretsMatch[2]) {
          let environment: ProjectEnvironmentName | undefined;
          if (environmentValue) {
            const scopedList = projectScope(project, environmentValue);
            if (!scopedList.ok) return withCors(scopedList.response);
            environment = scopedList.scope.environment;
          }
          const agentId = url.searchParams.get("agentId") ?? undefined;
          return withCors(
            json({ secrets: await account.listManagedSecrets(projectId, environment, agentId) }),
          );
        }
        if (identity.projectId) {
          return withCors(problem(403, "forbidden", "Project access tokens cannot manage secrets"));
        }
        const encodedName = projectSecretsMatch[2];
        const name = encodedName ? decodeURIComponent(encodedName) : "";
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
          return withCors(problem(400, "invalid_secret_name", "Secret names must use uppercase letters, numbers, and underscores"));
        }
        if (request.method === "PUT") {
          const body = await readBoundedJson(request, 128 * 1024);
          const scopedPut = projectScope(project, body?.environment);
          if (!scopedPut.ok) return withCors(scopedPut.response);
          const environment = scopedPut.scope.environment;
          const agentId = typeof body?.agentId === "string" && body.agentId
            ? body.agentId
            : undefined;
          if (
            typeof body?.value !== "string" ||
            !body.value ||
            body.value.length > 64 * 1024
          ) {
            return withCors(problem(400, "invalid_secret", "Expected a non-empty value and at least one allowed HTTPS origin"));
          }
          const normalizedOrigins = normalizedSecretOrigins(body?.allowedOrigins);
          if (!normalizedOrigins) {
            return withCors(problem(400, "invalid_secret_origin", "Secret origins must be public HTTPS origins without paths"));
          }
          return withCors(
            json(
              await account.putManagedSecret({
                projectId,
                environment,
                ...(agentId ? { agentId } : {}),
                name,
                value: body.value,
                allowedOrigins: normalizedOrigins,
              }),
            ),
          );
        }
        if (request.method === "DELETE") {
          const scopedDelete = projectScope(project, environmentValue);
          if (!scopedDelete.ok) return withCors(scopedDelete.response);
          const environment = scopedDelete.scope.environment;
          const agentId = url.searchParams.get("agentId") ?? undefined;
          const deleted = await account.deleteManagedSecret({
            projectId,
            environment,
            ...(agentId ? { agentId } : {}),
            name,
          });
          return withCors(
            deleted
              ? new Response(null, { status: 204 })
              : problem(404, "secret_not_found", "Secret not found"),
          );
        }
      }

      const projectServiceConnectionsMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/service-connections$/,
      );
      if (projectServiceConnectionsMatch?.[1]) {
        const projectId = decodeURIComponent(
          projectServiceConnectionsMatch[1],
        );
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(projectId);
        if (!project || (identity.projectId && identity.projectId !== project.id)) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        if (request.method === "GET") {
          const service = url.searchParams.get("service") ?? undefined;
          const attachments = await account.listProjectServiceAttachments(
            project.id,
            service,
          );
          return withCors(
            json({
              attachments: attachments.map(projectServiceAttachmentResponse),
            }),
          );
        }
        if (identity.projectId) {
          return withCors(
            problem(403, "forbidden", "Project access tokens cannot manage service connections"),
          );
        }
        const body = await readJson(request);
        const connectionId =
          typeof body?.connectionId === "string" ? body.connectionId : "";
        if (!connectionId) {
          return withCors(
            problem(400, "connection_id_required", "A connection ID is required"),
          );
        }
        if (request.method === "POST") {
          const connection = await account.getConnectionForUser(
            connectionId,
            identity.userId,
          );
          if (!connection) {
            return withCors(problem(404, "connection_not_found", "Connection not found"));
          }
          try {
            return withCors(
              json(
                projectServiceAttachmentResponse(
                  await account.attachProjectServiceConnection({
                  projectId: project.id,
                  connectionId,
                  }),
                ),
                201,
              ),
            );
          } catch (error) {
            return withCors(
              problem(
                409,
                "connection_not_attachable",
                error instanceof Error ? error.message : "Connection cannot be attached",
              ),
            );
          }
        }
        if (request.method === "DELETE") {
          const connection = await account.getConnectionForUser(
            connectionId,
            identity.userId,
          );
          if (!connection) {
            return withCors(problem(404, "connection_not_found", "Connection not found"));
          }
          const detached = await account.detachProjectServiceConnection({
            projectId: project.id,
            connectionId,
          });
          return withCors(
            detached
              ? new Response(null, { status: 204 })
              : problem(404, "attachment_not_found", "Project service attachment not found"),
          );
        }
      }

      if (
        (url.pathname === "/v1/connections/link" ||
          url.pathname === "/v1/connections/google/link" ||
          url.pathname === "/v1/connections/github/link" ||
          url.pathname === "/v1/connections/linear/link") &&
        request.method === "POST"
      ) {
        return withCors(await linkManagedConnection(request, env, identity));
      }

      if (
        (url.pathname === "/v1/connections/google/status" ||
          url.pathname === "/v1/connections/github/status" ||
          url.pathname === "/v1/connections/linear/status") &&
        request.method === "GET"
      ) {
        return withCors(
          await managedConnectionStatus(
            request,
            env,
            identity,
            url.searchParams.get("service") ?? "",
          ),
        );
      }

      if (
        (url.pathname === "/v1/connections/google" ||
          url.pathname === "/v1/connections/github" ||
          url.pathname === "/v1/connections/linear") &&
        request.method === "DELETE"
      ) {
        return withCors(
          await disconnectManagedConnection(
            request,
            env,
            identity,
            url.searchParams.get("service") ?? "",
          ),
        );
      }

      if (
        (url.pathname === "/v1/connections/google/fetch" ||
          url.pathname === "/v1/connections/github/fetch" ||
          url.pathname === "/v1/connections/linear/fetch") &&
        request.method === "POST"
      ) {
        return withCors(await proxyManagedConnection(request, env, identity));
      }

      if (url.pathname.startsWith("/v1/openrouter/")) {
        const platform = env as Env & PlatformEnv;
        if (!platform.OPENROUTER_API_KEY) {
          return withCors(
            problem(
              503,
              "model_gateway_unavailable",
              "The managed-agent model gateway is not configured",
            ),
          );
        }
        const upstreamUrl = new URL(
          `${url.pathname.slice("/v1/openrouter".length)}${url.search}`,
          "https://openrouter.ai",
        );
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${platform.OPENROUTER_API_KEY}`);
        headers.set("http-referer", "https://app.opencomputer.dev");
        headers.set("x-title", "OpenComputer");
        headers.delete("host");
        const upstream = await fetch(upstreamUrl, {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : request.body,
          redirect: "manual",
        });
        return withCors(upstream);
      }

      if (
        url.pathname === "/v1/deployment-uploads" &&
        request.method === "POST"
      ) {
        const input = parseDeploymentUpload(await readJson(request));
        if (!input) {
          return withCors(
            problem(
              400,
              "invalid_deployment_upload",
              "Invalid deployment upload payload",
            ),
          );
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = identity.projectId
          ? await account.getProject(identity.projectId)
          : await account.projectForAgent(input.agentId);
        if (identity.projectId) {
          if (!project || !projectOwnsAgent(project, input.agentId)) {
            return withCors(
              problem(
                403,
                "project_scope_violation",
                "Token is scoped to another project",
              ),
            );
          }
        }
        if (project) {
          const archived = projectArchived(project);
          if (archived) return withCors(archived);
        }
        const platform = env as Env & PlatformEnv;
        if (!platform.DEPLOYMENTS) {
          return withCors(
            problem(
              503,
              "deployment_service_unavailable",
              "The managed-agent deployment service is not configured",
            ),
          );
        }
        const response = await platform.DEPLOYMENTS.fetch(
          "https://blue-deployments/v1/deployment-uploads",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accountId: identity.accountId,
              ...input,
            }),
          },
        );
        return withCors(response);
      }

      if (url.pathname === "/v1/deployments" && request.method === "POST") {
        const body = await readJson(request);
        if (parseDeploymentRegion(body?.region) === null) {
          return withCors(
            problem(
              400,
              "unsupported_region",
              `Unsupported region ${JSON.stringify(body?.region)}; supported: ${SUPPORTED_REGIONS}`,
            ),
          );
        }
        if (parseDeploymentEgress(body?.egress) === null) {
          return withCors(
            problem(
              400,
              "invalid_egress",
              `Invalid egress: expected { domains, cidrs }, each at most ${EGRESS_MAX_ENTRIES} ` +
                `entries of exact or "*." domains and IPv4/IPv6 addresses or CIDRs`,
            ),
          );
        }
        if (parseFixedIps(body?.fixedIps) === null) {
          return withCors(
            problem(
              400,
              "invalid_fixed_ips",
              `Unsupported fixed IPs region ${JSON.stringify(body?.fixedIps)}; supported: ${fixedIpsRegions().join(", ")}`,
            ),
          );
        }
        const input = parseDeploymentInput(
          body,
          env as Env & PlatformEnv,
          identity.accountId,
        );
        if (!input) {
          return withCors(
            problem(400, "invalid_deployment", "Invalid deployment payload"),
          );
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = identity.projectId
          ? await account.getProject(identity.projectId)
          : await account.projectForAgent(input.agentId);
        if (identity.projectId) {
          if (!project || !projectOwnsAgent(project, input.agentId)) {
            return withCors(
              problem(
                403,
                "project_scope_violation",
                "Token is scoped to another project",
              ),
            );
          }
        }
        if (project) {
          const archived = projectArchived(project);
          if (archived) return withCors(archived);
        }
        // A legacy project publishes under whatever alias the caller names,
        // as it always has. A single-mode project has one current
        // deployment: the alias is resolved to its canonical scope (an older
        // CLI's `development` included) and `production` is refused before
        // anything is uploaded or activated.
        let aliasCompatibility: ResolvedProjectScope["compatibility"];
        if (project?.environmentMode === "single") {
          const scopedAlias = projectScope(project, input.alias);
          if (!scopedAlias.ok) return withCors(scopedAlias.response);
          input.alias = scopedAlias.scope.environment;
          aliasCompatibility = scopedAlias.scope.compatibility;
        }
        if (input.models) {
          try {
            input.defaultModel = await admitDeploymentModels(
              input.models,
              env as Env & PlatformEnv,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Model validation failed";
            return withCors(
              problem(
                error instanceof ModelValidationError ? 409 : 503,
                error instanceof ModelValidationError
                  ? "invalid_model_selection"
                  : "model_catalog_unavailable",
                message,
              ),
            );
          }
        }
        let deployment: AgentDeployment;
        try {
          const database = input.projectDeployment?.resources.database;
          const databaseEnvironment = project
            ? environmentOfMode(project.environmentMode, input.alias)
            : isProjectEnvironmentName(input.alias)
              ? input.alias
              : undefined;
          if (database && databaseEnvironment) {
            const platform = env as Env & PlatformEnv;
            if (!platform.DATABASES) {
              return withCors(
                problem(503, "database_unavailable", "The project database is not configured"),
              );
            }
            if (!project) {
              return withCors(
                problem(409, "database_project_required", "Database migrations require a project deployment"),
              );
            }
            const scope = {
              accountId: identity.accountId,
              projectId: project.id,
              environment: databaseEnvironment,
            } as const;
            await platform.DATABASES.getByName(
              databaseObjectName(scope.accountId, scope.projectId, scope.environment),
            ).applyMigrations(scope, database.migrations);
          }
          deployment = await account.registerDeployment(input);
        } catch (error) {
          // The Memory DO refused the configuration (a resource changed its
          // provider kind) or two agents disagree on a shared resource: the
          // promotion did not happen and the caller can fix the declaration.
          if (error instanceof Error && error.message.startsWith("Memory resource ")) {
            return withCors(problem(409, "memory_configuration_conflict", error.message));
          }
          if (error instanceof Error && error.message.startsWith("Database migration ")) {
            return withCors(problem(409, "database_migration_failed", error.message));
          }
          if (error instanceof Error && error.message.startsWith("Project deployment primary agent ")) {
            return withCors(problem(409, "invalid_project_deployment", error.message));
          }
          throw error;
        }
        if (input.projectDeployment && isProjectEnvironmentName(input.alias)) {
          const project = identity.projectId
            ? await account.getProject(identity.projectId)
            : await account.projectForAgent(deployment.agentId);
          if (project) {
            await account.reconcileProjectSchedules({
              accountId: identity.accountId,
              userId: identity.userId,
              projectId: project.id,
              environment: input.alias,
              edgeOrigin: new URL(request.url).origin,
              projectDeployment: input.projectDeployment,
            });
          }
        }
        const platform = env as Env & PlatformEnv;
        if (
          platform.POOLS &&
          platform.WORKERD_RUNTIME &&
          sessionRunsOnWorkerd(platform, identity.accountId)
        ) {
          context.waitUntil(
            refillWorkerdPool(
              platform,
              identity.accountId,
              deployment,
              new URL(request.url).origin,
            ),
          );
        }
        return withCors(
          json(
            aliasCompatibility
              ? { ...deployment, aliasCompatibility }
              : deployment,
            201,
          ),
        );
      }

      if (url.pathname === "/v1/schedules" && request.method === "GET") {
        const projectId = url.searchParams.get("projectId")?.trim();
        const agentId = url.searchParams.get("agentId")?.trim();
        if (!projectId) {
          return withCors(
            problem(400, "invalid_schedule_scope", "Expected projectId and environment"),
          );
        }
        if (identity.projectId && identity.projectId !== projectId) {
          return withCors(problem(403, "project_scope_violation", "Token is scoped to another project"));
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(projectId);
        if (!project) return withCors(problem(404, "project_not_found", "Project not found"));
        const scoped = projectScope(project, url.searchParams.get("environment"), {
          legacyDefault: "required",
        });
        if (!scoped.ok) return withCors(scoped.response);
        const environment = scoped.scope.environment;
        if (agentId && !projectOwnsAgent(project, agentId)) {
          return withCors(problem(403, "project_scope_violation", "Agent is outside this project"));
        }
        return withCors(
          json({
            schedules: await account.listProjectSchedules({
              projectId,
              environment,
              ...(agentId ? { agentId } : {}),
            }),
          }),
        );
      }

      if (url.pathname === "/v1/schedule-runs" && request.method === "GET") {
        const projectId = url.searchParams.get("projectId")?.trim();
        const agentId = url.searchParams.get("agentId")?.trim();
        const scheduleId = url.searchParams.get("scheduleId")?.trim();
        if (!projectId) {
          return withCors(
            problem(400, "invalid_schedule_scope", "Expected projectId and environment"),
          );
        }
        if (identity.projectId && identity.projectId !== projectId) {
          return withCors(problem(403, "project_scope_violation", "Token is scoped to another project"));
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(projectId);
        if (!project) return withCors(problem(404, "project_not_found", "Project not found"));
        const scoped = projectScope(project, url.searchParams.get("environment"), {
          legacyDefault: "required",
        });
        if (!scoped.ok) return withCors(scoped.response);
        const environment = scoped.scope.environment;
        if (agentId && !projectOwnsAgent(project, agentId)) {
          return withCors(problem(403, "project_scope_violation", "Agent is outside this project"));
        }
        return withCors(
          json({
            runs: await account.listProjectScheduleRuns({
              projectId,
              environment,
              ...(agentId ? { agentId } : {}),
              ...(scheduleId ? { scheduleId } : {}),
            }),
          }),
        );
      }

      const scheduleRunMatch = url.pathname.match(/^\/v1\/schedules\/([^/]+)\/run$/);
      if (scheduleRunMatch?.[1] && request.method === "POST") {
        const projectId = url.searchParams.get("projectId")?.trim();
        const agentId = url.searchParams.get("agentId")?.trim();
        if (!projectId || !agentId) {
          return withCors(
            problem(400, "invalid_schedule_scope", "Expected projectId, environment, and agentId"),
          );
        }
        if (identity.projectId && identity.projectId !== projectId) {
          return withCors(problem(403, "project_scope_violation", "Token is scoped to another project"));
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = await account.getProject(projectId);
        if (!project) return withCors(problem(404, "project_not_found", "Project not found"));
        const scoped = projectScope(project, url.searchParams.get("environment"), {
          legacyDefault: "required",
        });
        if (!scoped.ok) return withCors(scoped.response);
        const environment = scoped.scope.environment;
        const archived = projectArchived(project);
        if (archived) return withCors(archived);
        if (!projectOwnsAgent(project, agentId)) {
          return withCors(problem(403, "project_scope_violation", "Agent is outside this project"));
        }
        try {
          const run = await account.runProjectScheduleNow({
            projectId,
            environment,
            agentId,
            scheduleId: decodeURIComponent(scheduleRunMatch[1]),
          });
          return withCors(json({ run }, 201));
        } catch (error) {
          if (error instanceof Error && error.message === "Schedule not found") {
            return withCors(problem(404, "schedule_not_found", error.message));
          }
          throw error;
        }
      }

      if (url.pathname === "/v1/deployments" && request.method === "GET") {
        const agentId = url.searchParams.get("agentId")?.trim();
        if (!agentId) {
          return withCors(
            problem(
              400,
              "invalid_agent",
              "Expected an agentId query parameter",
            ),
          );
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        if (identity.projectId) {
          const project = await account.getProject(identity.projectId);
          if (!project || !projectOwnsAgent(project, agentId)) {
            return withCors(
              problem(
                403,
                "project_scope_violation",
                "Token is scoped to another project",
              ),
            );
          }
        }
        return withCors(
          json({ deployments: await account.listDeployments(agentId) }),
        );
      }

      if (url.pathname === "/v1/agents" && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = identity.projectId
          ? await account.getProject(identity.projectId)
          : null;
        const agents = (await account.listAgents()).filter(
          (agent: AgentSummary) =>
            !identity.projectId ||
            Boolean(project && projectOwnsAgent(project, agent.id)),
        );
        return withCors(json({ agents }));
      }

      if (url.pathname === "/v1/logs" && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const requestedAgent = url.searchParams.get("agentId")?.trim();
        const requestedSession = url.searchParams.get("sessionId")?.trim();
        const requestedEnvironment = url.searchParams.get("environment");
        const after = url.searchParams.get("after") ?? "";
        const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(requestedLimit, 1_000))
          : 200;
        let environment: ProjectEnvironmentName | undefined;
        if (requestedEnvironment) {
          const logProject = identity.projectId
            ? await account.getProject(identity.projectId)
            : requestedAgent
              ? await account.projectForAgent(requestedAgent)
              : null;
          if (logProject) {
            const scopedLogs = projectScope(logProject, requestedEnvironment);
            if (!scopedLogs.ok) return withCors(scopedLogs.response);
            environment = scopedLogs.scope.environment;
          } else if (isProjectEnvironmentName(requestedEnvironment)) {
            // Account-wide: rows from every project mode are in scope, so any
            // canonical name is a valid filter and none is translated.
            environment = requestedEnvironment;
          } else {
            return withCors(
              problem(
                400,
                "invalid_environment",
                "environment must be default, development, or production",
              ),
            );
          }
        }
        const logs = await account.listAgentLogs({
          ...(identity.projectId ? { projectId: identity.projectId } : {}),
          ...(requestedAgent ? { agentId: requestedAgent } : {}),
          ...(requestedSession ? { sessionId: requestedSession } : {}),
          ...(environment ? { environment } : {}),
          after,
          limit,
        });
        return withCors(
          json({ logs, cursor: logs.at(-1)?.cursor ?? after }),
        );
      }


      if (
        url.pathname === "/v1/benchmarks/warm-pool" &&
        request.method === "POST"
      ) {
        return withCors(await benchmarkWarmRuntime(request, env, identity));
      }

      if (url.pathname === "/v1/connections" && request.method === "GET") {
        return withCors(await listManagedConnections(request, env, identity));
      }

      if (
        url.pathname === "/v1/connections/providers/google" &&
        request.method === "GET"
      ) {
        const config = googleConfig(env as Env & PlatformEnv);
        return withCors(
          config
            ? json({ provider: "google", clientId: config.clientId })
            : problem(
                503,
                "provider_unavailable",
                "Google connections are not configured",
              ),
        );
      }

      if (url.pathname === "/v1/connections" && request.method === "POST") {
        return withCors(await startToolConnection(request, env, identity));
      }

      if (
        url.pathname === "/v1/connections/channel-identity/link" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const token = typeof body?.token === "string" ? body.token : "";
        if (!/^[a-f0-9]{32}$/i.test(token)) {
          return withCors(
            problem(400, "invalid_channel_link", "Channel link is invalid"),
          );
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const claimed = await account.claimChannelIdentityLink(
          await sha256(token),
          identity.userId,
        );
        return withCors(
          claimed
            ? json({ linked: true })
            : problem(
                404,
                "channel_link_not_found",
                "Channel link is invalid or expired",
              ),
        );
      }

      const connectionMatch = url.pathname.match(
        /^\/v1\/connections\/([^/]+)$/,
      );
      if (connectionMatch?.[1] && request.method === "PUT") {
        return withCors(
          await completeToolConnection(
            request,
            env,
            identity,
            decodeURIComponent(connectionMatch[1]),
          ),
        );
      }
      if (connectionMatch?.[1] && request.method === "DELETE") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const connection = await account.getConnectionForUser(
          decodeURIComponent(connectionMatch[1]),
          identity.userId,
        );
        return withCors(
          connection
            ? json(await account.disconnectConnection(connection.id))
            : problem(404, "connection_not_found", "Connection not found"),
        );
      }

      // ── Model access (work 011) ─────────────────────────────────────────
      // Organization-owned Claude/Codex subscription connections. The provider
      // token is write-only and never returned. Management requires an org
      // admin; project-environment enablement requires project-settings
      // permission. Both are enforced here via identity.role and project token
      // scoping.
      if (
        url.pathname === "/v1/model-access/connections" &&
        request.method === "GET"
      ) {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        return withCors(
          json({
            data: await account.listModelAccessConnections(identity.accountId),
          }),
        );
      }

      if (
        url.pathname === "/v1/model-access/connections" &&
        request.method === "POST"
      ) {
        if (identity.role !== "admin") {
          return withCors(
            problem(403, "forbidden", "Organization admin role is required"),
          );
        }
        const body = await readJson(request);
        if (
          body?.provider !== "openai" &&
          body?.provider !== "anthropic" &&
          body?.provider !== "openrouter" &&
          body?.provider !== "openai_compatible"
        ) {
          return withCors(
            problem(
              400,
              "invalid_request",
              "provider must be openai, anthropic, openrouter, or openai_compatible",
            ),
          );
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        if (
          body.provider === "openrouter" ||
          body.provider === "openai_compatible"
        ) {
          const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
          if (apiKey.length < 8 || apiKey.length > 8_192) {
            return withCors(
              problem(400, "invalid_request", "A valid API key is required"),
            );
          }
          const rawBaseUrl =
            body.provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : typeof body.base_url === "string"
                ? body.base_url.trim()
                : "";
          let baseUrl: URL;
          try {
            baseUrl = new URL(rawBaseUrl);
          } catch {
            return withCors(
              problem(400, "invalid_request", "A valid HTTPS base_url is required"),
            );
          }
          if (
            baseUrl.protocol !== "https:" ||
            !egressOriginIsPublic(baseUrl) ||
            baseUrl.username ||
            baseUrl.password ||
            baseUrl.search ||
            baseUrl.hash
          ) {
            return withCors(
              problem(400, "invalid_request", "base_url must be a public HTTPS URL without credentials, query, or fragment"),
            );
          }
          const normalizedBaseUrl = baseUrl.toString().replace(/\/$/, "");
          const validation = await validateOpenAICompatibleApiKey(
            normalizedBaseUrl,
            apiKey,
          );
          if (validation !== "valid") {
            return withCors(
              problem(
                validation === "rejected" ? 401 : 502,
                validation === "rejected"
                  ? "connection_failed"
                  : "provider_unavailable",
                validation === "rejected"
                  ? "The provider rejected this API key"
                  : "The provider model catalog could not be validated",
              ),
            );
          }
          return withCors(
            json(
              await account.connectModelAccessApiKey({
                organizationId: identity.accountId,
                connectedByUserId: identity.userId,
                provider: body.provider,
                apiKey,
                baseUrl: normalizedBaseUrl,
                label: typeof body.label === "string" ? body.label : undefined,
              }),
              201,
            ),
          );
        }
        if (body.provider === "anthropic") {
          const token = typeof body.token === "string" ? body.token.trim() : "";
          if (
            token.length < 32 ||
            token.length > 4_096 ||
            !token.startsWith("sk-ant-")
          ) {
            return withCors(
              problem(
                400,
                "invalid_request",
                "Paste the token produced by claude setup-token",
              ),
            );
          }
          if (!(await validateClaudeSetupToken(token))) {
            return withCors(
              problem(
                401,
                "connection_failed",
                "Anthropic rejected this Claude setup token",
              ),
            );
          }
          return withCors(
            json(
              await account.connectModelAccessToken({
                organizationId: identity.accountId,
                connectedByUserId: identity.userId,
                provider: "anthropic",
                token,
                label:
                  typeof body.label === "string" ? body.label : undefined,
              }),
              201,
            ),
          );
        }
        const config = codexConfig(env as Env & PlatformEnv);
        const redirectUri = modelAccessRedirectUri(env as Env & PlatformEnv);
        if (!config || !redirectUri) {
          return withCors(
            problem(
              503,
              "provider_unavailable",
              "Codex subscription OAuth is not configured",
            ),
          );
        }
        const codeVerifier = randomWebhookToken(); // base64url 32-byte
        const codeVerifierBytes = new TextEncoder().encode(codeVerifier);
        const challengeBytes = await crypto.subtle.digest(
          "SHA-256",
          codeVerifierBytes,
        );
        const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(challengeBytes)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "");
        const connection = await account.startModelAccessConnect({
          organizationId: identity.accountId,
          connectedByUserId: identity.userId,
          provider: "openai",
          oauthCodeVerifier: codeVerifier,
          oauthRedirectUri: redirectUri,
          label: typeof body?.label === "string" ? body.label : undefined,
        });
        // One-time OAuth state embeds the connection id + a nonce so the
        // callback can direct the exchange to the right connection.
        const state = `${connection.id}.${crypto.randomUUID()}`;
        await account.setModelAccessOAuthState(
          connection.id,
          await sha256(state),
        );
        const authorizationUrl = codexAuthorizationUrl({
          config,
          redirectUri,
          state,
          codeChallenge,
        });
        return withCors(
          json({
            connection,
            status: "pending",
            authorize_url: authorizationUrl,
            expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          }),
        );
      }

      const modelAccessMatch = url.pathname.match(
        /^\/v1\/model-access\/connections\/([^/]+)(\/validate|\/complete)?$/,
      );
      if (modelAccessMatch?.[1]) {
        const id = decodeURIComponent(modelAccessMatch[1]);
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const existing = await account.getModelAccessConnection(id);
        if (!existing || existing.organizationId !== identity.accountId) {
          return withCors(
            problem(404, "connection_not_found", "Connection not found"),
          );
        }
        if (request.method === "DELETE") {
          if (identity.role !== "admin") {
            return withCors(
              problem(403, "forbidden", "Organization admin role is required"),
            );
          }
          return withCors(json(await account.disconnectModelAccess(id)));
        }
        if (request.method === "POST" && modelAccessMatch[2] === "/complete") {
          const body = await readJson(request);

          // Relay path (local CLI): the CLI performed the OAuth exchange on the
          // user's machine against the authorized Codex endpoints and relays the
          // credential here for encrypted custody. Requires org-admin.
          if (
            typeof body?.access_token === "string" &&
            body.access_token.length > 0 &&
            typeof body?.expires_at === "number"
          ) {
            if (identity.role !== "admin") {
              return withCors(
                problem(403, "forbidden", "Organization admin role is required"),
              );
            }
            const completed = await account.completeModelAccessConnect({
              id: existing.id,
              accessToken: body.access_token,
              refreshToken:
                typeof body?.refresh_token === "string"
                  ? body.refresh_token
                  : undefined,
              tokenType:
                typeof body?.token_type === "string" ? body.token_type : "Bearer",
              expiresAt: body.expires_at,
              externalAccountHint: identity.userId,
            });
            return withCors(json(completed));
          }

          // Server-exchange path (dashboard redirect): the dashboard redirected to
          // the provider and back; exchange the authorization code server-side.
          const config = codexConfig(env as Env & PlatformEnv);
          if (!config) {
            return withCors(
              problem(
                503,
                "provider_unavailable",
                "Codex subscription OAuth is not configured",
              ),
            );
          }
          if (typeof body?.code !== "string" || typeof body?.state !== "string") {
            return withCors(
              problem(400, "invalid_oauth_callback", "Invalid OAuth callback"),
            );
          }
          const intent = account.modelAccessOAuthIntent(existing.id);
          if (
            !intent ||
            !constantTimeEqual(intent.stateHash, await sha256(body.state))
          ) {
            return withCors(
              problem(401, "invalid_oauth_state", "OAuth state is invalid"),
            );
          }
          try {
            const credential = await exchangeCodexCode({
              config,
              code: body.code,
              codeVerifier: intent.codeVerifier,
              redirectUri: intent.redirectUri,
            });
            const completed = await account.completeModelAccessConnect({
              id: existing.id,
              accessToken: credential.accessToken,
              refreshToken: credential.refreshToken,
              tokenType: credential.tokenType,
              expiresAt: credential.expiresAt,
            });
            return withCors(json(completed));
          } catch (error) {
            return withCors(
              problem(
                502,
                "connection_failed",
                error instanceof Error ? error.message : "Codex connection failed",
              ),
            );
          }
        }
        if (request.method === "POST" && modelAccessMatch[2] === "/validate") {
          if (identity.role !== "admin") {
            return withCors(
              problem(403, "forbidden", "Organization admin role is required"),
            );
          }
          if (existing.provider === "anthropic") {
            const token = await account.modelAccessCredential(id);
            const valid = Boolean(
              token && (await validateClaudeSetupToken(token)),
            );
            return withCors(
              json(
                await account.setModelAccessConnectionStatus(
                  id,
                  valid ? "connected" : "reauth_required",
                  new Date().toISOString(),
                ),
              ),
            );
          }
          return withCors(
            json(
              await account.setModelAccessConnectionStatus(
                id,
                "connected",
                new Date().toISOString(),
              ),
            ),
          );
        }
      }

      const modelAccessBindingMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/model-access\/bindings(?:\/([^/]+)\/([^/]+))?$/,
      );
      if (modelAccessBindingMatch?.[1]) {
        const projectId = decodeURIComponent(modelAccessBindingMatch[1]);
        const account = env.ACCOUNTS.getByName(identity.accountId);
        if (request.method === "GET" && !modelAccessBindingMatch[2]) {
          return withCors(
            json({ data: await account.listModelAccessBindings(projectId) }),
          );
        }
        const provider = modelAccessBindingMatch[2];
        const bindingProject = await account.getProject(projectId);
        if (!bindingProject) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        const scopedBinding = projectScope(bindingProject, modelAccessBindingMatch[3], {
          legacyDefault: "required",
        });
        if ((provider === "openai" || provider === "anthropic") && !scopedBinding.ok) {
          return withCors(scopedBinding.response);
        }
        if ((provider === "openai" || provider === "anthropic") && scopedBinding.ok) {
          const environment = scopedBinding.scope.environment;
          if (request.method === "PUT") {
            const body = await readJson(request);
            if (typeof body?.enabled !== "boolean") {
              return withCors(
                problem(400, "invalid_request", "enabled is required"),
              );
            }
            try {
              return withCors(
                json(
                  await account.putModelAccessBinding({
                    organizationId: identity.accountId,
                    projectId,
                    environment,
                    provider,
                    enabled: body.enabled,
                    enabledByUserId: identity.userId,
                  }),
                ),
              );
            } catch (error) {
              return withCors(
                problem(
                  422,
                  "binding_failed",
                  error instanceof Error ? error.message : "Binding failed",
                ),
              );
            }
          }
          if (request.method === "DELETE") {
            await account.deleteModelAccessBinding(
              projectId,
              environment,
              provider,
            );
            return withCors(new Response(null, { status: 204 }));
          }
        }
      }

      const modelRouteMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/model-routes(?:\/([^/]+))?$/,
      );
      if (modelRouteMatch?.[1]) {
        const projectId = decodeURIComponent(modelRouteMatch[1]);
        const environment = modelRouteMatch[2]
          ? decodeURIComponent(modelRouteMatch[2])
          : undefined;
        const account = env.ACCOUNTS.getByName(identity.accountId);
        if (request.method === "GET" && !environment) {
          return withCors(json({ data: await account.listModelRoutes(projectId) }));
        }
        const routeProject = await account.getProject(projectId);
        if (!routeProject) {
          return withCors(problem(404, "project_not_found", "Project not found"));
        }
        const scopedRoute = projectScope(routeProject, environment, {
          legacyDefault: "required",
        });
        if (!scopedRoute.ok) return withCors(scopedRoute.response);
        const routeEnvironment = scopedRoute.scope.environment;
        const body = await readJson(request);
        const agentId = typeof body?.agent_id === "string" ? body.agent_id : undefined;
        if (request.method === "DELETE") {
          await account.deleteModelRoute(projectId, routeEnvironment, agentId);
          return withCors(new Response(null, { status: 204 }));
        }
        if (request.method === "PUT") {
          if (
            typeof body?.connection_id !== "string" ||
            typeof body?.model !== "string" ||
            (body?.fallback !== "fail" && body?.fallback !== "managed")
          ) {
            return withCors(problem(400, "invalid_request", "connection_id, model, and fallback are required"));
          }
          try {
            return withCors(json(await account.putModelRoute({
              organizationId: identity.accountId,
              projectId,
              environment: routeEnvironment,
              ...(agentId ? { agentId } : {}),
              connectionId: body.connection_id,
              model: body.model,
              fallback: body.fallback,
              updatedByUserId: identity.userId,
            })));
          } catch (error) {
            return withCors(problem(409, "model_route_invalid", error instanceof Error ? error.message : "Model route is invalid"));
          }
        }
      }

      if (url.pathname === "/v1/channels" && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = identity.projectId
          ? await account.getProject(identity.projectId)
          : null;
        const connections = (await account.listChannelConnections()).filter(
          (connection: SlackConnection) =>
            !identity.projectId ||
            Boolean(project && projectOwnsAgent(project, connection.agentId)),
        );
        return withCors(
          json({
            connections: await Promise.all(
              connections.map(async (connection: SlackConnection) => ({
                ...connection,
                agents: await account.channelConsumers(
                  connection.agentId,
                  connection.alias,
                  connection.channelId,
                ),
                destinations: await account.listSlackDestinations(connection.id),
              })),
            ),
          }),
        );
      }

      if (url.pathname === "/v1/approvals" && request.method === "GET") {
        return withCors(await listEnvironmentApprovals(request, env, identity));
      }

      if (url.pathname === "/v1/outboxes" && request.method === "GET") {
        return withCors(
          await listEnvironmentOutboxes(request, env, identity),
        );
      }

      if (
        url.pathname === "/v1/channels/twilio/connections" &&
        request.method === "POST"
      ) {
        return withCors(
          await createTwilioConnectionRequest(request, env, identity),
        );
      }

      const twilioConnectionMatch = url.pathname.match(
        /^\/v1\/channels\/twilio\/connections\/([^/]+)$/,
      );
      if (twilioConnectionMatch?.[1] && request.method === "PUT") {
        return withCors(
          await completeTwilioConnection(
            request,
            env,
            identity,
            decodeURIComponent(twilioConnectionMatch[1]),
          ),
        );
      }
      if (twilioConnectionMatch?.[1] && request.method === "DELETE") {
        const connectionId = decodeURIComponent(twilioConnectionMatch[1]);
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const connection = await account.getChannelConnection(connectionId);
        if (!connection || connection.provider !== "twilio") {
          return withCors(
            problem(404, "twilio_connection_not_found", "Connection not found"),
          );
        }
        // The route goes first: once it is gone nothing can be delivered here,
        // even if the number is still pointed at us.
        await env.ACCOUNTS.getByName(
          channelRouteName("twilio", connectionId),
        ).clearChannelRoute(connectionId);
        await account.disconnectChannelConnection(connectionId, "twilio");
        return withCors(json({ connection: { id: connectionId, status: "disconnected" } }));
      }

      if (
        url.pathname === "/v1/channels/slack/apps" &&
        request.method === "POST"
      ) {
        return withCors(await registerChannelApp(request, env, identity));
      }
      // Secrets belonging to one installation. Scoped under the app so the
      // caller cannot reach a connection that belongs to a different one.
      // A person's own credential on one installation.
      const userSecretsMatch = url.pathname.match(
        /^\/v1\/channels\/slack\/apps\/([^/]+)\/installations\/([^/]+)\/users\/([^/]+)\/secrets(?:\/([^/]+))?$/,
      );
      if (userSecretsMatch?.[1] && userSecretsMatch[2] && userSecretsMatch[3]) {
        return withCors(
          await installationSecretsRequest(request, env, identity, {
            appId: decodeURIComponent(userSecretsMatch[1]),
            connectionId: decodeURIComponent(userSecretsMatch[2]),
            externalUserId: decodeURIComponent(userSecretsMatch[3]),
            name: userSecretsMatch[4]
              ? decodeURIComponent(userSecretsMatch[4])
              : undefined,
          }),
        );
      }

      const installationSecretsMatch = url.pathname.match(
        /^\/v1\/channels\/slack\/apps\/([^/]+)\/installations\/([^/]+)\/secrets(?:\/([^/]+))?$/,
      );
      if (installationSecretsMatch?.[1] && installationSecretsMatch[2]) {
        return withCors(
          await installationSecretsRequest(request, env, identity, {
            appId: decodeURIComponent(installationSecretsMatch[1]),
            connectionId: decodeURIComponent(installationSecretsMatch[2]),
            name: installationSecretsMatch[3]
              ? decodeURIComponent(installationSecretsMatch[3])
              : undefined,
          }),
        );
      }

      const appInstallationMatch = url.pathname.match(
        /^\/v1\/channels\/slack\/apps\/([^/]+)\/installations$/,
      );
      if (appInstallationMatch?.[1] && request.method === "POST") {
        return withCors(
          await createAppInstallation(
            request,
            env,
            identity,
            decodeURIComponent(appInstallationMatch[1]),
          ),
        );
      }
      if (appInstallationMatch?.[1] && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        return withCors(
          json({
            installations: await account.listAppInstallations(
              decodeURIComponent(appInstallationMatch[1]),
            ),
          }),
        );
      }

      const slackSetupResponse = await handleSlackSetupRoute(
        request,
        env,
        identity,
      );
      if (slackSetupResponse) return withCors(slackSetupResponse);

      const linearConnectionResponse = await handleLinearConnectionRoute(
        request,
        env,
        identity,
        { encodeOAuthState, decodeOAuthState, html, projectOwnsAgent },
      );
      if (linearConnectionResponse) return withCors(linearConnectionResponse);

      if (
        url.pathname === "/v1/channels/slack/connections" &&
        request.method === "POST"
      ) {
        return withCors(await createSlackConnection(request, env, identity));
      }

      const slackConnectionMatch = url.pathname.match(
        /^\/v1\/channels\/slack\/connections\/([^/]+)$/,
      );
      const slackDestinationMatch = url.pathname.match(
        /^\/v1\/channels\/slack\/connections\/([^/]+)\/destinations\/([^/]+)$/,
      );
      if (
        slackDestinationMatch?.[1] &&
        slackDestinationMatch[2] &&
        request.method === "PUT"
      ) {
        return withCors(
          await bindSlackDestination(
            request,
            env,
            identity,
            decodeURIComponent(slackDestinationMatch[1]),
            decodeURIComponent(slackDestinationMatch[2]),
          ),
        );
      }
      if (slackConnectionMatch?.[1] && request.method === "PUT") {
        return withCors(
          await completeSlackConnection(
            request,
            env,
            identity,
            decodeURIComponent(slackConnectionMatch[1]),
          ),
        );
      }
      if (slackConnectionMatch?.[1] && request.method === "DELETE") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const connection = await account.getSlackConnection(
          decodeURIComponent(slackConnectionMatch[1]),
        );
        if (!connection) {
          return withCors(
            problem(404, "slack_connection_not_found", "Connection not found"),
          );
        }
        await env.ACCOUNTS.getByName(
          channelRouteName("slack", connection.id),
        ).clearChannelRoute(connection.id);
        return withCors(
          json(
            await account.updateSlackConnectionStatus(
              connection.id,
              "disconnected",
            ),
          ),
        );
      }

      const deploymentMatch = url.pathname.match(
        /^\/v1\/deployments\/([^/]+)$/,
      );
      if (deploymentMatch?.[1] && request.method === "GET") {
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const deployment = await account.getDeployment(
          decodeURIComponent(deploymentMatch[1]),
        );
        const project = identity.projectId
          ? await account.getProject(identity.projectId)
          : null;
        return withCors(
          deployment &&
            (!identity.projectId ||
              Boolean(project && projectOwnsAgent(project, deployment.agentId)))
            ? json(deployment)
            : problem(404, "deployment_not_found", "Deployment not found"),
        );
      }

      if (url.pathname === "/v1/sessions" && request.method === "POST") {
        const latency = latencyTelemetry(
          env,
          "edge",
          {},
          requestRegion(request),
        );
        const response = await latency.time(
          "session_create.responded",
          () => createSession(request, env, identity, context, latency),
          (result) => ({ status: result.status }),
        );
        latency.send(context);
        return withCors(response);
      }

      if (
        url.pathname === "/v1/billing/sessions" &&
        request.method === "GET"
      ) {
        const requestedLimit = Number.parseInt(
          url.searchParams.get("limit") ?? "50",
          10,
        );
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(requestedLimit, 100))
          : 50;
        const account = env.ACCOUNTS.getByName(identity.accountId);
        const project = identity.projectId
          ? await account.getProject(identity.projectId)
          : null;
        const projects = project
          ? [project]
          : identity.projectId
            ? []
            : await account.listProjects();
        const indexed = (
          await account.listSessionSummaries({
            ...(project ? { project: project.id } : {}),
            labels: [],
            limit,
          })
        ).sessions;
        const sessions = await Promise.all(
          indexed.map(async (entry: SessionSummary) => {
            const owningProject = projects.find((candidate: Project) =>
              projectOwnsAgent(candidate, entry.agentId),
            );
            return {
              ...entry,
              ...(owningProject
                ? {
                    projectId: owningProject.id,
                    projectName: owningProject.name,
                  }
                : {}),
              ...(await env.SESSIONS.getByName(entry.id).usageSummary()),
            };
          }),
        );
        return withCors(json({ sessions }));
      }

      if (url.pathname === "/v1/sessions" && request.method === "GET") {
        const query = parseSessionListQuery(url.searchParams);
        if ("error" in query) {
          return withCors(problem(400, "invalid_query", query.error));
        }
        const account = env.ACCOUNTS.getByName(identity.accountId);
        let listProject: Project | null = null;
        if (identity.projectId) {
          // A project token lists its project only; naming another is a
          // scope violation, not an empty page.
          const scoped = await account.getProject(identity.projectId);
          if (!scoped) {
            return withCors(
              problem(403, "project_scope_invalid", "Project token is no longer valid"),
            );
          }
          if (query.project !== undefined) {
            const named = await account.getProject(query.project);
            if (!named || named.id !== scoped.id) {
              return withCors(
                problem(403, "project_scope_violation", "Token is scoped to another project"),
              );
            }
          }
          query.project = scoped.id;
          listProject = scoped;
        } else if (query.project !== undefined) {
          // The filter takes a project id or slug; an unknown value matches
          // nothing, like any other filter.
          listProject = await account.getProject(query.project);
          query.project = listProject?.id ?? query.project;
        } else if (query.agent !== undefined) {
          listProject = await account.projectForAgent(query.agent);
        }
        if (listProject && query.environment !== undefined) {
          // The filter is the caller's word; the project's mode decides what
          // it names, so an older CLI's `development` finds single-mode rows.
          const scopedFilter = projectScope(listProject, query.environment);
          if (!scopedFilter.ok) return withCors(scopedFilter.response);
          query.environment = scopedFilter.scope.environment;
        }
        return withCors(json(await account.listSessionSummaries(query)));
      }

      const path = sessionPath(url.pathname);
      if (path) {
        const response = await routeSession(
          request,
          env,
          path,
          identity,
          context,
        );
        return response.webSocket ? response : withCors(response);
      }

      return withCors(problem(404, "not_found", "Route not found"));
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "edge.request_failed",
          method: request.method,
          path: loggablePath(new URL(request.url).pathname),
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return withCors(
        problem(500, "internal_error", "The request could not be completed"),
      );
    }
  },

  /** The idle sandbox sweep (see sandbox-sweep.ts), on the cron trigger. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await sweepIdleSandboxes(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "sandbox_sweep.failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
