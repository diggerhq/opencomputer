import { DurableObject } from "cloudflare:workers";
import { Cron } from "croner";

import {
  appendSlackStream,
  postSlackDirectMessage,
  postSlackConversationMessage,
  postSlackMessage,
  resolveSlackInstallation,
  resolveSlackConversation,
  resolveSlackUser,
  setSlackThreadStatus,
  startSlackStream,
  stopSlackStream,
  type SlackInstallation,
  type SlackStreamChunk,
} from "../channels/slack-api.js";
import {
  manifestBotScopes,
  SLACK_OAUTH_STATE_TTL_MS,
  SLACK_SETUP_CREATING_TTL_MS,
  SLACK_SETUP_EXCHANGING_TTL_MS,
  slackSetupActions,
  slackSetupError,
} from "../channels/slack-setup.js";
import { verifySlackSignature } from "../channels/slack-events.js";
import type {
  LinearConnection,
  LinearConnectionCredentialsInput,
} from "../protocol.js";
import {
  linearServiceRequest,
  type LinearServiceRequest,
  type LinearServiceResult,
} from "./linear-service.js";
import { linearConnectionPrincipal } from "./linear-contract.js";
import { googleServiceForScopes } from "../connections/selection.js";
import {
  LinearConnections,
  ensureLinearConnectionSchema,
  type CreateLinearConnectionOutcome,
  type CreateLinearConnectionRecord,
  type LinearAuthorizationCompletion,
  type LinearAuthorizationIssue,
  type LinearConnectionWithHealth,
  type LinearCredentialsOutcome,
  type LinearDisconnectOutcome,
} from "./linear-connections.js";
import {
  LinearIngress,
  nextLinearDeliveryAttempt,
  type LinearAcceptResult,
  type LinearLaunchInput,
  type LinearWebhookDelivery,
} from "./linear-ingress.js";
import type {
  LinearActivityPost,
  LinearActivityPostResult,
} from "./linear-contract.js";
import {
  postLinearActivityWith,
  setLinearSessionExternalLinkWith,
  type LinearSessionLink,
  type LinearSessionUpdateResult,
} from "./linear-activities.js";
import { channelAdapter } from "../channels/registry.js";
import type { ApprovalCard, QuestionCard } from "../channels/adapter.js";
import {
  sessionRunsOnWorkerd,
  type RuntimeLaunchEnv,
} from "./runtime-launch.js";
import {
  configuredManagedRuntimeProfileAssignment,
  managedRuntimeProfile,
  runtimeDeploymentForProfile,
  type ManagedRuntimeProfileEnv,
} from "./runtime-profiles.js";
import type { SlackStatus } from "../channels/slack-progress.js";
import {
  allocateMemoryActivation,
  deploymentMemory,
  driveMemoryActivation,
  dueMemoryActivations,
  ensureMemoryActivationSchema,
  nextMemoryActivationAttempt,
  readMemoryActivation,
  resourceConfigForDeployments,
  storeDeploymentMemory,
  type MemoryActivationEnv,
  type MemoryActivationFlip,
  selectedMemoryResources,
} from "./memory-activation.js";
import {
  DEFAULT_NEW_PROJECT_ENVIRONMENT_MODE,
  LEGACY_ENVIRONMENT_MODE,
  LEGACY_ENVIRONMENTS,
  SINGLE_ENVIRONMENT,
  canonicalEnvironments,
  environmentModeFromStorage,
  isProjectEnvironmentMode,
  environmentOfMode,
  isProjectEnvironmentName,
} from "./project-scope.js";
import type {
  AgentDeployment,
  AgentLogEntry,
  AgentSummary,
  ChannelConnectionStatus,
  Connection,
  ConnectionKind,
  CreatedProjectAccessToken,
  Project,
  ProjectServiceAttachment,
  ComputerGrantScope,
  ComputerServiceAttachment,
  ProjectAccessToken,
  ProjectEnvironmentMode,
  ProjectEnvironmentName,
  ProjectSchedule,
  ProjectScheduleRun,
  ProjectDeploymentReference,
  RegisterDeploymentInput,
  GitHubConnectionStatus,
  GitHubInstallation,
  GitHubTokenMint,
  GitHubAppPermission,
  GitHubConnectionDefinition,
  HttpConnectionDefinition,
  InstallationSecretMetadata,
  UserSecretMetadata,
  ManagedSecretMetadata,
  AgentRuntimeVariableMetadata,
  CreatedProjectWebhook,
  EventSubscription,
  OutcomeDestination,
  OutcomeEventType,
  ProjectWebhook,
  ProjectWebhookRequest,
  SessionActivity,
  SessionLabels,
  SessionPublication,
  SessionResult,
  SessionSnapshot,
  SessionSource,
  SessionSummary,
  StructuredAgentInput,
  SlackConnection,
  SlackSetup,
  SlackSetupError,
  SlackSetupPhase,
  SlackSetupResult,
  ModelAccessBinding,
  ModelAccessConnection,
  ModelAccessConnectionStatus,
  ModelAccessProvider,
  ModelRoute,
  DeploymentRuntimeMode,
} from "../protocol.js";
import {
  exchangeGitHubUserCode,
  GitHubMintError,
  listGitHubUserInstallations,
  waitForGitHubUserInstallation,
  gitHubAppJwt,
  importGitHubAppKey,
  mintGitHubInstallationToken,
} from "./github.js";
import { labelsMatch, readLabels } from "./session-labels.js";
import { startSandboxSessionRuntime } from "./sandbox-runtime-start.js";
import type { SessionDurableObject } from "./session-do.js";
import { parseDeploymentRegion, regionPlacement } from "../deployment-region.js";
import { parseDeploymentEgress } from "../deployment-egress.js";
import { forgetEgressExit, recordEgressExit } from "./egress-exits.js";
import {
  encodeSessionListCursor,
  type SessionListQuery,
} from "./session-listing.js";
import {
  requireAutonomousBillingAdmission,
  type AutonomousBillingEnv,
} from "./billing-admission.js";

type ScheduleRuntimeEnv =
  & Env
  & RuntimeLaunchEnv
  & ManagedRuntimeProfileEnv
  & AutonomousBillingEnv;

/** How long a publication may stay owed before reconciliation re-delivers it. */
const SESSION_PUBLICATION_STALE_MS = 10 * 60_000;
/** The reconciliation pass runs this often while the account has live sessions. */
const SESSION_RECONCILE_INTERVAL_MS = 60 * 60_000;
/** A live session is probed at most this often; a probe wakes its object. */
const SESSION_RECONCILE_PROBE_INTERVAL_MS = 24 * 60 * 60_000;
const SESSION_RECONCILE_BATCH = 100;
/** Maximum agent display-name length accepted from a deployment manifest. */
const AGENT_DISPLAY_NAME_LIMIT = 80;
// Slack names change rarely; a week keeps a rename from lingering forever.
const SLACK_NAME_RESOLVED_TTL_MS = 7 * 24 * 60 * 60_000;
// A failed lookup repeats identically; retry a few times an hour, not per message.
const SLACK_NAME_FAILED_TTL_MS = 15 * 60_000;
const SESSION_RECONCILE_ALARM_KEY = "sessionReconcileAtMs";
const EMPTY_ACTIVITY: SessionActivity = {
  activeTurnId: null,
  queued: 0,
  lastSettledTurn: null,
};

/**
 * One row of the account's session projection: what a list returns, held
 * at the revision the Session object last published. Rows written before
 * the projection existed carry revision 0 and empty activity until their
 * session publishes again.
 */
interface SessionProjectionRow {
  [key: string]: SqlStorageValue;
  id: string;
  project_id: string | null;
  agent_id: string;
  deployment_id: string;
  environment: string | null;
  source: string;
  status: string;
  labels_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
  activity_json: string;
  result_json: string | null;
}

interface AgentRow {
  [key: string]: SqlStorageValue;
  id: string;
  display_name: string | null;
  // Both come from subqueries over deployment_aliases, so they are NULL for an
  // agent that has never been deployed.
  active_deployment_id: string | null;
  active_alias: string | null;
  deployment_count: number;
  created_at: string;
  updated_at: string;
}

interface DeploymentRow {
  [key: string]: SqlStorageValue;
  id: string;
  agent_id: string;
  alias: string;
  runtime_mode: DeploymentRuntimeMode;
  region: string | null;
  egress: string | null;
  fixed_ips: string | null;
  artifact_bucket: string;
  artifact_key: string;
  artifact_digest: string;
  artifact_size: number;
  image_arn: string;
  image_version: string;
  created_at: string;
}

interface ProjectRow {
  [key: string]: SqlStorageValue;
  id: string;
  slug: string;
  name: string;
  agent_id: string;
  environment_mode: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectTokenRow {
  [key: string]: SqlStorageValue;
  id: string;
  project_id: string;
  name: string;
  environment: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ManagedSecretRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  environment: string;
  agent_id: string;
  name: string;
  allowed_origins_json: string;
  ciphertext: string;
  iv: string;
  created_at: string;
  updated_at: string;
}

interface AgentRuntimeVariableRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  environment: string;
  agent_id: string;
  name: string;
  ciphertext: string;
  iv: string;
  created_at: string;
  updated_at: string;
}

interface ProjectWebhookRow {
  [key: string]: SqlStorageValue;
  id: string;
  project_id: string;
  environment: string;
  agent_id: string;
  name: string;
  token_hash: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_invoked_at: string | null;
  identity: string | null;
}

interface ProjectWebhookRequestRow {
  [key: string]: SqlStorageValue;
  id: string;
  webhook_id: string;
  project_id: string;
  environment: string;
  agent_id: string;
  deployment_id: string | null;
  session_id: string | null;
  idempotency_key: string | null;
  payload_hash: string;
  outcome: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  input_json: string | null;
  attempt: number | null;
  next_attempt_at: string | null;
  edge_origin: string | null;
  user_id: string | null;
  account_id: string | null;
  terminal: number | null;
}

interface ScheduleRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  account_id: string;
  environment: string;
  schedule_id: string;
  agent_id: string;
  deployment_id: string;
  cron: string;
  timezone: string;
  overlap_policy: string;
  dispatch_json: string;
  edge_origin: string;
  user_id: string;
  status: string;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ScheduleRunRow {
  [key: string]: SqlStorageValue;
  id: string;
  schedule_id: string;
  project_id: string;
  environment: string;
  agent_id: string;
  deployment_id: string;
  scheduled_at: string;
  manual: number;
  attempt: number;
  outcome: string;
  session_id: string | null;
  error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

function nextScheduleRun(
  cron: string,
  timezone: string,
  after = new Date(),
): string {
  const next = new Cron(cron, { timezone, paused: true }).nextRun(after);
  if (!next) throw new Error("Schedule does not have a future run");
  return next.toISOString();
}

function outboxContentPreview(value: string): {
  title?: string;
  body?: string;
  url?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed === "string") return { body: parsed.slice(0, 2_000) };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const content = parsed as Record<string, unknown>;
  return {
    ...(typeof content.title === "string"
      ? { title: content.title.slice(0, 300) }
      : {}),
    ...(typeof content.body === "string"
      ? { body: content.body.slice(0, 2_000) }
      : {}),
    ...(typeof content.url === "string"
      ? { url: content.url.slice(0, 2_000) }
      : {}),
  };
}

function managedSecretFromRow(row: ManagedSecretRow): ManagedSecretMetadata {
  return {
    name: row.name,
    projectId: row.project_id,
    environment: row.environment as ProjectEnvironmentName,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    allowedOrigins: JSON.parse(row.allowed_origins_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runtimeVariableFromRow(
  row: AgentRuntimeVariableRow,
): AgentRuntimeVariableMetadata {
  return {
    name: row.name,
    projectId: row.project_id,
    environment: row.environment as ProjectEnvironmentName,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface EventSubscriptionRow {
  [key: string]: SqlStorageValue;
  id: string;
  project_id: string;
  environment: string;
  agent_id: string | null;
  source_labels_json: string | null;
  events_json: string;
  destination_json: string;
  created_by: string;
  created_at: string;
}

function eventSubscriptionFromRow(row: EventSubscriptionRow): EventSubscription {
  return {
    id: row.id,
    projectId: row.project_id,
    environment: row.environment as ProjectEnvironmentName,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.source_labels_json
      ? { sourceLabels: readLabels(row.source_labels_json) }
      : {}),
    events: JSON.parse(row.events_json) as OutcomeEventType[],
    destination: JSON.parse(row.destination_json) as OutcomeDestination,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function projectWebhookFromRow(row: ProjectWebhookRow): ProjectWebhook {
  return {
    ...(row.identity ? { identity: row.identity } : {}),
    id: row.id,
    projectId: row.project_id,
    environment: row.environment as ProjectEnvironmentName,
    agentId: row.agent_id,
    name: row.name,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_invoked_at ? { lastInvokedAt: row.last_invoked_at } : {}),
  };
}

function projectWebhookRequestFromRow(
  row: ProjectWebhookRequestRow,
): ProjectWebhookRequest {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    projectId: row.project_id,
    environment: row.environment as ProjectEnvironmentName,
    agentId: row.agent_id,
    ...(row.deployment_id ? { deploymentId: row.deployment_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    outcome:
      row.outcome === "accepted" || row.outcome === "failed"
        ? row.outcome
        : "pending",
    ...(row.error ? { error: row.error } : {}),
    attempt: row.attempt ?? 0,
    ...(row.terminal ? { terminal: true } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Session id for an admission that must be known before the session exists.
 * Same derivation as the session route's idempotent ids; attempt 0 omits the
 * suffix so the id returned at claim time is the one the first attempt uses.
 */
export async function derivedSessionId(
  accountId: string,
  key: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["session", accountId, key])),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

export function webhookRequestSessionKey(requestId: string, attempt: number): string {
  return attempt === 0 ? `webhook:${requestId}` : `webhook:${requestId}:${attempt}`;
}

/** Delay after each failed attempt; a failure with no entry left marks the request `failed`. */
const WEBHOOK_ENACT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];

/** A failure that no retry can change; the request is marked `failed` at once. */
class WebhookAdmissionTerminalError extends Error {}
const WEBHOOK_ENACT_LEASE_MS = 600_000;

function deploymentRuntimeMode(value: unknown): DeploymentRuntimeMode {
  return value === "workerd-lazy-sandbox"
    ? "workerd-lazy-sandbox"
    : "microvm";
}

/**
 * The stored egress allowlist. A row that no longer parses fails closed:
 * an empty allowlist, not an open network.
 */
function storedEgress(value: string | null): AgentDeployment["egress"] {
  if (!value) return undefined;
  try {
    return parseDeploymentEgress(JSON.parse(value)) ?? { domains: [], cidrs: [] };
  } catch {
    return { domains: [], cidrs: [] };
  }
}

function deploymentFromRow(row: DeploymentRow): AgentDeployment {
  return {
    id: row.id,
    agentId: row.agent_id,
    alias: row.alias,
    runtimeMode: deploymentRuntimeMode(row.runtime_mode),
    ...(parseDeploymentRegion(row.region) ? { region: parseDeploymentRegion(row.region)! } : {}),
    ...(storedEgress(row.egress) ? { egress: storedEgress(row.egress)! } : {}),
    ...(row.fixed_ips ? { fixedIps: row.fixed_ips } : {}),
    channels: [],
    connections: [],
    httpConnections: [],
    githubConnections: [],
    artifact: {
      bucket: row.artifact_bucket,
      key: row.artifact_key,
      digest: row.artifact_digest,
      size: row.artifact_size,
    },
    imageArn: row.image_arn,
    imageVersion: row.image_version,
    createdAt: row.created_at,
  };
}

interface ChannelConnectionRow {
  [key: string]: SqlStorageValue;
  id: string;
  channel: string;
  agent_id: string;
  alias: string;
  external_channel_id: string;
  team_id: string | null;
  connected_account_id: string;
  trigger_id: string | null;
  app_name: string | null;
  app_name_synced_at: string | null;
  app_id: string | null;
  team_name: string | null;
  bot_user_id: string | null;
  verified_at: string | null;
  verification_error: string | null;
  last_event_at: string | null;
  last_delivery_status: string | null;
  last_delivery_at: string | null;
  last_error_category: string | null;
  last_error_at: string | null;
  token_ciphertext: string | null;
  token_iv: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ConnectionRow {
  [key: string]: SqlStorageValue;
  id: string;
  kind: string;
  provider: string;
  label: string;
  owner_user_id: string;
  agent_id: string;
  alias: string;
  external_account_id: string | null;
  display_name: string | null;
  scopes_json: string;
  credential_ciphertext: string | null;
  credential_iv: string | null;
  oauth_state_hash: string | null;
  managed_expires_at: string | null;
  managed_last_checked_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ProjectServiceAttachmentRow extends ConnectionRow {
  project_id: string;
  connection_id: string;
  attachment_provider: string;
  attachment_service: string;
  attachment_label: string;
  attachment_created_at: string;
  attachment_updated_at: string;
}

interface ComputerServiceAttachmentRow extends ConnectionRow {
  connection_id: string;
  attachment_provider: string;
  attachment_service: string;
  attachment_label: string;
  attachment_scope: string;
  attachment_subject: string;
  attachment_granted_by: string;
  attachment_created_at: string;
  attachment_updated_at: string;
}

interface ManagedModelCredentialRow {
  [key: string]: SqlStorageValue;
  id: string;
  provider: string;
  or_key_hash: string;
  operation_id: string;
  credential_ciphertext: string;
  credential_iv: string;
  created_at: string;
  updated_at: string;
}

interface ModelAccessConnectionRow {
  [key: string]: SqlStorageValue;
  id: string;
  organization_id: string;
  connected_by_user_id: string;
  provider: string;
  kind: string;
  label: string;
  base_url: string | null;
  external_account_hint: string | null;
  status: string;
  entitlement_snapshot_json: string | null;
  checked_at: string | null;
  oauth_state_hash: string | null;
  oauth_code_verifier: string | null;
  oauth_redirect_uri: string | null;
  credential_ciphertext: string | null;
  credential_iv: string | null;
  refresh_ciphertext: string | null;
  refresh_iv: string | null;
  access_expires_at: number | null;
  token_type: string | null;
  created_at: string;
  updated_at: string;
}

interface ModelRouteRow {
  [key: string]: SqlStorageValue;
  id: string;
  organization_id: string;
  project_id: string;
  environment: string;
  agent_id: string;
  connection_id: string;
  model: string;
  fallback: string;
  revision: number;
  updated_by_user_id: string;
  created_at: string;
  updated_at: string;
}

interface ModelAccessBindingRow {
  [key: string]: SqlStorageValue;
  organization_id: string;
  project_id: string;
  environment: string;
  provider: string;
  connection_id: string;
  enabled: number;
  enabled_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ChannelConnectionGrantRow {
  [key: string]: SqlStorageValue;
  connection_id: string;
  external_user_id: string;
  principal_user_id: string;
  service: string;
  label: string;
}

export interface ChannelConnectionGrant {
  connectionId: string;
  externalUserId: string;
  principalUserId: string;
  service: string;
  label: string;
}

function connectionFromRow(row: ConnectionRow): Connection {
  let scopes: string[] = [];
  try {
    const value: unknown = JSON.parse(row.scopes_json);
    if (Array.isArray(value)) {
      scopes = value.filter(
        (scope): scope is string => typeof scope === "string",
      );
    }
  } catch {
    // Invalid legacy metadata is exposed as an empty scope set.
  }
  return {
    id: row.id,
    kind: row.kind as ConnectionKind,
    provider: row.provider,
    label: row.label,
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    alias: row.alias,
    externalAccountId: row.external_account_id ?? undefined,
    displayName: row.display_name ?? undefined,
    scopes,
    status: row.status as ChannelConnectionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function modelRouteFromRow(row: ModelRouteRow): ModelRoute {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environment: row.environment as ModelRoute["environment"],
    agentId: row.agent_id || undefined,
    connectionId: row.connection_id,
    model: row.model,
    fallback: row.fallback as ModelRoute["fallback"],
    revision: row.revision,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function modelAccessConnectionFromRow(
  row: ModelAccessConnectionRow,
): ModelAccessConnection {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectedByUserId: row.connected_by_user_id,
    provider: row.provider as ModelAccessProvider,
    kind: row.kind as ModelAccessConnection["kind"],
    label: row.label,
    baseUrl: row.base_url ?? undefined,
    externalAccountHint: row.external_account_hint ?? undefined,
    status: row.status as ModelAccessConnectionStatus,
    entitlementSnapshot: row.entitlement_snapshot_json
      ? (JSON.parse(row.entitlement_snapshot_json) as unknown)
      : undefined,
    checkedAt: row.checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function modelAccessBindingFromRow(row: ModelAccessBindingRow): ModelAccessBinding {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    environment: row.environment as ModelAccessBinding["environment"],
    provider: row.provider as ModelAccessProvider,
    connectionId: row.connection_id,
    enabled: row.enabled === 1,
    enabledByUserId: row.enabled_by_user_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ChannelAppRow {
  [key: string]: SqlStorageValue;
  id: string;
  provider: string;
  external_app_id: string;
  agent_id: string;
  alias: string;
  label: string;
  secret_ciphertext: string;
  secret_iv: string;
  created_at: string;
  updated_at: string;
}

/**
 * How long a write may take before we stop expecting an answer.
 *
 * Nothing else here bounds how long a tool may run — `run` is unbounded, and
 * the transport to a tool is start-then-poll rather than a held request. So
 * this is not a limit on the work; it is how long the record waits before
 * admitting it does not know. Generous on purpose: the cost of waiting is a
 * card that says "applying", and the cost of giving up early is telling
 * somebody a write failed when it did not.
 */
const APPLY_GRACE_MS = 10 * 60 * 1_000;

export interface ChannelAppRecord {
  id: string;
  provider: string;
  externalAppId: string;
  agentId: string;
  alias: string;
  label: string;
}

interface ApprovalRow {
  [key: string]: SqlStorageValue;
  id: string;
  agent_id: string;
  alias: string;
  deployment_id: string;
  session_id: string | null;
  turn_id: string | null;
  tool_id: string;
  input_json: string;
  preview_json: string;
  connection_id: string;
  delivery_ref: string;
  provider: string;
  external_message_id: string | null;
  decider_principal: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  applying_at: string | null;
  apply_session_id: string | null;
  applied_at: string | null;
  result_json: string | null;
  error: string | null;
  expires_at: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRecord {
  id: string;
  agentId: string;
  alias: string;
  deploymentId: string;
  sessionId?: string;
  turnId?: string;
  toolId: string;
  input: unknown;
  preview: unknown;
  connectionId: string;
  provider: string;
  deliveryRef: Readonly<Record<string, unknown>>;
  externalMessageId?: string;
  deciderPrincipal?: string;
  status: string;
  decidedBy?: string;
  decidedAt?: string;
  applyingAt?: string;
  applySessionId?: string;
  appliedAt?: string;
  result?: unknown;
  error?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function approvalFromRow(row: ApprovalRow): ApprovalRecord {
  const deliveryRef = parseJson(row.delivery_ref);
  return {
    id: row.id,
    agentId: row.agent_id,
    alias: row.alias,
    deploymentId: row.deployment_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    toolId: row.tool_id,
    input: parseJson(row.input_json),
    preview: parseJson(row.preview_json),
    connectionId: row.connection_id,
    provider: row.provider,
    // The reply address is the adapter's business, so it is handed back the
    // way it was stored rather than reshaped into any one provider's fields.
    deliveryRef:
      deliveryRef && typeof deliveryRef === "object" && !Array.isArray(deliveryRef)
        ? (deliveryRef as Record<string, unknown>)
        : {},
    ...(row.external_message_id
      ? { externalMessageId: row.external_message_id }
      : {}),
    ...(row.decider_principal
      ? { deciderPrincipal: row.decider_principal }
      : {}),
    status: row.status,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.applying_at ? { applyingAt: row.applying_at } : {}),
    ...(row.apply_session_id ? { applySessionId: row.apply_session_id } : {}),
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
    ...(row.result_json !== null ? { result: parseJson(row.result_json) } : {}),
    ...(row.error ? { error: row.error } : {}),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slackConnectionFromRow(row: ChannelConnectionRow): SlackConnection {
  return {
    id: row.id,
    channelId: row.external_channel_id || "slack",
    agentId: row.agent_id,
    alias: row.alias,
    appName: row.app_name ?? undefined,
    appId: row.app_id ?? undefined,
    teamId: row.team_id ?? undefined,
    teamName: row.team_name ?? undefined,
    botUserId: row.bot_user_id ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    verificationError:
      row.verification_error === "signing_secret_mismatch"
        ? row.verification_error
        : undefined,
    ...(row.last_event_at ? { lastEventAt: row.last_event_at } : {}),
    ...(row.last_delivery_status && row.last_delivery_at
      ? {
          lastDelivery: {
            status: row.last_delivery_status as "delivered" | "failed",
            at: row.last_delivery_at,
          },
        }
      : {}),
    ...(row.last_error_category && row.last_error_at
      ? {
          lastError: {
            category: row.last_error_category,
            at: row.last_error_at,
          },
        }
      : {}),
    status: row.status as ChannelConnectionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A route lives in its own Durable Object, named `${provider}:${connectionId}`,
 * which is how an inbound webhook finds the account that owns the connection
 * without a scan. One route per DO, so a connection per provider costs nothing.
 */
export interface ChannelRoute {
  accountId: string;
  connectionId: string;
  webhookTokenHash: string;
  /** Absent on routes written before providers were named. */
  provider?: string;
  /**
   * The connection revision this route was minted at. A publication carrying
   * an older revision than the stored one is refused: the route's owner is
   * the last word on which webhook identity is live, whatever the order the
   * publishers' requests arrived in.
   */
  revision?: number;
}

/**
 * Where a shared app's events go. One of these per Slack app, rather than one
 * per workspace, because the app has only one Request URL to point at us.
 */
export interface ChannelAppRoute {
  accountId: string;
  appId: string;
  webhookTokenHash: string;
  provider: string;
}

/** @deprecated Use ChannelRoute. */
export type SlackRoute = ChannelRoute;

export interface WebhookRoute {
  accountId: string;
  webhookId: string;
  tokenHash: string;
}

interface GitHubInstallationRow {
  [key: string]: SqlStorageValue;
  id: string;
  github_installation_id: number;
  github_app_id: number | null;
  github_account_id: number | null;
  account_login: string;
  account_type: string;
  repository_selection: string;
  state: string;
  created_at: string;
  updated_at: string;
}

interface GitHubConnectStateRow {
  [key: string]: SqlStorageValue;
  nonce_hash: string;
  project_id: string;
  environments_json: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface SlackSetupRow {
  [key: string]: SqlStorageValue;
  id: string;
  request_key: string;
  project_id: string;
  owner_user_id: string | null;
  agent_id: string;
  alias: string;
  channel_id: string;
  connection_id: string;
  webhook_token_hash: string;
  name: string;
  manifest_json: string;
  phase: string;
  resume_phase: string | null;
  attempt_id: string | null;
  attempt_started_at: number | null;
  connection_revision: number;
  route_published_at: number | null;
  app_id: string | null;
  client_id: string | null;
  client_secret_ciphertext: string | null;
  client_secret_iv: string | null;
  signing_secret_ciphertext: string | null;
  signing_secret_iv: string | null;
  team_id: string | null;
  team_name: string | null;
  bot_user_id: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
}

interface SlackOAuthStateRow {
  [key: string]: SqlStorageValue;
  nonce_hash: string;
  setup_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  result_code: string | null;
  connection_revision: number;
}

/**
 * A setup as the routes see it: the redacted `setup` they may serialize, and
 * beside it what only the flow itself needs. Kept apart so a handler cannot
 * hand the whole record to a response by accident.
 */
export interface SlackSetupRecord {
  setup: SlackSetup;
  /** The exact manifest submitted, as stored; parsed by the caller that needs it. */
  manifestJson: string;
  webhookTokenHash: string;
  /** The connection revision this setup last observed while owning it. */
  connectionRevision: number;
  clientId?: string;
  botScopes: string[];
}

export type SlackSetupCreationClaim =
  | { status: "claimed"; attemptId: string; record: SlackSetupRecord }
  | {
      status: "joined" | "unpublished" | "refused" | "superseded";
      record: SlackSetupRecord;
    }
  | { status: "missing" };

export type SlackSetupReservation =
  | { outcome: "created" | "existing"; record: SlackSetupRecord }
  | { outcome: "conflict" }
  | { outcome: "active"; record: SlackSetupRecord }
  | { outcome: "connected" };

export type SlackSetupCreationOutcome =
  | {
      kind: "created";
      appId: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
    }
  | { kind: "rejected"; error: SlackSetupError }
  | { kind: "uncertain"; error: SlackSetupError };

export type SlackOAuthStateClaim =
  | { status: "claimed"; setupId: string }
  | { status: "used"; setupId: string; resultCode: SlackSetupResult | null }
  | { status: "expired"; setupId: string }
  | { status: "missing" };

export type SlackExchangeOutcome =
  | {
      kind: "connected";
      botToken: string;
      installation: SlackInstallation;
    }
  | { kind: "failed"; result: SlackSetupResult; error: SlackSetupError };

export type SlackExchangeCommit =
  | { result: "connected"; setup: SlackSetup }
  | { result: "superseded"; setup: SlackSetup }
  | { result: "failed"; setup: SlackSetup }
  | { result: "stale" };

function slackSetupFromRow(row: SlackSetupRow): SlackSetup {
  const phase = row.phase as SlackSetupPhase;
  return {
    id: row.id,
    requestKey: row.request_key,
    projectId: row.project_id,
    agentId: row.agent_id,
    alias: row.alias,
    channelId: row.channel_id,
    name: row.name,
    connectionId: row.connection_id,
    phase,
    ...(row.app_id ? { app: { id: row.app_id, name: row.name } } : {}),
    ...(row.team_id
      ? {
          workspace: {
            id: row.team_id,
            ...(row.team_name ? { name: row.team_name } : {}),
          },
        }
      : {}),
    ...(row.bot_user_id ? { botUserId: row.bot_user_id } : {}),
    ...(row.error_json
      ? { error: JSON.parse(row.error_json) as SlackSetupError }
      : {}),
    actions: slackSetupActions(
      phase,
      row.error_json ? (JSON.parse(row.error_json) as SlackSetupError) : undefined,
    ),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function slackSetupRecordFromRow(row: SlackSetupRow): SlackSetupRecord {
  return {
    setup: slackSetupFromRow(row),
    manifestJson: row.manifest_json,
    webhookTokenHash: row.webhook_token_hash,
    connectionRevision: row.connection_revision,
    ...(row.client_id ? { clientId: row.client_id } : {}),
    botScopes: manifestBotScopes(
      JSON.parse(row.manifest_json) as Record<string, unknown>,
    ),
  };
}

/** The message a blocked manual completion throws with; it crosses the RPC boundary as text. */
export const SLACK_MANUAL_COMPLETION_BLOCKED = "slack_manual_completion_blocked";

/** One structured line per phase transition; never a provider body or secret. */
function logSlackSetupPhase(
  setupId: string,
  from: string,
  to: string,
  error?: SlackSetupError,
): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "slack.setup.phase",
      setupId,
      from,
      to,
      ...(error ? { errorCode: error.code } : {}),
    }),
  );
}

function gitHubInstallationFromRow(
  row: GitHubInstallationRow,
): GitHubInstallation {
  return {
    id: row.id,
    githubInstallationId: row.github_installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection:
      row.repository_selection === "selected" ? "selected" : "all",
    state: row.state as GitHubInstallation["state"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// A schedule manifest may still name Development and/or Production. A
// single-mode project's one scope is where Production ran: a manifest enabled
// for production (the compiler's default) runs there, while one enabled only
// for development stays manual, as it would have in Production.
function scheduleEnabledIn(
  enabled: readonly string[],
  environment: ProjectEnvironmentName,
): boolean {
  if (enabled.includes(environment)) return true;
  return environment === "default" && enabled.includes("production");
}

export class AccountDurableObject extends DurableObject<Env> {
  /** Linear agent connections (work 037 S1): `LinearConnectionStore` plus their lifecycle. */
  protected readonly linearConnections = new LinearConnections({
    storage: () => this.ctx.storage,
    encrypt: (value) => this.encryptSecret(value),
    decrypt: (ciphertext, iv) => this.decryptSecret(ciphertext, iv),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_updated_at
          ON sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS sessions_created_at
          ON sessions(created_at DESC, id);
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          display_name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deployments (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          runtime_mode TEXT NOT NULL DEFAULT 'microvm',
          region TEXT,
          egress TEXT,
          fixed_ips TEXT,
          artifact_bucket TEXT NOT NULL,
          artifact_key TEXT NOT NULL,
          artifact_digest TEXT NOT NULL,
          artifact_size INTEGER NOT NULL,
          image_arn TEXT NOT NULL,
          image_version TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS deployments_agent_created_at
          ON deployments(agent_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS deployment_aliases (
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, alias)
        );
        CREATE TABLE IF NOT EXISTS deployment_channels (
          deployment_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          PRIMARY KEY (deployment_id, channel)
        );
        CREATE TABLE IF NOT EXISTS deployment_connections (
          deployment_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          PRIMARY KEY (deployment_id, provider)
        );
        CREATE TABLE IF NOT EXISTS deployment_models (
          deployment_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          is_declared INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (deployment_id, provider, model)
        );
        CREATE TABLE IF NOT EXISTS deployment_http_connections (
          deployment_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          PRIMARY KEY (deployment_id, connection_id)
        );
        CREATE TABLE IF NOT EXISTS deployment_github_connections (
          deployment_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          PRIMARY KEY (deployment_id, connection_id)
        );
        CREATE TABLE IF NOT EXISTS deployment_project_resources (
          deployment_id TEXT PRIMARY KEY,
          project_deployment_id TEXT NOT NULL,
          local_agent_id TEXT NOT NULL,
          definition_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS deployment_project_resources_project
          ON deployment_project_resources(project_deployment_id);
        CREATE TABLE IF NOT EXISTS channel_connections (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          external_channel_id TEXT NOT NULL,
          team_id TEXT,
          connected_account_id TEXT NOT NULL,
          trigger_id TEXT,
          app_name TEXT,
          app_name_synced_at TEXT,
          app_id TEXT,
          team_name TEXT,
          bot_user_id TEXT,
          verified_at TEXT,
          verification_error TEXT,
          last_event_at TEXT,
          last_delivery_status TEXT,
          last_delivery_at TEXT,
          last_error_category TEXT,
          last_error_at TEXT,
          token_ciphertext TEXT,
          token_iv TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS channel_connections_trigger
          ON channel_connections(trigger_id);
        CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          provider TEXT NOT NULL,
          label TEXT NOT NULL,
          owner_user_id TEXT NOT NULL DEFAULT '',
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          external_account_id TEXT,
          display_name TEXT,
          scopes_json TEXT NOT NULL,
          credential_ciphertext TEXT,
          credential_iv TEXT,
          oauth_state_hash TEXT,
          managed_expires_at TEXT,
          managed_last_checked_at TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS connections_agent_provider
          ON connections(agent_id, alias, provider, updated_at DESC);
        CREATE TABLE IF NOT EXISTS project_service_attachments (
          project_id TEXT NOT NULL,
          service TEXT NOT NULL,
          provider TEXT NOT NULL,
          label TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id, service, label)
        );
        CREATE INDEX IF NOT EXISTS project_service_attachments_connection
          ON project_service_attachments(connection_id);
        CREATE TABLE IF NOT EXISTS computer_service_attachments (
          service TEXT NOT NULL,
          provider TEXT NOT NULL,
          label TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          scope_subject TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(service, label, scope, scope_subject)
        );
        CREATE INDEX IF NOT EXISTS computer_service_attachments_connection
          ON computer_service_attachments(connection_id);
        CREATE TABLE IF NOT EXISTS managed_model_credentials (
          provider TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          or_key_hash TEXT NOT NULL UNIQUE,
          operation_id TEXT NOT NULL UNIQUE,
          credential_ciphertext TEXT NOT NULL,
          credential_iv TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channel_apps (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          external_app_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          label TEXT NOT NULL,
          -- One app, one secret, every workspace's request signed with it.
          secret_ciphertext TEXT NOT NULL,
          secret_iv TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS channel_connections_app
          ON channel_connections(app_id, team_id);
        CREATE TABLE IF NOT EXISTS channel_threads (
          connection_id TEXT NOT NULL,
          external_thread_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (connection_id, external_thread_id)
        );
        CREATE TABLE IF NOT EXISTS channel_destination_bindings (
          connection_id TEXT NOT NULL,
          destination TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (connection_id, destination)
        );
        CREATE TABLE IF NOT EXISTS slack_identity_cache (
          connection_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          external_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          resolved_at TEXT NOT NULL,
          PRIMARY KEY (connection_id, kind, external_id)
        );
        CREATE TABLE IF NOT EXISTS outbox_items (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          session_id TEXT,
          outbox_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          content_json TEXT NOT NULL,
          status TEXT NOT NULL,
          connection_id TEXT,
          destination TEXT,
          external_message_id TEXT,
          error TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (agent_id, alias, outbox_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS outbox_items_status
          ON outbox_items(status, updated_at);
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          session_id TEXT,
          turn_id TEXT,
          tool_id TEXT NOT NULL,
          -- The arguments the human agreed to. The write uses these, never a
          -- second pass through the model.
          input_json TEXT NOT NULL,
          preview_json TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          -- Adapter-opaque, exactly as channel deliveries store it.
          delivery_ref TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_message_id TEXT,
          decider_principal TEXT,
          status TEXT NOT NULL,
          decided_by TEXT,
          decided_at TEXT,
          applying_at TEXT,
          apply_session_id TEXT,
          applied_at TEXT,
          result_json TEXT,
          error TEXT,
          expires_at TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (agent_id, alias, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS approvals_pending
          ON approvals(status, expires_at);
        CREATE TABLE IF NOT EXISTS channel_identities (
          connection_id TEXT NOT NULL,
          external_user_id TEXT NOT NULL,
          user_id TEXT,
          link_token_hash TEXT UNIQUE,
          expires_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (connection_id, external_user_id)
        );
        CREATE TABLE IF NOT EXISTS channel_connection_grants (
          token_hash TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          external_user_id TEXT NOT NULL,
          principal_user_id TEXT NOT NULL,
          service TEXT NOT NULL,
          label TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS channel_connection_grants_expiry
          ON channel_connection_grants(expires_at);
        CREATE TABLE IF NOT EXISTS channel_events (
          id TEXT PRIMARY KEY,
          received_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          agent_id TEXT NOT NULL UNIQUE,
          archived_at TEXT,
          environment_mode TEXT NOT NULL DEFAULT 'legacy',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_environments (
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          active_deployment_id TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, name)
        );
        CREATE TABLE IF NOT EXISTS project_access_tokens (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          environment TEXT NOT NULL,
          prefix TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS project_access_tokens_project
          ON project_access_tokens(project_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS managed_secrets (
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          allowed_origins_json TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          iv TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, environment, agent_id, name)
        );
        CREATE INDEX IF NOT EXISTS managed_secrets_project
          ON managed_secrets(project_id, environment, agent_id, name);
        CREATE TABLE IF NOT EXISTS user_secrets (
          connection_id TEXT NOT NULL,
          external_user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          allowed_origins_json TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          iv TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (connection_id, external_user_id, name)
        );
        CREATE TABLE IF NOT EXISTS installation_secrets (
          connection_id TEXT NOT NULL,
          name TEXT NOT NULL,
          allowed_origins_json TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          iv TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (connection_id, name)
        );
        CREATE TABLE IF NOT EXISTS agent_runtime_variables (
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          iv TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, environment, agent_id, name)
        );
        CREATE INDEX IF NOT EXISTS agent_runtime_variables_project
          ON agent_runtime_variables(project_id, environment, agent_id, name);
        CREATE TABLE IF NOT EXISTS project_webhooks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_invoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS project_webhooks_scope
          ON project_webhooks(project_id, environment, agent_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS event_subscriptions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT,
          events_json TEXT NOT NULL,
          destination_json TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS event_subscriptions_project
          ON event_subscriptions(project_id, environment, created_at);
        CREATE TABLE IF NOT EXISTS project_webhook_requests (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          deployment_id TEXT,
          session_id TEXT,
          idempotency_key TEXT,
          payload_hash TEXT NOT NULL,
          outcome TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (webhook_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS project_webhook_requests_scope
          ON project_webhook_requests(project_id, environment, agent_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS project_schedules (
          project_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          schedule_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          cron TEXT NOT NULL,
          timezone TEXT NOT NULL,
          overlap_policy TEXT NOT NULL,
          dispatch_json TEXT NOT NULL,
          edge_origin TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL,
          next_run_at TEXT NOT NULL,
          last_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, environment, agent_id, schedule_id)
        );
        CREATE INDEX IF NOT EXISTS project_schedules_due
          ON project_schedules(status, next_run_at);
        CREATE TABLE IF NOT EXISTS project_schedule_runs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          manual INTEGER NOT NULL,
          attempt INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          session_id TEXT,
          error TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS project_schedule_runs_scope
          ON project_schedule_runs(project_id, environment, agent_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS agent_logs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          timestamp TEXT NOT NULL,
          level TEXT NOT NULL,
          event TEXT NOT NULL,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS agent_logs_scope
          ON agent_logs(project_id, environment, agent_id, seq);
        CREATE TABLE IF NOT EXISTS github_installations (
          id TEXT PRIMARY KEY,
          github_installation_id INTEGER NOT NULL UNIQUE,
          github_app_id INTEGER,
          github_account_id INTEGER,
          account_login TEXT NOT NULL,
          account_type TEXT NOT NULL DEFAULT '',
          repository_selection TEXT NOT NULL DEFAULT 'all',
          state TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS github_attachments (
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          installation_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, environment)
        );
        CREATE TABLE IF NOT EXISTS github_connect_states (
          nonce_hash TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          environments_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS slack_setups (
          id TEXT PRIMARY KEY,
          request_key TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL,
          owner_user_id TEXT,
          agent_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          webhook_token_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          phase TEXT NOT NULL,
          resume_phase TEXT,
          attempt_id TEXT,
          attempt_started_at INTEGER,
          connection_revision INTEGER NOT NULL DEFAULT 0,
          route_published_at INTEGER,
          app_id TEXT,
          client_id TEXT,
          client_secret_ciphertext TEXT,
          client_secret_iv TEXT,
          signing_secret_ciphertext TEXT,
          signing_secret_iv TEXT,
          team_id TEXT,
          team_name TEXT,
          bot_user_id TEXT,
          error_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS slack_setups_target
          ON slack_setups(agent_id, alias, channel_id);
        CREATE TABLE IF NOT EXISTS slack_oauth_states (
          nonce_hash TEXT PRIMARY KEY,
          setup_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          result_code TEXT,
          connection_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS slack_oauth_states_setup
          ON slack_oauth_states(setup_id);
        CREATE TABLE IF NOT EXISTS model_access_connections (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          connected_by_user_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          base_url TEXT,
          external_account_hint TEXT,
          status TEXT NOT NULL,
          entitlement_snapshot_json TEXT,
          checked_at TEXT,
          oauth_state_hash TEXT,
          oauth_code_verifier TEXT,
          oauth_redirect_uri TEXT,
          credential_ciphertext TEXT,
          credential_iv TEXT,
          refresh_ciphertext TEXT,
          refresh_iv TEXT,
          access_expires_at INTEGER,
          token_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (organization_id, provider)
        );
        CREATE TABLE IF NOT EXISTS model_access_bindings (
          organization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          provider TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          enabled_by_user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, environment, provider)
        );
        CREATE INDEX IF NOT EXISTS model_access_bindings_connection
          ON model_access_bindings(connection_id);
        CREATE TABLE IF NOT EXISTS model_routes (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT '',
          connection_id TEXT NOT NULL,
          model TEXT NOT NULL,
          fallback TEXT NOT NULL DEFAULT 'fail',
          revision INTEGER NOT NULL DEFAULT 1,
          updated_by_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (project_id, environment, agent_id)
        );
        CREATE INDEX IF NOT EXISTS model_routes_connection
          ON model_routes(connection_id);
        CREATE TABLE IF NOT EXISTS managed_runtime_profile (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          profile_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const gitHubInstallationColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(github_installations)")
        .toArray();
      if (!gitHubInstallationColumns.some((column) => column.name === "github_app_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE github_installations ADD COLUMN github_app_id INTEGER",
        );
      }
      if (!gitHubInstallationColumns.some((column) => column.name === "github_account_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE github_installations ADD COLUMN github_account_id INTEGER",
        );
      }
      this.ctx.storage.sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS github_installations_app_account
           ON github_installations(github_app_id, github_account_id)
           WHERE github_app_id IS NOT NULL AND github_account_id IS NOT NULL`,
      );
      const projectColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(projects)")
        .toArray();
      if (!projectColumns.some((column) => column.name === "archived_at")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE projects ADD COLUMN archived_at TEXT",
        );
      }
      if (!projectColumns.some((column) => column.name === "environment_mode")) {
        // Every project that exists before the column is a legacy
        // Development/Production project; nothing is inferred from its rows.
        this.ctx.storage.sql.exec(
          `ALTER TABLE projects ADD COLUMN environment_mode TEXT NOT NULL DEFAULT '${LEGACY_ENVIRONMENT_MODE}'`,
        );
      }
      const agentColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(agents)")
        .toArray();
      if (!agentColumns.some((column) => column.name === "display_name")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE agents ADD COLUMN display_name TEXT",
        );
      }
      const modelAccessBaseColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(model_access_connections)")
        .toArray();
      if (!modelAccessBaseColumns.some((column) => column.name === "base_url")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE model_access_connections ADD COLUMN base_url TEXT",
        );
      }
      const deploymentColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(deployments)")
        .toArray();
      if (!deploymentColumns.some((column) => column.name === "runtime_mode")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE deployments ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'microvm'",
        );
      }
      if (!deploymentColumns.some((column) => column.name === "region")) {
        this.ctx.storage.sql.exec("ALTER TABLE deployments ADD COLUMN region TEXT");
      }
      if (!deploymentColumns.some((column) => column.name === "egress")) {
        this.ctx.storage.sql.exec("ALTER TABLE deployments ADD COLUMN egress TEXT");
      }
      if (!deploymentColumns.some((column) => column.name === "fixed_ips")) {
        this.ctx.storage.sql.exec("ALTER TABLE deployments ADD COLUMN fixed_ips TEXT");
      }
      const sessionColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(sessions)")
        .toArray();
      if (!sessionColumns.some((column) => column.name === "source")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'api'",
        );
      }
      for (const [column, definition] of [
        ["project_id", "TEXT"],
        ["environment", "TEXT"],
        ["labels_json", "TEXT NOT NULL DEFAULT '{}'"],
        ["revision", "INTEGER NOT NULL DEFAULT 0"],
        ["activity_json", `TEXT NOT NULL DEFAULT '${JSON.stringify(EMPTY_ACTIVITY)}'`],
        ["result_json", "TEXT"],
        ["reconciled_at", "TEXT"],
      ] as const) {
        if (!sessionColumns.some((existing) => existing.name === column)) {
          this.ctx.storage.sql.exec(
            `ALTER TABLE sessions ADD COLUMN ${column} ${definition}`,
          );
        }
      }
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS sessions_project_created_at
         ON sessions(project_id, created_at DESC, id)`,
      );
      // Rows indexed before the projection carried a project: give them the
      // one their agent belongs to, so a project filter finds them. Once per
      // account; a session that publishes again writes its own.
      for (const row of this.ctx.storage.sql
        .exec<{ agent_id: string }>(
          "SELECT DISTINCT agent_id FROM sessions WHERE project_id IS NULL",
        )
        .toArray()) {
        this.ctx.storage.sql.exec(
          "UPDATE sessions SET project_id = ? WHERE agent_id = ? AND project_id IS NULL",
          this.projectOwningAgent(row.agent_id)?.id ?? `project:${row.agent_id}`,
          row.agent_id,
        );
      }
      const outboxColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(outbox_items)")
        .toArray();
      if (!outboxColumns.some((column) => column.name === "session_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE outbox_items ADD COLUMN session_id TEXT",
        );
      }
      // `CREATE TABLE IF NOT EXISTS` never widens a table that already exists,
      // so every column added after the first deploy needs this. Without it the
      // decision path threw `no such column` and the approval sat untouched
      // while the person who clicked saw nothing happen.
      const approvalColumns = new Set(
        this.ctx.storage.sql
          .exec<{ name: string }>("PRAGMA table_info(approvals)")
          .toArray()
          .map((column) => column.name),
      );
      for (const [column, definition] of [
        ["applying_at", "TEXT"],
        ["apply_session_id", "TEXT"],
      ] as const) {
        if (approvalColumns.size && !approvalColumns.has(column)) {
          this.ctx.storage.sql.exec(
            `ALTER TABLE approvals ADD COLUMN ${column} ${definition}`,
          );
        }
      }
      const webhookRequestColumns = new Set(
        this.ctx.storage.sql
          .exec<{ name: string }>("PRAGMA table_info(project_webhook_requests)")
          .toArray()
          .map((column) => column.name),
      );
      for (const [column, definition] of [
        ["input_json", "TEXT"],
        ["attempt", "INTEGER NOT NULL DEFAULT 0"],
        ["next_attempt_at", "TEXT"],
        ["edge_origin", "TEXT"],
        ["user_id", "TEXT"],
        ["account_id", "TEXT"],
        ["terminal", "INTEGER NOT NULL DEFAULT 0"],
      ] as const) {
        if (!webhookRequestColumns.has(column)) {
          this.ctx.storage.sql.exec(
            `ALTER TABLE project_webhook_requests ADD COLUMN ${column} ${definition}`,
          );
        }
      }
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS project_webhook_requests_due
           ON project_webhook_requests(outcome, next_attempt_at)`,
      );
      const webhookColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(project_webhooks)")
        .toArray();
      if (!webhookColumns.some((column) => column.name === "identity")) {
        this.ctx.storage.sql.exec("ALTER TABLE project_webhooks ADD COLUMN identity TEXT");
      }
      const eventSubscriptionColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(event_subscriptions)")
        .toArray();
      if (
        !eventSubscriptionColumns.some((column) => column.name === "source_labels_json")
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE event_subscriptions ADD COLUMN source_labels_json TEXT",
        );
      }
      const connectionColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(connections)")
        .toArray();
      if (
        !connectionColumns.some((column) => column.name === "owner_user_id")
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE connections ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''",
        );
      }
      if (
        !connectionColumns.some(
          (column) => column.name === "managed_expires_at",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE connections ADD COLUMN managed_expires_at TEXT",
        );
      }
      if (
        !connectionColumns.some(
          (column) => column.name === "managed_last_checked_at",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE connections ADD COLUMN managed_last_checked_at TEXT",
        );
      }
      if (
        !connectionColumns.some((column) => column.name === "oauth_state_hash")
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE connections ADD COLUMN oauth_state_hash TEXT",
        );
      }
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS connections_owner_provider_label
         ON connections(owner_user_id, provider, label, updated_at DESC)`,
      );
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS connections_pending_expiry
         ON connections(status, managed_expires_at)`,
      );
      const columns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(channel_connections)")
        .toArray();
      if (!columns.some((column) => column.name === "team_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE channel_connections ADD COLUMN team_id TEXT",
        );
      }
      for (const name of [
        "app_name",
        "app_name_synced_at",
        "app_id",
        "team_name",
        "bot_user_id",
        "verified_at",
        "verification_error",
        "token_ciphertext",
        "token_iv",
        "last_event_at",
        "last_delivery_status",
        "last_delivery_at",
        "last_error_category",
        "last_error_at",
        // The hash of the webhook token the connection currently routes by,
        // written by every path that mints one, so an activation can check
        // inside its own transaction that the route it was reserved with is
        // still the live one.
        "webhook_token_hash",
      ]) {
        if (!columns.some((column) => column.name === name)) {
          this.ctx.storage.sql.exec(
            `ALTER TABLE channel_connections ADD COLUMN ${name} TEXT`,
          );
        }
      }
      // Advanced by every write that changes a connection's credentials,
      // status or routing. A setup records the revision it observed while it
      // owned the connection and every one of its writes is conditional on
      // that revision still being current: ownership, not identity.
      if (!columns.some((column) => column.name === "revision")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE channel_connections ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
        );
      }
      // Who minted the route the row currently carries: 'manual' (the
      // generated-manifest flow) or 'setup' (an automated reservation). A
      // manual completion may only activate a route minted by hand; a row
      // whose route a setup minted has no manifest a person could have
      // installed against. Absent on rows that predate this record.
      if (!columns.some((column) => column.name === "route_minted_by")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE channel_connections ADD COLUMN route_minted_by TEXT",
        );
      }
      const modelAccessColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(model_access_connections)")
        .toArray();
      for (const [name, type] of [
        ["oauth_state_hash", "TEXT"],
        ["oauth_code_verifier", "TEXT"],
        ["oauth_redirect_uri", "TEXT"],
        ["credential_ciphertext", "TEXT"],
        ["credential_iv", "TEXT"],
        ["refresh_ciphertext", "TEXT"],
        ["refresh_iv", "TEXT"],
        ["access_expires_at", "INTEGER"],
        ["token_type", "TEXT"],
      ] as const) {
        if (!modelAccessColumns.some((column) => column.name === name)) {
          this.ctx.storage.sql.exec(
            `ALTER TABLE model_access_connections ADD COLUMN ${name} ${type}`,
          );
        }
      }
      const deploymentModelColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(deployment_models)")
        .toArray();
      if (
        !deploymentModelColumns.some((column) => column.name === "is_declared")
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE deployment_models ADD COLUMN is_declared INTEGER NOT NULL DEFAULT 0",
        );
      }
      ensureMemoryActivationSchema(this.ctx.storage.sql);
      ensureLinearConnectionSchema(this.ctx.storage.sql);
    });
  }

  getManagedRuntimeProfile(): {
    profileId: string | null;
    updatedAt: string;
  } | null {
    const row = this.ctx.storage.sql
      .exec<{ profile_id: string; updated_at: string }>(
        "SELECT profile_id, updated_at FROM managed_runtime_profile WHERE singleton = 1",
      )
      .toArray()[0];
    return row
      ? {
          profileId: row.profile_id === "" ? null : row.profile_id,
          updatedAt: row.updated_at,
        }
      : null;
  }

  setManagedRuntimeProfile(profileId: string | null): {
    profileId: string | null;
    updatedAt: string;
  } {
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO managed_runtime_profile (singleton, profile_id, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         profile_id = excluded.profile_id,
         updated_at = excluded.updated_at`,
      profileId ?? "",
      updatedAt,
    );
    return { profileId, updatedAt };
  }

  private projectDeploymentReady(
    projectDeployment: ProjectDeploymentReference,
  ): boolean {
    const registeredMembers = new Set(
      this.ctx.storage.sql
        .exec<{ deployment_id: string; local_agent_id: string }>(
          `SELECT deployment_id, local_agent_id
           FROM deployment_project_resources
           WHERE project_deployment_id = ?`,
          projectDeployment.id,
        )
        .toArray()
        .map((row) => `${row.deployment_id}\0${row.local_agent_id}`),
    );
    return projectDeployment.agents.every((member) =>
      registeredMembers.has(
        `${member.agentId}:${member.artifactDigest}\0${member.localId}`,
      ),
    );
  }

  async registerDeployment(input: RegisterDeploymentInput): Promise<AgentDeployment> {
    const agentId = input.agentId.trim();
    const displayName = input.name?.trim() || null;
    const alias = input.alias.trim();
    const runtimeMode = deploymentRuntimeMode(input.runtimeMode);
    if (
      !agentId ||
      !alias ||
      !input.artifact.digest.trim() ||
      !input.imageArn ||
      !input.imageVersion
    ) {
      throw new Error(
        "Agent ID, alias, artifact digest, and runtime image are required",
      );
    }
    if (displayName && displayName.length > AGENT_DISPLAY_NAME_LIMIT) {
      throw new Error(
        `Agent names must be ${AGENT_DISPLAY_NAME_LIMIT} characters or fewer`,
      );
    }
    const primary = input.projectDeployment?.agents[0];
    const owningProject = primary
      ? this.projectOwningAgent(primary.agentId)
      : null;
    if (owningProject && primary?.agentId !== owningProject.agentId) {
      throw new Error(
        `Project deployment primary agent must be ${owningProject.agentId}, not ${primary?.agentId}`,
      );
    }
    const deploymentId = `${agentId}:${input.artifact.digest}`;
    const timestamp = new Date().toISOString();
    // Fixed IPs (work 073): the exits learn of the deployment before any of
    // its sandboxes can exist. A row left by a failed register is harmless.
    if (input.fixedIps) {
      if (!input.accountId) throw new Error("Fixed IPs need the registering account");
      await recordEgressExit(this.env, {
        accountId: input.accountId,
        deploymentId,
        region: input.fixedIps,
        ...(input.egress ? { egress: input.egress } : {}),
      });
    } else if (input.accountId && this.deploymentHadFixedIps(deploymentId)) {
      await forgetEgressExit(this.env, { accountId: input.accountId, deploymentId });
    }
    const memoryEnv = this.env as Env & MemoryActivationEnv;
    // Filled inside the transaction callback; a holder because narrowing does
    // not follow assignments made in closures.
    const activation: {
      allocated: { projectId: string; environment: ProjectEnvironmentName; seq: number } | null;
    } = { allocated: null };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO agents (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           -- The deployed name wins, so code stays the source of truth and a
           -- rename in the code lands. Falls back to the stored name when the
           -- deploy sends none, so deploying without a name does not wipe one.
           display_name = COALESCE(excluded.display_name, agents.display_name),
           updated_at = excluded.updated_at`,
        agentId,
        displayName,
        timestamp,
        timestamp,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM deployment_channels WHERE deployment_id = ?",
        deploymentId,
      );
      for (const channel of [...new Set(input.channels ?? [])]) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_channels (deployment_id, channel)
           VALUES (?, ?)`,
          deploymentId,
          channel,
        );
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM deployment_connections WHERE deployment_id = ?",
        deploymentId,
      );
      for (const provider of [...new Set(input.connections ?? [])]) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_connections (deployment_id, provider)
           VALUES (?, ?)`,
          deploymentId,
          provider,
        );
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM deployment_models WHERE deployment_id = ?",
        deploymentId,
      );
      for (const model of input.models ?? []) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_models
             (deployment_id, provider, model, is_default, is_declared)
           VALUES (?, ?, ?, 0, 1)`,
          deploymentId,
          model.provider,
          model.model,
        );
      }
      if (input.defaultModel) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_models
             (deployment_id, provider, model, is_default, is_declared)
           VALUES (?, ?, ?, 1, 0)
           ON CONFLICT(deployment_id, provider, model) DO UPDATE SET is_default = 1`,
          deploymentId,
          input.defaultModel.provider,
          input.defaultModel.model,
        );
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM deployment_http_connections WHERE deployment_id = ?",
        deploymentId,
      );
      for (const connection of input.httpConnections ?? []) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_http_connections
             (deployment_id, connection_id, definition_json)
           VALUES (?, ?, ?)`,
          deploymentId,
          connection.id,
          JSON.stringify(connection),
        );
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM deployment_github_connections WHERE deployment_id = ?",
        deploymentId,
      );
      for (const connection of input.githubConnections ?? []) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_github_connections
             (deployment_id, connection_id, definition_json)
           VALUES (?, ?, ?)`,
          deploymentId,
          connection.id,
          JSON.stringify(connection),
        );
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM deployment_project_resources WHERE deployment_id = ?",
        deploymentId,
      );
      if (input.projectDeployment) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_project_resources
             (deployment_id, project_deployment_id, local_agent_id, definition_json)
           VALUES (?, ?, ?, ?)`,
          deploymentId,
          input.projectDeployment.id,
          input.projectDeployment.localAgentId,
          JSON.stringify(input.projectDeployment),
        );
      }
      storeDeploymentMemory(this.ctx.storage.sql, deploymentId, input.memory ?? []);
      this.ctx.storage.sql.exec(
        `INSERT INTO deployments (
           id, agent_id, alias, runtime_mode, region, egress, fixed_ips, artifact_bucket,
           artifact_key, artifact_digest, artifact_size, image_arn, image_version,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         -- The id is the artifact digest, which region, egress and fixed IPs
         -- are not part of: a redeploy that only changes them updates them for
         -- new sandboxes.
         ON CONFLICT(id) DO UPDATE SET
           region = excluded.region, egress = excluded.egress, fixed_ips = excluded.fixed_ips`,
        deploymentId,
        agentId,
        alias,
        runtimeMode,
        input.region ?? null,
        input.egress ? JSON.stringify(input.egress) : null,
        input.fixedIps ?? null,
        input.artifact.bucket,
        input.artifact.key,
        input.artifact.digest,
        input.artifact.size,
        input.imageArn,
        input.imageVersion,
        timestamp,
      );
      const projectDeployment = input.projectDeployment;
      const projectReady = projectDeployment
        ? this.projectDeploymentReady(projectDeployment)
        : true;
      if (!projectReady) return;
      const primary = projectDeployment?.agents[0];
      // The owning project: the primary agent itself or one of its child
      // agents (`primary--name`), so a secondary agent deployed alone still
      // activates through its project.
      const project = this.projectOwningAgent(primary?.agentId ?? agentId);
      const environment =
        environmentOfMode(
          this.projectForAgent(primary?.agentId ?? agentId)?.environmentMode ?? "legacy",
          alias,
        ) ?? null;
      const flip: MemoryActivationFlip = projectDeployment
        ? {
            aliases: projectDeployment.agents.map((member) => ({
              agentId: member.agentId,
              deploymentId: `${member.agentId}:${member.artifactDigest}`,
            })),
            activeDeploymentId: `${primary!.agentId}:${primary!.artifactDigest}`,
          }
        : {
            aliases: [{ agentId, deploymentId }],
            ...(project && agentId !== project.agentId ? {} : { activeDeploymentId: deploymentId }),
          };
      if ((input.memory?.length ?? 0) > 0) {
        // Declarations are live only through an activation: a shape that
        // cannot be activated is refused before any alias is published.
        const reason = !project
          ? `${agentId} belongs to no project`
          : !environment
            ? `${alias} is not an environment`
            : !input.accountId || !memoryEnv.MEMORY
              ? "project memory is not configured"
              : null;
        if (reason) {
          throw new Error(`Memory resource declarations on ${agentId} cannot be activated: ${reason}`);
        }
      }
      if (environment && project && input.accountId && memoryEnv.MEMORY) {
        // Promotion of an environment: allocate the activation and record
        // the intent; the alias flips only after the Memory DO has applied
        // the configuration (driveMemoryActivation below). The applied
        // configuration is the aggregate over every deployment active in
        // the environment after the flip: a whole-project deployment names
        // its members; a single agent joins the other agents' current
        // aliases.
        const members = projectDeployment
          ? flip.aliases.map((entry) => entry.deploymentId)
          : [
              deploymentId,
              ...this.activeMemberDeployments(project, environment)
                .filter((entry) => entry.agentId !== agentId)
                .map((entry) => entry.deploymentId),
            ];
        activation.allocated = {
          projectId: project.id,
          environment,
          seq: allocateMemoryActivation(this.ctx.storage.sql, {
            accountId: input.accountId,
            projectId: project.id,
            environment,
            deploymentId: flip.activeDeploymentId ?? deploymentId,
            resources: resourceConfigForDeployments(this.ctx.storage.sql, members),
            flip,
          }),
        };
        return;
      }
      for (const entry of flip.aliases) {
        this.ctx.storage.sql.exec(
          `INSERT INTO deployment_aliases (
             agent_id, alias, deployment_id, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id, alias) DO UPDATE SET
             deployment_id = excluded.deployment_id,
             updated_at = excluded.updated_at`,
          entry.agentId,
          alias,
          entry.deploymentId,
          timestamp,
        );
      }
      if (project && flip.activeDeploymentId) {
        this.ctx.storage.sql.exec(
          `UPDATE project_environments
           SET active_deployment_id = ?, updated_at = ?
           WHERE project_id = ? AND name = ?`,
          flip.activeDeploymentId,
          timestamp,
          project.id,
          alias,
        );
      }
    });
    const allocated = activation.allocated;
    if (allocated) {
      const row = readMemoryActivation(
        this.ctx.storage.sql,
        allocated.projectId,
        allocated.environment,
        allocated.seq,
      );
      if (!row) throw new Error("Memory activation was not recorded");
      try {
        // The alarm is armed to the apply deadline before the call leaves.
        await driveMemoryActivation(this.ctx.storage, memoryEnv, row, () => this.resetAlarm());
      } finally {
        await this.resetAlarm();
      }
    }
    const deployment = this.getDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment registration failed");
    return { ...deployment, alias };
  }

  /**
   * Drops a non-environment alias (a PR preview such as `pr-12`) from every
   * agent of the project. Environment aliases are never removed this way.
   */
  removeProjectAlias(input: { projectId: string; alias: string }): number {
    if (input.alias === "development" || input.alias === "production") return 0;
    const project = this.getProject(input.projectId);
    if (!project) return 0;
    const rows = this.ctx.storage.sql
      .exec<{ agent_id: string }>(
        "SELECT agent_id FROM deployment_aliases WHERE alias = ?",
        input.alias,
      )
      .toArray()
      .filter((row) => this.projectOwningAgent(row.agent_id)?.id === project.id);
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        "DELETE FROM deployment_aliases WHERE agent_id = ? AND alias = ?",
        row.agent_id,
        input.alias,
      );
    }
    return rows.length;
  }

  /** The project whose primary agent is `agentId` or whose child-agent namespace (`primary--name`) contains it. */
  private projectOwningAgent(agentId: string): { id: string; agentId: string } | undefined {
    return this.ctx.storage.sql
      .exec<{ id: string; agent_id: string }>("SELECT id, agent_id FROM projects")
      .toArray()
      .filter((row) => agentId === row.agent_id || agentId.startsWith(`${row.agent_id}--`))
      .sort((a, b) => b.agent_id.length - a.agent_id.length)
      .map((row) => ({ id: row.id, agentId: row.agent_id }))[0];
  }

  /** The deployments currently published under the environment's alias for the project's agents. */
  private activeMemberDeployments(
    project: { agentId: string },
    environment: ProjectEnvironmentName,
  ): Array<{ agentId: string; deploymentId: string }> {
    return this.ctx.storage.sql
      .exec<{ agent_id: string; deployment_id: string }>(
        "SELECT agent_id, deployment_id FROM deployment_aliases WHERE alias = ? ORDER BY agent_id",
        environment,
      )
      .toArray()
      .filter((row) => row.agent_id === project.agentId || row.agent_id.startsWith(`${project.agentId}--`))
      .map((row) => ({ agentId: row.agent_id, deploymentId: row.deployment_id }));
  }

  /** Resource ids declared by the environment's selected activation (every active member, not one agent's code). */
  activeMemoryResources(projectId: string, environment: ProjectEnvironmentName): string[] {
    return selectedMemoryResources(this.ctx.storage.sql, projectId, environment);
  }

  private channelsForDeployment(deploymentId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ channel: string }>(
        `SELECT channel FROM deployment_channels
         WHERE deployment_id = ? ORDER BY channel`,
        deploymentId,
      )
      .toArray()
      .map((row) => row.channel);
  }

  private connectionsForDeployment(deploymentId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ provider: string }>(
        `SELECT provider FROM deployment_connections
         WHERE deployment_id = ? ORDER BY provider`,
        deploymentId,
      )
      .toArray()
      .map((row) => row.provider);
  }

  private modelsForDeployment(
    deploymentId: string,
  ): Pick<AgentDeployment, "models" | "defaultModel"> {
    const rows = this.ctx.storage.sql
      .exec<{
        provider: string;
        model: string;
        is_default: number;
        is_declared: number;
      }>(
        `SELECT provider, model, is_default, is_declared FROM deployment_models
         WHERE deployment_id = ? ORDER BY provider, model`,
        deploymentId,
      )
      .toArray();
    if (!rows.length) return {};
    const defaultModel = rows.find((row) => row.is_default === 1);
    return {
      models: rows
        .filter((row) => row.is_declared === 1)
        .map(({ provider, model }) => ({ provider, model })),
      ...(defaultModel
        ? { defaultModel: { provider: defaultModel.provider, model: defaultModel.model } }
        : {}),
    };
  }

  private memoryForDeployment(deploymentId: string): Pick<AgentDeployment, "memory"> {
    const memory = deploymentMemory(this.ctx.storage.sql, deploymentId);
    return memory.length ? { memory } : {};
  }

  private httpConnectionsForDeployment(
    deploymentId: string,
  ): HttpConnectionDefinition[] {
    return this.ctx.storage.sql
      .exec<{ definition_json: string }>(
        `SELECT definition_json FROM deployment_http_connections
         WHERE deployment_id = ? ORDER BY connection_id`,
        deploymentId,
      )
      .toArray()
      .map((row) => JSON.parse(row.definition_json) as HttpConnectionDefinition);
  }

  private githubConnectionsForDeployment(
    deploymentId: string,
  ): GitHubConnectionDefinition[] {
    return this.ctx.storage.sql
      .exec<{ definition_json: string }>(
        `SELECT definition_json FROM deployment_github_connections
         WHERE deployment_id = ? ORDER BY connection_id`,
        deploymentId,
      )
      .toArray()
      .map((row) => JSON.parse(row.definition_json) as GitHubConnectionDefinition);
  }

  private projectResourcesForDeployment(
    deploymentId: string,
  ): AgentDeployment["projectDeployment"] {
    const row = this.ctx.storage.sql
      .exec<{ definition_json: string }>(
        `SELECT definition_json FROM deployment_project_resources
         WHERE deployment_id = ?`,
        deploymentId,
      )
      .toArray()[0];
    return row
      ? (JSON.parse(row.definition_json) as NonNullable<
          AgentDeployment["projectDeployment"]
        >)
      : undefined;
  }

  /** Whether a registered deployment's sandboxes leave through exits. */
  private deploymentHadFixedIps(deploymentId: string): boolean {
    return this.ctx.storage.sql
      .exec<{ fixed_ips: string | null }>("SELECT fixed_ips FROM deployments WHERE id = ?", deploymentId)
      .toArray()
      .some((row) => row.fixed_ips !== null);
  }

  getDeployment(deploymentId: string): AgentDeployment | null {
    const row = this.ctx.storage.sql
      .exec<DeploymentRow>(
        `SELECT id, agent_id, alias, runtime_mode, region, egress, fixed_ips, artifact_bucket, artifact_key,
                artifact_digest, artifact_size, image_arn, image_version,
                created_at
         FROM deployments WHERE id = ?`,
        deploymentId,
      )
      .toArray()[0];
    return row
      ? {
          ...deploymentFromRow(row),
          channels: this.channelsForDeployment(row.id),
          connections: this.connectionsForDeployment(row.id),
          ...this.modelsForDeployment(row.id),
          httpConnections: this.httpConnectionsForDeployment(row.id),
          githubConnections: this.githubConnectionsForDeployment(row.id),
          ...(this.projectResourcesForDeployment(row.id)
            ? { projectDeployment: this.projectResourcesForDeployment(row.id) }
            : {}),
          ...this.memoryForDeployment(row.id),
        }
      : null;
  }

  listDeployments(agentId: string, limit = 100): AgentDeployment[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return this.ctx.storage.sql
      .exec<DeploymentRow>(
        `SELECT id, agent_id, alias, runtime_mode, region, egress, fixed_ips, artifact_bucket, artifact_key,
                artifact_digest, artifact_size, image_arn, image_version,
                created_at
         FROM deployments
         WHERE agent_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        agentId,
        safeLimit,
      )
      .toArray()
      .map((row) => ({
        ...deploymentFromRow(row),
        channels: this.channelsForDeployment(row.id),
        connections: this.connectionsForDeployment(row.id),
        ...this.modelsForDeployment(row.id),
        httpConnections: this.httpConnectionsForDeployment(row.id),
        githubConnections: this.githubConnectionsForDeployment(row.id),
        ...(this.projectResourcesForDeployment(row.id)
          ? { projectDeployment: this.projectResourcesForDeployment(row.id) }
          : {}),
        ...this.memoryForDeployment(row.id),
      }));
  }

  /**
   * The agents a channel connection delivers to: the local ids registered on
   * its channel in the alias's active deployment, or the dedicated agent when
   * nothing is registered (the same fallback ingress applies).
   */
  channelConsumers(agentId: string, alias: string, channelId: string): string[] {
    const graph = this.resolveDeployment(`${agentId}@${alias}`)?.projectDeployment;
    const registered = graph
      ? [
          ...new Set(
            graph.resources.channelRegistrations
              .filter((registration) => registration.channelId === channelId)
              .map((registration) => registration.agentId),
          ),
        ]
      : [];
    if (registered.length) return registered;
    return [
      graph?.agents.find((agent) => agent.agentId === agentId)?.localId ?? agentId,
    ];
  }

  resolveDeployment(agentReference: string): AgentDeployment | null {
    const separator = agentReference.lastIndexOf("@");
    const agentId =
      separator > 0 ? agentReference.slice(0, separator) : agentReference;
    // A bare agent id names the project's current deployment: production for
    // a legacy project, the one `default` scope for a single-mode project. In
    // a single-mode project an older client's `@development` names that same
    // scope; `@production` names nothing there, so it resolves to no row.
    const requestedAlias =
      separator > 0 ? agentReference.slice(separator + 1) : undefined;
    const single =
      this.projectForAgent(agentId)?.environmentMode === "single";
    const alias =
      requestedAlias === undefined
        ? single
          ? SINGLE_ENVIRONMENT
          : "production"
        : single && requestedAlias === "development"
          ? SINGLE_ENVIRONMENT
          : requestedAlias;
    const row = this.ctx.storage.sql
      .exec<DeploymentRow>(
        `SELECT d.id, d.agent_id, a.alias AS alias, d.runtime_mode, d.region, d.egress, d.fixed_ips,
                d.artifact_bucket, d.artifact_key,
                d.artifact_digest, d.artifact_size, d.image_arn,
                d.image_version, d.created_at
         FROM deployment_aliases a
         JOIN deployments d ON d.id = a.deployment_id
         WHERE a.agent_id = ? AND a.alias = ?`,
        agentId,
        alias,
      )
      .toArray()[0];
    return row
      ? {
          ...deploymentFromRow(row),
          channels: this.channelsForDeployment(row.id),
          connections: this.connectionsForDeployment(row.id),
          ...this.modelsForDeployment(row.id),
          httpConnections: this.httpConnectionsForDeployment(row.id),
          githubConnections: this.githubConnectionsForDeployment(row.id),
          ...(this.projectResourcesForDeployment(row.id)
            ? { projectDeployment: this.projectResourcesForDeployment(row.id) }
            : {}),
          ...this.memoryForDeployment(row.id),
        }
      : null;
  }

  listAgents(): AgentSummary[] {
    return this.ctx.storage.sql
      .exec<AgentRow>(
        `SELECT a.id, a.display_name,
                (
                  SELECT da.deployment_id
                  FROM deployment_aliases da
                  WHERE da.agent_id = a.id
                  ORDER BY CASE WHEN da.alias = 'production' THEN 0 ELSE 1 END,
                           da.updated_at DESC
                  LIMIT 1
                ) AS active_deployment_id,
                (
                  SELECT da.alias
                  FROM deployment_aliases da
                  WHERE da.agent_id = a.id
                  ORDER BY CASE WHEN da.alias = 'production' THEN 0 ELSE 1 END,
                           da.updated_at DESC
                  LIMIT 1
                ) AS active_alias,
                (
                  SELECT COUNT(*)
                  FROM deployments d
                  WHERE d.agent_id = a.id
                ) AS deployment_count,
                a.created_at,
                a.updated_at
         FROM agents a
         ORDER BY a.updated_at DESC`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        name: row.display_name ?? row.id,
        activeDeploymentId: row.active_deployment_id,
        activeAlias: row.active_alias,
        deploymentCount: Number(row.deployment_count),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private projectFromRow(row: ProjectRow): Project {
    const environments = this.ctx.storage.sql
      .exec<{
        name: string;
        active_deployment_id: string | null;
        updated_at: string;
      }>(
        `SELECT name, active_deployment_id, updated_at
         FROM project_environments WHERE project_id = ? ORDER BY name`,
        row.id,
      )
      .toArray()
      .map((environment) => ({
        name: environment.name as ProjectEnvironmentName,
        activeDeploymentId: environment.active_deployment_id ?? undefined,
        updatedAt: environment.updated_at,
      }));
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      agentId: row.agent_id,
      environmentMode: environmentModeFromStorage(row.environment_mode),
      environments,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createProject(input: {
    id: string;
    name: string;
    slug: string;
    environmentMode?: ProjectEnvironmentMode;
  }): Project {
    const name = input.name.trim();
    // `--` separates a project's primary agent from its child agents
    // (`primary--child`), so hyphen runs are collapsed to keep slugs unambiguous.
    const slug = input.slug.trim().toLowerCase().replace(/-{2,}/g, "-");
    if (!name || name.length > 80 || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      throw new Error("Project name or slug is invalid");
    }
    const environmentMode =
      input.environmentMode ?? DEFAULT_NEW_PROJECT_ENVIRONMENT_MODE;
    if (!isProjectEnvironmentMode(environmentMode)) {
      throw new Error("Project environment mode is invalid");
    }
    const timestamp = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO projects (id, slug, name, agent_id, environment_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        slug,
        name,
        slug,
        environmentMode,
        timestamp,
        timestamp,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO agents (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        slug,
        name.slice(0, 80),
        timestamp,
        timestamp,
      );
      for (const environment of canonicalEnvironments(environmentMode)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO project_environments
             (project_id, name, active_deployment_id, updated_at)
           VALUES (?, ?, NULL, ?)`,
          input.id,
          environment,
          timestamp,
        );
      }
    });
    const project = this.getProject(input.id);
    if (!project) throw new Error("Project creation failed");
    return project;
  }

  getProject(idOrSlug: string): Project | null {
    const row = this.ctx.storage.sql
      .exec<ProjectRow>(
        `SELECT id, slug, name, agent_id, environment_mode, archived_at, created_at, updated_at
         FROM projects WHERE id = ? OR slug = ? LIMIT 1`,
        idOrSlug,
        idOrSlug,
      )
      .toArray()[0];
    return row ? this.projectFromRow(row) : null;
  }

  listProjects(input: { archived?: boolean } = {}): Project[] {
    return this.ctx.storage.sql
      .exec<ProjectRow>(
        `SELECT id, slug, name, agent_id, environment_mode, archived_at, created_at, updated_at
         FROM projects
         WHERE archived_at IS ${input.archived ? "NOT " : ""}NULL
         ORDER BY updated_at DESC`,
      )
      .toArray()
      .map((row) => this.projectFromRow(row));
  }

  setProjectArchived(projectId: string, archived: boolean): Project | null {
    const project = this.getProject(projectId);
    if (!project) return null;
    if (Boolean(project.archivedAt) === archived) return project;
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?`,
      archived ? timestamp : null,
      timestamp,
      project.id,
    );
    return this.getProject(project.id);
  }

  private gitHubAppConfig(): {
    appId: number;
    slug: string;
    privateKey: string;
    clientId: string;
    clientSecret: string;
  } | null {
    const env = this.env as Env & {
      OC_GITHUB_APP_ID?: string;
      OC_GITHUB_APP_SLUG?: string;
      OC_GITHUB_APP_PRIVATE_KEY?: string;
      OC_GITHUB_APP_CLIENT_ID?: string;
      OC_GITHUB_APP_CLIENT_SECRET?: string;
    };
    const appId = Number.parseInt(env.OC_GITHUB_APP_ID ?? "", 10);
    if (
      !Number.isSafeInteger(appId) ||
      appId <= 0 ||
      !env.OC_GITHUB_APP_SLUG ||
      !env.OC_GITHUB_APP_PRIVATE_KEY ||
      !env.OC_GITHUB_APP_CLIENT_ID ||
      !env.OC_GITHUB_APP_CLIENT_SECRET
    ) {
      return null;
    }
    return {
      appId,
      slug: env.OC_GITHUB_APP_SLUG,
      privateKey: env.OC_GITHUB_APP_PRIVATE_KEY,
      clientId: env.OC_GITHUB_APP_CLIENT_ID,
      clientSecret: env.OC_GITHUB_APP_CLIENT_SECRET,
    };
  }

  getGitHubApp(): { appId: number; slug: string; clientId: string } | null {
    const config = this.gitHubAppConfig();
    return config
      ? { appId: config.appId, slug: config.slug, clientId: config.clientId }
      : null;
  }

  createGitHubConnectState(input: {
    nonceHash: string;
    projectId?: string;
    environments?: ProjectEnvironmentName[];
    ttlSeconds?: number;
  }): void {
    if (input.projectId && !this.getProject(input.projectId)) throw new Error("Project not found");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM github_connect_states WHERE expires_at < ?",
        new Date(now).toISOString(),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO github_connect_states
           (nonce_hash, project_id, environments_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.nonceHash,
        input.projectId ?? "",
        JSON.stringify(input.environments ?? []),
        new Date(now).toISOString(),
        new Date(now + (input.ttlSeconds ?? 1800) * 1000).toISOString(),
      );
    });
  }

  consumeGitHubConnectState(nonceHash: string): {
    projectId?: string;
    environments: ProjectEnvironmentName[];
  } | null {
    const consumed = this.ctx.storage.transactionSync<GitHubConnectStateRow | null>(() => {
      const row = this.ctx.storage.sql
        .exec<GitHubConnectStateRow>(
          "SELECT * FROM github_connect_states WHERE nonce_hash = ?",
          nonceHash,
        )
        .toArray()[0];
      if (
        !row ||
        row.used_at ||
        row.expires_at < new Date().toISOString()
      ) {
        return null;
      }
      const now = new Date().toISOString();
      const result = this.ctx.storage.sql.exec(
        "UPDATE github_connect_states SET used_at = ? WHERE nonce_hash = ? AND used_at IS NULL",
        now,
        nonceHash,
      );
      return result.rowsWritten === 1 ? row : null;
    });
    if (!consumed) return null;
    return {
      ...(consumed.project_id ? { projectId: consumed.project_id } : {}),
      environments: JSON.parse(
        consumed.environments_json,
      ) as ProjectEnvironmentName[],
    };
  }

  async bindGitHubInstallation(input: {
    githubInstallationId?: number;
    code: string;
    projectId?: string;
    environments?: ProjectEnvironmentName[];
  }): Promise<GitHubInstallation | null> {
    if (input.projectId && !this.getProject(input.projectId)) return null;
    const config = this.gitHubAppConfig();
    if (!config) return null;
    const userToken = await exchangeGitHubUserCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: input.code,
    });
    let summaries: Awaited<ReturnType<typeof listGitHubUserInstallations>>;
    if (input.githubInstallationId) {
      summaries = [
        await waitForGitHubUserInstallation(
          userToken,
          input.githubInstallationId,
        ),
      ];
    } else {
      const matching = (await listGitHubUserInstallations(userToken)).filter(
        (installation) => installation.appId === config.appId,
      );
      if (matching.length === 0) {
        throw new GitHubMintError(
          "installation_not_found",
          "No installation is accessible to the authorizing user",
        );
      }
      if (input.projectId && matching.length !== 1) {
        throw new GitHubMintError(
          "installation_ambiguous",
          "More than one installation is accessible to the authorizing user",
        );
      }
      summaries = matching;
    }
    if (summaries.some((summary) => summary.appId !== config.appId)) return null;
    const now = new Date().toISOString();
    const installationIds = new Map<number, string>();
    this.ctx.storage.transactionSync(() => {
      for (const summary of summaries) {
        const candidates = this.ctx.storage.sql
          .exec<GitHubInstallationRow & { attachment_count: number }>(
            `SELECT i.*, COUNT(a.installation_id) AS attachment_count
               FROM github_installations i
               LEFT JOIN github_attachments a ON a.installation_id = i.id
              WHERE i.github_installation_id = ?
                 OR (i.github_app_id = ? AND i.github_account_id = ?)
                 OR (i.github_app_id IS NULL AND i.github_account_id IS NULL
                     AND i.account_login = ? AND i.account_type = ?)
              GROUP BY i.id
              ORDER BY i.created_at, i.id`,
            summary.installationId,
            summary.appId,
            summary.accountId,
            summary.accountLogin,
            summary.accountType,
          )
          .toArray();
        const canonical =
          candidates.find(
            (candidate) =>
              candidate.github_app_id === summary.appId &&
              candidate.github_account_id === summary.accountId,
          ) ??
          candidates.reduce<(typeof candidates)[number] | undefined>(
            (selected, candidate) =>
              !selected || candidate.attachment_count > selected.attachment_count
                ? candidate
                : selected,
            undefined,
          );
        const id = canonical?.id ?? `ghi_${crypto.randomUUID().replaceAll("-", "")}`;
        for (const duplicate of candidates) {
          if (duplicate.id === id) continue;
          this.ctx.storage.sql.exec(
            "UPDATE github_attachments SET installation_id = ?, updated_at = ? WHERE installation_id = ?",
            id,
            now,
            duplicate.id,
          );
          this.ctx.storage.sql.exec(
            "DELETE FROM github_installations WHERE id = ?",
            duplicate.id,
          );
        }
        if (canonical) {
          this.ctx.storage.sql.exec(
            `UPDATE github_installations
                SET github_installation_id = ?, github_app_id = ?,
                    github_account_id = ?, account_login = ?, account_type = ?,
                    repository_selection = ?, state = ?, updated_at = ?
              WHERE id = ?`,
            summary.installationId,
            summary.appId,
            summary.accountId,
            summary.accountLogin,
            summary.accountType,
            summary.repositorySelection,
            summary.suspended ? "suspended" : "active",
            now,
            id,
          );
        } else {
          this.ctx.storage.sql.exec(
            `INSERT INTO github_installations
               (id, github_installation_id, github_app_id, github_account_id,
                account_login, account_type, repository_selection, state,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            summary.installationId,
            summary.appId,
            summary.accountId,
            summary.accountLogin,
            summary.accountType,
            summary.repositorySelection,
            summary.suspended ? "suspended" : "active",
            now,
            now,
          );
        }
        installationIds.set(summary.installationId, id);
      }
      const installationId = installationIds.get(summaries[0]!.installationId);
      if (!installationId) throw new Error("GitHub installation write failed");
      for (const environment of input.environments ?? []) {
        this.ctx.storage.sql.exec(
          `INSERT INTO github_attachments
             (project_id, environment, installation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, environment) DO UPDATE SET
             installation_id = excluded.installation_id,
             updated_at = excluded.updated_at`,
          input.projectId!,
          environment,
          installationId,
          now,
          now,
        );
      }
    });
    const row = this.ctx.storage.sql
      .exec<GitHubInstallationRow>(
        "SELECT * FROM github_installations WHERE github_installation_id = ?",
        summaries[0]!.installationId,
      )
      .toArray()[0];
    return row ? gitHubInstallationFromRow(row) : null;
  }

  listGitHubInstallations(): GitHubInstallation[] {
    return this.ctx.storage.sql
      .exec<GitHubInstallationRow>(
        "SELECT * FROM github_installations ORDER BY account_login, id",
      )
      .toArray()
      .map(gitHubInstallationFromRow);
  }

  attachGitHub(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    installationId: string;
  }): boolean {
    if (!this.getProject(input.projectId)) return false;
    const installation = this.ctx.storage.sql
      .exec<GitHubInstallationRow>(
        "SELECT * FROM github_installations WHERE id = ? AND state = 'active'",
        input.installationId,
      )
      .toArray()[0];
    if (!installation) return false;
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO github_attachments
         (project_id, environment, installation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, environment) DO UPDATE SET
         installation_id = excluded.installation_id,
         updated_at = excluded.updated_at`,
      input.projectId,
      input.environment,
      installation.id,
      now,
      now,
    );
    return true;
  }

  getGitHubStatus(projectId: string): GitHubConnectionStatus[] {
    const project = this.getProject(projectId);
    const environments = project
      ? canonicalEnvironments(project.environmentMode)
      : LEGACY_ENVIRONMENTS;
    return environments.map((environment) => {
      const row = this.ctx.storage.sql
        .exec<GitHubInstallationRow>(
          `SELECT i.* FROM github_attachments a
           JOIN github_installations i ON i.id = a.installation_id
           WHERE a.project_id = ? AND a.environment = ?`,
          projectId,
          environment,
        )
        .toArray()[0];
      return row
        ? {
            environment,
            state: row.state as GitHubConnectionStatus["state"],
            installation: gitHubInstallationFromRow(row),
          }
        : { environment, state: "not_connected" };
    });
  }

  /**
   * Mints an installation token for the environment's attached installation
   * with exactly `permissions`. The outcome is a value, never a thrown
   * `GitHubMintError`: a custom error class does not cross the Durable
   * Object RPC boundary with its `code`, so a caller on the other side could
   * only tell "failed" from "worked" and every mint failure became a 500.
   */
  async mintGitHubToken(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    permissions: Record<string, GitHubAppPermission>;
  }): Promise<GitHubTokenMint> {
    const installation = this.ctx.storage.sql
      .exec<GitHubInstallationRow>(
        `SELECT i.* FROM github_attachments a
         JOIN github_installations i ON i.id = a.installation_id
         WHERE a.project_id = ? AND a.environment = ? AND i.state = 'active'`,
        input.projectId,
        input.environment,
      )
      .toArray()[0];
    if (!installation) return { outcome: "not_connected" };
    return this.mintForInstallation(installation, input.permissions);
  }

  /** Mints a token for one of the account's installations, addressed by its connection id rather than a project attachment. */
  async mintGitHubInstallationToken(input: {
    installationId: string;
    /** Omitted: every permission the installation grants (the computer's git and gh). */
    permissions?: Record<string, GitHubAppPermission>;
    /** Narrow the token to these repositories (bare names in the installation's account). */
    repositories?: string[];
  }): Promise<GitHubTokenMint> {
    const installation = this.ctx.storage.sql
      .exec<GitHubInstallationRow>(
        "SELECT * FROM github_installations WHERE id = ? AND state = 'active'",
        input.installationId,
      )
      .toArray()[0];
    if (!installation) return { outcome: "not_connected" };
    return this.mintForInstallation(installation, input.permissions, input.repositories);
  }

  getGitHubInstallation(installationId: string): GitHubInstallation | null {
    const row = this.ctx.storage.sql
      .exec<GitHubInstallationRow>(
        "SELECT * FROM github_installations WHERE id = ?",
        installationId,
      )
      .toArray()[0];
    return row ? gitHubInstallationFromRow(row) : null;
  }

  private async mintForInstallation(
    installation: GitHubInstallationRow,
    permissions: Record<string, GitHubAppPermission> | undefined,
    repositories?: string[],
  ): Promise<GitHubTokenMint> {
    const config = this.gitHubAppConfig();
    if (!config) return { outcome: "app_not_configured" };
    try {
      const key = await importGitHubAppKey(config.privateKey);
      const minted = await mintGitHubInstallationToken({
        appJwt: await gitHubAppJwt(config.appId, key),
        installationId: installation.github_installation_id,
        ...(permissions ? { permissions } : {}),
        ...(repositories?.length ? { repositories } : {}),
      });
      return { outcome: "minted", token: minted.token, expiresAt: minted.expiresAt };
    } catch (error) {
      if (error instanceof GitHubMintError) {
        if (error.code === "installation_not_found") {
          this.ctx.storage.sql.exec(
            `UPDATE github_installations
                SET state = 'deleted', updated_at = ?
              WHERE id = ?`,
            new Date().toISOString(),
            installation.id,
          );
        }
        return {
          outcome: "failed",
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        };
      }
      throw error;
    }
  }

  // ── Linear (work 037 S4) ────────────────────────────────────────────────────

  /**
   * `callService({ service: "linear" })` from a session this Linear
   * connection owns: `POST /graphql` only, with the connection's app token.
   * The token never leaves this object.
   */
  async linearServiceRequest(
    connectionId: string,
    request: LinearServiceRequest,
  ): Promise<LinearServiceResult> {
    return linearServiceRequest(this.linearConnections, connectionId, request);
  }

  detachGitHub(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
  }): boolean {
    return (
      this.ctx.storage.sql.exec(
        "DELETE FROM github_attachments WHERE project_id = ? AND environment = ?",
        input.projectId,
        input.environment,
      ).rowsWritten === 1
    );
  }

  createProjectAccessToken(input: {
    id: string;
    projectId: string;
    name: string;
    environment: ProjectEnvironmentName;
    prefix: string;
    tokenHash: string;
    token: string;
  }): CreatedProjectAccessToken {
    if (!this.getProject(input.projectId)) throw new Error("Project not found");
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO project_access_tokens
         (id, project_id, name, environment, prefix, token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.projectId,
      input.name.trim() || "Development",
      input.environment,
      input.prefix,
      input.tokenHash,
      timestamp,
    );
    return {
      id: input.id,
      projectId: input.projectId,
      name: input.name.trim() || "Development",
      environment: input.environment,
      prefix: input.prefix,
      createdAt: timestamp,
      token: input.token,
    };
  }

  listProjectAccessTokens(projectId: string): ProjectAccessToken[] {
    return this.ctx.storage.sql
      .exec<ProjectTokenRow>(
        `SELECT id, project_id, name, environment, prefix, created_at,
                last_used_at, revoked_at
         FROM project_access_tokens WHERE project_id = ? ORDER BY created_at DESC`,
        projectId,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        environment: row.environment as ProjectEnvironmentName,
        prefix: row.prefix,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at ?? undefined,
        revokedAt: row.revoked_at ?? undefined,
      }));
  }

  validateProjectAccessToken(tokenHash: string): Project | null {
    const row = this.ctx.storage.sql
      .exec<{ project_id: string }>(
        `SELECT project_id FROM project_access_tokens
         WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
        tokenHash,
      )
      .toArray()[0];
    if (!row) return null;
    this.ctx.storage.sql.exec(
      "UPDATE project_access_tokens SET last_used_at = ? WHERE token_hash = ?",
      new Date().toISOString(),
      tokenHash,
    );
    return this.getProject(row.project_id);
  }

  /**
   * Every agent belonging to a project.
   *
   * A project owns its own agent id and each `id--name` beneath it — the same
   * prefix relationship projectForAgent resolves in the other direction. A
   * delete that only matched the exact id would leave every agent in a
   * multi-agent project behind, still deployed and still serving.
   */
  agentIdsForProject(projectId: string): string[] {
    const project = this.getProject(projectId);
    if (!project) return [];
    return this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM agents
         WHERE id = ? OR instr(id, ? || '--') = 1
         ORDER BY id`,
        project.agentId,
        project.agentId,
      )
      .toArray()
      .map((row) => row.id);
  }

  /** Sessions still running for a project, which must be stopped before its
   *  rows go: deleting the record does not stop the machine. */
  liveSessionIdsForProject(projectId: string): string[] {
    const agentIds = this.agentIdsForProject(projectId);
    if (!agentIds.length) return [];
    const placeholders = agentIds.map(() => "?").join(", ");
    return this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM sessions
         WHERE status != 'ended' AND agent_id IN (${placeholders})`,
        ...agentIds,
      )
      .toArray()
      .map((row) => row.id);
  }

  /** Connections held by a project's agents, so their grants can be withdrawn
   *  before the rows that point at them are gone. */
  connectionsForProject(projectId: string): Connection[] {
    const agentIds = new Set(this.agentIdsForProject(projectId));
    return this.listConnections().filter(
      (connection: Connection) =>
        connection.agentId !== undefined && agentIds.has(connection.agentId),
    );
  }

  /**
   * Remove a project and everything beneath it.
   *
   * One transaction: a half-deleted project is worse than either outcome,
   * because what survives is a configuration nothing owns. The caller stops
   * the live things first — sessions, schedules, grants — since none of them
   * are stopped by deleting a row.
   */
  deleteProject(projectId: string): boolean {
    const project = this.getProject(projectId);
    if (!project) return false;
    const agentIds = this.agentIdsForProject(projectId);
    const agents = agentIds.length
      ? `(${agentIds.map(() => "?").join(", ")})`
      : "(NULL)";

    this.ctx.storage.transactionSync(() => {
      for (const table of [
        "project_environments",
        "project_access_tokens",
        "github_attachments",
        "github_connect_states",
        "model_access_bindings",
        "managed_secrets",
        "agent_runtime_variables",
        "project_webhook_requests",
        "project_webhooks",
        "event_subscriptions",
        "project_schedule_runs",
        "project_schedules",
        "agent_logs",
      ]) {
        this.ctx.storage.sql.exec(
          `DELETE FROM ${table} WHERE project_id = ?`,
          projectId,
        );
      }
      if (agentIds.length) {
        for (const table of [
          "sessions",
          "deployment_aliases",
          "deployments",
          "channel_connections",
          "connections",
          "channel_apps",
          "outbox_items",
          "approvals",
        ]) {
          this.ctx.storage.sql.exec(
            `DELETE FROM ${table} WHERE agent_id IN ${agents}`,
            ...agentIds,
          );
        }
        this.ctx.storage.sql.exec(
          `DELETE FROM agents WHERE id IN ${agents}`,
          ...agentIds,
        );
      }
      this.ctx.storage.sql.exec("DELETE FROM projects WHERE id = ?", projectId);
    });
    return true;
  }

  projectForAgent(agentId: string): Project | null {
    const rows = this.ctx.storage.sql
      .exec<ProjectRow>(
        `SELECT id, slug, name, agent_id, environment_mode, archived_at, created_at, updated_at
         FROM projects
         WHERE ? = agent_id OR instr(?, agent_id || '--') = 1
         ORDER BY length(agent_id) DESC
         LIMIT 1`,
        agentId,
        agentId,
      )
      .toArray();
    return rows[0] ? this.projectFromRow(rows[0]) : null;
  }

  /**
   * The deployment a `consult` call targets: `memberRef` (a local name like
   * `categoriser` or a full `primary--categoriser` id) restricted to members
   * of the project `hostAgentId` belongs to, active in `environment`. Null
   * when the host belongs to no project or no member deployment matches — a
   * session can never reach another project's agents.
   */
  consultDeployment(
    hostAgentId: string,
    memberRef: string,
    environment: ProjectEnvironmentName,
  ): { agentId: string; deployment: AgentDeployment } | null {
    const project = this.projectOwningAgent(hostAgentId);
    if (!project) return null;
    const candidates =
      memberRef === project.agentId || memberRef.startsWith(`${project.agentId}--`)
        ? [memberRef]
        : [`${project.agentId}--${memberRef}`];
    for (const agentId of candidates) {
      const deployment = this.resolveDeployment(`${agentId}@${environment}`);
      if (deployment) return { agentId, deployment };
    }
    return null;
  }

  private scheduleFromRow(row: ScheduleRow): ProjectSchedule {
    return {
      id: row.schedule_id,
      projectId: row.project_id,
      environment: row.environment as ProjectEnvironmentName,
      agentId: row.agent_id,
      deploymentId: row.deployment_id,
      cron: row.cron,
      timezone: row.timezone,
      overlap: row.overlap_policy === "allow" ? "allow" : "skip",
      dispatch: JSON.parse(row.dispatch_json) as ProjectSchedule["dispatch"],
      nextRunAt: row.next_run_at,
      ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
      status:
        row.status === "paused"
          ? "paused"
          : row.status === "manual"
            ? "manual"
            : "active",
    };
  }

  private scheduleRunFromRow(row: ScheduleRunRow): ProjectScheduleRun {
    return {
      id: row.id,
      scheduleId: row.schedule_id,
      projectId: row.project_id,
      environment: row.environment as ProjectEnvironmentName,
      deploymentId: row.deployment_id,
      scheduledAt: row.scheduled_at,
      manual: Boolean(row.manual),
      attempt: Number(row.attempt),
      outcome: row.outcome as ProjectScheduleRun["outcome"],
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
    };
  }

  private async resetScheduleAlarm(): Promise<void> {
    await this.resetAlarm();
  }

  /** One alarm serves schedules and deferred webhook admissions: the earliest wins. */
  private async resetAlarm(): Promise<void> {
    const nextSchedule = this.ctx.storage.sql
      .exec<{ next_run_at: string }>(
        `SELECT next_run_at FROM project_schedules
         WHERE status = 'active'
           AND project_id IN (SELECT id FROM projects WHERE archived_at IS NULL)
         ORDER BY next_run_at LIMIT 1`,
      )
      .toArray()[0]?.next_run_at;
    const nextRequest = this.ctx.storage.sql
      .exec<{ next_attempt_at: string }>(
        `SELECT next_attempt_at FROM project_webhook_requests
         WHERE outcome = 'pending' AND next_attempt_at IS NOT NULL
           AND project_id IN (SELECT id FROM projects WHERE archived_at IS NULL)
         ORDER BY next_attempt_at LIMIT 1`,
      )
      .toArray()[0]?.next_attempt_at;
    const nextApproval = this.ctx.storage.sql
      .exec<{ due_at: string }>(
        `SELECT due_at FROM (
           SELECT expires_at AS due_at FROM approvals WHERE status = 'pending'
           UNION ALL
           SELECT datetime(applying_at, ?) AS due_at
             FROM approvals WHERE status = 'applying'
         ) ORDER BY due_at LIMIT 1`,
        `+${String(Math.round(APPLY_GRACE_MS / 1_000))} seconds`,
      )
      .toArray()[0]?.due_at;
    const nextActivation = nextMemoryActivationAttempt(this.ctx.storage.sql);
    const nextReconcile = await this.ctx.storage.get<number>(SESSION_RECONCILE_ALARM_KEY);
    const candidates = [
      nextSchedule,
      nextRequest,
      nextApproval,
      nextActivation,
      nextLinearDeliveryAttempt(this.ctx.storage.sql),
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => new Date(value).getTime());
    if (typeof nextReconcile === "number") candidates.push(nextReconcile);
    if (!candidates.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(new Date(Math.min(...candidates)));
  }

  async reconcileProjectSchedules(input: {
    accountId: string;
    userId: string;
    projectId: string;
    environment: ProjectEnvironmentName;
    edgeOrigin: string;
    projectDeployment: ProjectDeploymentReference;
  }): Promise<{ active: number; ready: boolean }> {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    if (project.archivedAt) throw new Error("Project is archived");
    const ready = this.projectDeploymentReady(input.projectDeployment);
    if (!ready) return { active: 0, ready: false };

    const origin = new URL(input.edgeOrigin).origin;
    // A single-mode project's one scope runs every schedule, as development
    // always has; only legacy production is opt-in per schedule.
    const definitions = input.projectDeployment.resources.schedules.filter(
      (schedule) =>
        input.environment !== "production" ||
        schedule.enabled.includes("production"),
    );
    const members = new Map(
      input.projectDeployment.agents.map((member) => [member.localId, member]),
    );
    const timestamp = new Date().toISOString();
    const keys = new Set(
      definitions.map((schedule) => {
        const member = members.get(schedule.agentId);
        if (!member) throw new Error(`Schedule ${schedule.id} targets an unknown agent`);
        return `${member.agentId}:${schedule.id}`;
      }),
    );

    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<ScheduleRow>(
          `SELECT * FROM project_schedules
           WHERE project_id = ? AND environment = ?`,
          input.projectId,
          input.environment,
        )
        .toArray();
      for (const row of existing) {
        if (!keys.has(`${row.agent_id}:${row.schedule_id}`)) {
          this.ctx.storage.sql.exec(
            `DELETE FROM project_schedules
             WHERE project_id = ? AND environment = ?
               AND agent_id = ? AND schedule_id = ?`,
            input.projectId,
            input.environment,
            row.agent_id,
            row.schedule_id,
          );
        }
      }

      for (const definition of definitions) {
        const member = members.get(definition.agentId);
        if (!member) throw new Error(`Schedule ${definition.id} targets an unknown agent`);
        const agentId = member.agentId;
        const deploymentId = `${agentId}:${member.artifactDigest}`;
        const prior = existing.find(
          (row) => row.agent_id === agentId && row.schedule_id === definition.id,
        );
        const nextRunAt =
          prior &&
          prior.cron === definition.cron &&
          prior.timezone === definition.timezone
            ? prior.next_run_at
            : nextScheduleRun(definition.cron, definition.timezone);
        this.ctx.storage.sql.exec(
          `INSERT INTO project_schedules (
             project_id, account_id, environment, schedule_id, agent_id,
             deployment_id, cron, timezone, overlap_policy, dispatch_json,
             edge_origin, user_id, status, next_run_at, last_run_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, environment, agent_id, schedule_id) DO UPDATE SET
             account_id = excluded.account_id,
             deployment_id = excluded.deployment_id,
             cron = excluded.cron,
             timezone = excluded.timezone,
             overlap_policy = excluded.overlap_policy,
             dispatch_json = excluded.dispatch_json,
             edge_origin = excluded.edge_origin,
             user_id = excluded.user_id,
             status = excluded.status,
             next_run_at = excluded.next_run_at,
             updated_at = excluded.updated_at`,
          input.projectId,
          input.accountId,
          input.environment,
          definition.id,
          agentId,
          deploymentId,
          definition.cron,
          definition.timezone,
          definition.overlap,
          JSON.stringify(definition.dispatch),
          origin,
          input.userId,
          scheduleEnabledIn(definition.enabled, input.environment)
            ? "active"
            : "manual",
          nextRunAt,
          prior?.last_run_at ?? null,
          prior?.created_at ?? timestamp,
          timestamp,
        );
      }
    });
    await this.resetScheduleAlarm();
    return { active: definitions.length, ready: true };
  }

  listProjectSchedules(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
  }): ProjectSchedule[] {
    return this.ctx.storage.sql
      .exec<ScheduleRow>(
        `SELECT * FROM project_schedules
         WHERE project_id = ? AND environment = ?
           AND (? IS NULL OR agent_id = ?)
         ORDER BY agent_id, schedule_id`,
        input.projectId,
        input.environment,
        input.agentId ?? null,
        input.agentId ?? null,
      )
      .toArray()
      .map((row) => this.scheduleFromRow(row));
  }

  listProjectScheduleRuns(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    scheduleId?: string;
    limit?: number;
  }): ProjectScheduleRun[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return this.ctx.storage.sql
      .exec<ScheduleRunRow>(
        `SELECT * FROM project_schedule_runs
         WHERE project_id = ? AND environment = ?
           AND (? IS NULL OR agent_id = ?)
           AND (? IS NULL OR schedule_id = ?)
         ORDER BY created_at DESC LIMIT ?`,
        input.projectId,
        input.environment,
        input.agentId ?? null,
        input.agentId ?? null,
        input.scheduleId ?? null,
        input.scheduleId ?? null,
        limit,
      )
      .toArray()
      .map((row) => this.scheduleRunFromRow(row));
  }

  /**
   * Whether a sandbox session's turn is waiting on a runtime that no longer
   * exists. Only asked about a bound, running runtime with an active turn; a
   * provider that cannot tell, or any error, reads as alive.
   */
  private async sandboxRuntimeGone(
    env: ScheduleRuntimeEnv,
    snapshot: SessionSnapshot,
  ): Promise<boolean> {
    if (
      !env.RUNTIMES ||
      snapshot.executionMode === "workerd" ||
      snapshot.status === "ended" ||
      !snapshot.microvmId ||
      (snapshot.microvmState && snapshot.microvmState !== "running") ||
      !snapshot.turns.some((turn) => turn.status === "queued" || turn.status === "running")
    ) {
      return false;
    }
    try {
      const response = await env.RUNTIMES.fetch(
        `https://blue-runtime/v1/sessions/${encodeURIComponent(snapshot.id)}/status`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId: snapshot.accountId,
            microvmId: snapshot.microvmId,
          }),
        },
      );
      if (!response.ok) return false;
      const { state } = (await response.json()) as { state?: string };
      return state === "terminated";
    } catch {
      return false;
    }
  }

  private async enactProjectSchedule(
    row: ScheduleRow,
    scheduledAt: string,
    manual: boolean,
  ): Promise<ProjectScheduleRun> {
    const runId = manual
      ? crypto.randomUUID()
      : [row.project_id, row.environment, row.agent_id, row.schedule_id, scheduledAt].join(":");
    const existing = this.ctx.storage.sql
      .exec<ScheduleRunRow>("SELECT * FROM project_schedule_runs WHERE id = ?", runId)
      .toArray()[0];
    if (existing) return this.scheduleRunFromRow(existing);

    const timestamp = new Date().toISOString();
    const env = this.env as ScheduleRuntimeEnv;
    const overlapCandidates =
      row.overlap_policy === "skip"
        ? this.ctx.storage.sql
            .exec<{ id: string }>(
              `SELECT s.id
               FROM project_schedule_runs r
               JOIN sessions s ON s.id = r.session_id
               WHERE r.project_id = ? AND r.environment = ?
                 AND r.agent_id = ? AND r.schedule_id = ?
                 AND r.outcome = 'enacted'
                 AND s.status IN ('new', 'connecting', 'running', 'waiting_runtime', 'resuming')`,
              row.project_id,
              row.environment,
              row.agent_id,
              row.schedule_id,
            )
            .toArray()
        : [];
    let overlapping = false;
    for (const candidate of overlapCandidates) {
      const candidateSession = env.SESSIONS.getByName(candidate.id);
      const snapshot = (await candidateSession.snapshot()) as SessionSnapshot;
      // A run whose sandbox is gone (crashed, reaped, past its lifetime) never
      // settles its turn and would skip every later firing: end it instead.
      if (await this.sandboxRuntimeGone(env, snapshot)) {
        await candidateSession.end();
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "schedule.overlap_runtime_gone",
            accountId: row.account_id,
            scheduleId: row.schedule_id,
            sessionId: snapshot.id,
            microvmId: snapshot.microvmId,
          }),
        );
        continue;
      }
      // A sandbox session holding a turn with no runtime bound needs a start;
      // without one it would stay active forever and skip every later firing.
      // The session's claim makes this a no-op while a start is in flight.
      if (
        snapshot.executionMode !== "workerd" &&
        snapshot.status !== "ended" &&
        !snapshot.microvmId
      ) {
        const candidateDeployment = this.getDeployment(snapshot.deploymentId);
        if (candidateDeployment) {
          this.startSandboxRuntime({
            session: candidateSession,
            accountId: row.account_id,
            projectId: row.project_id,
            deployment: this.runtimeDeployment(env, row.account_id, candidateDeployment),
            edgeOrigin: row.edge_origin,
          });
        }
      }
      const activeTurn = snapshot.turns.some(
        (turn) => turn.status === "queued" || turn.status === "running",
      );
      const activeLifecycle =
        snapshot.status === "new" ||
        snapshot.status === "connecting" ||
        snapshot.status === "running" ||
        snapshot.status === "resuming";
      if (
        activeLifecycle ||
        (snapshot.status === "waiting_runtime" &&
          Boolean(snapshot.runtimeId || activeTurn))
      ) {
        overlapping = true;
        break;
      }
    }
    if (overlapping) {
      this.ctx.storage.sql.exec(
        `INSERT INTO project_schedule_runs (
           id, schedule_id, project_id, environment, agent_id, deployment_id,
           scheduled_at, manual, attempt, outcome, session_id, error,
           idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'skipped', NULL, ?, ?, ?, ?)`,
        runId,
        row.schedule_id,
        row.project_id,
        row.environment,
        row.agent_id,
        row.deployment_id,
        scheduledAt,
        manual ? 1 : 0,
        "A prior run is still active",
        runId,
        timestamp,
        timestamp,
      );
      return this.scheduleRunFromRow(
        this.ctx.storage.sql
          .exec<ScheduleRunRow>("SELECT * FROM project_schedule_runs WHERE id = ?", runId)
          .toArray()[0]!,
      );
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO project_schedule_runs (
         id, schedule_id, project_id, environment, agent_id, deployment_id,
         scheduled_at, manual, attempt, outcome, session_id, error,
         idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL, ?, ?, ?)`,
      runId,
      row.schedule_id,
      row.project_id,
      row.environment,
      row.agent_id,
      row.deployment_id,
      scheduledAt,
      manual ? 1 : 0,
      runId,
      timestamp,
      timestamp,
    );

    const deployment = this.getDeployment(row.deployment_id);
    if (!deployment) {
      this.ctx.storage.sql.exec(
        "UPDATE project_schedule_runs SET outcome = 'failed', error = ?, updated_at = ? WHERE id = ?",
        "Pinned deployment is unavailable",
        timestamp,
        runId,
      );
      return this.scheduleRunFromRow(
        this.ctx.storage.sql
          .exec<ScheduleRunRow>("SELECT * FROM project_schedule_runs WHERE id = ?", runId)
          .toArray()[0]!,
      );
    }

    const sessionId = crypto.randomUUID();
    const dispatch = JSON.parse(row.dispatch_json) as ProjectSchedule["dispatch"];
    const text = dispatch.text?.trim() || `Run schedule ${row.schedule_id}`;
    try {
      await this.launchSession({
        sessionId,
        accountId: row.account_id,
        userId: row.user_id,
        projectId: row.project_id,
        agentId: row.agent_id,
        environment: row.environment as ProjectEnvironmentName,
        deployment,
        edgeOrigin: row.edge_origin,
        source: "schedule",
        text,
        idempotencyKey: `schedule:${runId}`,
        agentInput: {
          source: "schedule",
          text,
          ...(dispatch.payload !== undefined ? { payload: dispatch.payload } : {}),
          schedule: {
            id: row.schedule_id,
            runId,
            scheduledAt,
            timezone: row.timezone,
            attempt: 1,
            manual,
          },
        },
      });
      this.ctx.storage.sql.exec(
        `UPDATE project_schedule_runs
         SET outcome = 'enacted', session_id = ?, error = NULL, updated_at = ? WHERE id = ?`,
        sessionId,
        new Date().toISOString(),
        runId,
      );
    } catch (error) {
      this.ctx.storage.sql.exec(
        `UPDATE project_schedule_runs
         SET outcome = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        error instanceof Error ? error.message.slice(0, 1_000) : "Schedule run failed",
        new Date().toISOString(),
        runId,
      );
    }
    return this.scheduleRunFromRow(
      this.ctx.storage.sql
        .exec<ScheduleRunRow>(
          "SELECT * FROM project_schedule_runs WHERE id = ?",
          runId,
        )
        .toArray()[0]!,
    );
  }

  /**
   * A session's pinned deployment as this account's runtime profile runs it,
   * for a session that boots its own runtime (a turn waking a suspended
   * sandbox). Null when the deployment is gone.
   */
  sessionRuntimeDeployment(accountId: string, deploymentId: string): AgentDeployment | null {
    const deployment = this.getDeployment(deploymentId);
    return deployment
      ? this.runtimeDeployment(this.env as ScheduleRuntimeEnv, accountId, deployment)
      : null;
  }

  /** A deployment as this account's runtime profile runs it. */
  private runtimeDeployment(
    env: ScheduleRuntimeEnv,
    accountId: string,
    deployment: AgentDeployment,
  ): AgentDeployment {
    const assignment = this.getManagedRuntimeProfile();
    return runtimeDeploymentForProfile(
      env,
      deployment,
      managedRuntimeProfile(
        env,
        assignment
          ? assignment.profileId
          : configuredManagedRuntimeProfileAssignment(env, accountId),
      ),
    );
  }

  /**
   * Boot a sandbox session's runtime in the background (the DO-first start).
   * The account's own launches need this as much as the HTTP routes do: a
   * sandbox session nobody starts holds its turn forever.
   */
  private startSandboxRuntime(input: {
    session: DurableObjectStub<SessionDurableObject>;
    accountId: string;
    projectId: string;
    deployment: AgentDeployment;
    edgeOrigin: string;
  }): void {
    const env = this.env as ScheduleRuntimeEnv & { DO_FIRST_SESSION_SPIKE?: string };
    if (env.DO_FIRST_SESSION_SPIKE !== "true") return;
    this.ctx.waitUntil(
      startSandboxSessionRuntime(env, {
        accountId: input.accountId,
        session: input.session,
        edge: input.edgeOrigin,
        configuration: async () => ({
          projectId: input.projectId,
          deployment: input.deployment,
        }),
      }),
    );
  }

  /**
   * Initialize a session, start its runtime, index it, and enqueue its first
   * turn. Used by schedule firings and deferred webhook admissions. On any
   * failure the session is ended and the error rethrown; the caller records it.
   */
  private async launchSession(input: {
    sessionId: string;
    accountId: string;
    userId: string;
    projectId: string;
    agentId: string;
    /**
     * The environment the admission belongs to (the webhook's, the
     * schedule's): recorded on the session so the list's environment filter
     * and credential selection see it, as every other creation path does.
     */
    environment: ProjectEnvironmentName;
    deployment: AgentDeployment;
    edgeOrigin: string;
    source: SessionSource;
    text: string;
    idempotencyKey: string;
    agentInput: StructuredAgentInput;
    /** Linear's prompt `createdAt` for the first turn (work 037 S2). */
    providerTime?: string;
  }): Promise<void> {
    const env = this.env as ScheduleRuntimeEnv;
    await requireAutonomousBillingAdmission(env, input.accountId);
    const runtimeDeployment = this.runtimeDeployment(
      env,
      input.accountId,
      input.deployment,
    );
    const session = env.SESSIONS.getByName(
      input.sessionId,
      regionPlacement(input.deployment.region),
    );
    const executionMode = sessionRunsOnWorkerd(env, input.accountId)
      ? "workerd"
      : "microvm";
    let enqueueIssued = false;
    try {
      await session.initialize({
        id: input.sessionId,
        accountId: input.accountId,
        userId: input.userId,
        agentId: input.agentId,
        deploymentId: input.deployment.id,
        executionMode,
        deployment: runtimeDeployment,
        runtimeEdge: input.edgeOrigin,
        projectId: input.projectId,
        environment: input.environment,
        source: input.source,
      });
      // The session's first row, before its first turn: a list read sees
      // it as soon as it exists. The Session object's alarm re-delivers if
      // this is lost.
      await session.publishSummary();
      enqueueIssued = true;
      await session.enqueueTurn({
        input: input.text,
        idempotencyKey: input.idempotencyKey,
        agentInput: input.agentInput,
        ...(input.providerTime ? { providerTime: input.providerTime } : {}),
      });
      // A Workerd session runs its turn itself; a sandbox session's runtime
      // is booted from outside, as the HTTP create and turn routes do.
      if (executionMode === "microvm") {
        this.startSandboxRuntime({
          session,
          accountId: input.accountId,
          projectId: input.projectId,
          deployment: runtimeDeployment,
          edgeOrigin: input.edgeOrigin,
        });
      }
    } catch (error) {
      if (!enqueueIssued) {
        // Nothing can have been admitted; the session is safe to end.
        await session.end().catch(() => undefined);
        throw error;
      }
      // The enqueue was issued and its reply was lost or it failed. The
      // Session DO knows which; only it may decide, and a session that
      // holds the turn must not be ended (the runtime may already run it).
      let committed: { turnId: string } | null | undefined;
      try {
        committed = await session.findTurn(input.idempotencyKey);
      } catch {
        committed = undefined;
      }
      if (committed) return;
      if (committed === null) await session.end().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Enact one acknowledged webhook delivery. Recovery decides on one fact,
   * whether the Session DO named by the ledger holds the keyed turn:
   *
   *   turn exists                       → accept that session, even if ended
   *   initialized, runtime bound        → enqueue there (idempotent), accept
   *   ended, no turn                    → replace (the launcher ended it on a
   *                                       failure before any enqueue)
   *   initialized, no runtime bound     → terminal failure: the launch outcome
   *                                       is unknown and only the session could
   *                                       re-ensure its compute (work 020)
   *   never initialized                 → launch under the ledger's id
   *   Session DO unreachable            → record, retry later, allocate nothing
   *
   * A replacement id is written to the ledger before the replacement is
   * touched, so every later attempt finds it. Attempt ids never repeat.
   * Retries follow WEBHOOK_ENACT_BACKOFF_MS; the fifth failure is final.
   */
  private async enactProjectWebhookRequest(
    row: ProjectWebhookRequestRow,
  ): Promise<void> {
    if (
      row.outcome !== "pending" ||
      !row.input_json ||
      !row.edge_origin ||
      !row.account_id ||
      !row.session_id
    ) {
      return;
    }
    const attempt = (row.attempt ?? 0) + 1;
    const leaseUntil = new Date(Date.now() + WEBHOOK_ENACT_LEASE_MS).toISOString();
    // Take a lease before any await so a second alarm firing skips this row.
    const leased = this.ctx.storage.sql
      .exec(
        `UPDATE project_webhook_requests
         SET attempt = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND outcome = 'pending' AND (attempt IS NULL OR attempt = ?)`,
        attempt,
        leaseUntil,
        new Date().toISOString(),
        row.id,
        attempt - 1,
      )
      .rowsWritten;
    if (!leased) return;

    const env = this.env as ScheduleRuntimeEnv;
    const accountId = row.account_id;
    const webhook = this.projectWebhookRow(row.webhook_id);
    const deployment = row.deployment_id ? this.getDeployment(row.deployment_id) : null;
    const input = JSON.parse(row.input_json) as {
      text?: string;
      payload?: StructuredAgentInput["payload"];
    };
    const text = input.text?.trim() || `Webhook ${webhook?.name ?? row.webhook_id} invoked`;
    const agentInput: StructuredAgentInput = {
      source: "webhook",
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(Object.hasOwn(input, "payload") ? { payload: input.payload } : {}),
      webhook: { id: row.webhook_id, requestId: row.id, receivedAt: row.created_at },
    };
    const idempotencyKey = `webhook:${row.id}`;
    let sessionId = row.session_id;
    let recovered = false;
    try {
      if (!webhook || webhook.enabled !== 1) throw new Error("Webhook unavailable");
      if (!deployment) throw new Error("Pinned deployment is unavailable");

      const prior = env.SESSIONS.getByName(
        sessionId,
        regionPlacement(deployment.region),
      );
      // Only the Session DO can say whether the admission already happened.
      const committed = await prior.findTurn(idempotencyKey);
      if (committed) {
        recovered = true;
      } else {
        const snapshot = await prior.snapshotOrNull();
        if (snapshot && snapshot.status !== "ended") {
          const runtimeReady = Boolean(snapshot.microvmId) || !env.RUNTIMES;
          if (runtimeReady) {
            // A usable session with no turn yet: finish the earlier attempt.
            await prior.publishSummary();
            await prior.enqueueTurn({ input: text, idempotencyKey, agentInput });
            recovered = true;
          } else {
            // Initialized, no runtime bound, no turn: the earlier attempt died
            // between launch and bind. This admission cannot re-ensure the
            // session's compute; say so instead of guessing. A resend under a
            // new identity starts fresh, as a failed session route does today.
            throw new WebhookAdmissionTerminalError(
              "Session initialized without a runtime; resend the delivery under a new identity",
            );
          }
        }
        if (!recovered) {
          if (snapshot) {
            // Persist the replacement before touching it (invariant 1).
            sessionId = await derivedSessionId(accountId, webhookRequestSessionKey(row.id, attempt));
            this.ctx.storage.sql.exec(
              "UPDATE project_webhook_requests SET session_id = ?, updated_at = ? WHERE id = ?",
              sessionId,
              new Date().toISOString(),
              row.id,
            );
          }
          await this.launchSession({
            sessionId,
            accountId,
            userId: row.user_id ?? webhook.created_by,
            projectId: row.project_id,
            agentId: row.agent_id,
            environment: row.environment as ProjectEnvironmentName,
            deployment,
            edgeOrigin: row.edge_origin,
            source: "webhook",
            text,
            idempotencyKey,
            agentInput,
          });
        }
      }
      this.recordWebhookRequestAccepted(row.id, sessionId);
      console.log(
        JSON.stringify({
          level: "info",
          event: "agent_webhook.accepted",
          webhookId: row.webhook_id,
          requestId: row.id,
          projectId: row.project_id,
          environment: row.environment,
          agentId: row.agent_id,
          deploymentId: row.deployment_id,
          sessionId,
          attempt,
          recovered,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 1_000) : "Webhook admission failed";
      const backoff = WEBHOOK_ENACT_BACKOFF_MS[attempt - 1];
      const terminal = error instanceof WebhookAdmissionTerminalError;
      const exhausted = backoff === undefined || terminal;
      this.ctx.storage.sql.exec(
        `UPDATE project_webhook_requests
         SET outcome = ?, next_attempt_at = ?, terminal = ?, error = ?, updated_at = ?
         WHERE id = ?`,
        exhausted ? "failed" : "pending",
        exhausted ? null : new Date(Date.now() + backoff).toISOString(),
        terminal ? 1 : 0,
        message,
        new Date().toISOString(),
        row.id,
      );
      console.log(
        JSON.stringify({
          level: exhausted ? "error" : "warn",
          event: "agent_webhook.enact_failed",
          webhookId: row.webhook_id,
          requestId: row.id,
          projectId: row.project_id,
          environment: row.environment,
          agentId: row.agent_id,
          sessionId,
          attempt,
          exhausted,
          terminal,
          error: message,
        }),
      );
    }
  }

  /** The acceptance write, separate so recovery after its failure is testable. */
  private recordWebhookRequestAccepted(id: string, sessionId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE project_webhook_requests
       SET outcome = 'accepted', session_id = ?, next_attempt_at = NULL, error = NULL, updated_at = ?
       WHERE id = ?`,
      sessionId,
      new Date().toISOString(),
      id,
    );
  }

  async runProjectScheduleNow(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId: string;
    scheduleId: string;
  }): Promise<ProjectScheduleRun> {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    if (project.archivedAt) throw new Error("Project is archived");
    const row = this.ctx.storage.sql
      .exec<ScheduleRow>(
        `SELECT * FROM project_schedules
         WHERE project_id = ? AND environment = ? AND agent_id = ? AND schedule_id = ?`,
        input.projectId,
        input.environment,
        input.agentId,
        input.scheduleId,
      )
      .toArray()[0];
    if (!row) throw new Error("Schedule not found");
    return this.enactProjectSchedule(row, new Date().toISOString(), true);
  }

  override async alarm(): Promise<void> {
    const now = new Date();
    const due = this.ctx.storage.sql
      .exec<ScheduleRow>(
        `SELECT * FROM project_schedules
         WHERE status = 'active' AND next_run_at <= ?
           AND project_id IN (SELECT id FROM projects WHERE archived_at IS NULL)
         ORDER BY next_run_at LIMIT 50`,
        now.toISOString(),
      )
      .toArray();
    for (const row of due) {
      const scheduledAt = row.next_run_at;
      this.ctx.storage.sql.exec(
        `UPDATE project_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ?
         WHERE project_id = ? AND environment = ? AND agent_id = ? AND schedule_id = ?`,
        scheduledAt,
        nextScheduleRun(row.cron, row.timezone, new Date(scheduledAt)),
        now.toISOString(),
        row.project_id,
        row.environment,
        row.agent_id,
        row.schedule_id,
      );
      await this.enactProjectSchedule(row, scheduledAt, false);
    }
    const dueRequests = this.ctx.storage.sql
      .exec<ProjectWebhookRequestRow>(
        `SELECT * FROM project_webhook_requests
         WHERE outcome = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
           AND project_id IN (SELECT id FROM projects WHERE archived_at IS NULL)
         ORDER BY next_attempt_at LIMIT 50`,
        now.toISOString(),
      )
      .toArray();
    for (const row of dueRequests) {
      await this.enactProjectWebhookRequest(row);
    }
    await this.linearIngress().enactDue(now.toISOString());
    await this.expireApprovals(now.toISOString());
    const reconcileAt = await this.ctx.storage.get<number>(SESSION_RECONCILE_ALARM_KEY);
    if (typeof reconcileAt === "number" && reconcileAt <= now.getTime()) {
      await this.reconcileSessionPublications({});
    }
    for (const row of dueMemoryActivations(this.ctx.storage.sql, now.toISOString())) {
      // A promotion whose apply or flip did not complete: re-drive it by seq.
      await driveMemoryActivation(
        this.ctx.storage,
        this.env as Env & MemoryActivationEnv,
        row,
        () => this.resetAlarm(),
      ).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "memory.activation_redrive_failed",
            projectId: row.project_id,
            environment: row.environment,
            seq: row.seq,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }
    await this.resetAlarm();
  }

  /**
   * Close out approvals nobody answered.
   *
   * Expiry was only ever checked when a click arrived, so a card nobody
   * touched stayed pending and clickable indefinitely. This settles it and
   * rewrites the card, so the thread stops offering a decision that is no
   * longer on the table.
   */
  private async expireApprovals(nowIso: string): Promise<void> {
    const expired = this.ctx.storage.sql
      .exec<ApprovalRow>(
        `SELECT * FROM approvals
         WHERE status = 'pending' AND expires_at <= ?
         ORDER BY expires_at LIMIT 50`,
        nowIso,
      )
      .toArray()
      .map(approvalFromRow);
    for (const approval of expired) {
      this.ctx.storage.sql.exec(
        `UPDATE approvals SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        nowIso,
        approval.id,
      );
      await this.rewriteApprovalCard(approval, "failed");
    }

    // A write that never answered. This is the one case where saying "failed"
    // would be a lie we cannot back up: the write may well have landed and
    // simply not reported. So the record says we do not know, and the card
    // tells the reader to check before doing it again.
    const stuck = this.ctx.storage.sql
      .exec<ApprovalRow>(
        `SELECT * FROM approvals
         WHERE status = 'applying' AND applying_at <= ?
         ORDER BY applying_at LIMIT 50`,
        new Date(Date.parse(nowIso) - APPLY_GRACE_MS).toISOString(),
      )
      .toArray()
      .map(approvalFromRow);
    for (const approval of stuck) {
      this.ctx.storage.sql.exec(
        `UPDATE approvals
         SET status = 'unknown', error = ?, updated_at = ?
         WHERE id = ? AND status = 'applying'`,
        "The write did not report back; it may or may not have happened",
        nowIso,
        approval.id,
      );
      await this.rewriteApprovalCard(approval, "unknown", approval.decidedBy);
      await this.notifyApprovalOutcome(
        approval,
        "approved it, but we could not confirm the change went through",
      );
    }
  }

  async putManagedSecret(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    name: string;
    value: string;
    allowedOrigins: string[];
  }): Promise<ManagedSecretMetadata> {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    if (
      input.agentId &&
      input.agentId !== project.agentId &&
      !input.agentId.startsWith(`${project.agentId}--`)
    ) {
      throw new Error("Agent does not belong to this project");
    }
    const encrypted = await this.encryptSecret(input.value);
    const timestamp = new Date().toISOString();
    const agentId = input.agentId ?? "";
    this.ctx.storage.sql.exec(
      `INSERT INTO managed_secrets (
         project_id, environment, agent_id, name, allowed_origins_json,
         ciphertext, iv, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, environment, agent_id, name) DO UPDATE SET
         allowed_origins_json = excluded.allowed_origins_json,
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         updated_at = excluded.updated_at`,
      input.projectId,
      input.environment,
      agentId,
      input.name,
      JSON.stringify(input.allowedOrigins),
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    const row = this.managedSecretRow(
      input.projectId,
      input.environment,
      agentId,
      input.name,
    );
    if (!row) throw new Error("Secret was not stored");
    return managedSecretFromRow(row);
  }

  listManagedSecrets(
    projectId: string,
    environment?: ProjectEnvironmentName,
    agentId?: string,
  ): ManagedSecretMetadata[] {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    return this.ctx.storage.sql
      .exec<ManagedSecretRow>(
        `SELECT project_id, environment, agent_id, name, allowed_origins_json,
                ciphertext, iv, created_at, updated_at
         FROM managed_secrets
         WHERE project_id = ?
           AND (? IS NULL OR environment = ?)
           AND (? IS NULL OR agent_id = ?)
         ORDER BY environment, agent_id, name`,
        projectId,
        environment ?? null,
        environment ?? null,
        agentId ?? null,
        agentId ?? null,
      )
      .toArray()
      .map(managedSecretFromRow);
  }

  deleteManagedSecret(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    name: string;
  }): boolean {
    const existing = this.managedSecretRow(
      input.projectId,
      input.environment,
      input.agentId ?? "",
      input.name,
    );
    if (!existing) return false;
    this.ctx.storage.sql.exec(
      `DELETE FROM managed_secrets
       WHERE project_id = ? AND environment = ? AND agent_id = ? AND name = ?`,
      input.projectId,
      input.environment,
      input.agentId ?? "",
      input.name,
    );
    return true;
  }

  /**
   * Secrets belonging to one channel installation.
   *
   * A project secret is one value for the whole deployment, which is right for
   * a credential the operator owns. It is wrong for a credential that belongs
   * to the customer whose workspace the message came from: one deployment
   * answering many workspaces would reach every customer's account with the
   * same key. These are keyed by the installation instead, so the credential
   * follows the tenant.
   */
  async putInstallationSecret(input: {
    connectionId: string;
    name: string;
    value: string;
    allowedOrigins: string[];
  }): Promise<InstallationSecretMetadata> {
    const connection = this.getChannelConnection(input.connectionId);
    if (!connection) throw new Error("Installation not found");
    const encrypted = await this.encryptSecret(input.value);
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO installation_secrets (
         connection_id, name, allowed_origins_json, ciphertext, iv,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, name) DO UPDATE SET
         allowed_origins_json = excluded.allowed_origins_json,
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         updated_at = excluded.updated_at`,
      input.connectionId,
      input.name,
      JSON.stringify(input.allowedOrigins),
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    const stored = this.listInstallationSecrets(input.connectionId).find(
      (secret) => secret.name === input.name,
    );
    if (!stored) throw new Error("Secret was not stored");
    return stored;
  }

  /** Names and origins only. A stored value is never readable back out. */
  listInstallationSecrets(connectionId: string): InstallationSecretMetadata[] {
    return this.ctx.storage.sql
      .exec<{
        name: string;
        allowed_origins_json: string;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT name, allowed_origins_json, created_at, updated_at
         FROM installation_secrets WHERE connection_id = ?
         ORDER BY name`,
        connectionId,
      )
      .toArray()
      .map((row) => ({
        name: row.name,
        allowedOrigins: JSON.parse(row.allowed_origins_json) as string[],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  deleteInstallationSecret(connectionId: string, name: string): boolean {
    const before = this.listInstallationSecrets(connectionId).length;
    this.ctx.storage.sql.exec(
      `DELETE FROM installation_secrets WHERE connection_id = ? AND name = ?`,
      connectionId,
      name,
    );
    return this.listInstallationSecrets(connectionId).length < before;
  }

  /**
   * Credentials belonging to one person on one installation.
   *
   * An installation credential says what the workspace may do. This says what
   * a particular person may do, so the upstream applies its own permissions to
   * them — the agent stops being a single account that everyone shares.
   */
  async putUserSecret(input: {
    connectionId: string;
    externalUserId: string;
    name: string;
    value: string;
    allowedOrigins: string[];
  }): Promise<UserSecretMetadata> {
    const connection = this.getChannelConnection(input.connectionId);
    if (!connection) throw new Error("Installation not found");
    const encrypted = await this.encryptSecret(input.value);
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO user_secrets (
         connection_id, external_user_id, name, allowed_origins_json,
         ciphertext, iv, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, external_user_id, name) DO UPDATE SET
         allowed_origins_json = excluded.allowed_origins_json,
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         updated_at = excluded.updated_at`,
      input.connectionId,
      input.externalUserId,
      input.name,
      JSON.stringify(input.allowedOrigins),
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    const stored = this.listUserSecrets(input.connectionId).find(
      (secret) =>
        secret.externalUserId === input.externalUserId &&
        secret.name === input.name,
    );
    if (!stored) throw new Error("Secret was not stored");
    return stored;
  }

  /** Names and owners only, never values. */
  listUserSecrets(
    connectionId: string,
    externalUserId?: string,
  ): UserSecretMetadata[] {
    const rows = externalUserId
      ? this.ctx.storage.sql.exec<{
          external_user_id: string;
          name: string;
          allowed_origins_json: string;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT external_user_id, name, allowed_origins_json, created_at, updated_at
           FROM user_secrets WHERE connection_id = ? AND external_user_id = ?
           ORDER BY name`,
          connectionId,
          externalUserId,
        )
      : this.ctx.storage.sql.exec<{
          external_user_id: string;
          name: string;
          allowed_origins_json: string;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT external_user_id, name, allowed_origins_json, created_at, updated_at
           FROM user_secrets WHERE connection_id = ?
           ORDER BY external_user_id, name`,
          connectionId,
        );
    return rows.toArray().map((row) => ({
      externalUserId: row.external_user_id,
      name: row.name,
      allowedOrigins: JSON.parse(row.allowed_origins_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteUserSecret(
    connectionId: string,
    externalUserId: string,
    name: string,
  ): boolean {
    const before = this.listUserSecrets(connectionId, externalUserId).length;
    this.ctx.storage.sql.exec(
      `DELETE FROM user_secrets
       WHERE connection_id = ? AND external_user_id = ? AND name = ?`,
      connectionId,
      externalUserId,
      name,
    );
    return this.listUserSecrets(connectionId, externalUserId).length < before;
  }

  async resolveUserSecret(input: {
    connectionId: string;
    externalUserId: string;
    name: string;
    origin: string;
  }): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<{ allowed_origins_json: string; ciphertext: string; iv: string }>(
        `SELECT allowed_origins_json, ciphertext, iv
         FROM user_secrets
         WHERE connection_id = ? AND external_user_id = ? AND name = ?`,
        input.connectionId,
        input.externalUserId,
        input.name,
      )
      .toArray()[0];
    if (!row) return null;
    const allowedOrigins = JSON.parse(row.allowed_origins_json) as string[];
    if (
      !allowedOrigins.includes("*") &&
      !allowedOrigins.includes(input.origin)
    ) {
      return null;
    }
    return this.decryptSecret(row.ciphertext, row.iv);
  }

  /**
   * Resolve one for egress. Returns null when the installation has no such
   * secret, or when it is not allowed to reach this origin — callers treat
   * both as a refusal rather than substituting anything else.
   */
  async resolveInstallationSecret(input: {
    connectionId: string;
    name: string;
    origin: string;
  }): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<{ allowed_origins_json: string; ciphertext: string; iv: string }>(
        `SELECT allowed_origins_json, ciphertext, iv
         FROM installation_secrets WHERE connection_id = ? AND name = ?`,
        input.connectionId,
        input.name,
      )
      .toArray()[0];
    if (!row) return null;
    const allowedOrigins = JSON.parse(row.allowed_origins_json) as string[];
    if (
      !allowedOrigins.includes("*") &&
      !allowedOrigins.includes(input.origin)
    ) {
      return null;
    }
    return this.decryptSecret(row.ciphertext, row.iv);
  }

  async resolveManagedSecret(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId: string;
    name: string;
    origin: string;
  }): Promise<string | null> {
    const agent = this.managedSecretRow(
      input.projectId,
      input.environment,
      input.agentId,
      input.name,
    );
    const project = this.managedSecretRow(
      input.projectId,
      input.environment,
      "",
      input.name,
    );
    const row = agent ?? project;
    if (!row) return null;
    const allowedOrigins = JSON.parse(row.allowed_origins_json) as string[];
    if (!allowedOrigins.includes("*") && !allowedOrigins.includes(input.origin)) {
      return null;
    }
    return this.decryptSecret(row.ciphertext, row.iv);
  }

  private managedSecretRow(
    projectId: string,
    environment: ProjectEnvironmentName,
    agentId: string,
    name: string,
  ): ManagedSecretRow | null {
    return (
      this.ctx.storage.sql
        .exec<ManagedSecretRow>(
          `SELECT project_id, environment, agent_id, name,
                  allowed_origins_json, ciphertext, iv, created_at, updated_at
           FROM managed_secrets
           WHERE project_id = ? AND environment = ? AND agent_id = ? AND name = ?`,
          projectId,
          environment,
          agentId,
          name,
        )
        .toArray()[0] ?? null
    );
  }

  async putAgentRuntimeVariable(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    name: string;
    value: string;
  }): Promise<AgentRuntimeVariableMetadata> {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    if (
      input.agentId &&
      input.agentId !== project.agentId &&
      !input.agentId.startsWith(`${project.agentId}--`)
    ) {
      throw new Error("Agent does not belong to this project");
    }
    const encrypted = await this.encryptSecret(input.value);
    const timestamp = new Date().toISOString();
    const agentId = input.agentId ?? "";
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_runtime_variables (
         project_id, environment, agent_id, name, ciphertext, iv,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, environment, agent_id, name) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         updated_at = excluded.updated_at`,
      input.projectId,
      input.environment,
      agentId,
      input.name,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    const row = this.agentRuntimeVariableRow(
      input.projectId,
      input.environment,
      agentId,
      input.name,
    );
    if (!row) throw new Error("Runtime variable was not stored");
    return runtimeVariableFromRow(row);
  }

  listAgentRuntimeVariables(
    projectId: string,
    environment?: ProjectEnvironmentName,
    agentId?: string,
  ): AgentRuntimeVariableMetadata[] {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    return this.ctx.storage.sql
      .exec<AgentRuntimeVariableRow>(
        `SELECT project_id, environment, agent_id, name, ciphertext, iv,
                created_at, updated_at
         FROM agent_runtime_variables
         WHERE project_id = ?
           AND (? IS NULL OR environment = ?)
           AND (? IS NULL OR agent_id = ?)
         ORDER BY environment, agent_id, name`,
        projectId,
        environment ?? null,
        environment ?? null,
        agentId ?? null,
        agentId ?? null,
      )
      .toArray()
      .map(runtimeVariableFromRow);
  }

  deleteAgentRuntimeVariable(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    name: string;
  }): boolean {
    const agentId = input.agentId ?? "";
    const existing = this.agentRuntimeVariableRow(
      input.projectId,
      input.environment,
      agentId,
      input.name,
    );
    if (!existing) return false;
    this.ctx.storage.sql.exec(
      `DELETE FROM agent_runtime_variables
       WHERE project_id = ? AND environment = ? AND agent_id = ? AND name = ?`,
      input.projectId,
      input.environment,
      agentId,
      input.name,
    );
    return true;
  }

  async resolveAgentRuntimeVariables(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId: string;
  }): Promise<Record<string, string>> {
    const rows = this.ctx.storage.sql
      .exec<AgentRuntimeVariableRow>(
        `SELECT project_id, environment, agent_id, name, ciphertext, iv,
                created_at, updated_at
         FROM agent_runtime_variables
         WHERE project_id = ? AND environment = ? AND (agent_id = '' OR agent_id = ?)
         ORDER BY CASE WHEN agent_id = '' THEN 0 ELSE 1 END, name`,
        input.projectId,
        input.environment,
        input.agentId,
      )
      .toArray();
    const variables: Record<string, string> = {};
    for (const row of rows) {
      variables[row.name] = await this.decryptSecret(row.ciphertext, row.iv);
    }
    return variables;
  }

  private agentRuntimeVariableRow(
    projectId: string,
    environment: ProjectEnvironmentName,
    agentId: string,
    name: string,
  ): AgentRuntimeVariableRow | null {
    return (
      this.ctx.storage.sql
        .exec<AgentRuntimeVariableRow>(
          `SELECT project_id, environment, agent_id, name, ciphertext, iv,
                  created_at, updated_at
           FROM agent_runtime_variables
           WHERE project_id = ? AND environment = ? AND agent_id = ? AND name = ?`,
          projectId,
          environment,
          agentId,
          name,
        )
        .toArray()[0] ?? null
    );
  }

  // Event subscriptions (work 025, session destinations). Project-scoped,
  // immutable once created: the only edit is deletion, which stops every
  // pending delivery for it visibly.

  createEventSubscription(input: {
    id: string;
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    sourceLabels?: SessionLabels;
    events: OutcomeEventType[];
    destination: OutcomeDestination;
    createdBy: string;
  }): EventSubscription {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    if (
      input.agentId !== undefined &&
      input.agentId !== project.agentId &&
      !input.agentId.startsWith(`${project.agentId}--`)
    ) {
      throw new Error("Agent does not belong to this project");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO event_subscriptions (
         id, project_id, environment, agent_id, source_labels_json, events_json,
         destination_json, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.projectId,
      input.environment,
      input.agentId ?? null,
      input.sourceLabels ? JSON.stringify(input.sourceLabels) : null,
      JSON.stringify(input.events),
      JSON.stringify(input.destination),
      input.createdBy,
      new Date().toISOString(),
    );
    const created = this.getEventSubscription(input.id);
    if (!created) throw new Error("Event subscription was not stored");
    return created;
  }

  getEventSubscription(id: string): EventSubscription | null {
    const row = this.ctx.storage.sql
      .exec<EventSubscriptionRow>("SELECT * FROM event_subscriptions WHERE id = ?", id)
      .toArray()[0];
    return row ? eventSubscriptionFromRow(row) : null;
  }

  listEventSubscriptions(projectId: string): EventSubscription[] {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    return this.ctx.storage.sql
      .exec<EventSubscriptionRow>(
        "SELECT * FROM event_subscriptions WHERE project_id = ? ORDER BY created_at, rowid",
        projectId,
      )
      .toArray()
      .map(eventSubscriptionFromRow);
  }

  deleteEventSubscription(id: string, projectId: string): boolean {
    return (
      this.ctx.storage.sql.exec(
        "DELETE FROM event_subscriptions WHERE id = ? AND project_id = ?",
        id,
        projectId,
      ).rowsWritten > 0
    );
  }

  /**
   * The subscriptions a turn admitted on `agentId` in `environment` is
   * captured with. Resolved through the agent's project so the source
   * session needs no project of its own; an agent outside every project
   * matches nothing, and a subscription never crosses environments. A
   * subscription with `sourceLabels` matches only when `labels` (the
   * source session's, as the caller read them at admission) carries every
   * pair.
   */
  matchEventSubscriptions(
    agentId: string,
    environment: ProjectEnvironmentName,
    labels: SessionLabels = {},
  ): EventSubscription[] {
    const project = this.projectForAgent(agentId);
    if (!project) return [];
    return this.ctx.storage.sql
      .exec<EventSubscriptionRow>(
        `SELECT * FROM event_subscriptions
         WHERE project_id = ? AND environment = ? AND (agent_id IS NULL OR agent_id = ?)
         ORDER BY created_at, rowid`,
        project.id,
        environment,
        agentId,
      )
      .toArray()
      .map(eventSubscriptionFromRow)
      .filter(
        (subscription) =>
          !subscription.sourceLabels || labelsMatch(labels, subscription.sourceLabels),
      );
  }

  createProjectWebhook(input: {
    id: string;
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId: string;
    name: string;
    tokenHash: string;
    token: string;
    createdBy: string;
    identity?: string;
  }): CreatedProjectWebhook {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    if (
      input.agentId !== project.agentId &&
      !input.agentId.startsWith(`${project.agentId}--`)
    ) {
      throw new Error("Agent does not belong to this project");
    }
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO project_webhooks (
         id, project_id, environment, agent_id, name, token_hash, enabled,
         created_by, created_at, updated_at, identity
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      input.id,
      input.projectId,
      input.environment,
      input.agentId,
      input.name,
      input.tokenHash,
      input.createdBy,
      timestamp,
      timestamp,
      input.identity ?? null,
    );
    const webhook = this.getProjectWebhook(input.id);
    if (!webhook) throw new Error("Webhook was not stored");
    return { ...webhook, token: input.token };
  }

  getProjectWebhook(id: string): ProjectWebhook | null {
    const row = this.projectWebhookRow(id);
    return row ? projectWebhookFromRow(row) : null;
  }

  listProjectWebhooks(input: {
    projectId: string;
    environment?: ProjectEnvironmentName;
    agentId?: string;
  }): ProjectWebhook[] {
    if (!this.getProject(input.projectId)) throw new Error("Project not found");
    return this.ctx.storage.sql
      .exec<ProjectWebhookRow>(
        `SELECT * FROM project_webhooks
         WHERE project_id = ?
           AND (? IS NULL OR environment = ?)
           AND (? IS NULL OR agent_id = ?)
         ORDER BY created_at DESC`,
        input.projectId,
        input.environment ?? null,
        input.environment ?? null,
        input.agentId ?? null,
        input.agentId ?? null,
      )
      .toArray()
      .map(projectWebhookFromRow);
  }

  updateProjectWebhook(input: {
    id: string;
    projectId: string;
    name?: string;
    enabled?: boolean;
    /** A source string sets it; null clears it; undefined leaves it. */
    identity?: string | null;
  }): ProjectWebhook | null {
    const row = this.projectWebhookRow(input.id);
    if (!row || row.project_id !== input.projectId) return null;
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE project_webhooks
       SET name = COALESCE(?, name), enabled = COALESCE(?, enabled),
           identity = CASE WHEN ? THEN ? ELSE identity END, updated_at = ?
       WHERE id = ? AND project_id = ?`,
      input.name ?? null,
      input.enabled === undefined ? null : input.enabled ? 1 : 0,
      input.identity === undefined ? 0 : 1,
      input.identity ?? null,
      timestamp,
      input.id,
      input.projectId,
    );
    return this.getProjectWebhook(input.id);
  }

  rotateProjectWebhookToken(input: {
    id: string;
    projectId: string;
    tokenHash: string;
  }): ProjectWebhook | null {
    const row = this.projectWebhookRow(input.id);
    if (!row || row.project_id !== input.projectId) return null;
    this.ctx.storage.sql.exec(
      `UPDATE project_webhooks SET token_hash = ?, updated_at = ?
       WHERE id = ? AND project_id = ?`,
      input.tokenHash,
      new Date().toISOString(),
      input.id,
      input.projectId,
    );
    return this.getProjectWebhook(input.id);
  }

  deleteProjectWebhook(id: string, projectId: string): boolean {
    const row = this.projectWebhookRow(id);
    if (!row || row.project_id !== projectId) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM project_webhook_requests WHERE webhook_id = ?",
        id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM project_webhooks WHERE id = ? AND project_id = ?",
        id,
        projectId,
      );
    });
    return true;
  }

  /**
   * Record a delivery and arm its enactment. Returns before any session or
   * runtime work. A same-key retry of a `failed` request re-arms it; of a
   * `pending` or `accepted` one, echoes it. A different body under the same
   * key is a conflict.
   */
  async claimProjectWebhookRequest(input: {
    id: string;
    webhookId: string;
    payloadHash: string;
    idempotencyKey?: string;
    /** Identity derived from the provider's notification: a body-hash mismatch is not a conflict. */
    identityDerived?: boolean;
    input: { text?: string; payload?: StructuredAgentInput["payload"] };
    deploymentId: string;
    edgeOrigin: string;
    userId: string;
    accountId: string;
  }): Promise<{
    request: ProjectWebhookRequest;
    duplicate: boolean;
    conflict: boolean;
    rearmed: boolean;
    bodyMismatch: boolean;
  }> {
    const webhook = this.projectWebhookRow(input.webhookId);
    if (!webhook || webhook.enabled !== 1) throw new Error("Webhook unavailable");
    const timestamp = new Date().toISOString();
    if (input.idempotencyKey) {
      const existing = this.ctx.storage.sql
        .exec<ProjectWebhookRequestRow>(
          `SELECT * FROM project_webhook_requests
           WHERE webhook_id = ? AND idempotency_key = ? LIMIT 1`,
          input.webhookId,
          input.idempotencyKey,
        )
        .toArray()[0];
      if (existing) {
        const bodyMismatch = existing.payload_hash !== input.payloadHash;
        const conflict = bodyMismatch && !input.identityDerived;
        // A terminal failure is echoed: nothing about the stored request can
        // change, so re-arming it would only fail again on the same session.
        const rearmed =
          !conflict &&
          existing.outcome === "failed" &&
          existing.input_json !== null &&
          !existing.terminal;
        if (rearmed) {
          this.ctx.storage.sql.exec(
            `UPDATE project_webhook_requests
             SET outcome = 'pending', next_attempt_at = ?, error = NULL, updated_at = ?
             WHERE id = ?`,
            timestamp,
            timestamp,
            existing.id,
          );
          await this.resetAlarm();
        }
        return {
          request: projectWebhookRequestFromRow(
            this.projectWebhookRequestRow(existing.id) ?? existing,
          ),
          duplicate: true,
          conflict,
          rearmed,
          bodyMismatch,
        };
      }
    }
    const sessionId = await derivedSessionId(
      input.accountId,
      webhookRequestSessionKey(input.id, 0),
    );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO project_webhook_requests (
           id, webhook_id, project_id, environment, agent_id, deployment_id, session_id,
           idempotency_key, payload_hash, outcome, created_at, updated_at,
           input_json, attempt, next_attempt_at, edge_origin, user_id, account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?, ?)`,
        input.id,
        webhook.id,
        webhook.project_id,
        webhook.environment,
        webhook.agent_id,
        input.deploymentId,
        sessionId,
        input.idempotencyKey ?? null,
        input.payloadHash,
        timestamp,
        timestamp,
        JSON.stringify(input.input),
        timestamp,
        input.edgeOrigin,
        input.userId,
        input.accountId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE project_webhooks SET last_invoked_at = ?, updated_at = ? WHERE id = ?",
        timestamp,
        timestamp,
        webhook.id,
      );
    });
    await this.resetAlarm();
    const request = this.projectWebhookRequestRow(input.id);
    if (!request) throw new Error("Webhook request was not stored");
    return {
      request: projectWebhookRequestFromRow(request),
      duplicate: false,
      conflict: false,
      rearmed: false,
      bodyMismatch: false,
    };
  }

  // ── Linear ingress (work 037 S2; src/edge/linear-ingress.ts) ─────────────────

  private linearIngressInstance?: LinearIngress;

  /**
   * Durable acceptance of one Linear webhook delivery: verify with the
   * connection's signing secret, write the ledger row idempotently on
   * `Linear-Delivery`, arm the alarm. The route answers Linear with this.
   */
  async receiveLinearWebhook(delivery: LinearWebhookDelivery): Promise<LinearAcceptResult> {
    return this.linearIngress().accept(delivery);
  }

  private linearIngress(): LinearIngress {
    const env = this.env as ScheduleRuntimeEnv;
    this.linearIngressInstance ??= new LinearIngress({
      storage: this.ctx.storage,
      connections: () => this.linearConnections,
      session: (sessionId, connection) => {
        const region = connection
          ? this.resolveDeployment(`${connection.agentId}@${connection.environment}`)
              ?.region
          : undefined;
        const session = env.SESSIONS.getByName(sessionId, regionPlacement(region));
        return {
          findTurn: async (key) => session.findTurn(key),
          state: async () => {
            const snapshot = await session.snapshotOrNull();
            if (!snapshot) return null;
            return {
              status: snapshot.status,
              ready:
                snapshot.executionMode === "workerd" ||
                Boolean(snapshot.microvmId) ||
                !env.RUNTIMES,
              admitted: snapshot.turns.length > 0,
            };
          },
          enqueueTurn: async (input) => session.enqueueTurn(input),
          end: async () => {
            await session.end();
          },
          applyControl: async (input) => session.applyControl(input),
          linearQueueDrained: async () => session.linearQueueDrained(),
          enqueueLinearTerminal: async (input) => session.enqueueLinearTerminal(input),
        };
      },
      launch: (input) => this.launchLinearSession(input),
      deriveSessionId: derivedSessionId,
      resetAlarm: () => this.resetAlarm(),
    });
    return this.linearIngressInstance;
  }

  /** A session owned by the connection principal, on the bound agent's deployment. */
  private async launchLinearSession(input: LinearLaunchInput): Promise<void> {
    const { connection } = input;
    const project = this.getProject(connection.projectId);
    if (!project || project.archivedAt) {
      throw new Error("The Linear connection's project is unavailable");
    }
    const deployment = this.resolveDeployment(
      `${connection.agentId}@${connection.environment}`,
    );
    if (!deployment) {
      throw new Error(
        `The Linear connection's agent is not deployed in ${connection.environment}`,
      );
    }
    await this.launchSession({
      sessionId: input.sessionId,
      accountId: input.accountId,
      userId: linearConnectionPrincipal(connection.id),
      projectId: connection.projectId,
      agentId: connection.agentId,
      environment: connection.environment,
      deployment,
      edgeOrigin: input.edgeOrigin,
      source: "channel",
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      agentInput: input.agentInput,
      providerTime: input.providerTime,
    });
  }

  completeProjectWebhookRequest(input: {
    id: string;
    deploymentId: string;
    sessionId: string;
  }): ProjectWebhookRequest {
    this.ctx.storage.sql.exec(
      `UPDATE project_webhook_requests
       SET deployment_id = ?, session_id = ?, outcome = 'accepted', updated_at = ?
       WHERE id = ?`,
      input.deploymentId,
      input.sessionId,
      new Date().toISOString(),
      input.id,
    );
    const row = this.projectWebhookRequestRow(input.id);
    if (!row) throw new Error("Webhook request not found");
    return projectWebhookRequestFromRow(row);
  }

  failProjectWebhookRequest(id: string, error: string): ProjectWebhookRequest {
    this.ctx.storage.sql.exec(
      `UPDATE project_webhook_requests
       SET outcome = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      error.slice(0, 1_000),
      new Date().toISOString(),
      id,
    );
    const row = this.projectWebhookRequestRow(id);
    if (!row) throw new Error("Webhook request not found");
    return projectWebhookRequestFromRow(row);
  }

  listProjectWebhookRequests(input: {
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    webhookId?: string;
    limit?: number;
  }): ProjectWebhookRequest[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return this.ctx.storage.sql
      .exec<ProjectWebhookRequestRow>(
        `SELECT * FROM project_webhook_requests
         WHERE project_id = ? AND environment = ?
           AND (? IS NULL OR agent_id = ?)
           AND (? IS NULL OR webhook_id = ?)
         ORDER BY created_at DESC LIMIT ?`,
        input.projectId,
        input.environment,
        input.agentId ?? null,
        input.agentId ?? null,
        input.webhookId ?? null,
        input.webhookId ?? null,
        limit,
      )
      .toArray()
      .map(projectWebhookRequestFromRow);
  }

  async setWebhookRoute(route: WebhookRoute): Promise<void> {
    await this.ctx.storage.put("webhookRoute", route);
  }

  async getWebhookRoute(): Promise<WebhookRoute | null> {
    return (await this.ctx.storage.get<WebhookRoute>("webhookRoute")) ?? null;
  }

  async clearWebhookRoute(webhookId: string): Promise<void> {
    const route = await this.getWebhookRoute();
    if (route?.webhookId === webhookId) {
      await this.ctx.storage.delete("webhookRoute");
    }
  }

  private projectWebhookRow(id: string): ProjectWebhookRow | null {
    return (
      this.ctx.storage.sql
        .exec<ProjectWebhookRow>("SELECT * FROM project_webhooks WHERE id = ?", id)
        .toArray()[0] ?? null
    );
  }

  private projectWebhookRequestRow(id: string): ProjectWebhookRequestRow | null {
    return (
      this.ctx.storage.sql
        .exec<ProjectWebhookRequestRow>(
          "SELECT * FROM project_webhook_requests WHERE id = ?",
          id,
        )
        .toArray()[0] ?? null
    );
  }

  appendAgentLog(
    input: Omit<AgentLogEntry, "id" | "cursor">,
  ): AgentLogEntry {
    const id = crypto.randomUUID();
    const row = this.ctx.storage.sql.exec<{ seq: number }>(
      `INSERT INTO agent_logs (
         id, timestamp, level, event, project_id, environment,
         agent_id, deployment_id, session_id, data_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING seq`,
      id,
      input.timestamp,
      input.level,
      input.event,
      input.projectId,
      input.environment,
      input.agentId,
      input.deploymentId,
      input.sessionId,
      JSON.stringify(input.data),
    ).toArray()[0];
    if (!row) throw new Error("Agent log was not stored");
    const cursor = String(row.seq).padStart(16, "0");
    return { id, cursor, ...input };
  }

  listAgentLogs(input: {
    projectId?: string;
    environment?: ProjectEnvironmentName;
    agentId?: string;
    sessionId?: string;
    after?: string;
    limit?: number;
  }): AgentLogEntry[] {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
    const after = Number.parseInt(input.after ?? "0", 10) || 0;
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        seq: number;
        timestamp: string;
        level: string;
        event: string;
        project_id: string;
        environment: string;
        agent_id: string;
        deployment_id: string;
        session_id: string;
        data_json: string;
      }>(
        `SELECT seq, id, timestamp, level, event, project_id, environment,
                agent_id, deployment_id, session_id, data_json
         FROM agent_logs
         WHERE seq > ?
           AND (? IS NULL OR project_id = ?)
           AND (? IS NULL OR environment = ?)
           AND (? IS NULL OR agent_id = ?)
           AND (? IS NULL OR session_id = ?)
         ORDER BY
           CASE WHEN ? = 0 THEN seq END DESC,
           CASE WHEN ? <> 0 THEN seq END ASC
         LIMIT ?`,
        after,
        input.projectId ?? null,
        input.projectId ?? null,
        input.environment ?? null,
        input.environment ?? null,
        input.agentId ?? null,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.sessionId ?? null,
        after,
        after,
        limit,
      )
      .toArray();
    if (after === 0) rows.reverse();
    return rows.map((row) => ({
        id: row.id,
        cursor: String(row.seq).padStart(16, "0"),
        timestamp: row.timestamp,
        level: row.level === "error" ? "error" : row.level === "warn" ? "warn" : "info",
        event: row.event,
        projectId: row.project_id,
        environment: row.environment as ProjectEnvironmentName,
        agentId: row.agent_id,
        deploymentId: row.deployment_id,
        sessionId: row.session_id,
        data: JSON.parse(row.data_json) as Record<string, unknown>,
    }));
  }

  // Session projection (design C1, "Projection protocol").
  //
  // Rows are served from here, never by fanning out to Session objects. A
  // Session object publishes `{ sessionId, revision, row }` after each listed
  // mutation; a row is kept only when its revision is newer than the one
  // held, so delayed and duplicated deliveries cannot regress it. A session's
  // first publication also records its creation in the shared D1 ledger, as
  // the old index did. Reconciliation probes live sessions whose publication
  // may have been lost; it runs from the alarm, apart from any list read.

  private sessionFromRow(row: SessionProjectionRow): SessionSummary {
    let activity: SessionActivity = EMPTY_ACTIVITY;
    try {
      const parsed: unknown = JSON.parse(row.activity_json);
      if (parsed && typeof parsed === "object") activity = parsed as SessionActivity;
    } catch {
      activity = EMPTY_ACTIVITY;
    }
    let result: SessionResult | null = null;
    if (row.result_json) {
      try {
        result = JSON.parse(row.result_json) as SessionResult;
      } catch {
        result = null;
      }
    }
    return {
      id: row.id,
      projectId: row.project_id ?? `project:${row.agent_id}`,
      agentId: row.agent_id,
      deploymentId: row.deployment_id,
      environment: isProjectEnvironmentName(row.environment)
        ? row.environment
        : null,
      source: row.source as SessionSource,
      status: row.status as SessionSummary["status"],
      labels: readLabels(row.labels_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: Number(row.revision),
      activity,
      result,
    };
  }

  private sessionRow(id: string): SessionProjectionRow | undefined {
    return this.ctx.storage.sql
      .exec<SessionProjectionRow>(
        `SELECT id, project_id, agent_id, deployment_id, environment, source, status,
                labels_json, created_at, updated_at, revision, activity_json, result_json
         FROM sessions
         WHERE id = ?
         LIMIT 1`,
        id,
      )
      .toArray()[0];
  }

  /**
   * Takes a Session object's publication when it is newer than the row
   * held. Answers the revision now held either way, so the publisher can
   * treat "already held" as acknowledged. Every accepted revision also
   * upserts the D1 analytics projection before the row is written: if that
   * write fails the publication fails and the Session object retries.
   */
  async acceptSessionPublication(
    publication: SessionPublication,
  ): Promise<{ accepted: boolean; revision: number }> {
    const { row } = publication;
    if (
      !Number.isInteger(publication.revision) ||
      publication.revision < 1 ||
      row.id !== publication.sessionId ||
      row.revision !== publication.revision
    ) {
      throw new Error("Session publication is malformed");
    }
    const existing = this.sessionRow(row.id);
    if (existing && Number(existing.revision) >= publication.revision) {
      return { accepted: false, revision: Number(existing.revision) };
    }
    const countability = publication.countability ?? {
      countable: true,
      exclusionReason: null,
      outcomeAt: null,
    };
    try {
      await this.env.SERVERLESS_AGENTS_DB.prepare(
        `INSERT INTO session_creations (
           session_id, account_id, source, created_at,
           countable, exclusion_reason, outcome_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           account_id = excluded.account_id,
           source = excluded.source,
           created_at = excluded.created_at,
           countable = excluded.countable,
           exclusion_reason = excluded.exclusion_reason,
           outcome_at = excluded.outcome_at`,
      )
        .bind(
          row.id,
          this.ctx.id.name ?? "",
          row.source,
          row.createdAt,
          countability.countable ? 1 : 0,
          countability.exclusionReason,
          countability.outcomeAt,
        )
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const legacySchema =
        message.includes("no column named countable") ||
        message.includes("no such column: countable");
      // Rolling and local-test compatibility only. A non-countable outcome
      // must never be acknowledged until its projection can preserve it.
      if (!legacySchema || !countability.countable) throw error;
      await this.env.SERVERLESS_AGENTS_DB.prepare(
        `INSERT INTO session_creations (session_id, account_id, source, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           account_id = excluded.account_id,
           source = excluded.source,
           created_at = excluded.created_at`,
      )
        .bind(row.id, this.ctx.id.name ?? "", row.source, row.createdAt)
        .run();
    }
    const written = this.ctx.storage.transactionSync(() => {
      // Re-read inside the transaction: the D1 await above yielded.
      const current = this.sessionRow(row.id);
      if (current && Number(current.revision) >= publication.revision) {
        return Number(current.revision);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (
           id, project_id, agent_id, deployment_id, environment, source, status,
           labels_json, created_at, updated_at, revision, activity_json, result_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           agent_id = excluded.agent_id,
           deployment_id = excluded.deployment_id,
           environment = excluded.environment,
           source = excluded.source,
           status = excluded.status,
           labels_json = excluded.labels_json,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           revision = excluded.revision,
           activity_json = excluded.activity_json,
           result_json = excluded.result_json`,
        row.id,
        row.projectId,
        row.agentId,
        row.deploymentId,
        row.environment,
        row.source,
        row.status,
        JSON.stringify(row.labels),
        row.createdAt,
        row.updatedAt,
        publication.revision,
        JSON.stringify(row.activity),
        row.result === null ? null : JSON.stringify(row.result),
      );
      return publication.revision;
    });
    if (written !== publication.revision) {
      return { accepted: false, revision: written };
    }
    if (row.status !== "ended") await this.armSessionReconcile();
    return { accepted: true, revision: publication.revision };
  }

  /** Rows in the immutable order, `createdAt` descending then `id`, one page at a time. */
  listSessionSummaries(query: SessionListQuery): {
    sessions: SessionSummary[];
    nextCursor: string | null;
  } {
    const conditions: string[] = [];
    const parameters: SqlStorageValue[] = [];
    if (query.project !== undefined) {
      conditions.push("project_id = ?");
      parameters.push(query.project);
    }
    if (query.environment !== undefined) {
      conditions.push("environment = ?");
      parameters.push(query.environment);
    }
    if (query.agent !== undefined) {
      conditions.push("agent_id = ?");
      parameters.push(query.agent);
    }
    if (query.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(query.status);
    }
    for (const label of query.labels) {
      // The key passed the label-key pattern (no quotes, no backslashes), so
      // it can name a JSON path; the value is bound.
      conditions.push(`json_extract(labels_json, '$."${label.key}"') = ?`);
      parameters.push(label.value);
    }
    if (query.cursor) {
      conditions.push("(created_at < ? OR (created_at = ? AND id > ?))");
      parameters.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id);
    }
    const rows = this.ctx.storage.sql
      .exec<SessionProjectionRow>(
        `SELECT id, project_id, agent_id, deployment_id, environment, source, status,
                labels_json, created_at, updated_at, revision, activity_json, result_json
         FROM sessions
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id ASC
         LIMIT ?`,
        ...parameters,
        query.limit + 1,
      )
      .toArray();
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      sessions: page.map((row) => this.sessionFromRow(row)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeSessionListCursor({ createdAt: last.created_at, id: last.id })
          : null,
    };
  }

  /**
   * Re-delivers publications that live sessions still owe. Probes non-ended
   * rows whose last publication is older than the threshold, each at most
   * once a day, in one bounded batch per run; a session whose object fails
   * is logged and skipped, never hiding the others. Runs from the alarm
   * while the account has live sessions, and on demand from the internal
   * reconcile route.
   */
  async reconcileSessionPublications(input: {
    olderThanMs?: number;
    limit?: number;
  }): Promise<{ scanned: number; pending: number; delivered: number; failed: number }> {
    const olderThanMs = input.olderThanMs ?? SESSION_PUBLICATION_STALE_MS;
    const limit = Math.max(1, Math.min(input.limit ?? SESSION_RECONCILE_BATCH, 500));
    const now = Date.now();
    const candidates = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM sessions
         WHERE status != 'ended'
           AND updated_at <= ?
           AND (reconciled_at IS NULL OR reconciled_at <= ?)
         ORDER BY reconciled_at, updated_at
         LIMIT ?`,
        new Date(now - olderThanMs).toISOString(),
        new Date(now - SESSION_RECONCILE_PROBE_INTERVAL_MS).toISOString(),
        limit,
      )
      .toArray();
    const outcome = { scanned: 0, pending: 0, delivered: 0, failed: 0 };
    for (const candidate of candidates) {
      outcome.scanned += 1;
      try {
        const probe = await this.env.SESSIONS.getByName(candidate.id).reconcilePublication(
          olderThanMs,
        );
        if (probe.pending) outcome.pending += 1;
        if (probe.delivered) outcome.delivered += 1;
      } catch (error) {
        outcome.failed += 1;
        console.error(
          JSON.stringify({
            level: "error",
            event: "session.publication_reconcile_failed",
            sessionId: candidate.id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET reconciled_at = ? WHERE id = ?",
        new Date().toISOString(),
        candidate.id,
      );
    }
    const liveRemain = this.ctx.storage.sql
      .exec<{ found: number }>(
        "SELECT 1 AS found FROM sessions WHERE status != 'ended' LIMIT 1",
      )
      .toArray()[0];
    if (liveRemain) {
      await this.ctx.storage.put(
        SESSION_RECONCILE_ALARM_KEY,
        Date.now() + SESSION_RECONCILE_INTERVAL_MS,
      );
    } else {
      await this.ctx.storage.delete(SESSION_RECONCILE_ALARM_KEY);
    }
    await this.resetAlarm();
    if (outcome.pending || outcome.failed) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "session.publication_reconciled",
          ...outcome,
        }),
      );
    }
    return outcome;
  }

  /** Arms the periodic reconciliation once; it re-arms itself while live sessions remain. */
  private async armSessionReconcile(): Promise<void> {
    const existing = await this.ctx.storage.get<number>(SESSION_RECONCILE_ALARM_KEY);
    if (typeof existing === "number") return;
    await this.ctx.storage.put(
      SESSION_RECONCILE_ALARM_KEY,
      Date.now() + SESSION_RECONCILE_INTERVAL_MS,
    );
    await this.resetAlarm();
  }

  async backfillSessionCreations(accountId: string): Promise<number> {
    const rows = this.ctx.storage.sql
      .exec<Pick<SessionProjectionRow, "id" | "source" | "created_at">>(
        "SELECT id, source, created_at FROM sessions ORDER BY created_at",
      )
      .toArray();
    for (let offset = 0; offset < rows.length; offset += 50) {
      await this.env.SERVERLESS_AGENTS_DB.batch(
        rows.slice(offset, offset + 50).map((row) =>
          this.env.SERVERLESS_AGENTS_DB.prepare(
            `INSERT INTO session_creations (session_id, account_id, source, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               account_id = excluded.account_id,
               source = excluded.source,
               created_at = excluded.created_at`,
          ).bind(row.id, accountId, row.source, row.created_at),
        ),
      );
    }
    return rows.length;
  }

  hasSession(id: string): boolean {
    return this.getSession(id) !== null;
  }

  getSession(id: string): SessionSummary | null {
    const row = this.sessionRow(id);
    return row ? this.sessionFromRow(row) : null;
  }

  /**
   * Create a pending Slack connection. Returns the connection and the
   * revision it was written at, from the same transaction, so a publisher
   * can carry exactly that revision to the route object.
   */
  createSlackConnection(input: {
    id: string;
    channelId?: string;
    agentId: string;
    alias: string;
    appName: string;
    webhookTokenHash?: string;
    routeMintedBy?: "manual" | "setup";
  }): { connection: SlackConnection; revision: number } {
    return this.ctx.storage.transactionSync(() => {
      this.insertSlackConnectionRows(input);
      const connection = this.getSlackConnection(input.id);
      if (!connection) throw new Error("Slack connection was not stored");
      return {
        connection,
        revision: this.channelConnectionFacts(input.id)?.revision ?? 0,
      };
    });
  }

  private insertSlackConnectionRows(input: {
    id: string;
    channelId?: string;
    agentId: string;
    alias: string;
    appName: string;
    webhookTokenHash?: string;
    routeMintedBy?: "manual" | "setup";
  }): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_connections (
         id, channel, agent_id, alias, external_channel_id,
         team_id, connected_account_id, trigger_id, app_name, webhook_token_hash,
         route_minted_by, status, created_at, updated_at
       ) VALUES (?, 'slack', ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 'pending', ?, ?)`,
      input.id,
      input.agentId,
      input.alias,
      input.channelId ?? "slack",
      "",
      input.appName,
      input.webhookTokenHash ?? null,
      input.routeMintedBy ?? null,
      timestamp,
      timestamp,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (
         id, kind, provider, label, owner_user_id, agent_id, alias, external_account_id,
         display_name, scopes_json, credential_ciphertext, credential_iv,
         oauth_state_hash, status, created_at, updated_at
       ) VALUES (?, 'channel', 'slack', 'slack', '', ?, ?, NULL, NULL, '[]',
                 NULL, NULL, NULL, 'pending', ?, ?)`,
      input.id,
      input.agentId,
      input.alias,
      timestamp,
      timestamp,
    );
  }

  /**
   * Twilio has no install flow to redirect through. The operator supplies an
   * account SID, an auth token, and one of their numbers, so the connection is
   * connected the moment it is created rather than pending an OAuth callback.
   *
   * The number is stored here, per connection, for the same reason Slack
   * conversation IDs are: development and production do not share one.
   */
  async createTwilioConnection(input: {
    id: string;
    channelId?: string;
    agentId: string;
    alias: string;
    accountSid: string;
    authToken: string;
    phoneNumber: string;
  }): Promise<void> {
    const timestamp = new Date().toISOString();
    const encrypted = await this.encryptSecret(
      JSON.stringify({
        accountSid: input.accountSid,
        authToken: input.authToken,
      }),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_connections (
         id, channel, agent_id, alias, external_channel_id,
         team_id, connected_account_id, trigger_id, app_name, status, created_at,
         updated_at
       ) VALUES (?, 'twilio', ?, ?, ?, NULL, ?, NULL, 'twilio', ?, ?, ?)`,
      input.id,
      input.agentId,
      input.alias,
      input.channelId ?? "twilio",
      input.phoneNumber,
      input.phoneNumber ? "connected" : "pending",
      timestamp,
      timestamp,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (
         id, kind, provider, label, owner_user_id, agent_id, alias, external_account_id,
         display_name, scopes_json, credential_ciphertext, credential_iv,
         oauth_state_hash, status, created_at, updated_at
       ) VALUES (?, 'channel', 'twilio', 'twilio', '', ?, ?, ?, ?, '[]',
                 ?, ?, NULL, ?, ?, ?)`,
      input.id,
      input.agentId,
      input.alias,
      input.accountSid,
      input.phoneNumber,
      encrypted.ciphertext,
      encrypted.iv,
      input.phoneNumber ? "connected" : "pending",
      timestamp,
      timestamp,
    );
  }

  /**
   * A channel connection in provider-neutral terms, for the ingress path that
   * only needs to know which agent and alias to route to.
   */
  getChannelConnection(id: string): {
    id: string;
    provider: string;
    agentId: string;
    alias: string;
    channelId: string;
    status: string;
    accountSid?: string;
    from?: string;
  } | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        channel: string;
        agent_id: string;
        alias: string;
        external_channel_id: string | null;
        connected_account_id: string | null;
        status: string;
      }>(
        `SELECT id, channel, agent_id, alias, external_channel_id,
                connected_account_id, status
         FROM channel_connections WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      provider: row.channel,
      agentId: row.agent_id,
      alias: row.alias,
      channelId: row.external_channel_id ?? row.channel,
      status: row.status,
      // For Twilio this column holds the number the connection owns, which is
      // what `matchesConnection` compares the delivery's `To` against. The
      // account SID lives in the encrypted credential, not here, so it is left
      // unset and that check is skipped rather than compared against a number.
      ...(row.connected_account_id ? { from: row.connected_account_id } : {}),
    };
  }

  /** Close a channel connection without deleting what it already handled. */
  disconnectChannelConnection(connectionId: string, provider: string): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET status = 'disconnected', revision = revision + 1, updated_at = ?
       WHERE id = ? AND channel = ?`,
      timestamp,
      connectionId,
      provider,
    );
    this.ctx.storage.sql.exec(
      `UPDATE connections SET status = 'disconnected', updated_at = ?
       WHERE id = ? AND provider = ?`,
      timestamp,
      connectionId,
      provider,
    );
  }

  /**
   * Bind the chosen number and open the connection for traffic. Until this
   * runs the connection has no number, so `matchesConnection` rejects every
   * delivery — a half-finished setup cannot half-work.
   */
  activateTwilioConnection(connectionId: string, phoneNumber: string): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET connected_account_id = ?, status = 'connected', updated_at = ?
       WHERE id = ? AND channel = 'twilio'`,
      phoneNumber,
      timestamp,
      connectionId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE connections
       SET display_name = ?, status = 'connected', updated_at = ?
       WHERE id = ? AND provider = 'twilio'`,
      phoneNumber,
      timestamp,
      connectionId,
    );
  }

  /**
   * The Twilio credential, for the one job that needs it outside an adapter:
   * downloading a recording, which Twilio serves from an authenticated URL.
   */
  async twilioCredential(
    connectionId: string,
  ): Promise<{ accountSid: string; authToken: string } | null> {
    const credential = this.connectionCredential(connectionId);
    if (!credential) return null;
    const parsed: unknown = JSON.parse(
      await this.decryptSecret(credential.ciphertext, credential.iv),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.accountSid === "string" &&
      typeof record.authToken === "string"
      ? { accountSid: record.accountSid, authToken: record.authToken }
      : null;
  }

  /** The number a Twilio connection sends from, for the reply address. */
  twilioConnectionNumber(id: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ display_name: string | null }>(
        "SELECT display_name FROM connections WHERE id = ? AND provider = 'twilio'",
        id,
      )
      .toArray()[0];
    return row?.display_name ?? null;
  }

  getSlackConnection(id: string): SlackConnection | null {
    const row = this.ctx.storage.sql
      .exec<ChannelConnectionRow>(
        `SELECT id, channel, agent_id, alias, external_channel_id,
                team_id, connected_account_id, trigger_id, app_name, app_name_synced_at, app_id, team_name,
                bot_user_id, verified_at, verification_error,
                last_event_at, last_delivery_status, last_delivery_at,
                last_error_category, last_error_at,
                token_ciphertext, token_iv, status,
                created_at, updated_at
         FROM channel_connections
         WHERE id = ? AND channel = 'slack'`,
        id,
      )
      .toArray()[0];
    return row ? slackConnectionFromRow(row) : null;
  }

  /**
   * Every channel connection, whatever the provider.
   *
   * The Slack-only version partitioned by (agent, alias), which was right when
   * one agent could only have one channel. It now partitions by provider too,
   * or an agent connected to both Slack and Twilio would show whichever was
   * touched last and silently hide the other.
   */
  async listChannelConnections(): Promise<SlackConnection[]> {
    const rows = this.ctx.storage.sql
      .exec<ChannelConnectionRow>(
        `SELECT id, channel, agent_id, alias, external_channel_id,
                team_id, connected_account_id, trigger_id, app_name, app_name_synced_at, app_id, team_name,
                bot_user_id, verified_at, verification_error,
                last_event_at, last_delivery_status, last_delivery_at,
                last_error_category, last_error_at,
                token_ciphertext, token_iv, status,
                created_at, updated_at
         FROM channel_connections
         WHERE status <> 'disconnected'
           AND id = (
             SELECT current.id
             FROM channel_connections current
             WHERE current.agent_id = channel_connections.agent_id
               AND current.alias = channel_connections.alias
               AND current.channel = channel_connections.channel
             ORDER BY current.updated_at DESC
             LIMIT 1
           )
         ORDER BY updated_at DESC`,
      )
      .toArray();
    return rows.map(slackConnectionFromRow);
  }

  async listSlackConnections(): Promise<SlackConnection[]> {
    let rows = this.ctx.storage.sql
      .exec<ChannelConnectionRow>(
        `SELECT id, channel, agent_id, alias, external_channel_id,
                team_id, connected_account_id, trigger_id, app_name, app_name_synced_at, app_id, team_name,
                bot_user_id, verified_at, verification_error,
                last_event_at, last_delivery_status, last_delivery_at,
                last_error_category, last_error_at,
                token_ciphertext, token_iv, status,
                created_at, updated_at
         FROM channel_connections
         WHERE channel = 'slack'
           AND status <> 'disconnected'
           AND id = (
             SELECT current.id
             FROM channel_connections current
             WHERE current.channel = 'slack'
               AND current.agent_id = channel_connections.agent_id
               AND current.alias = channel_connections.alias
             ORDER BY current.updated_at DESC
             LIMIT 1
           )
         ORDER BY updated_at DESC`,
      )
      .toArray();
    let refreshed = false;
    for (const row of rows) {
      if (
        row.status !== "connected" ||
        row.app_name_synced_at ||
        !row.app_id
      ) {
        continue;
      }
      try {
        const installation = await resolveSlackInstallation(
          await this.slackBotToken(row.id),
          row.app_id,
        );
        if (installation.appName) {
          this.ctx.storage.sql.exec(
            `UPDATE channel_connections
             SET app_name = ?, app_name_synced_at = ?, updated_at = ?
             WHERE id = ? AND channel = 'slack'`,
            installation.appName,
            new Date().toISOString(),
            new Date().toISOString(),
            row.id,
          );
          refreshed = true;
        }
      } catch {
        // A stale token should not prevent the dashboard from listing channels.
      }
    }
    if (refreshed) {
      rows = rows.map((row) => {
        const connection = this.getSlackConnection(row.id);
        return connection
          ? { ...row, app_name: connection.appName ?? row.app_name }
          : row;
      });
    }
    return rows.map(slackConnectionFromRow);
  }

  findSlackConnectionForAlias(
    agentId: string,
    alias: string,
    channelId?: string,
  ): SlackConnection | null {
    const row = this.ctx.storage.sql
      .exec<ChannelConnectionRow>(
        `SELECT id, channel, agent_id, alias, external_channel_id,
                team_id, connected_account_id, trigger_id, app_name, app_name_synced_at, app_id, team_name,
                bot_user_id, verified_at, verification_error,
                last_event_at, last_delivery_status, last_delivery_at,
                last_error_category, last_error_at,
                token_ciphertext, token_iv, status,
                created_at, updated_at
         FROM channel_connections
         WHERE channel = 'slack' AND agent_id = ? AND alias = ?
           AND (? IS NULL OR external_channel_id = ?)
         ORDER BY updated_at DESC
         LIMIT 1`,
        agentId,
        alias,
        channelId ?? null,
        channelId ?? null,
      )
      .toArray()[0];
    return row ? slackConnectionFromRow(row) : null;
  }

  /**
   * Mint a Slack connection for a target in one transaction, the way the
   * automated reservation does: find the target's current row, refuse a
   * connected one (unless the caller asked to reconnect) and a target an
   * automated setup is working on, then reuse the row or create one. The
   * caller never chooses an id or decides create-versus-reuse outside the
   * transaction, so two mints for one target cannot both create. Returns the
   * connection and the revision it was written at, for the publisher.
   */
  mintSlackConnection(input: {
    agentId: string;
    alias: string;
    channelId: string;
    appName: string;
    webhookTokenHash: string;
    reconnect: boolean;
  }):
    | {
        outcome: "minted";
        created: boolean;
        connection: SlackConnection;
        revision: number;
      }
    | { outcome: "connected" }
    | { outcome: "setup_active"; setupId: string } {
    return this.ctx.storage.transactionSync(() => {
      const current = this.findSlackConnectionForAlias(
        input.agentId,
        input.alias,
        input.channelId,
      );
      if (current?.status === "connected" && !input.reconnect) {
        return { outcome: "connected" };
      }
      const active = this.activeSlackSetupForTarget(
        input.agentId,
        input.alias,
        input.channelId,
      );
      if (active) return { outcome: "setup_active", setupId: active.id };
      const id = current?.id ?? crypto.randomUUID();
      if (current) {
        this.resetSlackConnectionRows(id, input.appName, input.webhookTokenHash, "manual");
      } else {
        this.insertSlackConnectionRows({
          id,
          channelId: input.channelId,
          agentId: input.agentId,
          alias: input.alias,
          appName: input.appName,
          webhookTokenHash: input.webhookTokenHash,
          routeMintedBy: "manual",
        });
      }
      const connection = this.getSlackConnection(id);
      if (!connection) throw new Error("Slack connection was not stored");
      return {
        outcome: "minted",
        created: !current,
        connection,
        revision: this.channelConnectionFacts(id)?.revision ?? 0,
      };
    });
  }

  /** Reset a Slack connection to pending with a freshly minted route; the revision advances. */
  private resetSlackConnectionRows(
    id: string,
    appName: string,
    webhookTokenHash: string,
    routeMintedBy: "manual" | "setup",
  ): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET app_name = ?, app_name_synced_at = NULL, app_id = NULL, team_id = NULL, team_name = NULL,
           bot_user_id = NULL, verified_at = NULL, verification_error = NULL,
           last_event_at = NULL, last_delivery_status = NULL, last_delivery_at = NULL,
           last_error_category = NULL, last_error_at = NULL,
           token_ciphertext = NULL, token_iv = NULL,
           webhook_token_hash = ?,
           route_minted_by = ?,
           revision = revision + 1,
           status = 'pending', updated_at = ?
       WHERE id = ? AND channel = 'slack'`,
      appName,
      webhookTokenHash,
      routeMintedBy,
      timestamp,
      id,
    );
    this.ctx.storage.sql.exec(
      `UPDATE connections
       SET external_account_id = NULL, display_name = NULL,
           credential_ciphertext = NULL, credential_iv = NULL,
           status = 'pending', updated_at = ?
       WHERE id = ? AND provider = 'slack'`,
      timestamp,
      id,
    );
  }

  // ── Linear agent connections (work 037 S1) ─────────────────────────────────
  // RPC surface of `this.linearConnections` for the private routes in
  // `linear-connection-routes.ts` and the egress proxy. Every rule lives in
  // `linear-connections.ts`.

  createLinearConnection(
    input: CreateLinearConnectionRecord,
  ): Promise<CreateLinearConnectionOutcome> {
    return this.linearConnections.create(input);
  }

  getLinearConnection(id: string): LinearConnection | null {
    return this.linearConnections.get(id);
  }

  listLinearConnections(
    projectId: string,
    environment?: ProjectEnvironmentName,
  ): Promise<LinearConnectionWithHealth[]> {
    return this.linearConnections.list(projectId, environment);
  }

  setLinearConnectionCredentials(
    id: string,
    input: LinearConnectionCredentialsInput,
  ): Promise<LinearCredentialsOutcome> {
    return this.linearConnections.setCredentials(id, input);
  }

  issueLinearAuthorization(
    id: string,
    nonceHash: string,
  ): Promise<LinearAuthorizationIssue> {
    return this.linearConnections.issueAuthorization(id, nonceHash);
  }

  completeLinearAuthorization(input: {
    nonceHash: string;
    code: string | null;
    denied: boolean;
  }): Promise<LinearAuthorizationCompletion> {
    return this.linearConnections.completeAuthorization(input);
  }

  disconnectLinearConnection(id: string): Promise<LinearDisconnectOutcome> {
    return this.linearConnections.disconnect(id);
  }

  createToolConnection(input: {
    id: string;
    provider: string;
    label: string;
    ownerUserId: string;
    agentId: string;
    alias: string;
    scopes: string[];
    oauthStateHash: string;
  }): Connection {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (
         id, kind, provider, label, owner_user_id, agent_id, alias, external_account_id,
         display_name, scopes_json, credential_ciphertext, credential_iv,
         oauth_state_hash, status, created_at, updated_at
       ) VALUES (?, 'tool', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?,
                 'pending', ?, ?)`,
      input.id,
      input.provider,
      input.label,
      input.ownerUserId,
      input.agentId,
      input.alias,
      JSON.stringify(input.scopes),
      input.oauthStateHash,
      timestamp,
      timestamp,
    );
    const connection = this.getConnection(input.id);
    if (!connection) throw new Error("Connection was not stored");
    return connection;
  }

  getConnection(id: string): Connection | null {
    const row = this.connectionRow(id);
    return row ? connectionFromRow(row) : null;
  }

  getConnectionForUser(id: string, ownerUserId: string): Connection | null {
    const connection = this.getConnection(id);
    return connection?.ownerUserId === ownerUserId ? connection : null;
  }

  findUserConnection(
    ownerUserId: string,
    provider: string,
    label: string,
  ): Connection | null {
    const row = this.ctx.storage.sql
      .exec<ConnectionRow>(
        `SELECT id, kind, provider, label, owner_user_id, agent_id, alias,
                external_account_id, display_name, scopes_json,
                credential_ciphertext, credential_iv, oauth_state_hash,
                status, created_at, updated_at
         FROM connections
         WHERE kind = 'tool' AND owner_user_id = ? AND provider = ?
           AND label = ? AND status != 'disconnected'
         ORDER BY updated_at DESC
         LIMIT 1`,
        ownerUserId,
        provider,
        label,
      )
      .toArray()[0];
    return row ? connectionFromRow(row) : null;
  }

  listConnections(ownerUserId?: string): Connection[] {
    this.deleteExpiredManagedConnections(new Date().toISOString());
    return this.ctx.storage.sql
      .exec<ConnectionRow>(
        `SELECT id, kind, provider, label, owner_user_id, agent_id, alias,
                external_account_id, display_name, scopes_json,
                credential_ciphertext, credential_iv, oauth_state_hash,
                status, created_at, updated_at
         FROM connections
         WHERE (? IS NULL OR owner_user_id = ?)
         ORDER BY updated_at DESC`,
        ownerUserId ?? null,
        ownerUserId ?? null,
      )
      .toArray()
      .map(connectionFromRow);
  }

  listProjectServiceAttachments(
    projectId: string,
    service?: string,
  ): ProjectServiceAttachment[] {
    return this.ctx.storage.sql
      .exec<ProjectServiceAttachmentRow>(
        `SELECT a.project_id, a.connection_id,
                a.service AS attachment_service,
                a.provider AS attachment_provider, a.label AS attachment_label,
                a.created_at AS attachment_created_at,
                a.updated_at AS attachment_updated_at,
                c.id, c.kind, c.provider, c.label, c.owner_user_id, c.agent_id,
                c.alias, c.external_account_id, c.display_name, c.scopes_json,
                c.credential_ciphertext, c.credential_iv, c.oauth_state_hash,
                c.managed_expires_at, c.managed_last_checked_at,
                c.status, c.created_at, c.updated_at
         FROM project_service_attachments a
         JOIN connections c ON c.id = a.connection_id
         WHERE a.project_id = ? AND (? IS NULL OR a.service = ?)
         ORDER BY a.service, a.label`,
        projectId,
        service ?? null,
        service ?? null,
      )
      .toArray()
      .map((row) => ({
        projectId: row.project_id,
        service: row.attachment_service,
        provider: row.attachment_provider,
        label: row.attachment_label,
        connectionId: row.connection_id,
        connection: connectionFromRow(row),
        createdAt: row.attachment_created_at,
        updatedAt: row.attachment_updated_at,
      }));
  }

  /** The service a connection serves, if it may be attached to a project or granted to the computer. */
  private attachableService(connectionId: string, target: string): { connection: Connection; service: string } {
    const connection = this.getConnection(connectionId);
    if (
      !connection ||
      connection.kind !== "tool" ||
      connection.status !== "connected"
    ) {
      throw new Error("A connected tool connection is required");
    }
    const row = this.connectionRow(connection.id);
    if (!row || row.credential_ciphertext) {
      throw new Error(`Only managed OAuth connections can be attached to ${target}`);
    }
    const service =
      connection.provider === "google"
        ? googleServiceForScopes(connection.scopes)
        : connection.provider;
    if (!service || !["gmail", "calendar", "drive", "sheets", "github", "linear"].includes(service)) {
      throw new Error(`Connection service cannot be attached to ${target}`);
    }
    return { connection, service };
  }

  attachProjectServiceConnection(input: {
    projectId: string;
    connectionId: string;
  }): ProjectServiceAttachment {
    if (!this.getProject(input.projectId)) throw new Error("Project not found");
    const { connection, service } = this.attachableService(input.connectionId, "a project");
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO project_service_attachments
         (project_id, service, provider, label, connection_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, service, label) DO UPDATE SET
         connection_id = excluded.connection_id,
         updated_at = excluded.updated_at`,
      input.projectId,
      service,
      connection.provider,
      connection.label,
      connection.id,
      timestamp,
      timestamp,
    );
    const attachment = this.listProjectServiceAttachments(
      input.projectId,
      service,
    ).find((candidate) => candidate.label === connection.label);
    if (!attachment) throw new Error("Project service attachment was not stored");
    return attachment;
  }

  detachProjectServiceConnection(input: {
    projectId: string;
    connectionId: string;
  }): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ connection_id: string }>(
          `DELETE FROM project_service_attachments
           WHERE project_id = ? AND connection_id = ?
           RETURNING connection_id`,
          input.projectId,
          input.connectionId,
        )
        .toArray().length > 0
    );
  }

  // ── The organization's computer (work 080) ──
  // Grants of account-owned connections to the computer, for one Slack thread, one Slack
  // user or everyone on it. Who may grant is the caller's check (the dashboard route, or
  // the gateway from Slack); this stores and lists.

  listComputerServiceAttachments(service?: string): ComputerServiceAttachment[] {
    return this.ctx.storage.sql
      .exec<ComputerServiceAttachmentRow>(
        `SELECT a.connection_id,
                a.service AS attachment_service,
                a.provider AS attachment_provider, a.label AS attachment_label,
                a.scope AS attachment_scope, a.scope_subject AS attachment_subject,
                a.granted_by AS attachment_granted_by,
                a.created_at AS attachment_created_at,
                a.updated_at AS attachment_updated_at,
                c.id, c.kind, c.provider, c.label, c.owner_user_id, c.agent_id,
                c.alias, c.external_account_id, c.display_name, c.scopes_json,
                c.credential_ciphertext, c.credential_iv, c.oauth_state_hash,
                c.managed_expires_at, c.managed_last_checked_at,
                c.status, c.created_at, c.updated_at
         FROM computer_service_attachments a
         JOIN connections c ON c.id = a.connection_id
         WHERE (? IS NULL OR a.service = ?)
         ORDER BY a.service, a.label, a.scope, a.scope_subject`,
        service ?? null,
        service ?? null,
      )
      .toArray()
      .map((row) => ({
        service: row.attachment_service,
        provider: row.attachment_provider,
        label: row.attachment_label,
        connectionId: row.connection_id,
        connection: connectionFromRow(row),
        scope: row.attachment_scope as ComputerGrantScope,
        subject: row.attachment_subject,
        grantedBy: row.attachment_granted_by,
        createdAt: row.attachment_created_at,
        updatedAt: row.attachment_updated_at,
      }));
  }

  /** One grant per service, label and audience: granting again replaces the connection behind it. */
  grantComputerServiceConnection(input: {
    connectionId: string;
    scope: ComputerGrantScope;
    subject: string;
    grantedBy: string;
  }): ComputerServiceAttachment {
    const subject = input.scope === "everyone" ? "" : input.subject;
    if (!["session", "user", "everyone"].includes(input.scope)) throw new Error("Unknown grant scope");
    if (input.scope !== "everyone" && !subject) throw new Error(`A ${input.scope} grant needs its subject`);
    if (!input.grantedBy) throw new Error("A grant needs who granted it");
    const { connection, service } = this.attachableService(input.connectionId, "the computer");
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO computer_service_attachments
         (service, provider, label, connection_id, scope, scope_subject, granted_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(service, label, scope, scope_subject) DO UPDATE SET
         provider = excluded.provider,
         connection_id = excluded.connection_id,
         granted_by = excluded.granted_by,
         updated_at = excluded.updated_at`,
      service,
      connection.provider,
      connection.label,
      connection.id,
      input.scope,
      subject,
      input.grantedBy,
      timestamp,
      timestamp,
    );
    const attachment = this.listComputerServiceAttachments(service).find(
      (candidate) =>
        candidate.label === connection.label &&
        candidate.scope === input.scope &&
        candidate.subject === subject,
    );
    if (!attachment) throw new Error("Computer service attachment was not stored");
    return attachment;
  }

  /** The owner's connections that can be granted to the computer for a service (work 080, from Slack). */
  grantableComputerConnections(ownerUserId: string, service: string): Array<{ id: string; label: string; displayName?: string }> {
    return this.listConnections(ownerUserId).flatMap((connection) => {
      try {
        if (this.attachableService(connection.id, "the computer").service !== service) return [];
      } catch {
        return [];
      }
      return [{ id: connection.id, label: connection.label, ...(connection.displayName ? { displayName: connection.displayName } : {}) }];
    });
  }

  /** A thread or personal grant made in Slack: only the connection's owner grants it. */
  grantOwnComputerServiceConnection(input: {
    connectionId: string;
    ownerUserId: string;
    scope: "session" | "user";
    subject: string;
    grantedBy: string;
  }): void {
    if (input.scope !== "session" && input.scope !== "user") throw new Error("Grants for everyone are made on the dashboard");
    if (!this.getConnectionForUser(input.connectionId, input.ownerUserId)) throw new Error("Connection not found");
    this.grantComputerServiceConnection({
      connectionId: input.connectionId,
      scope: input.scope,
      subject: input.subject,
      grantedBy: input.grantedBy,
    });
  }

  /** Revokes a connection's grants: all of them, or only those for one scope (and subject). */
  revokeComputerServiceConnection(input: {
    connectionId: string;
    scope?: ComputerGrantScope;
    subject?: string;
  }): number {
    return this.ctx.storage.sql
      .exec<{ connection_id: string }>(
        `DELETE FROM computer_service_attachments
         WHERE connection_id = ?
           AND (? IS NULL OR scope = ?)
           AND (? IS NULL OR scope_subject = ?)
         RETURNING connection_id`,
        input.connectionId,
        input.scope ?? null,
        input.scope ?? null,
        input.subject ?? null,
        input.subject ?? null,
      )
      .toArray().length;
  }

  upsertManagedToolConnection(input: {
    id: string;
    provider: string;
    label: string;
    ownerUserId: string;
    externalAccountId?: string;
    displayName?: string;
    scopes: string[];
    status?: ChannelConnectionStatus;
    expiresAt?: string;
  }): Connection {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (
         id, kind, provider, label, owner_user_id, agent_id, alias, external_account_id,
         display_name, scopes_json, credential_ciphertext, credential_iv,
         oauth_state_hash, managed_expires_at, managed_last_checked_at,
         status, created_at, updated_at
       ) VALUES (?, 'tool', ?, ?, ?, '', '', ?, ?, ?, NULL, NULL, NULL,
                 ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = 'tool',
         provider = excluded.provider,
         label = excluded.label,
         owner_user_id = excluded.owner_user_id,
         external_account_id = excluded.external_account_id,
         display_name = COALESCE(excluded.display_name, connections.display_name),
         scopes_json = excluded.scopes_json,
         managed_expires_at = excluded.managed_expires_at,
         managed_last_checked_at = NULL,
         status = excluded.status,
         updated_at = excluded.updated_at`,
      input.id,
      input.provider,
      input.label,
      input.ownerUserId,
      input.externalAccountId ?? null,
      input.displayName ?? null,
      JSON.stringify(input.scopes),
      input.status === "pending" ? (input.expiresAt ?? null) : null,
      input.status ?? "connected",
      timestamp,
      timestamp,
    );
    const connection = this.getConnection(input.id);
    if (!connection) throw new Error("Managed connection was not stored");
    return connection;
  }

  claimPendingManagedConnections(input: {
    ownerUserId: string;
    checkedAt: string;
    retryBefore: string;
  }): Connection[] {
    return this.ctx.storage.transactionSync(() => {
      this.deleteExpiredManagedConnections(input.checkedAt);
      const rows = this.ctx.storage.sql
        .exec<ConnectionRow>(
          `SELECT id, kind, provider, label, owner_user_id, agent_id, alias,
                  external_account_id, display_name, scopes_json,
                  credential_ciphertext, credential_iv, oauth_state_hash,
                  managed_expires_at, managed_last_checked_at,
                  status, created_at, updated_at
           FROM connections
           WHERE kind = 'tool' AND owner_user_id = ? AND status = 'pending'
             AND (managed_expires_at IS NULL OR managed_expires_at > ?)
             AND (managed_last_checked_at IS NULL OR managed_last_checked_at <= ?)
           ORDER BY updated_at DESC`,
          input.ownerUserId,
          input.checkedAt,
          input.retryBefore,
        )
        .toArray();
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          `UPDATE connections
           SET managed_last_checked_at = ?
           WHERE id = ? AND status = 'pending'`,
          input.checkedAt,
          row.id,
        );
      }
      return rows.map(connectionFromRow);
    });
  }

  deleteExpiredManagedConnections(timestamp: string): number {
    const parsed = new Date(timestamp);
    const legacyCutoff = new Date(
      (Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime()) -
        15 * 60_000,
    ).toISOString();
    return this.ctx.storage.sql
      .exec<{ id: string }>(
        `DELETE FROM connections
         WHERE kind = 'tool' AND status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM project_service_attachments a
             WHERE a.connection_id = connections.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM computer_service_attachments a
             WHERE a.connection_id = connections.id
           )
           AND (
             (managed_expires_at IS NOT NULL AND managed_expires_at <= ?)
             OR (managed_expires_at IS NULL AND updated_at <= ?)
           )
         RETURNING id`,
        timestamp,
        legacyCutoff,
      )
      .toArray().length;
  }

  removeConnection(id: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM project_service_attachments WHERE connection_id = ?",
        id,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM computer_service_attachments WHERE connection_id = ?",
        id,
      );
      this.ctx.storage.sql.exec("DELETE FROM connections WHERE id = ?", id);
    });
  }

  connectionOAuthStateHash(id: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{
          oauth_state_hash: string | null;
        }>("SELECT oauth_state_hash FROM connections WHERE id = ?", id)
        .toArray()[0]?.oauth_state_hash ?? null
    );
  }

  async completeToolConnection(input: {
    id: string;
    externalAccountId: string;
    displayName: string;
    scopes: string[];
    credential: string;
  }): Promise<Connection> {
    const encrypted = await this.encryptSecret(input.credential);
    this.ctx.storage.sql.exec(
      `UPDATE connections
       SET external_account_id = ?, display_name = ?, scopes_json = ?,
           credential_ciphertext = ?, credential_iv = ?,
           oauth_state_hash = NULL, status = 'connected', updated_at = ?
       WHERE id = ? AND kind = 'tool'`,
      input.externalAccountId,
      input.displayName,
      JSON.stringify(input.scopes),
      encrypted.ciphertext,
      encrypted.iv,
      new Date().toISOString(),
      input.id,
    );
    const connection = this.getConnection(input.id);
    if (!connection) throw new Error("Connection was not found");
    return connection;
  }

  disconnectConnection(id: string): Connection {
    this.ctx.storage.sql.exec(
      `UPDATE connections
       SET status = 'disconnected', credential_ciphertext = NULL,
           credential_iv = NULL, oauth_state_hash = NULL, updated_at = ?
       WHERE id = ?`,
      new Date().toISOString(),
      id,
    );
    const connection = this.getConnection(id);
    if (!connection) throw new Error("Connection was not found");
    return connection;
  }

  // ── Model access (work 011) ────────────────────────────────────────────────
  // Organization-owned Claude/Codex subscription connections. One per provider
  // per organization (enforced by UNIQUE (organization_id, provider)). The
  // provider token is stored encrypted and is never returned by these methods.

  // Stores a provider-issued long-lived automation token after the caller has
  // validated it. This is the Claude setup-token path; Codex continues to use
  // the OAuth start/complete methods below.
  async connectModelAccessToken(input: {
    organizationId: string;
    connectedByUserId: string;
    provider: "anthropic";
    token: string;
    label?: string;
  }): Promise<ModelAccessConnection> {
    const existing = this.modelAccessConnectionRowForProvider(
      input.organizationId,
      input.provider,
    );
    const encrypted = await this.encryptSecret(input.token);
    const timestamp = new Date().toISOString();
    if (existing) {
      this.ctx.storage.sql.exec(
        `UPDATE model_access_connections
         SET connected_by_user_id = ?, kind = 'claude_subscription',
             label = COALESCE(?, label), external_account_hint = NULL,
             credential_ciphertext = ?, credential_iv = ?,
             refresh_ciphertext = NULL, refresh_iv = NULL,
             access_expires_at = NULL, token_type = 'Bearer',
             oauth_state_hash = NULL, oauth_code_verifier = NULL,
             oauth_redirect_uri = NULL, status = 'connected', checked_at = ?,
             updated_at = ?
         WHERE id = ?`,
        input.connectedByUserId,
        input.label ?? null,
        encrypted.ciphertext,
        encrypted.iv,
        timestamp,
        timestamp,
        existing.id,
      );
      const row = this.modelAccessConnectionRow(existing.id);
      if (!row) throw new Error("Model access connection was not stored");
      return modelAccessConnectionFromRow(row);
    }
    const id = `mac_${crypto.randomUUID().replaceAll("-", "")}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO model_access_connections (
         id, organization_id, connected_by_user_id, provider, kind, label,
         external_account_hint, status, entitlement_snapshot_json, checked_at,
         oauth_state_hash, oauth_code_verifier, oauth_redirect_uri,
         credential_ciphertext, credential_iv, refresh_ciphertext, refresh_iv,
         access_expires_at, token_type, created_at, updated_at
       ) VALUES (?, ?, ?, 'anthropic', 'claude_subscription', ?, NULL,
                 'connected', NULL, ?, NULL, NULL, NULL, ?, ?, NULL, NULL,
                 NULL, 'Bearer', ?, ?)`,
      id,
      input.organizationId,
      input.connectedByUserId,
      input.label ?? "Claude account",
      timestamp,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    const row = this.modelAccessConnectionRow(id);
    if (!row) throw new Error("Model access connection was not stored");
    return modelAccessConnectionFromRow(row);
  }

  async connectModelAccessApiKey(input: {
    organizationId: string;
    connectedByUserId: string;
    provider: "openrouter" | "openai_compatible";
    apiKey: string;
    baseUrl: string;
    label?: string;
  }): Promise<ModelAccessConnection> {
    const existing = this.modelAccessConnectionRowForProvider(
      input.organizationId,
      input.provider,
    );
    const encrypted = await this.encryptSecret(input.apiKey);
    const timestamp = new Date().toISOString();
    const kind =
      input.provider === "openrouter"
        ? "openrouter_api_key"
        : "openai_compatible_api";
    const label =
      input.label ??
      (input.provider === "openrouter" ? "OpenRouter" : "OpenAI-compatible API");
    if (existing) {
      this.ctx.storage.sql.exec(
        `UPDATE model_access_connections
         SET connected_by_user_id = ?, kind = ?, label = ?, base_url = ?,
             credential_ciphertext = ?, credential_iv = ?,
             refresh_ciphertext = NULL, refresh_iv = NULL,
             access_expires_at = NULL, token_type = 'Bearer',
             status = 'connected', checked_at = ?, updated_at = ?
         WHERE id = ?`,
        input.connectedByUserId,
        kind,
        label,
        input.baseUrl,
        encrypted.ciphertext,
        encrypted.iv,
        timestamp,
        timestamp,
        existing.id,
      );
      const row = this.modelAccessConnectionRow(existing.id);
      if (!row) throw new Error("Model access connection was not stored");
      return modelAccessConnectionFromRow(row);
    }
    const id = `mac_${crypto.randomUUID().replaceAll("-", "")}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO model_access_connections (
         id, organization_id, connected_by_user_id, provider, kind, label,
         base_url, external_account_hint, status, entitlement_snapshot_json,
         checked_at, credential_ciphertext, credential_iv, access_expires_at,
         token_type, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'connected', NULL, ?, ?, ?, NULL,
                 'Bearer', ?, ?)`,
      id,
      input.organizationId,
      input.connectedByUserId,
      input.provider,
      kind,
      label,
      input.baseUrl,
      timestamp,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    const row = this.modelAccessConnectionRow(id);
    if (!row) throw new Error("Model access connection was not stored");
    return modelAccessConnectionFromRow(row);
  }

  // Starts the personal Codex subscription OAuth flow. Records a single-flight
  // pending intent (state hash + PKCE verifier) keyed to one connection id, then
  // returns the connection row and the authorization URL. A retry for the same
  // provider returns the existing pending intent rather than minting a new one.
  startModelAccessConnect(input: {
    organizationId: string;
    connectedByUserId: string;
    provider: ModelAccessProvider;
    oauthCodeVerifier: string;
    oauthRedirectUri: string;
    label?: string;
  }): ModelAccessConnection {
    const existing = this.modelAccessConnectionRowForProvider(
      input.organizationId,
      input.provider,
    );
    const id =
      existing?.id ?? `mac_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO model_access_connections (
         id, organization_id, connected_by_user_id, provider, kind, label,
         external_account_hint, status, entitlement_snapshot_json, checked_at,
         oauth_state_hash, oauth_code_verifier, oauth_redirect_uri,
         credential_ciphertext, credential_iv, refresh_ciphertext, refresh_iv,
         access_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'openai', 'codex_subscription', ?, NULL, 'connecting',
                 NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(organization_id, provider) DO UPDATE SET
         connected_by_user_id = excluded.connected_by_user_id,
         label = COALESCE(excluded.label, model_access_connections.label),
         status = 'connecting',
         oauth_state_hash = NULL,
         oauth_code_verifier = excluded.oauth_code_verifier,
         oauth_redirect_uri = excluded.oauth_redirect_uri,
         updated_at = excluded.updated_at`,
      id,
      input.organizationId,
      input.connectedByUserId,
      input.label ?? "Codex account",
      input.oauthCodeVerifier,
      input.oauthRedirectUri,
      timestamp,
      timestamp,
    );
    const row = this.modelAccessConnectionRow(id);
    if (!row) throw new Error("Model access connection was not stored");
    return modelAccessConnectionFromRow(row);
  }

  // Records the sha-256 of the one-time OAuth state for a pending connection.
  // The state embeds the connection id so the dashboard callback can direct the
  // exchange to the right connection before validating the nonce.
  setModelAccessOAuthState(id: string, stateHash: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE model_access_connections SET oauth_state_hash = ?, updated_at = ?
       WHERE id = ?`,
      stateHash,
      new Date().toISOString(),
      id,
    );
  }

  // Completes the OAuth exchange with the provider access token (and refresh
  // credential when the provider grants one). Stores access and refresh material
  // separately encrypted. The refresh credential is write-only after this call.
  async completeModelAccessConnect(input: {
    id: string;
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt: number;
    externalAccountHint?: string;
  }): Promise<ModelAccessConnection> {
    const access = await this.encryptSecret(input.accessToken);
    const refresh = input.refreshToken
      ? await this.encryptSecret(input.refreshToken)
      : null;
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE model_access_connections
       SET credential_ciphertext = ?, credential_iv = ?,
           refresh_ciphertext = ?, refresh_iv = ?,
           access_expires_at = ?, token_type = ?,
           external_account_hint = COALESCE(?, external_account_hint),
           oauth_state_hash = NULL, oauth_code_verifier = NULL,
           oauth_redirect_uri = NULL,
           status = 'connected', checked_at = ?, updated_at = ?
       WHERE id = ?`,
      access.ciphertext,
      access.iv,
      refresh?.ciphertext ?? null,
      refresh?.iv ?? null,
      input.expiresAt,
      input.tokenType,
      input.externalAccountHint ?? null,
      timestamp,
      timestamp,
      input.id,
    );
    const row = this.modelAccessConnectionRow(input.id);
    if (!row) throw new Error("Model access connection was not found");
    return modelAccessConnectionFromRow(row);
  }

  // Returns the stored OAuth intent for a pending connection: the PKCE verifier
  // and redirect URI needed to exchange the authorization code. Never returns
  // the state hash; the caller compares it separately.
  modelAccessOAuthIntent(id: string): {
    codeVerifier: string;
    redirectUri: string;
    stateHash: string;
  } | null {
    const row = this.modelAccessConnectionRow(id);
    if (
      !row?.oauth_code_verifier ||
      !row.oauth_redirect_uri ||
      !row.oauth_state_hash
    ) {
      return null;
    }
    return {
      codeVerifier: row.oauth_code_verifier,
      redirectUri: row.oauth_redirect_uri,
      stateHash: row.oauth_state_hash,
    };
  }

  // The current usable access token for a connected Codex subscription. If the
  // access token is close to expiry and a refresh credential exists, refreshes
  // single-flight (rotates in place) and persists the new access material. Only
  // the dispatch path calls this, immediately before a provider request.
  async modelAccessCredential(id: string): Promise<string | null> {
    const row = this.modelAccessConnectionRow(id);
    if (!row?.credential_ciphertext || !row.credential_iv) return null;
    const accessToken = await this.decryptSecret(
      row.credential_ciphertext,
      row.credential_iv,
    );
    if (
      !row.refresh_ciphertext ||
      !row.refresh_iv ||
      (row.access_expires_at ?? 0) - 60_000 > Date.now()
    ) {
      return accessToken;
    }
    // Single-flight refresh delegated to the caller-provided refresher to keep
    // OAuth config out of the Durable Object. Returns the current token if the
    // refresher is absent or refuse — callers should then fail or fall back.
    return accessToken;
  }

  // The decrypted refresh credential for a connected Codex subscription. Only
  // the single-flight refresher uses this; never exposed over HTTP.
  async modelAccessRefreshCredential(id: string): Promise<{
    tokenType: string;
    refreshToken: string;
  } | null> {
    const row = this.modelAccessConnectionRow(id);
    if (!row?.refresh_ciphertext || !row.refresh_iv) return null;
    const refreshToken = await this.decryptSecret(
      row.refresh_ciphertext,
      row.refresh_iv,
    );
    return {
      tokenType: row.token_type ?? "Bearer",
      refreshToken,
    };
  }

  // Persists a freshly refreshed access credential (and, if the provider
  // rotated it, the new refresh credential) after the single-flight refresher
  // completes.
  async persistModelAccessRefresh(input: {
    id: string;
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt: number;
  }): Promise<void> {
    const access = await this.encryptSecret(input.accessToken);
    const refresh = input.refreshToken
      ? await this.encryptSecret(input.refreshToken)
      : null;
    this.ctx.storage.sql.exec(
      `UPDATE model_access_connections
       SET credential_ciphertext = ?, credential_iv = ?,
           refresh_ciphertext = COALESCE(?, refresh_ciphertext),
           refresh_iv = COALESCE(?, refresh_iv),
           access_expires_at = ?, token_type = ?, updated_at = ?
       WHERE id = ?`,
      access.ciphertext,
      access.iv,
      refresh?.ciphertext ?? null,
      refresh?.iv ?? null,
      input.expiresAt,
      input.tokenType,
      new Date().toISOString(),
      input.id,
    );
  }

  listModelAccessConnections(organizationId: string): ModelAccessConnection[] {
    return this.ctx.storage.sql
      .exec<ModelAccessConnectionRow>(
        `SELECT id, organization_id, connected_by_user_id, provider, kind, label, base_url,
                external_account_hint, status, entitlement_snapshot_json,
                checked_at, oauth_state_hash, oauth_code_verifier,
                oauth_redirect_uri, credential_ciphertext, credential_iv,
                refresh_ciphertext, refresh_iv, access_expires_at,
                created_at, updated_at
         FROM model_access_connections
         WHERE organization_id = ?
         ORDER BY updated_at DESC`,
        organizationId,
      )
      .toArray()
      .map(modelAccessConnectionFromRow);
  }

  getModelAccessConnection(id: string): ModelAccessConnection | null {
    const row = this.modelAccessConnectionRow(id);
    return row ? modelAccessConnectionFromRow(row) : null;
  }

  setModelAccessConnectionStatus(
    id: string,
    status: ModelAccessConnectionStatus,
    checkedAt?: string,
  ): ModelAccessConnection {
    this.ctx.storage.sql.exec(
      `UPDATE model_access_connections
       SET status = ?, checked_at = COALESCE(?, checked_at), updated_at = ?
       WHERE id = ?`,
      status,
      checkedAt ?? null,
      new Date().toISOString(),
      id,
    );
    const row = this.modelAccessConnectionRow(id);
    if (!row) throw new Error("Model access connection was not found");
    return modelAccessConnectionFromRow(row);
  }

  // Disconnect deletes local secret material. Provider-side revocation (when
  // supported) is the caller's responsibility and is best-effort before this.
  disconnectModelAccess(id: string): ModelAccessConnection {
    this.ctx.storage.sql.exec(
      `UPDATE model_access_connections
       SET status = 'revoked', credential_ciphertext = NULL, credential_iv = NULL,
           refresh_ciphertext = NULL, refresh_iv = NULL,
           oauth_state_hash = NULL, oauth_code_verifier = NULL,
           oauth_redirect_uri = NULL, updated_at = ?
       WHERE id = ?`,
      new Date().toISOString(),
      id,
    );
    // Project bindings for this connection become inactive.
    this.ctx.storage.sql.exec(
      `UPDATE model_access_bindings SET enabled = 0, updated_at = ?
       WHERE connection_id = ?`,
      new Date().toISOString(),
      id,
    );
    const row = this.modelAccessConnectionRow(id);
    if (!row) throw new Error("Model access connection was not found");
    return modelAccessConnectionFromRow(row);
  }

  listModelAccessBindings(
    projectId: string,
    environment?: ProjectEnvironmentName,
  ): ModelAccessBinding[] {
    return this.ctx.storage.sql
      .exec<ModelAccessBindingRow>(
        `SELECT organization_id, project_id, environment, provider, connection_id,
                enabled, enabled_by_user_id, created_at, updated_at
         FROM model_access_bindings
         WHERE project_id = ? AND (? IS NULL OR environment = ?)
         ORDER BY provider, environment`,
        projectId,
        environment ?? null,
        environment ?? null,
      )
      .toArray()
      .map(modelAccessBindingFromRow);
  }

  putModelAccessBinding(input: {
    organizationId: string;
    projectId: string;
    environment: ProjectEnvironmentName;
    provider: ModelAccessProvider;
    enabled: boolean;
    enabledByUserId: string;
  }): ModelAccessBinding {
    const connection = this.modelAccessConnectionRowForProvider(
      input.organizationId,
      input.provider,
    );
    if (!connection) {
      throw new Error("No model access connection for this provider");
    }
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO model_access_bindings (
         organization_id, project_id, environment, provider, connection_id,
         enabled, enabled_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, environment, provider) DO UPDATE SET
         connection_id = excluded.connection_id,
         enabled = excluded.enabled,
         enabled_by_user_id = excluded.enabled_by_user_id,
         updated_at = excluded.updated_at`,
      input.organizationId,
      input.projectId,
      input.environment,
      input.provider,
      connection.id,
      input.enabled ? 1 : 0,
      input.enabledByUserId,
      timestamp,
      timestamp,
    );
    const row = this.ctx.storage.sql
      .exec<ModelAccessBindingRow>(
        `SELECT organization_id, project_id, environment, provider, connection_id,
                enabled, enabled_by_user_id, created_at, updated_at
         FROM model_access_bindings
         WHERE project_id = ? AND environment = ? AND provider = ?`,
        input.projectId,
        input.environment,
        input.provider,
      )
      .toArray()[0];
    if (!row) throw new Error("Model access binding was not stored");
    return modelAccessBindingFromRow(row);
  }

  deleteModelAccessBinding(
    projectId: string,
    environment: ProjectEnvironmentName,
    provider: ModelAccessProvider,
  ): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM model_access_bindings
       WHERE project_id = ? AND environment = ? AND provider = ?`,
      projectId,
      environment,
      provider,
    );
  }

  listModelRoutes(
    projectId: string,
    environment?: ProjectEnvironmentName,
  ): ModelRoute[] {
    return this.ctx.storage.sql
      .exec<ModelRouteRow>(
        `SELECT id, organization_id, project_id, environment, agent_id,
                connection_id, model, fallback, revision, updated_by_user_id,
                created_at, updated_at
         FROM model_routes
         WHERE project_id = ? AND (? IS NULL OR environment = ?)
         ORDER BY environment, agent_id`,
        projectId,
        environment ?? null,
        environment ?? null,
      )
      .toArray()
      .map(modelRouteFromRow);
  }

  putModelRoute(input: {
    organizationId: string;
    projectId: string;
    environment: ProjectEnvironmentName;
    agentId?: string;
    connectionId: string;
    model: string;
    fallback: "fail" | "managed";
    updatedByUserId: string;
  }): ModelRoute {
    const connection = this.modelAccessConnectionRow(input.connectionId);
    if (
      !connection ||
      connection.organization_id !== input.organizationId ||
      connection.status !== "connected"
    ) {
      throw new Error("Connected model access connection was not found");
    }
    const agentId = input.agentId ?? "";
    const timestamp = new Date().toISOString();
    const id = `mr_${crypto.randomUUID().replaceAll("-", "")}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO model_routes (
         id, organization_id, project_id, environment, agent_id, connection_id,
         model, fallback, revision, updated_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(project_id, environment, agent_id) DO UPDATE SET
         connection_id = excluded.connection_id,
         model = excluded.model,
         fallback = excluded.fallback,
         revision = model_routes.revision + 1,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
      id,
      input.organizationId,
      input.projectId,
      input.environment,
      agentId,
      input.connectionId,
      input.model,
      input.fallback,
      input.updatedByUserId,
      timestamp,
      timestamp,
    );
    const row = this.ctx.storage.sql
      .exec<ModelRouteRow>(
        `SELECT id, organization_id, project_id, environment, agent_id,
                connection_id, model, fallback, revision, updated_by_user_id,
                created_at, updated_at
         FROM model_routes
         WHERE project_id = ? AND environment = ? AND agent_id = ?`,
        input.projectId,
        input.environment,
        agentId,
      )
      .toArray()[0];
    if (!row) throw new Error("Model route was not stored");
    return modelRouteFromRow(row);
  }

  deleteModelRoute(
    projectId: string,
    environment: ProjectEnvironmentName,
    agentId?: string,
  ): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM model_routes
       WHERE project_id = ? AND environment = ? AND agent_id = ?`,
      projectId,
      environment,
      agentId ?? "",
    );
  }

  private modelAccessConnectionRow(
    id: string,
  ): ModelAccessConnectionRow | undefined {
    return this.ctx.storage.sql
      .exec<ModelAccessConnectionRow>(
          `SELECT id, organization_id, connected_by_user_id, provider, kind, label, base_url,
                external_account_hint, status, entitlement_snapshot_json,
                checked_at, oauth_state_hash, oauth_code_verifier,
                oauth_redirect_uri, credential_ciphertext, credential_iv,
                refresh_ciphertext, refresh_iv, access_expires_at, token_type,
                created_at, updated_at
         FROM model_access_connections WHERE id = ?`,
        id,
      )
      .toArray()[0];
  }

  private modelAccessConnectionRowForProvider(
    organizationId: string,
    provider: ModelAccessProvider,
  ): ModelAccessConnectionRow | undefined {
    return this.ctx.storage.sql
      .exec<ModelAccessConnectionRow>(
        `SELECT id, organization_id, connected_by_user_id, provider, kind, label, base_url,
                external_account_hint, status, entitlement_snapshot_json,
                checked_at, oauth_state_hash, oauth_code_verifier,
                oauth_redirect_uri, credential_ciphertext, credential_iv,
                refresh_ciphertext, refresh_iv, access_expires_at, token_type,
                created_at, updated_at
         FROM model_access_connections
         WHERE organization_id = ? AND provider = ?
         ORDER BY updated_at DESC LIMIT 1`,
        organizationId,
        provider,
      )
      .toArray()[0];
  }

  async connectionSecretForDeployment(input: {
    provider: string;
    deploymentId: string;
    ownerUserId: string;
    label?: string;
  }): Promise<{ connection: Connection; credential: string } | null> {
    const row = this.ctx.storage.sql
      .exec<ConnectionRow>(
        `SELECT c.id, c.kind, c.provider, c.label, c.owner_user_id, c.agent_id, c.alias,
                c.external_account_id, c.display_name, c.scopes_json,
                c.credential_ciphertext, c.credential_iv,
                c.oauth_state_hash, c.status, c.created_at, c.updated_at
         FROM connections c
         JOIN deployments d ON d.agent_id = c.agent_id
         JOIN deployment_aliases a
           ON a.agent_id = c.agent_id
          AND a.alias = c.alias
          AND a.deployment_id = d.id
         WHERE d.id = ? AND c.provider = ? AND c.kind = 'tool'
           AND c.owner_user_id = ?
           AND c.status = 'connected'
           AND (? IS NULL OR c.label = ?)
         ORDER BY c.updated_at DESC
         LIMIT 1`,
        input.deploymentId,
        input.provider,
        input.ownerUserId,
        input.label ?? null,
        input.label ?? null,
      )
      .toArray()[0];
    if (!row?.credential_ciphertext || !row.credential_iv) return null;
    return {
      connection: connectionFromRow(row),
      credential: await this.decryptSecret(
        row.credential_ciphertext,
        row.credential_iv,
      ),
    };
  }

  async updateConnectionCredential(
    id: string,
    credential: string,
  ): Promise<void> {
    const encrypted = await this.encryptSecret(credential);
    this.ctx.storage.sql.exec(
      `UPDATE connections
       SET credential_ciphertext = ?, credential_iv = ?, updated_at = ?
       WHERE id = ? AND status = 'connected'`,
      encrypted.ciphertext,
      encrypted.iv,
      new Date().toISOString(),
      id,
    );
  }

  /**
   * Whether a manual completion may activate this row. It may not while an
   * automated setup is still working on the row, nor when the row is pending
   * and its route was minted by such a setup: there is no manifest a person
   * could have installed against that URL, so completing would report
   * connected on a dead route. Cancelling the setup and reconnecting
   * regenerates a manual manifest. A connected row repairs in place, whoever
   * minted its route: a regenerated signing secret or a new bot token does
   * not change the route, and the revision it advances supersedes any
   * re-authorization consent still open.
   */
  slackManualCompletionBlocked(id: string): boolean {
    const row = this.ctx.storage.sql
      .exec<{ route_minted_by: string | null; status: string }>(
        `SELECT route_minted_by, status FROM channel_connections
         WHERE id = ? AND channel = 'slack'`,
        id,
      )
      .toArray()[0];
    if (!row) return false;
    if (row.status === "pending" && row.route_minted_by === "setup") return true;
    // A claim its holder never came back for is not a live setup; settle it
    // here rather than waiting for something to read the setup.
    this.settleSlackSetupClaimsWhere("connection_id = ?", id);
    const active = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM slack_setups
         WHERE connection_id = ? AND phase NOT IN ('cancelled', 'connected')
         LIMIT 1`,
        id,
      )
      .toArray()[0];
    return Boolean(active);
  }

  /** Apply the lazy claim expiry to every creating/exchanging setup matching a predicate. */
  private settleSlackSetupClaimsWhere(
    predicate: string,
    ...bindings: SqlStorageValue[]
  ): void {
    const rows = this.ctx.storage.sql
      .exec<SlackSetupRow>(
        `SELECT * FROM slack_setups
         WHERE phase IN ('creating', 'exchanging') AND ${predicate}`,
        ...bindings,
      )
      .toArray();
    for (const row of rows) this.settleSlackSetupClaims(row);
  }

  /**
   * The request's view of a connection for a manual completion: the
   * connection, the revision it is at, and whether completing is blocked
   * right now, read together. The revision binds the request: its writes
   * apply only while the connection is still what it saw.
   */
  slackConnectionView(
    id: string,
  ): { connection: SlackConnection; revision: number; completionBlocked: boolean } | null {
    return this.ctx.storage.transactionSync(() => {
      const connection = this.getSlackConnection(id);
      if (!connection) return null;
      return {
        connection,
        revision: this.channelConnectionFacts(id)?.revision ?? 0,
        completionBlocked: this.slackManualCompletionBlocked(id),
      };
    });
  }

  async completeSlackConnection(
    id: string,
    botToken: string,
    appId?: string,
    signingSecret?: string,
    /** The revision the request read before any await; a moved connection refuses it. */
    expectedRevision?: number,
  ): Promise<SlackConnection> {
    if (this.slackManualCompletionBlocked(id)) {
      throw new Error(SLACK_MANUAL_COMPLETION_BLOCKED);
    }
    if (!this.getSlackConnection(id)) {
      throw new Error("Slack connection was not found");
    }
    // Everything that awaits comes first: Slack's answer and the encryption.
    // A reservation may take the row during either.
    const installation = await resolveSlackInstallation(botToken, appId);
    const encrypted = await this.encryptSecret(
      JSON.stringify({ botToken, ...(signingSecret ? { signingSecret } : {}) }),
    );
    // Then one transaction: the block re-evaluated against the rows as they
    // are now, and the write, with nothing in between.
    return this.ctx.storage.transactionSync<SlackConnection>(() => {
      // Blocked now, or not the connection this request saw: either way the
      // save must not land on a row that has since changed hands.
      if (
        this.slackManualCompletionBlocked(id) ||
        (expectedRevision !== undefined &&
          this.channelConnectionFacts(id)?.revision !== expectedRevision)
      ) {
        throw new Error(SLACK_MANUAL_COMPLETION_BLOCKED);
      }
      const existing = this.getSlackConnection(id);
      if (!existing) throw new Error("Slack connection was not found");
      if (!this.getConnection(id)) {
        const timestamp = new Date().toISOString();
        this.ctx.storage.sql.exec(
          `INSERT INTO connections (
             id, kind, provider, label, owner_user_id, agent_id, alias, external_account_id,
             display_name, scopes_json, credential_ciphertext, credential_iv,
             oauth_state_hash, status, created_at, updated_at
           ) VALUES (?, 'channel', 'slack', 'slack', '', ?, ?, NULL, NULL, '[]',
                     NULL, NULL, NULL, 'pending', ?, ?)`,
          id,
          existing.agentId,
          existing.alias,
          timestamp,
          timestamp,
        );
      }
      this.activateSlackConnectionRows(id, installation, encrypted);
      const connection = this.getSlackConnection(id);
      if (!connection) throw new Error("Slack connection was not found");
      return connection;
    });
  }

  /**
   * The writes that make a Slack connection live, shared by the manual
   * completion and the automated setup's commit so there is one definition of
   * "connected". Synchronous, so a caller can put it inside a transaction.
   */
  private activateSlackConnectionRows(
    id: string,
    installation: SlackInstallation,
    encrypted: { ciphertext: string; iv: string },
  ): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET app_name = COALESCE(app_name, ?), app_name_synced_at = ?, app_id = ?, team_id = ?, team_name = ?, bot_user_id = ?,
           verified_at = NULL, verification_error = NULL,
           revision = revision + 1,
           status = 'connected', updated_at = ?
       WHERE id = ? AND channel = 'slack'`,
      installation.appName ?? null,
      timestamp,
      installation.appId,
      installation.teamId,
      installation.teamName ?? null,
      installation.botUserId,
      timestamp,
      id,
    );
    this.ctx.storage.sql.exec(
      `UPDATE connections
       SET external_account_id = ?, display_name = ?,
           credential_ciphertext = ?, credential_iv = ?,
           status = 'connected', updated_at = ?
       WHERE id = ? AND provider = 'slack'`,
      installation.teamId,
      installation.teamName ?? installation.teamId,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      id,
    );
    // A new installation can point at a different workspace, where the same
    // Slack IDs belong to different people and channels — cached names were
    // resolved under the old credentials and must not carry over.
    this.ctx.storage.sql.exec(
      "DELETE FROM slack_identity_cache WHERE connection_id = ?",
      id,
    );
  }

  // ---------------------------------------------------------------------
  // Automated Slack setup: a durable record beside the connection.
  //
  // Every side effect against Slack is claimed here before the network call
  // and committed here after it, fenced on the attempt that claimed it, so a
  // retried or concurrent request can join an attempt but never repeat one.
  // ---------------------------------------------------------------------

  private channelConnectionFacts(id: string): {
    revision: number;
    status: string;
    appId: string | null;
    teamId: string | null;
  } | null {
    const row = this.ctx.storage.sql
      .exec<{
        revision: number;
        status: string;
        app_id: string | null;
        team_id: string | null;
      }>(
        `SELECT revision, status, app_id, team_id FROM channel_connections
         WHERE id = ? AND channel = 'slack'`,
        id,
      )
      .toArray()[0];
    return row
      ? { revision: row.revision, status: row.status, appId: row.app_id, teamId: row.team_id }
      : null;
  }

  /**
   * Whether a setup still owns its connection: the connection is at the
   * revision the setup (or its OAuth state) recorded, and in the status the
   * next write expects, pending before a first install, connected by this
   * very setup for a re-authorization. Matching app and workspace identity
   * alone is not ownership: a manual repair of the same app's credentials
   * advances the revision and this setup's consent must not overwrite it.
   */
  private slackSetupOwnsConnection(
    row: SlackSetupRow,
    expectedRevision: number,
  ): boolean {
    const facts = this.channelConnectionFacts(row.connection_id);
    if (!facts || facts.revision !== expectedRevision) return false;
    return row.team_id === null
      ? facts.status === "pending"
      : facts.status === "connected" &&
          facts.appId === row.app_id &&
          facts.teamId === row.team_id;
  }

  /** The connection changed hands: close the setup, publish and commit nothing. */
  private supersedeSlackSetup(row: SlackSetupRow, nonceHash?: string): void {
    const now = Date.now();
    const error = slackSetupError(
      "slack_setup_superseded",
      "The connection was changed another way while this setup was in progress; the app this setup created may still exist in your Slack app list. Manage the connection from its current state, or connect the app with manual setup.",
      false,
    );
    this.ctx.storage.sql.exec(
      `UPDATE slack_setups
       SET phase = 'cancelled', resume_phase = NULL, attempt_id = NULL, attempt_started_at = NULL,
           error_json = ?, updated_at = ?
       WHERE id = ?`,
      JSON.stringify(error),
      now,
      row.id,
    );
    this.ctx.storage.sql.exec(
      `UPDATE slack_oauth_states SET used_at = ?, result_code = 'superseded'
       WHERE setup_id = ? AND used_at IS NULL`,
      now,
      row.id,
    );
    if (nonceHash) {
      this.ctx.storage.sql.exec(
        "UPDATE slack_oauth_states SET result_code = 'superseded' WHERE nonce_hash = ?",
        nonceHash,
      );
    }
    logSlackSetupPhase(row.id, row.phase, "cancelled", error);
  }

  private slackSetupRow(id: string): SlackSetupRow | null {
    const row = this.ctx.storage.sql
      .exec<SlackSetupRow>("SELECT * FROM slack_setups WHERE id = ?", id)
      .toArray()[0];
    return row ? this.settleSlackSetupClaims(row) : null;
  }

  /**
   * Lazy expiry for a claim whose holder never came back: a create older
   * than its bound is uncertain (Slack may have made the app); an exchange
   * older than its bound falls back to the app for a fresh authorization
   * (the code it held is unusable by now). Applied on every read, so nothing
   * sits in a spinner and no alarm is needed.
   */
  private settleSlackSetupClaims(row: SlackSetupRow): SlackSetupRow {
    const now = Date.now();
    const startedAt = row.attempt_started_at ?? now;
    if (row.phase === "creating" && now - startedAt > SLACK_SETUP_CREATING_TTL_MS) {
      const error = slackSetupError(
        "slack_creation_uncertain",
        "The app creation attempt was interrupted before Slack answered. Check your Slack app list before creating another; an existing app can be connected with manual setup.",
        false,
      );
      this.ctx.storage.sql.exec(
        `UPDATE slack_setups
         SET phase = 'creation_uncertain', error_json = ?, updated_at = ?
         WHERE id = ? AND phase = 'creating' AND attempt_id IS ?`,
        JSON.stringify(error),
        now,
        row.id,
        row.attempt_id,
      );
      logSlackSetupPhase(row.id, "creating", "creation_uncertain", error);
    } else if (
      row.phase === "exchanging" &&
      now - startedAt > SLACK_SETUP_EXCHANGING_TTL_MS
    ) {
      const resume = row.resume_phase ?? "app_created";
      const error = slackSetupError(
        "slack_exchange_uncertain",
        "The installation was interrupted before it completed. Authorize again.",
        true,
      );
      this.ctx.storage.sql.exec(
        `UPDATE slack_setups
         SET phase = ?, resume_phase = NULL, attempt_id = NULL, attempt_started_at = NULL,
             error_json = ?, updated_at = ?
         WHERE id = ? AND phase = 'exchanging' AND attempt_id IS ?`,
        resume,
        JSON.stringify(error),
        now,
        row.id,
        row.attempt_id,
      );
      logSlackSetupPhase(row.id, "exchanging", resume, error);
    } else {
      return row;
    }
    return (
      this.ctx.storage.sql
        .exec<SlackSetupRow>("SELECT * FROM slack_setups WHERE id = ?", row.id)
        .toArray()[0] ?? row
    );
  }

  getSlackSetup(id: string): SlackSetupRecord | null {
    const row = this.slackSetupRow(id);
    return row ? slackSetupRecordFromRow(row) : null;
  }

  findSlackSetupByRequestKey(requestKey: string): SlackSetupRecord | null {
    const row = this.ctx.storage.sql
      .exec<SlackSetupRow>(
        "SELECT * FROM slack_setups WHERE request_key = ?",
        requestKey,
      )
      .toArray()[0];
    return row ? slackSetupRecordFromRow(this.settleSlackSetupClaims(row)) : null;
  }

  /** The latest setup that has not been cancelled for a target. */
  findSlackSetupForTarget(
    agentId: string,
    alias: string,
    channelId?: string,
  ): SlackSetupRecord | null {
    const row = this.ctx.storage.sql
      .exec<SlackSetupRow>(
        `SELECT * FROM slack_setups
         WHERE agent_id = ? AND alias = ? AND (? IS NULL OR channel_id = ?)
           AND phase <> 'cancelled'
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
        agentId,
        alias,
        channelId ?? null,
        channelId ?? null,
      )
      .toArray()[0];
    return row ? slackSetupRecordFromRow(this.settleSlackSetupClaims(row)) : null;
  }

  private activeSlackSetupForTarget(
    agentId: string,
    alias: string,
    channelId: string,
  ): SlackSetupRow | null {
    this.settleSlackSetupClaimsWhere(
      "agent_id = ? AND alias = ? AND channel_id = ?",
      agentId,
      alias,
      channelId,
    );
    const row = this.ctx.storage.sql
      .exec<SlackSetupRow>(
        `SELECT * FROM slack_setups
         WHERE agent_id = ? AND alias = ? AND channel_id = ?
           AND phase NOT IN ('cancelled', 'connected')
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
        agentId,
        alias,
        channelId,
      )
      .toArray()[0];
    return row ?? null;
  }

  /**
   * Reserve a setup, atomically with everything it depends on: one record
   * per request key, one active setup per target, never over a connected
   * connection, and the pending connection row it will complete (reused when
   * one already waits for this target, created otherwise).
   *
   * Two concurrent submissions with one key serialize here: the first
   * creates, the second is told it exists. Both then contend for the single
   * creation claim, so Slack is asked once.
   */
  reserveSlackSetup(input: {
    id: string;
    requestKey: string;
    projectId: string;
    ownerUserId?: string;
    agentId: string;
    alias: string;
    channelId: string;
    connectionId: string;
    webhookTokenHash: string;
    name: string;
    manifestJson: string;
  }): SlackSetupReservation {
    return this.ctx.storage.transactionSync<SlackSetupReservation>(() => {
      const existing = this.ctx.storage.sql
        .exec<SlackSetupRow>(
          "SELECT * FROM slack_setups WHERE request_key = ?",
          input.requestKey,
        )
        .toArray()[0];
      if (existing) {
        if (
          existing.agent_id !== input.agentId ||
          existing.alias !== input.alias ||
          existing.channel_id !== input.channelId ||
          existing.name !== input.name ||
          existing.project_id !== input.projectId
        ) {
          return { outcome: "conflict" };
        }
        return {
          outcome: "existing",
          record: slackSetupRecordFromRow(this.settleSlackSetupClaims(existing)),
        };
      }
      const current = this.findSlackConnectionForAlias(
        input.agentId,
        input.alias,
        input.channelId,
      );
      if (current?.status === "connected") return { outcome: "connected" };
      const active = this.activeSlackSetupForTarget(
        input.agentId,
        input.alias,
        input.channelId,
      );
      if (active) {
        return {
          outcome: "active",
          record: slackSetupRecordFromRow(this.settleSlackSetupClaims(active)),
        };
      }
      // The caller chose the connection id from the same lookup; honour a
      // pending row that still exists, otherwise create the one it named.
      // Either way the row records the webhook identity this setup's
      // manifest names, which the exchange commit checks in its transaction.
      if (this.getSlackConnection(input.connectionId)) {
        this.ctx.storage.sql.exec(
          `UPDATE channel_connections
           SET webhook_token_hash = ?, route_minted_by = 'setup', revision = revision + 1, updated_at = ?
           WHERE id = ? AND channel = 'slack'`,
          input.webhookTokenHash,
          new Date().toISOString(),
          input.connectionId,
        );
      } else {
        this.insertSlackConnectionRows({
          id: input.connectionId,
          channelId: input.channelId,
          agentId: input.agentId,
          alias: input.alias,
          appName: input.name,
          webhookTokenHash: input.webhookTokenHash,
          routeMintedBy: "setup",
        });
      }
      const now = Date.now();
      const revision = this.channelConnectionFacts(input.connectionId)?.revision ?? 0;
      this.ctx.storage.sql.exec(
        `INSERT INTO slack_setups (
           id, request_key, project_id, owner_user_id, agent_id, alias, channel_id,
           connection_id, webhook_token_hash, connection_revision, name, manifest_json, phase,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        input.id,
        input.requestKey,
        input.projectId,
        input.ownerUserId ?? null,
        input.agentId,
        input.alias,
        input.channelId,
        input.connectionId,
        input.webhookTokenHash,
        revision,
        input.name,
        input.manifestJson,
        now,
        now,
      );
      logSlackSetupPhase(input.id, "none", "prepared");
      const row = this.ctx.storage.sql
        .exec<SlackSetupRow>("SELECT * FROM slack_setups WHERE id = ?", input.id)
        .toArray()[0];
      if (!row) throw new Error("Slack setup was not stored");
      return { outcome: "created", record: slackSetupRecordFromRow(row) };
    });
  }

  /**
   * Record the outcome of publishing the setup's webhook route. The route
   * object refuses a publication older than the one it holds; a refusal, or
   * a connection that changed hands since the reservation, supersedes the
   * setup. Only a published, still-owned setup may claim creation.
   */
  recordSlackSetupRoutePublication(
    id: string,
    applied: boolean,
  ): "published" | "superseded" | "missing" {
    return this.ctx.storage.transactionSync<"published" | "superseded" | "missing">(() => {
      const row = this.slackSetupRow(id);
      if (!row) return "missing";
      if (row.phase === "cancelled") return "superseded";
      if (!applied || !this.slackSetupOwnsConnection(row, row.connection_revision)) {
        this.supersedeSlackSetup(row);
        return "superseded";
      }
      this.ctx.storage.sql.exec(
        `UPDATE slack_setups SET route_published_at = COALESCE(route_published_at, ?), updated_at = ?
         WHERE id = ?`,
        Date.now(),
        Date.now(),
        id,
      );
      return "published";
    });
  }

  /**
   * Claim the one creation attempt. In one transaction: the setup must be
   * `prepared` with a recoverable (or no) error, must still own its
   * connection at the revision it recorded, and must have had its route
   * published; then the winner is the caller whose UPDATE moved the row (see
   * decideApproval for why rowsWritten, not a timestamp). Ownership lost
   * here supersedes the setup before anything is sent to Slack.
   */
  claimSlackSetupCreation(id: string): SlackSetupCreationClaim {
    return this.ctx.storage.transactionSync<SlackSetupCreationClaim>(() => {
      const row = this.slackSetupRow(id);
      if (!row) return { status: "missing" };
      const record = () => slackSetupRecordFromRow(this.slackSetupRow(id) ?? row);
      if (row.phase !== "prepared") return { status: "joined", record: record() };
      const error = row.error_json
        ? (JSON.parse(row.error_json) as SlackSetupError)
        : null;
      if (error && !error.recoverable) return { status: "refused", record: record() };
      if (!this.slackSetupOwnsConnection(row, row.connection_revision)) {
        this.supersedeSlackSetup(row);
        return { status: "superseded", record: record() };
      }
      if (row.route_published_at === null) {
        return { status: "unpublished", record: record() };
      }
      const attemptId = crypto.randomUUID();
      const now = Date.now();
      const changed = this.ctx.storage.sql.exec(
        `UPDATE slack_setups
         SET phase = 'creating', attempt_id = ?, attempt_started_at = ?, error_json = NULL, updated_at = ?
         WHERE id = ? AND phase = 'prepared'`,
        attemptId,
        now,
        now,
        id,
      ).rowsWritten;
      if (changed === 0) return { status: "joined", record: record() };
      logSlackSetupPhase(id, "prepared", "creating");
      return { status: "claimed", attemptId, record: record() };
    });
  }

  /**
   * Commit what the creation attempt learned. Fenced on the attempt id, so a
   * commit from an attempt the record no longer recognises changes nothing.
   *
   * On success the signing secret is also written onto the pending connection
   * so signed events verify from the first one, while the connection stays
   * pending until a bot token exists.
   */
  async commitSlackSetupCreation(
    id: string,
    attemptId: string,
    outcome: SlackSetupCreationOutcome,
  ): Promise<SlackSetupRecord | null> {
    const now = Date.now();
    if (outcome.kind === "created") {
      const clientSecret = await this.encryptSecret(outcome.clientSecret);
      const signingSecret = await this.encryptSecret(outcome.signingSecret);
      const credential = await this.encryptSecret(
        JSON.stringify({ signingSecret: outcome.signingSecret }),
      );
      const committed = this.ctx.storage.transactionSync<boolean>(() => {
        const row = this.ctx.storage.sql
          .exec<SlackSetupRow>("SELECT * FROM slack_setups WHERE id = ?", id)
          .toArray()[0];
        const changed = this.ctx.storage.sql.exec(
          `UPDATE slack_setups
           SET phase = 'app_created', attempt_id = NULL, attempt_started_at = NULL,
               app_id = ?, client_id = ?,
               client_secret_ciphertext = ?, client_secret_iv = ?,
               signing_secret_ciphertext = ?, signing_secret_iv = ?,
               error_json = NULL, updated_at = ?
           WHERE id = ? AND attempt_id = ? AND phase IN ('creating', 'creation_uncertain')`,
          outcome.appId,
          outcome.clientId,
          clientSecret.ciphertext,
          clientSecret.iv,
          signingSecret.ciphertext,
          signingSecret.iv,
          now,
          id,
          attemptId,
        ).rowsWritten;
        if (changed === 0 || !row) return false;
        logSlackSetupPhase(id, row.phase, "app_created");
        // The app's credentials are kept on the setup whatever happens next:
        // Slack returned them once. The connection only takes the signing
        // secret while this setup still owns it; a row a manual reconnect
        // took meanwhile must not carry another app's secret.
        const updated = this.ctx.storage.sql
          .exec<SlackSetupRow>("SELECT * FROM slack_setups WHERE id = ?", id)
          .toArray()[0];
        if (!updated) return false;
        if (!this.slackSetupOwnsConnection(updated, updated.connection_revision)) {
          this.supersedeSlackSetup(updated);
          return true;
        }
        this.ctx.storage.sql.exec(
          `UPDATE connections
           SET credential_ciphertext = ?, credential_iv = ?, updated_at = ?
           WHERE id = ? AND provider = 'slack' AND status = 'pending'`,
          credential.ciphertext,
          credential.iv,
          new Date(now).toISOString(),
          row.connection_id,
        );
        return true;
      });
      return committed ? this.getSlackSetup(id) : null;
    }
    const phase = outcome.kind === "rejected" ? "prepared" : "creation_uncertain";
    const row = this.ctx.storage.sql
      .exec<SlackSetupRow>("SELECT * FROM slack_setups WHERE id = ?", id)
      .toArray()[0];
    const changed = this.ctx.storage.sql.exec(
      `UPDATE slack_setups
       SET phase = ?, attempt_id = NULL, attempt_started_at = NULL, error_json = ?, updated_at = ?
       WHERE id = ? AND attempt_id = ? AND phase IN ('creating', 'creation_uncertain')`,
      phase,
      JSON.stringify(outcome.error),
      now,
      id,
      attemptId,
    ).rowsWritten;
    if (changed > 0 && row) logSlackSetupPhase(id, row.phase, phase, outcome.error);
    return changed > 0 ? this.getSlackSetup(id) : null;
  }

  /**
   * Issue a fresh OAuth state for a setup that has an app and still owns its
   * connection; the state records the connection revision it was issued at,
   * which the exchange must find unchanged. Earlier unused states are closed
   * as expired: a consent page left open from before this one cannot
   * complete any more.
   */
  issueSlackOAuthState(
    setupId: string,
    nonceHash: string,
  ):
    | { status: "issued"; expiresAt: string }
    | { status: "superseded" | "unavailable" } {
    const now = Date.now();
    const expiresAt = now + SLACK_OAUTH_STATE_TTL_MS;
    return this.ctx.storage.transactionSync<
      { status: "issued"; expiresAt: string } | { status: "superseded" | "unavailable" }
    >(() => {
      const row = this.slackSetupRow(setupId);
      if (!row || (row.phase !== "app_created" && row.phase !== "connected")) {
        return { status: "unavailable" };
      }
      if (!this.slackSetupOwnsConnection(row, row.connection_revision)) {
        this.supersedeSlackSetup(row);
        return { status: "superseded" };
      }
      this.ctx.storage.sql.exec(
        `UPDATE slack_oauth_states
         SET used_at = ?, result_code = 'authorization_expired'
         WHERE setup_id = ? AND used_at IS NULL`,
        now,
        setupId,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM slack_oauth_states WHERE expires_at < ? AND used_at IS NOT NULL`,
        now - 24 * 60 * 60_000,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO slack_oauth_states (nonce_hash, setup_id, created_at, expires_at, connection_revision)
         VALUES (?, ?, ?, ?, ?)`,
        nonceHash,
        setupId,
        now,
        expiresAt,
        row.connection_revision,
      );
      return { status: "issued", expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  /**
   * Consume a state exactly once. An expired state is closed with that
   * result so a later replay answers the same; a state already used answers
   * with what it recorded, and Slack is never asked twice.
   */
  claimSlackOAuthState(nonceHash: string): SlackOAuthStateClaim {
    const now = Date.now();
    return this.ctx.storage.transactionSync<SlackOAuthStateClaim>(() => {
      const row = this.ctx.storage.sql
        .exec<SlackOAuthStateRow>(
          "SELECT * FROM slack_oauth_states WHERE nonce_hash = ?",
          nonceHash,
        )
        .toArray()[0];
      if (!row) return { status: "missing" };
      if (row.used_at !== null) {
        return {
          status: "used",
          setupId: row.setup_id,
          resultCode: (row.result_code as SlackSetupResult | null) ?? null,
        };
      }
      if (row.expires_at <= now) {
        this.ctx.storage.sql.exec(
          `UPDATE slack_oauth_states SET used_at = ?, result_code = 'authorization_expired'
           WHERE nonce_hash = ? AND used_at IS NULL`,
          now,
          nonceHash,
        );
        this.recordSlackSetupFailure(
          row.setup_id,
          slackSetupError(
            "slack_authorization_expired",
            "The Slack authorization expired before it was completed. Authorize again.",
            true,
          ),
        );
        return { status: "expired", setupId: row.setup_id };
      }
      const changed = this.ctx.storage.sql.exec(
        `UPDATE slack_oauth_states SET used_at = ?
         WHERE nonce_hash = ? AND used_at IS NULL AND expires_at > ?`,
        now,
        nonceHash,
        now,
      ).rowsWritten;
      return changed > 0
        ? { status: "claimed", setupId: row.setup_id }
        : { status: "used", setupId: row.setup_id, resultCode: null };
    });
  }

  /** An outcome decided at the callback without an exchange: denied, or a malformed code. */
  recordSlackOAuthResult(
    nonceHash: string,
    setupId: string,
    result: SlackSetupResult,
    error: SlackSetupError,
  ): SlackSetup | null {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE slack_oauth_states SET result_code = ? WHERE nonce_hash = ?",
        result,
        nonceHash,
      );
      this.recordSlackSetupFailure(setupId, error);
    });
    return this.getSlackSetup(setupId)?.setup ?? null;
  }

  /** Attach an error to a setup that is waiting for an authorization, without moving it. */
  private recordSlackSetupFailure(setupId: string, error: SlackSetupError): void {
    this.ctx.storage.sql.exec(
      `UPDATE slack_setups SET error_json = ?, updated_at = ?
       WHERE id = ? AND phase IN ('app_created', 'connected')`,
      JSON.stringify(error),
      Date.now(),
      setupId,
    );
  }

  /**
   * Claim the one exchange for a consumed state, in one transaction with the
   * ownership check against the revision that state recorded; the phase left
   * is remembered for the fallback.
   */
  claimSlackExchange(
    setupId: string,
    attemptId: string,
    nonceHash: string,
  ): "claimed" | "superseded" | "stale" {
    return this.ctx.storage.transactionSync<"claimed" | "superseded" | "stale">(() => {
      const row = this.slackSetupRow(setupId);
      if (!row || (row.phase !== "app_created" && row.phase !== "connected")) {
        return "stale";
      }
      const state = this.ctx.storage.sql
        .exec<SlackOAuthStateRow>(
          "SELECT * FROM slack_oauth_states WHERE nonce_hash = ? AND setup_id = ?",
          nonceHash,
          setupId,
        )
        .toArray()[0];
      if (!state) return "stale";
      if (!this.slackSetupOwnsConnection(row, state.connection_revision)) {
        this.supersedeSlackSetup(row, nonceHash);
        return "superseded";
      }
      const now = Date.now();
      const changed = this.ctx.storage.sql.exec(
        `UPDATE slack_setups
         SET phase = 'exchanging', resume_phase = ?, attempt_id = ?, attempt_started_at = ?, updated_at = ?
         WHERE id = ? AND phase = ?`,
        row.phase,
        attemptId,
        now,
        now,
        setupId,
        row.phase,
      ).rowsWritten;
      if (changed === 0) return "stale";
      logSlackSetupPhase(setupId, row.phase, "exchanging");
      return "claimed";
    });
  }

  /** What the exchange needs, decrypted; nothing else leaves the record. */
  async slackSetupExchangeCredentials(setupId: string): Promise<{
    appId: string;
    clientId: string;
    clientSecret: string;
    botScopes: string[];
    teamId?: string;
  } | null> {
    const row = this.slackSetupRow(setupId);
    if (
      !row?.app_id ||
      !row.client_id ||
      !row.client_secret_ciphertext ||
      !row.client_secret_iv
    ) {
      return null;
    }
    return {
      appId: row.app_id,
      clientId: row.client_id,
      clientSecret: await this.decryptSecret(
        row.client_secret_ciphertext,
        row.client_secret_iv,
      ),
      botScopes: manifestBotScopes(
        JSON.parse(row.manifest_json) as Record<string, unknown>,
      ),
      ...(row.team_id ? { teamId: row.team_id } : {}),
    };
  }

  /**
   * Commit the exchange. A success activates the connection in the same
   * transaction as the setup update, but only if the setup still owns the
   * connection at the revision the consumed state recorded: pending before a
   * first install, connected by this very setup for a re-authorization, and
   * untouched by any other credential, status or routing write since the
   * consent was issued. Otherwise a manual completion, repair, reconnect or
   * disconnect won, the result is `superseded`, and the connection is not
   * touched. Activation advances the revision and the setup records it.
   */
  async commitSlackExchange(
    setupId: string,
    attemptId: string,
    nonceHash: string,
    outcome: SlackExchangeOutcome,
  ): Promise<SlackExchangeCommit> {
    const now = Date.now();
    const row = this.slackSetupRow(setupId);
    if (!row || row.phase !== "exchanging" || row.attempt_id !== attemptId) {
      return { result: "stale" };
    }
    const resume = row.resume_phase ?? "app_created";
    if (outcome.kind === "failed") {
      const changed = this.ctx.storage.transactionSync<number>(() => {
        this.ctx.storage.sql.exec(
          "UPDATE slack_oauth_states SET result_code = ? WHERE nonce_hash = ?",
          outcome.result,
          nonceHash,
        );
        return this.ctx.storage.sql.exec(
          `UPDATE slack_setups
           SET phase = ?, resume_phase = NULL, attempt_id = NULL, attempt_started_at = NULL,
               error_json = ?, updated_at = ?
           WHERE id = ? AND phase = 'exchanging' AND attempt_id = ?`,
          resume,
          JSON.stringify(outcome.error),
          now,
          setupId,
          attemptId,
        ).rowsWritten;
      });
      if (changed === 0) return { result: "stale" };
      logSlackSetupPhase(setupId, "exchanging", resume, outcome.error);
      const setup = this.getSlackSetup(setupId)?.setup;
      return setup ? { result: "failed", setup } : { result: "stale" };
    }
    if (!row.signing_secret_ciphertext || !row.signing_secret_iv) {
      throw new Error("Slack setup has no signing secret to activate with");
    }
    const signingSecret = await this.decryptSecret(
      row.signing_secret_ciphertext,
      row.signing_secret_iv,
    );
    const encrypted = await this.encryptSecret(
      JSON.stringify({ botToken: outcome.botToken, signingSecret }),
    );
    const committed = this.ctx.storage.transactionSync<"connected" | "superseded" | "stale">(() => {
      const fresh = this.ctx.storage.sql
        .exec<SlackSetupRow>("SELECT * FROM slack_setups WHERE id = ?", setupId)
        .toArray()[0];
      if (!fresh || fresh.phase !== "exchanging" || fresh.attempt_id !== attemptId) {
        return "stale";
      }
      const state = this.ctx.storage.sql
        .exec<SlackOAuthStateRow>(
          "SELECT * FROM slack_oauth_states WHERE nonce_hash = ? AND setup_id = ?",
          nonceHash,
          setupId,
        )
        .toArray()[0];
      if (!state || !this.slackSetupOwnsConnection(fresh, state.connection_revision)) {
        this.supersedeSlackSetup(fresh, nonceHash);
        return "superseded";
      }
      if (!this.getConnection(fresh.connection_id)) {
        const timestamp = new Date(now).toISOString();
        this.ctx.storage.sql.exec(
          `INSERT INTO connections (
             id, kind, provider, label, owner_user_id, agent_id, alias, external_account_id,
             display_name, scopes_json, credential_ciphertext, credential_iv,
             oauth_state_hash, status, created_at, updated_at
           ) VALUES (?, 'channel', 'slack', 'slack', '', ?, ?, NULL, NULL, '[]',
                     NULL, NULL, NULL, 'pending', ?, ?)`,
          fresh.connection_id,
          fresh.agent_id,
          fresh.alias,
          timestamp,
          timestamp,
        );
      }
      this.activateSlackConnectionRows(
        fresh.connection_id,
        outcome.installation,
        encrypted,
      );
      const revision =
        this.channelConnectionFacts(fresh.connection_id)?.revision ??
        state.connection_revision + 1;
      this.ctx.storage.sql.exec(
        `UPDATE slack_setups
         SET phase = 'connected', resume_phase = NULL, attempt_id = NULL, attempt_started_at = NULL,
             connection_revision = ?, team_id = ?, team_name = ?, bot_user_id = ?,
             error_json = NULL, updated_at = ?
         WHERE id = ?`,
        revision,
        outcome.installation.teamId,
        outcome.installation.teamName ?? null,
        outcome.installation.botUserId,
        now,
        setupId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE slack_oauth_states SET result_code = 'connected' WHERE nonce_hash = ?",
        nonceHash,
      );
      return "connected";
    });
    if (committed === "stale") return { result: "stale" };
    if (committed === "connected") {
      logSlackSetupPhase(setupId, "exchanging", "connected");
    }
    const setup = this.getSlackSetup(setupId)?.setup;
    if (!setup) return { result: "stale" };
    return { result: committed, setup };
  }

  /**
   * Cancel a setup that has not connected. The Slack app, if one exists, is
   * left alone and the record says so. A live claim is not cancellable: its
   * commit may still bring back credentials that cancelling would discard,
   * which is how an app gets orphaned.
   */
  cancelSlackSetup(id: string): {
    outcome: "cancelled" | "connected" | "busy" | "missing";
    setup?: SlackSetup;
  } {
    const row = this.slackSetupRow(id);
    if (!row) return { outcome: "missing" };
    if (row.phase === "connected") {
      return { outcome: "connected", setup: slackSetupFromRow(row) };
    }
    if (row.phase === "creating" || row.phase === "exchanging") {
      return { outcome: "busy", setup: slackSetupFromRow(row) };
    }
    if (row.phase !== "cancelled") {
      const mayHaveApp =
        row.phase === "app_created" || row.phase === "creation_uncertain";
      const note = mayHaveApp
        ? slackSetupError(
            "slack_setup_cancelled",
            "Setup cancelled. The Slack app created for it is not deleted and may still appear in the workspace's app list; remove it there or connect it with manual setup.",
            false,
          )
        : null;
      this.ctx.storage.sql.exec(
        `UPDATE slack_setups
         SET phase = 'cancelled', resume_phase = NULL, attempt_id = NULL, attempt_started_at = NULL,
             error_json = ?, updated_at = ?
         WHERE id = ?`,
        note ? JSON.stringify(note) : null,
        Date.now(),
        id,
      );
      // A consent page still open for this setup can only report that the
      // setup is gone; "authorize again" would be a lie.
      this.ctx.storage.sql.exec(
        `UPDATE slack_oauth_states SET used_at = ?, result_code = 'superseded'
         WHERE setup_id = ? AND used_at IS NULL`,
        Date.now(),
        id,
      );
      logSlackSetupPhase(id, row.phase, "cancelled", note ?? undefined);
    }
    const setup = this.getSlackSetup(id)?.setup;
    return setup ? { outcome: "cancelled", setup } : { outcome: "missing" };
  }

  /**
   * A distributed Slack app has one Request URL for every workspace that
   * installs it, so events cannot be routed by connection id in the path the
   * way a single-workspace connection is. This route names the app; the
   * workspace comes out of the payload.
   */
  async setChannelAppRoute(route: ChannelAppRoute): Promise<void> {
    await this.ctx.storage.put("channelAppRoute", route);
  }

  async getChannelAppRoute(): Promise<ChannelAppRoute | null> {
    return (
      (await this.ctx.storage.get<ChannelAppRoute>("channelAppRoute")) ?? null
    );
  }

  /** Publish a route; false when a newer publication for the connection already holds it. */
  async setChannelRoute(route: ChannelRoute): Promise<boolean> {
    const current = await this.getChannelRoute();
    if (
      current &&
      current.connectionId === route.connectionId &&
      current.revision !== undefined &&
      route.revision !== undefined &&
      route.revision < current.revision
    ) {
      return false;
    }
    await this.ctx.storage.put("channelRoute", route);
    // Written for one release so a rollback still resolves the route.
    await this.ctx.storage.put("slackRoute", route);
    return true;
  }

  async getChannelRoute(): Promise<ChannelRoute | null> {
    const current = await this.ctx.storage.get<ChannelRoute>("channelRoute");
    if (current) return current;
    // A route stored before this key existed can only be Slack's.
    const legacy = await this.ctx.storage.get<ChannelRoute>("slackRoute");
    if (!legacy) return null;
    const migrated = { ...legacy, provider: legacy.provider ?? "slack" };
    await this.ctx.storage.put("channelRoute", migrated);
    return migrated;
  }

  async clearChannelRoute(connectionId: string): Promise<void> {
    const route = await this.getChannelRoute();
    if (route?.connectionId === connectionId) {
      await this.ctx.storage.delete("channelRoute");
      await this.ctx.storage.delete("slackRoute");
    }
  }

  /** @deprecated Use setChannelRoute. */
  async setSlackRoute(route: ChannelRoute): Promise<void> {
    await this.setChannelRoute(route);
  }

  recordSlackVerification(
    connectionId: string,
    verified: boolean,
  ): SlackConnection {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET verified_at = CASE WHEN ? THEN ? ELSE verified_at END,
           verification_error = CASE WHEN ? THEN NULL ELSE 'signing_secret_mismatch' END,
           updated_at = ?
       WHERE id = ? AND channel = 'slack'`,
      verified ? 1 : 0,
      timestamp,
      verified ? 1 : 0,
      timestamp,
      connectionId,
    );
    const connection = this.getSlackConnection(connectionId);
    if (!connection) throw new Error("Slack connection was not found");
    return connection;
  }

  /**
   * Verify an inbound channel request against the connection's stored secret.
   *
   * Providers sign different material — Slack covers a timestamp and the raw
   * body, Twilio covers the request URL plus its sorted parameters — so the
   * adapter is handed the whole request rather than named header values, and
   * decides for itself what to check.
   */
  async verifyChannelRequest(
    provider: string,
    connectionId: string,
    input: { payload: string; headers: Record<string, string>; url: string },
  ): Promise<boolean> {
    const adapter = channelAdapter(provider);
    if (!adapter) return false;
    const secret = await this.channelSigningSecret(connectionId);
    if (!secret) return false;
    return adapter.verify({
      payload: input.payload,
      headers: new Headers(input.headers),
      url: input.url,
      secret,
    });
  }

  /** The shared secret a provider signs with, from the stored credential. */
  private async channelSigningSecret(
    connectionId: string,
  ): Promise<string | null> {
    const credential = this.connectionCredential(connectionId);
    if (!credential) return null;
    const parsed: unknown = JSON.parse(
      await this.decryptSecret(credential.ciphertext, credential.iv),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    // Slack stores `signingSecret`; Twilio's is the account auth token.
    for (const key of ["signingSecret", "authToken"]) {
      if (typeof record[key] === "string" && record[key]) {
        return record[key] as string;
      }
    }
    return null;
  }

  /** @deprecated Use verifyChannelRequest. Kept for a rolling deploy. */
  async verifySlackRequest(
    connectionId: string,
    payload: string,
    timestamp: string | null,
    signature: string | null,
  ): Promise<boolean> {
    const credential = this.connectionCredential(connectionId);
    if (!credential || !timestamp || !signature) return false;
    const parsed: unknown = JSON.parse(
      await this.decryptSecret(credential.ciphertext, credential.iv),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("signingSecret" in parsed) ||
      typeof parsed.signingSecret !== "string"
    ) {
      return false;
    }
    return verifySlackSignature(
      payload,
      new Headers({
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      }),
      parsed.signingSecret,
    );
  }

  /** @deprecated Use getChannelRoute. */
  async getSlackRoute(): Promise<ChannelRoute | null> {
    return this.getChannelRoute();
  }

  /** @deprecated Use clearChannelRoute. */
  async clearSlackRoute(connectionId: string): Promise<void> {
    await this.clearChannelRoute(connectionId);
  }

  updateSlackConnectionStatus(
    id: string,
    status: ChannelConnectionStatus,
    /** The revision the caller's request was bound to; the write is skipped when it moved. */
    expectedRevision?: number,
  ): SlackConnection {
    return this.ctx.storage.transactionSync<SlackConnection>(() => {
    if (
      expectedRevision !== undefined &&
      this.channelConnectionFacts(id)?.revision !== expectedRevision
    ) {
      const current = this.getSlackConnection(id);
      if (!current) throw new Error("Slack connection was not found");
      return current;
    }
    if (status === "disconnected") {
      this.ctx.storage.sql.exec(
        `UPDATE channel_connections
         SET status = ?, token_ciphertext = NULL, token_iv = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND channel = 'slack'`,
        status,
        new Date().toISOString(),
        id,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE channel_connections
         SET status = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND channel = 'slack'`,
        status,
        new Date().toISOString(),
        id,
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE connections
       SET status = ?,
           credential_ciphertext = CASE WHEN ? = 'disconnected'
             THEN NULL ELSE credential_ciphertext END,
           credential_iv = CASE WHEN ? = 'disconnected'
             THEN NULL ELSE credential_iv END,
           updated_at = ?
       WHERE id = ? AND provider = 'slack'`,
      status,
      status,
      status,
      new Date().toISOString(),
      id,
    );
    const connection = this.getSlackConnection(id);
    if (!connection) throw new Error("Slack connection was not found");
    return connection;
    });
  }

  async postSlackReply(
    connectionId: string,
    input: {
      channelId: string;
      threadTimestamp: string;
      text: string;
    },
  ): Promise<string> {
    return postSlackMessage(await this.slackBotToken(connectionId), input);
  }

  async postSlackPrivateMessage(
    connectionId: string,
    externalUserId: string,
    text: string,
  ): Promise<string> {
    return postSlackDirectMessage(await this.slackBotToken(connectionId), {
      userId: externalUserId,
      text,
    });
  }

  bindSlackDestination(input: {
    connectionId: string;
    destination: string;
    conversationId: string;
    displayName: string;
  }): {
    connectionId: string;
    destination: string;
    conversationId: string;
    displayName: string;
    verifiedAt: string;
  } {
    const connection = this.getSlackConnection(input.connectionId);
    if (!connection || connection.status !== "connected") {
      throw new Error("Slack connection is not connected");
    }
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_destination_bindings
         (connection_id, destination, conversation_id, display_name,
          verified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, destination) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         display_name = excluded.display_name,
         verified_at = excluded.verified_at,
         updated_at = excluded.updated_at`,
      input.connectionId,
      input.destination,
      input.conversationId,
      input.displayName,
      timestamp,
      timestamp,
    );
    return { ...input, verifiedAt: timestamp };
  }

  async verifyAndBindSlackDestination(input: {
    connectionId: string;
    destination: string;
    conversationId: string;
  }): Promise<{
    connectionId: string;
    destination: string;
    conversationId: string;
    displayName: string;
    verifiedAt: string;
  }> {
    const conversation = await resolveSlackConversation(
      await this.slackBotToken(input.connectionId),
      input.conversationId,
    );
    if (conversation.isArchived) throw new Error("Slack conversation is archived");
    if (!conversation.isMember) {
      throw new Error("Invite the Slack app to this conversation first");
    }
    return this.bindSlackDestination({
      ...input,
      conversationId: conversation.id,
      displayName: `#${conversation.name}`,
    });
  }

  getSlackDestination(
    connectionId: string,
    destination: string,
  ): { conversationId: string; displayName: string; verifiedAt: string } | null {
    const row = this.ctx.storage.sql
      .exec<{
        conversation_id: string;
        display_name: string;
        verified_at: string;
      }>(
        `SELECT conversation_id, display_name, verified_at
         FROM channel_destination_bindings
         WHERE connection_id = ? AND destination = ?`,
        connectionId,
        destination,
      )
      .toArray()[0];
    return row
      ? {
          conversationId: row.conversation_id,
          displayName: row.display_name,
          verifiedAt: row.verified_at,
        }
      : null;
  }

  listSlackDestinations(connectionId: string): Array<{
    name: string;
    conversationId: string;
    displayName: string;
    verifiedAt: string;
  }> {
    return this.ctx.storage.sql
      .exec<{
        destination: string;
        conversation_id: string;
        display_name: string;
        verified_at: string;
      }>(
        `SELECT destination, conversation_id, display_name, verified_at
         FROM channel_destination_bindings
         WHERE connection_id = ? ORDER BY destination`,
        connectionId,
      )
      .toArray()
      .map((row) => ({
        name: row.destination,
        conversationId: row.conversation_id,
        displayName: row.display_name,
        verifiedAt: row.verified_at,
      }));
  }

  /**
   * Register a Slack app that many workspaces install, and the secret every
   * one of their requests is signed with.
   */
  async createChannelApp(input: {
    id: string;
    provider: string;
    externalAppId: string;
    agentId: string;
    alias: string;
    signingSecret: string;
    label: string;
  }): Promise<void> {
    const timestamp = new Date().toISOString();
    const encrypted = await this.encryptSecret(
      JSON.stringify({ signingSecret: input.signingSecret }),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_apps
         (id, provider, external_app_id, agent_id, alias, label,
          secret_ciphertext, secret_iv, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         external_app_id = excluded.external_app_id,
         agent_id = excluded.agent_id,
         alias = excluded.alias,
         label = excluded.label,
         secret_ciphertext = excluded.secret_ciphertext,
         secret_iv = excluded.secret_iv,
         updated_at = excluded.updated_at`,
      input.id,
      input.provider,
      input.externalAppId,
      input.agentId,
      input.alias,
      input.label,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
  }

  getChannelApp(id: string): ChannelAppRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<ChannelAppRow>("SELECT * FROM channel_apps WHERE id = ?", id)
      .toArray()[0];
    return row
      ? {
          id: row.id,
          provider: row.provider,
          externalAppId: row.external_app_id,
          agentId: row.agent_id,
          alias: row.alias,
          label: row.label,
        }
      : undefined;
  }

  async channelAppSigningSecret(id: string): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<ChannelAppRow>("SELECT * FROM channel_apps WHERE id = ?", id)
      .toArray()[0];
    if (!row) return null;
    const parsed: unknown = JSON.parse(
      await this.decryptSecret(row.secret_ciphertext, row.secret_iv),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const secret = (parsed as Record<string, unknown>).signingSecret;
    return typeof secret === "string" ? secret : null;
  }

  /**
   * The installation a workspace's event belongs to.
   *
   * This is the whole difference between one deployment serving one workspace
   * and one serving many: the connection is found by who sent the event, not
   * by what was in the URL.
   */
  findAppInstallation(
    appId: string,
    workspaceId: string,
  ): SlackConnection | undefined {
    const row = this.ctx.storage.sql
      .exec<ChannelConnectionRow>(
        `SELECT * FROM channel_connections
         WHERE app_id = ? AND team_id = ? AND channel = 'slack'
         ORDER BY updated_at DESC
         LIMIT 1`,
        appId,
        workspaceId,
      )
      .toArray()[0];
    return row ? slackConnectionFromRow(row) : undefined;
  }

  listAppInstallations(appId: string): SlackConnection[] {
    return this.ctx.storage.sql
      .exec<ChannelConnectionRow>(
        `SELECT * FROM channel_connections
         WHERE app_id = ? AND channel = 'slack'
         ORDER BY updated_at DESC
         LIMIT 500`,
        appId,
      )
      .toArray()
      .map(slackConnectionFromRow);
  }

  /**
   * Record one workspace's install of a shared app.
   *
   * Idempotent on (app, workspace) so a bulk import can be re-run: a
   * migration that cannot be repeated is a migration nobody dares start.
   */
  async upsertAppInstallation(input: {
    appId: string;
    provider: string;
    agentId: string;
    alias: string;
    channelId: string;
    workspaceId: string;
    botToken: string;
    signingSecret: string;
    tenantId?: string;
    workspaceName?: string;
  }): Promise<{ id: string; created: boolean }> {
    const existing = this.findAppInstallation(input.appId, input.workspaceId);
    const id = existing?.id ?? `chn_${crypto.randomUUID().replace(/-/g, "")}`;
    const timestamp = new Date().toISOString();
    const encrypted = await this.encryptSecret(
      JSON.stringify({
        botToken: input.botToken,
        signingSecret: input.signingSecret,
      }),
    );
    if (existing) {
      this.ctx.storage.sql.exec(
        `UPDATE channel_connections
         SET connected_account_id = ?, team_name = ?, token_ciphertext = ?,
             token_iv = ?, status = 'connected', revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        input.tenantId ?? existing.appName ?? "",
        input.workspaceName ?? null,
        encrypted.ciphertext,
        encrypted.iv,
        timestamp,
        id,
      );
      this.writeChannelConnectionCredential(id, input, encrypted, timestamp);
      return { id, created: false };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_connections
         (id, channel, agent_id, alias, external_channel_id, team_id,
          connected_account_id, app_id, team_name, token_ciphertext, token_iv,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)`,
      id,
      input.provider,
      input.agentId,
      input.alias,
      input.channelId,
      input.workspaceId,
      input.tenantId ?? "",
      input.appId,
      input.workspaceName ?? null,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    this.writeChannelConnectionCredential(id, input, encrypted, timestamp);
    return { id, created: true };
  }

  /**
   * Sending reads the credential from `connections`, not from the channel row,
   * so an installation that only writes the latter can receive messages and
   * never answer one. The wizard writes both; so must this.
   */
  private writeChannelConnectionCredential(
    id: string,
    input: { provider: string; agentId: string; alias: string; workspaceId: string },
    encrypted: { ciphertext: string; iv: string },
    timestamp: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (
         id, kind, provider, label, owner_user_id, agent_id, alias,
         external_account_id, display_name, scopes_json,
         credential_ciphertext, credential_iv, oauth_state_hash, status,
         created_at, updated_at
       ) VALUES (?, 'channel', ?, ?, '', ?, ?, ?, NULL, '[]', ?, ?, NULL,
                 'connected', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         external_account_id = excluded.external_account_id,
         credential_ciphertext = excluded.credential_ciphertext,
         credential_iv = excluded.credential_iv,
         status = 'connected',
         updated_at = excluded.updated_at`,
      id,
      input.provider,
      input.provider,
      input.agentId,
      input.alias,
      input.workspaceId,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
  }

  /**
   * Record a proposal. Lives here rather than on the session because a
   * decision arrives long after the session that made it has suspended, ended,
   * or been replaced — the same reason `channel_threads` lives here.
   */
  createApproval(input: {
    agentId: string;
    alias: string;
    deploymentId: string;
    sessionId?: string;
    turnId?: string;
    toolId: string;
    toolInput: unknown;
    preview: unknown;
    connectionId: string;
    provider: string;
    deliveryRef: Readonly<Record<string, unknown>>;
    deciderPrincipal?: string;
    idempotencyKey: string;
    expiresAt: string;
  }): {
    id: string;
    status: string;
    duplicate: boolean;
  } {
    const existing = this.ctx.storage.sql
      .exec<{ id: string; status: string }>(
        `SELECT id, status FROM approvals
         WHERE agent_id = ? AND alias = ? AND idempotency_key = ?`,
        input.agentId,
        input.alias,
        input.idempotencyKey,
      )
      .toArray()[0];
    if (existing) return { ...existing, duplicate: true };
    const id = `apr_${crypto.randomUUID().replace(/-/g, "")}`;
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO approvals
         (id, agent_id, alias, deployment_id, session_id, turn_id, tool_id,
          input_json, preview_json, connection_id, delivery_ref, provider,
          decider_principal, status, expires_at, idempotency_key,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      id,
      input.agentId,
      input.alias,
      input.deploymentId,
      input.sessionId ?? null,
      input.turnId ?? null,
      input.toolId,
      JSON.stringify(input.toolInput ?? null),
      JSON.stringify(input.preview ?? null),
      input.connectionId,
      JSON.stringify(input.deliveryRef),
      input.provider,
      input.deciderPrincipal ?? null,
      input.expiresAt,
      input.idempotencyKey,
      timestamp,
      timestamp,
    );
    return { id, status: "pending", duplicate: false };
  }

  /** Arm the alarm for a freshly recorded proposal's expiry. */
  async armApprovalExpiry(): Promise<void> {
    await this.resetAlarm();
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", id)
      .toArray()[0];
    return row ? approvalFromRow(row) : undefined;
  }

  /** Remember which message carries the card, so a decision can rewrite it. */
  recordApprovalMessage(id: string, externalMessageId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE approvals SET external_message_id = ?, updated_at = ? WHERE id = ?",
      externalMessageId,
      new Date().toISOString(),
      id,
    );
  }

  /**
   * Move a pending approval to a decision, and report whether this caller is
   * the one that moved it.
   *
   * Slack retries interactivity and people double-click, so exactly one writer
   * may win. Everything downstream of a decision — starting a session, running
   * the write, editing the card — hangs off that single `true`.
   */
  decideApproval(input: {
    id: string;
    choice: "approved" | "denied";
    decidedBy?: string;
  }): { decided: boolean; approval?: ApprovalRecord } {
    const timestamp = new Date().toISOString();
    // The winner is the caller whose UPDATE actually moved a row. Comparing a
    // timestamp instead looks equivalent and is not: two clicks landing in the
    // same millisecond write the same ISO string, and both would read it back
    // as theirs — which is precisely the case this guard exists for.
    //
    // `rowsWritten` counts index maintenance as well as the row, and `status`
    // is indexed here, so the test is "did anything move", not "exactly one".
    // The `WHERE` is on the primary key, so at most one row can match.
    const changed = this.ctx.storage.sql.exec(
      `UPDATE approvals
       SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      input.choice,
      input.decidedBy ?? null,
      timestamp,
      timestamp,
      input.id,
    ).rowsWritten;
    const approval = this.getApproval(input.id);
    return {
      decided: changed > 0,
      ...(approval ? { approval } : {}),
    };
  }

  /**
   * Mark an approved proposal as being carried out, and report whether this
   * caller is the one that started it.
   *
   * Same shape as the decision CAS, for the same reason: a retried dispatch
   * must not run the write twice.
   */
  beginApply(id: string): { started: boolean; approval?: ApprovalRecord } {
    const timestamp = new Date().toISOString();
    const changed = this.ctx.storage.sql.exec(
      `UPDATE approvals
       SET status = 'applying', applying_at = ?, updated_at = ?
       WHERE id = ? AND status = 'approved'`,
      timestamp,
      timestamp,
      id,
    ).rowsWritten;
    const approval = this.getApproval(id);
    return {
      started: changed > 0,
      ...(approval ? { approval } : {}),
    };
  }

  /**
   * The write answered. Settle the record, put the outcome on the card, and
   * tell the agent in the conversation it asked in.
   *
   * Lives here rather than at the edge because the answer can arrive long
   * after the request that triggered it has ended — from a runtime frame, or
   * from the alarm sweeping something that never answered at all.
   */
  async completeApproval(
    id: string,
    outcome: { ok: boolean; result?: unknown; message?: string },
  ): Promise<void> {
    const approval = this.getApproval(id);
    if (!approval || approval.status === "applied" || approval.status === "failed") {
      return;
    }
    this.settleApproval({
      id,
      ...(outcome.ok
        ? { result: outcome.result }
        : { error: outcome.message ?? "The write failed" }),
    });
    const settled = this.getApproval(id);
    if (!settled) return;
    await this.rewriteApprovalCard(
      settled,
      outcome.ok ? "approved" : "failed",
      settled.decidedBy,
    );
    await this.notifyApprovalOutcome(
      settled,
      outcome.ok
        ? "approved it, and the change has been applied"
        : `approved it, but the change failed: ${outcome.message ?? "unknown error"}`,
    );
  }

  /** Put the decision on the card, so it stops being a question. */
  async rewriteApprovalCard(
    approval: ApprovalRecord,
    choice: "approved" | "denied" | "failed" | "unknown" | "applying",
    by?: string,
  ): Promise<void> {
    if (!approval.externalMessageId) return;
    const preview = approval.preview as { title?: unknown; summary?: unknown };
    await this.updateChannelMessage(
      approval.provider,
      approval.connectionId,
      approval.deliveryRef as Record<string, unknown>,
      approval.externalMessageId,
      {
        text: "",
        card: {
          approvalId: approval.id,
          title:
            typeof preview?.title === "string" ? preview.title : approval.toolId,
          ...(typeof preview?.summary === "string"
            ? { summary: preview.summary }
            : {}),
          facts: [],
          decided: {
            choice,
            ...(by ? { by } : {}),
            at: new Date().toISOString(),
          },
        },
      },
    ).catch(() => undefined);
  }

  /**
   * Let the agent know what was decided, in the conversation it asked in.
   *
   * Only the proposing session is told. Handing this to a fresh session would
   * mean an agent with no memory of the conversation announcing the outcome of
   * something it never asked for.
   */
  async notifyApprovalOutcome(
    approval: ApprovalRecord,
    outcome: string,
  ): Promise<void> {
    if (!approval.sessionId) return;
    const session = this.env.SESSIONS.getByName(approval.sessionId);
    const snapshot = await session.snapshot().catch(() => null);
    if (
      !snapshot ||
      snapshot.status === "ended" ||
      snapshot.status === "failed" ||
      snapshot.microvmState === "terminated"
    ) {
      return;
    }
    const preview = approval.preview as { title?: unknown };
    const what =
      typeof preview?.title === "string" ? preview.title : approval.toolId;
    const who = approval.decidedBy ?? "Someone";
    const text = `${who} ${outcome}: ${what}`;
    await session
      .enqueueChannelTurn(
        {
          input: `[Decision] ${text}`,
          // `channel` is not optional on a channel input, and an agent that
          // reads it — as the type says it may — crashes on a bag that is not
          // there. Only what is certainly known is filled in; the rest of the
          // fields are optional precisely so they can be left out.
          agentInput: {
            source: "channel",
            text,
            channel: {
              provider: approval.provider,
              connectionId: approval.connectionId,
              ...(approval.decidedBy ? { userId: approval.decidedBy } : {}),
            },
          },
          idempotencyKey: `approval-outcome:${approval.id}`,
        },
        {
          provider: approval.provider,
          connectionId: approval.connectionId,
          ...(approval.decidedBy ? { externalUserId: approval.decidedBy } : {}),
          deliveryRef: approval.deliveryRef,
        },
      )
      .catch(() => undefined);
  }

  /**
   * Which session is carrying the write out.
   *
   * Recorded before the frame is sent, so that a runtime which is not up yet
   * can pick the work up when it connects. Without this a decision that
   * arrived while the session was cold was never attempted again — the sweep
   * only gives up, it does not retry.
   */
  recordApplyTarget(id: string, sessionId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET apply_session_id = ?, updated_at = ?
       WHERE id = ? AND status = 'applying'`,
      sessionId,
      new Date().toISOString(),
      id,
    );
  }

  /** Writes waiting on this session's runtime to appear. */
  pendingAppliesForSession(sessionId: string): ApprovalRecord[] {
    return this.ctx.storage.sql
      .exec<ApprovalRow>(
        `SELECT * FROM approvals
         WHERE status = 'applying' AND apply_session_id = ?
         ORDER BY applying_at LIMIT 10`,
        sessionId,
      )
      .toArray()
      .map(approvalFromRow);
  }

  /** The write landed, or it did not. Either way it is over. */
  settleApproval(input: {
    id: string;
    result?: unknown;
    error?: string;
  }): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE approvals
       SET status = ?, applied_at = ?, result_json = ?, error = ?, updated_at = ?
       WHERE id = ?`,
      input.error ? "failed" : "applied",
      timestamp,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error ?? null,
      timestamp,
      input.id,
    );
  }

  listApprovals(agentId: string, alias: string): ApprovalRecord[] {
    return this.ctx.storage.sql
      .exec<ApprovalRow>(
        `SELECT * FROM approvals
         WHERE agent_id = ? AND alias = ?
         ORDER BY created_at DESC
         LIMIT 100`,
        agentId,
        alias,
      )
      .toArray()
      .map(approvalFromRow);
  }

  createOutboxItem(input: {
    agentId: string;
    alias: string;
    deploymentId: string;
    sessionId?: string;
    outboxId: string;
    eventType: string;
    idempotencyKey: string;
    content: unknown;
  }): { id: string; status: string; duplicate: boolean } {
    const existing = this.ctx.storage.sql
      .exec<{ id: string; status: string }>(
        `SELECT id, status FROM outbox_items
         WHERE agent_id = ? AND alias = ? AND outbox_id = ?
           AND idempotency_key = ?`,
        input.agentId,
        input.alias,
        input.outboxId,
        input.idempotencyKey,
      )
      .toArray()[0];
    if (existing) return { ...existing, duplicate: true };
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO outbox_items
         (id, agent_id, alias, deployment_id, session_id, outbox_id, event_type,
          idempotency_key, content_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      input.agentId,
      input.alias,
      input.deploymentId,
      input.sessionId ?? null,
      input.outboxId,
      input.eventType,
      input.idempotencyKey,
      JSON.stringify(input.content),
      timestamp,
      timestamp,
    );
    return { id, status: "pending", duplicate: false };
  }

  listOutboxItems(
    agentId: string,
    alias: string,
    limit = 50,
  ): Array<{
    id: string;
    outboxId: string;
    eventType: string;
    sessionId?: string;
    contentPreview: { title?: string; body?: string; url?: string };
    status: string;
    destination?: string;
    attemptCount: number;
    error?: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return this.ctx.storage.sql
      .exec<{
        id: string;
        outbox_id: string;
        event_type: string;
        session_id: string | null;
        content_json: string;
        status: string;
        destination: string | null;
        attempt_count: number;
        error: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id, outbox_id, event_type, session_id, content_json,
                status, destination,
                attempt_count, error, created_at, updated_at
         FROM outbox_items
         WHERE agent_id = ? AND alias = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        agentId,
        alias,
        safeLimit,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        outboxId: row.outbox_id,
        eventType: row.event_type,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        contentPreview: outboxContentPreview(row.content_json),
        status: row.status,
        ...(row.destination ? { destination: row.destination } : {}),
        attemptCount: row.attempt_count,
        ...(row.error ? { error: row.error } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  async deliverOutboxItem(input: {
    id: string;
    connectionId: string;
    destination: string;
    conversationId: string;
    text: string;
  }): Promise<void> {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE outbox_items SET status = 'delivering', connection_id = ?,
         destination = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ? AND external_message_id IS NULL`,
      input.connectionId,
      input.destination,
      timestamp,
      input.id,
    );
    try {
      const external = await postSlackConversationMessage(
        await this.slackBotToken(input.connectionId),
        { channelId: input.conversationId, text: input.text },
      );
      this.ctx.storage.sql.exec(
        `UPDATE outbox_items SET status = 'delivered', external_message_id = ?,
           error = NULL, updated_at = ? WHERE id = ?`,
        external,
        new Date().toISOString(),
        input.id,
      );
      await this.recordSlackDelivery(input.connectionId, "delivered");
    } catch (error) {
      this.ctx.storage.sql.exec(
        `UPDATE outbox_items SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        error instanceof Error ? error.message.slice(0, 500) : "Slack delivery failed",
        new Date().toISOString(),
        input.id,
      );
      await this.recordSlackDelivery(
        input.connectionId,
        "failed",
        "outbox_delivery_failed",
      );
      throw error;
    }
  }

  recordSlackEvent(connectionId: string): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET last_event_at = ?, updated_at = ?
       WHERE id = ? AND channel = 'slack'`,
      timestamp,
      timestamp,
      connectionId,
    );
  }

  /**
   * Record the outcome of a delivery against the connection that made it.
   *
   * The provider is part of the predicate rather than assumed, because the
   * Slack-only version filtered `channel = 'slack'` — so a Twilio delivery
   * would have updated no rows and reported success, which is the worst kind
   * of wrong: a metric that is quietly always fine.
   */
  recordChannelDelivery(
    provider: string,
    connectionId: string,
    status: "delivered" | "failed",
    errorCategory?: string,
  ): void {
    const timestamp = new Date().toISOString();
    if (errorCategory) {
      this.ctx.storage.sql.exec(
        `UPDATE channel_connections
         SET last_delivery_status = ?, last_delivery_at = ?,
             last_error_category = ?, last_error_at = ?, updated_at = ?
         WHERE id = ? AND channel = ?`,
        status,
        timestamp,
        errorCategory,
        timestamp,
        timestamp,
        connectionId,
        provider,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET last_delivery_status = ?, last_delivery_at = ?, updated_at = ?
       WHERE id = ? AND channel = ?`,
      status,
      timestamp,
      timestamp,
      connectionId,
      provider,
    );
  }

  /** @deprecated Use recordChannelDelivery. */
  recordSlackDelivery(
    connectionId: string,
    status: "delivered" | "failed",
    errorCategory?: string,
  ): void {
    const timestamp = new Date().toISOString();
    if (errorCategory) {
      this.ctx.storage.sql.exec(
        `UPDATE channel_connections
         SET last_delivery_status = ?, last_delivery_at = ?,
             last_error_category = ?, last_error_at = ?, updated_at = ?
         WHERE id = ? AND channel = 'slack'`,
        status,
        timestamp,
        errorCategory,
        timestamp,
        timestamp,
        connectionId,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET last_delivery_status = ?, last_delivery_at = ?, updated_at = ?
       WHERE id = ? AND channel = 'slack'`,
      status,
      timestamp,
      timestamp,
      connectionId,
    );
  }

  recordSlackError(connectionId: string, category: string): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connections
       SET last_error_category = ?, last_error_at = ?, updated_at = ?
       WHERE id = ? AND channel = 'slack'`,
      category,
      timestamp,
      timestamp,
      connectionId,
    );
  }

  /**
   * Send an agent reply on whichever provider the conversation came from.
   * The target is the adapter's own `delivery_ref`, handed back untouched, so
   * this method never learns what a channel or a phone number is.
   */
  async sendChannelReply(
    provider: string,
    connectionId: string,
    target: Record<string, unknown>,
    text: string,
  ): Promise<void> {
    const adapter = channelAdapter(provider);
    if (!adapter) throw new Error(`No adapter for provider ${provider}`);
    await adapter.send({
      target,
      text,
      credential: await this.channelCredential(connectionId),
    });
  }

  /**
   * Post one activity to a Linear agent session as the connection's app user
   * (work 037 S3). The Session object owns order and retries; this attaches
   * the token. The client id makes a repeat safe: Linear's conflict on that
   * id is reported as posted, reconciled by reading the activity back.
   */
  async postLinearActivity(
    connectionId: string,
    post: LinearActivityPost,
  ): Promise<LinearActivityPostResult> {
    return postLinearActivityWith(this.linearConnections, connectionId, post);
  }

  /** Set a Linear agent session's external link (a pull request), as the app user. */
  async setLinearSessionExternalLink(
    connectionId: string,
    agentSessionId: string,
    link: LinearSessionLink,
  ): Promise<LinearSessionUpdateResult> {
    return setLinearSessionExternalLinkWith(
      this.linearConnections,
      connectionId,
      agentSessionId,
      link,
    );
  }

  /**
   * Post an `ask` question with its options as buttons (slack-ux P2), and
   * report which message it is: for Slack the `ts`, which is also the
   * question's provider time.
   */
  async sendChannelQuestion(
    provider: string,
    connectionId: string,
    target: Record<string, unknown>,
    card: QuestionCard,
  ): Promise<string> {
    const adapter = channelAdapter(provider);
    if (!adapter?.sendQuestion) {
      throw new Error(`Provider ${provider} cannot post a question`);
    }
    return adapter.sendQuestion({
      target,
      text: card.text,
      card,
      credential: await this.channelCredential(connectionId),
    });
  }

  /** Rewrite a question card once its question is answered or closed. */
  async updateChannelQuestion(
    provider: string,
    connectionId: string,
    target: Record<string, unknown>,
    messageId: string,
    card: QuestionCard,
  ): Promise<void> {
    const adapter = channelAdapter(provider);
    if (!adapter?.updateQuestion) {
      throw new Error(`Provider ${provider} cannot rewrite a question`);
    }
    await adapter.updateQuestion({
      target,
      messageId,
      text: card.text,
      card,
      credential: await this.channelCredential(connectionId),
    });
  }

  /** Post the card that asks for a decision, and report which message it is. */
  async sendChannelCard(
    provider: string,
    connectionId: string,
    target: Record<string, unknown>,
    card: ApprovalCard,
  ): Promise<string> {
    const adapter = channelAdapter(provider);
    if (!adapter?.sendCard) {
      throw new Error(`Provider ${provider} cannot ask for a decision`);
    }
    return adapter.sendCard({
      target,
      text: card.title,
      card,
      credential: await this.channelCredential(connectionId),
    });
  }

  /** Rewrite a message already sent — a decided card, or a stale one. */
  async updateChannelMessage(
    provider: string,
    connectionId: string,
    target: Record<string, unknown>,
    messageId: string,
    input: { text: string; card?: ApprovalCard },
  ): Promise<void> {
    const adapter = channelAdapter(provider);
    if (!adapter?.updateMessage) {
      throw new Error(`Provider ${provider} cannot rewrite a message`);
    }
    await adapter.updateMessage({
      target,
      messageId,
      text: input.text,
      ...(input.card ? { card: input.card } : {}),
      credential: await this.channelCredential(connectionId),
    });
  }

  /** The decrypted provider credential, as the adapter expects to read it. */
  private async channelCredential(
    connectionId: string,
  ): Promise<Record<string, unknown>> {
    const credential = this.connectionCredential(connectionId);
    if (!credential) {
      throw new Error("Channel connection credentials are unavailable");
    }
    const parsed: unknown = JSON.parse(
      await this.decryptSecret(credential.ciphertext, credential.iv),
    );
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Channel connection credentials are malformed");
    }
    return parsed as Record<string, unknown>;
  }

  async setSlackStatus(
    connectionId: string,
    input: {
      channelId: string;
      threadTimestamp: string;
      status: SlackStatus;
    },
  ): Promise<void> {
    await setSlackThreadStatus(await this.slackBotToken(connectionId), input);
  }

  async startSlackStream(
    connectionId: string,
    input: {
      channelId: string;
      threadTimestamp?: string;
      recipientUserId?: string;
      taskDisplayMode?: "timeline" | "plan";
    },
  ): Promise<string> {
    return startSlackStream(await this.slackBotToken(connectionId), {
      ...input,
      recipientTeamId: this.slackTeamId(connectionId) ?? undefined,
    });
  }

  async appendSlackStream(
    connectionId: string,
    input: {
      channelId: string;
      messageTimestamp: string;
      chunks: readonly SlackStreamChunk[];
    },
  ): Promise<void> {
    await appendSlackStream(await this.slackBotToken(connectionId), input);
  }

  async stopSlackStream(
    connectionId: string,
    input: {
      channelId: string;
      messageTimestamp: string;
    },
  ): Promise<void> {
    await stopSlackStream(await this.slackBotToken(connectionId), input);
  }

  /**
   * Who a Slack ID is, looked up once and cached. User and channel names are
   * the same on the thousandth message as on the first, and users.info and
   * conversations.info are rated per call, so repeat messages should hit the
   * cache rather than Slack. A failed lookup is cached briefly too: installs
   * created before the name scopes existed answer missing_scope on every
   * call, and retrying per message would only buy rate limits.
   */
  async resolveSlackNames(
    connectionId: string,
    input: { userId: string; channelId?: string },
  ): Promise<{ userName?: string; channelName?: string }> {
    const token = await this.slackBotToken(connectionId);
    const resolve = async (
      kind: "user" | "channel",
      externalId: string,
    ): Promise<string | undefined> => {
      const cached = this.ctx.storage.sql
        .exec<{ display_name: string; resolved_at: string }>(
          `SELECT display_name, resolved_at
           FROM slack_identity_cache
           WHERE connection_id = ? AND kind = ? AND external_id = ?`,
          connectionId,
          kind,
          externalId,
        )
        .toArray()[0];
      const now = Date.now();
      if (cached) {
        const ttl = cached.display_name
          ? SLACK_NAME_RESOLVED_TTL_MS
          : SLACK_NAME_FAILED_TTL_MS;
        if (now - Date.parse(cached.resolved_at) < ttl) {
          return cached.display_name || undefined;
        }
      }
      let name = "";
      try {
        name =
          kind === "user"
            ? (await resolveSlackUser(token, externalId)).displayName
            : (await resolveSlackConversation(token, externalId)).name;
      } catch {
        // Installs minted before the name scopes existed answer missing_scope,
        // and private conversations the bot is outside answer
        // channel_not_found: the raw ID stands in for the name.
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO slack_identity_cache
           (connection_id, kind, external_id, display_name, resolved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, kind, external_id) DO UPDATE SET
           display_name = excluded.display_name,
           resolved_at = excluded.resolved_at`,
        connectionId,
        kind,
        externalId,
        name,
        new Date(now).toISOString(),
      );
      return name || undefined;
    };
    const [userName, channelName] = await Promise.all([
      resolve("user", input.userId),
      input.channelId
        ? resolve("channel", input.channelId)
        : Promise.resolve(undefined),
    ]);
    return {
      ...(userName ? { userName } : {}),
      ...(channelName ? { channelName } : {}),
    };
  }

  private slackTeamId(connectionId: string): string | null {
    const row = this.ctx.storage.sql
      .exec<Pick<ChannelConnectionRow, "team_id">>(
        `SELECT team_id FROM channel_connections WHERE id = ? AND channel = 'slack'`,
        connectionId,
      )
      .toArray()[0];
    return row?.team_id ?? null;
  }

  private async slackBotToken(connectionId: string): Promise<string> {
    const generic = this.connectionCredential(connectionId);
    if (generic) {
      const parsed: unknown = JSON.parse(
        await this.decryptSecret(generic.ciphertext, generic.iv),
      );
      if (
        parsed &&
        typeof parsed === "object" &&
        "botToken" in parsed &&
        typeof parsed.botToken === "string"
      ) {
        return parsed.botToken;
      }
    }
    const row = this.ctx.storage.sql
      .exec<Pick<ChannelConnectionRow, "token_ciphertext" | "token_iv">>(
        `SELECT token_ciphertext, token_iv
         FROM channel_connections
         WHERE id = ? AND channel = 'slack' AND status = 'connected'`,
        connectionId,
      )
      .toArray()[0];
    if (!row?.token_ciphertext || !row.token_iv) {
      throw new Error("Slack connection credentials are unavailable");
    }
    return this.decryptSecret(row.token_ciphertext, row.token_iv);
  }

  private connectionRow(id: string): ConnectionRow | undefined {
    return this.ctx.storage.sql
      .exec<ConnectionRow>(
        `SELECT id, kind, provider, label, owner_user_id, agent_id, alias,
                external_account_id, display_name, scopes_json,
                credential_ciphertext, credential_iv, oauth_state_hash,
                status, created_at, updated_at
         FROM connections
         WHERE id = ?`,
        id,
      )
      .toArray()[0];
  }

  private connectionCredential(
    id: string,
  ): { ciphertext: string; iv: string } | null {
    const row = this.connectionRow(id);
    return row?.credential_ciphertext && row.credential_iv
      ? { ciphertext: row.credential_ciphertext, iv: row.credential_iv }
      : null;
  }

  async bindManagedModelCredential(input: {
    provider: string;
    key: string;
    orKeyHash: string;
    operationId: string;
  }): Promise<string> {
    const existing = this.ctx.storage.sql
      .exec<ManagedModelCredentialRow>(
        `SELECT id, provider, or_key_hash, operation_id,
                credential_ciphertext, credential_iv, created_at, updated_at
         FROM managed_model_credentials
         WHERE provider = ?`,
        input.provider,
      )
      .toArray()[0];
    if (existing?.operation_id === input.operationId) return existing.id;

    const encrypted = await this.encryptSecret(input.key);
    const timestamp = new Date().toISOString();
    const id = `mmc_${crypto.randomUUID().replaceAll("-", "")}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO managed_model_credentials (
         provider, id, or_key_hash, operation_id, credential_ciphertext,
         credential_iv, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         id = excluded.id,
         or_key_hash = excluded.or_key_hash,
         operation_id = excluded.operation_id,
         credential_ciphertext = excluded.credential_ciphertext,
         credential_iv = excluded.credential_iv,
         updated_at = excluded.updated_at`,
      input.provider,
      id,
      input.orKeyHash,
      input.operationId,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    return id;
  }

  getManagedModelCredentialByHash(
    provider: string,
    orKeyHash: string,
  ): { id: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM managed_model_credentials
         WHERE provider = ? AND or_key_hash = ?`,
        provider,
        orKeyHash,
      )
      .toArray()[0];
    return row ? { id: row.id } : null;
  }

  deleteManagedModelCredential(provider: string): number {
    return Number(
      this.ctx.storage.sql.exec(
        "DELETE FROM managed_model_credentials WHERE provider = ?",
        provider,
      ).rowsWritten,
    );
  }

  async resolveManagedModelCredential(
    provider: string,
  ): Promise<{ id: string; key: string } | null> {
    const row = this.ctx.storage.sql
      .exec<ManagedModelCredentialRow>(
        `SELECT id, provider, or_key_hash, operation_id,
                credential_ciphertext, credential_iv, created_at, updated_at
         FROM managed_model_credentials
         WHERE provider = ?`,
        provider,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      key: await this.decryptSecret(
        row.credential_ciphertext,
        row.credential_iv,
      ),
    };
  }

  private async encryptSecret(
    value: string,
  ): Promise<{ ciphertext: string; iv: string }> {
    const key = await this.encryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(value),
    );
    return {
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      iv: bytesToBase64(iv),
    };
  }

  private async decryptSecret(ciphertext: string, iv: string): Promise<string> {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv) },
      await this.encryptionKey(),
      base64ToBytes(ciphertext),
    );
    return new TextDecoder().decode(decrypted);
  }

  private async encryptionKey(): Promise<CryptoKey> {
    const encoded = (this.env as Env & { BLUE_CHANNEL_ENCRYPTION_KEY?: string })
      .BLUE_CHANNEL_ENCRYPTION_KEY;
    if (!encoded) {
      throw new Error("BLUE_CHANNEL_ENCRYPTION_KEY is not configured");
    }
    const bytes = base64ToBytes(encoded);
    if (bytes.byteLength !== 32) {
      throw new Error("BLUE_CHANNEL_ENCRYPTION_KEY must contain 32 bytes");
    }
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  getChannelThreadSession(
    connectionId: string,
    externalThreadId: string,
  ): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ session_id: string }>(
          `SELECT session_id FROM channel_threads
           WHERE connection_id = ? AND external_thread_id = ?`,
          connectionId,
          externalThreadId,
        )
        .toArray()[0]?.session_id ?? null
    );
  }

  setChannelThreadSession(
    connectionId: string,
    externalThreadId: string,
    sessionId: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_threads (
         connection_id, external_thread_id, session_id, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(connection_id, external_thread_id) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
      connectionId,
      externalThreadId,
      sessionId,
      new Date().toISOString(),
    );
  }

  resolveChannelIdentity(
    connectionId: string,
    externalUserId: string,
  ): string | null {
    const workspace = this.ctx.storage.sql
      .exec<{ team_id: string | null }>(
        `SELECT team_id FROM channel_connections
         WHERE id = ? AND channel = 'slack'`,
        connectionId,
      )
      .toArray()[0]?.team_id;
    return (
      this.ctx.storage.sql
        .exec<{ user_id: string | null }>(
          `SELECT identity.user_id
           FROM channel_identities identity
           JOIN channel_connections channel
             ON channel.id = identity.connection_id
           WHERE identity.external_user_id = ?
             AND identity.user_id IS NOT NULL
             AND channel.channel = 'slack'
             AND channel.team_id = ?
           ORDER BY identity.updated_at DESC
           LIMIT 1`,
          externalUserId,
          workspace ?? "",
        )
        .toArray()[0]?.user_id ?? null
    );
  }

  issueChannelIdentityLink(input: {
    connectionId: string;
    externalUserId: string;
    tokenHash: string;
    expiresAt: string;
  }): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `DELETE FROM channel_identities
       WHERE user_id IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      timestamp,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_identities (
         connection_id, external_user_id, user_id, link_token_hash,
         expires_at, updated_at
       ) VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(connection_id, external_user_id) DO UPDATE SET
         link_token_hash = excluded.link_token_hash,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      input.connectionId,
      input.externalUserId,
      input.tokenHash,
      input.expiresAt,
      timestamp,
    );
  }

  claimChannelIdentityLink(tokenHash: string, userId: string): boolean {
    const timestamp = new Date().toISOString();
    const row = this.ctx.storage.sql
      .exec<{ connection_id: string }>(
        `UPDATE channel_identities
         SET user_id = ?, link_token_hash = NULL, expires_at = NULL,
             updated_at = ?
         WHERE link_token_hash = ? AND expires_at > ?
         RETURNING connection_id`,
        userId,
        timestamp,
        tokenHash,
        timestamp,
      )
      .toArray()[0];
    if (!row) {
      this.ctx.storage.sql.exec(
        `DELETE FROM channel_identities
         WHERE user_id IS NULL AND link_token_hash = ?
           AND expires_at IS NOT NULL AND expires_at <= ?`,
        tokenHash,
        timestamp,
      );
    }
    return Boolean(row);
  }

  issueChannelConnectionGrant(input: {
    tokenHash: string;
    connectionId: string;
    externalUserId: string;
    principalUserId: string;
    service: string;
    label: string;
    expiresAt: string;
  }): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "DELETE FROM channel_connection_grants WHERE expires_at <= ? OR consumed_at IS NOT NULL",
      timestamp,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_connection_grants (
         token_hash, connection_id, external_user_id, principal_user_id,
         service, label, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      input.tokenHash,
      input.connectionId,
      input.externalUserId,
      input.principalUserId,
      input.service,
      input.label,
      input.expiresAt,
      timestamp,
    );
  }

  claimChannelConnectionGrant(
    tokenHash: string,
  ): ChannelConnectionGrant | null {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "DELETE FROM channel_connection_grants WHERE expires_at <= ? OR consumed_at IS NOT NULL",
      timestamp,
    );
    const row = this.ctx.storage.sql
      .exec<ChannelConnectionGrantRow>(
        `UPDATE channel_connection_grants
         SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING connection_id, external_user_id, principal_user_id,
                   service, label`,
        timestamp,
        tokenHash,
        timestamp,
      )
      .toArray()[0];
    return row
      ? {
          connectionId: row.connection_id,
          externalUserId: row.external_user_id,
          principalUserId: row.principal_user_id,
          service: row.service,
          label: row.label,
        }
      : null;
  }

  releaseChannelConnectionGrant(tokenHash: string): void {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE channel_connection_grants
       SET consumed_at = NULL
       WHERE token_hash = ? AND expires_at > ?`,
      tokenHash,
      timestamp,
    );
  }

  deleteChannelConnectionGrant(tokenHash: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM channel_connection_grants WHERE token_hash = ?",
      tokenHash,
    );
  }

  claimChannelEvent(id: string): boolean {
    const row = this.ctx.storage.sql
      .exec<{ id: string }>(
        `INSERT INTO channel_events (id, received_at)
         VALUES (?, ?)
         ON CONFLICT(id) DO NOTHING
         RETURNING id`,
        id,
        new Date().toISOString(),
      )
      .toArray()[0];
    return row?.id === id;
  }

  releaseChannelEvent(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM channel_events WHERE id = ?", id);
  }
}
