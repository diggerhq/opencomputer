// The one error the management client throws. The API answers every failure
// with `{ error: { code, message } }` (docs/agents/api.mdx, "Errors"); a
// missing key or an unknown route answers `{ error: "<text>" }` without a
// code. Both land here as `{ code, status, message }`, with `code` filled from
// the status when the body carried none, so a caller always has one string to
// branch on.

/**
 * The wire envelope: `{ error: { code, message } }` or `{ error: "<text>" }`.
 * An error the API ties to a session names it beside the code
 * (`session_publication_unconfirmed` carries `sessionId`).
 */
export interface ApiErrorEnvelope {
  error?: { code?: string; message?: string; sessionId?: string } | string;
}

/** What an error carries beside its status, code and message. */
export interface OpenComputerErrorDetails {
  /** Seconds to wait before retrying, from `Retry-After`, when the API sent one. */
  retryAfter?: number;
  /** The session the failure concerns, when the API named one. */
  sessionId?: string;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

export class OpenComputerError extends Error {
  /** The API's stable error code, or one derived from the status when the body had none. */
  readonly code: string;
  /** The HTTP status. */
  readonly status: number;
  /** Seconds to wait before retrying, from `Retry-After`, when the API sent one. */
  readonly retryAfter?: number;
  /**
   * The session the failure concerns, when the API named one:
   * `session_publication_unconfirmed` carries the id of the session that
   * exists, or whose labels are recorded, but is not confirmed in the list
   * yet. The client does not retry; the caller repeats the same call.
   */
  readonly sessionId?: string;

  constructor(
    status: number,
    code: string | undefined,
    message: string | undefined,
    details: OpenComputerErrorDetails = {},
  ) {
    super(message || `OpenComputer request failed (${status})`);
    this.name = "OpenComputerError";
    this.status = status;
    this.code = code || CODE_BY_STATUS[status] || (status >= 500 ? "unavailable" : "request_failed");
    if (details.retryAfter !== undefined) this.retryAfter = details.retryAfter;
    if (details.sessionId !== undefined) this.sessionId = details.sessionId;
  }
}

/** Builds the error for a failed response from its status, parsed body and headers. */
export function errorFromResponse(status: number, body: unknown, headers?: Headers): OpenComputerError {
  const envelope = body && typeof body === "object" ? (body as ApiErrorEnvelope) : undefined;
  const error = envelope?.error;
  const fields = typeof error === "object" && error ? error : undefined;
  const message = typeof error === "string" ? error : fields?.message;
  const retryAfterHeader = headers?.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  const details: OpenComputerErrorDetails = {};
  if (Number.isFinite(retryAfter) && retryAfter > 0) details.retryAfter = retryAfter;
  if (typeof fields?.sessionId === "string" && fields.sessionId) details.sessionId = fields.sessionId;
  return new OpenComputerError(status, fields?.code, message, details);
}
