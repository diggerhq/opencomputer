// JSON-RPC 2.0 as the relay speaks it (opc docs websocket/methods.mdx
// "Errors"): parsing one text frame into a request or a notification, and
// encoding results, errors and notifications.
//
// Invariants: a frame that is not JSON is -32700 with id null; a batch or a
// frame without `jsonrpc: "2.0"` and a string `method` is -32600; invalid
// params are -32602 with `data: {code: "invalid_request", status: 400, field}`;
// every API error is -32000 with `data` = the HTTP error body plus `status`.
// Encoders build strings: a recorded event is spliced in as the writer's JSON
// was parsed, never wrapped twice.

import type { ApiError } from '../protocol.js';
import { apiError } from '../api/writer.js';

export type RpcId = number | string;

export type Incoming =
  | { kind: 'request'; id: RpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'invalid'; id: RpcId | null; code: -32700 | -32600; message: string };

export function parseFrame(text: string): Incoming {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return { kind: 'invalid', id: null, code: -32700, message: 'Parse error' };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { kind: 'invalid', id: null, code: -32600, message: 'Invalid Request: batches are not supported' };
  const o = m as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof o.id === 'number' || typeof o.id === 'string' ? o.id : undefined;
  if (o.jsonrpc !== '2.0' || typeof o.method !== 'string' || (o.id !== undefined && id === undefined)) {
    return { kind: 'invalid', id: id ?? null, code: -32600, message: 'Invalid Request' };
  }
  if (o.params !== undefined && (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params))) {
    return id === undefined
      ? { kind: 'notification', method: o.method, params: undefined }
      : { kind: 'invalid', id, code: -32600, message: 'Invalid Request: params must be an object' };
  }
  return id === undefined ? { kind: 'notification', method: o.method, params: o.params } : { kind: 'request', id, method: o.method, params: o.params };
}

const idJson = (id: RpcId | null) => JSON.stringify(id);

export const encodeResult = (id: RpcId, result: unknown) => `{"jsonrpc":"2.0","id":${idJson(id)},"result":${JSON.stringify(result ?? {})}}`;

/** An API error as JSON-RPC: -32602 for invalid params, -32000 for the rest. */
export function encodeError(id: RpcId | null, e: ApiError): string {
  const code = e.code === 'invalid_request' ? -32602 : -32000;
  const data = code === -32602 ? { code: 'invalid_request', status: 400, field: typeof e.field === 'string' ? e.field : '' } : e;
  return `{"jsonrpc":"2.0","id":${idJson(id)},"error":${JSON.stringify({ code, message: e.message, data })}}`;
}

/** An envelope error (-32700, -32600, -32601), with no API data. */
export const encodeRpcError = (id: RpcId | null, code: number, message: string) =>
  `{"jsonrpc":"2.0","id":${idJson(id)},"error":${JSON.stringify({ code, message })}}`;

export const encodeNotification = (method: string, params: unknown) => `{"jsonrpc":"2.0","method":${JSON.stringify(method)},"params":${JSON.stringify(params)}}`;

/** The `event`/`delta` notification around an already-serialized body. */
export const encodeRaw = (method: 'event' | 'delta', json: string) => `{"jsonrpc":"2.0","method":"${method}","params":${json}}`;

// ---------------------------------------------------------------- the API errors the relay raises itself

const RETRYABLE = new Set(['rate_limited', 'unavailable', 'computer_unavailable', 'internal']);

export const err = (code: string, message: string, status: number, extra: Record<string, unknown> = {}): ApiError =>
  apiError(code, message, status, { retryable: RETRYABLE.has(code), ...extra });

export const errors = {
  invalidParams: (field: string, message: string) => err('invalid_request', message, 400, { field }),
  sessionNotFound: () => err('session_not_found', 'No such session, or you cannot see it.', 404),
  missingScope: (scope: string) => err('forbidden', `This key lacks the ${scope} scope.`, 403, { reason: 'missing_scope', scope }),
  readOnly: () => err('forbidden', 'This session is attached read-only.', 403, { reason: 'read_only' }),
  terminalOwnerOnly: () => err('forbidden', "Only the session's owner or an admin can open a terminal.", 403, { reason: 'terminal_owner_only' }),
  rateLimited: (retryAfterMs: number) => err('rate_limited', 'Too many requests.', 429, { retryAfterMs }),
  tooManyAttached: () => err('too_many_attached', 'This connection already has 20 sessions attached.', 409),
  tooManyTerminals: () => err('too_many_terminals', '8 terminals are already open in this session.', 409),
  terminalNotFound: () => err('terminal_not_found', 'The terminal is not open on this connection.', 404),
  unavailable: (retryAfterMs = 1000) => err('unavailable', 'The session is not reachable right now.', 503, { retryAfterMs }),
  internal: () => err('internal', 'Server error.', 500),
};
