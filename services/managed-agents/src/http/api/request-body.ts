// A request's body and query parameters, bounded and parsed.

import { readBoundedText } from "../../edge/http.js";

const BODY_MAX_BYTES = 512 * 1024;

export async function bodyOf(request: Request): Promise<{ value: unknown } | { error: [number, string, string, Record<string, unknown>] }> {
  const text = await readBoundedText(request, BODY_MAX_BYTES);
  if (text === null) return { error: [413, "payload_too_large", "The body is too large.", {}] };
  if (!text.trim()) return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: [400, "invalid_request", "The body is not JSON.", { field: "" }] };
  }
}

export const asObject = (value: unknown): Record<string, unknown> | null =>
  value === undefined ? {} : value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A non-negative integer query parameter in [min, max]; undefined when absent; null when bad. */
export function intParam(query: URLSearchParams, name: string, min: number, max: number): number | undefined | null {
  const raw = query.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** A body of exactly one string field of 1 to `max` characters. */
export async function oneString(request: Request, field: string, max: number): Promise<{ value: string } | { error: [number, string, string, Record<string, unknown>] }> {
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed;
  const body = asObject(parsed.value);
  const extra = body && Object.keys(body).find((k) => k !== field);
  if (extra) return { error: [400, "invalid_request", `Unknown field ${extra}.`, { field: extra }] };
  const value = body?.[field];
  if (typeof value !== "string" || !value.trim() || value.length > max) return { error: [400, "invalid_request", `${field} is a string of 1 to ${max} characters.`, { field }] };
  return { value };
}
