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

import { isSessionId } from "../../ids/session-ids.js";
import type { ComputerRpcAdded, SlackCarry, SlackModalReply, StartSpec } from "./contract.js";
import type { SlackRpc } from "../slack/contract.js";
import { type Access, type Principal, byOf } from "../../auth/principal.js";
import { type Dead, OWED_PURPOSE } from "../../durable/outbox.js";
import { alarms } from "../../durable/alarms.js";
import { migrate } from "../../durable/migrations.js";
import { type Sql, sqlOf } from "../../durable/sql.js";
import { turnIdFor } from "../../ids/slack-ids.js";
import { liveOf, logOf, orgOf, slackOf } from "../addresses.js";
import { DurableObject } from "cloudflare:workers";

import type { GitHubInstallation, GitHubTokenMint } from "../../protocol.js";
import { listGitHubInstallationRepositories } from "../../edge/github.js";
import {
  type BillingWarning,
  type DeliveryAdmission,
  type SlackNotice,
  admitDelivery,
  refusal,
  refuseForCredits,
} from "./admission.js";
import { ComputerRuntimeBilling } from "./machine/billing.js";
import { PlatformComputerCloud } from "./machine/cloud.js";
import {
  type ComputerEdgeEnv,
  ComputersNotConfigured,
  type PublicComputer,
  defaultDiskGiB,
  gatewayUrl,
  maxDiskGiB,
  missingEdgeConfig,
  selfManagedVms,
  publicOrigin,
  sizeFor,
  sizes,
  zones,
} from "./config.js";
import { sizeShape } from "./machine/placement.js";
import { DEFAULT_HARNESS, computerHarnesses, helloProfiles, profileHarnesses } from "./held-for-org/model-access/harnesses.js";
import { type SealPurpose, seal, unseal } from "../../crypto/seal.js";
import { type DiskReport, diskDecision } from "./machine/disk-growth.js";
import { LOOKUP_FAILED_TEXT } from "../../slack-api/threads.js";
import { type ComputerInstallation, type ComputerRepository, selectTokenTarget, workspaceDefinition } from "./held-for-org/github.js";
import { hostToken } from "./host-link/host-token.js";
import { type AdoptedComputer, ComputerLifecycle, type ComputerState, type LifecycleReply } from "./machine/lifecycle.js";
import { MANAGED_MODEL_PROVIDER, type ModelCredentials, managedModelRoute, requestManagedModelKey } from "./held-for-org/model-access/model-key.js";
import { apiSubscriptionOwner, linkedSlackUser, routeApiSession } from "./held-for-org/model-access/api-session-route.js";
import { mintOpenComputerKey } from "./held-for-org/keys/opencomputer-key.js";
import { type AutomationRepositoryEnv, automationRepositoryCredential } from "../../edge/automation-repository.js";
import { daysUnpaid, idleParkMs, parkingDecision, unpaidStage, unpaidWarning, unpaidWarningGiven } from "./machine/parking.js";
import { type ComputerPlan, type ResolvedPlan, type UsagePlan, resolvePlan, sizeTier } from "./machine/plan.js";
import { POOL_OBJECT, isPoolId } from "../../ids/computer-names.js";
import { ComputerPool, type PoolClaim, type PoolProbeResult, type PoolSlot, type PoolSlotStatus, SLOT_PROBE_TIMEOUT_MS, poolSize } from "../computer-pool/pool.js";
import { ComputerPreviews } from "./previews.js";
import { ComputerKeys, type SyncedKey } from "./held-for-org/keys/keys.js";
import { type ApiOp, type ApiRequest, type ApiReply, ComputerSessionsApi } from "./session-drain.js";
import type { PreviewComputerState } from "../../previews/worker.js";
import {
  CALVIN_PROTOCOL_VERSION,
  UPGRADE_REQUIRED,
  type CalvinGatewayToHost,
  type CalvinGitHubToken,
  type CalvinHostToGateway,
  type CalvinMode,
  type CalvinPerson,
  type CalvinSessionReport,
  type CalvinPreviewConfig,
  type CalvinHarness,
  type ModelProfile,
  type ModelRoute,
  type SecretRequest,
  type SessionSecret,
  type WorkspaceDefinition,
  parseSessionKey,
  personFor,
} from "../../host-protocol/protocol.js";
import { type SubmittedView, parseSecretCommand } from "./held-for-org/secrets/secrets.js";
import { parseVariableCommand } from "./held-for-org/secrets/variables.js";
import { type SecretsApiOp, SecretsStore } from "./held-for-org/secrets/secrets-store.js";
import { driversCommandText } from "./copied/access.js";
import { CONNECTION_VIEW, ComputerConnections, type ConnectionRequest, type GrantableConnection } from "./held-for-org/connections.js";
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
} from "./held-for-org/model-access/model-access.js";
import { createModelAccess } from "./held-for-org/model-access/model-access-impl.js";
import { ConnectCodeIndex, connectCodeIndexName } from "../connect-codes/codes.js";
import { ApiTelemetry, surfaceOfOrigin } from "./telemetry/api.js";
import { TelemetryBatch } from "../../telemetry/batch.js";
import { ComputerTelemetry, type HostAttachment } from "./telemetry/computer.js";
import type { GatewayTelemetry } from "../../telemetry/gateway.js";
import { type SlackInteraction, type SlackMessageJob, type SlackResult, slackThreadUrl } from "../../slack-api/web-api.js";

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
  /** Why it is `failed` (work 111), with the error as the cloud gave it; null in any other state. */
  failure: { code: string | null; message: string | null; at: string } | null;
  /** Org's owed calls that ran out of tries (spec 18.6); null when Org could not answer. */
  dead: Dead[] | null;
}

/** What `notifyJoinRequest` did: whether the person who linked the workspace was told. */
export interface JoinRequestOutcome {
  installerNotified: boolean;
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
const PLAN_TTL_MS = 10 * 60_000;
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
/**
 * A Durable Object has one instance, so a `running` row no drain of this
 * instance holds was left by an evicted one. The constructor recovers them
 * all; the alarm leaves a few seconds' grace (SLACK_STRANDED_GRACE_MS) and
 * fires again within SLACK_STRANDED_MS of a drain it found in flight, so an
 * eviction mid-drain is caught by then at the latest (sooner by any accept).
 */
export const SLACK_STRANDED_GRACE_MS = 5_000;
export const SLACK_STRANDED_MS = 60_000;
const REPOSITORY_PAGES = 10;
const DEFINITION_TIMEOUT_MS = 10_000;

type AlarmPurpose = typeof OWED_PURPOSE | "lifecycle" | "slack" | "idle" | "pool" | "assign" | "billing" | "size" | "model" | "agent" | "recover" | "machine" | "dial";

/** How soon a refused `Org.acceptMachine` is tried again. */
const MACHINE_RETRY_MS = 30_000;
/** A ready machine whose host has not dialed within this is a failed start: its VM is rebuilt. */
export const HOST_DIAL_MS = 15 * 60_000;
/** Rebuilds in a row before the waiting entries are reported `computer_unavailable`. */
const HOST_DIAL_REBUILDS = 1;
/** The settings the Slack actor carries over (spec 43.1); the bot token goes sealed. */
const SLACK_SETTINGS = ["slackTeamId", "slackTeamName", "slackBotUserId", "slackBotToken", "slackInstallerUserId"];

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

export class ComputerDurableObject extends DurableObject<ComputerEdgeEnv> implements ComputerRpcAdded {
  /** The other actors of tracks and threads (actors/addresses.ts); fields, so a test puts its own. */
  actors = {
    log: (sessionId: string) => logOf(this.env, sessionId),
    org: () => orgOf(this.env, this.accountId()),
    slack: () => slackOf(this.env, this.accountId()),
    live: () => liveOf(this.env, this.accountId()),
  };
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
  /** This object's storage as the shared actor module's `Sql` (durable/sql.ts). */
  private readonly store: Sql;
  private pool?: ComputerPool;
  /** The organization's managed model key, in memory only (never stored here, never logged). */
  private refreshingModelKey?: Promise<string | null>;
  private provisioningModelKey?: Promise<void>;
  /** The background admission re-check in flight (`admit`), and when the last one started. */
  private recheckingAdmission?: Promise<void>;
  private admissionRecheckedAt = 0;
  /** The create in flight: concurrent creates of one organization share it, so it claims at most one pool computer. */
  private ensuring?: Promise<LifecycleReply>;
  /** A size reconciliation asked for while one ran: it looks once more when that one ends. */
  private reconcileAgain = false;
  /** Unsealed values by purpose, context and ciphertext (work 068 §3d); a changed ciphertext is a new entry. Memory only. */
  private readonly unsealed = new Map<string, string>();
  /** The size reconciliation and the billing tick in flight: run off the alarm's path, never twice at once. */
  private reconciling?: Promise<void>;
  private billingRun?: Promise<void>;

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
      zones: () => zones(env),
      sizes: () => sizes(env),
      selfManaged: () => selfManagedVms(env),
      onReady: () => {
        this.noteActivity();
      },
    });
    this.secrets = new SecretsStore({
      sql,
      encryptionKey: () => env.BLUE_CHANNEL_ENCRYPTION_KEY,
      member: async (userId) => (await this.actors.slack().principal(userId)) !== null,
      instructs: (key, userId) => this.instructs(key, userId),
      slack: (method, body) => this.slack(method, body),
      session: (key) => this.runnerSession(key),
      push: (which) => this.pushSecrets(which),
      // Lazy: `this.access` is built below.
      linkOfSlack: (slackUserId) => this.access.agents.linkOfSlack(slackUserId),
      isAdmin: (member) => this.actors.org().isAdmin(member),
      wake: (session, userId, text, ts) => this.wakeSession(session, userId, text, ts),
    });
    this.access = createModelAccess({
      sql,
      encryptionKey: () => env.BLUE_CHANNEL_ENCRYPTION_KEY,
      accountId: () => this.accountId(),
      teamId: () => this.setting("slackTeamId") ?? "",
      slack: (method, body) => this.slack(method, body),
      harnesses: () => this.harnesses(),
      host: () => this.liveHost(),
      managedRoute: async () => (await this.managedModel((await this.organizationModelKey()).key)).route,
      send: (frame) => this.send(frame),
      schedule: (purpose) => this.purposeScheduler(purpose),
      liveSessions: () => this.liveSessions(),
      session: (key) => this.modelSession(key),
      // A token connected on the dashboard (`web:<id>`, work 081) has nobody in Slack to tell.
      directMessage: (userId, text) => (userId.startsWith(WEB_OWNER_PREFIX) ? Promise.resolve(false) : this.directMessage(userId, text)),
      threadUrl: (channelId, threadTs) => slackThreadUrl(this.setting("slackTeamId") ?? "", channelId, threadTs) ?? undefined,
      // Lazy: `this.telemetry` is built below.
      telemetry: (name, fields) => this.telemetry.subscription(name, fields),
      slackInstalled: () => {
        const installed = !!this.setting("slackTeamId");
        const teamName = this.setting("slackTeamName");
        return { installed, ...(teamName ? { teamName } : {}) };
      },
      poolProbe: (token, user) => (this.env.COMPUTERS && this.poolTarget() > 0 ? (this.poolObject().poolProbe(token, user) as Promise<PoolProbeResult>) : null),
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
      waitUntil: (task) => ctx.waitUntil(task),
      slackUserName: (userId) => this.actors.slack().userName(userId),
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
    });
    this.keys = new ComputerKeys({
      sql,
      kv: env.WIRE_KEYS,
      organizationId: () => this.setting("accountId"),
      tunnelId: () => this.previews.tunnelId(),
      revoked: (keyId) => this.send({ t: "revoked", keyId }) !== false,
      waitUntil: (promise) => ctx.waitUntil(promise),
      telemetry: this.apiTelemetry,
    });
    // The shared actor module's tables (spec 36.7): the drains owed here. Its alarm is this object's purpose `owed`.
    this.store = {
      ...sqlOf(ctx.storage),
      arm: (at) => {
        if (at === null) sql.exec("DELETE FROM alarms WHERE purpose = ?", OWED_PURPOSE);
        else void this.schedule(OWED_PURPOSE, at);
      },
    };
    migrate(this.store, []);
    this.api = new ComputerSessionsApi({
      sql,
      store: this.store,
      env,
      organizationId: () => this.accountId(),
      host: () => this.apiHost(),
      send: (frame) => this.send(frame),
      routeSession: (session, member) => routeApiSession({ access: this.access, profiles: () => this.liveHost()?.profiles, send: (frame) => this.send(frame) }, session, member),
      closeHost: (code, reason) => this.socket()?.close(code, reason),
      wake: () => this.wakeForApi(),
      computerStatus: () => this.apiComputerStatus(),
      admitted: () => this.admitForApi(),
      slackPerson: (slackUserId) => this.person(slackUserId),
      linkOfSlack: (slackUserId) => this.access.agents.linkOfSlack(slackUserId),
      secretsFor: (row) => this.secrets.forSession(row.key, this.secretsOwner(row)),
      slackTeamId: () => this.setting("slackTeamId"),
      keys: this.keys,
      tunnelId: () => this.previews.tunnelId(),
      waitUntil: (promise) => ctx.waitUntil(promise),
      scheduleRecover: (at) => this.scheduleRecover(at),
      setting: (key) => this.setting(key),
      put: (key, value) => this.put(key, value),
      remove: (key) => this.remove(key),
      telemetry: this.apiTelemetry,
      log: (sessionId) => this.actors.log(sessionId),
      live: () => this.actors.live(),
      chooseHarness: (row, harness) => this.chooseHarness(row.key, row.ownerId ?? row.ownerUserId ?? "", harness),
      slackOfMember: (member) => this.access.agents.view(member).linkedSlackUser?.id,
      transaction: (fn) => ctx.storage.transactionSync(fn),
    });
    // The retired Work board's stamp: its triggers moved a counter on every session and person write.
    sql.exec(`
      DROP TRIGGER IF EXISTS work_stamp_sessions_insert; DROP TRIGGER IF EXISTS work_stamp_sessions_update; DROP TRIGGER IF EXISTS work_stamp_sessions_delete;
      DROP TRIGGER IF EXISTS work_stamp_people_insert; DROP TRIGGER IF EXISTS work_stamp_people_update; DROP TRIGGER IF EXISTS work_stamp_people_delete;
      DROP TABLE IF EXISTS work_stamp;
    `);
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

  /**
   * The profiles a host at protocol 5 listed in its hello (work 097), kept as
   * its features are and read once per object. A hello without any (its model
   * proxy is down) leaves them; a hello below 5 forgets them.
   */
  private keptProfiles?: { value: ModelProfile[] | undefined };
  private keptHostProfiles(): ModelProfile[] | undefined {
    if (this.keptProfiles) return this.keptProfiles.value;
    let value: ModelProfile[] | undefined;
    try {
      value = helloProfiles(JSON.parse(this.setting("hostProfiles") ?? "null"));
    } catch {
      // Unreadable: as if never recorded.
    }
    this.keptProfiles = { value };
    return value;
  }

  private recordHostProfiles(profiles: ModelProfile[] | undefined): void {
    if (JSON.stringify(profiles) === JSON.stringify(this.keptHostProfiles())) return;
    if (profiles) this.put("hostProfiles", JSON.stringify(profiles));
    else this.remove("hostProfiles");
    this.keptProfiles = { value: profiles };
    console.log(JSON.stringify({ level: "info", event: "computer.host_profiles_changed", profiles: profiles?.map((p) => p.name) ?? null }));
  }

  /** The harnesses this computer can run (harnesses.ts): by its host's profiles once it has listed them, by its features until then. */
  private harnesses(): CalvinHarness[] {
    const profiles = this.keptHostProfiles();
    return profiles ? profileHarnesses(profiles) : computerHarnesses(this.hostFeatures());
  }

  /** The connected host's `features` and the `profiles` kept from its hello; undefined when none is connected. */
  private liveHost(): { features: string[]; profiles?: ModelProfile[] } | undefined {
    const socket = this.socket();
    if (!socket) return undefined;
    const profiles = this.keptHostProfiles();
    try {
      const a = socket.deserializeAttachment() as HostAttachment | null;
      return { features: a?.features ?? [], ...(profiles ? { profiles } : {}) };
    } catch {
      return { features: [] };
    }
  }

  /** The host the sessions API sees: none until its welcome is sent. */
  private apiHost(): { features: string[]; profiles?: ModelProfile[] } | undefined {
    const socket = this.socket();
    if (!socket) return undefined;
    try {
      if ((socket.deserializeAttachment() as HostAttachment | null)?.welcomed === false) return undefined;
    } catch {
      // An unreadable attachment: an old socket, welcomed long ago.
    }
    return this.liveHost();
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

  /** Warm pool computers to keep; none when the operator runs the VMs (work 105). */
  private poolTarget(): number {
    return selfManagedVms(this.env) ? 0 : poolSize(this.env.COMPUTER_POOL_SIZE);
  }

  private noteActivity(): void {
    this.put("lastActivityAt", String(Date.now()));
  }

  // ------------------------------------------------------------------ alarms

  // ------------------------------------------------------------------ tracks and threads (spec 36.3)

  async start(spec: StartSpec): Promise<void> {
    this.bind(spec.session.machine);
    await this.api.start(spec);
    this.ctx.waitUntil(this.publishMachine());
  }

  async stop(sessionId: string): Promise<void> {
    await this.api.stop(sessionId);
  }

  async drain(sessionId: string): Promise<void> {
    await this.api.drain(sessionId);
  }

  async watch(sessionId: string, until: number): Promise<void> {
    this.api.watch(sessionId, until);
  }

  async block(sessionId: string, blockId: string): Promise<void> {
    this.api.block(sessionId, blockId);
  }

  async setAccess(sessionId: string, access: Access, admins: string[]): Promise<void> {
    this.api.setAccess(sessionId, access, admins);
  }

  /**
   * Under the name `computer-slack-team:<team>`: the organization a Slack workspace was claimed for before the
   * Slack actor held the claims. Read by the Slack routes for an organization not imported yet; written by nothing.
   */
  teamAccount(): string | null {
    return this.setting("teamLinkAccountId") ?? null;
  }

  async changed(source: "org" | "slack"): Promise<void> {
    // An organization whose first act is the Slack install: this object is named by its id and not bound yet.
    const named = this.ctx.id.name;
    if (!this.setting("accountId") && named && !named.startsWith("computer-")) this.bind(named);
    if (!this.setting("accountId")) return;
    await (source === "org" ? this.readOrg() : this.readSlack(true));
  }

  /** Org's part of what the host holds: each session's access, the admins, the knowledge repository. Never throws. */
  private async readOrg(): Promise<void> {
    try {
      const got = await this.actors.org().forHost(this.accountId());
      const before = this.setting("knowledge") ?? "";
      this.put("knowledge", got.knowledge ?? "");
      for (const session of got.sessions) this.api.setAccess(session.sessionId, session.access, got.admins);
      if ((got.knowledge ?? "") !== before) await this.refreshDefinition();
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.org_read_failed", message: errorText(error) }));
    }
  }

  /** The Slack actor's part: people and the bot's credentials (passed to the host, never kept here). Never throws. */
  private async readSlack(changed = false): Promise<void> {
    try {
      const got = await this.actors.slack().forHost();
      await this.slackChanged(got.slack, changed);
      if (!this.socket()) return;
      if (got.people.length) this.send({ t: "people", people: got.people });
      if (got.slack) this.send({ t: "credentials", ...(await this.hostCredentials(undefined, got.slack)) });
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.slack_read_failed", message: errorText(error) }));
    }
  }

  /**
   * The Slack actor said its link changed. Linked: the machine starts (installing Slack is the moment someone
   * means to use it) and the installer's model access moves from their dashboard id to their Slack id;
   * unlinked: it moves back. `slackLinked` is the link this Computer last saw, so each happens once.
   */
  private async slackChanged(slack: Awaited<ReturnType<SlackRpc["forHost"]>>["slack"], start: boolean): Promise<void> {
    const before = this.setting("slackLinked");
    this.put("slackSeen", "1");
    if (slack) {
      // What the dashboard's overview shows of the link.
      this.put("slackBotSeen", slack.botUserId);
      this.put("slackNameSeen", slack.teamName ?? "");
      // What this object's session keys read; the token is the Slack actor's alone.
      this.put("slackTeamId", slack.teamId);
      this.put("slackBotUserId", slack.botUserId);
      if (slack.teamName) this.put("slackTeamName", slack.teamName);
      if (slack.installer) this.put("slackInstallerUserId", slack.installer.slackUser);
      const installer = slack.installer;
      if (before !== slack.teamId) {
        this.put("slackLinked", slack.teamId);
        if (installer?.member) await this.access.agents.rekey(installer.member, installer.slackUser);
        if (installer) this.put("slackLinkedInstaller", installer.slackUser);
        else this.remove("slackLinkedInstaller");
      }
      // Installing Slack is the moment someone means to use the computer: it comes alive now, when there is none to use
      // (no row, deleted or failed); a reinstall never wakes a parked one.
      const row = this.lifecycle.row();
      if (start && (!row || row.state === "deleted" || row.state === "failed")) await this.ensureComputer(this.accountId());
    } else if (before) {
      await this.access.agents.unrekey(this.setting("slackLinkedInstaller"));
      this.remove("slackLinked", "slackLinkedInstaller", "slackBotSeen", "slackNameSeen");
      this.remove("slackTeamId", "slackTeamName", "slackBotUserId", "slackBotToken", "slackInstallerUserId");
      this.unsealed.clear();
    }
  }

  /**
   * The machine's slot in Org (spec 36.3): its lifecycle state and previews, under a revision that moves when
   * either changes. A refused or failed call is retried from the alarm table. Never throws.
   */
  private async publishMachine(): Promise<void> {
    try {
      const machine = this.setting("accountId");
      const view = this.lifecycle.view();
      if (!machine || isPoolId(machine) || !view) return;
      const domain = this.previews.config()?.domain;
      const previews = domain
        ? [...this.ctx.storage.sql.exec<{ name: string; sessionId: string }>(
            "SELECT p.name AS name, s.session_id AS sessionId FROM previews p JOIN sessions s ON s.runner_key = p.session WHERE s.session_id IS NOT NULL ORDER BY p.name",
          )].map((row) => ({ sessionId: row.sessionId, name: row.name, url: `https://${row.name}.${domain}` }))
        : [];
      const body = JSON.stringify({ state: view.state, previews });
      if (body === this.setting("machineSent")) return;
      if (body !== this.setting("machineBody")) {
        this.put("machineBody", body);
        this.put("machineRevision", String(Number(this.setting("machineRevision") ?? 0) + 1));
      }
      try {
        await this.actors.org().acceptMachine({ machine, revision: Number(this.setting("machineRevision")), state: view.state, previews });
        this.put("machineSent", body);
      } catch (error) {
        console.warn(JSON.stringify({ level: "warn", event: "computer.machine_publish_failed", message: errorText(error) }));
        await this.schedule("machine", Date.now() + MACHINE_RETRY_MS);
      }
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.machine_publish_failed", message: errorText(error) }));
    }
  }

  /**
   * The Slack actor's commands that are this Computer's: `!secret`, `!var`, `!claude`, `!codex` and a
   * connection grant. The existing handlers answer in Slack themselves (ephemerals, modals): `reply` is empty.
   */
  async command(p: Principal, c: Parameters<ComputerRpcAdded["command"]>[1]): Promise<{ reply: string; member?: string }> {
    this.bind(p.org);
    // A linked person's subject is their member id: the Slack user is the one linked to it.
    const userId = p.subject.startsWith("slack:") ? p.subject.slice(p.subject.lastIndexOf(":") + 1) : this.access.agents.view(p.subject).linkedSlackUser?.id;
    if (!userId) return { reply: "This command works from Slack." };
    const row = c.sessionId
      ? [...this.ctx.storage.sql.exec<{ key: string; channelId: string; threadTs: string; ownerId: string | null }>(
          "SELECT runner_key AS key, channel_id AS channelId, thread_ts AS threadTs, owner_id AS ownerId FROM sessions WHERE session_id = ?",
          c.sessionId,
        )][0]
      : undefined;
    // Where the handlers answer: the command's channel, the session's thread, else the person (a direct message).
    const channelId = c.channelId ?? (row?.channelId || userId);
    const threadTs = c.threadTs ?? (row?.threadTs || undefined);
    const here = { userId, channelId, ...(threadTs ? { threadTs } : {}) };
    const ctx = { ...here, ...(row?.ownerId ? { session: { key: row.key, ownerId: row.ownerId } } : {}) };
    if (c.name === "grant") {
      if (c.triggerId) await this.connections.open(c.args, c.triggerId, here);
      return { reply: "" };
    }
    const text = `!${c.name} ${c.args}`.trim();
    const slack = this.access.slack;
    if (c.name === "secret") {
      const command = parseSecretCommand(text);
      if (command) await this.secrets.command(command, ctx);
    } else if (c.name === "var") {
      const command = parseVariableCommand(text);
      if (command) await this.secrets.variableCommand(command, ctx, text);
    } else if (c.name === "link") {
      const command = parseLinkCommand(text);
      if (command && slack) await slack.link.command(command, here);
      const member = this.access.agents.linkOfSlack(userId);
      return { reply: "", ...(member ? { member } : {}) };
    } else if (c.name === "claude") {
      const command = parseClaudeCommand(text);
      if (command && slack) await slack.claude.command(command, ctx);
    } else {
      const command = parseCodexCommand(text);
      if (command && slack) await slack.codex.command(command, ctx);
    }
    return { reply: "" };
  }

  /** Spec 43.1: what the Slack actor carries over, once: the install's settings (the bot token sealed, as stored), the people and their links. */
  async slackCarry(): Promise<SlackCarry> {
    const settings = Object.fromEntries(SLACK_SETTINGS.flatMap((key) => {
      const value = this.setting(key);
      return value === undefined ? [] : [[key, value]];
    }));
    const people = [...this.ctx.storage.sql.exec<SlackCarry["people"][number]>("SELECT slack_user_id, dir, git_name, git_email, updated_at FROM people ORDER BY slack_user_id")];
    const links = people.flatMap((row) => {
      const member = this.access.agents.linkOfSlack(row.slack_user_id);
      return member ? [{ slackUser: row.slack_user_id, member }] : [];
    });
    return { settings, people, links };
  }

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
    for (const purpose of due) {
      try {
        if (purpose === "lifecycle") {
          const before = this.lifecycle.row()?.state;
          await this.lifecycle.tick();
          this.noteUnpaidPark(before);
          // A wake that failed for good (spec 36.3): the waiting entries are reported, not kept.
          if (this.lifecycle.row()?.state === "failed" && this.api.owes()) await this.api.wakeFailed();
        }
        else if (purpose === "idle") await this.idleCheck();
        else if (purpose === "pool") {
          const next = await this.poolTable().refill();
          if (next !== null) await this.schedule("pool", next);
        } else if (purpose === "assign") this.assignCheck();
        else if (purpose === "model") await this.access.models.expire();
        else if (purpose === "agent") await this.access.agents.expire();
        else if (purpose === "recover") await this.api.recoverTick();
        else if (purpose === "dial") await this.dialCheck();
      } catch (error) {
        failed(purpose)(error);
      }
    }
    // Periodic, idempotent and unordered against the queue: after it, off the alarm's path.
    if (due.includes("billing")) this.ctx.waitUntil(this.billingTick().catch(failed("billing")));
    // The owed drains: one session's held delivery holds no other purpose.
    if (due.includes(OWED_PURPOSE)) this.ctx.waitUntil(alarms.run(this.store, now, { [OWED_PURPOSE]: () => this.api.runOwed() }, (_purpose, error) => failed(OWED_PURPOSE)(error)));
    if (due.includes("size")) this.ctx.waitUntil(this.reconcileSize().catch(failed("size")));
    // Tracks and threads: Org hears a changed state or preview list.
    this.ctx.waitUntil(this.publishMachine());
    // A ready computer is always being watched for idleness (pool computers never park).
    const row = this.lifecycle.row();
    if (row?.state === "ready" && !isPoolId(row.organizationId) && !selfManagedVms(this.env) && ![...this.ctx.storage.sql.exec("SELECT 1 FROM alarms WHERE purpose = 'idle'")].length) {
      this.ctx.storage.sql.exec("INSERT INTO alarms (purpose, at) VALUES ('idle', ?)", Date.now() + 15 * 60_000);
    }
    // A ready machine with no host is waited for, for a bound (`dialCheck`).
    if (row?.state === "ready" && !isPoolId(row.organizationId) && !selfManagedVms(this.env) && this.socket() === undefined) {
      if (!this.setting("hostAwaitedAt")) this.put("hostAwaitedAt", String(Date.now()));
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO alarms (purpose, at) VALUES ('dial', ?)", Number(this.setting("hostAwaitedAt")) + HOST_DIAL_MS);
    } else if (this.setting("hostAwaitedAt")) {
      this.hostDialed();
    }
    const next = [...this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM alarms")][0]?.at;
    if (next !== null && next !== undefined) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }

  /**
   * The bound on a start: a machine `ready` for HOST_DIAL_MS with no host connected (its bootstrap
   * failed, or its host died) is a failed start. Its VM goes and, while a session waits for it, is
   * built again from its disks; after HOST_DIAL_REBUILDS rebuilds in a row with no dial the waiting
   * entries are reported `computer_unavailable` and the machine stays parked until the next drain wakes it.
   */
  private async dialCheck(): Promise<void> {
    const row = this.lifecycle.row();
    if (row?.state !== "ready" || isPoolId(row.organizationId) || selfManagedVms(this.env)) return;
    if (this.socket() !== undefined) return this.hostDialed(true);
    // Since when it is waited for, stored: an alarm run early changes nothing.
    const since = Number(this.setting("hostAwaitedAt") ?? Date.now());
    if (Date.now() < since + HOST_DIAL_MS) return;
    const misses = Number(this.setting("dialMisses") ?? 0) + 1;
    const rebuild = misses <= HOST_DIAL_REBUILDS && this.api.owes();
    console.error(JSON.stringify({ level: "error", event: "computer.host_never_dialed", accountId: row.organizationId, misses, rebuild }));
    if (!(await this.lifecycle.park())) return;
    this.hostDialed();
    if (rebuild) {
      this.put("dialMisses", String(misses));
      await this.wakeComputer();
      return;
    }
    this.ctx.storage.sql.exec("DELETE FROM settings WHERE key = 'dialMisses'");
    if (this.api.owes()) await this.api.wakeFailed();
  }

  /** The wait for the host is over: it dialed (`met`: the rebuilds in a row start again), or the machine is not ready any more. */
  private hostDialed(met = false): void {
    this.ctx.storage.sql.exec("DELETE FROM alarms WHERE purpose = 'dial'");
    this.ctx.storage.sql.exec(met ? "DELETE FROM settings WHERE key IN ('hostAwaitedAt', 'dialMisses')" : "DELETE FROM settings WHERE key = 'hostAwaitedAt'");
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
    // Self-managed VMs (work 105): the operator sizes them.
    if (!row || isPoolId(row.organizationId) || row.state !== "ready" || selfManagedVms(this.env)) return;
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
    // Self-managed VMs (work 105) never park: the operator stops and starts them.
    if (!row || selfManagedVms(this.env)) return;
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
    const reachable = Boolean(installer && this.setting("slackTeamId"));
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
    // The link is the Slack actor's: what it last told this object, or this object's own until it has.
    const seen = this.setting("slackSeen");
    const teamId = seen ? this.setting("slackLinked") : this.setting("slackBotToken") ? this.setting("slackTeamId") : undefined;
    const teamName = seen ? this.setting("slackNameSeen") : this.setting("slackTeamName");
    const botUserId = seen ? this.setting("slackBotSeen") : this.setting("slackBotUserId");
    return {
      computer: this.lifecycle.view(),
      slack:
        teamId
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

  // ------------------------------------------------------------------ operator (edge /internal/computer/*, work 092)

  // ------------------------------------------------------------------ connection grants (edge, work 080)

  /**
   * Whom a computer key's connection grants are for: the live session it was
   * minted for and the Slack user who owns it, as this gateway has them. Null
   * when the session is not live here, so the key reaches only grants for everyone.
   */
  async grantAudience(sessionKey: string): Promise<{ sessionKey: string; ownerId: string } | null> {
    // A key of tracks and threads is minted for the session's `cs_…` id: its runner's key is the row's.
    const runner = isSessionId(sessionKey)
      ? [...this.ctx.storage.sql.exec<{ key: string }>("SELECT runner_key AS key FROM sessions WHERE session_id = ?", sessionKey)][0]?.key
      : sessionKey;
    const key = this.liveSessionKey(runner);
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
    const dead = await this.actors.org().dead().catch(() => null);
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
      failure: row.state === "failed" ? { code: row.failureCode, message: row.lastError, at: iso(row.updatedAt)! } : null,
      dead,
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
      (await this.lifecycle.create(accountId, { size, diskGiB: defaultDiskGiB(this.env) }));
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
    if (!this.env.COMPUTERS || this.poolTarget() === 0) return;
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
    if (!this.env.COMPUTERS || this.poolTarget() === 0) return null;
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
      target: () => this.poolTarget(),
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
    return this.lifecycle.create(poolId, { size: sizeFor(this.env, "default"), diskGiB: defaultDiskGiB(this.env) });
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
  async computerApi(accountId: string, caller: ApiRequest, op: ApiOp | SecretsApiOp): Promise<ApiReply> {
    this.bind(accountId);
    if (op.op === "secrets.session.put" || op.op === "secrets.session.list" || op.op === "secrets.session.delete") {
      // The edge checked the session's access with Org; this is its runner's row.
      const row = this.api.row(op.sessionId);
      if (!row) return { status: 404, error: { code: "session_not_found", message: "No such session." } };
      return this.secrets.api(caller, op, row.key);
    }
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

  /**
   * The wire found the tunnel down (530) under a key's connection: wake a
   * parked computer as an API call would, unless billing refuses it (a free
   * trial over), when it stays asleep and the client is told to back off.
   */
  async wireWake(): Promise<"waking" | "asleep" | "gone"> {
    if (!this.previewOrganization()) return "gone";
    const state = this.lifecycle.row()?.state;
    if (state === "provisioning" || state === "waking" || state === "resizing" || state === "ready") return "waking";
    if (state !== "parked" && state !== "parking") return "gone";
    if (!(await this.admitForApi().catch(() => false))) return "asleep";
    console.log(JSON.stringify({ level: "info", event: "computer.wire_wake", accountId: this.setting("accountId") }));
    // lifecycle.wake answers false when a wake is already in flight: still on its way up.
    await this.wakeComputer();
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
    // Self-managed VMs (work 105): the operator grows the disk.
    if (row?.state !== "ready" || selfManagedVms(this.env)) return;
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

  /**
   * The Slack actor's interactions that are this Computer's (the contract's list), as the presser. The
   * workspace is the one the Slack actor last reported; a `v:` button's session is named by its id.
   */
  async interaction(p: Principal, c: Parameters<ComputerRpcAdded["interaction"]>[1]): Promise<SlackModalReply> {
    this.bind(p.org);
    if (typeof c.interaction !== "object" || c.interaction === null) return {};
    let interaction = c.interaction as SlackInteraction;
    // The presser is the interaction's Slack user (the Slack actor checked them; a linked person's subject is their member id).
    const userId = interaction.user?.id;
    if (!userId || (p.subject.startsWith("slack:") && !p.subject.endsWith(`:${userId}`))) return {};
    if (interaction.team?.id !== (this.setting("slackSeen") ? this.setting("slackLinked") : this.setting("slackTeamId"))) return {};
    const action = interaction.actions?.[0];
    if (c.sessionId && action?.action_id?.startsWith("v:")) {
      const key = [...this.ctx.storage.sql.exec<{ key: string }>("SELECT runner_key AS key FROM sessions WHERE session_id = ?", c.sessionId)][0]?.key;
      // No runner row here: the handler answers that the session is gone.
      interaction = { ...interaction, actions: [{ ...action, action_id: `v:${key ?? c.sessionId}` }, ...(interaction.actions ?? []).slice(1)] };
    }
    return this.interact(userId, interaction);
  }

  /** The Slack actor only: a person left the workspace, was deactivated or became a guest; their subscriptions go. */
  async memberLeft(slackUserId: string): Promise<void> {
    const named = this.ctx.id.name;
    if (!this.setting("accountId") && named && !named.startsWith("computer-")) this.bind(named);
    if (!this.setting("accountId")) return;
    await this.access.models.memberRemoved(slackUserId);
  }

  private async interact(userId: string, interaction: SlackInteraction): Promise<SlackModalReply> {
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
      // Work 112: `!var` in a session's thread is a write to it, from a click as from a message.
      const instructs = key ? await this.instructs(key, userId).catch(() => undefined) : true;
      if (!instructs) {
        await respond(instructs === undefined ? LOOKUP_FAILED_TEXT : driversCommandText("var"));
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
    return {};
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
      protocol: CALVIN_PROTOCOL_VERSION,
      ...(await this.hostCredentials()),
      people: this.people(),
      definition,
      ...preview,
      // The relay is keyed from every welcome, this one too; without it the relay refuses every client.
      ...this.wireWelcome(preview),
    });
  }

  /** A welcome's `wire` (the relay's key, the previews key); warns when there is none. */
  private wireWelcome(preview: { preview?: CalvinPreviewConfig }): { wire?: { key: string } } {
    if (preview.preview) return { wire: { key: preview.preview.key } };
    console.warn(JSON.stringify({ level: "warn", event: "computer.welcome_without_wire_key", accountId: this.setting("accountId") }));
    return {};
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
    // A pool computer runs no sessions: only its hello, and answers to its own token checks (work 081; `model-response` at protocol 5).
    if (event.t !== "hello" && event.t !== "probed" && event.t !== "model-response" && isPoolId(this.setting("accountId") ?? "")) return;
    switch (event.t) {
      case "hello":
        return this.hello(ws, event);
      case "session":
        return this.report(event.report);
      case "disk":
        return this.diskReported(event);
      case "token":
        try {
          const result =
            event.kind === "opencomputer"
              ? await mintOpenComputerKey(this.env, this.accountId(), this.keySession(event.sessionKey))
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
      case "out-of-credits":
        return this.outOfCredits(event.sessionKey);
      // Work 077: the model proxy's answers and reports, relayed by the host.
      case "probed":
        return this.access.models.probed(event.id, event.result, event.error);
      case "model-bound":
        return this.access.models.bound(event.sessionKey, event.mode, event.key ?? event.fingerprint, event.profile);
      // Work 097, protocol 5: what an upstream answered on a session's credential, and the answer to a `model-request`.
      case "model-observed":
        return this.access.models.observed?.(event);
      case "model-response":
        return this.access.models.responded?.(event);
      case "model-health":
        return this.access.models.health(event);
      case "model-denied":
        return this.access.models.denied(
          this.runnerSession(event.sessionKey)?.ownerId,
          event.fallbackTo,
          this.access.models.harness(event.sessionKey) === "codex" ? "chatgpt" : "anthropic",
        );
      case "preview":
      case "unpreview":
        try {
          const result = event.t === "preview" ? await this.previews.register(event.from, event.req) : await this.previews.unregister(event.req.name);
          this.send({ t: "previewed", id: event.id, result });
          this.ctx.waitUntil(this.publishMachine());
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
      case "delta":
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
    // Work 084: API calls waiting on the host fail now; lost writers are recovered later.
    this.api.onHostClosed();
    // No host, no working session: stop billing now.
    this.billing.closeAll("host_disconnected", Date.now());
    await this.scheduleBilling();
    this.ctx.waitUntil(this.publishMachine());
  }

  private async hello(ws: WebSocket, event: Extract<CalvinHostToGateway, { t: "hello" }>): Promise<void> {
    // Protocol 6 (tracks and threads): one number on both sides; a host that says less upgrades first.
    if (!(typeof event.protocol === "number" && event.protocol >= CALVIN_PROTOCOL_VERSION)) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.host_upgrade_required", hostId: event.hostId, version: event.version, protocol: event.protocol }));
      ws.close(UPGRADE_REQUIRED, "upgrade required");
      return;
    }
    // The host dialed: the start's bound is met.
    this.hostDialed(true);
    // A reconnect replaces the host's old socket, which may be half-open.
    const previous = this.telemetry.previousConnection(ws, this.ctx.getWebSockets());
    for (const socket of this.ctx.getWebSockets()) if (socket !== ws) socket.close(4001, "replaced");
    const features = Array.isArray(event.features) ? event.features.filter((f): f is string => typeof f === "string").slice(0, 32) : undefined;
    ws.serializeAttachment({
      hostId: event.hostId,
      version: event.version,
      connectedAt: Date.now(),
      ...(features ? { features } : {}),
      welcomed: false,
    } satisfies HostAttachment);
    // A pool slot's hello isn't the organization's computer's: its own hello as the organization comes after the claim.
    if (!isPoolId(this.setting("accountId") ?? "")) this.recordHostFeatures(features ?? []);
    // The host lists its model proxy's profiles; without them (the proxy is down) the last list stands.
    const profiles = helloProfiles(event.profiles);
    if (profiles) this.recordHostProfiles(profiles);
    this.telemetry.connected(event.version, previous);
    const accountId = this.setting("accountId") ?? "";
    if (isPoolId(accountId)) return this.poolHello(ws, accountId);
    if (selfManagedVms(this.env)) {
      // Work 105: the operator's VM connecting is what makes the computer: its row is `ready` from here,
      // whether or not Slack was installed first, and threads told it was offline may be told again next time.
      await this.lifecycle.create(accountId, { size: sizeFor(this.env, "default"), diskGiB: defaultDiskGiB(this.env) });
      this.ctx.storage.sql.exec("DELETE FROM notices WHERE kind = 'offline'");
    }
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
        protocol: CALVIN_PROTOCOL_VERSION,
        ...(await this.hostCredentials()),
        people: this.people(),
        ...(definition ? { definition } : {}),
        ...(await this.telemetry.credential(event.hostId)),
        ...preview,
        // The relay verifies X-Wire-Auth with the previews key.
        ...this.wireWelcome(preview),
      } satisfies CalvinGatewayToHost),
    );
    // The API sees the host only once it has its welcome (and the wire key in it).
    this.markWelcomed(ws);
    if (stored) this.ctx.waitUntil(this.refreshDefinition());
    // The organization's first hello (or one after Cloudflare failed): make its tunnel; the host hears when it is ready.
    // Work 084: the wire's key records name the tunnel, so they follow it.
    if (this.previews.config()) this.ctx.waitUntil(this.previews.ensureTunnel().then(() => this.keys.rewriteAll()));
    // Work 084: the relay's access lists, and a look for writers lost while the host was away.
    this.api.onHello(event.journals);
    // Tracks and threads: Org's access lists and knowledge repository, the Slack actor's people and credentials.
    this.ctx.waitUntil(this.readOrg());
    this.ctx.waitUntil(this.readSlack());
    this.ctx.waitUntil(this.publishMachine());
    // The host starts over: what it reports working now is billed from now;
    // whatever the previous socket left open ends here.
    this.billing.closeAll("host_reconnected", Date.now());
    for (const report of event.sessions ?? []) await this.report(report);
    // Work 077: a restarted host and proxy have no tokens; its sessions on a seat (or refused) get their routes again.
    await this.access.models.helloed((event.sessions ?? []).map((report) => report.key)).catch((error) =>
      console.error(JSON.stringify({ level: "error", event: "computer.model_hello_push_failed", message: errorText(error) })),
    );
    await this.scheduleBilling();
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
        protocol: CALVIN_PROTOCOL_VERSION,
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

  /** Sessions running now, with their conversations and last activity (pushes go to these). */
  private liveSessions(): ModelSession[] {
    return [...this.ctx.storage.sql.exec<{ key: string; status: string; activeAt: number }>(
      "SELECT runner_key AS key, status, updated_at AS activeAt FROM sessions WHERE status IN ('starting', 'idle', 'busy')",
    )].flatMap((row) => {
      const session = this.modelSession(row.key);
      return session ? [{ ...session, status: row.status, activeAt: row.activeAt }] : [];
    });
  }

  /** Subscription refreshes, disconnects and host reconnects include API sessions too. */
  private modelSession(key: string): ModelSession | undefined {
    const slack = this.runnerSession(key);
    if (slack) return slack;
    const row = this.api.row(key);
    const ownerId = row?.ownerUserId ? apiSubscriptionOwner(this.access, row.ownerUserId) : undefined;
    return row && ownerId ? { key: row.key, ownerId, channelId: row.channelId, threadTs: row.threadTs } : undefined;
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

  /**
   * What a `welcome` or a `credentials` frame carries: the host's credentials
   * and, at protocol 5, `models`, the route of a session whose delivery names
   * none. `credentials.resolved` on `t` (or its own emitter), with where the
   * model key came from.
   */
  private async hostCredentials(telemetry?: GatewayTelemetry, known?: Awaited<ReturnType<SlackRpc["forHost"]>>["slack"]): Promise<Pick<Extract<CalvinGatewayToHost, { t: "credentials" }>, "credentials" | "models">> {
    return this.telemetry.within(telemetry, async (t) => {
      const span = t.start("credentials.resolved");
      try {
        const { key, source } = await this.organizationModelKey();
        const model = await this.managedModel(key);
        if (model.fallback) console.warn(JSON.stringify({ level: "warn", event: "computer.model_key_fallback", accountId: this.setting("accountId") }));
        // The bot token is the Slack actor's: asked for each time, never kept here.
        const slack = known !== undefined ? known : await this.slackForHost();
        const credentials = {
          slackBotToken: slack?.botToken ?? "",
          slackBotUserId: slack?.botUserId ?? "",
          ...(slack?.teamId ? { teamId: slack.teamId } : {}),
          ...model.credentials,
        };
        span.end({ outcome: "completed", data: { source } });
        return { credentials, ...(model.route.mode === "managed" ? {} : { models: { [DEFAULT_HARNESS]: model.route } }) };
      } catch (error) {
        span.end({ outcome: "failed", error_type: "unknown" });
        throw error;
      }
    });
  }

  /** The organization's managed models: no key in the host's credentials; the profile route that carries it, or a refusal. */
  private async managedModel(key: string | null): Promise<{ credentials: ModelCredentials; route: ModelRoute; fallback: boolean }> {
    return { credentials: {}, ...(await managedModelRoute(key, this.env, this.liveHost()?.profiles)) };
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

  /** The Slack actor's credentials for the host; none when it cannot be asked (the host keeps what it had until the next `credentials`). */
  private async slackForHost(): Promise<Awaited<ReturnType<SlackRpc["forHost"]>>["slack"]> {
    try {
      return (await this.actors.slack().forHost()).slack;
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.slack_read_failed", message: errorText(error) }));
      return null;
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
    this.send({ t: "credentials", ...(await this.hostCredentials()) });
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
      this.send({ t: "credentials", ...(await this.hostCredentials()) });
    })()
      .catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "computer.model_key_provision_failed", accountId, message: errorText(error) })))
      .finally(() => {
        this.provisioningModelKey = undefined;
      });
    this.ctx.waitUntil(this.provisioningModelKey);
  }

  /** Slack's Web API, through the Slack actor (it holds the token); a call that did not reach it is Slack's failure. */
  private async slack(method: string, body: Record<string, unknown>): Promise<SlackResult> {
    try {
      return await this.actors.slack().api(method, body);
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  private person(slackUserId: string): CalvinPerson {
    return this.people().find((p) => p.slackUserId === slackUserId) ?? personFor(slackUserId);
  }

  private people(): CalvinPerson[] {
    return [...this.ctx.storage.sql.exec<{ slackUserId: string; dir: string; gitName: string; gitEmail: string }>(
      "SELECT slack_user_id AS slackUserId, dir, git_name AS gitName, git_email AS gitEmail FROM people ORDER BY slack_user_id",
    )].map((row) => ({ ...row }));
  }

  private sessionIdOf(key: string): string | undefined {
    return [...this.ctx.storage.sql.exec<{ id: string | null }>("SELECT session_id AS id FROM sessions WHERE runner_key = ?", key)][0]?.id ?? undefined;
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

  /**
   * Whether this Slack user may write to the session behind a runner key: Org's
   * access record decides (spec 35.2), read as their principal (the Slack actor's).
   * A session Org has no record of is as before for one without an owner: allowed.
   */
  private async instructs(key: string, userId: string): Promise<boolean> {
    const sessionId = this.sessionIdOf(key);
    if (!sessionId) return true;
    const access = await this.actors.org().access(sessionId);
    if (!access) return true;
    const p = await this.actors.slack().principal(userId);
    if (access.writers === "members") return !!p && (p.kind === "member" || p.kind === "key");
    return !!p && access.writers.includes(byOf(p));
  }

  /**
   * A session waiting for a secret or a connection goes on: one turn in its
   * log, as the person who gave it (its SessionLog owes the drain). Idempotent on `ts`.
   */
  private async wakeSession(session: { key: string }, userId: string, text: string, ts: string): Promise<void> {
    const sessionId = this.sessionIdOf(session.key);
    if (!sessionId) return;
    const p = await this.actors.slack().principal(userId);
    if (!p) return;
    await this.actors.log(sessionId).accept(p, {
      id: await turnIdFor(session.key, `${ts}\0wake`),
      kind: "turn",
      body: { input: text, slack: { userId, ts, files: [], mentioned: true, context: [], linked: [] } },
    });
  }

  /** A runner key of this organization's workspace → its conversation. */
  private runnerSession(key: string): { key: string; ownerId: string; channelId: string; threadTs: string } | undefined {
    const parsed = parseSessionKey(key);
    if (!parsed || parsed.teamId !== this.setting("slackTeamId")) return undefined;
    const row = this.session(key);
    return row?.ownerId ? { key, ownerId: row.ownerId, channelId: row.channelId, threadTs: row.threadTs } : undefined;
  }

  /**
   * The `cs_…` id of the session a host names (by its runner's key) for an OpenComputer key: the key's
   * `session_key`, which the edge makes an agent principal of that session. Undefined: no session here,
   * and no key is minted.
   */
  private keySession(key: unknown): string | undefined {
    if (typeof key !== "string") return undefined;
    return [...this.ctx.storage.sql.exec<{ id: string }>("SELECT session_id AS id FROM sessions WHERE runner_key = ? AND session_id IS NOT NULL", key)][0]?.id;
  }

  private liveSessionKey(key: unknown): string | undefined {
    if (typeof key !== "string" || !this.runnerSession(key)) return undefined;
    const status = this.session(key)?.status;
    return status === "starting" || status === "idle" || status === "busy" ? key : undefined;
  }

  /**
   * Whose user-scope secrets a session gets: a Slack session's owner; an API session's dashboard owner only through
   * the Slack user they linked (work 083). Undefined: the session's and the workspace's secrets only.
   */
  private secretsOwner(row: { ownerId: string | null; ownerUserId: string | null }): string | undefined {
    return row.ownerId ?? linkedSlackUser(this.access, row.ownerUserId ?? undefined);
  }

  /** Secrets changed: send each affected running session its new set. */
  private async pushSecrets(which: { key?: string; owner?: string }): Promise<void> {
    const live = [...this.ctx.storage.sql.exec<{ key: string; ownerId: string | null; ownerUserId: string | null }>(
      "SELECT runner_key AS key, owner_id AS ownerId, owner_user_id AS ownerUserId FROM sessions WHERE status IN ('starting', 'idle', 'busy')",
    )];
    for (const session of live) {
      if (!session.ownerId && !session.ownerUserId) continue;
      const owner = this.secretsOwner(session);
      if ((which.key && session.key !== which.key) || (which.owner && owner !== which.owner)) continue;
      const secrets: SessionSecret[] = await this.secrets.forSession(session.key, owner);
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
          const definition = workspaceDefinition("organization", fresh, this.knowledge());
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

  /** The organization's knowledge repository (`owner/name`), as Org last answered `forHost` (`readOrg`), or none. */
  private knowledge(): string | undefined {
    return this.setting("knowledge") || undefined;
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
