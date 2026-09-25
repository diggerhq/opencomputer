import { APIError, type CreateSessionResult } from "./api.js";
import { CLIError, structuredError } from "./errors.js";

/**
 * Caller keys for the two mutations behind `session create "<prompt>"`.
 * Session creation and turn admission are separate idempotency domains, so
 * one `--idempotency-key` is never forwarded to both unchanged.
 */
export interface SessionCreateIdempotencyKeys {
  session?: string;
  turn?: string;
}

export function sessionCreateIdempotencyKeys(options: {
  idempotencyKey?: string;
  sessionIdempotencyKey?: string;
  turnIdempotencyKey?: string;
}): SessionCreateIdempotencyKeys {
  const root = options.idempotencyKey;
  const session =
    options.sessionIdempotencyKey ?? (root ? `session:${root}` : undefined);
  const turn = options.turnIdempotencyKey ?? (root ? `turn:${root}` : undefined);
  return {
    ...(session ? { session } : {}),
    ...(turn ? { turn } : {}),
  };
}

export interface SessionCreateOutcome {
  session: {
    id: string;
    created: boolean;
    duplicate: boolean;
    status?: string;
  };
  turn: {
    id: string | null;
    admitted: boolean;
    duplicate?: boolean;
    status?: "completed" | "failed";
    error?: { code: string; message: string };
  };
  complete: boolean;
}

export function sessionOutcome(
  created: CreateSessionResult,
): SessionCreateOutcome["session"] {
  return {
    id: created.session.id,
    created: created.created,
    duplicate: !created.created,
    ...(created.session.status ? { status: created.session.status } : {}),
  };
}

const TURN_CONFLICT_CODE = "turn_idempotency_conflict";

export function turnFailureCode(error: unknown): string {
  if (error instanceof APIError && error.status === 409) {
    return error.code === "idempotency_conflict"
      ? TURN_CONFLICT_CODE
      : (error.code ?? "conflict");
  }
  return structuredError(error).code;
}

/**
 * The compound command failed after the session was committed. The error
 * carries the session ID and what happened to the turn so callers can
 * retry unchanged (and converge) or clean the idle session up.
 */
export function sessionCreatedTurnFailed(
  session: SessionCreateOutcome["session"],
  turn: SessionCreateOutcome["turn"],
): CLIError {
  const code = turn.error?.code;
  const hint =
    code === TURN_CONFLICT_CODE
      ? `The turn key was already used with a different prompt on session ${session.id}. Repeat the earlier prompt unchanged, pass a new --turn-idempotency-key, or end the session with \`opencomputer session end ${session.id}\`.`
      : `Session ${session.id} exists${turn.admitted ? "" : " and is idle"}. Retry the same command with the same idempotency keys to converge on it, or end it with \`opencomputer session end ${session.id}\`.`;
  const message = turn.admitted
    ? `Session ${session.id} was created but turn ${turn.id ?? ""} failed: ${turn.error?.message ?? "unknown error"}`
    : `Session ${session.id} was created but the first turn was not admitted: ${turn.error?.message ?? "unknown error"}`;
  const outcome: SessionCreateOutcome = { session, turn, complete: false };
  return new CLIError("session_created_turn_failed", message, hint, outcome);
}
