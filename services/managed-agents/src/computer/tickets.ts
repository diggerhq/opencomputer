// `POST /tickets` (work 084): a short-lived credential a browser can put in
// the `opc.ticket.<t>` subprotocol, since it cannot set headers on an
// upgrade. The route (routes.ts) resolves the key, refuses project keys and
// rate-limits; this module validates the body and mints. The wire Worker
// alone verifies (src/wire/ticket.ts).

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
  keyId: string;
}

export interface MintedTicket {
  token: string;
  url: string;
  /** ISO 8601. */
  expiresAt: string;
  expiresInMs: number;
}

const FIELDS = new Set(["client", "sessionIds", "readOnly"]);

/** The request's User-Agent as a ticket's default client: printable ASCII without `|`, cut to 64. */
export function clientFromHeader(userAgent: string | null | undefined): string {
  return (userAgent ?? "").replace(/[^\x20-\x7b\x7d\x7e]/g, "").slice(0, 64).trim();
}

/**
 * Validates a `POST /tickets` body (absent or `{}` is fine). Unknown fields,
 * a client that is not printable ASCII up to 64 characters, more than 20 or
 * malformed `sessionIds`, or a non-boolean `readOnly` are field errors, for
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

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { client, ...(sessionIds ? { sessionIds } : {}), ...(readOnly ? { readOnly } : {}) } };
}

/**
 * Mints a ticket for `POST /tickets`: `{ticket: <this>}` is the response body.
 * Throws when WIRE_TICKET_KEY is unset, and TicketTooLongError when the
 * claims do not fit 1024 characters (answer 400 `invalid_request`, field `sessionIds`).
 */
export async function mintTicket(env: TicketEnv, input: MintTicketInput, now = Date.now()): Promise<MintedTicket> {
  if (!env.WIRE_TICKET_KEY) throw new Error("WIRE_TICKET_KEY is not set");
  const { org, member, computer, tunnelId, keyId, client, sessionIds, readOnly } = input;
  const token = await mintWireTicket(
    env.WIRE_TICKET_KEY,
    { org, member, computer, tunnelId, keyId, client, scope: { ...(sessionIds ? { sessionIds } : {}), ...(readOnly ? { readOnly } : {}) } },
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
