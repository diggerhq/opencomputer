import { Cron } from "croner";

import {
  memoryId,
  memoryProjection,
  type MemoryProjection,
} from "./memory.js";

export type DataValue =
  | null
  | boolean
  | number
  | string
  | readonly DataValue[]
  | { readonly [key: string]: DataValue };

export type InputSource =
  | "user"
  | "channel"
  | "schedule"
  | "webhook"
  | "subagent"
  | "system"
  | "event";

export interface ScheduleRunContext {
  readonly id: string;
  readonly runId: string;
  readonly scheduledAt: string;
  readonly timezone: string;
  readonly attempt: number;
  readonly manual: boolean;
}

export interface WebhookRequestContext {
  readonly id: string;
  readonly requestId: string;
  readonly receivedAt: string;
}

/** The turn outcomes an event subscription delivers. */
export type OutcomeEventType = "turn.completed" | "turn.failed" | "turn.cancelled";

/**
 * A recorded turn outcome of another session in the project, delivered by
 * an event subscription as the input of a new turn. The platform attests
 * where it came from through `source: "event"`; the included agent output
 * is data to reason about, not instructions to follow.
 */
export interface OutcomeEvent {
  /** The source session's own id for its terminal `turn.*` event. */
  readonly id: string;
  readonly type: OutcomeEventType;
  /** The session and turn whose outcome this is. */
  readonly sessionId: string;
  readonly turnId: string;
  /** The agent that ran the source turn. */
  readonly agentId: string;
  readonly occurredAt: string;
  /** Why the turn failed or was cancelled, when the source recorded a reason. */
  readonly reason?: string;
  /** The failure message, bounded, when the turn failed. */
  readonly error?: string;
  /** The final assistant message of a completed turn; `truncated` when it was cut to fit. */
  readonly result?: { readonly text: string; readonly truncated?: boolean };
}

interface BasicAgentInput {
  readonly text?: string;
  readonly payload?: DataValue;
}

export type AgentInput =
  | (BasicAgentInput & {
      readonly source: Exclude<InputSource, "schedule" | "webhook" | "event">;
    })
  | (BasicAgentInput & {
      readonly source: "schedule";
      readonly schedule: Readonly<ScheduleRunContext>;
    })
  | (BasicAgentInput & {
      readonly source: "webhook";
      readonly webhook: Readonly<WebhookRequestContext>;
    })
  | (BasicAgentInput & {
      readonly source: "event";
      readonly event: Readonly<OutcomeEvent>;
    });

export interface ResourceReference {
  readonly id: string;
}

export interface ConnectionReference extends ResourceReference {
  readonly kind: "connection";
}

export interface SecretReference extends ResourceReference {
  readonly kind: "secret";
}

export interface SecretHeaderReference {
  readonly kind: "secret-header";
  readonly secret: SecretReference;
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface HttpConnectionDefinition extends ConnectionReference {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string | SecretHeaderReference>>;
  readonly methods?: readonly string[];
  readonly pathPrefix?: string;
  readonly redirectOrigins?: readonly HttpConnectionRedirectOrigin[];
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface HttpConnectionRedirectOrigin {
  readonly origin: string;
  readonly pathPrefix?: string;
}

export type GitHubAppPermission = "read" | "write";

export interface GitHubAppPermissions {
  readonly contents?: GitHubAppPermission;
  readonly pull_requests?: GitHubAppPermission;
  readonly issues?: GitHubAppPermission;
  readonly checks?: GitHubAppPermission;
  readonly actions?: GitHubAppPermission;
  readonly metadata?: "read";
}

export interface GitHubAppProvider {
  readonly kind: "github-app";
  readonly permissions: Readonly<GitHubAppPermissions>;
}

export interface GitHubConnectionDefinition extends ConnectionReference {
  readonly provider: GitHubAppProvider;
}

export interface McpServerDefinition extends ResourceReference {
  readonly kind: "mcp";
  readonly url: string;
  readonly connection?: ConnectionReference;
}

/**
 * A channel is a conversation the agent takes part in, keyed by an external
 * participant. What differs between providers is transport, addressing, and
 * authentication; what does not differ is that an inbound message continues the
 * conversation it belongs to. Agents see the second part and never the first.
 */
export type ChannelProvider = "slack" | "twilio" | "email";

export type SlackChannelEvent = "app_mention" | "message.im";
/** Providers without a mention/DM distinction have exactly one inbound event. */
export type MessageChannelEvent = "message.inbound";
export type ChannelEvent = SlackChannelEvent | MessageChannelEvent;

export type ChannelTrigger = "mention" | "direct-message" | "message";

export interface ConversationDestination {
  readonly type: "conversation";
  readonly visibility: "public" | "private";
}

/** Reply on the conversation the message arrived on. */
export interface ReplyDestination {
  readonly type: "reply";
}

export type ChannelDestinationDefinition =
  | ConversationDestination
  | ReplyDestination;

interface ChannelDefinitionBase extends ResourceReference {
  readonly kind: "channel";
  readonly version: 1;
  readonly displayName?: string;
  readonly destinations: Readonly<
    Record<string, Readonly<ChannelDestinationDefinition>>
  >;
  readonly routing: {
    readonly whenAmbiguous: "ask";
  };
  /**
   * Agent runtime is billed by wall-clock time, and a conversation spends most
   * of its life waiting for a human. Suspend the runtime this long after the
   * last message; an inbound message resumes it. Without this a channel-backed
   * conversation bills for the hours nobody is typing.
   */
  readonly idle: {
    readonly suspendAfterSeconds: number;
  };
}

export interface SlackChannelDefinition extends ChannelDefinitionBase {
  readonly type: "slack";
  readonly scopes: {
    readonly bot: readonly string[];
  };
  readonly events: readonly SlackChannelEvent[];
}

/**
 * Named for the vendor, as `slack` is, because that is what actually differs:
 * the signature is Twilio's HMAC over the request URL and sorted parameters,
 * and the payload is Twilio's form encoding. A different SMS vendor is a
 * different adapter, not a variant of this one.
 *
 * Twilio WhatsApp rides the same API, webhook, and signature — addresses just
 * carry a `whatsapp:` prefix — so it needs no separate provider.
 *
 * The number itself is not here. It is per-environment operational
 * configuration, bound to a connection in the dashboard, exactly as Slack
 * conversation IDs are.
 */
export interface TwilioChannelDefinition extends ChannelDefinitionBase {
  readonly type: "twilio";
  readonly events: readonly MessageChannelEvent[];
}

/**
 * The address is likewise a per-environment binding, not source: development
 * and production do not share an inbox.
 */
export interface EmailChannelDefinition extends ChannelDefinitionBase {
  readonly type: "email";
  readonly events: readonly MessageChannelEvent[];
}

export type ChannelDefinition =
  | SlackChannelDefinition
  | TwilioChannelDefinition
  | EmailChannelDefinition;

export interface ChannelRegistrationDefinition extends ResourceReference {
  readonly kind: "channel-registration";
  readonly version: 1;
  readonly channelId: string;
  readonly triggers: readonly ChannelTrigger[];
}

export interface OutboxPublishInput {
  readonly type: string;
  readonly content: DataValue;
  readonly idempotencyKey: string;
}

export interface OutboxPublishResult {
  readonly id: string;
  readonly status: "pending" | "delivering" | "delivered" | "failed";
  readonly duplicate: boolean;
}

export interface OutboxDefinition extends ResourceReference {
  readonly kind: "outbox";
  readonly version: 1;
  readonly delivery: {
    readonly channelId: string;
    readonly destination: string;
  };
  publish(input: OutboxPublishInput): Promise<OutboxPublishResult>;
}

export interface OutboxRegistrationDefinition extends ResourceReference {
  readonly kind: "outbox-registration";
  readonly version: 1;
  readonly outboxId: string;
}

export type ScheduleEnvironment = "development" | "production";

export interface ScheduleDefinition extends ResourceReference {
  readonly kind: "schedule";
  readonly version: 1;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: readonly ScheduleEnvironment[];
  readonly overlap: "skip" | "allow";
  readonly dispatch: {
    readonly text?: string;
    readonly payload?: DataValue;
  };
}

function outboxEventType(value: string): string {
  const type = value.trim();
  if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(type)) {
    throw new Error("Outbox event types must use lowercase dot notation");
  }
  return type;
}

export async function publishOutbox(
  outbox: string | ResourceReference,
  input: OutboxPublishInput,
): Promise<OutboxPublishResult> {
  const id = resourceIdentifier(
    typeof outbox === "string" ? outbox : outbox.id,
    "publishOutbox",
  );
  const type = outboxEventType(input.type);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) {
    throw new Error("Outbox idempotency keys must contain 1 to 256 characters");
  }
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const base = runtime.process?.env?.OPENCOMPUTER_OUTBOX_URL;
  const token = runtime.process?.env?.OPENCOMPUTER_OUTBOX_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer outbox delivery is unavailable");
  }
  const response = await fetch(
    `${base.replace(/\/$/, "")}/${encodeURIComponent(id)}/items`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type,
        content: input.content,
        idempotencyKey,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Outbox publish failed with status ${response.status}`);
  }
  return (await response.json()) as OutboxPublishResult;
}

export type ModelSelection =
  | string
  | { readonly provider: string; readonly model: string };

export type ToolInputSchema = Readonly<Record<string, unknown>>;

export interface ToolExecutionContext {
  readonly input: Record<string, unknown>;
  readonly sessionId: string;
  /** The assistant message that emitted this call. */
  readonly messageId: string;
  /** The host-assigned id of this tool call, unique within the session. */
  readonly toolCallId: string;
  readonly agentId: string;
  readonly signal?: AbortSignal;
  reportProgress(metadata: Readonly<Record<string, DataValue>>): Promise<void>;
}

export interface ToolDefinition<
  Output extends DataValue = DataValue,
> extends ResourceReference {
  readonly kind: "tool";
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly input?: ToolInputSchema;
  readonly output?: ToolInputSchema;
  run(context: ToolExecutionContext): Output | Promise<Output>;
}

export type {
  DocumentMemoryInput,
  DocumentMemoryProvider,
  HttpMemoryConnection,
  HttpMemoryInput,
  HttpMemoryProvider,
  HttpMemoryToolDefinition,
  HttpMemoryToolInput,
  MemoryDefinition,
  MemoryDefinitionInput,
  MemoryProjection,
  MemoryProvider,
  MemoryReference,
  MemorySource,
  MemoryToolAccess,
} from "./memory.js";
export { defineMemory, documentMemory, httpMemory } from "./memory.js";

/**
 * Implemented by the host that renders the agent. The host renders inside an
 * isolated worker with a per-render `scope`, sets this object on
 * `globalThis[Symbol.for("opencomputer.agent-hooks")]`, and clears the scope
 * when the render returns. The scope fields each hook reads or writes:
 *
 * - `useInput()` reads `scope.input`.
 * - `useSessionData(key)` reads `scope.state[key]`.
 * - `useTool(id)` adds to `scope.tools`; returned as `enabledTools`.
 * - `useConnection(id)` adds to `scope.connections`; returned as
 *   `requiredConnections` so the host can make the declared connection
 *   available to this render.
 * - `useMemory(id)` reads `scope.memory[id]`, the projection the host
 *   resolved for the session binding with that resource id (absent when the
 *   session has no binding for it), and adds the id to
 *   `scope.selectedMemory`, returned sorted as `selectedMemory` next to
 *   `enabledTools`. The selection is what routes memory tools and their
 *   `memory` argument for the model request this render produced.
 */
interface AgentHooks {
  useInput(): Readonly<AgentInput>;
  useModel(model: ModelSelection): void;
  useTool(tool: string | ResourceReference): void;
  useConnection(connection: string | ResourceReference): void;
  useSubagent(agent: string | ResourceReference): void;
  useSessionData<T extends DataValue>(key: string): T | undefined;
  useMcpServer(server: string | ResourceReference): void;
  useMemory(memory: string): MemoryProjection | undefined;
}

function hooks(): AgentHooks {
  const value = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("opencomputer.agent-hooks")
  ];
  if (!value) {
    throw new Error("OpenComputer hooks can only run while rendering an agent");
  }
  return value as AgentHooks;
}

function identifier(value: string, kind: string): string {
  const id = value.trim();
  if (!id) throw new Error(`${kind} requires a non-empty id`);
  return id;
}

const OPENCOMPUTER_USER_AGENT =
  "OpenComputer-Agent/1 (+https://opencomputer.dev)";

export function useSecret(name: string): SecretReference {
  const id = identifier(name, "useSecret");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(id)) {
    throw new Error(
      "Secret names must use uppercase letters, numbers, and underscores",
    );
  }
  return Object.freeze({ kind: "secret", id });
}

export function secretHeader(
  secret: SecretReference,
  options: { prefix?: string; suffix?: string } = {},
): SecretHeaderReference {
  return Object.freeze({ kind: "secret-header", secret, ...options });
}

export function bearer(secret: SecretReference): SecretHeaderReference {
  return secretHeader(secret, { prefix: "Bearer " });
}

const GITHUB_APP_PERMISSION_KEYS = [
  "actions",
  "checks",
  "contents",
  "issues",
  "metadata",
  "pull_requests",
] as const;

export function githubApp(options: {
  permissions: GitHubAppPermissions;
}): GitHubAppProvider {
  const entries = Object.entries(options?.permissions ?? {});
  if (entries.length === 0) {
    throw new Error("githubApp() requires at least one permission");
  }
  const permissions: Record<string, GitHubAppPermission> = {};
  for (const [name, level] of entries) {
    if (!(GITHUB_APP_PERMISSION_KEYS as readonly string[]).includes(name)) {
      throw new Error(
        `githubApp() does not support the ${name} permission; supported permissions are ${GITHUB_APP_PERMISSION_KEYS.join(", ")}`,
      );
    }
    if (level !== "read" && level !== "write") {
      throw new Error(
        `githubApp() permission ${name} must be "read" or "write"`,
      );
    }
    if (name === "metadata" && level !== "read") {
      throw new Error('githubApp() permission metadata must be "read"');
    }
    permissions[name] = level;
  }
  return Object.freeze({
    kind: "github-app",
    permissions: Object.freeze(permissions),
  });
}

interface HttpConnectionInput {
  id: string;
  origin: string;
  headers?: Readonly<Record<string, string | SecretHeaderReference>>;
  methods?: readonly string[];
  pathPrefix?: string;
  redirectOrigins?: readonly HttpConnectionRedirectOrigin[];
}

interface GitHubConnectionInput {
  id: string;
  provider: GitHubAppProvider;
}

export function defineConnection(
  input: HttpConnectionInput,
): HttpConnectionDefinition;
export function defineConnection(
  input: GitHubConnectionInput,
): GitHubConnectionDefinition;
export function defineConnection(
  input: HttpConnectionInput | GitHubConnectionInput,
): HttpConnectionDefinition | GitHubConnectionDefinition {
  const id = identifier(input.id, "defineConnection");
  if ("provider" in input) {
    if (input.provider?.kind !== "github-app") {
      throw new Error("defineConnection() received an unsupported provider");
    }
    return Object.freeze({ kind: "connection", id, provider: input.provider });
  }
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("Connection origins must be HTTPS origins without a path");
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (
      [
        "api-key",
        "authorization",
        "cookie",
        "proxy-authorization",
        "x-api-key",
      ].includes(name.toLowerCase()) &&
      typeof value === "string"
    ) {
      throw new Error(`${name} must use useSecret()`);
    }
  }
  if ((input.redirectOrigins?.length ?? 0) > 16) {
    throw new Error("Connections may declare at most 16 redirect origins");
  }
  const redirectOrigins = input.redirectOrigins?.map((input) => {
    const redirectOrigin = new URL(input.origin);
    if (
      redirectOrigin.protocol !== "https:" ||
      redirectOrigin.pathname !== "/"
    ) {
      throw new Error(
        "Connection redirect origins must be HTTPS origins without a path",
      );
    }
    if (input.pathPrefix !== undefined && !input.pathPrefix.startsWith("/")) {
      throw new Error("Connection redirect path prefixes must start with /");
    }
    return Object.freeze({
      origin: redirectOrigin.origin,
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    });
  });
  if (
    redirectOrigins &&
    new Set(
      redirectOrigins.map(
        ({ origin, pathPrefix }) => `${origin}\n${pathPrefix ?? ""}`,
      ),
    ).size !== redirectOrigins.length
  ) {
    throw new Error("Connection redirect origin policies must be unique");
  }
  const definition = {
    kind: "connection" as const,
    id,
    origin: origin.origin,
    headers: Object.freeze({ ...(input.headers ?? {}) }),
    ...(input.methods
      ? {
          methods: Object.freeze(
            input.methods.map((method) => method.toUpperCase()),
          ),
        }
      : {}),
    ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    ...(redirectOrigins
      ? { redirectOrigins: Object.freeze(redirectOrigins) }
      : {}),
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const runtime = globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
      };
      const base = runtime.process?.env?.OPENCOMPUTER_CONNECTIONS_URL;
      const token = runtime.process?.env?.OPENCOMPUTER_CONNECTION_TOKEN;
      if (!base || !token) {
        throw new Error("OpenComputer managed egress is unavailable");
      }
      if (!path.startsWith("/")) {
        throw new Error("Connection requests require an absolute path");
      }
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      // Some APIs reject a request that carries no User-Agent — GitHub answers
      // 403 with an empty body, which is undiagnosable from the caller's side.
      // Default one unless the connection or this request already sets it.
      const declaresUserAgent = Object.keys(input.headers ?? {}).some(
        (name) => name.toLowerCase() === "user-agent",
      );
      if (!declaresUserAgent && !("user-agent" in headers)) {
        headers["user-agent"] = OPENCOMPUTER_USER_AGENT;
      }
      const body =
        init.body === undefined || init.body === null
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : (() => {
                throw new Error(
                  "Managed connection request bodies must currently be strings",
                );
              })();
      if (body !== undefined && body.length > 5 * 1024 * 1024) {
        throw new Error(
          "Managed connection request bodies cannot exceed 5 MiB",
        );
      }
      return fetch(
        `${base.replace(/\/$/, "")}/${encodeURIComponent(id)}/fetch`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            method: (init.method ?? "GET").toUpperCase(),
            path,
            headers,
            ...(body === undefined ? {} : { body }),
          }),
          signal: init.signal,
        },
      );
    },
  };
  return Object.freeze(definition);
}

export function defineMcpServer(input: {
  id: string;
  url: string;
  connection?: ConnectionReference;
}): McpServerDefinition {
  const url = new URL(input.url);
  if (url.protocol !== "https:") {
    throw new Error("Managed MCP server URLs must use HTTPS");
  }
  return Object.freeze({
    kind: "mcp",
    id: identifier(input.id, "defineMcpServer"),
    url: url.toString(),
    ...(input.connection ? { connection: input.connection } : {}),
  });
}

const RESOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLACK_SCOPE_PATTERN = /^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/;
const SLACK_EVENT_SCOPE: Readonly<Record<SlackChannelEvent, string>> = {
  app_mention: "app_mentions:read",
  "message.im": "im:history",
};
const TRIGGER_EVENT: Readonly<Record<ChannelTrigger, ChannelEvent>> = {
  mention: "app_mention",
  "direct-message": "message.im",
  message: "message.inbound",
};
const PROVIDER_TRIGGERS: Readonly<
  Record<ChannelProvider, readonly ChannelTrigger[]>
> = {
  slack: ["mention", "direct-message"],
  twilio: ["message"],
  email: ["message"],
};
// Suspend quickly by default. A resume costs a moment; an idle runtime costs
// for every second nobody is typing, and on SMS or email that is most of them.
const DEFAULT_IDLE_SUSPEND_SECONDS = 300;

function resourceIdentifier(value: string, kind: string): string {
  const id = identifier(value, kind);
  if (!RESOURCE_ID_PATTERN.test(id)) {
    throw new Error(
      `${kind} IDs must use lowercase letters, numbers, and single hyphens`,
    );
  }
  return id;
}

function schedulePayload(value: DataValue | undefined): DataValue | undefined {
  if (value === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Schedule payloads must be JSON-compatible");
  }
  if (serialized === undefined || serialized.length > 32 * 1024) {
    throw new Error(
      "Schedule payloads must be JSON-compatible and at most 32 KiB",
    );
  }
  return JSON.parse(serialized) as DataValue;
}

export function defineSchedule(input: {
  id: string;
  cron: string;
  timezone?: string;
  enabled?: readonly ScheduleEnvironment[];
  overlap?: "skip" | "allow";
  dispatch: {
    text?: string;
    payload?: DataValue;
  };
}): ScheduleDefinition {
  const id = resourceIdentifier(input.id, "defineSchedule");
  const cron = input.cron.trim().replace(/\s+/g, " ");
  if (cron.split(" ").length !== 5) {
    throw new Error(
      "Schedule cron expressions must contain exactly five fields",
    );
  }
  const timezone = input.timezone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Schedule ${id} has an invalid IANA timezone`);
  }
  try {
    new Cron(cron, { timezone, paused: true });
  } catch {
    throw new Error(`Schedule ${id} has an invalid cron expression`);
  }
  const enabled = [
    ...new Set(input.enabled ?? ["production"]),
  ] as ScheduleEnvironment[];
  if (
    !enabled.length ||
    enabled.some(
      (environment) =>
        environment !== "development" && environment !== "production",
    )
  ) {
    throw new Error(
      "Schedule enabled environments must contain development or production",
    );
  }
  const text = input.dispatch.text?.trim();
  const payload = schedulePayload(input.dispatch.payload);
  if (!text && payload === undefined) {
    throw new Error("Schedule dispatch requires text or payload");
  }
  return Object.freeze({
    kind: "schedule" as const,
    version: 1 as const,
    id,
    cron,
    timezone,
    enabled: Object.freeze(enabled),
    overlap: input.overlap ?? "skip",
    dispatch: Object.freeze({
      ...(text ? { text } : {}),
      ...(payload === undefined ? {} : { payload }),
    }),
  });
}

interface ChannelInputBase {
  id: string;
  displayName?: string;
  destinations?: Readonly<Record<string, ChannelDestinationDefinition>>;
  routing?: { whenAmbiguous?: "ask" };
  idle?: { suspendAfterSeconds?: number };
}

export interface SlackChannelInput extends ChannelInputBase {
  type: "slack";
  scopes: { bot: readonly string[] };
  events?: readonly SlackChannelEvent[];
}

export interface TwilioChannelInput extends ChannelInputBase {
  type: "twilio";
}

export interface EmailChannelInput extends ChannelInputBase {
  type: "email";
}

export type ChannelInput =
  | SlackChannelInput
  | TwilioChannelInput
  | EmailChannelInput;

function channelCommon(input: ChannelInputBase): {
  id: string;
  displayName?: string;
  routing: { whenAmbiguous: "ask" };
  idle: { suspendAfterSeconds: number };
} {
  const id = resourceIdentifier(input.id, "defineChannel");
  const seconds =
    input.idle?.suspendAfterSeconds ?? DEFAULT_IDLE_SUSPEND_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86_400) {
    throw new Error(
      "Channel idle.suspendAfterSeconds must be a whole number of seconds between 30 and 86400",
    );
  }
  return {
    id,
    ...(input.displayName?.trim()
      ? { displayName: input.displayName.trim() }
      : {}),
    routing: { whenAmbiguous: input.routing?.whenAmbiguous ?? "ask" },
    idle: { suspendAfterSeconds: seconds },
  };
}

/**
 * Providers other than Slack address a single participant, so their only
 * destination is a reply on the conversation the message arrived on.
 */
function replyDestinations(
  input: ChannelInputBase,
  provider: ChannelProvider,
): Record<string, Readonly<ChannelDestinationDefinition>> {
  const destinations: Record<string, Readonly<ChannelDestinationDefinition>> =
    {};
  for (const [name, destination] of Object.entries(input.destinations ?? {})) {
    const destinationId = resourceIdentifier(name, "Channel destination");
    if (destination.type !== "reply") {
      throw new Error(
        `${provider} destination ${destinationId} must be { type: "reply" }`,
      );
    }
    destinations[destinationId] = Object.freeze({ type: "reply" as const });
  }
  if (!Object.keys(destinations).length) {
    destinations.reply = Object.freeze({ type: "reply" as const });
  }
  return destinations;
}

export function defineChannel(input: SlackChannelInput): SlackChannelDefinition;
export function defineChannel(input: TwilioChannelInput): TwilioChannelDefinition;
export function defineChannel(input: EmailChannelInput): EmailChannelDefinition;
export function defineChannel(input: ChannelInput): ChannelDefinition {
  const common = channelCommon(input);

  if (input.type === "twilio" || input.type === "email") {
    return Object.freeze({
      kind: "channel" as const,
      version: 1 as const,
      type: input.type,
      ...common,
      events: Object.freeze(["message.inbound" as const]),
      destinations: Object.freeze(replyDestinations(input, input.type)),
      routing: Object.freeze(common.routing),
      idle: Object.freeze(common.idle),
    }) as ChannelDefinition;
  }

  const scopes = [...new Set(input.scopes.bot.map((scope) => scope.trim()))];
  if (
    !scopes.length ||
    scopes.some((scope) => !SLACK_SCOPE_PATTERN.test(scope))
  ) {
    throw new Error("Slack bot scopes must be non-empty Slack scope names");
  }
  const events = [...new Set(input.events ?? [])];
  for (const event of events) {
    const required = SLACK_EVENT_SCOPE[event];
    if (!scopes.includes(required)) {
      throw new Error(`Slack event ${event} requires bot scope ${required}`);
    }
  }
  const destinations: Record<
    string,
    Readonly<ChannelDestinationDefinition>
  > = {};
  for (const [name, destination] of Object.entries(input.destinations ?? {})) {
    const destinationId = resourceIdentifier(name, "Channel destination");
    if (destination.type !== "conversation") {
      throw new Error(
        `Slack destination ${destinationId} must be { type: "conversation" }`,
      );
    }
    const required =
      destination.visibility === "private" ? "groups:read" : "channels:read";
    if (!scopes.includes(required)) {
      throw new Error(
        `Slack destination ${destinationId} requires bot scope ${required}`,
      );
    }
    if (!scopes.includes("chat:write")) {
      throw new Error(
        `Slack destination ${destinationId} requires bot scope chat:write`,
      );
    }
    destinations[destinationId] = Object.freeze({ ...destination });
  }
  return Object.freeze({
    kind: "channel" as const,
    version: 1 as const,
    type: "slack" as const,
    ...common,
    scopes: Object.freeze({ bot: Object.freeze(scopes) }),
    events: Object.freeze(events),
    destinations: Object.freeze(destinations),
    routing: Object.freeze(common.routing),
    idle: Object.freeze(common.idle),
  });
}

export function registerChannel(
  channel: ChannelDefinition,
  input: { on: readonly ChannelTrigger[] },
): ChannelRegistrationDefinition {
  const triggers = [...new Set(input.on)];
  if (!triggers.length) {
    throw new Error("registerChannel requires at least one trigger");
  }
  const supported = PROVIDER_TRIGGERS[channel.type];
  // Each variant narrows `events` to its own literal union; widen once so the
  // membership check reads the same for every provider.
  const declared: readonly ChannelEvent[] = channel.events;
  for (const trigger of triggers) {
    if (!supported.includes(trigger)) {
      throw new Error(
        `Channel ${channel.id} is a ${channel.type} channel, which supports ${supported.join(" and ")}, not ${trigger}`,
      );
    }
    const event = TRIGGER_EVENT[trigger];
    if (!declared.includes(event)) {
      throw new Error(
        `Channel ${channel.id} does not declare the event required by ${trigger}`,
      );
    }
  }
  return Object.freeze({
    kind: "channel-registration" as const,
    version: 1 as const,
    id: channel.id,
    channelId: channel.id,
    triggers: Object.freeze(triggers),
  });
}

export function defineOutbox(input: {
  id: string;
  delivery: {
    channel: SlackChannelDefinition;
    destination: string;
  };
}): OutboxDefinition {
  const id = resourceIdentifier(input.id, "defineOutbox");
  const destination = resourceIdentifier(
    input.delivery.destination,
    "Outbox destination",
  );
  if (!input.delivery.channel.destinations[destination]) {
    throw new Error(
      `Outbox ${id} references unknown destination ${destination} on channel ${input.delivery.channel.id}`,
    );
  }
  const delivery = Object.freeze({
    channelId: input.delivery.channel.id,
    destination,
  });
  return Object.freeze({
    kind: "outbox" as const,
    version: 1 as const,
    id,
    delivery,
    async publish(input: OutboxPublishInput): Promise<OutboxPublishResult> {
      return publishOutbox(id, input);
    },
  });
}

export function registerOutbox(
  outbox: OutboxDefinition,
): OutboxRegistrationDefinition {
  return Object.freeze({
    kind: "outbox-registration" as const,
    version: 1 as const,
    id: outbox.id,
    outboxId: outbox.id,
  });
}

export function defineTool<Output extends DataValue = DataValue>(input: {
  name: string;
  description: string;
  input?: ToolInputSchema;
  output?: ToolInputSchema;
  run(context: ToolExecutionContext): Output | Promise<Output>;
}): ToolDefinition<Output> {
  const id = identifier(input.name, "defineTool");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      "Tool IDs may contain only letters, numbers, underscores, and hyphens",
    );
  }
  if (!input.description.trim()) {
    throw new Error("defineTool requires a non-empty description");
  }
  if (input.input && typeof input.input !== "object") {
    throw new Error("defineTool input must be a JSON Schema object");
  }
  if (input.output && typeof input.output !== "object") {
    throw new Error("defineTool output must be a JSON Schema object");
  }
  return Object.freeze({
    kind: "tool" as const,
    version: 1 as const,
    ...input,
    id,
    name: id,
  });
}

/**
 * The projection the host recalled for this session's binding of `memory`.
 * It never fetches: a session without that binding fails the render here,
 * before inference. Calling it also selects the binding's permitted tools for
 * this model request; omitting it exposes none of them.
 */
export function useMemory(memory: string | ResourceReference): MemoryProjection {
  const id = memoryId(
    typeof memory === "string" ? memory : memory.id,
    "useMemory",
  );
  return memoryProjection(id, hooks().useMemory(id));
}

export const useInput = (): Readonly<AgentInput> => hooks().useInput();
export const useCurrentInput = useInput;
export const useModel = (model: ModelSelection): void =>
  hooks().useModel(model);
export const useTool = (tool: string | ResourceReference): void =>
  hooks().useTool(tool);
export const useConnection = (
  connection: string | ResourceReference,
): void => hooks().useConnection(connection);
export const useSubagent = (agent: string | ResourceReference): void =>
  hooks().useSubagent(agent);
export const useMcpServer = (server: string | ResourceReference): void =>
  hooks().useMcpServer(server);
export function useSessionData<T extends DataValue>(
  key: string,
): T | undefined {
  return hooks().useSessionData<T>(key);
}
