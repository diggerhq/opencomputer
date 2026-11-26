// `PATCH /sessions/{id}`'s body (spec 37.2), checked at the edge before Org is asked: which fields,
// their types and lengths. Org checks what needs its rows (access, the metadata it merges into).

type Invalid = [status: 400, code: "invalid_request", message: string, extra: { field: string }];
const invalid = (field: string, message: string): { error: Invalid } => ({ error: [400, "invalid_request", message, { field }] });

export interface PatchInput {
  title?: string;
  model?: string;
  effort?: string;
  mode?: string;
  speed?: "fast" | "standard";
  archived?: boolean;
  metadata?: Record<string, string | null>;
  /** Who may use it: Org checks it (org/sessions.ts `parseAccess`). */
  access?: unknown;
}

const PATCH_FIELDS = new Set(["title", "model", "effort", "mode", "speed", "archived", "metadata", "access"]);

export function validatePatch(body: unknown): { value: PatchInput } | { error: Invalid } {
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) return invalid("", "The body must be a JSON object.");
  const input = (body ?? {}) as Record<string, unknown>;
  const fields = Object.keys(input);
  if (!fields.length) return invalid("", "The body names nothing to change.");
  for (const field of fields) if (!PATCH_FIELDS.has(field)) return invalid(field, `Unknown field ${field}.`);
  const value: PatchInput = {};
  for (const [field, min, max] of [["title", 1, 200], ["model", 1, 200], ["effort", 1, 50], ["mode", 1, 50]] as const) {
    const v = input[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length < min || v.length > max) return invalid(field, `${field} must be a string of ${min} to ${max} characters.`);
    value[field] = v;
  }
  if (input.speed !== undefined) {
    if (input.speed !== "fast" && input.speed !== "standard") return invalid("speed", "speed must be fast or standard.");
    value.speed = input.speed;
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") return invalid("archived", "archived must be a boolean.");
    value.archived = input.archived;
  }
  if (input.metadata !== undefined) {
    const m = input.metadata;
    if (!m || typeof m !== "object" || Array.isArray(m)) return invalid("metadata", "metadata must be an object.");
    const entries = Object.entries(m as Record<string, unknown>);
    if (entries.length > 20) return invalid("metadata", "At most 20 metadata keys.");
    for (const [k, v] of entries) {
      if (k.length < 1 || k.length > 40) return invalid(`metadata.${k}`, "Metadata keys are 1 to 40 characters.");
      if (!(typeof v === "string" && v.length <= 500) && v !== null) return invalid(`metadata.${k}`, "Metadata values are strings of at most 500 characters.");
    }
    value.metadata = m as Record<string, string | null>;
  }
  if (input.access !== undefined) value.access = input.access;
  return { value };
}
