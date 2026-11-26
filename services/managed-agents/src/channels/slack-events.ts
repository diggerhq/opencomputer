import { isRecord } from "../protocol.js";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifySlackSignature(
  payload: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature || !signature.startsWith("v0=")) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1_000) > 300_000) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${payload}`),
  );
  return constantTimeEqual(
    signature.slice(3),
    bytesToHex(new Uint8Array(digest)),
  );
}

export interface SlackEventCallback {
  id: string;
  appId: string;
  teamId: string;
  data: Record<string, unknown>;
}

export function parseSlackEventCallback(
  value: unknown,
): SlackEventCallback | null {
  if (!isRecord(value) || value.type !== "event_callback") return null;
  if (
    typeof value.event_id !== "string" ||
    typeof value.api_app_id !== "string" ||
    typeof value.team_id !== "string" ||
    !isRecord(value.event) ||
    (value.event.type !== "message" &&
      value.event.type !== "app_mention") ||
    typeof value.event.channel !== "string"
  ) {
    return null;
  }
  return {
    id: value.event_id,
    appId: value.api_app_id,
    teamId: value.team_id,
    data: value.event,
  };
}
