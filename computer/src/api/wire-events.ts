// The relay's telemetry events (work 084 instrumentation, catalog v2 "dumb
// dump"): one event per unit of work (a connection's open and close, an attach,
// a write batch, a detach, an error response, a terminal, a /files transfer, an
// opc telemetry frame) plus a per-minute sample of gauges. The relay sends each
// over wire.sock the moment it happens; the host checks it against this table
// and emits it into its spool. Lives in api/ because the relay may import only
// the API's modules (scripts/boundaries.mjs).
//
// Invariants: closed. An event whose name, key or value is not in the table is
// dropped whole on the host, never forwarded partly; strings are ids, codes,
// method names or closed values, never content.

import { isSessionId } from '../session-ids.js';

export const CLOSE_CODES = [1000, 1001, 1005, 1006, 1011, 1012, 4001, 4008, 4029, 4400, 4503] as const;
export const REFUSED_STATUSES = [401, 403, 404, 4400, 4029, 4503] as const;
export const DETACH_REASONS = ['too_far_behind', 'moved', 'access_lost', 'epoch_changed', 'unavailable'] as const;
export const FILES_OPS = ['put', 'get', 'file', 'list'] as const;
/** A refused frame (too large, over the rate) is no event: it is counted into `wire.flush` `telemetry_refused`. */
export const TELEMETRY_RESULTS = ['ok', 'invalid'] as const;

/** A key's type: number, boolean, an id, an error code, an API method name, or one of a closed list. */
type Spec = 'n' | 'b' | 'id' | 'code' | 'method' | readonly (string | number)[];

const SPECS = {
  'wire.connect': { connection_id: 'id' },
  'wire.refused': { status: REFUSED_STATUSES },
  'wire.close': {
    connection_id: 'id', code: [...CLOSE_CODES, 0], attaches: 'n', frames_in: 'n', bytes_in: 'n', frames_out: 'n', bytes_out: 'n',
  },
  'wire.attach': { connection_id: 'id', attach_ms: 'n', via: ['url', 'method'], resume: 'b', replay: 'b', deltas: 'b' },
  'wire.flush': {
    connection_id: 'id', frames: 'n', bytes: 'n', events: 'n', deltas: 'n', oldest_age_ms: 'n', wait_ms_max: 'n',
    queued_bytes: 'n', paused: 'b', merged: 'n', duplicates: 'n', telemetry_refused: 'n',
  },
  'wire.detached': { connection_id: 'id', reason: DETACH_REASONS },
  'wire.error': { connection_id: 'id', method: 'method', code: 'code' },
  'wire.terminal': { connection_id: 'id', bytes_in: 'n', bytes_out: 'n', exited: 'b' },
  'wire.files': { op: FILES_OPS, bytes: 'n' },
  'wire.telemetry': { connection_id: 'id', events: 'n', rejected: 'n', result: TELEMETRY_RESULTS },
  'wire.sample': { connections: 'n', members: 'n', attached: 'n', terminals: 'n', queued_bytes_max: 'n' },
} as const satisfies Record<string, Record<string, Spec>>;

export type WireEventName = keyof typeof SPECS;
export const WIRE_EVENTS = Object.fromEntries(Object.entries(SPECS).map(([k, v]) => [k, Object.keys(v)])) as {
  [N in WireEventName]: (keyof (typeof SPECS)[N] & string)[];
};
export const isWireEvent = (n: unknown): n is WireEventName => typeof n === 'string' && Object.hasOwn(SPECS, n);

/** Fields any wire event may carry for the envelope (the host lifts them out of data). */
export interface WireEnvelope {
  session_key?: string;
  person_id?: string;
  duration_ms?: number;
  outcome?: 'completed' | 'failed';
  error_code?: string;
}
export type WireFields = WireEnvelope & Record<string, number | string | boolean | undefined>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z_]{1,40}$/;
const METHOD = /^[a-z]+(\.[a-zA-Z_]+){0,3}$/;
const MAX_NUMBER = 1e12;

function value(spec: Spec, v: unknown): number | string | boolean | undefined {
  if (spec === 'n') return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_NUMBER ? Math.round(v) : undefined;
  if (spec === 'b') return typeof v === 'boolean' ? v : undefined;
  if (spec === 'id') return typeof v === 'string' && ID.test(v) ? v : undefined;
  if (spec === 'code') return typeof v === 'string' && CODE.test(v) ? v : undefined;
  if (spec === 'method') return typeof v === 'string' && v.length <= 40 && METHOD.test(v) ? v : undefined;
  return (typeof v === 'string' || typeof v === 'number') && (spec as readonly unknown[]).includes(v) ? v : undefined;
}

export interface CheckedWireEvent {
  name: WireEventName;
  envelope: WireEnvelope;
  data: Record<string, number | string | boolean>;
}

/** The host's check of one relay event; undefined when anything is off (the event is dropped whole). */
export function checkWireEvent(name: unknown, fields: unknown): CheckedWireEvent | undefined {
  if (!isWireEvent(name) || !fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const { session_key, person_id, duration_ms, outcome, error_code, ...rest } = fields as Record<string, unknown>;
  const envelope: WireEnvelope = {};
  if (session_key !== undefined) {
    if (!isSessionId(session_key)) return undefined;
    envelope.session_key = session_key;
  }
  if (person_id !== undefined) {
    if (typeof person_id !== 'string' || !ID.test(person_id)) return undefined;
    envelope.person_id = person_id;
  }
  if (duration_ms !== undefined) {
    const d = value('n', duration_ms);
    if (d === undefined) return undefined;
    envelope.duration_ms = d as number;
  }
  if (outcome !== undefined) {
    if (outcome !== 'completed' && outcome !== 'failed') return undefined;
    envelope.outcome = outcome;
  }
  if (error_code !== undefined) {
    if (typeof error_code !== 'string' || !CODE.test(error_code)) return undefined;
    envelope.error_code = error_code;
  }
  const spec = SPECS[name] as Record<string, Spec>;
  const data: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    if (!Object.hasOwn(spec, k)) return undefined;
    const ok = value(spec[k], v);
    if (ok === undefined) return undefined;
    data[k] = ok;
  }
  return { name, envelope, data };
}

/** A close code as `wire.close` carries it: one of CLOSE_CODES, else 0 (other). */
export const closeCode = (code: number): number => ((CLOSE_CODES as readonly number[]).includes(code) ? code : 0);
