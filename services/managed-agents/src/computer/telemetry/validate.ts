// Copied from diggerhq/calvin src/telemetry/validate.ts (calvin#44, work 054; names unchecked as of calvin#61);
// keep identical until work 050 P3 shares the protocol package.

// The telemetry boundary (work 054, "Data policy"): the only check between a
// process and Tinybird. Every emitter runs it, and the collector runs it again
// on what hosts send. It checks shape, not names: a record with an unknown
// column, a value outside a closed list, a non-scalar `data` value, an
// oversized string or anything content-shaped (a token, a path, a URL, a
// line break) is dropped whole, never forwarded partly. Event names and
// `data` keys are not checked against the catalog: a new event or key needs
// no deploy anywhere but its emitter (2026-10-14). The catalog types
// `emit` and documents what each event carries.
//
// The one repair: a negative duration or offset (clock skew across machines)
// is clamped to 0 and reported as `clamped`, so the caller counts it under
// `telemetry.dropped{reason: clock}` while the record still goes through.

import {
  CAPABILITIES,
  COUNTER_COLUMNS,
  DURATION_COLUMNS,
  ERROR_TYPES,
  OFFSET_COLUMNS,
  OUTCOMES,
  PATHS,
  SCHEMA_VERSION,
  TURN_OUTCOMES,
  type TelemetryEvent,
  type TurnRow,
} from './envelope.js';

export const MAX_STRING = 256;
const MAX_UINT32 = 2 ** 32 - 1;

/** Shapes that are never telemetry: tokens, keys, auth headers, multi-line text. */
const FORBIDDEN: RegExp[] = [/xox[abeprs]-/i, /\bsk-[A-Za-z0-9_-]{8,}/, /\bgh[pousr]_[A-Za-z0-9]{16,}/, /\bosb_[A-Za-z0-9_]{16,}/, /^bearer\s/i, /-----BEGIN /, /[\r\n]/];
/** The only fields whose values may contain `/` (anything else with one looks like a path or URL). */
const SLASH_OK = new Set(['model', 'service_version']);
const ERROR_CODE = /^(?:[a-z][a-z0-9_.]{0,63}|\d{3})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TB_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

const DIMENSIONS = [
  'trace_id',
  'span_id',
  'parent_span_id',
  'turn_id',
  'session_key',
  'gateway_session_id',
  'dispatch_id',
  'host_id',
  'org_id',
  'surface',
  'surface_workspace_id',
  'conversation_id',
  'person_id',
  'sent_at',
  'harness',
  'provider',
  'model',
  'tier',
  'substrate',
  'path',
] as const;
const EVENT_STRINGS = new Set<string>([
  ...DIMENSIONS,
  'event_id',
  'event_name',
  'occurred_at',
  'service_name',
  'service_version',
  'region',
  'tool_call_id',
  'tool_name',
  'capability',
  'outcome',
  'error_type',
  'error_code',
]);
const EVENT_KEYS = new Set<string>([...EVENT_STRINGS, 'schema_version', 'synthetic', 'duration_ms', 'data']);
const TURN_STRINGS = new Set<string>([...DIMENSIONS, 'region', 'gateway_version', 'host_version', 'runner_version', 'outcome', 'error_type']);
const TURN_NULLABLE = new Set<string>([...OFFSET_COLUMNS, ...DURATION_COLUMNS]);
const TURN_COUNTERS = new Set<string>(COUNTER_COLUMNS);
const TURN_KEYS = new Set<string>([...TURN_STRINGS, ...TURN_NULLABLE, ...TURN_COUNTERS, 'schema_version', 'turn_seq', 'synthetic', 'cost_usd']);
const TURN_REQUIRED = ['turn_id', 'trace_id', 'session_key', 'sent_at', 'region', 'outcome'];

const ENUMS: Record<string, readonly string[]> = {
  path: PATHS,
  capability: CAPABILITIES,
  error_type: ERROR_TYPES,
  service_name: ['gateway', 'host', 'runner', 'collector', 'edge', 'session', 'workerd'],
};

export type Checked<T> = { ok: true; value: T; clamped: boolean } | { ok: false; why: string };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a string may not cross the boundary, or undefined when it may. */
export function badString(key: string, v: unknown): string | undefined {
  if (typeof v !== 'string') return `${key}: not a string`;
  if (v.length > MAX_STRING) return `${key}: too long`;
  if (!SLASH_OK.has(key) && v.includes('/')) return `${key}: contains /`;
  if (FORBIDDEN.some((re) => re.test(v))) return `${key}: forbidden shape`;
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(v)) return `${key}: not in the closed list`;
  if (key === 'error_code' && !ERROR_CODE.test(v)) return `${key}: not an allowlisted code`;
  if ((key === 'occurred_at' || key === 'sent_at') && !TB_TIME.test(v)) return `${key}: not a timestamp`;
  if (key === 'event_id' && !UUID.test(v)) return `${key}: not a UUID`;
  return undefined;
}

/** A millisecond count: rounded, negatives clamped (reported), out of range rejected. */
function ms(key: string, v: unknown, clamp: { hit: boolean }): number | string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${key}: not a number`;
  if (v < 0) {
    clamp.hit = true;
    return 0;
  }
  const r = Math.round(v);
  return r > MAX_UINT32 ? `${key}: out of range` : r;
}

/** Check one event; the returned value is a fresh copy safe to forward. */
export function checkEvent(input: unknown): Checked<TelemetryEvent> {
  if (!isPlain(input)) return { ok: false, why: 'not an object' };
  const clamp = { hit: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (!EVENT_KEYS.has(k)) return { ok: false, why: `${k}: unknown field` };
    if (EVENT_STRINGS.has(k)) {
      const bad = badString(k, v);
      if (bad) return { ok: false, why: bad };
      out[k] = v;
    } else if (k === 'duration_ms') {
      const n = ms(k, v, clamp);
      if (typeof n === 'string') return { ok: false, why: n };
      out[k] = n;
    } else out[k] = v;
  }
  if (out.schema_version !== SCHEMA_VERSION) return { ok: false, why: 'schema_version' };
  if (typeof out.synthetic !== 'boolean') return { ok: false, why: 'synthetic: not a boolean' };
  for (const k of ['event_id', 'event_name', 'occurred_at', 'service_name', 'service_version', 'region']) {
    if (out[k] === undefined) return { ok: false, why: `${k}: missing` };
  }
  if (out.outcome !== undefined && !(OUTCOMES as readonly string[]).includes(out.outcome as string))
    return { ok: false, why: 'outcome: not in the closed list' };
  const data = out.data ?? {};
  if (!isPlain(data)) return { ok: false, why: 'data: not an object' };
  const cleanData: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (typeof v === 'string') {
      const bad = badString(k, v);
      if (bad) return { ok: false, why: `data.${bad}` };
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return { ok: false, why: `data.${k}: not finite` };
    } else if (typeof v !== 'boolean') return { ok: false, why: `data.${k}: not a scalar` };
    cleanData[k] = v;
  }
  out.data = cleanData;
  return { ok: true, value: out as unknown as TelemetryEvent, clamped: clamp.hit };
}

/** Check one turn row; the returned value is a fresh copy with every nullable column present. */
export function checkTurn(input: unknown): Checked<TurnRow> {
  if (!isPlain(input)) return { ok: false, why: 'not an object' };
  const clamp = { hit: false };
  const out: Record<string, unknown> = {};
  for (const k of TURN_NULLABLE) out[k] = null;
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (!TURN_KEYS.has(k)) return { ok: false, why: `${k}: unknown column` };
    if (TURN_STRINGS.has(k) || k === 'turn_id' || k === 'trace_id' || k === 'session_key') {
      const bad = badString(k, v);
      if (bad) return { ok: false, why: bad };
      out[k] = v;
    } else if (TURN_NULLABLE.has(k)) {
      if (v === null) continue;
      const n = ms(k, v, clamp);
      if (typeof n === 'string') return { ok: false, why: n };
      out[k] = n;
    } else if (TURN_COUNTERS.has(k) || k === 'turn_seq') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_UINT32) return { ok: false, why: `${k}: not a count` };
      out[k] = v;
    } else if (k === 'cost_usd') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { ok: false, why: `${k}: not a cost` };
      out[k] = v;
    } else out[k] = v;
  }
  if (out.schema_version !== SCHEMA_VERSION) return { ok: false, why: 'schema_version' };
  if (typeof out.synthetic !== 'boolean') return { ok: false, why: 'synthetic: not a boolean' };
  for (const k of TURN_REQUIRED) if (out[k] === undefined) return { ok: false, why: `${k}: missing` };
  if (!(TURN_OUTCOMES as readonly string[]).includes(out.outcome as string)) return { ok: false, why: 'outcome: not a turn outcome' };
  for (const k of TURN_COUNTERS) out[k] ??= 0;
  out.turn_seq ??= 0;
  out.cost_usd ??= 0;
  return { ok: true, value: out as unknown as TurnRow, clamped: clamp.hit };
}
