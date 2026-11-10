// opc's client telemetry (work 084 instrumentation, Q7): the `telemetry`
// notification a client sends on the wire, and the closed table both the
// relay and the host check it against. The contract is
// /tmp/build084/instrumentation-catalog.md ("opc's telemetry frame"); the
// host emits what passes as `cli.*` events with surface `cli`.
//
// Invariants:
// - Closed: an event whose name, key or value is not in the table is dropped
//   whole (counted), never forwarded partly. Values are non-negative finite
//   numbers (rounded), booleans, or one of a key's closed strings; nothing a
//   client sends can carry content, a path or free text.
// - The member and the session check are the relay's, never the client's:
//   `person_id` comes from the connection, and an event naming a session the
//   connection may not see is dropped.
// - Per occurrence (catalog v2, "dumb dump"): opc sends one event per unit
//   (a turn's first output, an attach, a key press, a slow draw, a connection);
//   no rollups.
// - Telemetry never hurts the session: a bad frame is dropped and counted, the
//   connection is not closed and no response is sent.

import { isSessionId } from '../session-ids.js';

/** A key's type: a number, a boolean, or one of these strings. */
type KeySpec = 'n' | 'b' | readonly string[];

const CONTROL_KINDS = ['steer', 'interrupt', 'answer', 'cancel'] as const;
const ERROR_CLASSES = ['ws_closed', 'auth', 'ticket', 'rate_limited', 'protocol', 'render', 'crash', 'timeout', 'other'] as const;
export const CLI_OS = ['darwin', 'linux', 'windows', 'other'] as const;
export const CLI_ARCH = ['arm64', 'x64', 'other'] as const;

const SPECS = {
  'cli.turn': { first_event_ms: 'n', first_output_received_ms: 'n', first_output_ms: 'n', interrupted: 'b' },
  'cli.attach': { attach_ms: 'n', connect_ms: 'n', reconnect: 'b', gap_ms: 'n', replayed_events: 'n' },
  'cli.control': { kind: CONTROL_KINDS, round_trip_ms: 'n', applied_ms: 'n', ok: 'b' },
  'cli.error': { class: ERROR_CLASSES, close_code: 'n' },
  'cli.render': { lag_ms: 'n', draw_ms: 'n' },
  'cli.connection': { up_ms: 'n', frames: 'n', bytes: 'n', close_code: 'n', reconnect: 'b' },
  'cli.overflow': { dropped: 'n' },
} as const satisfies Record<string, Record<string, KeySpec>>;

export type CliEventName = keyof typeof SPECS;
/** Keys the host adds to every `cli.*` event from the frame's header. */
export const CLI_COMMON = ['client_version', 'os', 'arch'] as const;
/** Each event's own data keys (the catalog lists these plus CLI_COMMON). */
export const CLI_EVENTS = Object.fromEntries(Object.entries(SPECS).map(([k, v]) => [k, Object.keys(v)])) as {
  [N in CliEventName]: (keyof (typeof SPECS)[N] & string)[];
};

export const CLI_LIMITS = { frameBytes: 16 << 10, events: 20, framesPerMinute: 6, burst: 3, skewMs: 24 * 3600_000 } as const;

const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NUMBER = 1e10;

export const isCliEvent = (n: unknown): n is CliEventName => typeof n === 'string' && Object.hasOwn(SPECS, n);

type Value = number | string | boolean;
/** One event as the relay forwards it to the host (`{t:'telemetry', name, fields}`) and the host checks it again. */
export type CliFields = Record<string, Value>;

function value(spec: KeySpec, v: unknown): Value | undefined {
  if (spec === 'n') return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_NUMBER ? Math.round(v) : undefined;
  if (spec === 'b') return typeof v === 'boolean' ? v : undefined;
  return typeof v === 'string' && spec.includes(v) ? v : undefined;
}

/** The event's data, checked against its spec; undefined when anything is off. */
function data(name: CliEventName, raw: unknown): CliFields | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const spec = SPECS[name] as Record<string, KeySpec>;
  const out: CliFields = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!Object.hasOwn(spec, k)) return undefined;
    const ok = value(spec[k], v);
    if (ok === undefined) return undefined;
    out[k] = ok;
  }
  return out;
}

const closed = <T extends readonly string[]>(list: T, v: unknown): T[number] => (typeof v === 'string' && list.includes(v) ? v : 'other');

export interface FrameContext {
  /** The connection's member (`usr_…`): the only person an event may name. */
  member: string;
  /** Whether this connection may see the session (the ticket and access list). */
  maySee(sessionId: string): boolean;
  now(): number;
}

export interface CheckedFrame {
  events: { name: CliEventName; fields: CliFields }[];
  /** Events dropped (the whole frame's count when the frame itself is bad). */
  rejected: number;
}

/** The relay's check of one `telemetry` notification's params. */
export function checkCliFrame(params: unknown, text: number, ctx: FrameContext): CheckedFrame {
  const p = params as { v?: unknown; client?: Record<string, unknown>; events?: unknown } | undefined;
  const n = Array.isArray(p?.events) ? p.events.length : 1;
  if (text > CLI_LIMITS.frameBytes || !p || p.v !== 1 || !p.client || p.client.name !== 'opc' || typeof p.client.version !== 'string' || !VERSION.test(p.client.version))
    return { events: [], rejected: Math.max(1, n) };
  if (!Array.isArray(p.events) || p.events.length < 1 || p.events.length > CLI_LIMITS.events) return { events: [], rejected: Math.max(1, n) };
  const header = { client_version: p.client.version, os: closed(CLI_OS, p.client.os), arch: closed(CLI_ARCH, p.client.arch) };
  const now = ctx.now();
  const out: CheckedFrame = { events: [], rejected: 0 };
  for (const e of p.events as Record<string, unknown>[]) {
    const ok = event(e, header, ctx, now);
    if (ok) out.events.push(ok);
    else out.rejected++;
  }
  return out;
}

function event(e: Record<string, unknown> | null, header: CliFields, ctx: FrameContext, now: number) {
  if (!e || typeof e !== 'object' || !isCliEvent(e.name)) return undefined;
  const d = data(e.name, e.data);
  if (!d) return undefined;
  const fields: CliFields = { ...d, ...header, person_id: ctx.member };
  if (e.sessionId !== undefined) {
    if (!isSessionId(e.sessionId) || !ctx.maySee(e.sessionId)) return undefined;
    fields.session_key = e.sessionId;
  }
  if (e.turnId !== undefined) {
    if (typeof e.turnId !== 'string' || !ID.test(e.turnId)) return undefined;
    fields.turn_id = e.turnId;
  }
  fields.at = typeof e.at === 'number' && Number.isFinite(e.at) && Math.abs(e.at - now) <= CLI_LIMITS.skewMs ? Math.round(e.at) : now;
  return { name: e.name, fields };
}

/** The host's check of a forwarded event: the same table, plus the relay's own fields. Returns the emit fields or undefined. */
export function checkCliForward(name: unknown, fields: unknown): { name: CliEventName; at: number; person_id: string; session_key?: string; turn_id?: string; data: CliFields } | undefined {
  if (!isCliEvent(name) || !fields || typeof fields !== 'object') return undefined;
  const { client_version, os, arch, person_id, session_key, turn_id, at, ...rest } = fields as Record<string, unknown>;
  if (typeof client_version !== 'string' || !VERSION.test(client_version)) return undefined;
  if (typeof os !== 'string' || !(CLI_OS as readonly string[]).includes(os) || typeof arch !== 'string' || !(CLI_ARCH as readonly string[]).includes(arch)) return undefined;
  if (typeof person_id !== 'string' || !ID.test(person_id) || typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (session_key !== undefined && !isSessionId(session_key)) return undefined;
  if (turn_id !== undefined && (typeof turn_id !== 'string' || !ID.test(turn_id))) return undefined;
  const d = data(name, rest);
  if (!d) return undefined;
  return { name, at, person_id, session_key, turn_id, data: { ...d, client_version, os, arch } };
}
