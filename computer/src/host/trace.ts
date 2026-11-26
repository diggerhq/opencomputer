// Trace context on the host (work 054, "Host agent"): the envelope fields a
// trace gives every host event, and the events a runner's exit emits.
//
// Invariants: pure. A missing trace gives just the session key.

import type { TraceContext } from '../protocol.js';
import { type Dimensions, tbTime } from '../telemetry/envelope.js';
import type { Telemetry } from '../telemetry/emitter.js';

/** Envelope fields for an event about this session and (if any) this message. */
export function traceFields(sessionKey: string, trace?: TraceContext): Dimensions & { synthetic?: boolean } {
  if (!trace) return { session_key: sessionKey };
  return {
    session_key: sessionKey,
    trace_id: trace.id,
    sent_at: Number.isFinite(trace.sentAt) ? tbTime(trace.sentAt) : undefined,
    surface: trace.surface,
    surface_workspace_id: trace.surfaceWorkspaceId,
    conversation_id: trace.conversationId,
    person_id: trace.personId,
    gateway_session_id: trace.gatewaySessionId,
    synthetic: trace.synthetic,
    path: trace.path,
  };
}

/** A runner a start launched: whether it resumed a session, or claimed a spare (work 069). */
export interface ColdStart {
  resumed: boolean;
  prewarmed?: boolean;
}

/** Why a runner's socket closed, as the host saw it. */
export function exitReason(r: { exiting?: boolean; report?: { status: string } }): 'idle' | 'stopped' | 'unknown' {
  if (r.exiting) return 'idle';
  return r.report?.status === 'stopped' ? 'stopped' : 'unknown';
}

/** Telemetry for the session's runner going away; `turn.abandoned` if it went mid-turn. */
export function runnerGone(tm: Telemetry, r: { key: string; connectedAt: number; exiting?: boolean; report?: { status: string } }) {
  const busy = r.report?.status === 'busy';
  const exit_reason = exitReason(r);
  tm.emit('runner.exited', { session_key: r.key, duration_ms: Date.now() - r.connectedAt, data: { busy, exit_reason, last_status: r.report?.status } });
  if (busy)
    tm.emit('turn.abandoned', { ...traceFields(r.key), outcome: 'abandoned', data: { exit_reason } });
}
