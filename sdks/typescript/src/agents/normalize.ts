// Normalize API responses to idiomatic TS: snake_case keys → camelCase, and a known set
// of numeric fields that the API serializes as strings (bigints) → numbers. Leaves the
// opaque `raw` payload (source-specific adapter data) untouched.

const NUMERIC = new Set([
  "seq", "head", "inputCursor", "inputFromSeq", "inputToSeq", "exitCode", "bytes", "port",
  "numTurns", "revision", "tokens", "turnSeconds", "turns",
  "attempts", "responseCode",
]);

const camel = (k: string): string => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function normalize<T = any>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => normalize(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const ck = camel(k);
      if (ck === "raw") { out[ck] = v; continue; }
      let nv: unknown = normalize(v);
      if (NUMERIC.has(ck) && typeof nv === "string" && nv !== "" && !Number.isNaN(Number(nv))) {
        nv = Number(nv);
      }
      out[ck] = nv;
    }
    return out as T;
  }
  return value as T;
}

// Inverse of normalize: camelCase keys → snake_case for REQUEST bodies (the API reads
// snake_case). Values are left untouched, and an opaque `raw` payload is not recursed into.
const snakeKey = (k: string): string => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

export function serialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => serialize(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sk = snakeKey(k);
      out[sk] = sk === "raw" ? v : serialize(v);
    }
    return out;
  }
  return value;
}
