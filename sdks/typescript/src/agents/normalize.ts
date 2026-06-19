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
