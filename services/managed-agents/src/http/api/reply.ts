// The API's responses: JSON with the request id and `Server-Timing`, and the errors of spec 34.2 an actor's
// refusal becomes.

import type { ApiReply } from "../../actors/computer/contract.js";
import type { EntryError, EventsReset, LogReadRefusal } from "../../actors/session-log/contract.js";
import type { Refusal } from "../../durable/rpc-reply.js";
import type { RequestFacts } from "./request-facts.js";

/** A SessionLog read refused, a reset included (session-log/contract.ts). */
export type LogRefused = LogReadRefusal | EventsReset;

export class Reply {
  readonly started = performance.now();
  readonly facts: RequestFacts = { op: "unknown", doMs: 0, logMs: 0 };
  constructor(readonly requestId: string) {}

  send(status: number, body: unknown): Response {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": this.requestId,
      "server-timing": `blue;dur=${(performance.now() - this.started).toFixed(1)}`,
    });
    return new Response(status === 204 || status === 304 ? null : JSON.stringify(body), { status, headers });
  }

  error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
    this.facts.errorCode = code;
    const retryable = extra.retryable ?? (status === 429 || status === 500 || status === 503 || code === "queue_full");
    const response = this.send(status, { error: { ...extra, code, message, requestId: this.requestId, retryable } });
    if (typeof extra.retryAfterMs === "number") response.headers.set("retry-after", String(Math.max(1, Math.ceil(extra.retryAfterMs / 1000))));
    return response;
  }

  of(reply: ApiReply): Response {
    if ((reply.body as { duplicate?: unknown } | undefined)?.duplicate === true) this.facts.replayed = true;
    if (reply.error) {
      const { code, message, ...extra } = reply.error;
      return this.error(reply.status, code, message, extra);
    }
    return this.send(reply.status, reply.body);
  }
}

const STATUS_OF: Record<string, number> = {
  invalid_request: 400,
  forbidden: 403,
  principal_mismatch: 403,
  not_found: 404,
  session_not_found: 404,
  refused: 409,
  taken: 409,
  conflict: 409,
  idempotency_conflict: 409,
  reset: 409,
  agent_turns: 409,
  inbox_full: 429,
  unavailable: 503,
  computer_unavailable: 503,
  // The host's refusals of a delivered entry (spec 40.2); the host's own `status` comes first (an entry refused before it was kept had none).
  ask_closed: 409,
  session_busy: 409,
  turn_not_cancellable: 409,
  subagent_ended: 409,
  feature_unavailable: 409,
  queue_full: 429,
  insufficient_credits: 402,
  model_refused: 403,
};
export const statusOf = (code: string, status?: unknown): number =>
  typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600 ? status : (STATUS_OF[code] ?? (code.endsWith("_not_found") ? 404 : 400));

/** An actor's refusal as the HTTP error of spec 34.2. */
export function refusalOf(out: Reply, r: Refusal): Response {
  const { ok: _ok, code, status, message, ...extra } = r;
  return out.error(statusOf(code, status), code, message ?? `Refused: ${code}.`, extra);
}

/** A host's refusal of a delivered entry (`ask_closed`, `queue_full`, …), with its own status when it has one. */
export function hostErrorOf(out: Reply, error: EntryError): Response {
  const { code, message, status, ...extra } = error;
  return out.error(typeof status === "number" || code in STATUS_OF ? statusOf(code, status) : 500, code, message, extra);
}

/** A SessionLog read's refusal: `reset` is 409 with its cursor; one the caller may not see is `not_found`. */
export function logRefusalOf(out: Reply, r: LogRefused): Response {
  if (r.error === "reset") return out.error(409, "reset", "The cursor's position no longer exists.", { cursor: r.cursor ?? null, ...(r.seq !== undefined ? { seq: r.seq } : {}) });
  if (r.error === "invalid_cursor") return out.error(409, "reset", "The cursor cannot be read.", { cursor: null });
  if (r.error === "unavailable") return out.error(503, "unavailable", "The session has not reached minSeq yet.", { retryAfterMs: r.retryAfterMs ?? 1_000 });
  if (r.error === "not_found") return out.error(404, "session_not_found", "No such session.");
  return out.error(404, r.error, `No such ${r.error.replace(/_not_found$/, "")}.`);
}

export const strip = <T extends { ok: true }>(r: T): Omit<T, "ok"> => {
  const { ok: _ok, ...rest } = r;
  return rest;
};
