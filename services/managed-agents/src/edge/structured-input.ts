import type {
  AgentInputValue,
  StructuredAgentInput,
  TurnInputMode,
} from "../protocol.js";

/**
 * One limit for a turn's structured input, applied where it is stored
 * (Session DO) and where a webhook delivery is acknowledged, so an admitted
 * delivery can never be rejected later at storage. Measured as the encoded
 * JSON string length, the unit the storage check has always used.
 */
export const STRUCTURED_INPUT_LIMIT = 256 * 1024;

export function structuredInputLength(input: StructuredAgentInput): number {
  return JSON.stringify(input).length;
}

/**
 * The bound on `payload` on the public turns route, measured as the UTF-8
 * length of its JSON encoding. Deliveries that arrive as structured input
 * from elsewhere (webhooks, schedules, event subscriptions) keep the storage
 * limit above; this is the bound an application composes against.
 */
export const TURN_PAYLOAD_LIMIT = 32 * 1024;

export function payloadLength(payload: AgentInputValue): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

/**
 * What a turn's idempotency key stands for: the text, the mode with its
 * default applied, the payload when one was sent, and the question it
 * answers when it names one (design 018: the question reference is part of
 * the turn's identity). Object keys are
 * sorted at every depth, so one request serialized in another key order is
 * the same request; strings are kept exactly as sent, whitespace included;
 * an absent payload and a `null` payload are different requests.
 */
export interface TurnRequest {
  input: string;
  mode?: TurnInputMode;
  payload?: AgentInputValue;
  answers?: string;
}

export function canonicalTurnRequest(request: TurnRequest): string {
  return JSON.stringify(
    canonicalValue({
      input: request.input,
      mode: request.mode ?? "queue",
      ...(request.payload !== undefined ? { payload: request.payload } : {}),
      ...(request.answers !== undefined ? { answers: request.answers } : {}),
    }),
  );
}

function canonicalValue(value: AgentInputValue): AgentInputValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key]!)]),
    );
  }
  return value;
}

/** SHA-256 of the canonical request, hex; stored with the turn it admitted. */
export async function turnFingerprint(request: TurnRequest): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalTurnRequest(request)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
