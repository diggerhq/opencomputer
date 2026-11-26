// The one telemetry emitter of the new actors (spec 36.7): a structured log line per event, with
// the actor, the organization and the trace when there is one. Never throws.

export type Level = "info" | "warn" | "error";

export interface Emitter {
  (event: string, fields?: Record<string, unknown>, level?: Level): void;
}

/** An actor's emitter: `emit("org.mutated", { subject })`. `base` is stamped on every line. */
export function emitter(actor: string, base: () => Record<string, unknown> = () => ({})): Emitter {
  return (event, fields, level = "info") => {
    try {
      const line = JSON.stringify({ level, actor, event, at: new Date().toISOString(), ...base(), ...fields });
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    } catch {
      // Telemetry never fails the work it measures.
    }
  };
}
