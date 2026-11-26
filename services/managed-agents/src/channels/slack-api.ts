import { isRecord } from "../protocol.js";
import {
  boundedRequest,
  ProviderRequestError,
  retryAfterHeaderMs,
} from "./adapter.js";
import { markdownMessageBody } from "./slack-format.js";
import type { SlackStatus } from "./slack-progress.js";

const SLACK_API = "https://slack.com/api";

/**
 * Slack said no, or Slack never said. The distinction decides recovery: an
 * explicit `ok: false` had no side effect and the input can be corrected; a
 * timeout, a dropped connection, a 5xx or an unreadable body after dispatch
 * may have done the work, so nothing that creates state is ever retried.
 *
 * Message and fields carry Slack's error code and nothing else: not the token
 * the call was made with, not the body it answered with.
 */
export class SlackApiError extends ProviderRequestError {
  readonly method: string;
  readonly outcome: "rejected" | "uncertain";
  readonly code: string;
  readonly manifestErrors?: ReadonlyArray<{ message: string; pointer?: string }>;

  constructor(
    method: string,
    outcome: "rejected" | "uncertain",
    code: string,
    options: {
      retryAfterMs?: number;
      manifestErrors?: ReadonlyArray<{ message: string; pointer?: string }>;
      details?: string;
    } = {},
  ) {
    super(
      `Slack ${method} ${outcome === "rejected" ? "failed" : "outcome unknown"}: ${code}${
        options.details ? ` (${options.details})` : ""
      }`,
      options.retryAfterMs,
    );
    this.name = "SlackApiError";
    this.method = method;
    this.outcome = outcome;
    this.code = code;
    if (options.manifestErrors) this.manifestErrors = options.manifestErrors;
  }
}

/** Slack's own codes for "something went wrong on our side", which may follow partial work. */
const UNCERTAIN_SLACK_ERRORS = new Set([
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
]);

/** Whatever the transport threw, as a classified Slack failure. */
function classifySlackThrow(method: string, error: unknown): SlackApiError {
  if (error instanceof SlackApiError) return error;
  const message = error instanceof Error ? error.message : "";
  return new SlackApiError(
    method,
    "uncertain",
    /timed out/.test(message) ? "request_timeout" : "transport",
  );
}

export interface SlackInstallation {
  appId: string;
  appName?: string;
  teamId: string;
  teamName?: string;
  botUserId: string;
  botId: string;
}

export interface SlackConversation {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
  isArchived: boolean;
}

async function slackRequest(
  token: string,
  method: string,
  body: Record<string, unknown>,
  httpMethod: "GET" | "POST" = "POST",
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  if (httpMethod === "GET") {
    for (const [name, value] of Object.entries(body)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        url.searchParams.set(name, String(value));
      }
    }
  }
  // Slack answers in well under a second. A request that does not, headers
  // or body, is a failure rather than a wait: a status update holds the
  // answer behind it, and a reply that hangs is retried on its own schedule.
  const { response, result } = await boundedRequest(
    `Slack ${method}`,
    url,
    {
      method: httpMethod,
      headers: {
        authorization: `Bearer ${token}`,
        ...(httpMethod === "POST"
          ? { "content-type": "application/json; charset=utf-8" }
          : {}),
      },
      ...(httpMethod === "POST" ? { body: JSON.stringify(body) } : {}),
    },
    async (response, signal) => ({
      response,
      result: (await response.json().catch((error: unknown) => {
        // A body that never arrives is the timeout's to report, not a
        // malformed answer.
        if (signal.aborted) throw error;
        return null;
      })) as unknown,
    }),
  );
  return slackResult(method, response, result);
}

/**
 * A Slack answer as a result or a classified failure. An `ok: false` with a
 * code is a rejection Slack made before doing anything; a 5xx, an unreadable
 * body or one of Slack's own server-side codes leaves the outcome unknown.
 */
function slackResult(
  method: string,
  response: Response,
  result: unknown,
): Record<string, unknown> {
  if (response.ok && isRecord(result) && result.ok === true) return result;
  const code =
    isRecord(result) && typeof result.error === "string" ? result.error : null;
  if (!code) {
    throw new SlackApiError(
      method,
      "uncertain",
      response.ok ? "malformed_response" : `http_${String(response.status)}`,
      response.status === 429
        ? { retryAfterMs: retryAfterHeaderMs(response) }
        : {},
    );
  }
  if (UNCERTAIN_SLACK_ERRORS.has(code)) {
    throw new SlackApiError(method, "uncertain", code);
  }
  const metadata = isRecord(result) && isRecord(result.response_metadata)
    ? result.response_metadata
    : null;
  const details = metadata && Array.isArray(metadata.messages)
    ? metadata.messages
        .filter((value): value is string => typeof value === "string")
        .join("; ")
        .slice(0, 500)
    : "";
  const manifestErrors = isRecord(result) && Array.isArray(result.errors)
    ? result.errors.flatMap((entry) =>
        isRecord(entry) && typeof entry.message === "string"
          ? [
              {
                message: entry.message.slice(0, 300),
                ...(typeof entry.pointer === "string"
                  ? { pointer: entry.pointer.slice(0, 200) }
                  : {}),
              },
            ]
          : [],
      )
    : undefined;
  // Slack's rate limit says when to come back, and asks that it be
  // honoured; the wait travels with the failure.
  throw new SlackApiError(method, "rejected", code, {
    ...(response.status === 429 || code === "ratelimited"
      ? { retryAfterMs: retryAfterHeaderMs(response) }
      : {}),
    ...(details ? { details } : {}),
    ...(manifestErrors?.length ? { manifestErrors } : {}),
  });
}

/**
 * Slack's form-encoded methods: app creation from a manifest and the OAuth
 * code exchange. Neither is retried, whatever happens: both create state on
 * Slack's side and neither carries an idempotency key.
 */
async function slackFormRequest(
  method: string,
  form: Record<string, string>,
  token?: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  let result: unknown;
  try {
    ({ response, result } = await boundedRequest(
      `Slack ${method}`,
      new URL(`${SLACK_API}/${method}`),
      {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: new URLSearchParams(form).toString(),
      },
      async (response, signal) => ({
        response,
        result: (await response.json().catch((error: unknown) => {
          if (signal.aborted) throw error;
          return null;
        })) as unknown,
      }),
    ));
  } catch (error) {
    throw classifySlackThrow(method, error);
  }
  return slackResult(method, response, result);
}

export interface SlackCreatedApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

/**
 * Create a Slack app from a manifest with a user's configuration access token.
 *
 * Slack returns the client secret and signing secret here and nowhere else,
 * so a success whose credentials are missing is not a success: the app may
 * exist without OpenComputer ever being able to install it, which is the
 * uncertain outcome, not a rejection.
 */
export async function createSlackAppFromManifest(
  configurationToken: string,
  manifest: Record<string, unknown>,
): Promise<SlackCreatedApp> {
  const result = await slackFormRequest(
    "apps.manifest.create",
    { manifest: JSON.stringify(manifest) },
    configurationToken,
  );
  const credentials = isRecord(result.credentials) ? result.credentials : null;
  const appId = typeof result.app_id === "string" ? result.app_id : "";
  const clientId =
    credentials && typeof credentials.client_id === "string"
      ? credentials.client_id
      : "";
  const clientSecret =
    credentials && typeof credentials.client_secret === "string"
      ? credentials.client_secret
      : "";
  const signingSecret =
    credentials && typeof credentials.signing_secret === "string"
      ? credentials.signing_secret
      : "";
  if (
    !/^A[A-Z0-9]+$/.test(appId) ||
    !clientId ||
    !clientSecret ||
    !signingSecret
  ) {
    throw new SlackApiError(
      "apps.manifest.create",
      "uncertain",
      "malformed_response",
    );
  }
  return { appId, clientId, clientSecret, signingSecret };
}

export interface SlackOAuthGrant {
  accessToken: string;
  tokenType?: string;
  /** The scopes Slack granted, which may be fewer than the manifest asked for. */
  scopes: string[];
  botUserId?: string;
  appId?: string;
  teamId?: string;
  teamName?: string;
  /** The Slack user who approved the install (`authed_user.id`). */
  authedUserId?: string;
  isEnterpriseInstall: boolean;
}

/**
 * Exchange an OAuth authorization code for the workspace's bot token. The
 * shape comes back as Slack gave it; the caller decides what it accepts, and
 * the token is never persisted before those checks pass.
 */
export async function exchangeSlackOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SlackOAuthGrant> {
  const result = await slackFormRequest("oauth.v2.access", {
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  });
  const accessToken =
    typeof result.access_token === "string" ? result.access_token : "";
  if (!accessToken) {
    throw new SlackApiError("oauth.v2.access", "uncertain", "malformed_response");
  }
  const team = isRecord(result.team) ? result.team : null;
  const authedUser = isRecord(result.authed_user) ? result.authed_user : null;
  return {
    accessToken,
    ...(typeof result.token_type === "string"
      ? { tokenType: result.token_type }
      : {}),
    scopes:
      typeof result.scope === "string"
        ? result.scope.split(",").map((scope) => scope.trim()).filter(Boolean)
        : [],
    ...(typeof result.bot_user_id === "string"
      ? { botUserId: result.bot_user_id }
      : {}),
    ...(typeof result.app_id === "string" ? { appId: result.app_id } : {}),
    ...(team && typeof team.id === "string" ? { teamId: team.id } : {}),
    ...(team && typeof team.name === "string" ? { teamName: team.name } : {}),
    ...(authedUser && typeof authedUser.id === "string"
      ? { authedUserId: authedUser.id }
      : {}),
    isEnterpriseInstall: result.is_enterprise_install === true,
  };
}

/**
 * Prove a bot token is the installation an OAuth grant described, through
 * auth.test alone: its `team_id` must be the grant's workspace and its
 * `user_id` the grant's bot user. The app is the grant's `app_id`, already
 * compared with the app persisted at creation by the caller; bots.info could
 * name it too but needs `users:read`, which installs minted before the name
 * scopes were added do not carry, so it is never asked here.
 */
export async function verifySlackInstallation(
  botToken: string,
  expected: { appId: string; teamId: string; botUserId: string },
): Promise<SlackInstallation> {
  let identity: Record<string, unknown>;
  try {
    identity = await slackRequest(botToken, "auth.test", {});
  } catch (error) {
    throw classifySlackThrow("auth.test", error);
  }
  const teamId = typeof identity.team_id === "string" ? identity.team_id : null;
  const botUserId =
    typeof identity.user_id === "string" ? identity.user_id : null;
  const botId = typeof identity.bot_id === "string" ? identity.bot_id : null;
  if (!teamId || !botUserId || !botId) {
    throw new SlackApiError("auth.test", "uncertain", "malformed_response");
  }
  if (teamId !== expected.teamId) {
    throw new SlackApiError("auth.test", "rejected", "workspace_mismatch");
  }
  if (botUserId !== expected.botUserId) {
    throw new SlackApiError("auth.test", "rejected", "bot_mismatch");
  }
  return {
    appId: expected.appId,
    appName: typeof identity.user === "string" ? identity.user : undefined,
    teamId,
    teamName: typeof identity.team === "string" ? identity.team : undefined,
    botUserId,
    botId,
  };
}

export async function resolveSlackInstallation(
  botToken: string,
  expectedAppId?: string,
): Promise<SlackInstallation> {
  const identity = await slackRequest(botToken, "auth.test", {});
  const teamId = typeof identity.team_id === "string" ? identity.team_id : null;
  const botUserId =
    typeof identity.user_id === "string" ? identity.user_id : null;
  const botId = typeof identity.bot_id === "string" ? identity.bot_id : null;
  if (!teamId || !botUserId || !botId) {
    throw new Error("Slack auth.test did not return a bot installation");
  }
  let appId = expectedAppId;
  if (!appId) {
    const bot = await slackRequest(botToken, "bots.info", { bot: botId });
    const botInfo = isRecord(bot.bot) ? bot.bot : null;
    appId =
      botInfo && typeof botInfo.app_id === "string"
        ? botInfo.app_id
        : undefined;
  }
  if (!appId) {
    throw new Error("Slack bots.info did not return an app ID");
  }
  return {
    appId,
    appName: typeof identity.user === "string" ? identity.user : undefined,
    teamId,
    teamName: typeof identity.team === "string" ? identity.team : undefined,
    botUserId,
    botId,
  };
}

export async function resolveSlackConversation(
  botToken: string,
  conversationId: string,
): Promise<SlackConversation> {
  const result = await slackRequest(botToken, "conversations.info", {
    channel: conversationId,
  }, "GET");
  const channel = isRecord(result.channel) ? result.channel : null;
  if (!channel || typeof channel.id !== "string" || typeof channel.name !== "string") {
    throw new Error("Slack conversations.info did not return a conversation");
  }
  return {
    id: channel.id,
    name: channel.name,
    isMember: channel.is_member === true,
    isPrivate: channel.is_private === true,
    isArchived: channel.is_archived === true,
  };
}

export interface SlackUser {
  id: string;
  /** What Slack displays for the person: display name, then real name, then handle. */
  displayName: string;
}

export async function resolveSlackUser(
  botToken: string,
  userId: string,
): Promise<SlackUser> {
  const result = await slackRequest(
    botToken,
    "users.info",
    { user: userId },
    "GET",
  );
  const user = isRecord(result.user) ? result.user : null;
  if (!user || typeof user.id !== "string") {
    throw new Error("Slack users.info did not return a user");
  }
  const profile = isRecord(user.profile) ? user.profile : null;
  const displayName =
    (typeof profile?.display_name === "string" && profile.display_name) ||
    (typeof user.real_name === "string" && user.real_name) ||
    (typeof profile?.real_name === "string" && profile.real_name) ||
    (typeof user.name === "string" && user.name) ||
    user.id;
  return { id: user.id, displayName };
}

export async function postSlackMessage(
  botToken: string,
  input: {
    channelId: string;
    threadTimestamp: string;
    text: string;
  },
): Promise<string> {
  const result = await slackRequest(botToken, "chat.postMessage", {
    channel: input.channelId,
    thread_ts: input.threadTimestamp,
    ...markdownMessageBody(input.text),
  });
  if (typeof result.ts !== "string") {
    throw new Error("Slack chat.postMessage did not return a timestamp");
  }
  return result.ts;
}

export interface SlackBlock {
  [key: string]: unknown;
}

export async function postSlackBlocks(
  botToken: string,
  input: {
    channelId: string;
    threadTimestamp: string;
    text: string;
    blocks: readonly SlackBlock[];
  },
): Promise<string> {
  const result = await slackRequest(botToken, "chat.postMessage", {
    channel: input.channelId,
    thread_ts: input.threadTimestamp,
    // Notifications and accessibility fall back to this, so it must stand on
    // its own rather than say "see the card above".
    text: input.text.slice(0, 3_000),
    blocks: input.blocks,
  });
  if (typeof result.ts !== "string") {
    throw new Error("Slack chat.postMessage did not return a timestamp");
  }
  return result.ts;
}

export async function updateSlackBlocks(
  botToken: string,
  input: {
    channelId: string;
    messageId: string;
    text: string;
    blocks: readonly SlackBlock[];
  },
): Promise<void> {
  await slackRequest(botToken, "chat.update", {
    channel: input.channelId,
    ts: input.messageId,
    text: input.text.slice(0, 3_000),
    blocks: input.blocks,
  });
}

export async function postSlackConversationMessage(
  botToken: string,
  input: { channelId: string; text: string },
): Promise<string> {
  const result = await slackRequest(botToken, "chat.postMessage", {
    channel: input.channelId,
    ...markdownMessageBody(input.text),
  });
  if (typeof result.ts !== "string") {
    throw new Error("Slack chat.postMessage did not return a timestamp");
  }
  return result.ts;
}

export async function postSlackDirectMessage(
  botToken: string,
  input: { userId: string; text: string },
): Promise<string> {
  const result = await slackRequest(botToken, "chat.postMessage", {
    channel: input.userId,
    ...markdownMessageBody(input.text),
  });
  if (typeof result.ts !== "string") {
    throw new Error("Slack chat.postMessage did not return a timestamp");
  }
  return result.ts;
}

export async function updateSlackMessage(
  botToken: string,
  input: {
    channelId: string;
    messageTimestamp: string;
    text: string;
  },
): Promise<void> {
  await slackRequest(botToken, "chat.update", {
    channel: input.channelId,
    ts: input.messageTimestamp,
    ...markdownMessageBody(input.text),
  });
}

export async function setSlackThreadStatus(
  botToken: string,
  input: {
    channelId: string;
    threadTimestamp: string;
    status: SlackStatus;
  },
): Promise<void> {
  await slackRequest(botToken, "assistant.threads.setStatus", {
    channel_id: input.channelId,
    thread_ts: input.threadTimestamp,
    status: input.status.status,
    loading_messages: input.status.loadingMessages,
  });
}

export interface SlackStreamChunk {
  type: "task_update" | "markdown_text" | "plan_update" | "blocks";
  [key: string]: unknown;
}

/**
 * The thinking-steps stream — Slack's "agent is working" message whose task
 * cards collapse once the work is done. `chat.startStream` opens it,
 * `chat.appendStream` adds task cards and text as the turn produces them, and
 * `chat.stopStream` finalizes it; the finished message stays in the thread
 * with the steps folded away.
 */
export async function startSlackStream(
  botToken: string,
  input: {
    channelId: string;
    threadTimestamp?: string;
    recipientUserId?: string;
    recipientTeamId?: string;
    taskDisplayMode?: "timeline" | "plan";
  },
): Promise<string> {
  const result = await slackRequest(botToken, "chat.startStream", {
    channel: input.channelId,
    thread_ts: input.threadTimestamp,
    recipient_user_id: input.recipientUserId,
    recipient_team_id: input.recipientTeamId,
    task_display_mode: input.taskDisplayMode,
  });
  if (typeof result.ts !== "string") {
    throw new Error("Slack chat.startStream did not return a timestamp");
  }
  return result.ts;
}

export async function appendSlackStream(
  botToken: string,
  input: {
    channelId: string;
    messageTimestamp: string;
    chunks: readonly SlackStreamChunk[];
  },
): Promise<void> {
  await slackRequest(botToken, "chat.appendStream", {
    channel: input.channelId,
    ts: input.messageTimestamp,
    chunks: input.chunks,
  });
}

export async function stopSlackStream(
  botToken: string,
  input: {
    channelId: string;
    messageTimestamp: string;
  },
): Promise<void> {
  await slackRequest(botToken, "chat.stopStream", {
    channel: input.channelId,
    ts: input.messageTimestamp,
  });
}
