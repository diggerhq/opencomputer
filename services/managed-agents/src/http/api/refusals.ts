// An actor's refusal, or a check made here, as the declared public error (errors.ts) with this
// request's id.

import * as Effect from "effect/Effect";

import type { Refusal } from "../../actor/contracts.js";
import { CurrentRequest } from "./caller.js";
import { type ApiError, Conflict, Forbidden, InvalidRequest, NotFound, Unauthenticated, Unavailable } from "../../contract/errors.js";

export const BY_STATUS = { 400: InvalidRequest, 401: Unauthenticated, 403: Forbidden, 404: NotFound, 409: Conflict, 503: Unavailable } as const;

/** The public error for `status`, with this request's id. */
export const apiError = (status: keyof typeof BY_STATUS, code: string, message: string, extra: Record<string, unknown> = {}) =>
  CurrentRequest.use(({ requestId }) => failWith(requestId, status, code, message, extra));

export const failWith = (requestId: string, status: keyof typeof BY_STATUS, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Effect.fail(new BY_STATUS[status]({ error: { ...extra, code, message, requestId, retryable: status === 503 } }) as ApiError);

/** An actor's refusal as the public error (statuses outside the declared set are a 409). */
export function fromRefusal(r: Refusal) {
  const { ok: _ok, code, status, message, ...extra } = r;
  const declared = status !== undefined && status in BY_STATUS ? (status as keyof typeof BY_STATUS) : code.endsWith("_not_found") ? 404 : 409;
  return apiError(declared, code, message ?? `Refused: ${code}.`, extra);
}
