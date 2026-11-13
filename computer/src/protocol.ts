// Contracts between the three processes of the split deployment (work 045):
//
//   gateway  (the backend's Worker in production, src/gateway on a laptop)  Slack HTTP, routing, tables, secrets
//     ⇅  one WebSocket per host, dialed by the host: GatewayToHost / HostToGateway
//   host agent (VM or laptop)           forks, runner lifecycle, housekeeping
//     ⇅  one unix socket per runner, the runner listens: HostToRunner / RunnerToHost
//   runner   (one per active session)    Agent SDK query(), renders to Slack itself
//
// Every message is one JSON object per WebSocket frame or per line on a unix
// socket. Messages that expect an answer carry an `id`; the answer is a
// `reply` (or `token`) with the same id. Unknown `t` values are ignored, so
// either side can be newer (risk R4).
//
// Changing this file changes the contract for every work item; coordinate in
// work 045 before editing it.

import type { Tier } from './tiers.js';
import type { Linked } from './links.js';
import type { Batch } from './telemetry/emitter.js';
import type { ApiDelivery, GatewayToHostV4, HostToGatewayV4, HostToRunnerV4, JournalReport, RunnerApi, WireConfig } from './protocol-api.js';
import type { GatewayToHostModel, HostToGatewayModel, ModelProfile, ModelRoute, ModelRoutes, RunnerModel } from './protocol-model.js';
import type { WorkspaceDefinition } from './protocol-workspace.js';

export * from './protocol-api.js';
export * from './protocol-model.js';
export * from './protocol-workspace.js';

// 2 (work 077): the hello carries `features`; `deliver.model`, `model`, `probe`/`probed`,
// `model-bound`/`model-health`/`model-denied`. The gateway routes a host below 2 managed only.
// 3 (work 082): subscription routes carry `provider` and `accountId`, sessions a `harness`,
// `model-health` a `provider`, `probe` a `provider` and `accountId`; the hello's `features` add
// `model-proxy/chatgpt`. Every field is optional and absent means what it meant at 2 (anthropic,
// claude), so a v2 frame reads unchanged; the gateway sends chatgpt routes only to a host that
// says 3 and lists `model-proxy/chatgpt`.
// 4 (work 084): the streaming session API (protocol-api.ts); a session may have no Slack thread and
// carries its `cs_` id; a person may have no Slack id. All optional: a v3 frame reads unchanged, and
// the gateway sends v4 frames only to a host that says 4.
// 5 (work 097): model routes are profiles of the host's model proxy (protocol-model.ts). The hello
// lists `profiles` in place of `features`; the earlier route modes, `probe`/`probed` and
// `model-health` are gone. A host at 5 speaks nothing older about models.
export const PROTOCOL_VERSION = 5;

/** Which agent runs a session's turns (work 082). Absent: claude. */
export type HarnessName = 'claude' | 'codex';

/**
 * A session's permission mode as persisted and sent between processes: Claude
 * Code's names, kept for every harness (work 082; a harness maps its own).
 * harness/claude/ asserts they still equal the SDK's.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
/** A reasoning effort, as `!effort` sets it and a session persists it; each harness's `caps.effort` says which it takes (`ultra`: Codex only). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/** Output speed, as `!speed` sets it and a session persists it: `fast` (Claude's fast mode, Codex's priority tier) unless `standard`. */
export type Speed = 'fast' | 'standard';

// ---------------------------------------------------------------- shared shapes

/** A Slack file as the event carries it; the runner downloads it with the bot token. */
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

/** A row of the gateway's people table: who may use the instance. */
export interface Person {
  /** Work 084: absent for a person with no Slack identity (an `opc` user); `userId` is then set. */
  slackUserId?: string;
  /** Work 084: the member, `usr_…`: the API's `Person.id`, the wire's `member`; `name`/`email` for the API. */
  userId?: string;
  name?: string;
  email?: string;
  /** Directory name on the host: /data/people/<dir> (046). Work 084: `user-<id>` for a person with no Slack id. */
  dir: string;
  /** Git author for commits made in this person's sessions. */
  gitName: string;
  gitEmail: string;
  /** May set and remove workspace-wide secrets (work 046). */
  admin?: boolean;
}

/** Everything a host needs to start or resume a session's runner. */
export interface SessionSpec {
  /** `<channel>:<threadTs>` for threads, `<channel>` for code channels; work 084: the `cs_` id for a session with no Slack thread. Internal: never on the API. */
  key: string;
  /** Work 084: `api` for a session with no Slack binding (created over the API). */
  kind: 'thread' | 'channel' | 'api';
  /** Work 084: absent for a session with no Slack binding; it then renders nowhere (NullSurface) and is read through the API. */
  channel?: string;
  /** Work 084: the public id, `cs_` + 16 (session-ids.ts); `origin` (`slack|opc|dashboard|api`) and `metadata` for the API. */
  sessionId?: string;
  origin?: { type: string; client?: string };
  metadata?: Record<string, string>;
  threadTs?: string;
  /** The initiator; owns the session (thesis: a thread runs as who started it). */
  owner: Person;
  teamId?: string;
  title: string;
  mode: PermissionMode;
  model?: string;
  /** Reasoning effort set with `!effort`; the default without. */
  effort?: EffortLevel;
  /** Output speed set with `!speed` or the API; absent = fast. */
  speed?: Speed;
  /** Set once the runner reported it; present means resume. */
  sdkSessionId?: string;
  /** Set once the host forked; present means the fork exists. */
  forkPath?: string;
  /** Work 082: the agent that runs its turns; absent = claude. `codex` needs a route whose profile serves Codex. */
  harness?: HarnessName;
}

/** One Slack message delivered into a session. Text is already decoded and the mention stripped. */
export interface Delivery {
  userId: string;
  text: string;
  /** The message's own ts, for reactions. */
  ts: string;
  /** Fetched by the runner with the bot token, never by the gateway. */
  files?: SlackFile[];
  /**
   * A person's message in the conversation: whether it @mentions the bot. The
   * agent sees who wrote it and this, and may stay silent when it is not
   * addressed to it. Unset for synthetic deliveries (a spawned thread's brief).
   */
  mentioned?: boolean;
  /**
   * The bot is @mentioned only mid-message ("ask @bot to check"), not at the
   * start: maybe a request, maybe a remark about it. Older runners ignore it.
   */
  mentionedInline?: boolean;
  /**
   * Slack permalinks in the text, read by the gateway when the security model
   * allows it, else the reason (work 049). Older runners ignore it.
   */
  linked?: Linked[];
  /** Work 084: a message from the API (opc, dashboard): who, and how it is delivered when busy. */
  api?: ApiDelivery;
}

/**
 * Telemetry trace context (work 054): minted by the gateway per message and
 * carried on `deliver`; the host adds its stamps before forwarding. Optional
 * everywhere, so older hosts and runners ignore it.
 */
export interface TraceContext {
  /** trace_id, UUIDv7. */
  id: string;
  /** ms since epoch: the frontend's own time for the message (Slack ts × 1000). */
  sentAt: number;
  /** Gateway wall clock at message.received. */
  receivedAt: number;
  /** Gateway wall clock at dispatch.sent. */
  dispatchedAt?: number;
  surface: string;
  surfaceWorkspaceId: string;
  conversationId: string;
  personId: string;
  surfaceEventId?: string;
  gatewayVersion?: string;
  gatewayRegion?: string;
  gatewaySessionId?: string;
  synthetic?: boolean;
  // Added by the host before forwarding to the runner. (Hosts before calvin#49
  // also sent hostReceivedAt, runnerReadyAt, forkMs and launchMs; ignored now:
  // those are host events on the same trace, joined in SQL.)
  path?: 'warm' | 'new' | 'resume' | 'prewarmed';
}

export type SessionStatus = 'starting' | 'idle' | 'busy' | 'stopped' | 'error';

/** What a host reports about a session; the gateway stores it in the session table. */
export interface SessionReport {
  key: string;
  /** Work 084: the `cs_` id, when the session has one. */
  sessionId?: string;
  status: SessionStatus;
  sdkSessionId?: string;
  forkPath?: string;
  runnerVersion?: string;
  model?: string;
  effort?: EffortLevel;
  speed?: Speed;
  mode?: PermissionMode;
  error?: string;
  /** Work 082: the harness the runner runs; absent = claude (so a Claude runner's report is unchanged). */
  harness?: HarnessName;
  subagents?: number; // work 084: running subagents (absent = 0); the host never idle-exits a runner with any
}

export interface WorkspaceStatus {
  person: string;
  repos: { name: string; fetchedAt?: string; head?: string; problem?: string }[];
}

/** Credentials the gateway hands to a host at connect; held in memory only. */
export interface HostCredentials {
  slackBotToken: string;
  slackBotUserId: string;
  teamId?: string;
  /** Host → runner only (work 097, C4): the session's route as its runner knows it; absent while it has none. */
  model?: RunnerModel;
}

/** A session asks for a new thread to run work in parallel (work 047). */
export interface SpawnRequest {
  /** One line: what the new thread should do. */
  task: string;
  /** Workspace-relative path of the Markdown brief (optional #anchor), already on its repository's default branch. */
  brief: string;
  /** The brief on GitHub, for the posted message. */
  briefUrl?: string;
  /** Model tier for the new thread (`smart`, `fast`, `default`); without one it keeps the parent's model. */
  tier?: Tier;
}

export interface SpawnResult {
  key: string;
  url?: string;
}

/**
 * Preview URLs (work 074): the host runs `cloudflared tunnel run` with
 * `tunnelToken` in TUNNEL_TOKEN, and its preview proxy (host/preview-proxy.ts)
 * forwards only `ports`, only requests signed with `key` (base64url, 32 bytes;
 * src/signed-header.ts). Held in memory only, like credentials.
 */
export interface PreviewConfig {
  tunnelToken: string;
  key: string;
  ports: number[];
}

/** A session asks for a public URL to one of its ports (the `preview` tool). */
export interface PreviewRequest {
  port: number;
  /** A chosen name (one DNS label); without one the gateway generates one, or returns the port's existing name. */
  name?: string;
}

/** The gateway's answer; `unpreview` answers with `{ url: "", name, port: 0 }`. */
export interface PreviewResult {
  url: string;
  name: string;
  port: number;
}

/** What the host gives the runner: the gateway's answer and its readiness probe (host/preview-probe.ts). */
export interface PreviewToolResult extends PreviewResult {
  /** The port answered HTTP within the probe's wait. */
  listening: boolean;
  /** The one config line a framework's host check needs, when the probe met it. */
  hint?: string;
}

/** A Slack thread a session reads or posts to (work 049 L3): a permalink, or a channel id and a message ts. */
export interface ReadThreadRequest {
  url?: string;
  channel?: string;
  ts?: string;
}

export interface PostThreadRequest extends ReadThreadRequest {
  /** Slack mrkdwn; the gateway neutralizes channel-wide mentions and appends who it was posted for. */
  text: string;
}

export interface PostThreadResult {
  ts: string;
  url: string;
}

/** Where a secret applies (work 046): one session, every session of a person, or every session. */
export type SecretScope = 'session' | 'user' | 'workspace';

/** A secret a session gets: an environment variable, or a file whose path is in the variable. */
export interface SessionSecret {
  name: string;
  value: string;
  scope: SecretScope;
  file?: boolean;
  /** A variable (`!var`): not secret, so never redacted. Older runners redact it like a secret. */
  variable?: boolean;
}

/** A session asks its person for a secret (the request_secret tool); the gateway posts a button. */
export interface SecretRequest {
  name: string;
  /** One line: what it is for, shown with the button. */
  reason: string;
  file?: boolean;
}

export interface GitHubToken {
  token: string;
  /** ISO time. */
  expiresAt: string;
  /** An OpenComputer key's API URL (kind 'opencomputer', work 067). */
  apiUrl?: string;
  /** The automations repository's git remote, without credentials, and its basic-auth user (kind 'automation-repo'). */
  remoteUrl?: string;
  username?: string;
}

/**
 * What a token is for: GitHub (git, gh), the OpenComputer CLI (a one-hour org
 * key), or pushing to the organization's automations repository (work 067).
 */
export type TokenKind = 'github' | 'opencomputer' | 'automation-repo';

// ---------------------------------------------------------------- gateway ⇄ host

/** Sent by the host. The host authenticates with `Authorization: Bearer <host token>` on the upgrade. */
export type HostToGateway =
  /** `profiles` (work 097): the model proxy's, while the host is connected to it; a change re-sends the hello. */
  | { t: 'hello'; protocol: number; hostId: string; version: string; sessions: SessionReport[]; profiles?: ModelProfile[]; journals?: JournalReport[] }
  | { t: 'session'; report: SessionReport }
  | { t: 'workspace'; status: WorkspaceStatus }
  /**
   * The data volume's size and free space (work 071), every 5 minutes:
   * a managed gateway grows the disk when it nears capacity. Older gateways ignore it.
   */
  | { t: 'disk'; totalBytes: number; freeBytes: number }
  /** A GitHub token for git/gh inside a session (credential helper → host → gateway). */
  | { t: 'token'; id: string; sessionKey?: string; repos?: string[]; kind?: TokenKind }
  /** Session `from` starts a new thread (work 047); answered by `spawned`. */
  | { t: 'spawn'; id: string; from: string; req: SpawnRequest }
  /** Session `from` asks its person for a secret; answered by `secret-asked`. */
  | { t: 'secret-request'; id: string; from: string; req: SecretRequest }
  /** Session `from` reads a Slack thread (work 049 L3); answered by `thread`, a refusal being a `Linked` that is not ok. */
  | { t: 'read'; id: string; from: string; req: ReadThreadRequest }
  /** Session `from` posts into a Slack thread for its owner; answered by `posted`. */
  | { t: 'post'; id: string; from: string; req: PostThreadRequest }
  /** Session `from` registers a port's public URL, or releases a name (work 074); both answered by `previewed`. */
  | { t: 'preview'; id: string; from: string; req: PreviewRequest }
  | { t: 'unpreview'; id: string; from: string; req: { name: string } }
  /** The model provider refused session `sessionKey`'s turn for credits (a 402): the gateway tells the thread how to get more. */
  | { t: 'out-of-credits'; sessionKey: string }
  | { t: 'reply'; id: string; ok: boolean; error?: string }
  | HostToGatewayModel
  | HostToGatewayV4;

export type GatewayToHost =
  /**
   * `definition` (work 052): the organization's workspace definition, used instead of
   * SP_DEFINITION and kept on disk until a later welcome changes it. Absent: no change.
   */
  /** `telemetryCredential` (work 054): a renewed signed credential for the telemetry collector. Absent: keep the current one. */
  | {
      t: 'welcome';
      protocol: number;
      credentials: HostCredentials;
      /** Work 097: the route of a session whose own delivery carries none, by harness. */
      models?: ModelRoutes;
      people: Person[];
      definition?: WorkspaceDefinition;
      telemetryCredential?: string;
      /** The collector base URL, for a host whose host.env has no SP_TELEMETRY_URL. Ignored when it has one. */
      telemetryUrl?: string;
      /** Work 074: this computer's previews. Absent: its tunnel is not provisioned yet; cloudflared stays stopped. */
      preview?: PreviewConfig;
      /** Work 084: the relay's edge key. Absent: the wire is off on this computer (the relay refuses every upgrade). */
      wire?: WireConfig;
    }
  /** Work 074: the previews config changed (tunnel provisioned, a port registered or released); sent before the `previewed` it causes. */
  | { t: 'previews'; preview: PreviewConfig }
  | { t: 'people'; people: Person[] }
  /**
   * A warm-pool host (id `pool-…`) was claimed by an organization (work 052):
   * keep this identity and reconnect as it. Refused by any other host.
   */
  | { t: 'assign'; organizationId: string; hostToken: string; gatewayUrl: string }
  /** Credentials changed (fresh Slack install, new Claude token): replaces the welcome's; the host forwards to runners. */
  | { t: 'credentials'; credentials: HostCredentials; models?: ModelRoutes }
  /** Start the runner if needed (fork if no forkPath, resume if sdkSessionId), then deliver. */
  /** Per-delivery credentials let a multi-tenant gateway keep workspace tokens scoped to one session. */
  /** `model` (work 097): the session's route; absent: the one it had, else `models[harness]`. */
  /** Work 084: `epoch` and `lastSeq` seed the session's journal as on `start` (absent: 1 and 0, or the local journal's). */
  | { t: 'deliver'; id: string; session: SessionSpec; msg: Delivery; credentials?: HostCredentials; secrets?: SessionSecret[]; trace?: TraceContext;
      model?: ModelRoute; epoch?: number; lastSeq?: number }
  /** A session's secrets changed: the host passes them to its runner, if one is running. */
  | { t: 'secrets'; sessionKey: string; secrets: SessionSecret[] }
  /** A button click on a prompt the session's runner posted. */
  | { t: 'action'; id: string; sessionKey: string; promptId: string; value: string; userId: string }
  /** Slack's stop button or !stop: interrupt the running turn. */
  | { t: 'stop'; id: string; sessionKey: string }
  /** A push to a repository: fetch it in every workspace that has it (D4). */
  | { t: 'pushed'; repo: string; ref: string }
  | { t: 'token'; id: string; result?: GitHubToken; error?: string }
  | { t: 'spawned'; id: string; result?: SpawnResult; error?: string }
  | { t: 'thread'; id: string; result?: Linked; error?: string }
  | { t: 'posted'; id: string; result?: PostThreadResult; error?: string }
  /** Answers `preview` and `unpreview`; `error` is a sentence for the model. */
  | { t: 'previewed'; id: string; result?: PreviewResult; error?: string }
  | { t: 'secret-asked'; id: string; error?: string }
  | { t: 'reply'; id: string; ok: boolean; error?: string }
  | GatewayToHostModel
  | GatewayToHostV4;

// ---------------------------------------------------------------- host ⇄ runner

/** The runner's start-up input: JSON in the RUNNER_SPEC environment variable. */
export interface RunnerSpec {
  /**
   * The runner's own id (work 069), minted by the host: names its socket, unit
   * and secrets directory for its life. Absent from hosts before 069, whose
   * runners are named by their session key.
   */
  id?: string;
  /** The session; absent for a spare, which gets it with `claim`. */
  session?: SessionSpec & { forkPath: string };
  /** Unix socket path the runner listens on. */
  socket: string;
  /** Work 084: the runner is the session's API writer (protocol-api.ts). */
  api?: RunnerApi;
  /** Code version (git commit) the runner was started from. */
  version: string;
}

/** A spare runner's state (work 069): a parked Claude Code waiting for a session. */
export interface SpareReport {
  id: string;
  /** Parked and claimable; false while (re)starting its Claude Code. */
  ready: boolean;
  version: string;
  /** What its harness was started for (model-key.ts `spareKind`, design C6): a session with the same kind may claim it. */
  kind?: string;
}

export type HostToRunner =
  | { t: 'deliver'; id: string; msg: Delivery; trace?: TraceContext }
  | { t: 'action'; id: string; promptId: string; value: string; userId: string }
  | { t: 'stop'; id: string }
  /** Credentials refreshed (e.g. after a host reconnect). */
  | { t: 'credentials'; credentials: HostCredentials }
  /** Exit when no turn is running (idle timeout, code update, drain); `ms`: quit after it anyway (a retired runner, work 084). */
  | { t: 'exit'; ms?: number }
  | { t: 'token'; id: string; result?: GitHubToken; error?: string }
  | { t: 'spawned'; id: string; result?: SpawnResult; error?: string }
  | { t: 'thread'; id: string; result?: Linked; error?: string }
  | { t: 'posted'; id: string; result?: PostThreadResult; error?: string }
  | { t: 'previewed'; id: string; result?: PreviewToolResult; error?: string }
  /** The session's secrets, all of them: sent before a delivery and whenever they change. */
  | { t: 'secrets'; secrets: SessionSecret[] }
  | { t: 'secret-asked'; id: string; error?: string }
  | { t: 'checked-out'; id: string; result?: CheckoutResult[]; error?: string }
  /**
   * A spare becomes this session's runner (work 069): its fork is complete.
   * Answered by `reply`; on an error the host starts the session cold.
   */
  | { t: 'claim'; id: string; session: SessionSpec & { forkPath: string }; api?: RunnerApi }
  /** The session's owner changed (their name or email became known): commits from now on carry it. */
  | { t: 'owner'; owner: Person } | HostToRunnerV4;

/** A repository checked out into a running session's fork (`checkout_repo`), cloned first if needed. */
export interface CheckoutResult {
  name: string;
  /** Fork-relative directory. */
  dir: string;
  branch: string;
  from: string;
  base: string;
  /** Set when the repository could not be checked out; the others still were. */
  error?: string;
  /** The fetch before the worktree failed; it starts from the cached default branch. */
  fetchError?: string;
}

export type RunnerToHost =
  | { t: 'report'; report: SessionReport }
  /** Sent by a runner without a session instead of `report`; never forwarded to the gateway. */
  | { t: 'spare'; spare: SpareReport }
  | { t: 'token'; id: string; repos?: string[] }
  | { t: 'spawn'; id: string; req: SpawnRequest }
  | { t: 'read'; id: string; req: ReadThreadRequest }
  | { t: 'post'; id: string; req: PostThreadRequest }
  /** Work 074: answered by `previewed`, after the host's readiness probe for `preview`. */
  | { t: 'preview'; id: string; req: PreviewRequest }
  | { t: 'unpreview'; id: string; req: { name: string } }
  | { t: 'secret-request'; id: string; req: SecretRequest }
  /** Check repositories (names or owner/name) out into this session's fork; answered by `checked-out`. */
  | { t: 'checkout'; id: string; repos: string[] }
  /** Telemetry the runner buffered (work 054); the host re-validates and ships it. */
  | { t: 'telemetry'; batch: Batch }
  /** The model provider refused this session's turn for credits; forwarded to the gateway as `out-of-credits`. */
  | { t: 'out-of-credits' }
  /** Work 077: the subscription refused `model`; the runner switched to `fallbackTo`. Forwarded as `model-denied`. */
  | { t: 'model-denied'; model: string; fallbackTo: string }
  | { t: 'reply'; id: string; ok: boolean; error?: string };

// Slack button ids: action-ids.ts (p:<base64url(sessionKey)>:<promptId>:<value>).
export { decodeActionId, encodeActionId } from './action-ids.js';

// ---------------------------------------------------------------- layout on a host

/** Defaults for a host; overridable by env (SP_DATA, SP_RUN). */
export const HOST_DATA = process.env.SP_DATA ?? '/data';
export const HOST_RUN = process.env.SP_RUN ?? '/run/slack-presence';
/** Local socket where git credential helpers and the gh shim ask the host for a token. */
export const HOST_TOKEN_SOCKET = 'token.sock';
/** Each runner's own token socket, `<HOST_RUN>/tokens/<runner id>.sock` (work 080): the host knows the session from which one is asked. */
export const RUNNER_TOKEN_DIR = 'tokens';
