// ModelAccess (work 097, 6b): the one interface behind which the hosted
// "subscription routing" lives, as the ComputerDurableObject sees it.
//
// The Durable Object routes every session's turns through `models`, answers
// the dashboard's agent routes through `agents`, mints and redeems connect
// codes through `codes`, and, when `slack` is present, handles the `!claude`,
// `!codex` and `!link` commands with their modals and buttons. Behind the
// interface stand six modules (model-subscriptions.ts,
// model-subscriptions-store.ts, model-subscriptions-slack.ts,
// agent-connect.ts, connect-codes.ts and token-check.ts), composed in
// model-access-impl.ts; that file and those modules are the overlay the
// deploy repo replaces at build time. The public build composes
// `noModelAccess()`: every session runs on the organization's managed models,
// nothing can be connected, and the Slack commands are not commands at all
// (the text goes to the agent like any other).
//
// Every data type the object or routes.ts needs is defined here, once; the
// six modules import them from here and re-export them from their old paths.

import { sha256Hex } from "./crypto.js";
import { DEFAULT_HARNESS } from "./harnesses.js";
import { MANAGED_MODEL_NAME } from "./model-key.js";
import type { PoolProbeResult } from "./pool.js";
import type { CalvinGatewayToHost, CalvinHarness, ModelObserved, ModelProfile, ModelProvider, ModelResponse, ModelRoute, ModelUsage } from "./protocol.js";
import type { SlackResult } from "./slack.js";
import type { SubscriptionEventName } from "./telemetry/catalog.js";
import type { EventFields } from "./telemetry/emitter.js";

// ------------------------------------------------------------------ subscriptions (model-subscriptions.ts)

export type ModelFallback = "managed" | "none";

/** Derived, never stored (work 077 spec section 1): ok unless paused, invalid, or limited until later. */
export type ModelHealth = "ok" | "paused" | "invalid" | "limited";

/** Why a session's turns do not run on its owner's subscription, or why they are refused. */
export type RouteReason =
  | "subscription"
  | "policy_off"
  | "host_without_proxy"
  | "spawned_by_other"
  | "no_subscription"
  | "owner_not_member"
  | "paused"
  | "invalid"
  | "limited"
  | "poster_not_member";

/** First 12 hex of sha256(token): correlation and display, never reversible. */
export async function tokenFingerprint(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, 12);
}

export const MODEL_VIEW = "calvin_model_subscription";
/** Button action ids: open the connect modal, confirm a disconnect. */
export const CONNECT_ACTION = "mc:connect";
export const DISCONNECT_ACTION = "md:disconnect";
export const MODEL_VIEW_CODEX = "calvin_codex_subscription";
export const CODEX_CONNECT_ACTION = "cx:connect";
export const CODEX_DISCONNECT_ACTION = "cx:disconnect";
/** The largest auth.json accepted; a real one is a few KiB. */
export const CODEX_AUTH_MAX_BYTES = 64 * 1024;

/** The fields of a submitted modal. */
export interface ModelSubmittedView {
  id?: string;
  callback_id?: string;
  private_metadata?: string;
  state?: { values?: Record<string, Record<string, { value?: string | null }>> };
}

export type ClaudeCommand =
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "connect" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "disconnect" }
  | { kind: "enable" }
  | { kind: "disable" }
  | { kind: "fallback"; fallback: ModelFallback }
  | { kind: "bad"; reason: string };

/** `!claude …`, or null when the text is not one. */
export function parseClaudeCommand(text: string): ClaudeCommand | null {
  const [head, sub = "", arg = "", ...rest] = text.trim().split(/\s+/);
  if (head?.toLowerCase() !== "!claude") return null;
  const lower = sub.toLowerCase();
  if (!sub || lower === "status") return { kind: "status" };
  if (rest.length || (arg && lower !== "fallback")) return { kind: "bad", reason: `\`!claude ${lower}\` takes no more words` };
  switch (lower) {
    case "help":
    case "connect":
    case "pause":
    case "resume":
    case "disconnect":
    case "enable":
    case "disable":
      return { kind: lower };
    case "fallback": {
      const fallback = arg.toLowerCase();
      if (fallback === "managed" || fallback === "none") return { kind: "fallback", fallback };
      return { kind: "bad", reason: "use `!claude fallback managed` or `!claude fallback none`" };
    }
    default:
      return { kind: "bad", reason: `unknown command \`${sub}\`` };
  }
}

export type CodexCommand =
  | { kind: "use" }
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "connect" }
  | { kind: "disconnect" }
  | { kind: "bad"; reason: string };

/** `!codex …`, or null when the text is not one. Bare `!codex` switches the thread it is said in to Codex (new threads follow the person's choice, agent-connect.ts `harnessFor`). */
export function parseCodexCommand(text: string): CodexCommand | null {
  const [head, sub = "", ...rest] = text.trim().split(/\s+/);
  if (head?.toLowerCase() !== "!codex") return null;
  const lower = sub.toLowerCase();
  if (!sub) return { kind: "use" };
  if (rest.length) return { kind: "bad", reason: `\`!codex ${lower}\` takes no more words` };
  switch (lower) {
    case "status":
    case "help":
    case "connect":
    case "disconnect":
    case "off":
      return { kind: lower };
    default:
      return { kind: "bad", reason: `unknown command \`${sub}\`` };
  }
}

export type LinkCommand = { kind: "help" } | { kind: "link"; code: string } | { kind: "bad"; reason: string };

/** `!link …`, or null when the text is not one. */
export function parseLinkCommand(text: string): LinkCommand | null {
  const [head, arg = "", ...rest] = text.trim().split(/\s+/);
  if (head?.toLowerCase() !== "!link") return null;
  if (!arg || arg.toLowerCase() === "help") return rest.length ? { kind: "bad", reason: "`!link help` takes no more words" } : { kind: "help" };
  if (rest.length) return { kind: "bad", reason: "`!link` takes one code" };
  return { kind: "link", code: arg };
}

// ------------------------------------------------------------------ the store (model-subscriptions-store.ts)

export interface ModelSession {
  key: string;
  ownerId: string;
  channelId: string;
  threadTs: string;
  /** `starting`, `idle` or `busy`; absent from a seam that doesn't say. */
  status?: string;
  /** When the thread last had a turn or changed status (ms); absent from a seam that doesn't say. */
  activeAt?: number;
}

/** A session's route and why. `route.mode === "refuse"` is never delivered, only pushed. */
export interface ResolvedRoute {
  route: ModelRoute;
  reason: RouteReason;
}

/** What a route does with an expired ChatGPT access token whose refresh is running. */
export type ExpiredToken = "wait" | "go" | "defer";

export interface HealthReport {
  fingerprint: string;
  status: string;
  /** Protocol 3: whose seat the fingerprint is. */
  provider?: ModelProvider;
  limitedUntil?: number;
  errorClass?: string;
  usage?: ModelUsage;
}

export type ProbeOutcome = { status: number; usage?: ModelUsage } | { error: string };

// ------------------------------------------------------------------ the person's agent (agent-connect.ts, token-check.ts)

/** Where a token check ran: the organization's host, a pool computer, or nowhere. */
export type ProbeVia = "own" | "pool" | "none";

export const WEB_OWNER_PREFIX = "web:";
export const webOwner = (userId: string) => `${WEB_OWNER_PREFIX}${userId}`;

export const AGENT_CHOICES = ["claude", "codex", "credits"] as const;
export type AgentChoice = (typeof AGENT_CHOICES)[number];

/** `unchecked`: stored but never confirmed by Anthropic (dashboard only; Slack shows such a row as ok). */
export type AgentHealth = ModelHealth | "unchecked";

/** `agent` in GET /v1/computer (work 081, API). Usage figures stay off this org-scoped body. */
export type AgentSubscriptionView = { provider: "claude" | "codex"; health: AgentHealth; limitedUntil?: string; setAt: string; plan?: string };

export interface AgentView {
  choice: AgentChoice | null;
  linked: boolean;
  linkedSlackUser?: { id: string; name: string; teamName: string };
  /** The row of the agent chosen (else the Claude one, else the ChatGPT one). `plan`: codex only, from the token's claims. */
  subscription: AgentSubscriptionView | null;
  /** Every provider's row, connected or not, so the dashboard shows each (work 083). */
  subscriptions: { claude: AgentSubscriptionView | null; codex: AgentSubscriptionView | null };
  managedModel: string;
  /** The harnesses this computer can run, so the ones a login can be connected for (work 082, harnesses.ts). */
  harnesses: CalvinHarness[];
}

export type AgentError = { status: number; code: string; message: string };
export type ConnectResult = { ok: true; agent: AgentView; verified: boolean; via: ProbeVia } | ({ ok: false } & AgentError);
export type CodexConnectResult = { ok: true; agent: AgentView } | ({ ok: false } & AgentError);

/** The dashboard's error copy lives in the web; these are for logs and API callers. */
export const AGENT_ERRORS = {
  format: { status: 422, code: "computer_agent_token_format", message: "That's not a setup token. It starts with sk-ant-oat01-." },
  rejected: { status: 422, code: "computer_agent_token_rejected", message: "Anthropic did not accept that token. Run claude setup-token again and paste the new one." },
  rateLimited: { status: 429, code: "computer_agent_rate_limited", message: "Too many tries. Wait a few minutes." },
  alreadyConnected: { status: 409, code: "computer_agent_already_connected", message: "Another member already connected a subscription for this organization" },
  connectInSlack: { status: 409, code: "computer_agent_connect_in_slack", message: "Connect from Slack: !claude connect" },
  disabled: { status: 403, code: "computer_agent_disabled", message: "Your workspace admin turned this off" },
  codexAuth: { status: 422, code: "computer_agent_codex_auth", message: "That's not a ChatGPT login: paste the auth.json `codex login` wrote." },
  notMember: { status: 403, code: "computer_agent_not_member", message: "Only full members of the linked Slack workspace can connect a subscription" },
  linkNotNeeded: { status: 409, code: "computer_agent_link_not_needed", message: "Nothing to link: Slack isn't connected, or you are linked already" },
} as const satisfies Record<string, AgentError>;

/**
 * Whom a token is for: a dashboard user (the dashboard's PUTs, a code minted
 * there), or a Slack user who asked in Slack and may have no dashboard
 * identity (a code minted by `!claude connect` or `!codex connect`, work 083).
 */
export type Person = { dashboard: string } | { slack: string };

// ------------------------------------------------------------------ connect codes (connect-codes.ts)

/** Where a code was minted. */
export type ConnectCodeVia = "dashboard" | "slack";
/** What a code does: store a login (`connect`), or link a Slack user to the dashboard user who minted it (`link`). */
export type ConnectCodePurpose = "connect" | "link";
/** The CLI names the harness (harnesses.ts HARNESSES) whose login it brings. */
export type RedeemInput = { provider: CalvinHarness; token?: unknown; authJson?: unknown };
export type RedeemResult = { ok: true; provider: CalvinHarness } | ({ ok: false } & AgentError);
/** Why a code was refused (logs and telemetry only; the caller always hears CONNECT_CODE_INVALID). */
export type RefusalReason = "malformed" | "other_org" | "unknown" | "expired" | "wrong_purpose";
/** Why `!link` failed (logs and telemetry; the Slack user hears one answer). */
export type LinkRefusal = "malformed" | "unknown" | "expired" | "wrong_purpose" | "not_member";
export type LinkResult = { ok: true; replaced: boolean } | { ok: false; reason: LinkRefusal };
/** A minted code, or why none was (the public build refuses every one). */
export type MintResult = { ok: true; code: string; expiresAt: number } | ({ ok: false } & AgentError);

// ------------------------------------------------------------------ Slack (model-subscriptions-slack.ts)

/** Where a command or click came from. */
export interface ModelContext {
  userId: string;
  channelId?: string;
  threadTs?: string;
  /** The session the thread runs, when it is one. */
  session?: { key: string; ownerId: string };
}

// ------------------------------------------------------------------ the interface

/** Each session's model route, the members' seats, and what the host reports about them. */
export interface ModelAccessModels {
  /** A session's harness from its next turn: Codex (on the owner's ChatGPT seat) or null, back to the default. */
  setHarness(sessionKey: string, harness: CalvinHarness | null): void;
  harness(sessionKey: string): CalvinHarness;
  /** Ask the host's proxy whether Anthropic takes `token`; null when no host with the proxy is connected. */
  probe(token: string, timeoutMs?: number): Promise<ProbeOutcome> | null;
  /** `probed` from the host. */
  probed(id: string, result: { status: number; usage?: ModelUsage } | undefined, error: string | undefined): void;
  /** Remember what the host was told for a session: a delivered route, or a pushed one. */
  noteSent(sessionKey: string, route: ModelRoute): void;
  /** Slack says a person left the workspace, was deactivated or became a guest. */
  memberRemoved(userId: string): Promise<void>;
  /** A spawned session whose spawning turn was not its owner's: never on the owner's seat. */
  markManagedOnly(sessionKey: string): void;
  managedOnly(sessionKey: string): boolean;
  /** A full member of the linked workspace: not a guest, bot, deactivated account or someone from another organization. */
  isMember(userId: string): Promise<boolean>;
  /** Whether the connected host runs the model proxy for `provider` (Claude by default). */
  hostReady(provider?: ModelProvider): boolean;
  /** The host said hello: the live sessions on a seat (or refused) get their routes again; how many were pushed. */
  helloed(sessionKeys: string[]): Promise<number>;
  /** `model-health` from the host. */
  health(report: HealthReport): Promise<void>;
  /** A delivery's route; `expired: "defer"` comes back undefined while an expired ChatGPT token is being refreshed. */
  forDelivery(session: { key: string; ownerId: string }, posterId: string): Promise<ResolvedRoute>;
  forDelivery(session: { key: string; ownerId: string }, posterId: string, expired: ExpiredToken): Promise<ResolvedRoute | undefined>;
  /** The object's "model" alarm. */
  expire(): Promise<void>;
  /** One `subscription.*` telemetry event; never throws. */
  emit<N extends SubscriptionEventName>(name: N, fields: EventFields<N>): void;
  /** `model-denied` from the host: the seat lacks a model; new threads start on `fallbackTo`. */
  denied(owner: string | undefined, fallbackTo: string, provider?: ModelProvider): Promise<void>;
  /** `model-bound` from the host: what the proxy says a session runs on now. At protocol 5 `fingerprint` is the frame's `key`, and `profile` its profile. */
  bound(sessionKey: string, mode: string, fingerprint: string | undefined, profile?: string): void;
  // Protocol 5 (work 097). Optional only while a build may still compose an implementation written for 4.
  /** `model-observed` from the host: what an upstream answered on a session's credential. */
  observed?(observed: ModelObserved): Promise<void>;
  /** `model-response` from the host: the answer to a `model-request` of this implementation's. */
  responded?(response: ModelResponse): void;
}

/** The person's agent from the dashboard (work 081) and the link between a dashboard user and their Slack identity. */
export interface ModelAccessAgents {
  view(user: string): AgentView;
  /** The dashboard user linked to Slack user `slackUserId`, if any. */
  linkOfSlack(slackUserId: string): string | undefined;
  /** The Slack workspace was unlinked: the installer's token goes back to their dashboard id. */
  unrekey(installerUserId: string | undefined): Promise<void>;
  setChoice(user: string, choice: AgentChoice): void;
  resume(user: string): Promise<AgentView>;
  /** The Slack install linked `dashboardUserId` to `installerUserId`: the dashboard token moves to the Slack id. */
  rekey(dashboardUserId: string, installerUserId: string): Promise<void>;
  /** Slack is installed and this dashboard user has no Slack half: they link first (work 083). */
  needsLink(user: string): boolean;
  /** What a new thread of Slack user `owner` runs. */
  harnessFor(owner: string): { harness: CalvinHarness; via: "choice" | "latest" | "none" };
  /** The object's "agent" alarm. */
  expire(): Promise<void>;
  disconnectCodex(user: string): Promise<void>;
  disconnect(user: string): Promise<void>;
  connectCodex(user: string, authJson: unknown): Promise<CodexConnectResult>;
  connect(user: string, rawToken: unknown): Promise<ConnectResult>;
}

/** The one-command connect codes (work 082) and link codes (work 083). */
export interface ModelAccessCodes {
  mint(person: Person, via: ConnectCodeVia, purpose?: ConnectCodePurpose): Promise<MintResult>;
  /** A code that can't be used: logged with why, answered with CONNECT_CODE_INVALID. */
  refuse(reason: RefusalReason, provider?: CalvinHarness): { ok: false } & AgentError;
  redeem(code: string, input: RedeemInput): Promise<RedeemResult>;
  /** `!link <code>` from a Slack user. */
  link(code: string, slackUserId: string): Promise<LinkResult>;
}

/** A subscription command in Slack: the command, its connect modal, the modal's submission, the disconnect button. */
export interface ModelAccessSlackCommands<Command> {
  command(cmd: Command, ctx: ModelContext): Promise<void>;
  open(triggerId: string, ctx: ModelContext): Promise<void>;
  submit(view: ModelSubmittedView, userId: string): Promise<{ errors?: Record<string, string>; view?: Record<string, unknown>; after?: () => Promise<void> }>;
  disconnect(userId: string, respond: (text: string) => Promise<void>): Promise<void>;
}

export interface ModelAccessSlack {
  claude: ModelAccessSlackCommands<ClaudeCommand>;
  codex: ModelAccessSlackCommands<CodexCommand>;
  link: { command(cmd: LinkCommand, ctx: ModelContext): Promise<void> };
}

export interface ModelAccess {
  models: ModelAccessModels;
  agents: ModelAccessAgents;
  codes: ModelAccessCodes;
  /** Undefined: `!claude`, `!codex` and `!link` are not commands; their modals and buttons are not handled. */
  slack?: ModelAccessSlack;
}

/** What the Durable Object gives the implementation: its storage, its Slack and host, and its alarms. */
export interface ModelAccessDeps {
  sql: SqlStorage;
  encryptionKey: () => string | undefined;
  accountId: () => string;
  /** The linked Slack workspace's id, "" when none. */
  teamId: () => string;
  slack(method: string, body: Record<string, unknown>): Promise<SlackResult>;
  /** The harnesses this computer can run (harnesses.ts `computerHarnesses`, from the host's latest recorded hello). */
  harnesses: () => readonly CalvinHarness[];
  /**
   * The connected host's hello `protocol` and `features`, and for a host at protocol 5 the `profiles` its
   * hello listed (undefined there: it never listed any); undefined when no host is connected.
   */
  host(): { protocol: number; features: string[]; profiles?: ModelProfile[] } | undefined;
  /**
   * The organization's managed models as a route the connected host takes: `managed` below protocol 5; at 5
   * the profile route with the organization's key (model-key.ts `managedModelRoute`), which the host also has
   * as `models`. For a session that must be told so, having been sent another route.
   */
  managedRoute(): Promise<ModelRoute>;
  /** A frame to the host; false when none is connected. */
  send(frame: CalvinGatewayToHost): boolean;
  /** The object's alarm for one purpose: `at` arms it, null disarms it. */
  schedule(purpose: "model" | "agent"): (at: number | null) => Promise<void>;
  /** Sessions running now (`starting`, `idle`, `busy`). */
  liveSessions(): ModelSession[];
  /** A runner key of this workspace → its session, if known. */
  session(key: string): ModelSession | undefined;
  directMessage(userId: string, text: string): Promise<boolean>;
  threadUrl(channelId: string, threadTs: string): string | undefined;
  /** The object's `subscription.*` telemetry; may be read lazily (the object builds its telemetry after this). */
  telemetry<N extends SubscriptionEventName>(name: N, fields: EventFields<N>): void;
  /** The linked Slack workspace, if any. */
  slackInstalled(): { installed: boolean; teamName?: string };
  /** The warm pool's token check (pool.ts `poolProbe`); null when no pool is configured. */
  poolProbe(token: string, user: string): Promise<PoolProbeResult> | null;
  /** Runs `fn` in one storage transaction (DurableObjectStorage.transactionSync). */
  transaction<T>(fn: () => T): T;
  /** Keeps `task` running after the caller's request is answered (the object's `ctx.waitUntil`). */
  waitUntil(task: Promise<unknown>): void;
  /** A Slack user's display name, best effort. */
  slackUserName(userId: string): Promise<string | undefined>;
  /** The connect-code routing record in the `computer-connect-codes:<x>` objects (connect-code-index.ts). */
  connectCodeIndex: { put(hash: string, expiresAt: number): Promise<void>; forget(hash: string): Promise<void> };
}

// ------------------------------------------------------------------ the public build

/** What the public build answers wherever a result may say no: nothing can be connected here. */
export const MODEL_ACCESS_UNAVAILABLE = {
  status: 404,
  code: "not_available",
  message: "Subscriptions are not available on this computer; sessions run on the organization's managed models.",
} as const satisfies AgentError;

const unavailable = (): { ok: false } & AgentError => ({ ok: false, ...MODEL_ACCESS_UNAVAILABLE });

/**
 * The public build's ModelAccess, when no overlay is present: every session
 * routes managed (as a member with no subscription does), nothing is
 * connected or connectable, the alarms do nothing, and Slack has no
 * subscription commands. Touches no SQL and creates no table (decision 8).
 */
export function noModelAccess(deps?: Pick<ModelAccessDeps, "harnesses">): ModelAccess {
  const view = (): AgentView => ({
    choice: null,
    linked: false,
    subscription: null,
    subscriptions: { claude: null, codex: null },
    managedModel: MANAGED_MODEL_NAME,
    harnesses: [...(deps?.harnesses() ?? [DEFAULT_HARNESS])],
  });
  const managed = (): ResolvedRoute => ({ route: { mode: "managed" }, reason: "no_subscription" });
  return {
    models: {
      setHarness: () => undefined,
      harness: () => DEFAULT_HARNESS,
      probe: () => null,
      probed: () => undefined,
      noteSent: () => undefined,
      memberRemoved: async () => undefined,
      markManagedOnly: () => undefined,
      managedOnly: () => false,
      isMember: async () => false,
      hostReady: () => false,
      helloed: async () => 0,
      health: async () => undefined,
      forDelivery: async () => managed(),
      expire: async () => undefined,
      emit: () => undefined,
      denied: async () => undefined,
      bound: () => undefined,
      observed: async () => undefined,
      responded: () => undefined,
    },
    agents: {
      view,
      linkOfSlack: () => undefined,
      unrekey: async () => undefined,
      setChoice: () => undefined,
      resume: async () => view(),
      rekey: async () => undefined,
      needsLink: () => false,
      harnessFor: () => ({ harness: DEFAULT_HARNESS, via: "none" }),
      expire: async () => undefined,
      disconnectCodex: async () => undefined,
      disconnect: async () => undefined,
      connectCodex: async () => unavailable(),
      connect: async () => unavailable(),
    },
    codes: {
      mint: async () => unavailable(),
      refuse: () => unavailable(),
      redeem: async () => unavailable(),
      link: async () => ({ ok: false, reason: "unknown" }),
    },
  };
}
