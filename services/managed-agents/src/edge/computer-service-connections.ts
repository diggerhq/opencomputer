/**
 * The dashboard's view of what the organization's computer may use
 * (work 080): `/v1/computer/service-connections`.
 *
 * - GET lists every grant, including thread and personal ones made in Slack, so
 *   the dashboard is one place to audit what the computer can reach.
 * - POST grants a connection to everyone on the computer: only an organization
 *   admin, and only with a connection of their own. The dashboard has no thread
 *   or Slack user to bind a narrower grant to; those come from Slack.
 * - DELETE revokes a connection's grants (all, or one scope and subject): its
 *   owner or an admin.
 *
 * The computer itself never reaches these: it uses grants, a person makes them.
 */

import type { ComputerGrantScope, ComputerServiceAttachment, Connection } from "../protocol.js";
import type { RequestIdentity } from "./auth.js";
import type { AccountDurableObject } from "./account-do.js";

export const COMPUTER_SERVICE_CONNECTIONS = "/v1/computer/service-connections";

const SCOPES: readonly ComputerGrantScope[] = ["session", "user", "everyone"];

interface Env {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
}

type PublicConnection = Omit<Connection, "ownerUserId" | "externalAccountId" | "agentId" | "alias" | "kind">;

export function computerServiceAttachmentResponse(
  attachment: ComputerServiceAttachment,
): Omit<ComputerServiceAttachment, "connection"> & { connection: PublicConnection } {
  const c = attachment.connection;
  return {
    service: attachment.service,
    provider: attachment.provider,
    label: attachment.label,
    connectionId: attachment.connectionId,
    connection: {
      id: c.id,
      provider: c.provider,
      label: c.label,
      displayName: c.displayName,
      scopes: c.scopes,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    },
    scope: attachment.scope,
    subject: attachment.subject,
    grantedBy: attachment.grantedBy,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** The route's response, or null when the request is for another route. */
export async function routeComputerServiceConnections(
  request: Request,
  env: Env,
  identity: RequestIdentity,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== COMPUTER_SERVICE_CONNECTIONS) return null;
  if (identity.principal || identity.kind !== "user" || identity.projectId) {
    return problem(403, "forbidden", "The computer's connections are managed by people, from the dashboard or Slack");
  }
  const account = env.ACCOUNTS.getByName(identity.accountId);
  const admin = identity.role === "admin";

  if (request.method === "GET") {
    const service = url.searchParams.get("service") ?? undefined;
    const attachments = await account.listComputerServiceAttachments(service);
    return Response.json({ attachments: attachments.map(computerServiceAttachmentResponse) });
  }
  if (request.method !== "POST" && request.method !== "DELETE") {
    return problem(405, "method_not_allowed", "Use GET, POST or DELETE");
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
  if (!connectionId) return problem(400, "connection_id_required", "A connection ID is required");

  if (request.method === "POST") {
    if (!admin) return problem(403, "forbidden", "Only an organization admin can grant a connection to everyone on the computer");
    // Only the owner attaches their connection, as for projects.
    if (!(await account.getConnectionForUser(connectionId, identity.userId))) {
      return problem(404, "connection_not_found", "Connection not found");
    }
    try {
      const attachment = await account.grantComputerServiceConnection({
        connectionId,
        scope: "everyone",
        subject: "",
        grantedBy: identity.userId,
      });
      return Response.json(computerServiceAttachmentResponse(attachment), { status: 201 });
    } catch (error) {
      return problem(
        409,
        "connection_not_attachable",
        error instanceof Error ? error.message : "Connection cannot be granted to the computer",
      );
    }
  }

  const scope = body?.scope;
  if (scope !== undefined && !SCOPES.includes(scope as ComputerGrantScope)) {
    return problem(400, "invalid_scope", "scope must be session, user or everyone");
  }
  const subject = body?.subject;
  if (subject !== undefined && typeof subject !== "string") {
    return problem(400, "invalid_subject", "subject must be a string");
  }
  const connection = await account.getConnection(connectionId);
  if (!connection || (!admin && connection.ownerUserId !== identity.userId)) {
    return problem(404, "connection_not_found", "Connection not found");
  }
  const revoked = await account.revokeComputerServiceConnection({
    connectionId,
    ...(scope !== undefined ? { scope: scope as ComputerGrantScope } : {}),
    ...(typeof subject === "string" ? { subject } : {}),
  });
  return revoked > 0
    ? new Response(null, { status: 204 })
    : problem(404, "attachment_not_found", "The computer has no such grant");
}
