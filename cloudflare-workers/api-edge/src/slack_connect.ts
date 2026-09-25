// Self-serve Slack Connect for Pro and Max organizations. The first invite
// from an org creates a dedicated channel in the OpenComputer workspace, adds
// the support team to it, and shares it with the caller via Slack Connect.
// Later invites from the same org reuse that channel. The invite always goes
// to the signed-in user's own account email — the dashboard never chooses the
// recipient.

import { hasBYOKPlanAccess } from "./managed_agents";

export interface SlackConnectEnv {
  OPENCOMPUTER_DB: D1Database;
  SESSIONS_KV: KVNamespace;
  AUTUMN_SECRET_KEY?: string;
  AUTUMN_BASE_URL?: string;
  // Bot token (xoxb-…) of the OpenComputer workspace app. Needs
  // groups:write (private channel create + invite) and
  // conversations.connect:write. Unset → feature hidden.
  SLACK_CONNECT_BOT_TOKEN?: string;
  // Comma-separated Slack user IDs of the team members added to every new
  // per-org channel. Unset → feature hidden.
  SLACK_CONNECT_TEAM_USER_IDS?: string;
  // Prefix for per-org channel names. Default "oc-".
  SLACK_CONNECT_CHANNEL_PREFIX?: string;
}

interface SlackConnectCaller {
  orgID: string;
  userID: string;
}

const INVITE_TTL_SEC = 30 * 24 * 60 * 60;
// Cooldown after a rejected Slack call so a stuck user can't hammer Slack.
const FAILURE_COOLDOWN_SEC = 60;
const SLACK_API = "https://slack.com/api";
const DEFAULT_CHANNEL_PREFIX = "oc-";
const SLACK_CHANNEL_NAME_MAX = 80;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isConfigured(env: SlackConnectEnv): boolean {
  return !!env.SLACK_CONNECT_BOT_TOKEN && teamUserIDs(env).length > 0;
}

function teamUserIDs(env: SlackConnectEnv): string[] {
  return (env.SLACK_CONNECT_TEAM_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function inviteKey(caller: SlackConnectCaller): string {
  return `slack_connect_invite:${caller.orgID}:${caller.userID}`;
}

function channelKey(orgID: string): string {
  return `slack_connect_channel:${orgID}`;
}

function cooldownKey(caller: SlackConnectCaller): string {
  return `slack_connect_cooldown:${caller.orgID}:${caller.userID}`;
}

interface OrgChannel {
  id: string;
  name: string;
  // False until the team has been added; retried on the next invite.
  teamInvited?: boolean;
}

async function userEmail(
  env: SlackConnectEnv,
  userID: string,
): Promise<string | null> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT email FROM users WHERE id = ?1",
  )
    .bind(userID)
    .first<{ email: string }>();
  return row?.email ?? null;
}

async function orgName(
  env: SlackConnectEnv,
  orgID: string,
): Promise<string | null> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT name FROM orgs WHERE id = ?1",
  )
    .bind(orgID)
    .first<{ name: string }>();
  return row?.name ?? null;
}

// Slack channel names: lowercase letters, digits, hyphens, underscores; ≤80.
export function slackChannelName(
  prefix: string,
  name: string,
  orgID: string,
  attempt = 0,
): string {
  const slug =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org";
  const idPart = orgID
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(-6);
  const tail = `-${idPart}${attempt > 0 ? `-${attempt}` : ""}`;
  const head = `${prefix}${slug}`.slice(
    0,
    SLACK_CHANNEL_NAME_MAX - tail.length,
  );
  return `${head}${tail}`;
}

class SlackError extends Error {
  constructor(
    public readonly code: string,
    public readonly method: string,
  ) {
    super(`${method}: ${code}`);
  }
}

class SlackUnreachable extends Error {}

async function slack<T extends { ok: boolean; error?: string }>(
  env: SlackConnectEnv,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  let result: T;
  try {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_CONNECT_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    result = (await res.json()) as T;
  } catch (error) {
    throw new SlackUnreachable(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!result.ok) throw new SlackError(result.error ?? "unknown_error", method);
  return result;
}

interface ChannelResponse {
  ok: boolean;
  error?: string;
  channel?: { id: string; name: string };
}

interface InviteResponse {
  ok: boolean;
  error?: string;
  errors?: { user: string; ok: boolean; error: string }[];
}

interface InviteSharedResponse {
  ok: boolean;
  error?: string;
  invite_id?: string;
}

async function createOrgChannel(
  env: SlackConnectEnv,
  orgID: string,
): Promise<OrgChannel> {
  const prefix = env.SLACK_CONNECT_CHANNEL_PREFIX ?? DEFAULT_CHANNEL_PREFIX;
  const name = (await orgName(env, orgID)) ?? "";
  let channel: OrgChannel | null = null;
  for (let attempt = 0; attempt < 5 && !channel; attempt++) {
    try {
      const res = await slack<ChannelResponse>(env, "conversations.create", {
        name: slackChannelName(prefix, name, orgID, attempt),
        is_private: true,
      });
      if (!res.channel)
        throw new SlackError("no_channel", "conversations.create");
      channel = { id: res.channel.id, name: res.channel.name };
    } catch (error) {
      if (!(error instanceof SlackError && error.code === "name_taken")) {
        throw error;
      }
    }
  }
  if (!channel) throw new SlackError("name_taken", "conversations.create");
  return channel;
}

async function inviteTeam(env: SlackConnectEnv, channel: OrgChannel) {
  try {
    await slack<InviteResponse>(env, "conversations.invite", {
      channel: channel.id,
      users: teamUserIDs(env).join(","),
    });
  } catch (error) {
    if (!(error instanceof SlackError && error.code === "already_in_channel")) {
      throw error;
    }
  }
}

async function saveOrgChannel(
  env: SlackConnectEnv,
  orgID: string,
  channel: OrgChannel,
) {
  await env.SESSIONS_KV.put(channelKey(orgID), JSON.stringify(channel));
}

// The channel is persisted as soon as Slack creates it so a failed team invite
// never orphans it; the team invite is retried on the next call instead.
async function ensureOrgChannel(
  env: SlackConnectEnv,
  orgID: string,
): Promise<OrgChannel> {
  const cached = await env.SESSIONS_KV.get(channelKey(orgID));
  let channel: OrgChannel;
  if (cached) {
    channel = JSON.parse(cached) as OrgChannel;
    if (channel.teamInvited !== false) return channel;
  } else {
    channel = { ...(await createOrgChannel(env, orgID)), teamInvited: false };
    await saveOrgChannel(env, orgID, channel);
  }
  await inviteTeam(env, channel);
  channel = { ...channel, teamInvited: true };
  await saveOrgChannel(env, orgID, channel);
  return channel;
}

async function eligibility(
  env: SlackConnectEnv,
  orgID: string,
): Promise<{ eligible: boolean } | Response> {
  try {
    return { eligible: await hasBYOKPlanAccess(env, orgID) };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack_connect.entitlement_failed",
        orgId: orgID,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return json(
      {
        error: {
          code: "billing_unavailable",
          message: "Plan eligibility could not be verified.",
        },
      },
      503,
    );
  }
}

export async function handleSlackConnectStatus(
  env: SlackConnectEnv,
  caller: SlackConnectCaller,
): Promise<Response> {
  if (!isConfigured(env)) {
    return json({
      available: false,
      eligible: false,
      email: null,
      channelName: null,
      invitedAt: null,
    });
  }
  const gate = await eligibility(env, caller.orgID);
  if (gate instanceof Response) return gate;
  const [email, invitedAt, channel] = await Promise.all([
    userEmail(env, caller.userID),
    env.SESSIONS_KV.get(inviteKey(caller)),
    env.SESSIONS_KV.get(channelKey(caller.orgID)),
  ]);
  return json({
    available: true,
    eligible: gate.eligible,
    email,
    channelName: channel ? (JSON.parse(channel) as OrgChannel).name : null,
    invitedAt: invitedAt ?? null,
  });
}

// Slack's error codes are stable; the messages are written here so a raw
// provider phrase never reaches the dashboard.
const SLACK_ERROR_MESSAGES: Record<string, string> = {
  already_in_channel: "You're already a member of your shared channel.",
  invite_already_sent:
    "An invitation was already sent to this email. Check your inbox.",
  user_already_team_member: "You're already a member of your shared channel.",
  restricted_action:
    "Slack Connect invitations are temporarily unavailable. Contact support.",
  missing_scope:
    "Slack Connect invitations are temporarily unavailable. Contact support.",
  not_in_channel:
    "Slack Connect invitations are temporarily unavailable. Contact support.",
  channel_not_found:
    "Slack Connect invitations are temporarily unavailable. Contact support.",
  invalid_email: "Slack could not deliver an invitation to your account email.",
};

const ALREADY_MEMBER_CODES = new Set([
  "already_in_channel",
  "user_already_team_member",
  "invite_already_sent",
]);

async function rememberInvite(
  env: SlackConnectEnv,
  caller: SlackConnectCaller,
  invitedAt: string,
): Promise<void> {
  try {
    await env.SESSIONS_KV.put(inviteKey(caller), invitedAt, {
      expirationTtl: INVITE_TTL_SEC,
    });
  } catch (error) {
    // Slack already delivered the invite; a lost bookkeeping write must not
    // turn that into a user-visible failure.
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack_connect.kv_write_failed",
        orgId: caller.orgID,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function slackFailure(
  env: SlackConnectEnv,
  caller: SlackConnectCaller,
  error: unknown,
): Promise<Response> {
  await env.SESSIONS_KV.put(cooldownKey(caller), "1", {
    expirationTtl: FAILURE_COOLDOWN_SEC,
  });
  if (error instanceof SlackUnreachable) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack_connect.unreachable",
        orgId: caller.orgID,
        message: error.message,
      }),
    );
    return json(
      {
        error: {
          code: "slack_connect_unavailable",
          message: "Slack could not be reached. Try again in a moment.",
        },
      },
      502,
    );
  }
  const code = error instanceof SlackError ? error.code : "unknown_error";
  console.error(
    JSON.stringify({
      level: "error",
      event: "slack_connect.rejected",
      orgId: caller.orgID,
      method: error instanceof SlackError ? error.method : null,
      slackError: code,
    }),
  );
  const alreadyMember = ALREADY_MEMBER_CODES.has(code);
  if (alreadyMember) {
    // Slack considers this user invited/joined; mirror that so Settings stops
    // offering the button instead of re-hitting Slack.
    await rememberInvite(env, caller, new Date().toISOString());
  }
  return json(
    {
      error: {
        code: alreadyMember
          ? "slack_connect_already_invited"
          : "slack_connect_invite_failed",
        message:
          SLACK_ERROR_MESSAGES[code] ??
          "Slack rejected the invitation. Try again later or contact support.",
      },
    },
    alreadyMember ? 409 : 502,
  );
}

export async function handleSlackConnectInvite(
  env: SlackConnectEnv,
  caller: SlackConnectCaller,
): Promise<Response> {
  if (!isConfigured(env)) {
    return json(
      {
        error: {
          code: "slack_connect_unavailable",
          message: "Slack Connect invitations are not available right now.",
        },
      },
      503,
    );
  }
  const gate = await eligibility(env, caller.orgID);
  if (gate instanceof Response) return gate;
  if (!gate.eligible) {
    return json(
      {
        error: {
          code: "slack_connect_plan_required",
          message: "Upgrade to Pro or Max to get a shared Slack channel.",
        },
      },
      403,
    );
  }
  const email = await userEmail(env, caller.userID);
  if (!email) return json({ error: "user not found" }, 404);

  const [existing, cachedChannel, coolingDown] = await Promise.all([
    env.SESSIONS_KV.get(inviteKey(caller)),
    env.SESSIONS_KV.get(channelKey(caller.orgID)),
    env.SESSIONS_KV.get(cooldownKey(caller)),
  ]);
  if (existing && cachedChannel) {
    return json({
      email,
      channelName: (JSON.parse(cachedChannel) as OrgChannel).name,
      invitedAt: existing,
      alreadyInvited: true,
    });
  }
  if (coolingDown) {
    return json(
      {
        error: {
          code: "slack_connect_rate_limited",
          message: "Please wait a minute before trying again.",
        },
      },
      429,
    );
  }

  let channel: OrgChannel;
  try {
    channel = await ensureOrgChannel(env, caller.orgID);
    await slack<InviteSharedResponse>(env, "conversations.inviteShared", {
      channel: channel.id,
      emails: [email],
      external_limited: true,
    });
  } catch (error) {
    return slackFailure(env, caller, error);
  }

  const invitedAt = new Date().toISOString();
  await rememberInvite(env, caller, invitedAt);
  return json({
    email,
    channelName: channel.name,
    invitedAt,
    alreadyInvited: false,
  });
}
