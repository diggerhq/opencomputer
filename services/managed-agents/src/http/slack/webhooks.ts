// The edge's Slack routes (tracks and threads, spec 40.11 step 1): Slack's events and
// interactions, the install and the unlink, all calling the Slack actor. The workspace →
// organization lookup is the team router, the Slack object named `slack-team:<teamId>`.

import { exchangeSlackOAuthCode } from "../../channels/slack-api.js";
import { verifySlackSignature } from "../../channels/slack-events.js";
import type { ComputerEdgeEnv } from "../../actors/computer/config.js";
import { publicOrigin, slackRedirectUri } from "../../actors/computer/config.js";
import { randomToken, sha256Hex } from "../../crypto/seal.js";
import type { Principal } from "../../auth/principal.js";
import { slackOf, type ActorEnv } from "../../actors/addresses.js";
import { decodeInstallState, encodeInstallState, parseInteraction, parseSlackEnvelope, slackAuthorizeUrl, slackTeamLinkName } from "../../slack-api/web-api.js";

export type SlackRouteEnv = ComputerEdgeEnv & ActorEnv;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const teamRouter = (env: SlackRouteEnv, teamId: string) => slackOf(env, `slack-team:${teamId}`);

/**
 * The organization a workspace is linked to. An organization the Slack actor has not
 * imported yet is claimed only in Computer's old router; its actor imports on first
 * touch and then claims the team in the Slack router.
 */
async function teamOrg(env: SlackRouteEnv, teamId: string): Promise<string | null> {
  const org = await teamRouter(env, teamId).teamOrg();
  if (org || !env.COMPUTERS) return org;
  const old = env.COMPUTERS.getByName(slackTeamLinkName(teamId)) as unknown as { teamAccount(): Promise<string | null> };
  return old.teamAccount();
}

function configured(env: SlackRouteEnv): boolean {
  return Boolean(env.SLACK && env.SLACK_COMPUTER_CLIENT_ID && env.SLACK_COMPUTER_CLIENT_SECRET && env.SLACK_COMPUTER_SIGNING_SECRET && env.SLACK_COMPUTER_SCOPES);
}

/** Slack's webhooks and the OAuth callback (their own authentication); null when the path is not one of them. */
export async function routeSlackPublic(request: Request, env: SlackRouteEnv, context: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/webhooks/computer/slack/events" && request.method === "POST") return events(request, env, context);
  if (url.pathname === "/v1/webhooks/computer/slack/interactivity" && request.method === "POST") return interactions(request, env);
  if (url.pathname === "/v1/computer/slack/callback" && request.method === "GET") return callback(env, url);
  return null;
}

/** The dashboard's install and unlink, as the caller's principal; null when the path is not one of them. */
export async function routeSlackDashboard(request: Request, env: SlackRouteEnv, principalOf: () => Promise<Principal | null>): Promise<Response | null> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route !== "POST /v1/computer/slack/install" && route !== "DELETE /v1/computer/slack") return null;
  const principal = await principalOf();
  if (!principal || principal.kind === "agent") return problem(403, "forbidden", "The computer is managed from the dashboard");
  if (!configured(env)) return problem(503, "computer_slack_not_configured", "The Slack app is not available yet");
  const slack = slackOf(env, principal.org);
  if (route === "POST /v1/computer/slack/install") {
    const nonce = randomToken();
    await slack.startInstall(principal, nonce);
    return json({
      url: slackAuthorizeUrl({
        clientId: env.SLACK_COMPUTER_CLIENT_ID!,
        scopes: env.SLACK_COMPUTER_SCOPES!,
        redirectUri: slackRedirectUri(env),
        state: encodeInstallState(principal.org, nonce),
      }),
    });
  }
  const teamId = (await slack.forHost()).slack?.teamId;
  if (!teamId) return problem(404, "computer_slack_not_installed", "No Slack workspace is linked");
  await slack.unlink(principal);
  await teamRouter(env, teamId).releaseTeam(principal.org);
  return new Response(null, { status: 204 });
}

/** The verified raw body, or the Response that ends the request. */
async function verified(request: Request, env: SlackRouteEnv): Promise<string | Response> {
  if (!env.SLACK || !env.SLACK_COMPUTER_SIGNING_SECRET) return problem(503, "computer_slack_not_configured", "The Slack app is not available yet");
  const raw = await request.text();
  if (!(await verifySlackSignature(raw, request.headers, env.SLACK_COMPUTER_SIGNING_SECRET))) return problem(401, "invalid_signature", "Invalid Slack signature");
  return raw;
}

async function events(request: Request, env: SlackRouteEnv, context: ExecutionContext): Promise<Response> {
  const raw = await verified(request, env);
  if (raw instanceof Response) return raw;
  let payload: { event_id?: unknown; team_id?: unknown };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return problem(400, "invalid_json", "Invalid JSON");
  }
  const parsed = parseSlackEnvelope(payload);
  if (parsed.kind === "challenge") return json({ challenge: parsed.challenge });
  const teamId = typeof payload.team_id === "string" ? payload.team_id : undefined;
  const eventId = typeof payload.event_id === "string" ? payload.event_id : undefined;
  if (!teamId || (parsed.kind !== "revoked" && (!eventId || parsed.kind === "ignored"))) return json({ ok: true });
  // Slack wants an answer within three seconds: the actor accepts after it.
  context.waitUntil(
    (async () => {
      const org = await teamOrg(env, teamId);
      if (!org) return console.warn(JSON.stringify({ level: "warn", event: "slack.team_unlinked", teamId }));
      if (parsed.kind === "revoked") return void (await releaseRevoked(env, teamId, org));
      await slackOf(env, org).accept({ kind: "event", id: eventId!, body: payload });
    })().catch((error) => console.error(JSON.stringify({ level: "error", event: "slack.event_failed", message: errorText(error) }))),
  );
  return json({ ok: true });
}

async function interactions(request: Request, env: SlackRouteEnv): Promise<Response> {
  const raw = await verified(request, env);
  if (raw instanceof Response) return raw;
  const interaction = parseInteraction(raw);
  if (!interaction) return problem(400, "invalid_payload", "Missing Slack interaction payload");
  const teamId = interaction.team?.id;
  const org = teamId ? await teamOrg(env, teamId) : null;
  if (!org) return new Response(null, { status: 200 });
  // Slack gives an interaction no id of its own: its trigger, else the hash of what was sent.
  const id = interaction.trigger_id ?? (await sha256Hex(raw));
  // A modal's answer goes back to Slack: errors keep it open, a view replaces it.
  try {
    const reply = await slackOf(env, org).interact(id, interaction);
    if (reply.errors) return json({ response_action: "errors", errors: reply.errors });
    if (reply.view) return json({ response_action: "update", view: reply.view });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "slack.interaction_failed", message: errorText(error) }));
  }
  return new Response(null, { status: 200 });
}

function redirect(env: SlackRouteEnv, outcome: { ok: true } | { ok: false; reason: string; notified?: boolean }): Response {
  const target = new URL(`${publicOrigin(env)}/computer`);
  if (outcome.ok) target.searchParams.set("slack", "connected");
  else {
    target.searchParams.set("slack", "error");
    target.searchParams.set("reason", outcome.reason);
    if (outcome.notified !== undefined) target.searchParams.set("notified", outcome.notified ? "1" : "0");
  }
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
}

/** The person who started the install, as a member of the organization. */
function installer(org: string, subject: string): Principal {
  return { org, subject, kind: "member", via: "dashboard", scopes: [], audiences: ["org", `member:${subject}`], admin: false, credential: { id: `slack-install:${subject}`, expiresAt: null } };
}

async function callback(env: SlackRouteEnv, url: URL): Promise<Response> {
  const fail = (reason: string) => redirect(env, { ok: false, reason });
  const slackError = url.searchParams.get("error");
  if (slackError) return fail(slackError === "access_denied" ? "access_denied" : "slack_error");
  const code = url.searchParams.get("code");
  const state = decodeInstallState(url.searchParams.get("state") ?? "");
  if (!code || !state) return fail("invalid_state");
  if (!configured(env)) return fail("not_configured");
  const org = state.accountId;
  const slack = slackOf(env, org);
  const consumed = await slack.consumeInstall(state.nonce);
  if (!consumed.ok) return fail(consumed.reason);
  let grant;
  try {
    grant = await exchangeSlackOAuthCode({ clientId: env.SLACK_COMPUTER_CLIENT_ID!, clientSecret: env.SLACK_COMPUTER_CLIENT_SECRET!, code, redirectUri: slackRedirectUri(env) });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "slack.oauth_failed", message: errorText(error) }));
    return fail("oauth_failed");
  }
  if (grant.isEnterpriseInstall) return fail("enterprise_install_unsupported");
  if (!grant.teamId || !grant.botUserId) return fail("oauth_failed");
  // One workspace links to one organization; a holder whose token is dead no longer holds it.
  let claim = await teamRouter(env, grant.teamId).claimTeam(grant.teamId, org);
  if (!claim.ok && (await releaseRevoked(env, grant.teamId, claim.holder))) claim = await teamRouter(env, grant.teamId).claimTeam(grant.teamId, org);
  if (!claim.ok) {
    // The holder's actor DMs the person who tried and its installer; the redirect never names the holder.
    let installerNotified = false;
    if (grant.authedUserId) {
      try {
        ({ installerNotified } = await slackOf(env, claim.holder).joinRequest(grant.teamId, grant.authedUserId));
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "slack.join_request_failed", message: errorText(error) }));
      }
    }
    return redirect(env, { ok: false, reason: "team_already_linked", notified: installerNotified });
  }
  const previousTeamId = (await slack.forHost()).slack?.teamId;
  await slack.install(installer(org, consumed.subject), {
    teamId: grant.teamId,
    teamName: grant.teamName ?? grant.teamId,
    botUserId: grant.botUserId,
    botToken: grant.accessToken,
    installerUserId: grant.authedUserId ?? "",
  });
  if (previousTeamId && previousTeamId !== grant.teamId) await teamRouter(env, previousTeamId).releaseTeam(org);
  console.log(JSON.stringify({ level: "info", event: "slack.linked", org, teamId: grant.teamId, by: consumed.subject }));
  return redirect(env, { ok: true });
}

/** Unlinks `holder` from `teamId` and frees the workspace when Slack says its token is dead. Whether it did; never throws. */
async function releaseRevoked(env: SlackRouteEnv, teamId: string, holder: string): Promise<boolean> {
  try {
    const { unlinked } = await slackOf(env, holder).unlinkRevoked(teamId);
    if (unlinked) await teamRouter(env, teamId).releaseTeam(holder);
    return unlinked;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "slack.release_failed", holder, teamId, message: errorText(error) }));
    return false;
  }
}
