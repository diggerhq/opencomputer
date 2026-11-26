// The session writer's interface (work 084): what serves one session's API, so
// the socket facade (socket.ts), the relay and the host's api-bridge see one
// shape whether the runner writes (runner/api/api.ts, a tap on its Session) or
// the host does because no runner runs (host/session-writer.ts).
//
// Invariants: one writer per session at a time, decided by the journal's flock
// (journal.ts); every write answers with the `seq` of the event it caused (the
// read-your-writes cursor); a subscriber gets every event with seq > its
// cursor exactly once and in order, then live ones, and is detached rather
// than allowed to fall unboundedly behind.

import type { ApiActor, ApiError, JournalDelta, JournalEvent } from '../protocol.js';

/**
 * The writer call that journals a host-side event (the host's wire-link: terminals, uploads). Not a
 * schema method, so the relay never forwards it from a client; only these types, data decoded strictly.
 */
export const RECORD_METHOD = 'host.record';
export const RECORDABLE = ['terminal.opened', 'terminal.closed', 'files.pushed'] as const;

/** Who is calling, as the relay or the gateway authenticated them. */
export interface CallContext {
  actor: ApiActor;
  /** `usr_…`: the idempotency scope. */
  member: string;
  idempotencyKey?: string;
  requestId?: string;
}

/** A call's outcome: the method's result body (schema-methods.ts METHODS[method].result), or an API error. */
export type CallOutcome = { result: unknown; error?: undefined } | { error: ApiError; result?: undefined };

export type DetachReason = 'too_far_behind' | 'moved' | 'access_lost' | 'epoch_changed';

export interface SubscribeOptions {
  /** Events with seq > after; absent with `tailTurns` absent: live only (after = lastSeq). */
  after?: number;
  /** The last N turns instead of `after` (the journal's sparse index). */
  tailTurns?: number;
  deltas: boolean;
  onEvent(event: JournalEvent): void;
  onDelta(delta: JournalDelta): void;
  /** The subscription ended on the writer's side (backlog over the limits, or the writer handed the journal on). */
  onDetached(reason: DetachReason): void;
  /** The host's mirror (api-bridge.ts), not a client: left out of `clients` (telemetry's api_clients), and given `subagent.progress` deltas alone. */
  mirror?: boolean;
}

/** The `sessions.attached` body less `sessionId`, as the writer knows it at subscribe time. */
export interface Attached {
  /** The Session object (schema-objects.ts Session). */
  session: unknown;
  /** The seq replay starts after; events follow the result. */
  after: number;
  lastSeq: number;
  epoch: number;
  /** The rest of AttachResult (schema-methods.ts), filled by SessionLog.subscribe. */
  logEpoch?: number;
  epochStartSeq?: number;
  capabilities?: unknown;
  earlierTurns?: unknown[] | null;
}

export interface Subscription {
  readonly attached: Attached;
  /** The client has everything up to `seq` (`sessions.ack`). */
  ack(seq: number): void;
  close(): void;
}

export interface Writer {
  readonly sessionId: string;
  /** Decodes `params` strictly (schema-methods.ts decodeParams) and runs `method`; never throws. */
  call(method: string, params: unknown, ctx: CallContext): Promise<CallOutcome>;
  subscribe(o: SubscribeOptions): Subscription | { error: ApiError };
}

/** An API error with its HTTP status (errors.mdx). */
export const apiError = (code: string, message: string, status: number, extra: Record<string, unknown> = {}): ApiError => ({
  code,
  message,
  status,
  ...extra,
});
