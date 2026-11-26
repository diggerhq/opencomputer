// The one telemetry emitter of the new actors (spec 36.7): a structured log line per event, with
// the actor, the organization and the trace when there is one. An event the catalog names also goes
// to `calvin_events` (the alert rules' table) when the actor gives a sink. Never throws.

import { CATALOG, type EventName, isEventName, type Scalar } from "./catalog.js";
import type { Dimensions } from "./envelope.js";
import type { EventFields } from "./emitter.js";
import { gatewayTelemetry, type TelemetryEnv } from "./gateway.js";
import { TelemetryBatch } from "./batch.js";

export type Level = "info" | "warn" | "error";

export interface Emitter {
  (event: string, fields?: Record<string, unknown>, level?: Level): void;
}

/** Where an actor's catalog events go besides the log: its Tinybird settings and `waitUntil`. */
export interface EventSink {
  env: () => TelemetryEnv;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Tests: the POST goes here instead of `fetch`. */
  fetch?: () => typeof fetch | undefined;
  /** Dimensions the log's `base` does not name as such (the organization of an object whose log says `team`). */
  dims?: () => Dimensions;
}

/**
 * An actor's emitter: `emit("org.mutated", { subject })`. `base` is stamped on every line. With a
 * `sink`, an event named in the catalog is also emitted to Tinybird (one POST per window per object).
 */
export function emitter(actor: string, base: () => Record<string, unknown> = () => ({}), sink?: EventSink): Emitter {
  let batch: TelemetryBatch | undefined;
  const events = () =>
    (batch ??= new TelemetryBatch({
      open: () => {
        const post = sink!.fetch?.();
        return gatewayTelemetry(sink!.env(), post ? { fetch: post } : {});
      },
      waitUntil: (promise) => sink!.waitUntil(promise),
    }));
  return (event, fields, level = "info") => {
    try {
      const all = { ...base(), ...fields };
      const line = JSON.stringify({ level, actor, event, at: new Date().toISOString(), ...all });
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
      if (sink && isEventName(event)) {
        const record = calvinEvent(event, { actor, ...sink.dims?.(), ...all }, level);
        events().emit((t) => t.emit(event, record));
      }
    } catch {
      // Telemetry never fails the work it measures.
    }
  };
}

const DIMENSIONS = new Set<string>([
  "trace_id",
  "turn_id",
  "session_key",
  "gateway_session_id",
  "dispatch_id",
  "host_id",
  "org_id",
  "surface",
  "surface_workspace_id",
  "conversation_id",
  "person_id",
  "sent_at",
  "harness",
  "provider",
  "model",
  "tier",
  "substrate",
  "path",
]);
const TOP = new Set<string>(["duration_ms", "outcome", "error_type", "error_code"]);
/** The log's own name for a dimension. */
const ALIASES: Record<string, string> = { org: "org_id" };
const TEXT_MAX = 500;

/** A log line's fields as a `calvin_events` record: dimensions and outcome on top, the catalog's keys in `data`. */
export function calvinEvent(event: EventName, fields: Record<string, unknown>, level: Level): EventFields<EventName> {
  const keys = new Set<string>(CATALOG[event].data);
  const out: Record<string, unknown> = {};
  const data: Record<string, Scalar> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const key = ALIASES[name] ?? name;
    if (DIMENSIONS.has(key) || TOP.has(key)) {
      if (out[key] === undefined) out[key] = value;
    } else if (keys.has(key) && (typeof value === "number" || typeof value === "boolean")) data[key] = value;
    else if (keys.has(key) && typeof value === "string") data[key] = value.slice(0, TEXT_MAX);
  }
  if (out.outcome === undefined && level === "error") out.outcome = "failed";
  if (Object.keys(data).length > 0) out.data = data;
  return out as EventFields<EventName> & Dimensions;
}
