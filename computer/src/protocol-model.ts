// Protocol v5's model frames (work 097, design C2 and C4): how the gateway,
// the host and a runner speak of a session's model credential once every
// request goes through the host's model proxy (computer/modelproxy). The
// gateway names a profile the proxy loaded and the values of its variables;
// the host binds them to the session's runner at the proxy; the runner learns
// the profile's `harness` object and where to connect, never a variable.
// protocol.ts re-exports everything here and splices the frames into its
// unions; the backend's copy of the protocol mirrors it.
//
//   gateway → host    `welcome.models`, `credentials.models`, `deliver.model`, `start.model`, `model`, `model-request`
//   host → gateway    `hello.profiles`, `model-bound`, `model-observed`, `model-response`
//   host → runner     `credentials.credentials.model` (RunnerModel)
//
// Invariants:
// - A variable's value travels gateway → host → proxy only: never to a runner,
//   never into a log or telemetry. `key` names a credential without revealing it.
// - A session's route is the last `model` it received in a `deliver`, `start` or
//   `model` frame, else `models[harness]` of the last `welcome` or `credentials`,
//   else none (the host refuses it).

import type { HarnessName } from './protocol.js';

/** The model proxy's API socket where the host's SP_MODEL_SOCKET is unset. */
export const MODEL_SOCKET = '/run/oc-modelproxy/api.sock';

/** A profile as the proxy's hello lists it; the host forwards it unread. */
export interface ModelProfile {
  name: string;
  /** Names of the variables a bind must carry. */
  vars: string[];
  /** harness → what that harness's adapter needs (design C5). Opaque to the host and the gateway. */
  harness: Partial<Record<HarnessName, unknown>>;
}

/** Which credential a session runs on: a profile with its variables, or a refusal with a sentence for the thread. */
export type ModelRoute =
  | { mode: 'profile'; profile: string; vars: Record<string, string>; key: string; owner?: string; maxModel?: string }
  | { mode: 'refuse'; reason: string };

/** The routes of sessions whose own delivery carries none, by harness; a `credentials` frame replaces the whole map. */
export type ModelRoutes = Partial<Record<HarnessName, ModelRoute>>;

/** What a runner knows of its session's route (design C4): never a variable. */
export interface RunnerModel {
  profile: string;
  key: string;
  /** The profile's `harness[h]` for the runner's own harness. */
  harness: unknown;
  owner?: string;
  maxModel?: string;
  /** Where the runner's model client connects: the host's SP_MODEL_SOCKET. */
  endpoint: { unixSocket: string };
  /** What it sends as its credential: the proxy's, from its hello. */
  placeholder: string;
}

/** The proxy's report of what an upstream answered on a credential, relayed by the host unread. */
export interface ModelObserved {
  sessionKey: string;
  key: string;
  profile: string;
  status?: number;
  /** Lower-case name → value. */
  headers?: Record<string, string>;
  /** The start of an error body: upstream text, never logged. */
  body?: string;
  error?: string;
}

/** A request of the gateway's own through a profile, with the credential in `vars`; answered by `model-response`. */
export interface ModelRequest {
  id: string;
  profile: string;
  vars: Record<string, string>;
  method: string;
  /** One of the profile's routes. */
  path: string;
  /** The raw query string, without the `?`. */
  query?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** `error`: the proxy's own code, `proxy_unavailable`, or `timeout` when the host gave up waiting (20 s). */
export interface ModelResponse {
  id: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

/** Spliced into GatewayToHost. */
export type GatewayToHostModel =
  /** A session's route changed (pause, limit, revoke, policy): the host rebinds its runner, or tells it to exit. */
  | { t: 'model'; sessionKey: string; model: ModelRoute }
  | ({ t: 'model-request' } & ModelRequest);

/** Spliced into HostToGateway. */
export type HostToGatewayModel =
  /** A session's bind took effect at the proxy. */
  | { t: 'model-bound'; sessionKey: string; mode: ModelRoute['mode']; profile?: string; key?: string }
  | ({ t: 'model-observed' } & ModelObserved)
  | ({ t: 'model-response' } & ModelResponse)
  /** The credential refused `model`; the session now runs on `fallbackTo`. */
  | { t: 'model-denied'; sessionKey: string; model: string; fallbackTo: string };
