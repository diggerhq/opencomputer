// The JSON body of a dashboard or CLI agent route (a Claude setup token, a Codex auth.json), size-capped.

import { CODEX_AUTH_MAX_BYTES } from "../actors/computer/held-for-org/model-access/model-access.js";
import { problem, readBoundedText } from "../edge/http.js";

/** A setup token is at most ~430 bytes; the body has room for JSON around it and no more. */
export const AGENT_BODY_MAX_BYTES = 4096;
/** An auth.json is capped at CODEX_AUTH_MAX_BYTES; sent as a JSON string its quotes are escaped, so twice that, and the envelope. */
export const CODEX_BODY_MAX_BYTES = 2 * CODEX_AUTH_MAX_BYTES + 1024;

/** An agent route's JSON object body; 413 over the limit, `{}` when it is not a JSON object (each route then says what is missing). */
export async function agentBody(request: Request, maxBytes = AGENT_BODY_MAX_BYTES): Promise<Record<string, unknown> | Response> {
  const text = await readBoundedText(request, maxBytes);
  if (text === null) return problem(413, "payload_too_large", "Request body is too large");
  try {
    const value: unknown = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
