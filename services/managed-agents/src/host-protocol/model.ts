// Model traffic: the route a session's turns use, the model proxy's profiles, and its reports.

import type { CalvinHarness } from "./session.js";

/** Work 082: whose subscription a route spends. */
export type ModelProvider = "anthropic" | "chatgpt";

/**
 * Work 077: which model credential a session's turns use. `subscription`
 * carries a member's Claude setup token (only to a host whose hello lists
 * `model-proxy`), or (work 082) a ChatGPT access token with its account id
 * (only to a protocol 3 host whose hello lists `model-proxy/chatgpt`; its
 * fingerprint names the owner and account, not the token, so a refreshed
 * token replaces the old one in place); `managed` means the deliver's
 * `credentials`, as before; `refuse` is only ever pushed (`model`), with a
 * sentence for the thread.
 *
 * Protocol 5 (work 097): `profile` or `refuse`, nothing else. `profile` names
 * one of the profiles the host's hello lists and carries the values of its
 * variables. `subscription` is protocol 4's and goes with it. `managed` is
 * never sent at 5: here it still means a session with no route of its own,
 * which the host runs on `models[harness]`.
 */
export type ModelRoute =
  | {
      mode: "subscription";
      /** Absent: anthropic. */
      provider?: ModelProvider;
      owner: string;
      token: string;
      fingerprint: string;
      /** chatgpt: required. */
      accountId?: string;
      maxModel?: string;
    }
  | { mode: "managed" }
  | {
      mode: "profile";
      profile: string;
      /** The profile's variables by name. Credential values: a frame that carries them is never logged. */
      vars: Record<string, string>;
      /** Names the credential without revealing it (model-key.ts `modelKey`, or its author's own name): `[A-Za-z0-9._:-]{1,64}`. */
      key: string;
      owner?: string;
      maxModel?: string;
    }
  | { mode: "refuse"; reason: string };

/** A subscription's usage windows, as the proxy last saw them: percentages, resets in epoch ms. */
export interface ModelUsage {
  fiveHourPct?: number;
  fiveHourReset?: number;
  sevenDayPct?: number;
  sevenDayReset?: number;
}

// The model proxy (work 097): mirrors calvin src/protocol.ts (design C2). The gateway knows a profile by its name and
// the harnesses it serves; everything else about it is the proxy's configuration.

/** A profile as the proxy's hello lists it; the host forwards it unread. */
export interface ModelProfile {
  name: string;
  /** Names of the variables a route must carry. */
  vars: string[];
  /** harness → what that harness's adapter needs. Opaque here: only the harness names are read. */
  harness: Partial<Record<CalvinHarness, unknown>>;
}

/**
 * The proxy's report of what an upstream answered on a credential, relayed by the host unread: a
 * status with the headers the profile reports and the start of an error body, or a transport
 * error's class. The proxy limits how often it arrives. `body` is upstream text: parsed, never
 * logged, never shown.
 */
export interface ModelObserved {
  sessionKey: string;
  key: string;
  profile: string;
  status?: number;
  /** Lower-case name → value. */
  headers?: Record<string, string>;
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

/** `error`: the proxy's own code, `proxy_unavailable`, or `timeout` when the host gave up waiting. */
export interface ModelResponse {
  id: string;
  status?: number;
  /** Lower-case name → value. */
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}
