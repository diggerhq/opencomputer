// Copied from diggerhq/calvin src/telemetry/envelope.ts at 017d8db (calvin#44, work 054);
// keep identical until work 050 P3 shares the protocol package. bluecode's
// stricter tsconfig (no DOM lib, noUncheckedIndexedAccess) needs two edits in
// uuidv7: the bare `crypto` global and non-null index reads.

// The telemetry record shapes (work 054, "Trace context and the envelope" and
// "The turn row"): one envelope for every event, one wide row per turn, the
// closed lists their enum-like fields come from, and the Tinybird wire form.
//
// Invariants: field names match the Tinybird datasources column for column;
// 035's v1 names are kept where they apply. Nothing here may hold content:
// the validator enforces it, these types only make the honest path easy.

import type { EventName, Scalar, ServiceName } from './catalog.js';

export const SCHEMA_VERSION = 1;

export const OUTCOMES = ['completed', 'failed', 'timed_out', 'cancelled', 'interrupted', 'abandoned', 'silent'] as const;
export const TURN_OUTCOMES = ['completed', 'failed', 'cancelled', 'interrupted', 'silent'] as const;
export const ERROR_TYPES = [
  'timeout',
  'surface_error',
  'surface_rate_limited',
  'harness_crash',
  'harness_error',
  'provider_error',
  'provider_rate_limited',
  'git_fetch',
  'git_worktree',
  'clone',
  'launch',
  'socket',
  'invalid_message',
  // oc-modelproxy denials (work 082): a WebSocket upgrade, a ChatGPT seat at its in-flight cap, a binding used on another provider's route
  'websocket',
  'account_inflight',
  'provider_mismatch',
  'unknown',
] as const;
export const PATHS = ['warm', 'new', 'resume', 'prewarmed'] as const;
export const CAPABILITIES = ['exec', 'read', 'edit', 'search', 'mcp', 'agent', 'other'] as const;
export const DROP_REASONS = ['buffer_full', 'send_failed', 'rejected', 'invalid', 'clock', 'duplicate_delivery'] as const;

export type Outcome = (typeof OUTCOMES)[number];
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];
export type ErrorType = (typeof ERROR_TYPES)[number];
export type TurnPath = (typeof PATHS)[number];
export type Capability = (typeof CAPABILITIES)[number];
export type DropReason = (typeof DROP_REASONS)[number];

/** Identity and dimension fields an event or turn may carry when known. */
export interface Dimensions {
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  turn_id?: string;
  session_key?: string;
  gateway_session_id?: string;
  dispatch_id?: string;
  host_id?: string;
  org_id?: string;
  surface?: string;
  surface_workspace_id?: string;
  conversation_id?: string;
  person_id?: string;
  /** Tinybird DateTime64(3) text, UTC: `YYYY-MM-DD hh:mm:ss.sss`. */
  sent_at?: string;
  harness?: string;
  provider?: string;
  model?: string;
  tier?: string;
  substrate?: string;
  path?: TurnPath;
}

/** One telemetry event as it travels between processes. `data` becomes a JSON string only at Tinybird. */
export interface TelemetryEvent extends Dimensions {
  schema_version: number;
  event_id: string;
  event_name: EventName;
  occurred_at: string;
  service_name: ServiceName;
  service_version: string;
  region: string;
  synthetic: boolean;
  tool_call_id?: string;
  tool_name?: string;
  capability?: Capability;
  outcome?: Outcome;
  duration_ms?: number;
  error_type?: ErrorType;
  error_code?: string;
  data: Record<string, Scalar>;
}

/** Milestone offsets from `sent_at` (null when the milestone did not happen), in diagram order. */
export const OFFSET_COLUMNS = [
  'received_ms',
  'dispatched_ms',
  'host_received_ms',
  'runner_ready_ms',
  'harness_ready_ms',
  'model_requested_ms',
  'first_token_ms',
  'renderable_ms',
  'first_visible_ms',
  'ended_ms',
] as const;
/** Durations of parts of the turn (null when the part did not happen). */
export const DURATION_COLUMNS = [
  'fork_ms',
  'launch_ms',
  'harness_init_ms',
  'intro_ms',
  'names_ms',
  'attachments_ms',
  'ttft_ms',
  'api_ms',
  'tool_ms',
  'overhead_ms',
] as const;
export const COUNTER_COLUMNS = [
  'model_calls',
  'tool_calls',
  'stream_flushes',
  'steers',
  'surface_calls',
  'surface_errors',
  'surface_rate_limited',
  'max_silence_ms',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
] as const;

type Columns<T extends readonly string[], V> = { [K in T[number]]: V };

/** One row of `calvin_turns`. */
export interface TurnRow
  extends Dimensions,
    Columns<typeof OFFSET_COLUMNS, number | null>,
    Columns<typeof DURATION_COLUMNS, number | null>,
    Columns<typeof COUNTER_COLUMNS, number> {
  schema_version: number;
  turn_id: string;
  trace_id: string;
  session_key: string;
  turn_seq: number;
  sent_at: string;
  region: string;
  gateway_version: string;
  host_version: string;
  runner_version: string;
  synthetic: boolean;
  cost_usd: number;
  outcome: TurnOutcome;
  error_type?: ErrorType;
}

type Filled = (typeof OFFSET_COLUMNS)[number] | (typeof DURATION_COLUMNS)[number] | (typeof COUNTER_COLUMNS)[number];
/** What a producer hands to `turn()`: absent milestones become null and absent counters 0. */
export type TurnInput = Omit<TurnRow, 'schema_version' | 'region' | 'turn_seq' | 'cost_usd' | Filled> &
  Partial<Pick<TurnRow, 'region' | 'turn_seq' | 'cost_usd' | Filled>>;

/** Tinybird's DateTime64(3) text form, UTC. */
export function tbTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/** The NDJSON line for the `calvin_events` datasource: `data` as a JSON string. */
export function eventLine(e: TelemetryEvent): string {
  return JSON.stringify({ ...e, data: JSON.stringify(e.data) });
}

/** UUIDv7 (RFC 9562): 48-bit ms timestamp, then random bits; sorts by time. Works in Node and Workers. */
export function uuidv7(now = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
