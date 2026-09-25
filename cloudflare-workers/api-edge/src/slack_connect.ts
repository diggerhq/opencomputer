// Self-serve Slack Connect invitations to the OpenComputer team's shared
// support channel. Pro and Max organizations only. The invite always goes to
// the signed-in user's own account email — the dashboard never chooses the
// recipient — and Slack delivers it as a transactional email.

import { hasBYOKPlanAccess } from "./managed_agents";

export interface SlackConnectEnv {
  OPENCOMPUTER_DB: D1Database;
  SESSIONS_KV: KVNamespace;
  AUTUMN_SECRET_KEY?: string;
  AUTUMN_BASE_URL?: string;
  // Bot token (xoxb-…) of the OpenComputer workspace app that owns the shared
  // channel. Needs conversations.connect:write. Unset → feature hidden.
  SLACK_CONNECT_BOT_TOKEN?: string;
  // Channel ID of the shared support channel in the OpenComputer workspace.
  SLACK_CONNECT_CHANNEL_ID?: string;
}

interface SlackConnectCaller {
  orgID: string;
  userID: string;
}

const INVITE_TTL_SEC = 7 * 24 * 60 * 60;
const SLACK_API = "https://slack.com/api/conversations.inviteShared";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isConfigured(env: SlackConnectEnv): boolean {
  return !!env.SLACK_CONNECT_BOT_TOKEN && !!env.SLACK_CONNECT_CHANNEL_ID;
}

function inviteKey(caller: SlackConnectCaller): string {
  return `slack_connect_invite:${caller.orgID}:${caller.userID}`;
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
      invitedAt: null,
    });
  }
  const gate = await eligibility(env, caller.orgID);
  if (gate instanceof Response) return gate;
  const [email, invitedAt] = await Promise.all([
    userEmail(env, caller.userID),
    env.SESSIONS_KV.get(inviteKey(caller)),
  ]);
  return json({
    available: true,
    eligible: gate.eligible,
    email,
    invitedAt: invitedAt ?? null,
  });
}

// Slack's error codes are stable; the messages are written here so a raw
// provider phrase never reaches the dashboard.
const SLACK_ERROR_MESSAGES: Record<string, string> = {
  already_in_channel: "You're already a member of the shared channel.",
  invite_already_sent:
    "An invitation was already sent to this email. Check your inbox.",
  user_already_team_member: "You're already a member of the shared channel.",
  restricted_action:
    "Slack Connect invitations are temporarily unavailable. Contact support.",
  not_in_channel:
    "Slack Connect invitations are temporarily unavailable. Contact support.",
  channel_not_found:
    "Slack Connect invitations are temporarily unavailable. Contact support.",
  invalid_email: "Slack could not deliver an invitation to your account email.",
};

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
          message: "Upgrade to Pro or Max to join the shared Slack channel.",
        },
      },
      403,
    );
  }
  const email = await userEmail(env, caller.userID);
  if (!email) return json({ error: "user not found" }, 404);

  const key = inviteKey(caller);
  const existing = await env.SESSIONS_KV.get(key);
  if (existing) {
    return json({ email, invitedAt: existing, alreadyInvited: true });
  }

  let result: { ok: boolean; error?: string; invite_id?: string };
  try {
    const res = await fetch(SLACK_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_CONNECT_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: env.SLACK_CONNECT_CHANNEL_ID,
        emails: [email],
        external_limited: true,
      }),
    });
    result = (await res.json()) as typeof result;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack_connect.invite_failed",
        orgId: caller.orgID,
        message: error instanceof Error ? error.message : String(error),
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

  if (!result.ok) {
    const code = result.error ?? "unknown_error";
    console.error(
      JSON.stringify({
        level: "error",
        event: "slack_connect.invite_rejected",
        orgId: caller.orgID,
        slackError: code,
      }),
    );
    const alreadyMember =
      code === "already_in_channel" ||
      code === "user_already_team_member" ||
      code === "invite_already_sent";
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

  const invitedAt = new Date().toISOString();
  await env.SESSIONS_KV.put(key, invitedAt, {
    expirationTtl: INVITE_TTL_SEC,
  });
  return json({ email, invitedAt, alreadyInvited: false });
}
