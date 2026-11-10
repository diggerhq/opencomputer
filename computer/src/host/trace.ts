// Trace context on the host (work 054, "Host agent"): the envelope fields a
// delivery's trace gives every host event, the path decision the host adds
// before forwarding, and the last forwarded trace per session kept in
// `<SP_RUN>/traces/<key>.trace.json`, so `turn.abandoned` can name the
// trace even after a host restart; and the events a runner's exit emits.
//
// Invariants: pure apart from the trace file, whose reads and writes never
// throw. A missing trace gives just the session key: older gateways send none.
// The traces directory is the host's alone (0700): runners/ is writable by the
// sessions' user, who could plant a FIFO or symlink where the host writes.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { TraceContext } from '../protocol.js';
import path from 'node:path';
import { HOST_RUN } from '../protocol.js';
import { keyName } from '../ipc.js';
import { type Dimensions, type TurnPath, tbTime } from '../telemetry/envelope.js';
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

/** How a turn started, decided after `ensureRunner`: no process launched → warm; a spare claimed → prewarmed. */
export function decidePath(cold: ColdStart | undefined): TurnPath {
  return !cold ? 'warm' : cold.prewarmed ? 'prewarmed' : cold.resumed ? 'resume' : 'new';
}

/** A runner this delivery started: whether it resumed a session, or claimed a spare (work 069). */
export interface ColdStart {
  resumed: boolean;
  prewarmed?: boolean;
}

/**
 * The trace the runner gets: the gateway's plus the path. Timings are not
 * forwarded: fork, launch and receipt are host events on the same trace, and
 * the turn is joined in SQL (telemetry/tinybird `turns`).
 */
export function forwardTrace(trace: TraceContext, cold?: ColdStart): TraceContext {
  return { ...trace, path: decidePath(cold) };
}

/** Why a runner's socket closed, as the host saw it. */
export function exitReason(r: { exiting?: boolean; report?: { status: string } }): 'idle' | 'stopped' | 'unknown' {
  if (r.exiting) return 'idle';
  return r.report?.status === 'stopped' ? 'stopped' : 'unknown';
}

/** The last trace forwarded to a runner and when. */
export interface Forwarded {
  trace?: TraceContext;
  /** Host wall clock at deliver.forwarded. */
  at: number;
}

const TRACES_DIR = path.join(HOST_RUN, 'traces');
export const traceFileFor = (key: string) => path.join(TRACES_DIR, `${keyName(key)}.trace.json`);

export function saveForwarded(key: string, f: Forwarded) {
  try {
    mkdirSync(TRACES_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(traceFileFor(key), JSON.stringify(f));
  } catch {
    // Telemetry only: a restart mid-turn then reports the abandoned turn without its trace.
  }
}

export function loadForwarded(key: string): Forwarded | undefined {
  try {
    const f = JSON.parse(readFileSync(traceFileFor(key), 'utf8'));
    return typeof f?.at === 'number' ? f : undefined;
  } catch {
    return undefined;
  }
}

export function clearForwarded(key: string) {
  rmSync(traceFileFor(key), { force: true });
}

/** Telemetry for the session's runner going away; `turn.abandoned` if it went mid-turn. */
export function runnerGone(tm: Telemetry, r: { key: string; connectedAt: number; exiting?: boolean; report?: { status: string }; forwarded?: Forwarded }) {
  const busy = r.report?.status === 'busy';
  const exit_reason = exitReason(r);
  tm.emit('runner.exited', { session_key: r.key, duration_ms: Date.now() - r.connectedAt, data: { busy, exit_reason, last_status: r.report?.status } });
  if (busy)
    tm.emit('turn.abandoned', { ...traceFields(r.key, r.forwarded?.trace), outcome: 'abandoned', duration_ms: r.forwarded && Date.now() - r.forwarded.at,
      data: { exit_reason } });
  clearForwarded(r.key);
}
