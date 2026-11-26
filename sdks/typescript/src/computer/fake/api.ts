// The fake server's interface: sections 37 and 38 in one process, for development and tests. It has
// no Node dependency, so the web surface runs against it in a browser tab and the conformance tests
// run against it in vitest.

import type { ApiEvent, Channel, Principal, Row, RowKind, RowOf } from "../types.js";

export interface Chaos {
  /** Probability, 0 to 1, that a pushed frame is dropped. */
  drop?: number;
  /** That a pushed frame is sent twice. */
  duplicate?: number;
  /** That a pushed frame is held and sent after the next one. */
  reorder?: number;
  /** That an HTTP request fails with 503 before reaching the server, and after it (the reply is lost). */
  failBefore?: number;
  failAfter?: number;
  /** Seed of the generator the probabilities draw from; the same seed gives the same run. */
  seed?: number;
}

export interface FakeOptions {
  principal?: Principal;
  /** `demo`: the prototype's tracks and threads. `empty`: a new organization (S8). */
  seed?: "demo" | "empty";
  chaos?: Chaos;
  /** The scripted agents answer turns on their own (default true). False: a test drives them with `agent`. */
  autoAgent?: boolean;
  /** Milliseconds between the scripted agent's steps (default 0 in tests; the demo page passes about 30). */
  pace?: number;
  /** Milliseconds every HTTP reply waits. */
  latency?: number;
  now?(): number;
}

/** An ask a fake agent opens: an approval of a tool call (Bash unless `toolName` says), a question, or a secret it needs. */
export type FakeAsk =
  | { kind: "approval"; title: string; command?: string; toolName?: string; input?: Record<string, unknown>; alwaysAllows?: string }
  | { kind: "question"; question: string; options: string[] }
  | { kind: "secret"; name: string; purpose?: string; file?: boolean };

/** What a test, or the scripted agent, does as a session's agent. Each call appends events and updates the feed as the real actors would. */
export interface FakeAgent {
  /** The turn in progress streams `text` as deltas, then appends `message.completed`. */
  say(sessionId: string, text: string, o?: { chunk?: number }): Promise<void>;
  tool(sessionId: string, title: string, o?: { toolName?: string; fail?: boolean }): void;
  ask(sessionId: string, ask: FakeAsk): string;
  endTurn(sessionId: string, o?: { failed?: string }): void;
  /** A mutation by `agent:<sessionId>`, through Org's mutation function: `thread.ready`, `result.add`, `proposal.create`, `track.set_stand`, `doc.save`, `thread.rename`… */
  mutate(sessionId: string, name: string, args: object): void;
  /** A track's agent starts a thread in its track. Answers the new session's id. */
  startThread(trackAgentSessionId: string, title: string, input: string): string;
  /** A pull request's state as GitHub reports it (section 40.9). */
  pull(resultId: string, state: "draft" | "open" | "merged" | "closed", checks?: "pending" | "passed" | "failed"): void;
}

export interface FakeServer {
  principal: Principal;
  /** As `ClientOptions.fetch`: `path` is relative to the API's root. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  connect(): Channel;
  agent: FakeAgent;
  /** The rows as Org holds them, for assertions. */
  rows<K extends RowKind>(kind: K): RowOf<K>[];
  row(kind: RowKind, id: string): Row | undefined;
  events(sessionId: string): ApiEvent[];
  /** Every request received, for assertions: method, path, the `x-oc-n` header. */
  requests: { method: string; path: string; n: number | null; status: number }[];
  chaos(c: Chaos): void;
  /** Closes every socket; while offline, `fetch` rejects and `connect()` channels close at once. */
  setOffline(offline: boolean): void;
  dropSockets(): void;
  /** The host lost the tail of a session's log: a new epoch that begins at `keepSeq + 1` (section 40.10). Readers past `keepSeq` get `reset`. */
  loseTail(sessionId: string, keepSeq: number): void;
  /** Org removed `gone` rows: readers with a cursor below the head get `reset` with `cursor: null`. */
  raiseFloor(): void;
  /** Changes a row behind the feed's back, so the next checksum differs. */
  corrupt(kind: RowKind, id: string): void;
  /** The hourly alarm of section 40.8: threads past their age get `earlierAt`. `ms` moves the clock first. */
  age(ms: number): void;
  /** Resolves when the scripted agents and timers have nothing left to do. */
  idle(): Promise<void>;
}

export type CreateFakeServer = (o?: FakeOptions) => FakeServer;
