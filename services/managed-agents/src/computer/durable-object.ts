// ComputerDurableObject (work 052): one per organization (named by its
// accountId), holding everything about the organization's computer:
//
//   - the computer row and its lifecycle (lifecycle.ts), parking (parking.ts)
//   - the host WebSocket (hibernatable), Calvin's protocol (protocol.ts)
//   - the dispatch queue, sessions and people
//   - session secrets (secrets-store.ts), and the linked Slack workspace's bot token
//   - the Slack event queue: dedup, conversations, owner, acknowledge
//
// Ported from dash-cal's MachineBrokerDurableObject and
// SlackWorkspaceDurableObject, merged: here an organization has exactly one
// Slack workspace and one computer, so they share one object.
//
// The same class, named `computer-slack-team:<teamId>`, is the routing record
// that says which organization a Slack workspace is linked to; those objects
// only use `claimTeam`, `teamAccount` and `releaseTeam`. When another
// organization tries to link a workspace that is already linked, the callback
// asks the holder's object (`notifyJoinRequest`) to DM both people with the
// holder's bot token, which never leaves that object. Likewise, named
// `computer-connect-codes:<x>`, it routes a connect code's hash to its
// organization (connect-codes.ts); those only use the connect code index.
//
// Warm pool (pool.ts): objects named `pool-<random>` are pool computers (a
// lifecycle and a host socket, no Slack, never parked), and the object named
// `computer-pool` keeps the slot table. Reusing this class for both avoids a
// new Durable Object class and its migration; each role only touches its own
// tables and methods, and the dashboard and host routes refuse those names
// as organizations.
//
// Claim, step by step (ensureComputer → claimFromPool), and its latency:
//   1. the organization has no computer row and the pool is configured;
//   2. `computer-pool` picks a warm slot and marks it claiming (synchronous,
//      so atomic), then asks the slot's object to release it: that object
//      checks its host is connected and marks its row `transferred`, after
//      which it never parks, wakes or deletes the computer (two RPC hops);
//   3. this object writes its row `ready` on the slot's prefix, size and
//      disks (`adopt`; local SQL), with the tags still to move;
//   4. the slot's object sends its connected host `assign` with this
//      organization's host token and URL (one RPC hop, one frame); the
//      dashboard answer goes out here, a few tens of milliseconds in;
//   5. the host persists its new identity and reconnects here: `hello`
//      (seconds), and queued messages flow;
//   6. the lifecycle alarm moves the resources' tags from `pool` to the
//      organization (platform → ARM, a few seconds, off the answer's path).
// No hello as the organization within ASSIGN_ACK_MS is logged
// (`computer.pool_assign_unacknowledged`) and the computer shows
// `connected: false`; there is no rollback. If the host reconnects as the
// pool computer instead (it lost the assign), that object sends it again.
//
// Billing (work 052, "same as agent runtime which serverless agents perform"):
//   - a session's working time is billed as `agent_runtime`, like a
//     serverless agent session's (billing.ts);
//   - a Slack message passes the autonomous sessions' credit admission
//     before it is delivered (admission.ts);
//   - Claude Code spends the organization's managed model key, metered as
//     `model_spend` (model-key.ts).
//
// One alarm serves several purposes (lifecycle polling, the Slack queue, the
// idle check, runtime billing); the `alarms` table keeps when each is due.
// For the Slack queue it is the fallback: an accept drains the queue inline
// (work 068 §3), and the alarm runs it first, before any other purpose.

import { DurableObject } from "cloudflare:workers";

import type { GitHubInstallation, GitHubTokenMint } from "../protocol.js";
import { listGitHubInstallationRepositories } from "../edge/github.js";
import {
  type BillingWarning,
  type DeliveryAdmission,
  type SlackNotice,
  admitDelivery,
  billingWarningMessage,
  forgetCreditsNotice,
  refusal,
  refuseForCredits,
} from "./admission.js";
import { ComputerRuntimeBilling } from "./billing.js";
import { PlatformComputerCloud } from "./cloud.js";
import {
  type ComputerEdgeEnv,
  ComputersNotConfigured,
  DEFAULT_ZONE,
  type PublicComputer,
  defaultDiskGiB,
  gatewayUrl,
  maxDiskGiB,
  missingEdgeConfig,
  publicOrigin,
  sizeFor,
  sizeShape,
} from "./config.js";
import { computerHarnesses, takeHarnessPrefix } from "./harnesses.js";
import { type SealPurpose, seal, sha256Hex, unseal } from "./crypto.js";
import { type DiskReport, diskDecision } from "./disk-growth.js";
import { type Linked, LINK_TIMEOUT_MS, ThreadAccess, findThreadLinks, forwardedLinked, threadRefFor } from "./threads.js";
import { type ComputerInstallation, type ComputerRepository, selectTokenTarget, workspaceDefinition } from "./github.js";
import { hostToken } from "./host-token.js";
import { type AdoptedComputer, ComputerLifecycle, type ComputerState, type LifecycleReply } from "./lifecycle.js";
import { MANAGED_MODEL_PROVIDER, modelCredentials, requestManagedModelKey } from "./model-key.js";
import { mintOpenComputerKey } from "./opencomputer-key.js";
import { type AutomationRepositoryEnv, automationRepositoryCredential } from "../edge/automation-repository.js";
import { daysUnpaid, idleParkMs, parkingDecision, unpaidStage, unpaidWarning, unpaidWarningGiven } from "./parking.js";
import { type ComputerPlan, type ResolvedPlan, type UsagePlan, resolvePlan, sizeTier } from "./plan.js";
import { POOL_OBJECT, isPoolId } from "./names.js";
import { ComputerPool, type PoolClaim, type PoolProbeResult, type PoolSlot, type PoolSlotStatus, SLOT_PROBE_TIMEOUT_MS, poolSize } from "./pool.js";
import { ComputerPreviews } from "./previews.js";
import { ComputerKeys, type SyncedKey } from "./keys.js";
import { type ApiCaller, type ApiOp, type ApiReply, ComputerSessionsApi } from "./sessions-api.js";
import type { PreviewComputerState } from "../previews/worker.js";
import {
  CALVIN_API_PROTOCOL,
  CALVIN_PROTOCOL_VERSION,
  type CalvinGatewayToHost,
  type CalvinTraceContext,
  type CalvinGitHubToken,
  type CalvinHostCredentials,
  type CalvinHostToGateway,
  type CalvinMode,
  type CalvinPerson,
  type CalvinSessionReport,
  type CalvinSlackFile,
  type CalvinPostThreadRequest,
  type CalvinPostThreadResult,
  type CalvinPreviewConfig,
  type CalvinHarness,
  type CalvinReadThreadRequest,
  type CalvinSpawnRequest,
  type CalvinSpawnResult,
  type SecretRequest,
  type SessionSecret,
  type WorkspaceDefinition,
  computerSessionId,
  decodeCalvinActionId,
  parseSessionKey,
  personFor,
  COMPUTER_GIT_NAME,
  noReplyGitEmail,
  sessionKey,
} from "./protocol.js";
import { type SubmittedView, parseSecretCommand } from "./secrets.js";
import { parseVariableCommand } from "./variables.js";
import { type SecretsApiOp, SecretsStore } from "./secrets-store.js";
import { CONNECTION_VIEW, ComputerConnections, type ConnectionRequest, type GrantableConnection } from "./connections.js";
import {
  AGENT_ERRORS,
  type AgentChoice,
  type AgentView,
  CODEX_CONNECT_ACTION,
  CODEX_DISCONNECT_ACTION,
  CONNECT_ACTION,
  type CodexConnectResult,
  type ConnectCodePurpose,
  type ConnectResult,
  DISCONNECT_ACTION,
  MODEL_VIEW,
  MODEL_VIEW_CODEX,
  type MintResult,
  type ModelAccess,
  type ModelSession,
  type ModelSubmittedView,
  type ProbeOutcome,
  type RedeemInput,
  type RedeemResult,
  WEB_OWNER_PREFIX,
  parseClaudeCommand,
  parseCodexCommand,
  parseLinkCommand,
} from "./model-access.js";
import { createModelAccess } from "./model-access-impl.js";
import { ConnectCodeIndex, connectCodeIndexName } from "./connect-code-index.js";
import { ApiTelemetry, surfaceOfOrigin } from "./telemetry/api.js";
import { computerApiEnabled, GATED_PROTOCOL } from "./api-gate.js";
import { TelemetryBatch } from "./telemetry/batch.js";
import { type Acknowledgement, ComputerTelemetry, type HostAttachment } from "./telemetry/computer.js";
import type { GatewayTelemetry } from "./telemetry/gateway.js";
import { SLACK_QUEUE_STATE_INDEX, slackQueueNow } from "./slack-queue-gauge.js";
import {
  RESIZING_NOTICE,
  STARTING_NOTICE,
  type SlackInteraction,
  type SlackMessageJob,
  type SlackResult,
  WAKING_NOTICE,
  joinRequestMessages,
  normalizeJob,
  slackApi,
  slackEscape,
  slackThreadUrl,
  slackTokenDead,
} from "./slack.js";

/** What the edge's AccountDurableObject offers the computer. */
interface AccountStub {
  listGitHubInstallations(): Promise<GitHubInstallation[]>;
  mintGitHubInstallationToken(input: {
    installationId: string;
    permissions?: Record<string, "read" | "write">;
    repositories?: string[];
  }): Promise<GitHubTokenMint>;
  resolveManagedModelCredential(provider: string): Promise<{ id: string; key: string } | null>;
  grantableComputerConnections(ownerUserId: string, service: string): Promise<GrantableConnection[]>;
  grantOwnComputerServiceConnection(input: {
    connectionId: string;
    ownerUserId: string;
    scope: "session" | "user";
    subject: string;
    grantedBy: string;
  }): Promise<void>;
}

export interface ComputerSession {
  key: string;
  title: string;
  channelId: string;
  threadTs: string;
  ownerSlackUserId: string | null;
  status: "starting" | "busy" | "idle" | "ended" | "error";
  updatedAt: string;
  slackUrl: string | null;
}

export interface ComputerOverview {
  computer: PublicComputer | null;
  /** botUserId: the app's bot user in the workspace, so the dashboard can open a DM with it. */
  slack: { installed: boolean; teamId?: string; teamName?: string; botUserId?: string };
  plan: ComputerPlan;
  /** The asking dashboard user's agent (work 081); only when the caller named one. */
  agent?: AgentView;
}

export interface SlackLink {
  teamId: string;
  teamName: string;
  botUserId: string;
  botToken: string;
  /** The Slack user who approved the install (oauth.v2.access `authed_user.id`), when Slack said. */
  installerUserId?: string;
  /** The dashboard user who started the install (its nonce): linked to `installerUserId` (work 081). */
  dashboardUserId?: string;
}

/** An organization's computer for an operator (edge /internal/computer/status and wake, work 092); times are ISO. */
export interface OperatorComputerStatus {
  accountId: string;
  /** The lifecycle's own state (`parked`, `waking`, `ready`, …), not the dashboard's. */
  state: ComputerState;
  hostConnected: boolean;
  size: string;
  /** As billing says now; null when billing could not answer. */
  plan: ComputerPlan | null;
  usagePlan: UsagePlan | null;
  /** A free organization's trial end: before it the computer never parks (parking.ts). */
  trialEndsAt: string | null;
  /** Billing refuses the organization since then: a free one parks at its next idle check. */
  haltedAt: string | null;
  lastActivityAt: string | null;
  nextIdleCheckAt: string | null;
  slackTeamName: string | null;
}

/** What `notifyJoinRequest` did: whether the person who linked the workspace was told. */
export interface JoinRequestOutcome {
  installerNotified: boolean;
}

/** One queued message for the host. */
interface Dispatch {
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  files?: CalvinSlackFile[];
  mentioned?: boolean;
  /** Work 054: kept in the stored payload, so a re-flushed dispatch keeps its trace. */
  trace?: CalvinTraceContext;
  /** Threads linked in the message (work 049 L3): dropped from the row once the host has answered. */
  linked?: Linked[];
}

type SessionRow = {
  key: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  ownerId: string | null;
  title: string;
  mode: CalvinMode | null;
  model: string | null;
  speed: string | null;
  sdkSessionId: string | null;
  forkPath: string | null;
  status: string | null;
  updatedAt: number;
};

const SESSION_SELECT = `SELECT runner_key AS key, team_id AS teamId, channel_id AS channelId, thread_ts AS threadTs,
  owner_id AS ownerId, title, mode, model, speed, sdk_session_id AS sdkSessionId, fork_path AS forkPath, status,
  updated_at AS updatedAt FROM sessions`;

const INSTALL_NONCE_TTL_MS = 10 * 60_000;
/** At most one pair of join-request DMs per requesting Slack user in this window. */
export const JOIN_REQUEST_INTERVAL_MS = 24 * 3600_000;
const PLAN_TTL_MS = 10 * 60_000;
const DEDUP_TTL_MS = 24 * 3600_000;
/** Linked threads (work 049 L3) wait with an undelivered message this long at most. */
const LINKED_TTL_MS = 10 * 60_000;
/** A session's read or post of a thread answers within this; the runner gives up at 30 s. */
const THREAD_REQUEST_MS = 25_000;
/**
 * Billing's admission, stale-while-revalidate (the RPC to the public edge and
 * its D1 was on every message's path). An "allowed" answer is served from
 * this object's storage for up to ADMISSION_MAX_AGE_MS; once it is older than
 * ADMISSION_FRESH_MS a message that uses it also re-checks in the background
 * (at most one re-check per ADMISSION_FRESH_MS). A refusal is stored as one
 * and never served: a refused organization asks billing on every message
 * and is admitted as soon as it has credits.
 *
 * The leak window for an organization that runs out of credits: messages
 * within ADMISSION_FRESH_MS of the last completed check, plus the message
 * that starts the re-check, are admitted; once the re-check lands, the next
 * message is refused. When billing cannot answer, cached admissions go on
 * for at most ADMISSION_MAX_AGE_MS after the last answer; then the check is
 * on the path again and throws, and the queue retries. Each check takes a
 * generation number when it starts; an answer older than the stored one is
 * dropped, so a slow re-check never overwrites a newer refusal.
 */
export const ADMISSION_FRESH_MS = 60_000;
export const ADMISSION_MAX_AGE_MS = 10 * 60_000;

/** The stored admission (settings `admission`): the check's generation, billing's answer, and when the check started. */
interface StoredAdmission {
  generation: number;
  allowed: boolean;
  checkedAt: number;
  /** The warning billing gave with it (086), told on the messages it admits. */
  warning?: BillingWarning;
}
/** Calvin's model tiers (tiers.ts); the runner maps them to models. */
const SPAWN_TIERS = new Set(["smart", "fast", "default"]);
const SLACK_MAX_ATTEMPTS = 5;
/**
 * The Slack queue (work 068 §3a–3b): drained inline on accept, one serial
 * chain per thread, at most SLACK_PARALLEL_THREADS threads at once and
 * SLACK_DRAIN_MAX_JOBS jobs per drain (the rest wait for the alarm).
 */
const SLACK_PARALLEL_THREADS = 8;
const SLACK_DRAIN_MAX_JOBS = 50;
/**
 * A Durable Object has one instance, so a `running` row no drain of this
 * instance holds was left by an evicted one. The constructor recovers them
 * all; the alarm leaves a few seconds' grace (SLACK_STRANDED_GRACE_MS) and
 * fires again within SLACK_STRANDED_MS of a drain it found in flight, so an
 * eviction mid-drain is caught by then at the latest (sooner by any accept).
 */
export const SLACK_STRANDED_GRACE_MS = 5_000;
export const SLACK_STRANDED_MS = 60_000;
/** The alarm behind an inline drain: it only finds work when the drain could not finish (eviction, saturation). */
const SLACK_FALLBACK_MS = 1_000;
const REPOSITORY_PAGES = 10;
const DEFINITION_TIMEOUT_MS = 10_000;
/** How often a delivery may re-read the organization's repositories (work 052). */
const DEFINITION_RECHECK_MS = 60_000;

type AlarmPurpose = "lifecycle" | "slack" | "idle" | "pool" | "assign" | "billing" | "size" | "model" | "agent" | "recover";

/** How soon an upsize that is waiting (host not connected yet, a session working) looks again. */
export const SIZE_RECHECK_MS = 60_000;

/** How long a resolved organization model key is reused before the account is asked again. */
/** A stored model key older than this is re-read from the account in the background (work 058); changes are pushed sooner. */
const MODEL_KEY_RECHECK_MS = 60 * 60_000;
/** How long "no key yet" is believed, and how often provisioning is asked for. */
const MODEL_KEY_MISS_TTL_MS = 60_000;
const MODEL_KEY_PROVISION_INTERVAL_MS = 10 * 60_000;

/** How long a claimed computer's host has to say hello as the organization before it is logged as lost. */
export const ASSIGN_ACK_MS = 3 * 60_000;
/** How often an organization's object reminds the pool to look at itself. */
const POOL_KICK_INTERVAL_MS = 5 * 60_000;

export class ComputerDurableObject extends DurableObject<ComputerEdgeEnv> {
  private readonly lifecycle: ComputerLifecycle;
  private readonly secrets: SecretsStore;
  /**
   * Work 097, 6b: subscription routing behind one seam (model-access.ts).
   * `models`: members' subscriptions and each session's model route (work
   * 077); `agents`: the person's agent from the dashboard (work 081);
   * `codes`: connect and link codes (works 082, 083); `slack`: `!claude`,
   * `!codex`, `!link` and their modals, undefined in the public build.
   */
  private readonly access: ModelAccess;
  private readonly connections: ComputerConnections;
  private readonly billing: ComputerRuntimeBilling;
  /** Work 054: the gateway's telemetry events (telemetry/computer.ts); sends nothing unless configured. */
  private readonly telemetry: ComputerTelemetry;
  /** Work 074: the organization's tunnel and preview names (previews.ts). */
  private readonly previews: ComputerPreviews;
  /** Work 084: the organization's API keys as the wire knows them (keys.ts). */
  private readonly keys: ComputerKeys;
  private readonly apiTelemetry: ApiTelemetry;
  /** Work 084: the session API, its rows and the host's v4 frames (sessions-api.ts). */
  private readonly api: ComputerSessionsApi;
  private pool?: ComputerPool;
  /** The organization's managed model key, in memory only (never stored here, never logged). */
  private refreshingModelKey?: Promise<string | null>;
  private provisioningModelKey?: Promise<void>;
  /** The background admission re-check in flight (`admit`), and when the last one started. */
  private recheckingAdmission?: Promise<void>;
  private admissionRecheckedAt = 0;
  /** Working statuses started on accept and not yet seen by the queue, by `<channel>:<message ts>` (memory only). */
  private readonly acks = new Map<string, Promise<Acknowledgement>>();
  /** The create in flight: concurrent creates of one organization share it, so it claims at most one pool computer. */
  private ensuring?: Promise<LifecycleReply>;
  /** The Slack queue's drain in flight (work 068 §3a): accepts and the alarm join it rather than start a second. */
  private draining?: Promise<void>;
  /** Wakes the drain in flight to look at the queue again (a row arrived while it waited on its chains). */
  private wakeDrain?: () => void;
  /** Queue rows a drain of this object instance is processing: never recovered as stranded. */
  private readonly inFlight = new Set<number>();
  /** Rows accepted by this instance and not yet taken: their `queue.started` says `inline` (work 068 §3f). */
  private readonly inlineRows = new Set<number>();
  /** A size reconciliation asked for while one ran: it looks once more when that one ends. */
  private reconcileAgain = false;
  /** Unsealed values by purpose, context and ciphertext (work 068 §3d); a changed ciphertext is a new entry. Memory only. */
  private readonly unsealed = new Map<string, string>();
  /** The size reconciliation and the billing tick in flight: run off the alarm's path, never twice at once. */
  private reconciling?: Promise<void>;
  private billingRun?: Promise<void>;
  /** Slack thread access (work 049 L3, threads.ts), for the linked workspace; its caches hold no message text. */
  private threadAccess?: { teamId: string; access: ThreadAccess };

  constructor(ctx: DurableObjectState, env: ComputerEdgeEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alarms (purpose TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        runner_key TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        owner_id TEXT,
        title TEXT NOT NULL,
        mode TEXT,
        model TEXT,
        sdk_session_id TEXT,
        fork_path TEXT,
        status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at);
      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY,
        runner_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dispatches_ready ON dispatches (state, created_at);
      CREATE TABLE IF NOT EXISTS people (
        slack_user_id TEXT PRIMARY KEY,
        dir TEXT NOT NULL,
        git_name TEXT NOT NULL,
        git_email TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_events (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_messages (message_key TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS install_nonces (
        nonce_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS join_requests (
        slack_user_id TEXT PRIMARY KEY,
        installer_notified INTEGER NOT NULL,
        notified_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notices (thread_key TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (thread_key, kind));
      CREATE TABLE IF NOT EXISTS billing_warnings (recipient TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (recipient, kind));
    `);
    // Columns added after the table first shipped (lifecycle.ts's pattern). `thread_key`:
    // `<channel>:<thread ts>`, a row's chain (NULL on older rows: a chain of its own).
    // `started_at`: when it was claimed `running`, for the stranded-row recovery.
    for (const column of ["thread_key TEXT", "started_at INTEGER"]) {
      try {
        sql.exec(`ALTER TABLE slack_queue ADD COLUMN ${column}`);
      } catch {
        // Already there.
      }
    }
    // The telemetry's Slack queue gauge reads waiting rows per journal batch: index-only (slack-queue-gauge.ts).
    sql.exec(SLACK_QUEUE_STATE_INDEX);
    this.lifecycle = new ComputerLifecycle({
      sql,
      cloud: () => {
        if (!env.RUNTIMES) throw new ComputersNotConfigured(["RUNTIMES"]);
        return new PlatformComputerCloud(env.RUNTIMES);
      },
      missingConfig: () => missingEdgeConfig(env),
      hostToken: (organizationId) => {
        if (!env.COMPUTER_HOST_TOKEN_KEY) throw new ComputersNotConfigured(["COMPUTER_HOST_TOKEN_KEY"]);
        return hostToken(env.COMPUTER_HOST_TOKEN_KEY, organizationId);
      },
      gatewayUrl: (organizationId) => {
        if (!env.COMPUTER_HOST_GATEWAY_URL) throw new ComputersNotConfigured(["COMPUTER_HOST_GATEWAY_URL"]);
        return gatewayUrl(env.COMPUTER_HOST_GATEWAY_URL, organizationId);
      },
      setAlarm: (at) => this.schedule("lifecycle", at),
      hostConnected: () => this.socket() !== undefined,
      onReady: () => {
        this.noteActivity();
        sql.exec("DELETE FROM notices");
        void this.flush();
      },
    });
    this.secrets = new SecretsStore({
      sql,
      encryptionKey: () => env.BLUE_CHANNEL_ENCRYPTION_KEY,
      teamId: () => this.setting("slackTeamId") ?? "",
      slack: (method, body) => this.slack(method, body),
      session: (key) => this.runnerSession(key),
      push: (which) => this.pushSecrets(which),
      wake: (session, userId, text, ts) => this.wakeSession(session, userId, text, ts),
    });
    this.access = createModelAccess({
      sql,
      encryptionKey: () => env.BLUE_CHANNEL_ENCRYPTION_KEY,
      accountId: () => this.accountId(),
      teamId: () => this.setting("slackTeamId") ?? "",
      slack: (method, body) => this.slack(method, body),
      harnesses: () => computerHarnesses(this.hostFeatures()),
      host: () => this.liveHost(),
      send: (frame) => this.send(frame),
      schedule: (purpose) => this.purposeScheduler(purpose),
      liveSessions: () => this.liveSessions(),
      session: (key) => this.runnerSession(key),
      // A token connected on the dashboard (`web:<id>`, work 081) has nobody in Slack to tell.
      directMessage: (userId, text) => (userId.startsWith(WEB_OWNER_PREFIX) ? Promise.resolve(false) : this.directMessage(userId, text)),
      threadUrl: (channelId, threadTs) => slackThreadUrl(this.setting("slackTeamId") ?? "", channelId, threadTs) ?? undefined,
      // Lazy: `this.telemetry` is built below.
      telemetry: (name, fields) => this.telemetry.subscription(name, fields),
      slackInstalled: () => {
        const installed = !!(this.setting("slackTeamId") && this.setting("slackBotToken"));
        const teamName = this.setting("slackTeamName");
        return { installed, ...(teamName ? { teamName } : {}) };
      },
      poolProbe: (token, user) => (this.env.COMPUTERS && poolSize(this.env.COMPUTER_POOL_SIZE) > 0 ? (this.poolObject().poolProbe(token, user) as Promise<PoolProbeResult>) : null),
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
      waitUntil: (task) => ctx.waitUntil(task),
      slackUserName: async (userId) => {
        const r = await this.slack("users.info", { user: userId });
        const u = r.ok ? r.user : undefined;
        return u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name || undefined;
      },
      connectCodeIndex: {
        put: (hash, expiresAt) => this.computerObject(connectCodeIndexName(hash)).indexConnectCode(hash, this.accountId(), expiresAt),
        forget: (hash) => this.computerObject(connectCodeIndexName(hash)).forgetConnectCode(hash),
      },
    });
    // Work 080: connections people grant the computer from Slack.
    this.connections = new ComputerConnections({
      slack: (method, body) => this.slack(method, body),
      session: (key) => this.runnerSession(key),
      linkOfSlack: (slackUserId) => this.access.agents.linkOfSlack(slackUserId),
      grantable: (userId, service) => this.account().grantableComputerConnections(userId, service),
      grant: (input) => this.account().grantOwnComputerServiceConnection(input),
      wake: (session, userId, text, ts) => this.wakeSession(session, userId, text, ts),
      origin: () => publicOrigin(this.env),
    });
    this.billing = new ComputerRuntimeBilling({
      sql,
      billable: () => {
        const accountId = this.setting("accountId");
        return Boolean(accountId) && !isPoolId(accountId!);
      },
      usage: (segment) => ({
        orgId: this.accountId(),
        // The usage endpoint wants serverless agents' attribution; a computer
        // has no deployment or agent, so both name the computer.
        deploymentId: "computer",
        agentId: "computer",
        sessionId: segment.runnerKey,
        microvmId: this.lifecycle.row()?.resourcePrefix ?? "computer",
      }),
      config: () => env,
    });
    this.previews = new ComputerPreviews({
      sql,
      env,
      organizationId: () => this.accountId(),
      seal: (value, context) => seal(value, env.BLUE_CHANNEL_ENCRYPTION_KEY, "tunnel-token", context),
      unseal: (sealed, context) => this.unsealCached(sealed, "tunnel-token", context),
      send: (command) => this.send(command),
    });
    this.telemetry = new ComputerTelemetry({
      env,
      sql,
      waitUntil: (promise) => ctx.waitUntil(promise),
      accountId: () => this.setting("accountId"),
      socket: () => this.socket(),
    });
    // Work 084 instrumentation: one event per unit of work, all joining the object's open batch
    // (one Tinybird POST per BATCH_MS, telemetry/batch.ts), never a POST per event.
    const batch = new TelemetryBatch({ open: () => this.telemetry.invocation(), waitUntil: (promise) => ctx.waitUntil(promise) });
    this.apiTelemetry = new ApiTelemetry({
      emit: (write) => batch.emit(write),
      surfaceOf: (sessionId) =>
        surfaceOfOrigin([...sql.exec<{ o: string | null }>("SELECT origin_type AS o FROM sessions WHERE session_id = ?", sessionId)][0]?.o),
      slackQueue: () => slackQueueNow(sql),
    });
    this.keys = new ComputerKeys({
      sql,
      kv: env.WIRE_KEYS,
      organizationId: () => this.setting("accountId"),
      tunnelId: () => this.previews.tunnelId(),
      revoked: (keyId) => (this.liveHost()?.protocol ?? 0) >= 4 && this.send({ t: "revoked", keyId }) !== false,
      waitUntil: (promise) => ctx.waitUntil(promise),
      telemetry: this.apiTelemetry,
    });
    this.api = new ComputerSessionsApi({
      sql,
      env,
      organizationId: () => this.accountId(),
      host: () => this.apiHost(),
      enabled: () => this.apiEnabled(),
      send: (frame) => this.send(frame),
      closeHost: (code, reason) => this.socket()?.close(code, reason),
      wake: () => this.wakeForApi(),
      computerStatus: () => this.apiComputerStatus(),
      admitted: () => this.admitForApi(),
      slackPerson: (slackUserId) => this.person(slackUserId),
      linkOfSlack: (slackUserId) => this.access.agents.linkOfSlack(slackUserId),
      slackTeamId: () => this.setting("slackTeamId"),
      keys: this.keys,
      tunnelId: () => this.previews.tunnelId(),
      waitUntil: (promise) => ctx.waitUntil(promise),
      scheduleRecover: (at) => this.scheduleRecover(at),
      setting: (key) => this.setting(key),
      put: (key, value) => this.put(key, value),
      remove: (key) => this.remove(key),
      telemetry: this.apiTelemetry,
    });
    // A new instance holds no drain: every row an evicted one left `running` goes
    // back to the queue, synchronously (local SQL; a failure is logged, never thrown:
    // a throw here would reset the object on every instantiation). The alarm for
    // them is armed off the constructor's path; an accept or the alarm arms it too.
    try {
      this.recoverStrandedSlackJobs(0);
      if (this.slackQueueBusy()) void this.rescheduleSlack().catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "computer.slack_rearm_failed", message: errorText(error) })));
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "computer.slack_recovery_failed", message: errorText(error) }));
    }
  }

  // ------------------------------------------------------------------ settings

  private setting(key: string): string | undefined {
    return [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)][0]?.value;
  }

  private put(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /**
   * The features of the host's hello, kept (work 082, harnesses.ts): what the
   * computer can run while it is parked or disconnected; the next hello
   * replaces them, so a downgraded host drops what it no longer lists.
   */
  private recordHostFeatures(features: readonly string[]): void {
    const previous = this.keptHostFeatures();
    const next = [...features];
    if (previous && previous.length === next.length && previous.every((f, i) => f === next[i])) return;
    this.put("hostFeatures", JSON.stringify(next));
    this.keptFeatures = { value: next };
    console.log(JSON.stringify({ level: "info", event: "computer.host_features_changed", features: next, first: previous === undefined }));
  }

  /**
   * The parsed `hostFeatures` setting, read once per object: every agent
   * view asks for the harnesses, and the setting only changes through
   * `recordHostFeatures`, which refreshes this. Unset until first read, so a
   * restarted object loads what the last hello left in storage.
   */
  private keptFeatures?: { value: string[] | undefined };
  private keptHostFeatures(): string[] | undefined {
    if (this.keptFeatures) return this.keptFeatures.value;
    const raw = this.setting("hostFeatures");
    let value: string[] | undefined;
    if (raw !== undefined) {
      try {
        const v: unknown = JSON.parse(raw);
        if (Array.isArray(v)) value = v.filter((f): f is string => typeof f === "string");
      } catch {
        // Unreadable: as if never recorded.
      }
    }
    this.keptFeatures = { value };
    return value;
  }

  /** The features of the host's latest hello; undefined when it has never said hello. */
  private hostFeatures(): string[] | undefined {
    // A host that said hello before hellos were kept is still on its socket.
    return this.keptHostFeatures() ?? this.liveHost()?.features;
  }

  /** Work 084 rollout gate: whether this organization's host is spoken to at v4 (api-gate.ts). */
  private apiEnabled(): boolean {
    return computerApiEnabled(this.env.COMPUTER_API_ORGS, this.setting("accountId"));
  }

  /** The protocol every `welcome` says: ours, or v3 for an organization the gate holds back. */
  private welcomeProtocol(): number {
    return this.apiEnabled() ? CALVIN_PROTOCOL_VERSION : GATED_PROTOCOL;
  }

  /** The connected host's hello `protocol` (at most v3 when gated off, recorded at its hello) and `features`; undefined when none is connected. */
  private liveHost(): { protocol: number; features: string[] } | undefined {
    const socket = this.socket();
    if (!socket) return undefined;
    try {
      const a = socket.deserializeAttachment() as HostAttachment | null;
      return { protocol: a?.protocol ?? 1, features: a?.features ?? [] };
    } catch {
      return { protocol: 1, features: [] };
    }
  }

  /** The host the sessions API sees: below protocol 4 until its welcome is sent (review r3 P2). */
  private apiHost(): { protocol: number; features: string[] } | undefined {
    const socket = this.socket();
    if (!socket) return undefined;
    let welcomed = true;
    try {
      welcomed = (socket.deserializeAttachment() as HostAttachment | null)?.welcomed !== false;
    } catch {
      welcomed = true;
    }
    const host = this.liveHost();
    return host && !welcomed ? { ...host, protocol: Math.min(host.protocol, CALVIN_API_PROTOCOL - 1) } : host;
  }

  private markWelcomed(ws: WebSocket): void {
    try {
      const a = ws.deserializeAttachment() as HostAttachment | null;
      if (a) ws.serializeAttachment({ ...a, welcomed: true } satisfies HostAttachment);
    } catch {
      // An unreadable attachment reads as welcomed already.
    }
  }

  private remove(...keys: string[]): void {
    for (const key of keys) this.ctx.storage.sql.exec("DELETE FROM settings WHERE key = ?", key);
  }

  /** This object is the organization's: the first call names it, later ones must agree. */
  private bind(accountId: string): void {
    const bound = this.setting("accountId");
    if (!bound) this.put("accountId", accountId);
    else if (bound !== accountId) throw new Error("computer object bound to another organization");
  }

  private accountId(): string {
    const accountId = this.setting("accountId");
    if (!accountId) throw new Error("computer object is not bound to an organization");
    return accountId;
  }

  private noteActivity(): void {
    this.put("lastActivityAt", String(Date.now()));
  }

  // ------------------------------------------------------------------ alarms

  /** A store's `schedule(at)` for one alarm purpose: `at` arms it, null disarms it. */
  private purposeScheduler(purpose: AlarmPurpose): (at: number | null) => Promise<void> {
    return async (at) => {
      if (at === null) this.ctx.storage.sql.exec("DELETE FROM alarms WHERE purpose = ?", purpose);
      else await this.schedule(purpose, at);
    };
  }

  private async schedule(purpose: AlarmPurpose, at: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO alarms (purpose, at) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET at = excluded.at",
      purpose,
      at,
    );
    await this.armAlarm();
  }

  private async armAlarm(): Promise<void> {
    const next = [...this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM alarms")][0]?.at;
    if (next === null || next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = [...this.ctx.storage.sql.exec<{ purpose: AlarmPurpose }>("SELECT purpose FROM alarms WHERE at <= ?", now)].map(
      (row) => row.purpose,
    );
    for (const purpose of due) this.ctx.storage.sql.exec("DELETE FROM alarms WHERE purpose = ?", purpose);
    const failed = (purpose: AlarmPurpose) => (error: unknown) =>
      console.error(JSON.stringify({ level: "error", event: "computer.alarm_failed", purpose, message: errorText(error) }));
    // The Slack queue first and alone (work 068 §3c): no other purpose's RPCs
    // run before it. Rows an evicted drain left `running` are recovered here
    // too. A drain in flight (an accept's) is woken, not awaited: the other
    // purposes must not wait out its network calls, and it reschedules itself
    // when it ends; the alarm comes back within SLACK_STRANDED_MS in case that
    // drain is evicted first.
    const recovered = this.recoverStrandedSlackJobs(SLACK_STRANDED_GRACE_MS);
    if (due.includes("slack") || recovered > 0) {
      if (this.draining) {
        this.wakeDrain?.();
        await this.scheduleSlack(now + SLACK_STRANDED_MS).catch(failed("slack"));
      } else {
        await this.drain().catch(failed("slack"));
      }
    }
    for (const purpose of due) {
      try {
        if (purpose === "lifecycle") {
          const before = this.lifecycle.row()?.state;
          await this.lifecycle.tick();
          this.noteUnpaidPark(before);
        }
        else if (purpose === "idle") await this.idleCheck();
        else if (purpose === "pool") {
          const next = await this.poolTable().refill();
          if (next !== null) await this.schedule("pool", next);
        } else if (purpose === "assign") this.assignCheck();
        else if (purpose === "model") await this.access.models.expire();
        else if (purpose === "agent") await this.access.agents.expire();
        else if (purpose === "recover") await this.api.recoverTick();
      } catch (error) {
        failed(purpose)(error);
      }
    }
    // Periodic, idempotent and unordered against the queue: after it, off the alarm's path.
    if (due.includes("billing")) this.ctx.waitUntil(this.billingTick().catch(failed("billing")));
    if (due.includes("size")) this.ctx.waitUntil(this.reconcileSize().catch(failed("size")));
    // A ready computer is always being watched for idleness (pool computers never park).
    const row = this.lifecycle.row();
    if (row?.state === "ready" && !isPoolId(row.organizationId) && ![...this.ctx.storage.sql.exec("SELECT 1 FROM alarms WHERE purpose = 'idle'")].length) {
      this.ctx.storage.sql.exec("INSERT INTO alarms (purpose, at) VALUES ('idle', ?)", Date.now() + 15 * 60_000);
    }
    const next = [...this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM alarms")][0]?.at;
    if (next !== null && next !== undefined) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }

  // ------------------------------------------------------------------ plan and parking

  private async plan(fresh = false): Promise<ComputerPlan> {
    const { plan, known } = await this.knownPlan(fresh);
    return known ? plan : ((this.setting("plan") as ComputerPlan | undefined) ?? plan);
  }

  /** The plan, whether billing said so, and the usage plan (fresh within PLAN_TTL_MS, or just asked). */
  private async knownPlan(fresh = false): Promise<ResolvedPlan> {
    const checkedAt = Number(this.setting("planCheckedAt") ?? 0);
    const cached = this.setting("plan") as ComputerPlan | undefined;
    if (!fresh && cached && Date.now() - checkedAt < PLAN_TTL_MS) {
      const haltedAt = this.setting("haltedAt");
      const trialEndsAt = this.setting("trialEndsAt");
      return {
        plan: cached,
        known: true,
        usagePlan: (this.setting("usagePlan") as UsagePlan | undefined) ?? null,
        haltedAt: haltedAt ? Number(haltedAt) : null,
        trialEndsAt: trialEndsAt ? Number(trialEndsAt) : null,
      };
    }
    const resolved = await resolvePlan(this.env.OPENCOMPUTER_BILLING, this.accountId());
    if (!resolved.known) return resolved;
    this.put("plan", resolved.plan);
    if (resolved.usagePlan) this.put("usagePlan", resolved.usagePlan);
    else this.remove("usagePlan");
    if (resolved.haltedAt !== null) this.put("haltedAt", String(resolved.haltedAt));
    else this.remove("haltedAt");
    if (resolved.trialEndsAt !== null) this.put("trialEndsAt", String(resolved.trialEndsAt));
    else this.remove("trialEndsAt");
    this.put("planCheckedAt", String(Date.now()));
    return resolved;
  }

  /**
   * The VM size the organization's usage plan wants ("max": COMPUTER_MAX_SIZE;
   * Pro and free: the default). Null when the usage plan is unknown (billing
   * cannot answer, or predates `usagePlan`): a computer is never resized on a
   * guess, it keeps the size it has.
   */
  private async desiredSize(fresh = false): Promise<string | null> {
    const { known, usagePlan } = await this.knownPlan(fresh);
    const tier = known ? sizeTier(usagePlan) : null;
    return tier ? sizeFor(this.env, tier) : null;
  }

  /** Sessions working, and deliveries queued or sent and not yet answered. */
  private workload(): { busySessions: number; pendingDispatches: number } {
    const count = (query: string) => [...this.ctx.storage.sql.exec<{ n: number }>(query)][0]?.n ?? 0;
    return {
      // Work 084: a session whose subagents still run is working, even with its turn over.
      busySessions: count("SELECT COUNT(*) AS n FROM sessions WHERE status IN ('starting', 'busy') OR subagents > 0"),
      pendingDispatches: count("SELECT COUNT(*) AS n FROM dispatches WHERE state IN ('pending', 'sent')"),
    };
  }

  /**
   * The computer follows its plan's size (2026-10-13): everyone
   * claims the warm pool's (default) size, and a "max" organization's computer
   * grows to COMPUTER_MAX_SIZE as soon as it is ready, connected and doing
   * nothing (no starting or busy session, no queued or unanswered message):
   * a resize restarts the VM. Upsizes only; a downsize waits for the next
   * park and wake (wake builds the VM on the plan's size), so nobody's
   * running computer shrinks under them. An unknown plan resizes nothing.
   * Runs after a claim, on hello, on the idle check (paid computers are
   * checked every park interval, so a plan change is noticed), and again every
   * SIZE_RECHECK_MS while an upsize waits.
   */
  private reconcileSize(): Promise<void> {
    if (this.reconciling) {
      // The run in flight may have read the row already: one more look after it.
      this.reconcileAgain = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      do {
        this.reconcileAgain = false;
        await this.reconcileSizeOnce();
      } while (this.reconcileAgain);
    })().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileSizeOnce(): Promise<void> {
    const row = this.lifecycle.row();
    if (!row || isPoolId(row.organizationId) || row.state !== "ready") return;
    const desired = await this.desiredSize();
    if (!desired || desired === row.size) return;
    if (sizeShape(desired).vcpus <= sizeShape(row.size).vcpus) return;
    const { busySessions, pendingDispatches } = this.workload();
    // Tags still `pool` (just claimed): the platform resizes only the organization's VM.
    if (!this.socket() || busySessions > 0 || pendingDispatches > 0 || row.tagsPending) {
      await this.schedule("size", Date.now() + SIZE_RECHECK_MS);
      return;
    }
    const reply = await this.lifecycle.resize(desired);
    const event = reply.status >= 400 ? "computer.resize_failed" : "computer.resizing";
    console.log(
      JSON.stringify({ level: reply.status >= 400 ? "error" : "info", event, accountId: row.organizationId, status: reply.status, ...(reply.error ? { message: reply.error } : {}) }),
    );
  }

  /** Wakes a parked computer on the size its plan wants (the plan unknown: the size it had). */
  private async wakeComputer(): Promise<boolean> {
    return this.lifecycle.wake((await this.desiredSize()) ?? undefined);
  }

  private async idleCheck(): Promise<void> {
    const row = this.lifecycle.row();
    if (!row) return;
    await this.reconcileSize();
    const pool = isPoolId(row.organizationId);
    const plan = pool ? "free" : await this.plan();
    const unpaid = plan === "paid" && row.state === "ready" ? await this.unpaidCheck() : null;
    // A free organization's trial keeps its computer on; once billing refuses it, the VM goes (work 092).
    const { trialEndsAt, haltedAt } = plan === "free" && !pool ? await this.knownPlan() : { trialEndsAt: null, haltedAt: null };
    const decision = parkingDecision({
      plan,
      unpaid: unpaid !== null,
      trialEndsAt,
      halted: haltedAt !== null,
      pool,
      // Re-read: the reconcile may have started a resize.
      state: this.lifecycle.row()?.state ?? row.state,
      hostConnected: this.socket() !== undefined,
      ...this.workload(),
      lastActivityAt: Number(this.setting("lastActivityAt") ?? row.updatedAt),
      now: Date.now(),
      idleMs: idleParkMs(this.env.COMPUTER_PARK_AFTER_MINUTES),
    });
    if (decision.park) {
      console.log(JSON.stringify({ level: "info", event: "computer.parking", accountId: row.organizationId, ...(unpaid !== null ? { unpaid: true } : {}), ...(haltedAt !== null ? { halted: true } : {}) }));
      // billing.vm_terminated waits for the VM to be gone (noteUnpaidPark, after the lifecycle's teardown).
      if ((await this.lifecycle.park()) && unpaid !== null) this.put("unpaidParking", String(unpaid));
    } else if (decision.recheckAt !== null) {
      await this.schedule("idle", decision.recheckAt);
    }
  }

  /**
   * Work 086, unpaid computers (parking.ts unpaidStage), for a ready paid
   * computer: warns the installer on day 6 and answers when the halt began
   * once the VM may go (null: not yet). Parking is decided on billing's
   * answer now, never on the cached plan, so a payment a minute ago keeps the
   * VM. COMPUTER_UNPAID_TERMINATION=on acts; anything else only logs what it
   * would do.
   */
  private async unpaidCheck(): Promise<number | null> {
    const now = Date.now();
    const warned = this.setting("unpaidWarnedAt");
    const warnedAt = warned ? Number(warned) : null;
    let { haltedAt } = await this.knownPlan();
    let stage = unpaidStage({ haltedAt, warnedAt, now });
    if (stage === "park") {
      ({ haltedAt } = await this.knownPlan(true));
      stage = unpaidStage({ haltedAt, warnedAt, now });
    }
    if (haltedAt === null || (stage !== "warn" && stage !== "park")) return null;
    const act = this.env.COMPUTER_UNPAID_TERMINATION === "on";
    const log = { accountId: this.setting("accountId"), haltedAt: new Date(haltedAt).toISOString(), dryRun: !act };
    if (stage === "park") {
      console.log(JSON.stringify({ level: "info", event: "computer.unpaid_park", ...log }));
      return act ? haltedAt : null;
    }
    // Warn: a DM to whoever installed the Slack app; nobody known, the warning is skipped and the clock still runs.
    // A known installer the DM did not reach is warned again on the next check; the VM stays until one gets through.
    const installer = this.setting("slackInstallerUserId");
    const reachable = Boolean(installer && this.setting("slackBotToken"));
    const sent = act && reachable ? await this.directMessage(installer!, unpaidWarning(publicOrigin(this.env))) : false;
    console.log(JSON.stringify({ level: "info", event: "computer.unpaid_warning", ...log, installer: installer !== undefined, sent }));
    if (act && unpaidWarningGiven({ reachable, sent })) this.put("unpaidWarnedAt", String(now));
    return null;
  }

  /**
   * After a lifecycle step: an unpaid park (idleCheck) that has deleted the
   * VM and NIC (parked, or straight on to waking) emits billing.vm_terminated,
   * once per halt (a computer woken again while unpaid parks again without a
   * second event). A park that failed or was overtaken emits nothing.
   */
  private noteUnpaidPark(before: string | undefined): void {
    const pending = this.setting("unpaidParking");
    if (!pending) return;
    const after = this.lifecycle.row()?.state;
    if (before === "parking" && after === "parking") return;
    this.remove("unpaidParking");
    if (before !== "parking" || (after !== "parked" && after !== "waking")) return;
    if (this.setting("unpaidParkedFor") === pending) return;
    this.put("unpaidParkedFor", pending);
    this.telemetry.vmTerminated(daysUnpaid(Number(pending), Date.now()));
  }

  // ------------------------------------------------------------------ runtime billing (billing.ts)

  /** Checkpoints long pieces, closes what no connected host can vouch for, delivers what is due. One at a time. */
  private billingTick(): Promise<void> {
    this.billingRun ??= this.billingTickOnce().finally(() => {
      this.billingRun = undefined;
    });
    return this.billingRun;
  }

  private async billingTickOnce(): Promise<void> {
    const now = Date.now();
    // A host that vanished without a close (half-open socket, evicted
    // object) bills at most one more checkpoint.
    if (!this.socket()) this.billing.closeAll("host_disconnected", now);
    else this.billing.checkpoint(now);
    await this.billing.deliver(now);
    await this.scheduleBilling();
  }

  private async scheduleBilling(): Promise<void> {
    const next = this.billing.nextDueAt();
    if (next === null) this.ctx.storage.sql.exec("DELETE FROM alarms WHERE purpose = 'billing'");
    else await this.schedule("billing", Math.max(next, Date.now()));
  }

  /** Segments closed on a session's report or the host leaving, for operators and tests. */
  runtimeSegments() {
    return this.billing.segments();
  }

  // ------------------------------------------------------------------ dashboard (routes.ts)

  /** `userId`: the dashboard user asking, for their `agent` block (work 081); none, no block. */
  async overview(accountId: string, userId?: string): Promise<ComputerOverview> {
    this.bind(accountId);
    this.kickPool();
    const teamId = this.setting("slackTeamId");
    const teamName = this.setting("slackTeamName");
    const botUserId = this.setting("slackBotUserId");
    return {
      computer: this.lifecycle.view(),
      slack:
        teamId && this.setting("slackBotToken")
          ? { installed: true, teamId, ...(teamName ? { teamName } : {}), ...(botUserId ? { botUserId } : {}) }
          : { installed: false },
      plan: await this.plan(),
      ...(userId ? { agent: this.access.agents.view(userId) } : {}),
    };
  }

  // ------------------------------------------------------------------ the person's agent (routes.ts, work 081)

  async agentConnect(accountId: string, userId: string, token: unknown): Promise<ConnectResult> {
    this.bind(accountId);
    return this.access.agents.connect(userId, token);
  }

  async agentDisconnect(accountId: string, userId: string): Promise<void> {
    this.bind(accountId);
    await this.access.agents.disconnect(userId);
  }

  /** PUT /v1/computer/agent/codex (work 082): the Codex CLI's auth.json. */
  async agentConnectCodex(accountId: string, userId: string, authJson: unknown): Promise<CodexConnectResult> {
    this.bind(accountId);
    return this.access.agents.connectCodex(userId, authJson);
  }

  async agentDisconnectCodex(accountId: string, userId: string): Promise<void> {
    this.bind(accountId);
    await this.access.agents.disconnectCodex(userId);
  }

  async agentResume(accountId: string, userId: string): Promise<AgentView> {
    this.bind(accountId);
    return this.access.agents.resume(userId);
  }

  agentChoose(accountId: string, userId: string, choice: AgentChoice): AgentView {
    this.bind(accountId);
    this.access.agents.setChoice(userId, choice);
    return this.access.agents.view(userId);
  }

  /**
   * POST /v1/computer/agent/connect-code (work 082, CLI connect): a code for
   * `userId`, replacing theirs. `link` (work 083) only while Slack is
   * installed and they have no Slack half; then a connect code is refused,
   * as their PUTs are (they link first, or connect from Slack).
   */
  async agentConnectCode(
    accountId: string,
    userId: string,
    purpose: ConnectCodePurpose = "connect",
  ): Promise<MintResult> {
    this.bind(accountId);
    const unlinked = this.access.agents.needsLink(userId);
    if (purpose === "link" && !unlinked) return { ok: false, ...AGENT_ERRORS.linkNotNeeded };
    if (purpose === "connect" && unlinked) return { ok: false, ...AGENT_ERRORS.connectInSlack };
    return this.access.codes.mint({ dashboard: userId }, "dashboard", purpose);
  }

  /**
   * POST /v1/computer/agent/connect: a code's redemption. The route has only
   * the code's word that this is the organization: an object that isn't it
   * (never bound, or bound to another) refuses without binding.
   */
  async agentConnectWithCode(accountId: string, code: string, input: RedeemInput): Promise<RedeemResult> {
    if (this.setting("accountId") !== accountId) return this.access.codes.refuse("other_org", input.provider);
    return this.access.codes.redeem(code, input);
  }

  // ------------------------------------------------------------------ connect code routing objects (`computer-connect-codes:<x>`)

  private codeIndex?: ConnectCodeIndex;
  private get connectCodeIndex(): ConnectCodeIndex {
    return (this.codeIndex ??= new ConnectCodeIndex(this.ctx.storage.sql));
  }

  /** Routes a connect code (by hash) to its organization until it expires. */
  indexConnectCode(hash: string, accountId: string, expiresAt: number): void {
    this.connectCodeIndex.put(hash, accountId, expiresAt);
  }

  /** The organization a live connect code (by hash) belongs to, or null. */
  connectCodeAccount(hash: string): string | null {
    return this.connectCodeIndex.accountOf(hash);
  }

  forgetConnectCode(hash: string): void {
    this.connectCodeIndex.forget(hash);
  }

  /** Another ComputerDurableObject by name: a routing object such as `computer-connect-codes:<x>`. */
  private computerObject(name: string): DurableObjectStub<ComputerDurableObject> {
    return (this.env.COMPUTERS as unknown as DurableObjectNamespace<ComputerDurableObject>).getByName(name);
  }

  /**
   * Creates the computer if there is none, wakes a parked one, retries a
   * failed one. Callers: the Slack install (ensureComputerOnInstall), a Slack
   * message with no computer (ensureAwake, the safety net) and POST
   * /v1/computer (idempotent; the dashboard's retry and wake).
   */
  async ensureComputer(accountId: string): Promise<LifecycleReply> {
    this.bind(accountId);
    this.ensuring ??= this.ensureComputerOnce(accountId).finally(() => {
      this.ensuring = undefined;
    });
    return this.ensuring;
  }

  /**
   * The Slack install brought the organization in (routes.ts, OAuth callback):
   * its computer comes alive now, from the warm pool or created cold. Only
   * when it has none to use (no row, deleted, or failed): a reinstall never
   * wakes a parked computer. Null: it already has one, nothing done.
   *
   * Why on install and not on the first visit (work 052, decision of
   * 2026-10-13): the computer is enabled for every organization, and most
   * only browse the page; claiming on a visit would hand thousands of warm
   * VMs to organizations that never talk to them. Installing Slack is the
   * moment someone means to use it.
   */
  async ensureComputerOnInstall(accountId: string): Promise<LifecycleReply | null> {
    this.bind(accountId);
    const row = this.lifecycle.row();
    if (row && row.state !== "deleted" && row.state !== "failed") return null;
    return this.ensureComputer(accountId);
  }

  // ------------------------------------------------------------------ operator (edge /internal/computer/*, work 092)

  // ------------------------------------------------------------------ connection grants (edge, work 080)

  /**
   * Whom a computer key's connection grants are for: the live session it was
   * minted for and the Slack user who owns it, as this gateway has them. Null
   * when the session is not live here, so the key reaches only grants for everyone.
   */
  async grantAudience(sessionKey: string): Promise<{ sessionKey: string; ownerId: string } | null> {
    const key = this.liveSessionKey(sessionKey);
    const ownerId = key ? this.runnerSession(key)?.ownerId : undefined;
    return key && ownerId ? { sessionKey: key, ownerId } : null;
  }

  /** The computer as an operator sees it: why it is up or parked, and when it is looked at next. Null: none. */
  async operatorStatus(accountId: string): Promise<OperatorComputerStatus | null> {
    this.bind(accountId);
    const row = this.lifecycle.row();
    if (!row || row.state === "deleted") return null;
    const { plan, known, usagePlan, trialEndsAt, haltedAt } = await this.knownPlan(true);
    const idleAt = [...this.ctx.storage.sql.exec<{ at: number }>("SELECT at FROM alarms WHERE purpose = 'idle'")][0]?.at;
    const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
    return {
      accountId,
      state: row.state,
      hostConnected: this.socket() !== undefined,
      size: row.size,
      plan: known ? plan : null,
      usagePlan,
      trialEndsAt: iso(trialEndsAt),
      haltedAt: iso(haltedAt),
      lastActivityAt: iso(Number(this.setting("lastActivityAt") ?? row.updatedAt)),
      nextIdleCheckAt: iso(idleAt),
      slackTeamName: this.setting("slackTeamName") ?? null,
    };
  }

  /**
   * An operator wakes the computer (or retries a failed one) without the
   * customer asking: ensureComputer, as the dashboard's wake, then a fresh
   * idle window. What keeps it on afterwards is the plan (parking.ts). Never
   * creates a computer the organization does not have. Null: none.
   */
  async operatorWake(accountId: string): Promise<{ reply: LifecycleReply; status: OperatorComputerStatus } | null> {
    this.bind(accountId);
    const before = this.lifecycle.row();
    if (!before || before.state === "deleted") return null;
    const reply = await this.ensureComputer(accountId);
    if (reply.status < 400) this.noteActivity();
    console.log(
      JSON.stringify({ level: "info", event: "computer.operator_wake", accountId, from: before.state, status: reply.status, ...(reply.error ? { message: reply.error } : {}) }),
    );
    return { reply, status: (await this.operatorStatus(accountId))! };
  }

  private async ensureComputerOnce(accountId: string): Promise<LifecycleReply> {
    // A new computer on the usage plan's size; unknown, the default (never the bigger one on a guess).
    const size = (await this.desiredSize(true)) ?? sizeFor(this.env, "default");
    const row = this.lifecycle.row();
    if (row?.state === "parked" || row?.state === "parking") {
      await this.wakeComputer();
      this.noteActivity();
      return { status: 202 };
    }
    const reply =
      (await this.claimFromPool(accountId)) ??
      (await this.lifecycle.create(accountId, { size, diskGiB: defaultDiskGiB(this.env), zone: DEFAULT_ZONE }));
    if (reply.status === 202) this.noteActivity();
    return reply;
  }

  // ------------------------------------------------------------------ warm pool: the organization's side

  private poolObject(): DurableObjectStub<ComputerDurableObject> {
    return (this.env.COMPUTERS as unknown as DurableObjectNamespace<ComputerDurableObject>).getByName(POOL_OBJECT);
  }

  private poolSlotObject(poolId: string): DurableObjectStub<ComputerDurableObject> {
    return (this.env.COMPUTERS as unknown as DurableObjectNamespace<ComputerDurableObject>).getByName(poolId);
  }

  /** Reminds the pool to look at itself, at most every few minutes, off the request's path. */
  private kickPool(): void {
    if (!this.env.COMPUTERS || poolSize(this.env.COMPUTER_POOL_SIZE) === 0) return;
    const last = Number(this.setting("poolKickedAt") ?? 0);
    if (Date.now() - last < POOL_KICK_INTERVAL_MS) return;
    this.put("poolKickedAt", String(Date.now()));
    this.ctx.waitUntil(
      this.poolObject()
        .poolKick()
        .catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.pool_kick_failed", message: errorText(error) }))),
    );
  }

  /**
   * A warm computer instead of a new one, when the organization has none and
   * a pool is configured. Every organization claims, whatever its plan: the
   * pool is at the default size, and a "max" organization's computer grows to
   * its size once connected and idle (reconcileSize). Null: no claim, create the
   * usual way. The steps are in this file's header.
   */
  private async claimFromPool(accountId: string): Promise<LifecycleReply | null> {
    if (!this.env.COMPUTERS || poolSize(this.env.COMPUTER_POOL_SIZE) === 0) return null;
    if (this.lifecycle.row() || isPoolId(accountId)) return null;
    if (missingEdgeConfig(this.env).length) return null;
    const started = Date.now();
    let claim: PoolClaim | null;
    try {
      claim = (await this.poolObject().poolClaim(accountId)) as PoolClaim | null;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "computer.pool_claim_failed", accountId, message: errorText(error) }));
      return null;
    }
    if (!claim) {
      console.log(JSON.stringify({ level: "info", event: "computer.pool_empty", accountId }));
      return null;
    }
    const adopted: AdoptedComputer = {
      prefix: claim.prefix,
      size: claim.size,
      diskGiB: claim.diskGiB,
      zone: claim.zone,
      sshPublicKey: claim.sshPublicKey,
      poolSlot: claim.poolId,
    };
    if (!(await this.lifecycle.adopt(accountId, adopted))) {
      // Cannot happen while creates are serialised (ensuring); if it does, the
      // pool computer is transferred and nobody's: log it for a person.
      console.error(JSON.stringify({ level: "error", event: "computer.pool_claim_orphaned", accountId, poolId: claim.poolId }));
      return { status: 200 };
    }
    let sent = false;
    try {
      ({ sent } = await this.poolSlotObject(claim.poolId).assignPoolHost(claim.poolId, accountId));
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "computer.pool_assign_failed", accountId, poolId: claim.poolId, message: errorText(error) }));
    }
    this.put("assignPendingSince", String(Date.now()));
    this.put("assignPoolSlot", claim.poolId);
    await this.schedule("assign", Date.now() + ASSIGN_ACK_MS);
    // A paid organization's computer grows once its host is here (hello schedules it too).
    await this.schedule("size", Date.now() + SIZE_RECHECK_MS);
    console.log(
      JSON.stringify({ level: "info", event: "computer.pool_claim", accountId, poolId: claim.poolId, assignSent: sent, ms: Date.now() - started }),
    );
    return { status: 202 };
  }

  /** The claimed computer's host never said hello as this organization. */
  private assignCheck(): void {
    const since = this.setting("assignPendingSince");
    if (!since) return;
    if (this.socket()) {
      this.remove("assignPendingSince", "assignPoolSlot");
      return;
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "computer.pool_assign_unacknowledged",
        accountId: this.setting("accountId"),
        poolId: this.setting("assignPoolSlot"),
        sinceMs: Date.now() - Number(since),
      }),
    );
    this.remove("assignPendingSince", "assignPoolSlot");
  }

  // ------------------------------------------------------------------ warm pool: the slot table (`computer-pool`)

  private poolTable(): ComputerPool {
    this.bind(POOL_OBJECT);
    this.pool ??= new ComputerPool({
      sql: this.ctx.storage.sql,
      target: () => poolSize(this.env.COMPUTER_POOL_SIZE),
      slot: (poolId) => {
        const stub = this.poolSlotObject(poolId);
        return {
          start: () => stub.startPoolComputer(poolId) as Promise<LifecycleReply>,
          status: () => stub.poolComputerStatus(poolId) as Promise<PoolSlotStatus>,
          release: (organizationId) => stub.releasePoolComputer(poolId, organizationId) as Promise<AdoptedComputer | null>,
          retire: () => stub.retirePoolComputer(poolId) as Promise<void>,
          probe: (token) => stub.probeToken(token) as Promise<ProbeOutcome>,
        };
      },
      setAlarm: (at) => this.schedule("pool", at),
    });
    return this.pool;
  }

  /** A warm computer for an organization, or null (the pool is empty). */
  poolClaim(organizationId: string): Promise<PoolClaim | null> {
    return this.poolTable().claim(organizationId);
  }

  /** A slot's host said hello. */
  poolHostConnected(poolId: string): Promise<void> {
    return this.poolTable().connected(poolId);
  }

  /** Makes sure the pool's alarm runs, without moving one already scheduled. */
  async poolKick(): Promise<void> {
    this.poolTable();
    if (![...this.ctx.storage.sql.exec("SELECT 1 FROM alarms WHERE purpose = 'pool'")].length) await this.schedule("pool", Date.now());
  }

  /**
   * Work 081: checks a Claude setup token through one warm slot for the
   * dashboard user `user`; rate-limited, behind a breaker, and writing
   * nothing to the slot table (pool.ts).
   */
  poolProbe(token: string, user: string): Promise<PoolProbeResult> {
    return this.poolTable().probe(token, user);
  }

  /** The slot table, for operators and tests. */
  poolSlots(): PoolSlot[] {
    return this.poolTable().slots();
  }

  // ------------------------------------------------------------------ warm pool: a pool computer (`pool-<random>`)

  private bindPool(poolId: string): void {
    if (!isPoolId(poolId)) throw new Error("not a pool computer");
    this.bind(poolId);
  }

  /** Creates the pool computer: the free size and the default disk, like a new free organization's. */
  startPoolComputer(poolId: string): Promise<LifecycleReply> {
    this.bindPool(poolId);
    return this.lifecycle.create(poolId, { size: sizeFor(this.env, "default"), diskGiB: defaultDiskGiB(this.env), zone: DEFAULT_ZONE });
  }

  poolComputerStatus(poolId: string): PoolSlotStatus {
    this.bindPool(poolId);
    return { state: this.lifecycle.row()?.state ?? null, connected: this.socket() !== undefined, proxy: this.access.models.hostReady() };
  }

  /**
   * Work 081: a pool computer checks a Claude setup token for the dashboard
   * through its host's model proxy. Only a pool computer that is still the
   * pool's (row `ready`, not `transferred`) with its host connected: an
   * organization's computer answers `not_pool`, so this call can never send
   * a token through a customer's computer. Writes nothing (the store's probe
   * keeps its resolver in memory); a slot claimed or evicted mid-probe drops
   * the late answer and the caller times out.
   */
  async probeToken(token: string): Promise<ProbeOutcome> {
    if (!isPoolId(this.setting("accountId") ?? "")) return { error: "not_pool" };
    if (this.lifecycle.row()?.state !== "ready" || !this.socket()) return { error: "not_ready" };
    return (await this.access.models.probe(token, SLOT_PROBE_TIMEOUT_MS)) ?? { error: "no_proxy" };
  }

  /** Hands the computer over if it is ready with its host connected; from here this object leaves it alone. */
  releasePoolComputer(poolId: string, organizationId: string): AdoptedComputer | null {
    this.bindPool(poolId);
    if (!this.socket()) return null;
    const computer = this.lifecycle.transfer();
    if (computer) this.put("claimedBy", organizationId);
    return computer;
  }

  /** Tells the connected host it now belongs to the organization; true if a host was there to tell. */
  async assignPoolHost(poolId: string, organizationId: string): Promise<{ sent: boolean }> {
    this.bindPool(poolId);
    if (this.setting("claimedBy") !== organizationId) throw new Error("this pool computer was not released to that organization");
    this.put("assignTo", organizationId);
    return { sent: this.send(await this.assignMessage(organizationId)) };
  }

  private async assignMessage(organizationId: string): Promise<CalvinGatewayToHost> {
    if (!this.env.COMPUTER_HOST_TOKEN_KEY) throw new ComputersNotConfigured(["COMPUTER_HOST_TOKEN_KEY"]);
    if (!this.env.COMPUTER_HOST_GATEWAY_URL) throw new ComputersNotConfigured(["COMPUTER_HOST_GATEWAY_URL"]);
    return {
      t: "assign",
      organizationId,
      hostToken: await hostToken(this.env.COMPUTER_HOST_TOKEN_KEY, organizationId),
      gatewayUrl: gatewayUrl(this.env.COMPUTER_HOST_GATEWAY_URL, organizationId),
    };
  }

  /** Deletes the pool computer with both disks; a transferred one is not this object's any more. */
  async retirePoolComputer(poolId: string): Promise<void> {
    this.bindPool(poolId);
    const row = this.lifecycle.row();
    if (!row || row.state === "transferred" || row.state === "deleted" || row.state === "deleting") return;
    await this.lifecycle.delete({ deleteDisk: true });
  }

  // ------------------------------------------------------------------ session API (work 084)

  /** One session API operation (api-http.ts resolved the caller); never throws for a refusal. */
  async computerApi(accountId: string, caller: ApiCaller, op: ApiOp | SecretsApiOp): Promise<ApiReply> {
    this.bind(accountId);
    // Organization secrets (work 095) answer whether or not the sessions API is enabled for the organization.
    if (op.op.startsWith("secrets.")) return this.secrets.api(caller, op as SecretsApiOp);
    return this.api.handle(caller, op as ApiOp);
  }

  /** The edge's key events (created or changed; revoked): the wire's KV records follow. */
  async keysSync(accountId: string, key: SyncedKey): Promise<void> {
    this.bind(accountId);
    await this.keys.sync(key);
  }

  async keysRevoke(accountId: string, keyId: string): Promise<boolean> {
    this.bind(accountId);
    return this.keys.revoke(keyId);
  }

  private apiComputerStatus(): "ready" | "asleep" | "not_set_up" {
    const row = this.lifecycle.row();
    if (!row || row.state === "deleted") return "not_set_up";
    if (row.state === "parked" || row.state === "parking") return "asleep";
    return "ready";
  }

  /** No host to take an API call: start or wake the computer, without any Slack notice. */
  private async wakeForApi(): Promise<void> {
    const row = this.lifecycle.row();
    if (!row || row.state === "deleted" || row.state === "failed") await this.ensureComputer(this.accountId());
    else if (row.state === "parked" || row.state === "parking") await this.wakeComputer();
    this.noteActivity();
  }

  /** Slack's admission (cached, revalidated off the path) without its Slack notice. Throws when billing is unavailable. */
  private async admitForApi(): Promise<boolean> {
    const accountId = this.accountId();
    const stored = this.storedAdmission();
    const age = stored ? Date.now() - stored.checkedAt : Infinity;
    if (stored?.allowed === true && age < ADMISSION_MAX_AGE_MS) {
      if (age >= ADMISSION_FRESH_MS) this.recheckAdmission(accountId);
      return true;
    }
    return (await this.checkAdmission(accountId)).deliver;
  }

  /** The recovery tick at `at`, or earlier if one is already due sooner. */
  private async scheduleRecover(at: number): Promise<void> {
    const current = [...this.ctx.storage.sql.exec<{ at: number }>("SELECT at FROM alarms WHERE purpose = 'recover'")][0]?.at;
    if (current !== undefined && current <= at && current > Date.now()) return;
    await this.schedule("recover", at);
  }

  sessions(accountId: string): ComputerSession[] {
    this.bind(accountId);
    const teamId = this.setting("slackTeamId") ?? null;
    return [...this.ctx.storage.sql.exec<SessionRow>(`${SESSION_SELECT} WHERE channel_id != '' ORDER BY updated_at DESC LIMIT 200`)].map((row) => ({
      key: row.key,
      title: row.title,
      channelId: row.channelId,
      threadTs: row.threadTs,
      ownerSlackUserId: row.ownerId,
      status: publicStatus(row.status),
      updatedAt: new Date(row.updatedAt).toISOString(),
      slackUrl: slackThreadUrl(teamId ?? row.teamId, row.channelId, row.threadTs),
    }));
  }

  /** Resize and disk growth, for operators; no public route yet. */
  resizeComputer(accountId: string, size: string): Promise<LifecycleReply> {
    this.bind(accountId);
    return this.lifecycle.resize(size);
  }

  /**
   * Takes down a stuck computer's VM, keeping its data disk, for operators; no
   * public route yet. The next create starts it again on the configured size.
   */
  resetComputer(accountId: string): Promise<LifecycleReply> {
    this.bind(accountId);
    return this.lifecycle.delete({ deleteDisk: false });
  }

  /** A one-hour push credential for this organization's automations repository (work 067). */
  private async automationPushCredential(): Promise<CalvinGitHubToken> {
    if (!this.env.SERVERLESS_AGENTS_DB) throw new Error("Automation repositories are not configured on this gateway");
    const credential = await automationRepositoryCredential(
      { ...this.env, SERVERLESS_AGENTS_DB: this.env.SERVERLESS_AGENTS_DB } as AutomationRepositoryEnv,
      { accountId: this.accountId(), userId: "computer" },
    );
    return { token: credential.password, expiresAt: credential.expiresAt, remoteUrl: credential.remoteUrl, username: credential.username };
  }

  growComputerDisk(accountId: string, diskGiB: number): Promise<LifecycleReply> {
    this.bind(accountId);
    return this.lifecycle.growDisk(diskGiB);
  }

  // ------------------------------------------------------------------ preview URLs (work 074; the previews Worker asks)

  /** The `preview` part of a welcome; never fails the welcome (a broken tunnel row only costs previews). */
  private async previewWelcome(): Promise<{ preview?: CalvinPreviewConfig }> {
    try {
      const preview = await this.previews.hostConfig();
      return preview ? { preview } : {};
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "computer.preview_config_failed", message: errorText(error) }));
      return {};
    }
  }

  /** The organization's computer, as the previews Worker needs it; never binds an object (the Worker names it). */
  private previewOrganization(): boolean {
    const accountId = this.setting("accountId");
    return Boolean(accountId) && !isPoolId(accountId!);
  }

  /** Asked when the tunnel is not connected (530): asleep gets the Wake button, waking the refreshing page. */
  previewState(): PreviewComputerState {
    if (!this.previewOrganization()) return "gone";
    const state = this.lifecycle.row()?.state;
    if (state === "parked" || state === "parking") return "asleep";
    if (state === "provisioning" || state === "waking" || state === "resizing") return "waking";
    if (state === "ready") return this.socket() ? "ready" : "waking";
    return "gone";
  }

  /**
   * A visitor pressed Wake on a registered name's page. Wakes a parked
   * computer, at most PREVIEW_WAKE_LIMIT times an hour, and says nothing in
   * Slack (ensureAwake's notices are for people in a thread).
   */
  async wakeForPreview(name: string): Promise<"waking" | "refused"> {
    if (!this.previewOrganization() || !this.previews.registered(name)) return "refused";
    const state = this.previewState();
    // Already on its way up (or up, with the tunnel still connecting): nothing to do, nothing to charge.
    if (state === "waking" || state === "ready") return "waking";
    if (state !== "asleep" || !this.previews.allowWake()) return "refused";
    console.log(JSON.stringify({ level: "info", event: "computer.preview_wake", accountId: this.setting("accountId"), name }));
    // lifecycle.wake answers false when the row changed under it (deleting, a wake already in flight).
    if (!(await this.wakeComputer())) return "refused";
    this.noteActivity();
    return "waking";
  }

  /** A preview served a visitor (at most every 30 s per name and isolate): the computer is in use, so it does not park. */
  notePreviewHit(): void {
    if (this.previewOrganization() && this.lifecycle.row()?.state === "ready") this.noteActivity();
  }

  /** The host's `/data` usage (work 071): grow the data disk near capacity, up to COMPUTER_MAX_DISK_GIB. */
  private async diskReported(report: DiskReport): Promise<void> {
    const row = this.lifecycle.row();
    if (row?.state !== "ready") return;
    const now = Date.now();
    const decision = diskDecision(report, { diskGiB: row.diskGiB, maxGiB: maxDiskGiB(this.env), grownAt: Number(this.setting("diskGrownAt") ?? 0) }, now);
    if (decision.action === "none") return;
    const base = { accountId: this.setting("accountId"), diskGiB: row.diskGiB, usedPct: Math.round(decision.usedShare * 100) };
    // `ceiling` is for alerting: the disk is nearly full and will not grow on its own.
    if (decision.action !== "grow") {
      const level = decision.action === "ceiling" ? "error" : "info";
      console.log(JSON.stringify({ level, event: `computer.disk_${decision.action}`, ...base }));
      return;
    }
    const reply = await this.lifecycle.growDisk(decision.diskGiB);
    if (reply.status !== 200) {
      console.log(JSON.stringify({ level: "error", event: "computer.disk_grow_failed", ...base, to: decision.diskGiB, error: reply.error }));
      return;
    }
    this.put("diskGrownAt", String(now));
    console.log(JSON.stringify({ level: "info", event: "computer.disk_grown", ...base, to: decision.diskGiB }));
  }

  // ------------------------------------------------------------------ Slack install (routes.ts)

  /** A nonce for the install's state, bound to this organization and the user starting it. */
  async startSlackInstall(accountId: string, userId: string, nonce: string): Promise<void> {
    this.bind(accountId);
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM install_nonces WHERE expires_at < ?", now - INSTALL_NONCE_TTL_MS);
    this.ctx.storage.sql.exec(
      "INSERT INTO install_nonces (nonce_hash, user_id, expires_at) VALUES (?, ?, ?)",
      await sha256Hex(nonce),
      userId,
      now + INSTALL_NONCE_TTL_MS,
    );
  }

  /** Spends an install nonce: once, before it expires. */
  async consumeSlackInstall(accountId: string, nonce: string): Promise<{ ok: true; userId: string } | { ok: false; reason: "invalid_state" | "state_expired" }> {
    if (this.setting("accountId") !== accountId) return { ok: false, reason: "invalid_state" };
    const hash = await sha256Hex(nonce);
    const row = [...this.ctx.storage.sql.exec<{ userId: string; expiresAt: number }>(
      "SELECT user_id AS userId, expires_at AS expiresAt FROM install_nonces WHERE nonce_hash = ?",
      hash,
    )][0];
    if (!row) return { ok: false, reason: "invalid_state" };
    this.ctx.storage.sql.exec("DELETE FROM install_nonces WHERE nonce_hash = ?", hash);
    if (row.expiresAt < Date.now()) return { ok: false, reason: "state_expired" };
    return { ok: true, userId: row.userId };
  }

  /** Stores the linked workspace's bot token, sealed. Returns the team this organization was linked to before, if another. */
  async linkSlack(accountId: string, link: SlackLink): Promise<{ previousTeamId: string | null }> {
    this.bind(accountId);
    const previous = this.setting("slackTeamId") ?? null;
    this.put("slackTeamId", link.teamId);
    this.put("slackTeamName", link.teamName);
    this.put("slackBotUserId", link.botUserId);
    // Who to ask when someone else tries to link this workspace; links made
    // before this was kept have none, and nobody is asked.
    if (link.installerUserId) this.put("slackInstallerUserId", link.installerUserId);
    else this.remove("slackInstallerUserId");
    if (previous !== link.teamId) this.ctx.storage.sql.exec("DELETE FROM join_requests");
    this.unsealed.clear();
    this.put(
      "slackBotToken",
      await seal(link.botToken, this.env.BLUE_CHANNEL_ENCRYPTION_KEY, "slack-bot-token", `${accountId}\0${link.teamId}`),
    );
    this.send({ t: "credentials", credentials: await this.credentials() });
    // Work 081: the installer's token from the dashboard moves to their Slack id (never throws).
    if (link.installerUserId && link.dashboardUserId) await this.access.agents.rekey(link.dashboardUserId, link.installerUserId);
    return { previousTeamId: previous && previous !== link.teamId ? previous : null };
  }

  /** Forgets the linked workspace's bot token. Returns the team that was linked, or null. */
  async unlinkSlack(accountId: string): Promise<{ teamId: string | null }> {
    this.bind(accountId);
    const teamId = this.setting("slackTeamId") ?? null;
    if (!teamId || !this.setting("slackBotToken")) return { teamId: null };
    // Work 081: the installer's token goes back to their dashboard id, the workspace's others go (never throws).
    await this.access.agents.unrekey(this.setting("slackInstallerUserId"));
    this.remove("slackTeamId", "slackTeamName", "slackBotUserId", "slackBotToken", "slackInstallerUserId");
    this.unsealed.clear();
    this.ctx.storage.sql.exec("DELETE FROM join_requests");
    // Other threads' text read for that workspace goes with it.
    this.ctx.storage.sql.exec("UPDATE dispatches SET payload = json_remove(payload, '$.linked') WHERE json_extract(payload, '$.linked') IS NOT NULL");
    this.send({ t: "credentials", credentials: await this.credentials() });
    return { teamId };
  }

  /**
   * Unlinks Slack when the linked workspace's bot token is dead (the app was
   * uninstalled or the token revoked), on Slack's word: asks auth.test with
   * the token, so neither an event nor another organization's install can
   * unlink a working link. Whether it unlinked; the caller releases the team.
   */
  async unlinkRevokedSlack(accountId: string, teamId: string): Promise<{ unlinked: boolean }> {
    if (this.setting("accountId") !== accountId || this.setting("slackTeamId") !== teamId || !this.setting("slackBotToken")) {
      return { unlinked: false };
    }
    const answer = await this.slack("auth.test", {});
    if (!slackTokenDead(answer)) return { unlinked: false };
    await this.unlinkSlack(accountId);
    console.log(JSON.stringify({ level: "info", event: "computer.slack_revoked_unlinked", accountId, teamId, error: answer.error }));
    return { unlinked: true };
  }

  /**
   * Someone in this organization's Slack workspace tried to link it to
   * another organization (routes.ts refused it). DM them that the workspace
   * is already here, and DM the person who linked it (when known, and not
   * the same person) to invite them. Once per requester per
   * JOIN_REQUEST_INTERVAL_MS: a repeat sends nothing and reports what the
   * first did. DM failures are logged, never thrown.
   */
  async notifyJoinRequest(accountId: string, input: { teamId: string; requesterUserId: string }): Promise<JoinRequestOutcome> {
    if (this.setting("accountId") !== accountId || this.setting("slackTeamId") !== input.teamId || !this.setting("slackBotToken")) {
      return { installerNotified: false };
    }
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM join_requests WHERE notified_at < ?", now - JOIN_REQUEST_INTERVAL_MS);
    const earlier = [...sql.exec<{ installerNotified: number }>(
      "SELECT installer_notified AS installerNotified FROM join_requests WHERE slack_user_id = ?",
      input.requesterUserId,
    )][0];
    if (earlier) return { installerNotified: earlier.installerNotified === 1 };

    const installerUserId = this.setting("slackInstallerUserId") ?? null;
    const messages = joinRequestMessages({
      requesterUserId: input.requesterUserId,
      installerUserId,
      settingsUrl: `${publicOrigin(this.env)}/settings`,
    });
    const requesterSent = await this.directMessage(input.requesterUserId, messages.requester);
    const installerNotified = installerUserId && messages.installer ? await this.directMessage(installerUserId, messages.installer) : false;
    console.log(JSON.stringify({ level: "info", event: "computer.slack_join_request", accountId, teamId: input.teamId, requesterSent, installerNotified }));
    // Nothing went out: let a retry try again rather than stay silent for a day.
    if (requesterSent || installerNotified) {
      sql.exec(
        "INSERT INTO join_requests (slack_user_id, installer_notified, notified_at) VALUES (?, ?, ?) ON CONFLICT(slack_user_id) DO UPDATE SET installer_notified = excluded.installer_notified, notified_at = excluded.notified_at",
        input.requesterUserId,
        installerNotified ? 1 : 0,
        now,
      );
    }
    return { installerNotified };
  }

  /** A DM from the bot: conversations.open, then chat.postMessage. Whether it was posted. */
  private async directMessage(userId: string, message: string | SlackNotice): Promise<boolean> {
    const opened = await this.slack("conversations.open", { users: userId });
    const channel = opened.ok ? opened.channel?.id : undefined;
    const posted = channel ? await this.slack("chat.postMessage", { channel, ...(typeof message === "string" ? { text: message } : message) }) : opened;
    if (!posted.ok) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.slack_dm_failed", step: channel ? "chat.postMessage" : "conversations.open", error: posted.error ?? "unknown" }));
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ team link objects (`computer-slack-team:<teamId>`)

  /**
   * Links a Slack workspace to an organization; refused when another
   * organization holds it, naming the holder so the edge can route to its
   * object (internal only: never shown to the caller's user).
   */
  claimTeam(teamId: string, accountId: string): { ok: true } | { ok: false; holder: string } {
    const holder = this.setting("teamLinkAccountId");
    if (holder && holder !== accountId) return { ok: false, holder };
    this.put("teamLinkTeamId", teamId);
    this.put("teamLinkAccountId", accountId);
    return { ok: true };
  }

  teamAccount(): string | null {
    return this.setting("teamLinkAccountId") ?? null;
  }

  releaseTeam(accountId: string): void {
    if (this.setting("teamLinkAccountId") === accountId) this.remove("teamLinkAccountId", "teamLinkTeamId");
  }

  // ------------------------------------------------------------------ Slack events (routes.ts → here)

  /**
   * Dedup and queue, then drain the queue inline (work 068 §3a): the row is
   * the durability (an eviction before the send still delivers, from the
   * alarm armed SLACK_FALLBACK_MS out), the drain is the speed. Returns
   * whether it was new.
   */
  async acceptSlackEvent(accountId: string, job: SlackMessageJob): Promise<{ accepted: boolean; unlinked?: boolean }> {
    this.bind(accountId);
    if (job.teamId !== this.setting("slackTeamId") || !this.setting("slackBotToken")) {
      this.telemetry.refused(job, { ignored: "unlinked" });
      return { accepted: false, unlinked: true };
    }
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM slack_events WHERE received_at < ?", job.receivedAt - DEDUP_TTL_MS);
    sql.exec("DELETE FROM slack_messages WHERE received_at < ?", job.receivedAt - DEDUP_TTL_MS);
    if (sql.exec("INSERT OR IGNORE INTO slack_events (event_id, received_at) VALUES (?, ?)", job.eventId, job.receivedAt).rowsWritten === 0) {
      this.telemetry.refused(job, { deduped: job.eventId });
      return { accepted: false };
    }
    // Slack sends both `message` and `app_mention` for one mention, with
    // different event ids: the first of the two to arrive is the one.
    if (
      sql.exec(
        "INSERT OR IGNORE INTO slack_messages (message_key, received_at) VALUES (?, ?)",
        `${job.channelId}:${job.messageTs}`,
        job.receivedAt,
      ).rowsWritten === 0
    ) {
      this.telemetry.refused(job, { deduped: `${job.channelId}:${job.messageTs}` });
      return { accepted: false };
    }
    const normalized = normalizeJob(job, this.setting("slackBotUserId") ?? "");
    if (!normalized) {
      this.telemetry.refused(job, { ignored: "empty" });
      return { accepted: false };
    }
    // The working status starts here, not when the queue gets to the message:
    // it runs beside the queue and never holds it up. The credit gate comes
    // later; a refusal waits for this and resets it (`admit`).
    const t = this.telemetry.job(normalized);
    const session = this.session(sessionKey(normalized.teamId, normalized.channelId, normalized.threadTs));
    const acked = wantsAcknowledgement(normalized, session !== undefined);
    const sequence = [...sql.exec<{ sequence: number }>(
      "INSERT INTO slack_queue (payload, available_at, thread_key) VALUES (?, ?, ?) RETURNING sequence",
      JSON.stringify(acked ? { ...normalized, acked } : normalized),
      Date.now(),
      `${normalized.channelId}:${normalized.threadTs}`,
    )][0]!.sequence;
    if (acked) this.startAcknowledgement(t, normalized, session?.ownerId ?? normalized.userId, sequence);
    // Since the gateway received it: the team lookup, this call and the object's wake. The queue's delay follows.
    t.emit("message.accepted", { duration_ms: Date.now() - normalized.receivedAt, data: { ack: acked } });
    this.telemetry.send(t);
    // The fallback alarm's row first (synchronous), so the drain's own reschedule
    // sees it; then the drain, which claims the row before its first await (a drain
    // already running is woken to take it); then the alarm itself.
    sql.exec(
      "INSERT INTO alarms (purpose, at) VALUES ('slack', ?) ON CONFLICT(purpose) DO UPDATE SET at = MIN(at, excluded.at)",
      Date.now() + SLACK_FALLBACK_MS,
    );
    this.inlineRows.add(sequence);
    this.ctx.waitUntil(this.drain().catch((error) => console.error(JSON.stringify({ level: "error", event: "computer.slack_drain_failed", message: errorText(error) }))));
    await this.armAlarm();
    return { accepted: true };
  }

  /**
   * Starts the working status for a message, off the caller's path; `ack.done`
   * goes on `t` when it settles. The queue row says so (`acked`) and, once
   * Slack answered, which indicator is showing (`ackIndicator`): what takes it
   * off again is decided from the row, which survives retries and eviction
   * (`withdrawAcknowledgement`). The in-memory promise only orders a reset after it.
   */
  private startAcknowledgement(t: GatewayTelemetry, job: SlackMessageJob, ownerId: string, sequence: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE slack_queue SET payload = json_set(payload, '$.acked', json('true')) WHERE sequence = ?", sequence);
    const key = `${job.channelId}:${job.messageTs}`;
    const ack = this.acknowledge(job, ownerId).then((result) => {
      sql.exec("UPDATE slack_queue SET payload = json_set(payload, '$.ackIndicator', ?) WHERE sequence = ?", result.ok ? result.indicator : "none", sequence);
      return result;
    });
    this.acks.set(key, ack);
    // Ordering only: forgotten once the queue has handled the message; a cap keeps a stuck queue from growing it.
    if (this.acks.size > 200) this.acks.delete(this.acks.keys().next().value!);
    this.ctx.waitUntil(this.telemetry.acked(t, job, ack));
  }

  /**
   * A message that will not be dispatched (refused, unlinked, or failed for
   * good): take its working status or 👀 off. Decided from the queue row;
   * when Slack's answer never got there (the object went away mid-call), both
   * are taken off. `statusReset`: the caller resets the status itself.
   * Never throws.
   */
  private async withdrawAcknowledgement(job: SlackMessageJob, sequence: number, o: { statusReset?: boolean } = {}): Promise<void> {
    try {
      const pending = this.acks.get(`${job.channelId}:${job.messageTs}`);
      if (pending) await pending.catch(() => null);
      const row = [...this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM slack_queue WHERE sequence = ?", sequence)][0];
      const stored = row ? (JSON.parse(row.payload) as SlackMessageJob) : job;
      if (!stored.acked || stored.ackIndicator === "none") return;
      if (!o.statusReset && stored.ackIndicator !== "reaction") {
        await this.slack("agents.sessions.setStatus", { channel_id: job.channelId, thread_ts: job.threadTs, status: "active" });
      }
      if (stored.ackIndicator !== "status") await this.slack("reactions.remove", { channel: job.channelId, timestamp: job.messageTs, name: "eyes" });
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.ack_withdraw_failed", message: errorText(error) }));
    }
  }

  // ------------------------------------------------------------------ the Slack queue (work 068 §3a–3c)
  //
  // One drain at a time per object (`draining`): an accept starts it inline,
  // in `waitUntil`, and a second accept or the alarm joins it. The drain runs
  // one serial chain per thread (`thread_key`, `<channel>:<thread ts>`), up to
  // SLACK_PARALLEL_THREADS chains at once, so one thread's slow job (billing,
  // a wake, Slack) never holds another thread's message; within a thread rows
  // go in `sequence` order. SQLite here is synchronous and the chains only
  // interleave at awaits, so a row is claimed `running` (with `started_at`)
  // before its first await and no two chains or drains can take it.
  //
  // A DO's `waitUntil` does not keep it from eviction: a row left `running`
  // by an evicted drain is recovered after SLACK_STRANDED_MS, on the next
  // alarm or when the object starts again (`recoverStrandedSlackJobs`).

  /**
   * Drain the queue, or join the drain in flight and have it look again (a
   * new thread's row starts its chain at once, not when a running chain
   * ends).
   */
  private drain(): Promise<void> {
    if (this.draining) {
      this.wakeDrain?.();
      return this.draining;
    }
    this.draining = this.runDrain();
    return this.draining;
  }

  private async runDrain(): Promise<void> {
    try {
      await this.drainThreads();
    } finally {
      // Synchronously after the drain's last look at the queue: an accept from
      // here on starts a new drain rather than join one that is done.
      this.draining = undefined;
    }
    this.ctx.storage.sql.exec("DELETE FROM slack_queue WHERE state = 'failed' AND sequence < (SELECT MAX(sequence) - 1000 FROM slack_queue)");
    await this.rescheduleSlack();
  }

  private async drainThreads(): Promise<void> {
    const chains = new Map<string, Promise<void>>();
    const budget = { left: SLACK_DRAIN_MAX_JOBS };
    for (;;) {
      if (budget.left > 0) {
        for (const thread of this.readySlackThreads()) {
          if (chains.size >= SLACK_PARALLEL_THREADS) break;
          if (chains.has(thread)) continue;
          // Registered before it runs: the chain reads `chains.size` for `parallel`.
          const chain: Promise<void> = Promise.resolve()
            .then(() => this.runThread(thread, budget, () => chains.size))
            .catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "computer.slack_chain_failed", message: errorText(error) })))
            .finally(() => chains.delete(thread));
          chains.set(thread, chain);
        }
      }
      if (!chains.size) return;
      const woken = new Promise<void>((resolve) => (this.wakeDrain = resolve));
      await Promise.race([...chains.values(), woken]);
      this.wakeDrain = undefined;
    }
  }

  /** One thread's chain: its ready rows in order, each claimed before its first await. */
  private async runThread(thread: string, budget: { left: number }, parallel: () => number): Promise<void> {
    const sql = this.ctx.storage.sql;
    while (budget.left > 0) {
      const next = [...sql.exec<{ sequence: number; payload: string; attempts: number }>(
        `SELECT sequence, payload, attempts FROM slack_queue
         WHERE state = 'pending' AND available_at <= ? AND COALESCE(thread_key, 'seq:' || sequence) = ?
         ORDER BY sequence LIMIT 1`,
        Date.now(),
        thread,
      )][0];
      if (!next) return;
      const claimed = sql.exec(
        "UPDATE slack_queue SET state = 'running', attempts = attempts + 1, started_at = ? WHERE sequence = ? AND state = 'pending'",
        Date.now(),
        next.sequence,
      ).rowsWritten;
      if (!claimed) continue;
      budget.left -= 1;
      this.inFlight.add(next.sequence);
      try {
        // Inline: accepted by this instance and taken now, by whichever drain (a retry or a recovered row is not).
        await this.runSlackJob(next, { inline: this.inlineRows.delete(next.sequence), parallel: parallel() });
      } finally {
        this.inFlight.delete(next.sequence);
      }
    }
  }

  /** Threads with a row ready to run, oldest first. Rows from before `thread_key` are a thread each. */
  private readySlackThreads(): string[] {
    return [...this.ctx.storage.sql.exec<{ thread: string }>(
      `SELECT COALESCE(thread_key, 'seq:' || sequence) AS thread, MIN(sequence) AS first FROM slack_queue
       WHERE state = 'pending' AND available_at <= ? GROUP BY thread ORDER BY first LIMIT ?`,
      Date.now(),
      SLACK_PARALLEL_THREADS * 4,
    )].map((row) => row.thread);
  }

  /** One claimed row: processed and deleted, or backed off, or given up on (its acknowledgement withdrawn). */
  private async runSlackJob(next: { sequence: number; payload: string; attempts: number }, how: { inline: boolean; parallel: number }): Promise<void> {
    const sql = this.ctx.storage.sql;
    const attempts = next.attempts + 1;
    const queued = this.telemetry.dequeued(next.payload, attempts, how);
    let job: SlackMessageJob | undefined;
    try {
      job = JSON.parse(next.payload) as SlackMessageJob;
      await this.process(job, queued.t, next.sequence);
      sql.exec("DELETE FROM slack_queue WHERE sequence = ?", next.sequence);
    } catch (error) {
      queued.failed(attempts >= SLACK_MAX_ATTEMPTS);
      if (attempts >= SLACK_MAX_ATTEMPTS) {
        // Given up: nothing will be dispatched, so the working status comes off.
        if (job) await this.withdrawAcknowledgement(job, next.sequence);
        sql.exec("UPDATE slack_queue SET state = 'failed', last_error = ? WHERE sequence = ?", errorText(error).slice(0, 500), next.sequence);
      } else {
        sql.exec(
          "UPDATE slack_queue SET state = 'pending', available_at = ?, last_error = ? WHERE sequence = ?",
          Date.now() + Math.min(60_000, 1000 * 2 ** attempts),
          errorText(error).slice(0, 500),
          next.sequence,
        );
      }
    }
    this.telemetry.send(queued.t);
  }

  /**
   * Rows `running` since more than `graceMs` ago that no drain of this
   * instance holds go back to `pending`, attempts kept (an eviction mid-job
   * used to strand them forever). How many.
   */
  private recoverStrandedSlackJobs(graceMs: number): number {
    const sql = this.ctx.storage.sql;
    const cutoff = Date.now() - graceMs;
    const stranded = [...sql.exec<{ sequence: number }>(
      "SELECT sequence FROM slack_queue WHERE state = 'running' AND COALESCE(started_at, 0) <= ?",
      cutoff,
    )].filter((row) => !this.inFlight.has(row.sequence));
    for (const row of stranded) {
      sql.exec("UPDATE slack_queue SET state = 'pending', available_at = ? WHERE sequence = ? AND state = 'running'", Date.now(), row.sequence);
    }
    if (stranded.length) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.slack_jobs_recovered", count: stranded.length }));
    }
    return stranded.length;
  }

  private slackQueueBusy(): boolean {
    return [...this.ctx.storage.sql.exec("SELECT 1 FROM slack_queue WHERE state IN ('pending', 'running') LIMIT 1")].length > 0;
  }

  /** The `slack` alarm no later than `at` (an earlier one stays). */
  private async scheduleSlack(at: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO alarms (purpose, at) VALUES ('slack', ?) ON CONFLICT(purpose) DO UPDATE SET at = MIN(at, excluded.at)",
      at,
    );
    await this.armAlarm();
  }

  /**
   * The `slack` alarm for what the queue still holds: the next row ready to
   * retry, or a `running` row no drain of this instance holds (stranded, once
   * its grace is up); none when the queue is empty, and then the platform's
   * alarm follows the table (the fallback armed on accept must not fire for
   * nothing).
   */
  private async rescheduleSlack(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const pending = [...sql.exec<{ at: number | null }>("SELECT MIN(available_at) AS at FROM slack_queue WHERE state = 'pending'")][0]?.at ?? null;
    // Rows this instance is processing reschedule when they finish; only the others can be stranded.
    const running = [...sql.exec<{ sequence: number; at: number }>("SELECT sequence, COALESCE(started_at, 0) AS at FROM slack_queue WHERE state = 'running'")]
      .filter((row) => !this.inFlight.has(row.sequence))
      .reduce<number | null>((min, row) => (min === null || row.at < min ? row.at : min), null);
    const candidates = [pending, running === null ? null : running + SLACK_STRANDED_GRACE_MS + 1].filter((at): at is number => at !== null);
    if (!candidates.length) {
      sql.exec("DELETE FROM alarms WHERE purpose = 'slack'");
      await this.syncAlarm();
      return;
    }
    await this.schedule("slack", Math.max(Math.min(...candidates), Date.now() + 25));
  }

  /** The platform's alarm set to exactly what the `alarms` table says is due next, or cleared when nothing is. */
  private async syncAlarm(): Promise<void> {
    const next = [...this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM alarms")][0]?.at ?? null;
    if (next === null) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
  }

  /** One Slack message: a conversation's first mention starts a session; later messages in its thread continue it. */
  private async process(job: SlackMessageJob, t: GatewayTelemetry, sequence: number): Promise<void> {
    const teamId = this.setting("slackTeamId");
    if (!teamId || teamId !== job.teamId) {
      await this.withdrawAcknowledgement(job, sequence);
      return t.emit("message.ignored", { data: { reason: "unlinked" } });
    }
    const key = sessionKey(teamId, job.channelId, job.threadTs);
    let session = this.session(key);
    if (!session && !job.mentioned && job.channelType !== "im") {
      await this.withdrawAcknowledgement(job, sequence);
      return t.emit("message.ignored", { data: { reason: "not_addressed" } });
    }
    // Commands answer with ephemerals: in the thread the command was sent in, else at the top
    // level (a `thread_ts` of a message with no thread hides the answer in a thread nobody opens).
    const text = commandText(job.text);
    const here = { userId: job.userId, channelId: job.channelId, ...(job.threadTs !== job.messageTs ? { threadTs: job.threadTs } : {}) };
    const inSession = session?.ownerId ? { session: { key, ownerId: session.ownerId } } : {};
    // `!secret` and `!var` are the gateway's: they never reach the session or its history.
    const secretCommand = parseSecretCommand(text);
    if (secretCommand) {
      return this.telemetry.command(t, "secret", this.secrets.command(secretCommand, { ...here, ...inSession }));
    }
    // The subscription commands (work 097, 6b): only where ModelAccess has them; elsewhere the text is the session's.
    const slack = this.access.slack;
    if (slack) {
      // `!claude` (work 077): the person's own Claude subscription, before the credit gate.
      const claudeCommand = parseClaudeCommand(text);
      if (claudeCommand) {
        return this.telemetry.command(t, "claude", slack.claude.command(claudeCommand, { ...here, ...inSession }));
      }
      // `!codex` (work 082): the person's ChatGPT plan, and this thread on Codex; before the credit gate too.
      const codexCommand = parseCodexCommand(text);
      if (codexCommand) {
        return this.telemetry.command(t, "codex", slack.codex.command(codexCommand, { ...here, ...inSession }));
      }
      // `!link <code>` (work 083): this Slack user becomes the dashboard user who was shown the code.
      const linkCommand = parseLinkCommand(text);
      if (linkCommand) {
        return this.telemetry.command(t, "link", slack.link.command(linkCommand, here));
      }
    }
    const variableCommand = parseVariableCommand(text);
    if (variableCommand) {
      return this.telemetry.command(t, "variable", this.secrets.variableCommand(variableCommand, { ...here, ...inSession }, text));
    }
    // The credit gate, before anything is created or delivered (the working
    // status was usually started on accept; a refusal resets it).
    const ackKey = `${job.channelId}:${job.messageTs}`;
    let admitted: boolean;
    try {
      admitted = await this.admit(job.channelId, job.threadTs, { messageTs: job.messageTs, t });
    } finally {
      this.acks.delete(ackKey);
    }
    if (!admitted) {
      // refuseForCredits reset the status; a 👀 comes off here.
      await this.withdrawAcknowledgement(job, sequence, { statusReset: true });
      return t.emit("message.ignored", { data: { reason: "no_credits" } });
    }
    const addressed = session !== undefined;
    if (!session) {
      const start = takeHarnessPrefix(job.text);
      const input = { ...job, text: start.text };
      // Commit the choice and cleaned queued input together: a retry after
      // session creation must still deliver +smart without the harness prefix.
      session = this.ctx.storage.transactionSync(() => {
        const created = this.createSession({ channelId: job.channelId, threadTs: job.threadTs, ownerId: job.userId, title: input.text });
        this.chooseHarness(created.key, job.userId, start.harness);
        if (start.harness) this.ctx.storage.sql.exec("UPDATE slack_queue SET payload = ? WHERE sequence = ?", JSON.stringify(input), sequence);
        return created;
      });
      job = input;
    }
    // Not started on accept (a job queued before that, or one it skipped): start it now.
    if (!job.acked && wantsAcknowledgement(job, addressed)) this.startAcknowledgement(t, job, session.ownerId ?? job.userId, sequence);
    this.acks.delete(ackKey);
    const mentioned = job.mentioned || job.channelType === "im";
    // A mention partway through a thread starts the session: it also gets the replies above (it sees only what comes after).
    const above = !addressed && job.channelType !== "im" && job.threadTs !== job.messageTs;
    const linked = await this.linkedThreads(t, job, session.ownerId ?? job.userId, above);
    await this.deliver({
      channelId: job.channelId,
      threadTs: job.threadTs,
      messageTs: job.messageTs,
      userId: job.userId,
      text: job.text,
      ...(job.files?.length ? { files: job.files } : {}),
      mentioned,
      ...(job.trace ? { trace: job.trace } : {}),
      ...(linked.length ? { linked } : {}),
    }, t);
  }

  private threads(): ThreadAccess {
    const teamId = this.setting("slackTeamId") ?? "";
    if (this.threadAccess?.teamId !== teamId) {
      this.threadAccess = { teamId, access: new ThreadAccess((method, body) => this.slack(method, body)) };
    }
    return this.threadAccess.access;
  }

  /**
   * Threads linked in a person's message (work 049 L3, decision D7), and with
   * `above` the replies above it in its own thread: read under D6 for the
   * session's owner and the poster, at most 10 s; past that each is delivered
   * as not read. Messages forwarded in it come first, as they are. Logs
   * outcomes, never content.
   */
  private async linkedThreads(t: GatewayTelemetry, job: SlackMessageJob, ownerId: string, above = false): Promise<Linked[]> {
    const links = findThreadLinks(job.text);
    const forwarded = forwardedLinked(job.forwarded);
    if (!links.length && !above) {
      if (forwarded.length) t.emit("links.resolved", { data: { count: 0, timed_out: false, forwarded: forwarded.length } });
      return forwarded;
    }
    const started = Date.now();
    const audience = { owner: ownerId, poster: job.userId, destination: job.channelId, deadline: started + LINK_TIMEOUT_MS };
    const late = "reading it took too long; ask again to retry";
    const here = { url: "", channel: job.channelId, ts: job.messageTs, threadTs: job.threadTs };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Linked[]>((resolve) => {
      timer = setTimeout(
        () => resolve([...(above ? [{ url: "", ok: false as const, reason: late, here: true }] : []), ...links.map((link) => ({ url: link.url, ok: false as const, reason: late }))]),
        LINK_TIMEOUT_MS,
      );
    });
    const reading = Promise.all([
      above ? this.threads().read(here, audience, job.messageTs).then((l): Linked[] => [{ ...l, here: true }]) : [],
      this.threads().resolve(job.text, audience),
    ]).then((r) => r.flat());
    let expired = false;
    const linked = await Promise.race([reading, timedOut.then((l) => ((expired = true), l))]).finally(() => clearTimeout(timer));
    t.emit("links.resolved", { duration_ms: Date.now() - started, data: { count: links.length, timed_out: expired, forwarded: forwarded.length } });
    console.log(
      JSON.stringify({
        level: "info",
        event: "computer.threads_linked",
        read: linked.filter((l) => l.ok).length,
        refused: linked.filter((l) => !l.ok).length,
        ms: Date.now() - started,
      }),
    );
    return [...forwarded, ...linked];
  }

  /**
   * The autonomous sessions' credit admission (admission.ts). Refused: the
   * thread is told once and nothing is delivered. Billing unavailable:
   * throws, and the Slack queue retries the message.
   */
  private async admit(channelId: string, threadTs: string, o: { messageTs?: string; t?: GatewayTelemetry } = {}): Promise<boolean> {
    return this.telemetry.within(o.t, (t) => this.admitWith(t, channelId, threadTs, o.messageTs));
  }

  private async admitWith(t: GatewayTelemetry, channelId: string, threadTs: string, messageTs: string | undefined): Promise<boolean> {
    const accountId = this.accountId();
    const stored = this.storedAdmission();
    const age = stored ? Date.now() - stored.checkedAt : Infinity;
    const cached = stored?.allowed === true && age < ADMISSION_MAX_AGE_MS;
    const span = t.start("admission.checked", { data: { cached } });
    let admission: DeliveryAdmission;
    try {
      admission = cached ? { deliver: true } : await this.checkAdmission(accountId);
    } catch (error) {
      span.end({ outcome: "failed", error_type: "unknown" });
      throw error;
    }
    span.end({ outcome: "completed", data: { cached, decision: admission.deliver ? "allowed" : "refused" } });
    // Served from storage and no longer fresh: billing is asked again off the path (stale-while-revalidate).
    if (cached && age >= ADMISSION_FRESH_MS) this.recheckAdmission(accountId);
    if (admission.deliver) {
      forgetCreditsNotice(this.ctx.storage.sql, channelId, threadTs);
      const warning = cached ? stored?.warning : admission.warning;
      if (warning) this.warnOfBilling(t, warning, channelId, threadTs);
      return true;
    }
    console.log(JSON.stringify({ level: "info", event: "computer.delivery_refused_credits", accountId }));
    // The working status started on accept lands before the reset, never after it.
    const pending = messageTs ? this.acks.get(`${channelId}:${messageTs}`) : undefined;
    if (pending) await pending.catch(() => null);
    const shown = await refuseForCredits({
      sql: this.ctx.storage.sql,
      slack: (method, body) => this.slack(method, body),
      channelId,
      threadTs,
      origin: publicOrigin(this.env),
      onPro: admission.onPro === true,
      haltReason: admission.haltReason ?? null,
    });
    if (shown) paywallShown(t, admission.haltReason ?? null);
    return false;
  }

  /**
   * The warning before the stop (086), told once per reason per run of
   * warnings (`since`): to the person who installed Slack, in a DM. A link
   * made before the installer was kept has nobody to DM, and a DM can fail:
   * then this thread hears it, once. Kept in `billing_warnings`, not
   * `notices`, so a wake does not repeat it; keyed by the recipient (the
   * workspace's installer, or the thread), so a new installer hears a
   * standing warning. Claimed here, synchronously (one send in flight), posted
   * off the chain like the waking notice, and released when nothing was shown,
   * so the next message tries again.
   */
  private warnOfBilling(t: GatewayTelemetry, warning: BillingWarning, channelId: string, threadTs: string): void {
    const message = billingWarningMessage(publicOrigin(this.env), warning.reason);
    if (!message) return;
    const sql = this.ctx.storage.sql;
    const kind = `${warning.reason}:${warning.since ?? 0}`;
    const claim = (recipient: string) =>
      sql.exec("INSERT OR IGNORE INTO billing_warnings (recipient, kind) VALUES (?, ?)", recipient, kind).rowsWritten > 0;
    const release = (recipient: string) => sql.exec("DELETE FROM billing_warnings WHERE recipient = ? AND kind = ?", recipient, kind);
    const thread = `thread:${channelId}:${threadTs}`;
    const installer = this.setting("slackInstallerUserId");
    const dm = installer ? `dm:${this.setting("slackTeamId") ?? ""}:${installer}` : null;
    const toInstaller = dm ? claim(dm) : false;
    const toThread = !dm && claim(thread);
    if (!toInstaller && !toThread) return;
    const work = (async () => {
      let shown = toInstaller && installer ? await this.directMessage(installer, message) : false;
      let threadClaimed = toThread;
      if (!shown && (toThread || (threadClaimed = claim(thread)))) {
        shown = (await this.slack("chat.postMessage", { channel: channelId, thread_ts: threadTs, ...message })).ok;
      }
      if (shown) {
        t.emit("billing.warning_shown", { data: { reason: warning.reason, surface: "slack" } });
        return;
      }
      if (toInstaller && dm) release(dm);
      if (threadClaimed) release(thread);
    })().catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.billing_warning_failed", message: errorText(error) })));
    t.wait(work);
    this.ctx.waitUntil(work);
  }

  private storedAdmission(): StoredAdmission | null {
    try {
      const raw = this.setting("admission");
      return raw ? (JSON.parse(raw) as StoredAdmission) : null;
    } catch {
      return null;
    }
  }

  /**
   * Billing's answer now (admission.ts), stored unless a check that started
   * later has already stored its own (ADMISSION_FRESH_MS). Throws when
   * billing is unavailable, and stores nothing.
   */
  private async checkAdmission(accountId: string): Promise<DeliveryAdmission> {
    const generation = Number(this.setting("admissionGeneration") ?? 0) + 1;
    this.put("admissionGeneration", String(generation));
    const checkedAt = Date.now();
    const admission = await admitDelivery(this.env, accountId);
    const stored = this.storedAdmission();
    if (!stored || stored.generation < generation) {
      const next: StoredAdmission = { generation, allowed: admission.deliver, checkedAt, ...(admission.warning ? { warning: admission.warning } : {}) };
      this.put("admission", JSON.stringify(next));
    }
    return admission;
  }

  /** Re-asks billing in the background: one at a time, at most once per ADMISSION_FRESH_MS; unavailable leaves the stored admission to age out. */
  private recheckAdmission(accountId: string): void {
    if (this.recheckingAdmission || Date.now() - this.admissionRecheckedAt < ADMISSION_FRESH_MS) return;
    this.admissionRecheckedAt = Date.now();
    this.recheckingAdmission = this.checkAdmission(accountId)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.recheckingAdmission = undefined;
      });
    this.ctx.waitUntil(this.recheckingAdmission);
  }

  /**
   * A conversation's session, owned by whoever started it. Mode and model are
   * unset unless inherited (a spawned thread): the runner's defaults apply.
   */
  /**
   * A new thread's explicit prefix wins over its owner's default. Later
   * default changes affect later threads; existing threads use !codex/off.
   */
  private chooseHarness(key: string, owner: string, override?: CalvinHarness): void {
    const { harness, via } = override ? { harness: override, via: "prefix" } : this.access.agents.harnessFor(owner);
    if (harness === "codex") this.access.models.setHarness(key, "codex");
    console.log(JSON.stringify({ level: "info", event: "computer.thread_harness", harness, via }));
  }

  private createSession(input: { channelId: string; threadTs: string; ownerId: string; title: string; mode?: CalvinMode; model?: string }): SessionRow {
    const teamId = this.setting("slackTeamId")!;
    const key = sessionKey(teamId, input.channelId, input.threadTs);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, mode, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key,
      teamId,
      input.channelId,
      input.threadTs,
      input.ownerId,
      input.title.slice(0, 80),
      input.mode ?? null,
      input.model ?? null,
      now,
      now,
    );
    // Analytics: one row per created session in the managed-agent session
    // index, like every serverless agent session, with source `computer`
    // so @OpenComputer sessions stay distinct from api, schedule, webhook,
    // channel and playground ones (oc-usage-chart). Off the critical path.
    this.ctx.waitUntil(this.indexSession(key, now));
    return this.session(key)!;
  }

  /** Agent session status first; 👀 only where that is unavailable (Calvin's acknowledge). */
  private async acknowledge(job: Pick<SlackMessageJob, "channelId" | "threadTs" | "messageTs">, ownerId: string): Promise<Acknowledgement> {
    const started = Date.now();
    const status = await this.slack("agents.sessions.setStatus", {
      channel_id: job.channelId,
      thread_ts: job.threadTs,
      status: "processing",
      initiator_user_id: ownerId,
    });
    if (status.ok) return { indicator: "status", ok: true, callMs: Date.now() - started };
    const reacted = await this.slack("reactions.add", { channel: job.channelId, timestamp: job.messageTs, name: "eyes" });
    return { indicator: "reaction", ok: reacted.ok, callMs: Date.now() - started };
  }

  /** Slack's stop button on a thread. */
  async slackStop(accountId: string, channelId: string, threadTs?: string): Promise<{ delivered: boolean }> {
    this.bind(accountId);
    const teamId = this.setting("slackTeamId");
    if (!teamId || !threadTs) return { delivered: false };
    const key = sessionKey(teamId, channelId, threadTs);
    if (!this.session(key)) return { delivered: false };
    return { delivered: this.send({ t: "stop", id: crypto.randomUUID(), sessionKey: key }) };
  }

  /** Interactivity: the secret modal's submission, its button, and prompts the runner posted. */
  async slackInteraction(accountId: string, interaction: SlackInteraction): Promise<{ errors?: Record<string, string>; view?: Record<string, unknown> }> {
    this.bind(accountId);
    const userId = interaction.user?.id;
    if (!userId || interaction.team?.id !== this.setting("slackTeamId")) return {};
    // The subscription modals (work 097, 6b): only where ModelAccess has them.
    const slack = this.access.slack;
    // Work 077: the Claude subscription modal; errors keep it open, `view` replaces it while the token is checked.
    if (slack && interaction.type === "view_submission" && interaction.view?.callback_id === MODEL_VIEW) {
      const { errors, view, after } = await slack.claude.submit(interaction.view as ModelSubmittedView, userId);
      if (after) this.ctx.waitUntil(after().catch((error) => console.error(JSON.stringify({ level: "error", event: "computer.model_followup_failed", message: errorText(error) }))));
      return errors ? { errors } : view ? { view } : {};
    }
    // Work 082: the ChatGPT paste modal; errors keep it open.
    if (slack && interaction.type === "view_submission" && interaction.view?.callback_id === MODEL_VIEW_CODEX) {
      const { errors, after } = await slack.codex.submit(interaction.view as ModelSubmittedView, userId);
      if (after) this.ctx.waitUntil(after().catch((error) => console.error(JSON.stringify({ level: "error", event: "computer.model_followup_failed", provider: "chatgpt", message: errorText(error) }))));
      return errors ? { errors } : {};
    }
    // Work 080: the grant-a-connection modal.
    if (interaction.type === "view_submission" && interaction.view?.callback_id === CONNECTION_VIEW) {
      const { errors, after } = await this.connections.submit(interaction.view, userId);
      if (after) this.ctx.waitUntil(after().catch((error) => console.error("computer.connection_followup_failed", errorText(error))));
      return errors ? { errors } : {};
    }
    if (interaction.type === "view_submission" && interaction.view) {
      const { errors, after } = await this.secrets.submit(interaction.view as SubmittedView, userId);
      if (after) this.ctx.waitUntil(after().catch((error) => console.error("computer.secret_followup_failed", errorText(error))));
      return errors ? { errors } : {};
    }
    const actionId = interaction.actions?.[0]?.action_id ?? "";
    if (actionId.startsWith("s:") && interaction.trigger_id) {
      const container = interaction.container;
      const channelId = interaction.channel?.id ?? container?.channel_id;
      await this.secrets.open(actionId, interaction.trigger_id, {
        userId,
        ...(channelId ? { channelId } : {}),
        ...(container?.thread_ts ? { threadTs: container.thread_ts } : {}),
        ...(container?.message_ts ? { messageTs: container.message_ts } : {}),
      });
      return {};
    }
    if (actionId.startsWith("cn:") && interaction.trigger_id) {
      const container = interaction.container;
      const channelId = interaction.channel?.id ?? container?.channel_id;
      await this.connections.open(actionId, interaction.trigger_id, {
        userId,
        ...(channelId ? { channelId } : {}),
        ...(container?.thread_ts ? { threadTs: container.thread_ts } : {}),
        ...(container?.message_ts ? { messageTs: container.message_ts } : {}),
      });
      return {};
    }
    if (slack && (actionId === CONNECT_ACTION || actionId === CODEX_CONNECT_ACTION) && interaction.trigger_id) {
      const container = interaction.container;
      const channelId = interaction.channel?.id ?? container?.channel_id;
      await (actionId === CODEX_CONNECT_ACTION ? slack.codex : slack.claude).open(interaction.trigger_id, {
        userId,
        ...(channelId ? { channelId } : {}),
        ...(container?.thread_ts ? { threadTs: container.thread_ts } : {}),
      });
      return {};
    }
    if (slack && (actionId === DISCONNECT_ACTION || actionId === CODEX_DISCONNECT_ACTION)) {
      const responseUrl = interaction.response_url;
      await (actionId === CODEX_DISCONNECT_ACTION ? slack.codex : slack.claude).disconnect(userId, async (text) => {
        if (responseUrl) await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace_original: true, text }) });
      });
      return {};
    }
    // "Set it anyway" on a variable that looks like a credential (secrets-store.ts).
    if (actionId.startsWith("v:")) {
      const key = actionId.slice(2);
      const session = key ? this.session(key) : undefined;
      const container = interaction.container;
      const channelId = interaction.channel?.id ?? container?.channel_id;
      const responseUrl = interaction.response_url;
      const respond = async (text: string) => {
        if (responseUrl) await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace_original: true, text }) });
      };
      if (key && !session?.ownerId) {
        await respond("That session is gone; nothing was set.");
        return {};
      }
      await this.secrets.confirmVariable(interaction.actions?.[0]?.value ?? "", {
        userId,
        ...(channelId ? { channelId } : {}),
        ...(container?.thread_ts ? { threadTs: container.thread_ts } : {}),
        ...(session?.ownerId ? { session: { key, ownerId: session.ownerId } } : {}),
      }, respond);
      return {};
    }
    const action = decodeCalvinActionId(actionId);
    if (action) {
      this.send({ t: "action", id: crypto.randomUUID(), sessionKey: action.sessionKey, promptId: action.promptId, value: action.value, userId });
    }
    return {};
  }

  /** A session that asked for something and is waiting: `text` from `userId` starts its next turn. */
  private async wakeSession(session: { channelId: string; threadTs: string }, userId: string, text: string, ts: string): Promise<void> {
    if (!(await this.admit(session.channelId, session.threadTs))) return;
    const trace = this.telemetry.trace({ teamId: this.setting("slackTeamId") ?? "", channelId: session.channelId, userId, messageTs: ts, receivedAt: Date.now() });
    await this.deliver({ channelId: session.channelId, threadTs: session.threadTs, messageTs: ts, userId, text, mentioned: true, trace });
  }

  // ------------------------------------------------------------------ delivery

  private async indexSession(key: string, createdAt: number): Promise<void> {
    if (!this.env.SERVERLESS_AGENTS_DB) return;
    try {
      await this.env.SERVERLESS_AGENTS_DB.prepare(
        `INSERT INTO session_creations (session_id, account_id, source, created_at)
         VALUES (?, ?, 'computer', ?)
         ON CONFLICT(session_id) DO NOTHING`,
      )
        .bind(computerSessionId(key), this.accountId(), new Date(createdAt).toISOString())
        .run();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "computer.session_index_failed", message: errorText(error) }));
    }
  }

  private async deliver(dispatch: Dispatch, telemetry?: GatewayTelemetry): Promise<void> {
    return this.telemetry.within(telemetry, (t) => this.deliverWith(dispatch, t));
  }

  private async deliverWith(dispatch: Dispatch, t: GatewayTelemetry): Promise<void> {
    const teamId = this.setting("slackTeamId");
    if (!teamId) return;
    const key = sessionKey(teamId, dispatch.channelId, dispatch.threadTs);
    // Names off the dispatch's path (work 068 §3b), except one: the owner's
    // identity goes into the delivery (`session.owner`) and the runner keeps it
    // as its git author for its life, which a later `people` push does not
    // change. So a session owner Slack has never been asked about is awaited
    // (bounded at 2 s, as before); everyone else (a known owner whose row is
    // stale or incomplete, a sender who is not the owner) is looked up in the
    // background and reaches the host as a `people` update.
    const owner = this.session(key)?.ownerId ?? dispatch.userId;
    const lookups = [...new Set([owner, dispatch.userId])].filter((id) => this.personNeedsLookup(id));
    const unknownOwner = lookups.includes(owner) && !this.personKnown(owner);
    const background = lookups.filter((id) => !(unknownOwner && id === owner));
    if (background.length) this.ctx.waitUntil(Promise.all(background.map((id) => this.registerPerson(id))).then(() => {}));
    if (unknownOwner) await this.registerPerson(owner);
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE sessions SET updated_at = ? WHERE runner_key = ?", now, key);
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO dispatches (id, runner_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      id,
      key,
      JSON.stringify(dispatch),
      now,
      now,
    );
    this.telemetry.created(t, id, key, dispatch, now);
    this.noteActivity();
    await this.flush(t);
    // Sent by this flush or by one that overlapped it (another thread's chain, a hello).
    // Claimed `sent` by a flush whose socket closed before it could send counts as
    // parked: webSocketClose puts it back, and this is what wakes the computer.
    const state = [...this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM dispatches WHERE id = ?", id)][0]?.state;
    const sent = state !== "pending" && !(state === "sent" && !this.socket());
    if (!sent) this.telemetry.parked(t, id, key, dispatch);
    if (!sent) await this.ensureAwake(dispatch);
    // After the send, never before it (work 058): it calls the account and GitHub.
    this.ctx.waitUntil(this.refreshDefinitionIfStale());
  }

  /**
   * Repositories connected after the host said hello (the person connects
   * GitHub once the computer is up) reach it before the next message: at most
   * once a minute, a changed definition is sent in a fresh `welcome`, which
   * Calvin's host applies like the first one (credentials and people unchanged).
   */
  private async refreshDefinitionIfStale(): Promise<void> {
    if (!this.socket()) return;
    if (Date.now() - Number(this.setting("definitionCheckedAt") ?? 0) < DEFINITION_RECHECK_MS) return;
    await this.refreshDefinition();
  }

  /** Re-read the organization's repositories; a changed definition goes to the host in a fresh `welcome`. Never throws. */
  private async refreshDefinition(): Promise<void> {
    const started = Date.now();
    this.put("definitionCheckedAt", String(started));
    const before = this.setting("definition");
    const definition = await this.definition();
    console.log(JSON.stringify({ level: "info", event: "computer.definition_refreshed", ms: Date.now() - started, changed: !!definition && JSON.stringify(definition) !== before }));
    if (!definition || JSON.stringify(definition) === before || !this.socket()) return;
    const preview = await this.previewWelcome();
    this.send({
      t: "welcome",
      protocol: this.welcomeProtocol(),
      credentials: await this.credentials(),
      people: this.people(),
      definition,
      ...preview,
      // Work 084: a v4 host keys its relay from every welcome, this one too; without it the relay refuses every client.
      ...this.wireWelcome(preview, this.liveHost()?.protocol ?? 0),
    });
  }

  /** A welcome's `wire` (the relay's key, the previews key), for a host at v4; warns when such a host gets none. */
  private wireWelcome(preview: { preview?: CalvinPreviewConfig }, protocol: number): { wire?: { key: string } } {
    if (protocol < CALVIN_API_PROTOCOL) return {};
    if (preview.preview) return { wire: { key: preview.preview.key } };
    console.warn(JSON.stringify({ level: "warn", event: "computer.welcome_without_wire_key", accountId: this.setting("accountId") }));
    return {};
  }

  /** Nothing can run this message now: start, wake or retry the computer, and say so once in the thread. */
  private async ensureAwake(dispatch: Dispatch): Promise<void> {
    const threadKey = `${dispatch.channelId}:${dispatch.threadTs}`;
    const row = this.lifecycle.row();
    let notice: string | null = null;
    if (!row || row.state === "deleted") {
      const reply = await this.ensureComputer(this.accountId());
      if (reply.status === 202) notice = STARTING_NOTICE;
      else if (reply.error) console.error(JSON.stringify({ level: "error", event: "computer.autocreate_failed", message: reply.error }));
    } else if (row.state === "parked" || row.state === "parking") {
      await this.wakeComputer();
      notice = WAKING_NOTICE;
    } else if (row.state === "resizing") {
      notice = RESIZING_NOTICE;
    } else if (row.state === "waking") {
      notice = WAKING_NOTICE;
    } else if (row.state === "provisioning") {
      notice = STARTING_NOTICE;
    } else if (row.state === "failed") {
      notice = "Your computer could not start, so this message is waiting. Open the Computer page on app.opencomputer.dev to try again.";
    }
    if (!notice) return;
    const inserted = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO notices (thread_key, kind) VALUES (?, ?)",
      threadKey,
      notice === WAKING_NOTICE ? "waking" : notice === STARTING_NOTICE ? "starting" : notice === RESIZING_NOTICE ? "resizing" : "failed",
    );
    // Off the chain (work 068 §3b): the notice is claimed above, synchronously, so it posts once.
    if (inserted.rowsWritten > 0) {
      this.ctx.waitUntil(
        this.slack("chat.postMessage", { channel: dispatch.channelId, thread_ts: dispatch.threadTs, text: notice }).then(
          () => {},
          (error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.notice_failed", message: errorText(error) })),
        ),
      );
    }
  }

  /** Sends queued deliveries to the host, oldest first. True if anything was sent. */
  private async flush(telemetry?: GatewayTelemetry): Promise<boolean> {
    return this.telemetry.within(telemetry, (t) => this.flushWith(t));
  }

  private async flushWith(t: GatewayTelemetry): Promise<boolean> {
    const socket = this.socket();
    if (!socket) return false;
    // The VM restarts on its new size: messages wait for it (the resize's end flushes).
    if (this.lifecycle.row()?.state === "resizing") return false;
    const credentials = await this.credentials(t);
    const rows = [...this.ctx.storage.sql.exec<{ id: string; key: string; payload: string; attempts: number; createdAt: number }>(
      "SELECT id, runner_key AS key, payload, attempts, created_at AS createdAt FROM dispatches WHERE state = 'pending' ORDER BY created_at LIMIT 20",
    )];
    if (!rows.length) return false;
    // Claimed before any await (work 058): a flush that overlaps this one (a hello, another
    // queue job) must not select and send the same rows. A dropped socket puts 'sent' rows
    // back to pending, as before.
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        "UPDATE dispatches SET state = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        Date.now(),
        row.id,
      );
    }
    // Work 082: a Codex delivery whose ChatGPT token expired waits (bounded) for its refresh, but never holds the
    // others up: it and its session's later rows go after every other row, in order, and wait then.
    const done = new Set<string>();
    let batch = rows;
    for (const expired of ["defer", "wait"] as const) {
      const later: typeof rows = [];
      const held = new Set<string>();
      for (const row of batch) {
        const delivered = held.has(row.key) ? "deferred" : await this.deliverRow(t, socket, credentials, row, expired);
        if (delivered === "deferred") {
          held.add(row.key);
          later.push(row);
        } else if (delivered === "closed") {
          for (const unsent of rows) if (!done.has(unsent.id)) this.ctx.storage.sql.exec("UPDATE dispatches SET state = 'pending' WHERE id = ? AND state = 'sent'", unsent.id);
          return done.size > 0;
        } else done.add(row.id);
      }
      batch = later;
    }
    return true;
  }

  /**
   * One claimed delivery to the host: its model route, then the `deliver`. "deferred": a Codex route waiting on a
   * refresh (`expired: "defer"` only); "closed": the socket went meanwhile, nothing sent.
   */
  private async deliverRow(
    t: GatewayTelemetry,
    socket: WebSocket,
    credentials: CalvinHostCredentials,
    row: { id: string; key: string; payload: string; attempts: number; createdAt: number },
    expired: "defer" | "wait",
  ): Promise<"done" | "deferred" | "closed"> {
    const dispatch = JSON.parse(row.payload) as Dispatch;
    // Linked threads read for a message that waited this long are stale and are not kept
    // any longer: the session reads them on demand.
    if (dispatch.linked && Date.now() - row.createdAt > LINKED_TTL_MS) {
      delete dispatch.linked;
      this.ctx.storage.sql.exec("UPDATE dispatches SET payload = json_remove(payload, '$.linked') WHERE id = ?", row.id);
    }
    const stored = this.session(row.key);
    const ownerId = stored?.ownerId ?? dispatch.userId;
    // Work 077: this turn's model route. A refused turn is never sent: the poster is told why.
    // Work 082: "defer" comes back undefined for a Codex session whose expired token is being refreshed.
    const resolved = await this.access.models.forDelivery({ key: row.key, ownerId }, dispatch.userId, expired);
    if (!resolved) return "deferred";
    const { route: model } = resolved;
    if (model.mode === "refuse") {
      this.ctx.storage.sql.exec("UPDATE dispatches SET state = 'complete', last_error = 'model_refused', updated_at = ? WHERE id = ?", Date.now(), row.id);
      this.ctx.waitUntil(this.modelRefused(dispatch, model.reason));
      return "done";
    }
    // Ahead of the message, so the turn starts with them (work 046).
    const secrets = await this.secrets.forSession(row.key, ownerId);
    // The socket went while the secrets were read: what is not sent yet goes back to
    // pending now, so the caller parks it (and wakes the computer) rather than a send throwing.
    if (socket.readyState !== WebSocket.OPEN) return "closed";
    // Work 084: a v4 host also gets the session's API id, its owner's member id and the log's position.
    const api = await this.api.slackDelivery(row.key, ownerId);
    if (socket.readyState !== WebSocket.OPEN) return "closed";
    const owner = this.person(ownerId);
    const command: CalvinGatewayToHost = {
      t: "deliver",
      id: row.id,
      session: {
        key: row.key,
        kind: "thread",
        channel: dispatch.channelId,
        threadTs: dispatch.threadTs,
        owner: api?.userId ? { ...owner, userId: api.userId } : owner,
        ...(credentials.teamId ? { teamId: credentials.teamId } : {}),
        ...(api ? { sessionId: api.sessionId, origin: { type: "slack" } } : {}),
        title: stored?.title ?? dispatch.text.slice(0, 80),
        mode: stored?.mode ?? "bypassPermissions",
        ...(stored?.model ? { model: stored.model } : {}),
        ...(stored?.speed === "fast" || stored?.speed === "standard" ? { speed: stored.speed } : {}),
        ...(stored?.sdkSessionId ? { sdkSessionId: stored.sdkSessionId } : {}),
        ...(stored?.forkPath ? { forkPath: stored.forkPath } : {}),
        // Work 082: a ChatGPT route runs Codex (only ever sent to a host at protocol 3 with the feature).
        ...(model.mode === "subscription" && model.provider === "chatgpt" ? { harness: "codex" as const } : {}),
      },
      msg: {
        userId: dispatch.userId,
        text: dispatch.text,
        ts: dispatch.messageTs,
        ...(dispatch.files?.length ? { files: dispatch.files } : {}),
        ...(dispatch.mentioned !== undefined ? { mentioned: dispatch.mentioned } : {}),
        ...(dispatch.linked?.length ? { linked: dispatch.linked } : {}),
      },
      credentials,
      secrets,
      ...(model.mode === "subscription" ? { model } : {}),
      ...(api ? { epoch: api.epoch, lastSeq: api.lastSeq } : {}),
      ...this.telemetry.sentTrace(dispatch),
    };
    socket.send(JSON.stringify(command));
    this.access.models.noteSent(row.key, model);
    this.telemetry.sent(t, row, dispatch);
    return "done";
  }

  // ------------------------------------------------------------------ host WebSocket

  /** The host's WebSocket upgrade; routes.ts has checked its token for `organizationId`. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    if (!organizationId) return new Response("organizationId required", { status: 400 });
    try {
      this.bind(organizationId);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    let event: CalvinHostToGateway;
    try {
      event = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as CalvinHostToGateway;
    } catch {
      return;
    }
    // A pool computer runs no sessions: only its hello, and answers to its own token checks (work 081).
    if (event.t !== "hello" && event.t !== "probed" && isPoolId(this.setting("accountId") ?? "")) return;
    switch (event.t) {
      case "hello":
        return this.hello(ws, event);
      case "reply":
        this.telemetry.replied(event.id, event.ok, event.error);
        this.ctx.storage.sql.exec(
          "UPDATE dispatches SET state = ?, last_error = ?, updated_at = ? WHERE id = ?",
          event.ok ? "complete" : "failed",
          event.error ?? null,
          Date.now(),
          event.id,
        );
        this.ctx.storage.sql.exec("DELETE FROM dispatches WHERE state IN ('complete', 'failed') AND updated_at < ?", Date.now() - DEDUP_TTL_MS);
        if (!event.ok) await this.deliveryFailed(event.id, event.error ?? "unknown error");
        // Other threads' text is not kept past delivery (the row stays for dedup).
        this.ctx.storage.sql.exec(
          "UPDATE dispatches SET payload = json_remove(payload, '$.linked') WHERE id = ? AND json_extract(payload, '$.linked') IS NOT NULL",
          event.id,
        );
        return;
      case "session":
        return this.report(event.report);
      case "disk":
        return this.diskReported(event);
      case "token":
        try {
          const result =
            event.kind === "opencomputer"
              ? await mintOpenComputerKey(this.env, this.accountId(), this.liveSessionKey(event.sessionKey))
              : event.kind === "automation-repo"
                ? await this.automationPushCredential()
                : await this.mintToken(event.repos);
          this.send({ t: "token", id: event.id, result });
        } catch (error) {
          this.send({ t: "token", id: event.id, error: errorText(error) });
        }
        return;
      case "secret-request":
        try {
          await this.secrets.request(event.from, event.req as SecretRequest);
          this.send({ t: "secret-asked", id: event.id });
        } catch (error) {
          this.send({ t: "secret-asked", id: event.id, error: errorText(error) });
        }
        return;
      case "connection-request":
        try {
          await this.connections.request(event.from, event.req as ConnectionRequest);
          this.send({ t: "connection-asked", id: event.id });
        } catch (error) {
          this.send({ t: "connection-asked", id: event.id, error: errorText(error) });
        }
        return;
      case "read":
        try {
          this.send({ t: "thread", id: event.id, result: await this.readThread(event.from, event.req) });
        } catch (error) {
          this.send({ t: "thread", id: event.id, error: errorText(error) });
        }
        return;
      case "out-of-credits":
        return this.outOfCredits(event.sessionKey);
      // Work 077: the model proxy's answers and reports, relayed by the host.
      case "probed":
        return this.access.models.probed(event.id, event.result, event.error);
      case "model-bound":
        return this.access.models.bound(event.sessionKey, event.mode, event.fingerprint);
      case "model-health":
        return this.access.models.health(event);
      case "model-denied":
        return this.access.models.denied(
          this.runnerSession(event.sessionKey)?.ownerId,
          event.fallbackTo,
          this.access.models.harness(event.sessionKey) === "codex" ? "chatgpt" : "anthropic",
        );
      case "post":
        try {
          this.send({ t: "posted", id: event.id, result: await this.postThread(event.from, event.req) });
        } catch (error) {
          this.send({ t: "posted", id: event.id, error: errorText(error) });
        }
        return;
      case "spawn":
        try {
          this.send({ t: "spawned", id: event.id, result: await this.spawn(event.from, event.req) });
        } catch (error) {
          this.send({ t: "spawned", id: event.id, error: errorText(error) });
        }
        return;
      case "preview":
      case "unpreview":
        try {
          const result = event.t === "preview" ? await this.previews.register(event.from, event.req) : await this.previews.unregister(event.req.name);
          this.send({ t: "previewed", id: event.id, result });
        } catch (error) {
          this.send({ t: "previewed", id: event.id, error: errorText(error) });
        }
        return;
      // Work 084: the session API's frames (sessions-api.ts).
      case "journal":
      case "subagent-progress":
      case "api-result":
      case "started":
      case "wake":
        await this.api.onHostFrame(event);
        return;
      default:
        return;
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.telemetry.disconnected(ws, code);
    // A replaced socket closing after its successor said hello must not touch
    // what the successor now owns.
    if (this.ctx.getWebSockets().some((socket) => socket !== ws && socket.readyState === WebSocket.OPEN)) return;
    this.ctx.storage.sql.exec("UPDATE dispatches SET state = 'pending' WHERE state = 'sent'");
    // Work 084: API calls waiting on the host fail now; lost writers are recovered later.
    this.api.onHostClosed();
    // No host, no working session: stop billing now.
    this.billing.closeAll("host_disconnected", Date.now());
    await this.scheduleBilling();
  }

  private async hello(ws: WebSocket, event: Extract<CalvinHostToGateway, { t: "hello" }>): Promise<void> {
    // A reconnect replaces the host's old socket, which may be half-open.
    const previous = this.telemetry.previousConnection(ws, this.ctx.getWebSockets());
    for (const socket of this.ctx.getWebSockets()) if (socket !== ws) socket.close(4001, "replaced");
    const features = Array.isArray(event.features) ? event.features.filter((f): f is string => typeof f === "string").slice(0, 32) : undefined;
    // Work 084 rollout gate: a gated-off organization's host is a v3 host here, whatever it speaks.
    const said = typeof event.protocol === "number" ? event.protocol : 1;
    const protocol = this.apiEnabled() ? said : Math.min(said, GATED_PROTOCOL);
    ws.serializeAttachment({
      hostId: event.hostId,
      version: event.version,
      connectedAt: Date.now(),
      protocol,
      ...(features ? { features } : {}),
      welcomed: false,
    } satisfies HostAttachment);
    // A pool slot's hello isn't the organization's computer's: its own hello as the organization comes after the claim.
    if (!isPoolId(this.setting("accountId") ?? "")) this.recordHostFeatures(features ?? []);
    this.telemetry.connected(event.version, previous);
    if ((event.protocol ?? 1) < CALVIN_PROTOCOL_VERSION) {
      // Expected of every host until calvin #129 ships protocol 3: a note, not a warning.
      console.log(JSON.stringify({ level: "info", event: "computer.host_protocol_behind", hostId: event.hostId, version: event.version, protocol: event.protocol }));
    }
    const accountId = this.setting("accountId") ?? "";
    if (isPoolId(accountId)) return this.poolHello(ws, accountId);
    this.lifecycle.noteHostSeen();
    const assignedAt = this.setting("assignPendingSince");
    if (assignedAt) {
      console.log(
        JSON.stringify({ level: "info", event: "computer.pool_assign_acknowledged", accountId, poolId: this.setting("assignPoolSlot"), ms: Date.now() - Number(assignedAt) }),
      );
      this.remove("assignPendingSince", "assignPoolSlot");
    }
    // The stored definition, refreshed after the welcome (work 058); only a first hello waits for GitHub.
    const stored = this.setting("definition");
    const definition = stored ? (JSON.parse(stored) as WorkspaceDefinition) : await this.definition();
    const preview = await this.previewWelcome();
    ws.send(
      JSON.stringify({
        t: "welcome",
        protocol: this.welcomeProtocol(),
        credentials: await this.credentials(),
        people: this.people(),
        ...(definition ? { definition } : {}),
        ...(await this.telemetry.credential(event.hostId)),
        ...preview,
        // Work 084: the relay verifies X-Wire-Auth with the previews key (only a v4 host reads it).
        ...this.wireWelcome(preview, protocol),
      } satisfies CalvinGatewayToHost),
    );
    // Work 084 (review r3): the API treats the host as v4 only once it has its welcome (and the wire key in it).
    this.markWelcomed(ws);
    if (stored) this.ctx.waitUntil(this.refreshDefinition());
    // The organization's first hello (or one after Cloudflare failed): make its tunnel; the host hears when it is ready.
    // Work 084: the wire's key records name the tunnel, so they follow it.
    if (this.previews.config()) this.ctx.waitUntil(this.previews.ensureTunnel().then(() => this.keys.rewriteAll()));
    // Work 084: the relay's access lists, and a look for writers lost while the host was away.
    this.api.onHello(event.journals);
    this.ctx.storage.sql.exec("UPDATE dispatches SET state = 'pending' WHERE state = 'sent'");
    // The host starts over: what it reports working now is billed from now;
    // whatever the previous socket left open ends here.
    this.billing.closeAll("host_reconnected", Date.now());
    for (const report of event.sessions ?? []) await this.report(report);
    // Work 077: a restarted host and proxy have no tokens; its sessions on a seat (or refused) get their routes again.
    await this.access.models.helloed((event.sessions ?? []).map((report) => report.key)).catch((error) =>
      console.error(JSON.stringify({ level: "error", event: "computer.model_hello_push_failed", message: errorText(error) })),
    );
    await this.scheduleBilling();
    await this.flush();
    // A host saying hello during a resize is the VM back on its new size: look
    // now rather than at the next poll (POLL_MS), so the queued messages go.
    if (this.lifecycle.row()?.state === "resizing") await this.schedule("lifecycle", Date.now());
    // A claimed or woken computer may want its plan's bigger size.
    await this.schedule("size", Date.now());
  }

  /**
   * A pool computer's host: welcomed with no credentials, people or
   * definition (it runs no sessions), and the pool told it is warm. Handed
   * over already: it missed its `assign`, so it gets it again.
   */
  private async poolHello(ws: WebSocket, poolId: string): Promise<void> {
    const assignTo = this.setting("assignTo");
    if (assignTo && this.lifecycle.row()?.state === "transferred") {
      ws.send(JSON.stringify(await this.assignMessage(assignTo)));
      console.warn(JSON.stringify({ level: "warn", event: "computer.pool_assign_resent", poolId, accountId: assignTo }));
      return;
    }
    this.lifecycle.noteHostSeen();
    ws.send(
      JSON.stringify({
        t: "welcome",
        protocol: this.welcomeProtocol(),
        credentials: { slackBotToken: "", slackBotUserId: "" },
        people: [],
      } satisfies CalvinGatewayToHost),
    );
    if (this.lifecycle.row()?.state === "ready") {
      this.ctx.waitUntil(
        this.poolObject()
          .poolHostConnected(poolId)
          .catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.pool_notify_failed", poolId, message: errorText(error) }))),
      );
    }
  }

  private async report(report: CalvinSessionReport): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET sdk_session_id = COALESCE(?, sdk_session_id), fork_path = COALESCE(?, fork_path),
              mode = COALESCE(?, mode), model = COALESCE(?, model), speed = COALESCE(?, speed), status = ?, updated_at = ?
       WHERE runner_key = ?`,
      report.sdkSessionId ?? null,
      report.forkPath ?? null,
      report.mode ?? null,
      report.model ?? null,
      report.speed === "fast" || report.speed === "standard" ? report.speed : null,
      report.status,
      Date.now(),
      report.key,
    );
    this.api.reported(report);
    if (report.status === "busy" || report.status === "starting") this.noteActivity();
    this.billing.report(report.key, report.status, Date.now());
    await this.scheduleBilling();
  }

  /** The session asking for thread access, and who it is for (its owner). Throws for one that is not this workspace's. */
  private threadSession(from: string): { teamId: string; ownerId: string; channelId: string; threadTs: string } {
    const teamId = this.setting("slackTeamId");
    const session = this.session(from);
    if (!teamId || session?.teamId !== teamId || !session.ownerId) throw new Error(`unknown session ${from}`);
    return { teamId, ownerId: session.ownerId, channelId: session.channelId, threadTs: session.threadTs };
  }

  /** read_thread (work 049 L3): a thread for the session, under D6 with its owner as the person. */
  private async readThread(from: string, req: CalvinReadThreadRequest): Promise<Linked> {
    const session = this.threadSession(from);
    const ref = threadRefFor(req);
    if (!ref) throw new Error("give a Slack thread link, or a channel id and a message ts");
    const linked = await this.threads().read(ref, { owner: session.ownerId, destination: session.channelId, deadline: Date.now() + THREAD_REQUEST_MS });
    console.log(JSON.stringify({ level: "info", event: "computer.thread_read", ok: linked.ok }));
    return linked;
  }

  /** post_thread (work 049 L3, D8): a reply in a thread under the same check, attributed to the owner. */
  private async postThread(from: string, req: CalvinPostThreadRequest): Promise<CalvinPostThreadResult> {
    const session = this.threadSession(from);
    const ref = threadRefFor(req);
    if (!ref) throw new Error("give a Slack thread link, or a channel id and a message ts");
    if (typeof req.text !== "string") throw new Error("the text is required");
    const posted = await this.threads().post(ref, { owner: session.ownerId, destination: session.channelId, deadline: Date.now() + THREAD_REQUEST_MS }, {
      text: req.text,
      sessionUrl: slackThreadUrl(session.teamId, session.channelId, session.threadTs),
    });
    console.log(JSON.stringify({ level: "info", event: "computer.thread_posted" }));
    return posted;
  }

  /**
   * A session starts a thread (Calvin work 047): post a short top-level
   * message in the parent's channel and start a session on it as if the
   * parent's owner had mentioned the app there, with the parent's mode and
   * model. A tier goes in front of the brief as `+smart`/`+fast`, which the
   * runner applies like a typed one.
   */
  private async spawn(from: string, req: CalvinSpawnRequest): Promise<CalvinSpawnResult> {
    const teamId = this.setting("slackTeamId");
    const parent = this.session(from);
    // A session of a Slack workspace this organization was linked to before is not one.
    if (!teamId || parent?.teamId !== teamId || !parent.ownerId) throw new Error(`unknown session ${from}`);
    if (typeof req?.task !== "string" || !req.task.trim() || typeof req.brief !== "string" || !req.brief.trim()) {
      throw new Error("a task and a brief are required");
    }
    if (req.tier !== undefined && !SPAWN_TIERS.has(req.tier)) throw new Error(`unknown tier ${String(req.tier)}: use smart, fast or default`);
    if (!(await this.admit(parent.channelId, parent.threadTs))) throw new Error("out of credits");
    const ownerId = parent.ownerId;
    const task = req.task.trim();
    const parentUrl = slackThreadUrl(teamId, parent.channelId, parent.threadTs);
    const brief = req.briefUrl ? `<${req.briefUrl.replace(/[<>|]/g, encodeURIComponent)}|${slackEscape(req.brief)}>` : `\`${slackEscape(req.brief)}\``;
    const tier = req.tier ? `+${req.tier} ` : "";
    // Escaped: the task is the agent's text, and must not ping the channel or break the markup.
    const posted = await this.slack("chat.postMessage", {
      channel: parent.channelId,
      text: `<@${ownerId}> ↳ ${tier}${slackEscape(task)}\nBrief: ${brief} · <${parentUrl}|from this thread>`,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!posted.ok || !posted.ts) throw new Error(`Slack post failed: ${posted.error ?? "unknown_error"}`);
    const threadTs = posted.ts;
    const { key } = this.createSession({
      channelId: parent.channelId,
      threadTs,
      ownerId,
      title: task,
      ...(parent.mode ? { mode: parent.mode } : {}),
      // A tier picks its own model in the runner; without one the parent's carries over.
      ...(!req.tier && parent.model ? { model: parent.model } : {}),
    });
    // Work 077: the owner's Claude seat carries over only when the owner's own turn spawned this
    // (the parent's latest delivered message is theirs) and the parent may use the seat.
    if (this.access.models.managedOnly(from) || this.latestAuthor(from) !== ownerId) this.access.models.markManagedOnly(key);
    // Otherwise it runs what its parent runs (a Codex thread's are on the same ChatGPT seat).
    else if (this.access.models.harness(from) === "codex") this.access.models.setHarness(key, "codex");
    this.ctx.waitUntil(this.acknowledge({ channelId: parent.channelId, threadTs, messageTs: threadTs }, ownerId).catch(() => {}));
    // `Task:` first: the runner takes a message starting with `!` for a command (after any `+tier`).
    const text =
      `${tier}Task: ${task}\n\nBrief: ${req.brief}\n` +
      `Started by the session in thread ${from} (${parentUrl}). ` +
      "Read the brief first; claim and report there.";
    // Not awaited: waking the computer or starting the runner can take longer than the parent waits.
    this.ctx.waitUntil(
      this.deliver({ channelId: parent.channelId, threadTs, messageTs: threadTs, userId: ownerId, text }).catch((error) =>
        console.error(JSON.stringify({ level: "error", event: "computer.spawn_deliver_failed", message: errorText(error) })),
      ),
    );
    return { key, url: slackThreadUrl(teamId, parent.channelId, threadTs)! };
  }

  /** Who wrote the latest message delivered to session `key` (the turn now running), if it is still known. */
  private latestAuthor(key: string): string | undefined {
    const row = [...this.ctx.storage.sql.exec<{ userId: string | null }>(
      "SELECT json_extract(payload, '$.userId') AS userId FROM dispatches WHERE runner_key = ? AND state != 'pending' ORDER BY created_at DESC LIMIT 1",
      key,
    )][0];
    return row?.userId ?? undefined;
  }

  /** A turn the model route refused (work 077): the poster is told why, and the working status comes off. */
  private async modelRefused(dispatch: Dispatch, reason: string): Promise<void> {
    try {
      await this.slack("chat.postEphemeral", { channel: dispatch.channelId, user: dispatch.userId, thread_ts: dispatch.threadTs, text: reason });
      await this.slack("agents.sessions.setStatus", { channel_id: dispatch.channelId, thread_ts: dispatch.threadTs, status: "active" });
      await this.slack("reactions.remove", { channel: dispatch.channelId, timestamp: dispatch.messageTs, name: "eyes" });
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.model_refused_notice_failed", message: errorText(error) }));
    }
  }

  /** Sessions running now, with their conversations and last activity (pushes go to these). */
  private liveSessions(): ModelSession[] {
    return [...this.ctx.storage.sql.exec<{ key: string; ownerId: string | null; channelId: string; threadTs: string; status: string; activeAt: number }>(
      "SELECT runner_key AS key, owner_id AS ownerId, channel_id AS channelId, thread_ts AS threadTs, status, updated_at AS activeAt FROM sessions WHERE status IN ('starting', 'idle', 'busy')",
    )].flatMap((row) => (row.ownerId ? [{ key: row.key, ownerId: row.ownerId, channelId: row.channelId, threadTs: row.threadTs, status: row.status, activeAt: row.activeAt }] : []));
  }

  /** Slack says a person left, was deactivated or became a guest (work 077): their Claude subscription goes. */
  async slackMemberLeft(accountId: string, userId: string): Promise<void> {
    this.bind(accountId);
    await this.access.models.memberRemoved(userId);
  }

  /** The host could not take a message: tell the thread, unless the runner is merely slow to start. */
  private async deliveryFailed(id: string, error: string): Promise<void> {
    if (error === "timeout") return;
    const row = [...this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM dispatches WHERE id = ?", id)][0];
    if (!row) return;
    const dispatch = JSON.parse(row.payload) as Dispatch;
    await this.slack("chat.postMessage", {
      channel: dispatch.channelId,
      thread_ts: dispatch.threadTs,
      text: `:warning: couldn't reach the session: ${error}`,
    });
    // Like Calvin's gateway: clear Slack's "is working" indicator, and show
    // the session as failed rather than starting forever.
    await this.slack("agents.sessions.setStatus", {
      channel_id: dispatch.channelId,
      thread_ts: dispatch.threadTs,
      status: "active",
    });
    const teamId = this.setting("slackTeamId");
    if (teamId) {
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET status = 'error', updated_at = ? WHERE runner_key = ?",
        Date.now(),
        sessionKey(teamId, dispatch.channelId, dispatch.threadTs),
      );
    }
  }

  private socket(): WebSocket | undefined {
    return this.ctx.getWebSockets().find((socket) => socket.readyState === WebSocket.OPEN);
  }

  private send(command: CalvinGatewayToHost): boolean {
    const socket = this.socket();
    if (!socket) return false;
    socket.send(JSON.stringify(command));
    return true;
  }

  /** The host's credentials; `credentials.resolved` on `t` (or its own emitter), with where the model key came from. */
  private async credentials(telemetry?: GatewayTelemetry): Promise<CalvinHostCredentials> {
    return this.telemetry.within(telemetry, async (t) => {
      const span = t.start("credentials.resolved");
      try {
        const teamId = this.setting("slackTeamId");
        const { key, source } = await this.organizationModelKey();
        const { credentials: model, fallback } = modelCredentials(key, this.env);
        if (fallback) console.warn(JSON.stringify({ level: "warn", event: "computer.model_key_fallback", accountId: this.setting("accountId") }));
        const credentials = {
          slackBotToken: await this.slackBotToken(),
          slackBotUserId: this.setting("slackBotUserId") ?? "",
          ...(teamId ? { teamId } : {}),
          ...model,
        };
        span.end({ outcome: "completed", data: { source } });
        return credentials;
      } catch (error) {
        span.end({ outcome: "failed", error_type: "unknown" });
        throw error;
      }
    });
  }

  /**
   * `unseal`, remembered in this object's memory (work 068 §3d): the bot
   * token and the model key were decrypted on every flush and every Slack
   * call. Keyed by the ciphertext itself, so a relinked token or a refreshed
   * key is a new entry; the memo is also cleared when either changes
   * (`modelKeyChanged`, `linkSlack`, `unlinkSlack`). Failures are not kept.
   */
  private async unsealCached(sealed: string, purpose: SealPurpose, context: string): Promise<string> {
    const memo = `${purpose}\0${context}\0${sealed}`;
    const known = this.unsealed.get(memo);
    if (known !== undefined) return known;
    const value = await unseal(sealed, this.env.BLUE_CHANNEL_ENCRYPTION_KEY, purpose, context);
    if (this.unsealed.size >= 16) this.unsealed.clear();
    this.unsealed.set(memo, value);
    return value;
  }

  private async slackBotToken(): Promise<string> {
    const teamId = this.setting("slackTeamId");
    const sealed = this.setting("slackBotToken");
    if (!teamId || !sealed) return "";
    try {
      return await this.unsealCached(sealed, "slack-bot-token", `${this.accountId()}\0${teamId}`);
    } catch {
      console.error(JSON.stringify({ level: "error", event: "computer.slack_token_undecryptable" }));
      return "";
    }
  }

  /**
   * The organization's managed model key (model-key.ts). The account owns it;
   * this object keeps a sealed copy (or the fact that there is none) in its own
   * storage, so no message waits on the account (work 058). An old copy is
   * re-read in the background, and the edge's bind and delete routes push
   * changes (`modelKeyChanged`). Only an organization's first lookup is remote.
   * None yet: provisioning is asked for in the background, and the host is sent
   * fresh credentials when it lands.
   */
  private async organizationModelKey(): Promise<{ key: string | null; source: "local" | "remote" | "none" }> {
    const accountId = this.setting("accountId");
    if (!accountId || isPoolId(accountId)) return { key: null, source: "none" };
    const storedAt = Number(this.setting("modelKeyStoredAt") ?? 0);
    if (!storedAt) return { key: await this.refreshModelKey(accountId), source: "remote" };
    const sealed = this.setting("modelKeySealed");
    let key: string | null = null;
    if (sealed) {
      try {
        key = await this.unsealCached(sealed, "managed-model-key", modelKeyContext(accountId));
      } catch {
        console.error(JSON.stringify({ level: "error", event: "computer.model_key_undecryptable", accountId }));
        return { key: await this.refreshModelKey(accountId), source: "remote" };
      }
    }
    if (Date.now() - storedAt > (key ? MODEL_KEY_RECHECK_MS : MODEL_KEY_MISS_TTL_MS)) this.ctx.waitUntil(this.refreshModelKey(accountId));
    if (!key) this.provisionModelKey(accountId);
    return { key, source: "local" };
  }

  /** Re-read the key from the account and store its sealed copy, or its absence. One at a time; never throws. */
  private refreshModelKey(accountId: string): Promise<string | null> {
    this.refreshingModelKey ??= (async () => {
      const started = Date.now();
      let key: string | null;
      try {
        key = (await this.account().resolveManagedModelCredential(MANAGED_MODEL_PROVIDER))?.key ?? null;
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "computer.model_key_unavailable", accountId, message: errorText(error) }));
        return null;
      }
      console.log(JSON.stringify({ level: "info", event: "computer.model_key_fetched", accountId, ms: Date.now() - started, found: !!key }));
      if (key) this.put("modelKeySealed", await seal(key, this.env.BLUE_CHANNEL_ENCRYPTION_KEY, "managed-model-key", modelKeyContext(accountId)));
      else this.remove("modelKeySealed");
      this.put("modelKeyStoredAt", String(Date.now()));
      if (!key) this.provisionModelKey(accountId);
      return key;
    })().finally(() => {
      this.refreshingModelKey = undefined;
    });
    return this.refreshingModelKey;
  }

  /** The edge bound or deleted this organization's model key (work 058): refresh the copy and push it to the host. */
  async modelKeyChanged(): Promise<void> {
    const accountId = this.setting("accountId");
    if (!accountId || isPoolId(accountId)) return;
    this.unsealed.clear();
    await this.refreshModelKey(accountId);
    this.send({ t: "credentials", credentials: await this.credentials() });
  }

  private provisionModelKey(accountId: string): void {
    if (this.provisioningModelKey) return;
    if (Date.now() - Number(this.setting("modelKeyRequestedAt") ?? 0) < MODEL_KEY_PROVISION_INTERVAL_MS) return;
    this.put("modelKeyRequestedAt", String(Date.now()));
    this.provisioningModelKey = (async () => {
      if ((await requestManagedModelKey(this.env, accountId)) !== "requested") return;
      if (!(await this.refreshModelKey(accountId))) {
        console.warn(JSON.stringify({ level: "warn", event: "computer.model_key_not_bound", accountId }));
        return;
      }
      console.log(JSON.stringify({ level: "info", event: "computer.model_key_provisioned", accountId }));
      this.send({ t: "credentials", credentials: await this.credentials() });
    })()
      .catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "computer.model_key_provision_failed", accountId, message: errorText(error) })))
      .finally(() => {
        this.provisioningModelKey = undefined;
      });
    this.ctx.waitUntil(this.provisioningModelKey);
  }

  private async slack(method: string, body: Record<string, unknown>): Promise<SlackResult> {
    const token = await this.slackBotToken();
    if (!token) return { ok: false, error: "not_linked" };
    return slackApi(token, method, body);
  }

  // ------------------------------------------------------------------ people, sessions, secrets

  /**
   * Record a person and their git identity, from Slack. Rows still missing
   * the name or email (users.info failed, installs without users:read.email,
   * rows from before either) are asked again, at most once an hour.
   */
  private async registerPerson(slackUserId: string): Promise<void> {
    if (!this.personNeedsLookup(slackUserId)) return;
    const existing = this.storedPerson(slackUserId);
    // On the delivery path: a slow or failing Slack leaves the identity for later, never the message.
    const failed: SlackResult = { ok: false };
    const r = await Promise.race([
      this.slack("users.info", { user: slackUserId }).catch(() => failed),
      new Promise<SlackResult>((resolve) => setTimeout(() => resolve(failed), 2_000)),
    ]);
    const u = r.ok ? r.user : undefined;
    if (!u && existing) {
      // Keep what we have; ask again in an hour.
      this.ctx.storage.sql.exec("UPDATE people SET updated_at = ? WHERE slack_user_id = ?", Date.now(), slackUserId);
      return;
    }
    const name = u?.real_name || u?.profile?.real_name || u?.profile?.display_name || u?.name || undefined;
    const person = personFor(slackUserId, { name, email: u?.profile?.email });
    // Keeps the row's directory: it names the person's sessions on disk.
    this.ctx.storage.sql.exec(
      `INSERT INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (slack_user_id) DO UPDATE SET git_name = excluded.git_name, git_email = excluded.git_email, updated_at = excluded.updated_at`,
      person.slackUserId,
      person.dir,
      person.gitName,
      person.gitEmail,
      Date.now(),
    );
    if (existing?.gitName !== person.gitName || existing?.gitEmail !== person.gitEmail) this.send({ t: "people", people: this.people() });
  }

  private storedPerson(slackUserId: string): { gitName: string; gitEmail: string; updatedAt: number } | undefined {
    return [...this.ctx.storage.sql.exec<{ gitName: string; gitEmail: string; updatedAt: number }>(
      "SELECT git_name AS gitName, git_email AS gitEmail, updated_at AS updatedAt FROM people WHERE slack_user_id = ?",
      slackUserId,
    )][0];
  }

  private personKnown(slackUserId: string): boolean {
    return this.storedPerson(slackUserId) !== undefined;
  }

  /** Whether `registerPerson` would ask Slack: no row, or an incomplete or legacy one not asked about within the hour. */
  private personNeedsLookup(slackUserId: string): boolean {
    const existing = this.storedPerson(slackUserId);
    if (!existing) return true;
    const legacy = /^Slack [A-Z0-9]+$/.test(existing.gitName);
    const complete = existing.gitName !== COMPUTER_GIT_NAME && existing.gitEmail !== noReplyGitEmail(slackUserId);
    if (complete && !legacy) return false;
    return Date.now() - existing.updatedAt >= 60 * 60_000;
  }

  private person(slackUserId: string): CalvinPerson {
    return this.people().find((p) => p.slackUserId === slackUserId) ?? personFor(slackUserId);
  }

  private people(): CalvinPerson[] {
    return [...this.ctx.storage.sql.exec<{ slackUserId: string; dir: string; gitName: string; gitEmail: string }>(
      "SELECT slack_user_id AS slackUserId, dir, git_name AS gitName, git_email AS gitEmail FROM people ORDER BY slack_user_id",
    )].map((row) => ({ ...row }));
  }

  private session(key: string): SessionRow | undefined {
    return [...this.ctx.storage.sql.exec<SessionRow>(`${SESSION_SELECT} WHERE runner_key = ?`, key)][0];
  }

  /**
   * The model provider refused a turn for credits (Calvin's `out-of-credits`).
   * OpenRouter refuses a call its key's remaining limit can't cover, so this
   * can come while billing still shows credits left and admits messages: the
   * thread hears the paywall once, as a refused message would.
   */
  private async outOfCredits(key: string): Promise<void> {
    const session = this.runnerSession(key);
    if (!session) return;
    console.log(JSON.stringify({ level: "info", event: "computer.turn_refused_credits", accountId: this.accountId() }));
    const why = await refusal(this.env, this.accountId());
    const shown = await refuseForCredits({
      sql: this.ctx.storage.sql,
      slack: (method, body) => this.slack(method, body),
      channelId: session.channelId,
      threadTs: session.threadTs,
      origin: publicOrigin(this.env),
      ...why,
    });
    if (shown) await this.telemetry.within(undefined, async (t) => paywallShown(t, why.haltReason));
  }

  /** A runner key of this organization's workspace → its conversation. */
  private runnerSession(key: string): { key: string; ownerId: string; channelId: string; threadTs: string } | undefined {
    const parsed = parseSessionKey(key);
    if (!parsed || parsed.teamId !== this.setting("slackTeamId")) return undefined;
    const row = this.session(key);
    return row?.ownerId ? { key, ownerId: row.ownerId, channelId: row.channelId, threadTs: row.threadTs } : undefined;
  }

  /**
   * The session a host names for a key, kept only when it is a live session of
   * this organization's workspace (work 080). The host vouches for which of its
   * sessions asked; the gateway vouches that the session exists here.
   */
  private liveSessionKey(key: unknown): string | undefined {
    if (typeof key !== "string" || !this.runnerSession(key)) return undefined;
    const status = this.session(key)?.status;
    return status === "starting" || status === "idle" || status === "busy" ? key : undefined;
  }

  /** Secrets changed: send each affected running session its new set. */
  private async pushSecrets(which: { key?: string; owner?: string }): Promise<void> {
    const live = [...this.ctx.storage.sql.exec<{ key: string; ownerId: string | null }>(
      "SELECT runner_key AS key, owner_id AS ownerId FROM sessions WHERE status IN ('starting', 'idle', 'busy')",
    )];
    for (const session of live) {
      if (!session.ownerId || (which.key && session.key !== which.key) || (which.owner && session.ownerId !== which.owner)) continue;
      const secrets: SessionSecret[] = await this.secrets.forSession(session.key, session.ownerId);
      this.send({ t: "secrets", sessionKey: session.key, secrets });
    }
  }

  // ------------------------------------------------------------------ GitHub

  private account(): AccountStub {
    return this.env.ACCOUNTS.getByName(this.accountId()) as unknown as AccountStub;
  }

  private async installations(timing?: DefinitionTiming): Promise<ComputerInstallation[]> {
    return (await timed(timing, "accountMs", this.account().listGitHubInstallations()))
      .filter((installation) => installation.state === "active")
      .map((installation) => ({ id: installation.id, accountLogin: installation.accountLogin }));
  }

  /** Every repository the organization's installations grant, live from GitHub; cached for token selection. */
  private async refreshRepositories(installations: ComputerInstallation[], timing?: DefinitionTiming): Promise<ComputerRepository[]> {
    const repositories: ComputerRepository[] = [];
    for (const installation of installations) {
      const minted = await timed(timing, "accountMs", this.account().mintGitHubInstallationToken({
        installationId: installation.id,
        permissions: { metadata: "read" },
      }));
      if (minted.outcome !== "minted") continue;
      for (let page = 1, more = true; more && page <= REPOSITORY_PAGES; page += 1) {
        const result = await timed(timing, "githubMs", listGitHubInstallationRepositories({ token: minted.token, page, perPage: 100, details: true }));
        for (const repository of result.repositories) {
          repositories.push({
            installationId: installation.id,
            fullName: repository.fullName,
            defaultBranch: repository.defaultBranch,
            archived: repository.archived,
            ...(repository.description ? { description: repository.description } : {}),
            ...(repository.language ? { language: repository.language } : {}),
            ...(repository.pushedAt ? { pushedAt: repository.pushedAt } : {}),
          });
        }
        more = result.nextCursor !== null;
      }
    }
    // Token selection needs only owner, name and installation; the index metadata stays out of storage.
    this.put("repositories", JSON.stringify(repositories.map(({ description, language, pushedAt, ...kept }) => kept)));
    return repositories;
  }

  private cachedRepositories(): ComputerRepository[] {
    try {
      return JSON.parse(this.setting("repositories") ?? "[]") as ComputerRepository[];
    } catch {
      return [];
    }
  }

  /**
   * The workspace definition for `welcome`: fresh if GitHub answers in time,
   * else the last one, else none (no change). `definition.refreshed` times
   * the account object's part (installations, token mints) apart from
   * GitHub's (the repository listing).
   */
  private async definition(): Promise<WorkspaceDefinition | null> {
    return this.telemetry.within(undefined, async (t) => {
      const span = t.start("definition.refreshed");
      const timing: DefinitionTiming = { accountMs: 0, githubMs: 0 };
      const data = () => ({ account_ms: timing.accountMs, github_ms: timing.githubMs });
      try {
        const fresh = await Promise.race([
          this.installations(timing).then((installations) => this.refreshRepositories(installations, timing)),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), DEFINITION_TIMEOUT_MS)),
        ]);
        if (fresh) {
          const definition = workspaceDefinition("organization", fresh);
          const changed = JSON.stringify(definition) !== this.setting("definition");
          this.put("definition", JSON.stringify(definition));
          span.end({ outcome: "completed", data: { ...data(), repos: fresh.length, changed, timed_out: false } });
          return definition;
        }
        span.end({ outcome: "timed_out", error_type: "timeout", data: { ...data(), timed_out: true } });
      } catch (error) {
        span.end({ outcome: "failed", error_type: "unknown", data: data() });
        console.warn(JSON.stringify({ level: "warn", event: "computer.definition_refresh_failed", message: errorText(error) }));
      }
      const cached = this.setting("definition");
      return cached ? (JSON.parse(cached) as WorkspaceDefinition) : null;
    });
  }

  /** A host's `token`: from the installation that owns the requested repositories, narrowed to them. */
  private async mintToken(repos: string[] | undefined): Promise<{ token: string; expiresAt: string }> {
    const installations = await this.installations();
    let target = selectTokenTarget(repos, installations, this.cachedRepositories());
    if (!target.ok && installations.length && repos?.some((repo) => !repo.includes("/"))) {
      target = selectTokenTarget(repos, installations, await this.refreshRepositories(installations));
    }
    if (!target.ok) throw new Error(target.error);
    const minted = await this.account().mintGitHubInstallationToken({
      installationId: target.installationId,
      ...(target.repositories ? { repositories: target.repositories } : {}),
    });
    if (minted.outcome === "minted") return { token: minted.token, expiresAt: minted.expiresAt };
    if (minted.outcome === "not_connected") throw new Error("the GitHub installation is no longer connected");
    if (minted.outcome === "app_not_configured") throw new Error("the GitHub App is not configured");
    throw new Error(`GitHub token request failed: ${minted.message}`);
  }
}

/**
 * Whether a message gets Slack's working status (👀 where unavailable): it is
 * addressed to the app (a mention, a DM, or a reply in one of its threads),
 * it is not a `!` command (`!!` is text), and it is not a reply that
 * @mentions other people and not the app: that one is most likely for them.
 */
export function wantsAcknowledgement(job: Pick<SlackMessageJob, "mentioned" | "channelType" | "text" | "mentionsOthers">, inSession: boolean): boolean {
  const mentioned = job.mentioned || job.channelType === "im";
  if (!inSession && !mentioned) return false;
  const text = commandText(job.text);
  const command = text.startsWith("!") && !text.startsWith("!!");
  return !command && !(!mentioned && job.mentionsOthers);
}

/**
 * The text a `!` command is parsed from: `job.text` without one wrapping pair
 * of backticks (or a code fence), because Slack keeps the code formatting of
 * a command copied from a web page and sends it as `` `!link oc_…` ``.
 */
export function commandText(text: string): string {
  const trimmed = text.trim();
  const code = /^```\s*([\s\S]*?)\s*```$/.exec(trimmed) ?? /^`([^`]+)`$/.exec(trimmed);
  return code?.[1]?.trim() ?? trimmed;
}

/** Where a definition refresh spent its time (`definition.refreshed`). */
type DefinitionTiming = { accountMs: number; githubMs: number };

/** `work`, with the time it took added to `timing[part]`. */
async function timed<T>(timing: DefinitionTiming | undefined, part: keyof DefinitionTiming, work: Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work;
  } finally {
    if (timing) timing[part] += Date.now() - started;
  }
}

function publicStatus(status: string | null): ComputerSession["status"] {
  if (status === "busy" || status === "idle" || status === "error" || status === "starting") return status;
  if (status === "stopped") return "ended";
  return "starting";
}

/** The paywall was posted (086 funnel): `reason` the halt's, or the credit rule's. */
function paywallShown(t: GatewayTelemetry, haltReason: string | null): void {
  t.emit("billing.paywall_shown", { data: { reason: haltReason ?? "credits_exhausted", surface: "slack" } });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The AAD of an organization's sealed model key. */
function modelKeyContext(accountId: string): string {
  return `${accountId}\0${MANAGED_MODEL_PROVIDER}`;
}
