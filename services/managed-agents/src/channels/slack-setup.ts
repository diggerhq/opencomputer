import type {
  SlackSetupAction,
  SlackSetupError,
  SlackSetupErrorCode,
  SlackSetupPhase,
  SlackSetupResult,
} from "../protocol.js";
import type { SlackApiError, SlackOAuthGrant } from "./slack-api.js";

/**
 * The automated Slack setup's rules, apart from storage and HTTP: what each
 * phase permits, how a provider failure maps to a user-facing error, what an
 * OAuth grant must prove before a token is kept, and the two URLs the flow
 * hands out (Slack's consent page and the dashboard it returns to).
 */

/** A creation claim older than this with no commit is reported as uncertain. */
export const SLACK_SETUP_CREATING_TTL_MS = 120_000;
/** An exchange claim older than this with no commit falls back to the app. */
export const SLACK_SETUP_EXCHANGING_TTL_MS = 60_000;
/** The established OAuth state lifetime. */
export const SLACK_OAUTH_STATE_TTL_MS = 10 * 60_000;

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export function slackSetupActions(
  phase: SlackSetupPhase,
  error?: SlackSetupError,
): SlackSetupAction[] {
  switch (phase) {
    case "prepared":
      // A rejected manifest is this setup's snapshot; only a new setup
      // regenerates it, so `create` is not on offer.
      return error && !error.recoverable
        ? ["manual", "cancel"]
        : ["create", "manual", "cancel"];
    case "creation_uncertain":
      return ["manual", "cancel"];
    case "app_created":
      return ["authorize", "manual", "cancel"];
    case "connected":
      return ["authorize"];
    case "cancelled":
      return error?.code === "slack_setup_superseded" ? ["manual"] : [];
    case "creating":
    case "exchanging":
      return [];
  }
}

export function slackSetupError(
  code: SlackSetupErrorCode,
  message: string,
  recoverable: boolean,
  extra: { retryAfterMs?: number; pointer?: string } = {},
): SlackSetupError {
  return {
    code,
    message,
    recoverable,
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
    ...(extra.pointer ? { pointer: extra.pointer } : {}),
    at: new Date().toISOString(),
  };
}

/**
 * How apps.manifest.create failing reads to the user. An explicit rejection
 * goes back to `prepared` for a corrected submission; anything Slack may have
 * half-done is uncertain and never retried by the platform.
 */
export function slackCreationFailure(
  error: SlackApiError,
): { outcome: "rejected" | "uncertain"; error: SlackSetupError } {
  if (error.outcome === "uncertain") {
    return {
      outcome: "uncertain",
      error: slackSetupError(
        "slack_creation_uncertain",
        "Slack did not confirm whether the app was created. Check your Slack app list before creating another; an existing app can be connected with manual setup.",
        false,
      ),
    };
  }
  switch (error.code) {
    case "token_expired":
      return {
        outcome: "rejected",
        error: slackSetupError(
          "slack_configuration_token_expired",
          "The configuration token has expired. Generate a new one in Slack's app settings and submit it again.",
          true,
        ),
      };
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "missing_scope":
    case "not_allowed_token_type":
    case "invalid_team_id":
    case "not_in_team":
      return {
        outcome: "rejected",
        error: slackSetupError(
          "slack_configuration_token_invalid",
          "Slack did not accept the configuration token. Generate an app configuration token for the workspace you want to install into and submit it again.",
          true,
        ),
      };
    case "invalid_manifest": {
      // The pointer names the field; Slack's free text stays out of the
      // record, as every other provider body does. The manifest is this
      // setup's snapshot, so the setup itself cannot recover: a new one,
      // after the declaration is fixed and redeployed, regenerates it.
      const pointer = error.manifestErrors?.[0]?.pointer;
      return {
        outcome: "rejected",
        error: slackSetupError(
          "slack_manifest_rejected",
          pointer
            ? `Slack rejected the generated app manifest at ${pointer}. Cancel this setup, fix the channel declaration and redeploy, then start a new setup; or connect an app with manual setup.`
            : "Slack rejected the generated app manifest. Cancel this setup, fix the channel declaration and redeploy, then start a new setup; or connect an app with manual setup.",
          false,
          pointer ? { pointer } : {},
        ),
      };
    }
    case "managed_app_limit_reached":
      return {
        outcome: "rejected",
        error: slackSetupError(
          "slack_app_limit_reached",
          "This Slack workspace has reached its limit of apps. Remove an unused app or connect an existing one with manual setup.",
          true,
        ),
      };
    case "ratelimited":
      return {
        outcome: "rejected",
        error: slackSetupError(
          "slack_rate_limited",
          "Slack is rate limiting app creation. Wait and submit again.",
          true,
          error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {},
        ),
      };
    default:
      // Only the codes Slack documents as answered before any work are
      // rejections; anything else (failed_creating_app, invalid_app, a code
      // that did not exist when this was written) may follow partial work.
      return {
        outcome: "uncertain",
        error: slackSetupError(
          "slack_creation_uncertain",
          `Slack answered app creation with ${error.code}, which does not say whether an app was created. Check your Slack app list before creating another; an existing app can be connected with manual setup.`,
          false,
        ),
      };
  }
}

export interface SlackExchangeFailure {
  result: SlackSetupResult;
  error: SlackSetupError;
}

/** How a failed code exchange or installation check reads to the user. */
export function slackExchangeFailure(error: SlackApiError): SlackExchangeFailure {
  if (error.outcome === "uncertain") {
    return {
      result: "provider_unavailable",
      error: slackSetupError(
        "slack_provider_unavailable",
        "Slack did not answer while completing the installation. Authorize again.",
        true,
      ),
    };
  }
  switch (error.code) {
    case "invalid_code":
      return {
        result: "authorization_expired",
        error: slackSetupError(
          "slack_authorization_expired",
          "The Slack authorization expired before it could be completed. Authorize again.",
          true,
        ),
      };
    case "app_mismatch":
      return {
        result: "app_mismatch",
        error: slackSetupError(
          "slack_app_mismatch",
          "Slack installed a different app than the one created for this setup. Authorize again from this setup.",
          true,
        ),
      };
    case "workspace_mismatch":
      return {
        result: "workspace_mismatch",
        error: slackSetupError(
          "slack_workspace_mismatch",
          "The installation belongs to a different workspace than this connection. Authorize again in the workspace this bot is connected to.",
          true,
        ),
      };
    case "bot_mismatch":
      return {
        result: "exchange_failed",
        error: slackSetupError(
          "slack_exchange_failed",
          "The bot token Slack issued does not belong to the bot the installation named. Authorize again.",
          true,
        ),
      };
    default:
      return {
        result: "exchange_failed",
        error: slackSetupError(
          "slack_exchange_failed",
          `Slack refused to complete the installation (${error.code}). Authorize again.`,
          true,
        ),
      };
  }
}

export interface ValidatedSlackGrant {
  accessToken: string;
  appId: string;
  teamId: string;
  teamName?: string;
  botUserId: string;
  scopes: string[];
}

/**
 * What an OAuth grant must prove before its token is kept, all fail-closed:
 * a bot token for the app this setup created, every requested scope granted,
 * a single workspace (organization-wide installs are outside this slice).
 */
export function validateSlackOAuthGrant(
  grant: SlackOAuthGrant,
  expected: { appId: string; requiredScopes: readonly string[] },
): { ok: true; grant: ValidatedSlackGrant } | { ok: false; failure: SlackExchangeFailure } {
  if (grant.isEnterpriseInstall || !grant.teamId) {
    return {
      ok: false,
      failure: {
        result: "enterprise_install_unsupported",
        error: slackSetupError(
          "slack_enterprise_install_unsupported",
          "Organization-wide Slack installations are not supported. Install the app into a single workspace.",
          true,
        ),
      },
    };
  }
  if (grant.appId !== expected.appId) {
    return {
      ok: false,
      failure: {
        result: "app_mismatch",
        error: slackSetupError(
          "slack_app_mismatch",
          "Slack installed a different app than the one created for this setup. Authorize again from this setup.",
          true,
        ),
      },
    };
  }
  const granted = new Set(grant.scopes);
  const missing = expected.requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length) {
    return {
      ok: false,
      failure: {
        result: "scope_missing",
        error: slackSetupError(
          "slack_scope_missing",
          `The installation did not grant every permission the agent declares (${missing.join(", ")}). Authorize again and approve all of them.`,
          true,
        ),
      },
    };
  }
  if (
    grant.tokenType !== "bot" ||
    !grant.accessToken.startsWith("xoxb-") ||
    !grant.botUserId ||
    !/^[UW][A-Z0-9]+$/.test(grant.botUserId) ||
    !/^T[A-Z0-9]+$/.test(grant.teamId)
  ) {
    return {
      ok: false,
      failure: {
        result: "exchange_failed",
        error: slackSetupError(
          "slack_exchange_failed",
          "Slack did not return a bot installation for this app. Authorize again.",
          true,
        ),
      },
    };
  }
  return {
    ok: true,
    grant: {
      accessToken: grant.accessToken,
      appId: grant.appId,
      teamId: grant.teamId,
      ...(grant.teamName ? { teamName: grant.teamName } : {}),
      botUserId: grant.botUserId,
      scopes: grant.scopes,
    },
  };
}

/**
 * Slack's consent page for this app, built here rather than taken from the
 * creation response: that URL carries neither the state nor the redirect.
 */
export function slackAuthorizationUrl(input: {
  clientId: string;
  scopes: readonly string[];
  state: string;
  redirectUri: string;
  teamId?: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", input.scopes.join(","));
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.teamId) url.searchParams.set("team", input.teamId);
  return url.toString();
}

/** The one place the callback may send a browser: the setup's Connections tab. */
export function slackSetupReturnUrl(
  appUrl: string,
  setup: { id: string; projectId: string; alias: string },
  result: SlackSetupResult,
): string {
  const url = new URL(
    `/projects/${encodeURIComponent(setup.projectId)}/connections`,
    appUrl,
  );
  url.searchParams.set("environment", setup.alias);
  url.searchParams.set("slack", result);
  url.searchParams.set("setup", setup.id);
  return url.toString();
}

/** The bot scopes a stored manifest asked for. */
export function manifestBotScopes(manifest: Record<string, unknown>): string[] {
  const oauth = manifest.oauth_config;
  if (!oauth || typeof oauth !== "object") return [];
  const scopes = (oauth as { scopes?: { bot?: unknown } }).scopes?.bot;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
}
