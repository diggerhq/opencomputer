import { Cron } from "croner";

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
  | "system";

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

/**
 * Who sent this message, in the provider's own terms.
 *
 * An agent serving one Slack workspace never needs this. An agent serving
 * many — one deployment behind a distributed app — needs it for everything:
 * which customer's records to read, which credential to use, whether this
 * person may act at all. Without it the agent is blind to the tenant, and no
 * amount of prompting recovers what was never sent.
 *
 * These are the provider's public identifiers, not ours. `workspaceId` is a
 * Slack team id or a Twilio account SID; `userId` is a Slack member id or an
 * E.164 number. They are stable, and they are what an agent can join against
 * its own customer records.
 *
 * Session ownership is keyed separately, by a one-way hash that is deliberately
 * not derivable from these (see the platform's channel principal). This bag
 * exists to be used by the agent; that key exists to keep sessions apart.
 */
export interface ChannelMessageContext {
  readonly provider: string;
  /** The connection this arrived on. Distinct installations, distinct ids. */
  readonly connectionId: string;
  /** The provider's tenant: a Slack team, a Twilio account. */
  readonly workspaceId?: string;
  /** Where it was said, when the provider names conversations. */
  readonly conversationId?: string;
  /** The provider's id for the person who said it. */
  readonly userId?: string;
}

interface BasicAgentInput {
  readonly text?: string;
  readonly payload?: DataValue;
}

export type AgentInput =
  | (BasicAgentInput & {
      readonly source: Exclude<
        InputSource,
        "channel" | "schedule" | "webhook"
      >;
    })
  | (BasicAgentInput & {
      readonly source: "channel";
      readonly channel: Readonly<ChannelMessageContext>;
    })
  | (BasicAgentInput & {
      readonly source: "schedule";
      readonly schedule: Readonly<ScheduleRunContext>;
    })
  | (BasicAgentInput & {
      readonly source: "webhook";
      readonly webhook: Readonly<WebhookRequestContext>;
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
  readonly messageId: string;
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

/** One line on an approval card: what changes, from what, to what. */
export interface ApprovalFact {
  readonly label: string;
  readonly value: string;
}

/**
 * What a person is shown before they decide. Built by `preview`, stored
 * verbatim, and kept after the decision as the record of what was agreed to.
 */
export interface ApprovalPreview {
  readonly title: string;
  readonly summary?: string;
  readonly facts?: readonly ApprovalFact[];
}

export interface ApprovalDecision {
  /**
   * This approval, once. Stable, unique, and the same on every attempt to
   * carry out this one decision.
   *
   * Pass it to whatever you call as an idempotency key. Then a write that
   * cannot be confirmed — the runtime died mid-flight, the answer never came
   * back — can simply be run again, because the second attempt returns the
   * first one's result instead of charging anyone twice:
   *
   * ```ts
   * async apply({ input, decision, signal }) {
   *   return billing.fetch("/charges", {
   *     method: "POST",
   *     headers: { "Idempotency-Key": decision.id },
   *     body: JSON.stringify({ customer: input.customerId }),
   *     signal,
   *   });
   * }
   * ```
   *
   * Without it an unconfirmed write is a dead end: nobody can retry it,
   * because nobody can tell whether the first attempt landed.
   */
  readonly id: string;
  readonly decidedAt: string;
  /** Who clicked, in the provider's terms. Absent if the platform decided. */
  readonly decidedBy?: string;
}

export interface GatedToolApplyContext extends ToolExecutionContext {
  readonly decision: Readonly<ApprovalDecision>;
}

export interface ApprovalPublishResult {
  readonly id: string;
  readonly status: "pending" | "approved" | "denied" | "applied";
  readonly duplicate: boolean;
  /** What to tell the model. Supplied by the platform so every agent agrees. */
  readonly message: string;
}

export interface GatedToolDefinition<
  Output extends DataValue = DataValue,
> extends ResourceReference {
  readonly kind: "gated-tool";
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly input?: ToolInputSchema;
  readonly output?: ToolInputSchema;
  preview(context: ToolExecutionContext): ApprovalPreview | Promise<ApprovalPreview>;
  apply(context: GatedToolApplyContext): Output | Promise<Output>;
  /**
   * What the model calls. It does not write: it builds the preview, records
   * the proposal, and returns a sentence telling the model to stop. The write
   * happens later, in `apply`, from the arguments stored here.
   */
  run(context: ToolExecutionContext): Promise<string>;
}

function approvalPreview(value: unknown, toolId: string): ApprovalPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Tool ${toolId} preview must return an object`);
  }
  const preview = value as ApprovalPreview;
  if (typeof preview.title !== "string" || !preview.title.trim()) {
    throw new Error(`Tool ${toolId} preview requires a non-empty title`);
  }
  if (preview.summary !== undefined && typeof preview.summary !== "string") {
    throw new Error(`Tool ${toolId} preview summary must be a string`);
  }
  if (preview.facts !== undefined) {
    if (!Array.isArray(preview.facts)) {
      throw new Error(`Tool ${toolId} preview facts must be an array`);
    }
    if (preview.facts.length > 20) {
      throw new Error(`Tool ${toolId} preview may carry at most 20 facts`);
    }
    for (const fact of preview.facts) {
      if (
        !fact ||
        typeof fact.label !== "string" ||
        typeof fact.value !== "string"
      ) {
        throw new Error(
          `Tool ${toolId} preview facts must each have a label and a value`,
        );
      }
    }
  }
  return preview;
}

/**
 * Record a proposal for a human to decide on.
 *
 * Reaches the platform the way an outbox item does: over the session's own
 * runtime token, which is the only credential the agent holds that the
 * platform trusts.
 */
export async function publishApproval(
  tool: string | ResourceReference,
  input: {
    readonly input: DataValue;
    readonly preview: ApprovalPreview;
    readonly idempotencyKey: string;
  },
): Promise<ApprovalPublishResult> {
  const id = resourceIdentifier(
    typeof tool === "string" ? tool : tool.id,
    "publishApproval",
  );
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) {
    throw new Error("Approval idempotency keys must contain 1 to 256 characters");
  }
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const base = runtime.process?.env?.OPENCOMPUTER_APPROVAL_URL;
  const token = runtime.process?.env?.OPENCOMPUTER_APPROVAL_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer approvals are unavailable");
  }
  const response = await fetch(`${base.replace(/\/$/, "")}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      toolId: id,
      input: input.input,
      preview: input.preview,
      idempotencyKey,
    }),
  });
  if (!response.ok) {
    // Whatever the model is told here, it repeats to a person — and a bare
    // status code invites it to invent a reason. The platform writes these
    // sentences so the explanation is true.
    const detail = await response.text().catch(() => "");
    let message = "";
    try {
      const problem = JSON.parse(detail) as { error?: { message?: unknown } };
      if (typeof problem.error?.message === "string") {
        message = problem.error.message;
      }
    } catch {
      /* not a problem document; fall through to the status */
    }
    throw new Error(
      message || `Recording the approval failed with status ${response.status}`,
    );
  }
  return (await response.json()) as ApprovalPublishResult;
}

interface AgentHooks {
  useInput(): Readonly<AgentInput>;
  useModel(model: ModelSelection): void;
  useTool(tool: string | ResourceReference): void;
  useSubagent(agent: string | ResourceReference): void;
  useSessionData<T extends DataValue>(key: string): T | undefined;
  useMcpServer(server: string | ResourceReference): void;
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

export function defineConnection(input: {
  id: string;
  origin: string;
  headers?: Readonly<Record<string, string | SecretHeaderReference>>;
  methods?: readonly string[];
  pathPrefix?: string;
  redirectOrigins?: readonly HttpConnectionRedirectOrigin[];
}): HttpConnectionDefinition {
  const id = identifier(input.id, "defineConnection");
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
 * A tool whose write waits for a person.
 *
 * The model calls it and nothing is written. `preview` builds what the human
 * sees, the proposal is recorded against the conversation it came from, and
 * the model is told to stop. When somebody approves, `apply` runs with the
 * arguments that were on the card — not with whatever a second pass through
 * the model would produce.
 *
 * This is cooperative. A tool that wants to write in `preview` can; what the
 * platform guarantees is that `apply` runs once, from the stored arguments,
 * whether or not this session still exists by then.
 *
 * Give `apply` an idempotency key from `decision.id` if whatever you call
 * accepts one. A write that never reports back is recorded as unconfirmed
 * rather than failed, and that is only recoverable if running it again is
 * safe.
 */
export function defineGatedTool<Output extends DataValue = DataValue>(input: {
  name: string;
  description: string;
  input?: ToolInputSchema;
  output?: ToolInputSchema;
  preview(context: ToolExecutionContext): ApprovalPreview | Promise<ApprovalPreview>;
  apply(context: GatedToolApplyContext): Output | Promise<Output>;
}): GatedToolDefinition<Output> {
  const id = identifier(input.name, "defineGatedTool");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      "Tool IDs may contain only letters, numbers, underscores, and hyphens",
    );
  }
  if (!input.description.trim()) {
    throw new Error("defineGatedTool requires a non-empty description");
  }
  if (input.input && typeof input.input !== "object") {
    throw new Error("defineGatedTool input must be a JSON Schema object");
  }
  if (input.output && typeof input.output !== "object") {
    throw new Error("defineGatedTool output must be a JSON Schema object");
  }
  if (typeof input.preview !== "function") {
    throw new Error("defineGatedTool requires a preview function");
  }
  if (typeof input.apply !== "function") {
    throw new Error("defineGatedTool requires an apply function");
  }
  return Object.freeze({
    kind: "gated-tool" as const,
    version: 1 as const,
    ...input,
    id,
    name: id,
    async run(context: ToolExecutionContext): Promise<string> {
      const preview = approvalPreview(await input.preview(context), id);
      // The tool call is the proposal's identity, so the same call recorded
      // twice — a retry, a resumed turn — is one approval, not two.
      const result = await publishApproval(id, {
        input: context.input as DataValue,
        preview,
        idempotencyKey: context.messageId,
      });
      return result.message;
    },
  });
}

export const useInput = (): Readonly<AgentInput> => hooks().useInput();
export const useCurrentInput = useInput;
export const useModel = (model: ModelSelection): void =>
  hooks().useModel(model);
export const useTool = (tool: string | ResourceReference): void =>
  hooks().useTool(tool);
export const useSubagent = (agent: string | ResourceReference): void =>
  hooks().useSubagent(agent);
export const useMcpServer = (server: string | ResourceReference): void =>
  hooks().useMcpServer(server);
export function useSessionData<T extends DataValue>(
  key: string,
): T | undefined {
  return hooks().useSessionData<T>(key);
}
