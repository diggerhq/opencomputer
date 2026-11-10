// The `linear` provider: verification and parsing of the deliveries a
// customer's own Linear agent app sends to its connection's webhook URL
// (design 018, "Ingress, acceptance and acknowledgement"; work 037's compact
// Linear contract).
//
// Deliberately not a `ChannelAdapter` in the registry. That seam is shaped for
// a conversation of plain messages answered by `send(text)`: `parseInbound`
// yields one message or nothing, and replies go out through the adapter. A
// Linear delivery is one of three kinds (a conversational session event, a
// stop control on a session, a connection control such as a revocation), its
// replies are ordered, typed activities with persisted ids owned by the
// Session object's queue (work 037 S3), and its conversation map is the
// Account object's ledger, not `channel_threads`. Registering it would mean a
// `send` that cannot be honest and a provider listed where channels are
// declared. This module keeps the provider-shaped half (signature, freshness,
// payload shape) and nothing else.

import { bytesToHex, constantTimeEqual, hmac } from "./adapter.js";
import { isRecord, type AgentInputValue } from "../protocol.js";

export const LINEAR_PROVIDER = "linear" as const;

/** Linear's documented freshness window for `webhookTimestamp`. */
export const LINEAR_WEBHOOK_FRESHNESS_MS = 60_000;

/** Headers Linear sends with every webhook delivery. */
export const LINEAR_DELIVERY_HEADER = "linear-delivery";
export const LINEAR_EVENT_HEADER = "linear-event";
export const LINEAR_SIGNATURE_HEADER = "linear-signature";

/**
 * `Linear-Signature` is the hex HMAC-SHA256 of the raw body with the app's
 * signing secret. Compared in constant time.
 */
export async function verifyLinearSignature(
  payload: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  const expected = bytesToHex(await hmac("SHA-256", secret, payload));
  return constantTimeEqual(signature.trim().toLowerCase(), expected);
}

/** `|now − body.webhookTimestamp| ≤ 60 s`; a body without one is stale. */
export function linearWebhookFresh(body: unknown, now = Date.now()): boolean {
  if (!isRecord(body)) return false;
  const timestamp = body.webhookTimestamp;
  const at =
    typeof timestamp === "number"
      ? timestamp
      : typeof timestamp === "string"
        ? Number(timestamp)
        : Number.NaN;
  return Number.isFinite(at) && Math.abs(now - at) <= LINEAR_WEBHOOK_FRESHNESS_MS;
}

export type LinearVerification =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: "invalid_signature" | "invalid_body" | "stale" };

/** Signature over the raw bytes first, then the body's own timestamp. */
export async function verifyLinearDelivery(input: {
  payload: string;
  signature: string | null;
  secret: string;
  now?: number;
}): Promise<LinearVerification> {
  if (!(await verifyLinearSignature(input.payload, input.signature, input.secret))) {
    return { ok: false, reason: "invalid_signature" };
  }
  let body: unknown;
  try {
    body = JSON.parse(input.payload);
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_body" };
  if (!linearWebhookFresh(body, input.now)) return { ok: false, reason: "stale" };
  return { ok: true, body };
}

// ── Parsed deliveries ─────────────────────────────────────────────────────────

export interface LinearIssueFacts {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  team: { id: string; key: string; name: string };
}

/** The prompt activity of a `prompted` event. */
export interface LinearPromptActivity {
  id: string;
  /** When the person wrote it (provider time); the order that matters. */
  createdAt: string;
  body: string;
  signal: string | null;
  userId?: string;
  sourceCommentId?: string;
}

/** `AgentSessionEvent` `created` or `prompted`, typed. */
export interface LinearSessionEvent {
  kind: "session";
  action: "created" | "prompted";
  /** True for a `prompted` whose activity carries `signal: "stop"`. */
  stop: boolean;
  organizationId: string;
  oauthClientId?: string;
  appUserId?: string;
  /** The event's own `createdAt`. */
  createdAt: string;
  agentSessionId: string;
  /** When the agent session itself was created, when the payload says. */
  sessionCreatedAt?: string;
  issueId?: string;
  /** The issue as the delivery carried it; null when incomplete. */
  issue: LinearIssueFacts | null;
  session: {
    id: string;
    url?: string;
    creator?: { id: string; name: string };
    commentId?: string;
  };
  comment?: { id: string; body: string };
  activity?: LinearPromptActivity;
  promptContext?: string;
  previousComments?: AgentInputValue;
  guidance?: AgentInputValue;
}

export interface LinearRevokedEvent {
  kind: "revoked";
  organizationId?: string;
  oauthClientId?: string;
  createdAt: string;
}

export interface LinearTeamAccessEvent {
  kind: "teams";
  organizationId?: string;
  createdAt: string;
  canAccessAllPublicTeams: boolean;
  addedTeamIds: string[];
  removedTeamIds: string[];
}

/** A verified delivery we do not act on (e.g. `OAuthAuthorization created`). */
export interface LinearIgnoredEvent {
  kind: "ignored";
  type: string;
  action: string;
}

export type LinearWebhookEvent =
  | LinearSessionEvent
  | LinearRevokedEvent
  | LinearTeamAccessEvent
  | LinearIgnoredEvent;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timeText(value: unknown, fallback: string): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function jsonValue(value: unknown): AgentInputValue | undefined {
  if (value === undefined || value === null) return undefined;
  // A round trip keeps only JSON, which is what a turn input may carry.
  return JSON.parse(JSON.stringify(value)) as AgentInputValue;
}

function issueFacts(value: unknown): LinearIssueFacts | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const identifier = text(value.identifier);
  const url = text(value.url);
  const team = isRecord(value.team) ? value.team : null;
  const teamId = text(team?.id) ?? text(value.teamId);
  if (!id || !identifier || !url || !teamId) return null;
  return {
    id,
    identifier,
    title: typeof value.title === "string" ? value.title : "",
    description: typeof value.description === "string" ? value.description : null,
    url,
    team: {
      id: teamId,
      key: typeof team?.key === "string" ? team.key : "",
      name: typeof team?.name === "string" ? team.name : "",
    },
  };
}

function parseSessionEvent(
  body: Record<string, unknown>,
  action: "created" | "prompted",
): LinearSessionEvent | null {
  const session = isRecord(body.agentSession) ? body.agentSession : null;
  const agentSessionId = text(session?.id) ?? text(body.agentSessionId);
  const organizationId = text(body.organizationId);
  if (!session || !agentSessionId || !organizationId) return null;
  const createdAt = timeText(body.createdAt, new Date().toISOString());
  const rawActivity = isRecord(body.agentActivity) ? body.agentActivity : null;
  let activity: LinearPromptActivity | undefined;
  if (rawActivity) {
    const content = isRecord(rawActivity.content) ? rawActivity.content : null;
    const id = text(rawActivity.id);
    if (id) {
      activity = {
        id,
        createdAt: timeText(rawActivity.createdAt, createdAt),
        body:
          typeof content?.body === "string"
            ? content.body
            : typeof rawActivity.body === "string"
              ? rawActivity.body
              : "",
        signal: typeof rawActivity.signal === "string" ? rawActivity.signal : null,
        ...(text(rawActivity.userId) ? { userId: text(rawActivity.userId) } : {}),
        ...(text(rawActivity.sourceCommentId)
          ? { sourceCommentId: text(rawActivity.sourceCommentId) }
          : {}),
      };
    }
  }
  // A prompt without its activity has nothing to admit.
  if (action === "prompted" && !activity) return null;
  const creator = isRecord(session.creator) ? session.creator : null;
  const creatorId = text(creator?.id) ?? text(session.creatorId);
  const rawComment = isRecord(session.comment) ? session.comment : null;
  const comment =
    text(rawComment?.id) && typeof rawComment?.body === "string"
      ? { id: rawComment.id as string, body: rawComment.body }
      : undefined;
  const issue = issueFacts(session.issue);
  const previousComments = jsonValue(body.previousComments);
  const guidance = jsonValue(body.guidance);
  return {
    kind: "session",
    action,
    stop: action === "prompted" && activity?.signal === "stop",
    organizationId,
    ...(text(body.oauthClientId) ? { oauthClientId: text(body.oauthClientId) } : {}),
    ...(text(body.appUserId) ? { appUserId: text(body.appUserId) } : {}),
    createdAt,
    agentSessionId,
    ...(session.createdAt !== undefined
      ? { sessionCreatedAt: timeText(session.createdAt, createdAt) }
      : {}),
    ...((text(session.issueId) ?? issue?.id)
      ? { issueId: text(session.issueId) ?? issue?.id }
      : {}),
    issue,
    session: {
      id: agentSessionId,
      ...(text(session.url) ? { url: text(session.url) } : {}),
      ...(creatorId
        ? {
            creator: {
              id: creatorId,
              name: typeof creator?.name === "string" ? creator.name : "",
            },
          }
        : {}),
      ...(text(session.commentId) ? { commentId: text(session.commentId) } : {}),
    },
    ...(comment ? { comment } : {}),
    ...(activity ? { activity } : {}),
    ...(typeof body.promptContext === "string" && body.promptContext
      ? { promptContext: body.promptContext }
      : {}),
    ...(previousComments !== undefined ? { previousComments } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
  };
}

/**
 * A verified body, typed. Null means the body claims a type we handle but is
 * malformed: the caller answers 400, stores nothing, and Linear's retry
 * cannot fix it either.
 */
export function parseLinearWebhook(body: Record<string, unknown>): LinearWebhookEvent | null {
  const type = typeof body.type === "string" ? body.type : "";
  const action = typeof body.action === "string" ? body.action : "";
  const createdAt = timeText(body.createdAt, new Date().toISOString());
  if (type === "AgentSessionEvent" && (action === "created" || action === "prompted")) {
    return parseSessionEvent(body, action);
  }
  if (type === "OAuthApp" && action === "revoked") {
    return {
      kind: "revoked",
      ...(text(body.organizationId) ? { organizationId: text(body.organizationId) } : {}),
      ...(text(body.oauthClientId) ? { oauthClientId: text(body.oauthClientId) } : {}),
      createdAt,
    };
  }
  if (type === "PermissionChange" && action === "teamAccessChanged") {
    return {
      kind: "teams",
      ...(text(body.organizationId) ? { organizationId: text(body.organizationId) } : {}),
      createdAt,
      canAccessAllPublicTeams: body.canAccessAllPublicTeams === true,
      addedTeamIds: stringList(body.addedTeamIds),
      removedTeamIds: stringList(body.removedTeamIds),
    };
  }
  return { kind: "ignored", type, action };
}
