/** The error envelope the API returns: `{ error: { type, message, code, param?, request_id } }`. */
export interface ApiErrorBody {
  type?: string;
  message?: string;
  code?: string;
  param?: string;
  request_id?: string;
}

/** Base error for every failed API call. Thrown (never returned). */
export class OpenComputerError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly type?: string;
  readonly param?: string;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody | undefined, fallback: string) {
    super(body?.message || fallback);
    this.name = "OpenComputerError";
    this.status = status;
    this.code = body?.code;
    this.type = body?.type;
    this.param = body?.param;
    this.requestId = body?.request_id;
  }
}

export class AuthError extends OpenComputerError { name = "AuthError"; }        // 401 / 403
export class NotFoundError extends OpenComputerError { name = "NotFoundError"; } // 404
export class ConflictError extends OpenComputerError { name = "ConflictError"; } // 409
export class ValidationError extends OpenComputerError { name = "ValidationError"; } // 422

export class RateLimitError extends OpenComputerError {
  name = "RateLimitError";
  /** Seconds to wait, from the `Retry-After` header, if present. */
  readonly retryAfter?: number;
  constructor(status: number, body: ApiErrorBody | undefined, fallback: string, retryAfter?: number) {
    super(status, body, fallback);
    this.retryAfter = retryAfter;
  }
}

export function errorFromResponse(
  status: number,
  body: ApiErrorBody | undefined,
  retryAfter?: number,
): OpenComputerError {
  const fallback = `OpenComputer request failed (${status})`;
  switch (status) {
    case 401:
    case 403: return new AuthError(status, body, fallback);
    case 404: return new NotFoundError(status, body, fallback);
    case 409: return new ConflictError(status, body, fallback);
    case 422: return new ValidationError(status, body, fallback);
    case 429: return new RateLimitError(status, body, fallback, retryAfter);
    default:  return new OpenComputerError(status, body, fallback);
  }
}
