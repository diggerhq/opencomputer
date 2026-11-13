// The gateway side of Calvin's host protocol (calvin src/protocol.ts, branch
// feat/computer-per-org; dash-cal's calvin-protocol.ts was the first
// gateway-side port). One JSON object per WebSocket frame; unknown `t`
// values are ignored by both sides, so either may be newer. Only the shapes
// this gateway sends or reads are declared here.

import type { Linked } from "./threads.js";

// 2 (work 077): the hello carries `features`, and `deliver.model`, `model`, `probe`/`probed`,
// `model-bound`/`model-health`/`model-denied` exist. A host below 2 is routed managed only.
// 3 (work 082): routes carry `provider` and `accountId`, sessions a `harness`, `model-health`
// a `provider`, `probe` a `provider` and `accountId`. ChatGPT routes go only to a host at 3 or
// above whose hello lists `model-proxy/chatgpt`; a host at 2 sees exactly what it saw before.
// 4 (work 084): the streaming session API. `start`/`started`, `api`/`api-result`,
// `journal`/`journal-ack`, `access`, `revoked`, `welcome.wire`; a session may have no Slack
// thread (`kind: "api"`, the `cs_` id as its key) and carries its `sessionId`; a person may have
// no Slack id. Every field is optional: a v3 frame reads unchanged, and v4 frames go only to a
// host that says 4 (`hostSpeaksV4`).
// 5 (work 097, design C2): every session's model traffic goes through the host's model proxy, by
// profile. The hello lists the proxy's `profiles`; `welcome` and `credentials` carry `models`;
// routes are `profile` or `refuse`; `model-observed`, `model-request` and `model-response` exist.
// `managed` and `subscription` routes, the `model-proxy` features, `probe`/`probed`,
// `model-health` and the model key in `credentials` do not exist at 5. A host that says 5 gets
// only protocol 5's shapes, a host below it exactly what it got before: this gateway speaks both
// until no host says 4, then everything marked protocol 4 here goes and
// CALVIN_PROTOCOL_VERSION becomes 5.
export const CALVIN_PROTOCOL_VERSION = 4;
/** The first host protocol that has the session API (work 084). */
export const CALVIN_API_PROTOCOL = 4;
/** The first host protocol whose model routes are profiles (work 097); a `welcome` says it only to such a host. */
export const CALVIN_MODEL_PROTOCOL = 5;

export type SecretScope = "session" | "user" | "workspace";

/** What a runner gets: an environment variable, or a file whose path is in the variable. */
export interface SessionSecret {
  name: string;
  value: string;
  scope: SecretScope;
  file?: boolean;
  /** A variable (`!var`): not secret, so the runner never redacts it. Older runners redact it like a secret. */
  variable?: boolean;
}

/** A session's request_secret: the gateway posts a button in its thread. */
export interface SecretRequest {
  name: string;
  reason: string;
  file?: boolean;
}

export interface CalvinPerson {
  /**
   * The member's Slack id. Work 084: an `opc`-only person has none; the gateway then sends
   * `slackUserId: ""` to a v3 host (which never runs such a session) and omits it for v4.
   */
  slackUserId: string;
  /** Work 084: the member, `usr_…` (the API's Person.id, the wire's member). */
  userId?: string;
  name?: string;
  email?: string;
  /** /data/people/<dir>: `slack-<id>` for a Slack person, `user-<id>` for one without (work 084). */
  dir: string;
  gitName: string;
  gitEmail: string;
}

export type CalvinMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface CalvinSessionSpec {
  /** Internal runner key: `team:channel:ts` for a Slack thread; work 084: the `cs_` id for a session with no thread. Never on the API. */
  key: string;
  /** Work 084: `api` for a session with no Slack binding. */
  kind: "thread" | "channel" | "api";
  /** Absent for `kind: "api"` (work 084: the runner renders nowhere); always set for Slack sessions. */
  channel?: string;
  /** Work 084: the public id, `cs_` + 16. */
  sessionId?: string;
  /** Work 084: where the session started, for the API (`slack | opc | dashboard | api`). */
  origin?: { type: string; client?: string };
  metadata?: Record<string, string>;
  threadTs?: string;
  owner: CalvinPerson;
  teamId?: string;
  title: string;
  mode: CalvinMode;
  model?: string;
  /** Work 084: the session's reasoning effort, as calvin persists it; absent = the default. */
  effort?: string;
  /** The session's speed, as calvin persists it; absent = the default (fast). */
  speed?: "fast" | "standard";
  sdkSessionId?: string;
  forkPath?: string;
  /**
   * Work 082: which agent runs the session's turns. Absent = claude. Set to
   * `codex` only with a `chatgpt` subscription route; a managed route never
   * carries it.
   */
  harness?: CalvinHarness;
}

/** Work 082: the agent a session runs. */
export type CalvinHarness = "claude" | "codex";

/** A Slack file as the event carries it; the runner downloads it with the bot token. */
export interface CalvinSlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface CalvinDelivery {
  userId: string;
  text: string;
  ts: string;
  files?: CalvinSlackFile[];
  mentioned?: boolean;
  /** Slack threads linked in the message (work 049 L3, threads.ts): read, or why not. */
  linked?: Linked[];
}

/**
 * Telemetry trace context (work 054; calvin src/protocol.ts `TraceContext`):
 * minted per Slack message at `message.received`, kept in the Slack queue and
 * dispatch payloads, and sent on `deliver`. The host adds its own stamps
 * before forwarding to the runner. Optional everywhere: older hosts ignore it
 * and the protocol version is unchanged.
 */
export interface CalvinTraceContext {
  /** trace_id, UUIDv7. */
  id: string;
  /** ms since epoch: the frontend's own time for the message (Slack ts × 1000). */
  sentAt: number;
  /** Gateway wall clock at message.received. */
  receivedAt: number;
  /** Gateway wall clock when this delivery was sent to the host. */
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
  // Added by the host before forwarding to the runner:
  path?: "warm" | "new" | "resume" | "prewarmed";
  hostReceivedAt?: number;
  runnerReadyAt?: number;
  forkMs?: number;
  launchMs?: number;
}

export interface CalvinHostCredentials {
  slackBotToken: string;
  slackBotUserId: string;
  teamId?: string;
  claudeOAuthToken?: string;
  /** Protocol 4 only, with `anthropicBaseUrl`: at 5 the key travels in a route's `vars` (`models`). */
  anthropicApiKey?: string;
  /**
   * Where `anthropicApiKey` is spent, when not Anthropic: the organization's
   * managed OpenRouter key comes with `https://openrouter.ai/api` (work 052,
   * model-key.ts). Calvin sets ANTHROPIC_BASE_URL for its runners from it.
   */
  anthropicBaseUrl?: string;
}

export type CalvinSessionStatus = "starting" | "idle" | "busy" | "stopped" | "error";

export interface CalvinSessionReport {
  key: string;
  /** Work 084: the `cs_` id, when the session has one. */
  sessionId?: string;
  status: CalvinSessionStatus;
  sdkSessionId?: string;
  forkPath?: string;
  runnerVersion?: string;
  model?: string;
  mode?: CalvinMode;
  /** The session's speed as the runner has it (a `!speed` change included); absent = unchanged. */
  speed?: "fast" | "standard";
  error?: string;
  /** Work 084: running subagents (absent = 0); the host never idle-exits a runner with any. */
  subagents?: number;
}

export interface CalvinGitHubToken {
  token: string;
  expiresAt: string;
  /** An OpenComputer key's API URL (`kind: "opencomputer"`). */
  apiUrl?: string;
  /** The automations repository's git remote and basic-auth user (`kind: "automation-repo"`). */
  remoteUrl?: string;
  username?: string;
}

/** One repository of a workspace definition (calvin `WorkspaceRepo`). */
export interface WorkspaceRepo {
  name: string;
  /** HTTPS clone URL, no credentials. */
  remote: string;
  branch?: string;
  /**
   * Calvin work 056: `lazy` is cloned only when a session checks it out
   * (`checkout_repo`); `eager` (the default) in the background. Older hosts
   * ignore it and the metadata below, which feeds the fork's repository index.
   */
  clone?: "eager" | "lazy";
  description?: string;
  language?: string;
  pushedAt?: string;
}

/**
 * The organization's workspace definition, sent in `welcome` (calvin
 * `WorkspaceDefinition`, the shape of definitions/opencomputer.json). The host
 * uses it instead of SP_DEFINITION; absent means "no change".
 */
export interface WorkspaceDefinition {
  name?: string;
  about?: string;
  repos: WorkspaceRepo[];
  /** Workspace-root path → source path relative to the release's definitions/ directory. */
  rootFiles?: Record<string, string>;
}

export type CalvinGatewayToHost =
  | {
      t: "welcome";
      protocol: number;
      credentials: CalvinHostCredentials;
      people: CalvinPerson[];
      definition?: WorkspaceDefinition;
      /** Work 054: a signed credential for the telemetry collector, renewed on every hello. Absent: keep the current one. */
      telemetryCredential?: string;
      /** The collector base URL, with the credential; for hosts whose host.env has none. */
      telemetryUrl?: string;
      /** Work 074: this computer's previews. Absent: its tunnel is not provisioned yet; keep cloudflared stopped. */
      preview?: CalvinPreviewConfig;
      /** Work 084: the relay's edge key. Absent: the wire is off on this computer. */
      wire?: CalvinWireConfig;
      /** Protocol 5: the route of a session whose own delivery carries none, by harness. */
      models?: Partial<Record<CalvinHarness, ModelRoute>>;
    }
  /** Work 074: the previews config changed (tunnel provisioned, a port registered or released). Sent before the `previewed` it causes. */
  | { t: "previews"; preview: CalvinPreviewConfig }
  | { t: "people"; people: CalvinPerson[] }
  /** Protocol 5: `models` replaces the whole map of the `welcome`. */
  | { t: "credentials"; credentials: CalvinHostCredentials; models?: Partial<Record<CalvinHarness, ModelRoute>> }
  | {
      t: "deliver";
      id: string;
      session: CalvinSessionSpec;
      msg: CalvinDelivery;
      credentials?: CalvinHostCredentials;
      secrets?: SessionSecret[];
      trace?: CalvinTraceContext;
      /**
       * Work 077: the session's model route. Absent = managed (older gateways); never `refuse` (a refused delivery is not sent).
       * Protocol 5: absent = `models[harness]`.
       */
      model?: ModelRoute;
      /** Work 084: the log's epoch and the last seq the SessionLog holds; the writer continues at lastSeq + 1. */
      epoch?: number;
      lastSeq?: number;
    }
  | { t: "secrets"; sessionKey: string; secrets: SessionSecret[] }
  /** Work 077: a live session's model route changed. The host ignores sessions it does not run. */
  | { t: "model"; sessionKey: string; model: ModelRoute }
  /**
   * Work 077: check a Claude setup token through the host's model proxy; answered by `probed`.
   * Work 082 adds `provider` and `accountId` (absent: anthropic); blue does not probe chatgpt yet.
   */
  | { t: "probe"; id: string; token: string; provider?: ModelProvider; accountId?: string }
  | { t: "action"; id: string; sessionKey: string; promptId: string; value: string; userId: string }
  | { t: "stop"; id: string; sessionKey: string }
  | { t: "token"; id: string; result?: CalvinGitHubToken; error?: string }
  | { t: "spawned"; id: string; result?: CalvinSpawnResult; error?: string }
  /** Work 074: answers `preview` and `unpreview`; `error` is a sentence for the model. */
  | { t: "previewed"; id: string; result?: CalvinPreviewResult; error?: string }
  | { t: "secret-asked"; id: string; error?: string }
  /** Work 080: answers `connection-request` once the button is posted. */
  | { t: "connection-asked"; id: string; error?: string }
  /** Answers to `read` and `post` (work 049 L3); a refused read is a result with `ok: false`. */
  | { t: "thread"; id: string; result?: Linked; error?: string }
  | { t: "posted"; id: string; result?: CalvinPostThreadResult; error?: string }
  /**
   * Warm pool (work 052): a pool computer was claimed by an organization.
   * The host persists the new identity (organization id, host token, the
   * organization's gateway URL) and reconnects with it; its next `hello`
   * arrives at the organization's object.
   */
  | { t: "assign"; organizationId: string; hostToken: string; gatewayUrl: string }
  | CalvinGatewayToHostV4
  | CalvinGatewayToHostV5;

export type CalvinHostToGateway =
  /** `features`: what this host can do; `model-proxy` (work 077) means subscription routes may go to it. */
  /** `journals` (work 084): every session journal on the host's disk, so the gateway sends `epoch` for the ones it is ahead on. */
  /** `profiles` (protocol 5): the model proxy's, while the host is connected to it; a change re-sends the hello. */
  | {
      t: "hello";
      protocol: number;
      hostId: string;
      version: string;
      sessions: CalvinSessionReport[];
      features?: string[];
      journals?: CalvinJournalReport[];
      profiles?: ModelProfile[];
    }
  | { t: "session"; report: CalvinSessionReport }
  | { t: "workspace"; status: unknown }
  /** `/data`'s size and free space, every 5 minutes (work 071): the disk grows near capacity (disk-growth.ts). */
  | { t: "disk"; totalBytes: number; freeBytes: number }
  /**
   * `kind` "opencomputer" asks for a one-hour OpenComputer key, "automation-repo"
   * for a one-hour push credential to the organization's automations
   * repository (work 067); GitHub otherwise.
   */
  | {
      t: "token";
      id: string;
      sessionKey?: string;
      repos?: string[];
      kind?: "github" | "opencomputer" | "automation-repo";
    }
  | { t: "spawn"; id: string; from: string; req: CalvinSpawnRequest }
  /** Work 074: register a port's public URL (`preview` tool), or release a name (`unpreview`). */
  | { t: "preview"; id: string; from: string; req: CalvinPreviewRequest }
  | { t: "unpreview"; id: string; from: string; req: { name: string } }
  | { t: "secret-request"; id: string; from: string; req: SecretRequest }
  /** Work 080: request_connection, a "Grant …" button in the session's thread. */
  | { t: "connection-request"; id: string; from: string; req: { service: string; reason: string } }
  | { t: "read"; id: string; from: string; req: CalvinReadThreadRequest }
  | { t: "post"; id: string; from: string; req: CalvinPostThreadRequest }
  /** The model provider refused session `sessionKey`'s turn for credits (a 402). */
  | { t: "out-of-credits"; sessionKey: string }
  | { t: "reply"; id: string; ok: boolean; error?: string }
  /** Work 077: the model proxy's answers and reports, relayed by the host. */
  | { t: "probed"; id: string; result?: { status: number; usage?: ModelUsage }; error?: string }
  /** Protocol 4: `subscription` or `managed`, with `fingerprint`. Protocol 5: `profile`, with `profile` and `key`. `refuse` in both. */
  | { t: "model-bound"; sessionKey: string; mode: "subscription" | "managed" | "profile" | "refuse"; fingerprint?: string; profile?: string; key?: string }
  | {
      t: "model-health";
      sessionKey: string;
      fingerprint: string;
      /** Work 082: whose upstream answered (absent: anthropic). For chatgpt, `unauthorized` asks blue for a refresh. */
      provider?: ModelProvider;
      status: "ok" | "limited" | "unauthorized" | "error";
      /** Epoch ms. */
      limitedUntil?: number;
      errorClass?: string;
      usage?: ModelUsage;
    }
  | { t: "model-denied"; sessionKey: string; model: string; fallbackTo: string }
  | CalvinHostToGatewayV4
  | CalvinHostToGatewayV5;

/** Work 082: whose subscription a route spends. */
export type ModelProvider = "anthropic" | "chatgpt";

/**
 * Work 077: which model credential a session's turns use. `subscription`
 * carries a member's Claude setup token (only to a host whose hello lists
 * `model-proxy`), or (work 082) a ChatGPT access token with its account id
 * (only to a protocol 3 host whose hello lists `model-proxy/chatgpt`; its
 * fingerprint names the owner and account, not the token, so a refreshed
 * token replaces the old one in place); `managed` means the deliver's
 * `credentials`, as before; `refuse` is only ever pushed (`model`), with a
 * sentence for the thread.
 *
 * Protocol 5 (work 097): `profile` or `refuse`, nothing else. `profile` names
 * one of the profiles the host's hello lists and carries the values of its
 * variables. `subscription` is protocol 4's and goes with it. `managed` is
 * never sent at 5: here it still means a session with no route of its own,
 * which the host runs on `models[harness]`.
 */
export type ModelRoute =
  | {
      mode: "subscription";
      /** Absent: anthropic. */
      provider?: ModelProvider;
      owner: string;
      token: string;
      fingerprint: string;
      /** chatgpt: required. */
      accountId?: string;
      maxModel?: string;
    }
  | { mode: "managed" }
  | {
      mode: "profile";
      profile: string;
      /** The profile's variables by name. Credential values: a frame that carries them is never logged. */
      vars: Record<string, string>;
      /** Names the credential without revealing it (model-key.ts `modelKey`, or its author's own name): `[A-Za-z0-9._:-]{1,64}`. */
      key: string;
      owner?: string;
      maxModel?: string;
    }
  | { mode: "refuse"; reason: string };

/** A subscription's usage windows, as the proxy last saw them: percentages, resets in epoch ms. */
export interface ModelUsage {
  fiveHourPct?: number;
  fiveHourReset?: number;
  sevenDayPct?: number;
  sevenDayReset?: number;
}

/**
 * Work 074, preview URLs. The host runs `cloudflared tunnel run` with
 * `tunnelToken` in TUNNEL_TOKEN, and its preview proxy on 127.0.0.1:7070
 * forwards only `ports`, only requests signed with `key` (blue
 * src/previews/auth.ts: `X-Preview-Auth: <expiry ms>.<base64url
 * HMAC-SHA256(key, "<port>|<expiry ms>")>`).
 */
export interface CalvinPreviewConfig {
  tunnelToken: string;
  /** base64url, 32 bytes. */
  key: string;
  ports: number[];
}

export interface CalvinPreviewRequest {
  port: number;
  /** A chosen name (one DNS label); without one the gateway generates one, or returns the port's existing name. */
  name?: string;
}

/** `unpreview` answers with `{ url: "", name, port: 0 }`. */
export interface CalvinPreviewResult {
  url: string;
  name: string;
  port: number;
}

/** A session starts a thread (Calvin work 047, spawn_thread). */
export interface CalvinSpawnRequest {
  task: string;
  /** Workspace-relative path of the Markdown brief. */
  brief: string;
  briefUrl?: string;
  /** Calvin's model tier (`smart`, `fast`, `default`); without one the thread keeps the parent's model. */
  tier?: string;
}

/** read_thread (work 049 L3): a thread link, or a channel and the ts of a message in it. */
export interface CalvinReadThreadRequest {
  url?: string;
  channel?: string;
  ts?: string;
}

/** post_thread: a reply in that thread, in Slack mrkdwn. */
export interface CalvinPostThreadRequest extends CalvinReadThreadRequest {
  text: string;
}

export interface CalvinPostThreadResult {
  ts: string;
  url: string;
}

export interface CalvinSpawnResult {
  key: string;
  url?: string;
}

// ---------------------------------------------------------------- v4 (work 084)
// Mirrors calvin src/protocol-api.ts (gateway ⇄ host part). Bodies (`params`, `result`,
// `event.data`) are the public API's shapes (api-types.ts); here they are opaque.

/** Who acted (API `Actor`). */
export interface CalvinApiActor {
  id: string;
  name: string | null;
  /** `slack | opc | dashboard | api | system`; open. */
  via: string;
  client: string | null;
}

/** An API error body as the writer returns it: `code` from errors.mdx, `status` its HTTP status. */
export interface CalvinApiError {
  code: string;
  message: string;
  status: number;
  retryable?: boolean;
  [field: string]: unknown;
}

/** A journal on the host's disk, in `hello.journals`: its file epoch and local last seq. */
export interface CalvinJournalReport {
  sessionId: string;
  /** 0: events with no epoch line yet (an adoption into a new file, torn before its commit record). */
  epoch: number;
  lastSeq: number;
  /** The epoch's first seq (calvin b9de827); blue compares `lastSeq` with the log's ack instead. */
  startSeq?: number;
}

/** One journal event in the public envelope (API `Event`). */
export interface CalvinJournalEvent {
  id: string;
  seq: number;
  createdAt: string;
  sessionId: string;
  turnId: string | null;
  type: string;
  actor: CalvinApiActor | null;
  data: unknown;
}

/** Who may attach to a session; `members: null` is every member of the organization. */
export interface CalvinSessionAccess {
  sessionId: string;
  owner: string;
  members: string[] | null;
  /** The organization's admins (`usr_…`), who may also open terminals in the session; attaching follows `members`. */
  admins?: string[];
}

export type CalvinApiSessionStatus = "starting" | "running" | "waiting" | "idle" | "suspended";

export interface CalvinWireConfig {
  /** base64url, 32 bytes: verifies X-Wire-Auth. Today the previews key. */
  key: string;
}

export type CalvinGatewayToHostV4 =
  /** Claim and fork for `session` with no input; answered by `started`. */
  | {
      t: "start";
      id: string;
      session: CalvinSessionSpec;
      epoch: number;
      lastSeq: number;
      credentials?: CalvinHostCredentials;
      secrets?: SessionSecret[];
      model?: ModelRoute;
    }
  /** An HTTP route's operation, named by its WebSocket method; answered by `api-result` (15 s here). */
  | {
      t: "api";
      id: string;
      sessionId: string;
      method: string;
      params: unknown;
      actor: CalvinApiActor;
      member: string;
      idempotencyKey?: string;
      requestId?: string;
      session?: CalvinSessionSpec;
      epoch?: number;
      lastSeq?: number;
    }
  /** The SessionLog stored every event of `epoch` up to `seq`. */
  | { t: "journal-ack"; sessionId: string; epoch: number; seq: number }
  /**
   * The only frame that moves a session's epoch on a host (recovery-fix.md): the log is at `epoch`,
   * begun at `startSeq`; `tail` is every stored event `startSeq..lastSeq`, verbatim (≤ 1000). Sent
   * after a recovery, after `hello` for each listed journal the log is ahead of, and on a
   * `stale_epoch` batch (≤ once per session per 5 s). Before any other frame carrying that epoch.
   */
  | { t: "epoch"; sessionId: string; epoch: number; startSeq: number; lastSeq: number; tail: CalvinJournalEvent[] }
  | { t: "access"; access: CalvinSessionAccess }
  | { t: "revoked"; keyId: string };

export type CalvinHostToGatewayV4 =
  | { t: "started"; id: string; sessionId: string; status: CalvinApiSessionStatus; error?: CalvinApiError }
  | { t: "api-result"; id: string; result?: unknown; error?: CalvinApiError }
  /** The mirror: the next events of `sessionId` under `epoch`, in seq order, at least once. */
  | { t: "journal"; sessionId: string; epoch: number; events: CalvinJournalEvent[] }
  /**
   * Blue's proposal (subagents.md; requests-calvin.md): the latest `subagent.progress` values of a
   * session's running subagents, folded by the host, at most once a second per session. Never
   * journaled; the SessionLog merges them into reads. A host that never sends it leaves reads at
   * the started/ended values.
   */
  | { t: "subagent-progress"; sessionId: string; epoch: number; progress: Array<{ subagentId: string; activity: string | null; toolCalls: number; tokens: number }> }
  /**
   * A send the host's writer queued for a session the host has no spec of (none came since it booted):
   * answered with `start`, as for a session created without a message. Ignored for an unknown session.
   */
  | { t: "wake"; sessionId: string };

// ---------------------------------------------------------------- v5 (work 097)
// Mirrors calvin src/protocol.ts at 5 (design C2). The gateway knows a profile by its name and
// the harnesses it serves; everything else about it is the proxy's configuration.

/** A profile as the proxy's hello lists it; the host forwards it unread. */
export interface ModelProfile {
  name: string;
  /** Names of the variables a route must carry. */
  vars: string[];
  /** harness → what that harness's adapter needs. Opaque here: only the harness names are read. */
  harness: Partial<Record<CalvinHarness, unknown>>;
}

/**
 * The proxy's report of what an upstream answered on a credential, relayed by the host unread: a
 * status with the headers the profile reports and the start of an error body, or a transport
 * error's class. The proxy limits how often it arrives. `body` is upstream text: parsed, never
 * logged, never shown.
 */
export interface ModelObserved {
  sessionKey: string;
  key: string;
  profile: string;
  status?: number;
  /** Lower-case name → value. */
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

/** A request of the gateway's own through a profile, with the credential in `vars`; answered by `model-response`. */
export interface ModelRequest {
  id: string;
  profile: string;
  vars: Record<string, string>;
  method: string;
  /** One of the profile's routes. */
  path: string;
  /** The raw query string, without the `?`. */
  query?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** `error`: the proxy's own code, `proxy_unavailable`, or `timeout` when the host gave up waiting. */
export interface ModelResponse {
  id: string;
  status?: number;
  /** Lower-case name → value. */
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

export type CalvinGatewayToHostV5 = { t: "model-request" } & ModelRequest;

export type CalvinHostToGatewayV5 = ({ t: "model-observed" } & ModelObserved) | ({ t: "model-response" } & ModelResponse);

/** The app's name in git, the author until a person's name is known. */
export const COMPUTER_GIT_NAME = "Computer";

/**
 * Every Slack user maps to one directory and git identity on the computer.
 * Commits name the person who asked, via Computer, with their Slack email
 * (GitHub links it to their profile when they verified it there); just
 * Computer and a no-reply address until Slack has told us.
 */
export function personFor(slackUserId: string, slack: { name?: string; email?: string; userId?: string } = {}): CalvinPerson {
  return {
    slackUserId,
    ...(slack.userId ? { userId: slack.userId } : {}),
    dir: `slack-${slackUserId.toLowerCase()}`,
    gitName: slack.name ? `${slack.name} via Computer` : COMPUTER_GIT_NAME,
    gitEmail: slack.email || noReplyGitEmail(slackUserId),
  };
}

/**
 * Work 084: a member with no Slack identity (an `opc` user). Their directory is
 * `user-<id>`, so it can never collide with a `slack-<id>` one.
 */
export function personForMember(userId: string, member: { name?: string; email?: string } = {}): CalvinPerson {
  const slug = userId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return {
    slackUserId: "",
    userId,
    ...(member.name ? { name: member.name } : {}),
    ...(member.email ? { email: member.email } : {}),
    dir: `user-${slug}`,
    gitName: member.name ? `${member.name} via Computer` : COMPUTER_GIT_NAME,
    gitEmail: member.email || `${slug}@users.noreply.opencomputer.dev`,
  };
}

export function noReplyGitEmail(slackUserId: string): string {
  return `${slackUserId.toLowerCase()}@users.noreply.opencomputer.dev`;
}

/** `team:channel:threadTs`, as dash-cal keys its runners. */
/** A computer session's id in the managed-agent session index: unique beside serverless agent session ids. */
export function computerSessionId(key: string): string {
  return `computer:${key}`;
}

export function sessionKey(teamId: string, channelId: string, threadTs: string): string {
  return `${teamId}:${channelId}:${threadTs}`;
}

export function parseSessionKey(key: string): { teamId: string; channelId: string; threadTs: string } | null {
  const [teamId, channelId, threadTs, extra] = key.split(":");
  if (!teamId || !channelId || !threadTs || extra !== undefined) return null;
  return { teamId, channelId, threadTs };
}

/** A prompt button the runner posted: `p:<base64url(sessionKey)>:<promptId>:<value>`. */
export function decodeCalvinActionId(actionId: string): { sessionKey: string; promptId: string; value: string } | null {
  const match = actionId.match(/^p:([A-Za-z0-9_-]+):([^:]+):(.*)$/);
  if (!match?.[1] || !match[2] || match[3] === undefined) return null;
  const encoded = match[1].replace(/-/g, "+").replace(/_/g, "/");
  try {
    return { sessionKey: atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), promptId: match[2], value: match[3] };
  } catch {
    return null;
  }
}
