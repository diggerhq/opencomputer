import { SESSION_STATUSES, type SessionStatus } from "../protocol.js";
import type { MemoryEnvironment } from "./memory-contract.js";
import { isProjectEnvironmentName } from "./project-scope.js";
import { SESSION_LABEL_LIMITS } from "./session-labels.js";

/**
 * The query of `GET /sessions`, parsed once at the edge and executed by the
 * Account object's projection. Unknown parameters are refused rather than
 * ignored, so a misspelled filter cannot silently widen a listing.
 */
export interface SessionListQuery {
  project?: string;
  environment?: MemoryEnvironment;
  agent?: string;
  status?: SessionStatus;
  /** At most three `label.<key>=<value>` equality filters. */
  labels: Array<{ key: string; value: string }>;
  cursor?: SessionListCursor;
  limit: number;
}

/** The position after the last row of a page in the immutable order (createdAt desc, id asc). */
export interface SessionListCursor {
  createdAt: string;
  id: string;
}

export const SESSION_LIST_DEFAULT_LIMIT = 50;
export const SESSION_LIST_MAX_LIMIT = 100;
export const SESSION_LIST_MAX_LABEL_FILTERS = 3;

/** The shared status set: whatever a session can show, the filter accepts. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set<string>(SESSION_STATUSES);

const KNOWN_PARAMETERS = new Set([
  "project",
  "environment",
  "agent",
  "status",
  "cursor",
  "limit",
]);

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeSessionListCursor(cursor: SessionListCursor): string {
  return base64UrlEncode(JSON.stringify([cursor.createdAt, cursor.id]));
}

export function decodeSessionListCursor(
  value: string,
): SessionListCursor | null {
  if (!value || value.length > 512) return null;
  const decoded = base64UrlDecode(value);
  if (decoded === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !parsed[0] ||
      !parsed[1]
    ) {
      return null;
    }
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

/**
 * Parses the list query. An error is the `invalid_query` message; the edge
 * decides the status. Values are trimmed of nothing: a filter is an exact
 * equality.
 */
export function parseSessionListQuery(
  params: URLSearchParams,
): SessionListQuery | { error: string } {
  const query: SessionListQuery = { labels: [], limit: SESSION_LIST_DEFAULT_LIMIT };
  const seen = new Set<string>();
  for (const [name, value] of params) {
    if (seen.has(name)) return { error: `Parameter ${name} is repeated` };
    seen.add(name);
    if (name.startsWith("label.")) {
      const key = name.slice("label.".length);
      if (!SESSION_LABEL_LIMITS.keyPattern.test(key)) {
        return { error: `Label filter key ${JSON.stringify(key)} is invalid` };
      }
      if (value.length > SESSION_LABEL_LIMITS.maxValueLength) {
        return { error: `Label filter ${name} is too long` };
      }
      if (query.labels.length >= SESSION_LIST_MAX_LABEL_FILTERS) {
        return { error: `At most ${SESSION_LIST_MAX_LABEL_FILTERS} label filters are allowed` };
      }
      query.labels.push({ key, value });
      continue;
    }
    if (!KNOWN_PARAMETERS.has(name)) {
      return { error: `Unknown parameter ${name}` };
    }
    if (name === "limit") {
      if (!/^\d{1,3}$/.test(value)) {
        return { error: `limit must be an integer between 1 and ${SESSION_LIST_MAX_LIMIT}` };
      }
      const limit = Number.parseInt(value, 10);
      if (limit < 1 || limit > SESSION_LIST_MAX_LIMIT) {
        return { error: `limit must be an integer between 1 and ${SESSION_LIST_MAX_LIMIT}` };
      }
      query.limit = limit;
      continue;
    }
    if (name === "cursor") {
      const cursor = decodeSessionListCursor(value);
      if (!cursor) return { error: "cursor is not a cursor this listing issued" };
      query.cursor = cursor;
      continue;
    }
    if (!value || value.length > 256) {
      return { error: `${name} must be a non-empty value of at most 256 characters` };
    }
    if (name === "environment") {
      if (!isProjectEnvironmentName(value)) {
        return { error: "environment must be default, development, or production" };
      }
      query.environment = value;
      continue;
    }
    if (name === "status") {
      if (!KNOWN_STATUSES.has(value)) {
        return { error: `status ${JSON.stringify(value)} is not a session status` };
      }
      query.status = value as SessionStatus;
      continue;
    }
    if (name === "project") query.project = value;
    if (name === "agent") query.agent = value;
  }
  return query;
}
