// `POST /tickets` (work 084): a short-lived credential a browser can put in
// the `opc.ticket.<t>` subprotocol, since it cannot set headers on an
// upgrade. The route (routes.ts) resolves the key, refuses project keys and
// rate-limits; this module validates the body and mints. The wire Worker
// alone verifies (src/wire/ticket.ts).
//
// A dashboard login gets one too (work 113): without `keyId`, always
// read-only, and labelled `dashboard…` so the relay's actor says so. With
// `terminal: true` and one session (web terminal MVP), a login's ticket opens
// terminals in that session instead; the route checks the member may open one in it.

import { WIRE_CLIENT } from "../wire/auth.js";
import { SESSION_ID, TICKET_MAX_SESSIONS, TICKET_TTL_MS, TicketTooLongError, mintTicket as mintWireTicket } from "../wire/ticket.js";
import { DEFAULT_WIRE_URL } from "./config.js";

export interface TicketEnv {
  WIRE_TICKET_KEY?: string;
  WIRE_PUBLIC_URL?: string;
}

export interface TicketRequest {
  client: string;
  sessionIds?: string[];
  readOnly?: boolean;
  /** A dashboard login's terminal ticket, for the one session in `sessionIds`. */
  terminal?: true;
}

export interface TicketFieldError {
  /** Dotted path, indexes in brackets: `sessionIds[2]`. */
  field: string;
  message: string;
}

export type TicketRequestValidation = { ok: true; value: TicketRequest } | { ok: false; errors: TicketFieldError[] };

export interface MintTicketInput extends TicketRequest {
  org: string;
  member: string;
  computer: string;
  tunnelId: string;
  /** The minting API key's id; absent for a dashboard login, whose ticket is read-only whatever `readOnly` says, unless `terminal`. */
  keyId?: string;
}

/** A login ticket's client label: the caller's own when it already says `dashboard`, else plain `dashboard`. */
export const dashboardClient = (client: string) => (client.startsWith("dashboard") ? client : "dashboard");

export interface MintedTicket {
  token: string;
  url: string;
  /** ISO 8601. */
  expiresAt: string;
  expiresInMs: number;
}

const FIELDS = new Set(["client", "sessionIds", "readOnly", "terminal"]);

/** The request's User-Agent as a ticket's default client: printable ASCII without `|`, cut to 64. */
export function clientFromHeader(userAgent: string | null | undefined): string {
  return (userAgent ?? "").replace(/[^\x20-\x7b\x7d\x7e]/g, "").slice(0, 64).trim();
}

/**
 * Validates a `POST /tickets` body (absent or `{}` is fine). Unknown fields,
 * a client that is not printable ASCII up to 64 characters, more than 20 or
 * malformed `sessionIds`, a non-boolean `readOnly`, or a `terminal` that is
 * not `true` with exactly one session id and no `readOnly` are field errors, for
 * `400 invalid_request` with the first one's `field`.
 */
export function validateTicketRequest(body: unknown, userAgent?: string | null): TicketRequestValidation {
  if (body === undefined || body === null) return { ok: true, value: { client: clientFromHeader(userAgent) } };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: [{ field: "", message: "The body must be a JSON object." }] };
  const errors: TicketFieldError[] = [];
  const input = body as Record<string, unknown>;
  for (const field of Object.keys(input)) if (!FIELDS.has(field)) errors.push({ field, message: `Unknown field ${field}.` });

  let client = clientFromHeader(userAgent);
  if (input.client !== undefined) {
    if (typeof input.client !== "string" || !WIRE_CLIENT.test(input.client)) {
      errors.push({ field: "client", message: "client must be printable ASCII, at most 64 characters, without |." });
    } else client = input.client;
  }

  let sessionIds: string[] | undefined;
  if (input.sessionIds !== undefined) {
    if (!Array.isArray(input.sessionIds)) errors.push({ field: "sessionIds", message: "sessionIds must be an array of session ids." });
    else if (input.sessionIds.length > TICKET_MAX_SESSIONS) errors.push({ field: "sessionIds", message: `At most ${TICKET_MAX_SESSIONS} sessionIds.` });
    else {
      input.sessionIds.forEach((id, index) => {
        if (typeof id !== "string" || !SESSION_ID.test(id)) errors.push({ field: `sessionIds[${index}]`, message: "Not a session id." });
      });
      sessionIds = [...new Set(input.sessionIds as string[])];
    }
  }

  let readOnly: boolean | undefined;
  if (input.readOnly !== undefined) {
    if (typeof input.readOnly !== "boolean") errors.push({ field: "readOnly", message: "readOnly must be a boolean." });
    else readOnly = input.readOnly;
  }

  let terminal: true | undefined;
  if (input.terminal !== undefined) {
    if (input.terminal !== true) errors.push({ field: "terminal", message: "terminal must be true." });
    else if (sessionIds?.length !== 1) errors.push({ field: "sessionIds", message: "A terminal ticket names exactly one session." });
    else if (input.readOnly !== undefined) errors.push({ field: "readOnly", message: "A terminal ticket is not read-only." });
    else terminal = true;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { client, ...(sessionIds ? { sessionIds } : {}), ...(readOnly ? { readOnly } : {}), ...(terminal ? { terminal } : {}) } };
}

/**
 * Mints a ticket for `POST /tickets`: `{ticket: <this>}` is the response body.
 * Throws when WIRE_TICKET_KEY is unset, and TicketTooLongError when the
 * claims do not fit 1024 characters (answer 400 `invalid_request`, field `sessionIds`).
 */
export async function mintTicket(env: TicketEnv, input: MintTicketInput, now = Date.now()): Promise<MintedTicket> {
  if (!env.WIRE_TICKET_KEY) throw new Error("WIRE_TICKET_KEY is not set");
  const { org, member, computer, tunnelId, keyId, client, sessionIds, readOnly, terminal } = input;
  const sessions = sessionIds ? { sessionIds } : {};
  const token = await mintWireTicket(
    env.WIRE_TICKET_KEY,
    keyId !== undefined
      ? { org, member, computer, tunnelId, keyId, client, scope: { ...sessions, ...(readOnly ? { readOnly } : {}) } }
      : { org, member, computer, tunnelId, login: true, client: dashboardClient(client), scope: terminal ? { ...sessions, terminal } : { ...sessions, readOnly: true } },
    now,
  );
  return {
    token,
    url: env.WIRE_PUBLIC_URL || DEFAULT_WIRE_URL,
    expiresAt: new Date(now + TICKET_TTL_MS).toISOString(),
    expiresInMs: TICKET_TTL_MS,
  };
}

export { TicketTooLongError };
