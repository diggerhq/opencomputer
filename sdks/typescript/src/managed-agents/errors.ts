// The one error the management client throws. The API answers every failure
// with `{ error: { code, message } }` (docs/agents/api.mdx, "Errors"); a
// missing key or an unknown route answers `{ error: "<text>" }` without a
// code. Both land here as `{ code, status, message }`, with `code` filled from
// the status when the body carried none, so a caller always has one string to
// branch on.

/** The wire envelope: `{ error: { code, message } }` or `{ error: "<text>" }`. */
export interface ApiErrorEnvelope {
  error?: { code?: string; message?: string } | string;
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

  constructor(status: number, code: string | undefined, message: string | undefined, retryAfter?: number) {
    super(message || `OpenComputer request failed (${status})`);
    this.name = "OpenComputerError";
    this.status = status;
    this.code = code || CODE_BY_STATUS[status] || (status >= 500 ? "unavailable" : "request_failed");
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** Builds the error for a failed response from its status, parsed body and headers. */
export function errorFromResponse(status: number, body: unknown, headers?: Headers): OpenComputerError {
  const envelope = body && typeof body === "object" ? (body as ApiErrorEnvelope) : undefined;
  const error = envelope?.error;
  const code = typeof error === "object" && error ? error.code : undefined;
  const message = typeof error === "string" ? error : typeof error === "object" && error ? error.message : undefined;
  const retryAfterHeader = headers?.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  return new OpenComputerError(
    status,
    code,
    message,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}
