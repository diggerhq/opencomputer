import { Cron } from "croner";

import { memoryId, memoryProjection, type MemoryProjection } from "./memory.js";

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

/** The turn outcomes an event subscription delivers. */
export type OutcomeEventType =
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled";

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
      readonly source: Exclude<
        InputSource,
        "channel" | "schedule" | "webhook" | "event"
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

/**
 * Which store a secret is read from.
 *
 * `project` is one value for the whole deployment. `tenant` is one value per
 * channel installation: an agent answering many workspaces resolves the
 * credential belonging to whichever installation the message arrived through,
 * so one customer's agent cannot reach another customer's account. `user` is
 * narrower still — the credential of the particular person being acted for,
 * so the upstream applies its own permissions to them rather than to the
 * installation as a whole.
 *
 * Nothing falls back. A `tenant` secret never reaches for the project's, and a
 * `user` secret never reaches for the installation's, because a credential
 * substituted when the right one is missing is exactly how one customer ends
 * up acting with another's authority.
 */
export type SecretScope = "project" | "tenant" | "user";

export interface SecretReference extends ResourceReference {
  readonly kind: "secret";
  readonly scope: SecretScope;
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
  /**
   * The agent's result tool: its latest committed output is the session's
   * `result`. At most one tool per agent; `output` is required so the host
   * can validate every value before it is committed.
   */
  readonly result?: true;
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
  /** Optional: the declaration is extracted at build time, so a host
   *  that does nothing at run time is still correct. */
  useService?(service: string): void;
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

export function useSecret(
  name: string,
  options: { scope?: SecretScope } = {},
): SecretReference {
  const id = identifier(name, "useSecret");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(id)) {
    throw new Error(
      "Secret names must use uppercase letters, numbers, and underscores",
    );
  }
  const scope = options.scope ?? "project";
  if (scope !== "project" && scope !== "tenant" && scope !== "user") {
    throw new Error('A secret scope must be "project", "tenant" or "user"');
  }
  return Object.freeze({ kind: "secret", id, scope });
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

/**
 * A service the platform holds an OAuth credential for.
 *
 * `defineConnection` covers the case where WE hold the secret: the egress proxy
 * attaches a managed secret to a declared origin. It cannot express an OAuth
 * integration, because the credential is short-lived, per-person, and has to be
 * refreshed — which is why the runtime is forbidden from setting `Authorization`
 * on a declared connection at all.
 *
 * This is the other half, and the platform already implements it: the request
 * names a service and a mailbox rather than a URL and a header, and the
 * credential is resolved, refreshed and attached on the way out. The agent never
 * sees a token, which is the same guarantee, reached differently.
 */
export type ManagedService =
  | "gmail"
  | "calendar"
  | "drive"
  | "sheets"
  | "github";

export interface ServiceRequest {
  /** Which service. `google` is accepted as an alias for `gmail`. */
  service: ManagedService | string;
  /**
   * Which connected account, when a user has more than one. This is the label
   * the connection was linked under — an agent sweeping two mailboxes asks for
   * each by name rather than hoping the right one is first.
   */
  label?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path on the service, e.g. `/gmail/v1/users/me/messages`. */
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Call a service the platform is connected to on this session's behalf.
 *
 * Returns the upstream response, so a caller reads status and body exactly as
 * it would from `fetch` — a 404 from the service arrives as a 404, not as an
 * exception that has lost the distinction.
 *
 * The transport does not make that free. A managed connection answers with an
 * envelope — `{status, headers, body}`, the body a string — wrapped in a 200,
 * because the proxy has to report its own failures separately from the
 * service's. Handing that to a caller means every one of them reinvents the
 * unwrapping, and the ones that forget see `ok` on a request that failed. So
 * the envelope is opened here and a real Response is rebuilt from it. A
 * non-2xx from the proxy itself is passed through untouched: that is the
 * platform failing, not the service.
 */
export async function callService(request: ServiceRequest): Promise<Response> {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const base = runtime.process?.env?.OPENCOMPUTER_CONNECTIONS_URL;
  const token = runtime.process?.env?.OPENCOMPUTER_CONNECTION_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer managed connections are unavailable");
  }
  if (!request.path.startsWith("/")) {
    throw new Error("Service requests require an absolute path");
  }
  const service = request.service.trim().toLowerCase();
  if (!service) throw new Error("A service request needs a service");
  // The provider segment routes the supervisor; the service in the body is what
  // the platform resolves a credential for. GitHub and Google are separate
  // providers with separate grants, so the two cannot be collapsed.
  const provider = service === "github" ? "github" : "google";
  const response = await fetch(`${base.replace(/\/$/, "")}/${provider}/fetch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      service,
      ...(request.label ? { label: request.label } : {}),
      method: (request.method ?? "GET").toUpperCase(),
      path: request.path,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return unwrapServiceResponse(response);
}

/**
 * Rebuild the upstream response from the proxy's envelope.
 *
 * Anything that is not a well-formed envelope is returned as it arrived —
 * a proxy error, or a future shape this does not recognise, should reach the
 * caller rather than be flattened into a confusing success.
 */
async function unwrapServiceResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const envelope = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    status?: unknown;
    headers?: unknown;
    body?: unknown;
  } | null;
  if (
    !envelope ||
    typeof envelope.status !== "number" ||
    typeof envelope.body !== "string"
  ) {
    return response;
  }
  const headers =
    envelope.headers && typeof envelope.headers === "object"
      ? Object.fromEntries(
          Object.entries(envelope.headers as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return new Response(envelope.body, { status: envelope.status, headers });
}

/** A service account the platform holds a credential for, as listed. */
export interface ConnectedService {
  readonly id: string;
  /** `google` or `github` — the grant, not the API being called. */
  readonly provider: string;
  /** The alias this account was connected under. Pass it as `label`. */
  readonly label: string;
  /** Who the account belongs to, e.g. the mailbox address. */
  readonly displayName?: string;
  readonly scopes?: readonly string[];
  /** `connected` accounts are usable; anything else is not yet. */
  readonly status: string;
}

/**
 * The service accounts this session can reach.
 *
 * An agent that sweeps several mailboxes cannot hold their names in its
 * source: they are connected and disconnected by an operator long after the
 * artifact is built. This answers "which ones exist right now" so the loop is
 * over live state rather than over a list someone has to remember to redeploy.
 *
 * The platform reconciles pending consents before answering, so an account
 * connected a moment ago is already `connected` here rather than on the next
 * run. Only providers the deployment declares are returned.
 *
 * Unlike `callService`, this returns parsed rows rather than a `Response` —
 * it is the platform's own API, not an upstream service whose status codes
 * the caller needs to see.
 */
export async function listServices(
  options: {
    /** Restrict to one grant, e.g. `google`. Omit for everything. */
    provider?: string;
    /** Omit unusable accounts. Defaults to true. */
    connectedOnly?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ConnectedService[]> {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const base = runtime.process?.env?.OPENCOMPUTER_CONNECTIONS_URL;
  const token = runtime.process?.env?.OPENCOMPUTER_CONNECTION_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer managed connections are unavailable");
  }
  // `opencomputer` is the reserved provider segment for the platform's own
  // connection actions; a body carrying no method and no path is what routes
  // this to them rather than to managed egress.
  const response = await fetch(
    `${base.replace(/\/$/, "")}/opencomputer/fetch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "list" }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Listing connected services failed: ${response.status} ${(
        await response.text()
      ).slice(0, 300)}`,
    );
  }
  const body = (await response.json()) as { connections?: ConnectedService[] };
  const provider = options.provider?.trim().toLowerCase();
  return (body.connections ?? []).filter(
    (connection) =>
      (!provider || connection.provider?.toLowerCase() === provider) &&
      (options.connectedOnly === false || connection.status === "connected"),
  );
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
  const destinations: Record<
    string,
    Readonly<ChannelDestinationDefinition>
  > = {};
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
export function defineChannel(
  input: TwilioChannelInput,
): TwilioChannelDefinition;
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

/**
 * What `defineTool()` accepts. A result tool must declare `output`: the
 * schema is pinned in the deployment and the host rejects a value that does
 * not match it before anything is committed. A tool that waits for a person
 * (`preview` and `apply`) is a `GatedToolInput` and cannot be the result
 * tool: the model's call records a proposal, not the output.
 */
export type ToolInput<Output extends DataValue = DataValue> = {
  name: string;
  description: string;
  input?: ToolInputSchema;
  run(context: ToolExecutionContext): Output | Promise<Output>;
} & (
  | { result?: false; output?: ToolInputSchema }
  | { result: true; output: ToolInputSchema }
);

export interface GatedToolInput<Output extends DataValue = DataValue> {
  name: string;
  description: string;
  input?: ToolInputSchema;
  output?: ToolInputSchema;
  /**
   * Runs when the model calls the tool. Reads; never writes. What this returns
   * is what a person sees and agrees to.
   */
  preview(context: ToolExecutionContext): ApprovalPreview | Promise<ApprovalPreview>;
  /** Runs only after somebody approves, from the arguments previewed above. */
  apply(context: GatedToolApplyContext): Output | Promise<Output>;
}

/**
 * Define a tool.
 *
 * A tool that writes can wait for a person: supply `preview` and `apply`
 * instead of `run`, and the model's call becomes a proposal rather than the
 * write. `run` is then written for you — it builds the preview, records the
 * proposal under the calling message's id so a retry is one approval rather
 * than two, and returns a sentence telling the model to stop.
 *
 * Waiting for approval is a property of a tool, not a different kind of thing:
 * the model sees it, and `useTool` selects it, exactly as for any other. What
 * changes is only whether the tool's body runs now or after a decision.
 */
export function defineTool<Output extends DataValue = DataValue>(
  input: ToolInput<Output>,
): ToolDefinition<Output>;
export function defineTool<Output extends DataValue = DataValue>(
  input: GatedToolInput<Output>,
): GatedToolDefinition<Output>;
export function defineTool<Output extends DataValue = DataValue>(
  input: ToolInput<Output> | GatedToolInput<Output>,
): ToolDefinition<Output> | GatedToolDefinition<Output> {
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

  const candidate = input as Partial<ToolInput<Output>> &
    Partial<GatedToolInput<Output>>;
  const gated =
    typeof candidate.preview === "function" ||
    typeof candidate.apply === "function";

  if (!gated) {
    if (typeof candidate.run !== "function") {
      throw new Error(
        "defineTool requires run(), or preview() and apply() for a tool that waits for approval",
      );
    }
    const tool = input as ToolInput<Output>;
    if (tool.result !== undefined && typeof tool.result !== "boolean") {
      throw new Error("defineTool result must be true or false");
    }
    if (tool.result === true && !tool.output) {
      throw new Error(
        "defineTool result tools require an output schema; the host validates every result against it before committing",
      );
    }
    const { result, ...definition } = tool;
    return Object.freeze({
      kind: "tool" as const,
      version: 1 as const,
      ...definition,
      ...(result === true ? { result: true as const } : {}),
      id,
      name: id,
    });
  }

  // The result tool's committed output is what its run() returns; a gated
  // tool's run() is written here and returns the platform's sentence, so the
  // two cannot be one tool.
  if ("result" in candidate) {
    throw new Error("A tool that waits for approval cannot be the result tool");
  }

  // Half a gate is the dangerous shape: a preview with no apply asks for a
  // decision nothing acts on, and an apply with no preview asks a person to
  // approve something they were never shown.
  if (typeof candidate.preview !== "function") {
    throw new Error("A tool with apply() also requires preview()");
  }
  if (typeof candidate.apply !== "function") {
    throw new Error("A tool with preview() also requires apply()");
  }
  if (typeof candidate.run === "function") {
    throw new Error(
      "A tool has either run(), or preview() and apply() — not both; run() is written for you when the tool waits for approval",
    );
  }

  const definition = input as GatedToolInput<Output>;
  return Object.freeze({
    kind: "gated-tool" as const,
    version: 1 as const,
    ...definition,
    id,
    name: id,
    async run(context: ToolExecutionContext): Promise<string> {
      const preview = approvalPreview(await definition.preview(context), id);
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

/**
 * The projection the host recalled for this session's binding of `memory`.
 * It never fetches: a session without that binding fails the render here,
 * before inference. Calling it also selects the binding's permitted tools for
 * this model request; omitting it exposes none of them.
 */
export function useMemory(
  memory: string | ResourceReference,
): MemoryProjection {
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
export const useConnection = (connection: string | ResourceReference): void =>
  hooks().useConnection(connection);
/**
 * Declare that this agent reaches a managed service.
 *
 * `callService` works without this, but two things do not. The capability
 * manifest is extracted from source at build time and is meant to be the whole
 * statement of what an agent can reach — an undeclared `callService("gmail")`
 * is reach that no reviewer can see. And `listServices()` only returns grants
 * the deployment declares, so an agent that sweeps mailboxes without declaring
 * `gmail` is told, truthfully and uselessly, that none are connected.
 *
 * Pass a literal string: it is read out of the source, not evaluated.
 */
export const useService = (service: string): void =>
  hooks().useService?.(service);
export const useSubagent = (agent: string | ResourceReference): void =>
  hooks().useSubagent(agent);
export const useMcpServer = (server: string | ResourceReference): void =>
  hooks().useMcpServer(server);
export function useSessionData<T extends DataValue>(
  key: string,
): T | undefined {
  return hooks().useSessionData<T>(key);
}
