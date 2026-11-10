// The organization-level OpenComputer Slack app (work 052, decision 8): the
// pure parts. Event envelopes, interactions, message text, the authorize
// URL and its state, and Web API calls with the linked workspace's bot token.
// Ported from dash-cal src/slack.ts and src/workspace-do.ts.

import type { CalvinSlackFile, CalvinTraceContext } from "./protocol.js";
import type { SubmittedView } from "./secrets.js";
import { type ForwardedMessage, MAX_LINKS } from "./threads.js";

export interface SlackMessageJob {
  eventId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  files?: CalvinSlackFile[];
  /** Messages forwarded in this one: Slack sends them in `attachments`, not `text`. */
  forwarded?: ForwardedMessage[];
  mentioned: boolean;
  /** Raw text @mentions someone other than this app: most likely not addressed to it. */
  mentionsOthers?: boolean;
  channelType?: string;
  receivedAt: number;
  /** Work 054: minted at message.received and kept in the queue payload, so a retried job keeps its trace. */
  trace?: CalvinTraceContext;
  /** The working status (or 👀) was started when the message was accepted; the queue does not start it again. */
  acked?: boolean;
  /** Which indicator Slack confirmed for that (`none`: neither took); written to the queue row when it settles. */
  ackIndicator?: "status" | "reaction" | "none";
}

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    /** A user id on messages; a user object on `team_leave` and `user_change`. */
    user?: string | SlackEventUser;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel_type?: string;
    files?: CalvinSlackFile[];
    attachments?: SlackAttachment[];
    tokens?: { oauth?: string[]; bot?: string[] };
  };
}

/** The fields of a Slack message attachment that carry a forwarded message's copy. */
interface SlackAttachment {
  /** Set on a forwarded or shared message, which Slack also marks `is_msg_unfurl`; a link's preview lacks it. */
  is_share?: boolean;
  from_url?: string;
  original_url?: string;
  author_name?: string;
  author_subname?: string;
  channel_name?: string;
  ts?: string;
  text?: string;
  fallback?: string;
  files?: Array<{ name?: string; title?: string }>;
}

/** Messages forwarded in an event, at most `MAX_LINKS`. */
export function forwardedMessages(attachments: SlackAttachment[] | undefined): ForwardedMessage[] {
  return (attachments ?? [])
    .filter((a) => a.is_share && (a.text || a.fallback || a.files?.length))
    .slice(0, MAX_LINKS)
    .map((a) => ({
      url: a.from_url ?? a.original_url ?? "",
      author: a.author_name ?? a.author_subname ?? "someone",
      ...(a.channel_name ? { channel: a.channel_name } : {}),
      ...(a.ts ? { ts: a.ts } : {}),
      text: a.text || a.fallback || "",
      ...(a.files?.length ? { files: a.files.map((f) => f.name ?? f.title ?? "file") } : {}),
    }));
}

interface SlackEventUser {
  id?: string;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
}

/** Subtypes that are still a person's message: an upload, and a thread reply also sent to the channel. */
const PERSON_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/**
 * Slack message text → what the user typed. Slack wraps links, mentions and
 * channels in <…> and escapes &, <, > as entities; the model should see plain
 * text, otherwise pasted code arrives as `&amp;&amp;`.
 */
export function decodeSlack(text: string): string {
  return text
    .replace(/<([^<>]+)>/g, (_, inner: string) => {
      const [target = "", label] = inner.split("|", 2) as [string, string | undefined];
      if (target.startsWith("@")) return label ? `@${label}` : target;
      if (target.startsWith("#")) return label ? `#${label}` : target;
      if (target.startsWith("!")) return label ?? `@${target.slice(1).split("^")[0]}`;
      const url = target.replace(/^mailto:/, "");
      if (!label || url.endsWith(label) || label.endsWith(url)) return label ?? url;
      return `${label} (${url})`;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Text → Slack message text that shows as typed: no mentions, links or broken markup. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Only metadata the runner needs to fetch a file with the bot token; never its contents. */
function fileMetadata(files: CalvinSlackFile[] | undefined): CalvinSlackFile[] | undefined {
  if (!files?.length) return undefined;
  return files.flatMap((file) =>
    typeof file?.id === "string"
      ? [
          {
            id: file.id,
            ...(file.name ? { name: file.name } : {}),
            ...(file.title ? { title: file.title } : {}),
            ...(file.mimetype ? { mimetype: file.mimetype } : {}),
            ...(file.filetype ? { filetype: file.filetype } : {}),
            ...(typeof file.size === "number" ? { size: file.size } : {}),
            ...(file.url_private ? { url_private: file.url_private } : {}),
            ...(file.url_private_download ? { url_private_download: file.url_private_download } : {}),
          },
        ]
      : [],
  );
}

export type ParsedSlackEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; job: SlackMessageJob }
  | { kind: "stop"; teamId: string; channelId: string; threadTs?: string; eventId: string }
  /** The app was uninstalled from the workspace, or its bot token revoked. */
  | { kind: "revoked"; teamId: string }
  /** Work 077: a person left the workspace, was deactivated or became a guest (`team_leave`, `user_change`). */
  | { kind: "member-left"; teamId: string; userId: string }
  | { kind: "ignored"; teamId?: string };

export function parseSlackEnvelope(payload: unknown, now = Date.now()): ParsedSlackEvent {
  if (!payload || typeof payload !== "object") return { kind: "ignored" };
  const envelope = payload as SlackEventEnvelope;
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    return { kind: "challenge", challenge: envelope.challenge };
  }
  const event = envelope.event;
  if (
    envelope.type === "event_callback" &&
    envelope.event_id &&
    envelope.team_id &&
    event?.type === "agent_session_stopped" &&
    event.channel
  ) {
    return {
      kind: "stop",
      teamId: envelope.team_id,
      channelId: event.channel,
      ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
      eventId: envelope.event_id,
    };
  }
  if (
    envelope.type === "event_callback" &&
    envelope.team_id &&
    (event?.type === "app_uninstalled" || (event?.type === "tokens_revoked" && event.tokens?.bot?.length))
  ) {
    return { kind: "revoked", teamId: envelope.team_id };
  }
  if (envelope.type === "event_callback" && envelope.team_id && (event?.type === "team_leave" || event?.type === "user_change")) {
    const user = typeof event.user === "object" ? event.user : undefined;
    const left = event.type === "team_leave" || !!(user?.deleted || user?.is_restricted || user?.is_ultra_restricted);
    if (left && user?.id) return { kind: "member-left", teamId: envelope.team_id, userId: user.id };
    return { kind: "ignored", teamId: envelope.team_id };
  }
  if (
    envelope.type !== "event_callback" ||
    !envelope.event_id ||
    !envelope.team_id ||
    !event ||
    (event.type !== "app_mention" && event.type !== "message") ||
    (event.subtype && !PERSON_SUBTYPES.has(event.subtype)) ||
    event.bot_id ||
    !event.channel ||
    typeof event.user !== "string" ||
    !event.user ||
    (!event.text && !event.files?.length && !forwardedMessages(event.attachments).length) ||
    !event.ts
  ) {
    return { kind: "ignored", ...(envelope.team_id ? { teamId: envelope.team_id } : {}) };
  }
  const files = fileMetadata(event.files);
  const forwarded = forwardedMessages(event.attachments);
  return {
    kind: "message",
    job: {
      eventId: envelope.event_id,
      teamId: envelope.team_id,
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      messageTs: event.ts,
      userId: event.user,
      // Raw until the Durable Object removes this app's own mention: the
      // paired `message`/`app_mention` events stay equivalent, and mentions
      // of other people stay visible.
      text: event.text ?? "",
      ...(files?.length ? { files } : {}),
      ...(forwarded.length ? { forwarded } : {}),
      mentioned: event.type === "app_mention",
      ...(event.channel_type ? { channelType: event.channel_type } : {}),
      receivedAt: now,
    },
  };
}

/**
 * The job as the session sees it: this app's mention removed, the text
 * decoded, and whether it mentions anyone else (dash-cal's heuristic: a
 * reply that @mentions other people and not the app is most likely for
 * them). Null when nothing is left to deliver.
 */
export function normalizeJob(job: SlackMessageJob, botUserId: string): SlackMessageJob | null {
  const mention = `<@${botUserId}>`;
  const raw = botUserId ? job.text.replaceAll(mention, "") : job.text;
  const normalized: SlackMessageJob = {
    ...job,
    mentioned: job.mentioned || (botUserId !== "" && job.text.includes(mention)),
    mentionsOthers: /<@[UW]/.test(raw),
    text: decodeSlack(raw).trim(),
  };
  if (!normalized.text && !normalized.files?.length && !normalized.forwarded?.length) return null;
  return normalized;
}

export interface SlackInteraction {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  trigger_id?: string;
  channel?: { id?: string };
  container?: { channel_id?: string; thread_ts?: string; message_ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: SubmittedView;
  response_url?: string;
}

/** Slack posts interactivity form-encoded: `payload=<json>`. */
export function parseInteraction(rawBody: string): SlackInteraction | null {
  const encoded = new URLSearchParams(rawBody).get("payload");
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded) as unknown;
    return value && typeof value === "object" ? (value as SlackInteraction) : null;
  } catch {
    return null;
  }
}

/** The Slack Web API with a bot token. Read methods ignore JSON bodies, so they are form-encoded. */
const FORM_METHODS = new Set([
  "users.info",
  "chat.getPermalink",
  "conversations.info",
  "conversations.replies",
  "conversations.members",
  "auth.test",
  "auth.revoke",
]);

export interface SlackResult {
  ok: boolean;
  error?: string;
  ts?: string;
  permalink?: string;
  channel?: { id?: string };
  user?: {
    team_id?: string;
    name?: string;
    real_name?: string;
    profile?: { real_name?: string; display_name?: string; email?: string };
    deleted?: boolean;
    is_bot?: boolean;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
    is_stranger?: boolean;
    is_admin?: boolean;
    is_owner?: boolean;
    is_primary_owner?: boolean;
  };
}

/** Errors that mean the bot token is dead for good: the app was uninstalled or the token revoked. */
const DEAD_TOKEN_ERRORS = new Set(["token_revoked", "invalid_auth", "account_inactive", "token_expired"]);

export function slackTokenDead(result: SlackResult): boolean {
  return !result.ok && DEAD_TOKEN_ERRORS.has(result.error ?? "");
}

export async function slackApi(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<SlackResult> {
  try {
    const form = FORM_METHODS.has(method);
    const response = await fetcher(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
      },
      body: form
        ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))
        : JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    return (await response.json()) as SlackResult;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request_failed" };
  }
}

/** Slack's authorize URL for the organization app. */
export function slackAuthorizeUrl(input: { clientId: string; scopes: string; redirectUri: string; state: string }): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", input.scopes);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * The install's `state`: the organization (so the callback finds its
 * Durable Object) and a random nonce that object stored, bound to the user
 * who started the install, for a short time, and spends once.
 */
export function encodeInstallState(accountId: string, nonce: string): string {
  return `${btoa(accountId).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.${nonce}`;
}

export function decodeInstallState(state: string): { accountId: string; nonce: string } | null {
  const [encoded, nonce, extra] = state.split(".");
  if (!encoded || !nonce || extra !== undefined || !/^[A-Za-z0-9_-]{20,100}$/.test(nonce)) return null;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const accountId = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return accountId ? { accountId, nonce } : null;
  } catch {
    return null;
  }
}

/** A link to the thread that works without knowing the workspace's domain. */
export function slackThreadUrl(teamId: string | null, channelId: string, threadTs: string): string | null {
  if (!teamId) return null;
  return `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}/thread/${encodeURIComponent(`${channelId}-${threadTs}`)}`;
}

/** The routing object that says which organization a Slack workspace is linked to. */
export function slackTeamLinkName(teamId: string): string {
  return `computer-slack-team:${teamId}`;
}

/**
 * Someone tried to link a Slack workspace another organization already
 * linked (work 052): what they are told in a DM, and, when the person who
 * linked it is known, what that person is told so they can invite them.
 * Neither names an organization: the requester may not belong to it.
 */
export function joinRequestMessages(input: {
  requesterUserId: string;
  installerUserId: string | null;
  settingsUrl: string;
}): { requester: string; installer: string | null } {
  const { requesterUserId, installerUserId, settingsUrl } = input;
  if (!installerUserId) {
    return {
      requester: "This Slack workspace already works with OpenComputer. Ask a teammate who uses it to invite you.",
      installer: null,
    };
  }
  if (installerUserId === requesterUserId) {
    return {
      requester:
        "This Slack workspace already works with OpenComputer, in another organization you set it up for. Switch to that organization from the menu at the top left of the dashboard.",
      installer: null,
    };
  }
  return {
    requester: `This Slack workspace already works with OpenComputer, set up by <@${installerUserId}>. We've let them know you'd like to join, so look out for an invite.`,
    installer: `<@${requesterUserId}> just tried to set up OpenComputer for this workspace. It's already yours: invite them to your organization so they can use the computer with you: ${settingsUrl}`,
  };
}

export const WAKING_NOTICE = "Waking your computer, this takes a minute or two; your message is queued.";
export const RESIZING_NOTICE = "Upgrading your computer to its bigger size — back in a couple of minutes; your message is queued.";
export const STARTING_NOTICE = "Setting up your computer. This takes a few minutes the first time; your message is queued.";
