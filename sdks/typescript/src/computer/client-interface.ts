// What a caller gives the client and what the client gives back (spec section 42.1).

import type { MutationArgs, MutationName } from "./mutation-table.js";
import type { CreateSessionBody, FeedFrame, SettingsPatch, UploadReply } from "./http-bodies.js";
import type { Answer, ApiEvent, IfBusy } from "./session-objects.js";
import type { ClientFrame, Delta, ServerFrame } from "./socket-frames.js";

/**
 * One connection to `/live`. `connect()` returns a new one each time; the client calls it again,
 * after the backoff of section 38.3, once a channel reports `closed`. Frames sent before `open`
 * are queued by the channel.
 */
export interface Channel {
  send(frame: ClientFrame): void;
  onFrame(cb: (frame: ServerFrame) => void): void;
  onState(cb: (state: "open" | "closed") => void): void;
  close(): void;
}

/** Named by principal by the caller. Values are JSON. `list` answers in key order. */
export interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<[key: string, value: unknown][]>;
  /** Several writes at once, where the store has transactions. */
  batch?(ops: ({ put: string; value: unknown } | { delete: string })[]): Promise<void>;
}

export interface Signal<T> {
  get(): T;
  subscribe(cb: (value: T) => void): () => void;
}

/** Subscribing starts the stream; the last unsubscribe stops it. What was held is replayed first. */
export interface Stream<T> {
  subscribe(cb: (value: T) => void): () => void;
}

export interface Principal {
  org: string;
  subject: string;
}

export type Pending =
  | { key: string; kind: "mutation"; name: MutationName; args: Record<string, unknown>; at: number }
  | { key: string; kind: "session"; sessionId: string; body: CreateSessionBody & { id: string; turnId?: string }; at: number }
  | { key: string; kind: "turn"; sessionId: string; turnId: string; input: string; ifBusy?: IfBusy; at: number }
  | { key: string; kind: "answer"; sessionId: string; askId: string; answer: Answer; at: number }
  | { key: string; kind: "dismiss"; sessionId: string; askId: string; at: number }
  | { key: string; kind: "interrupt"; sessionId: string; at: number }
  | { key: string; kind: "settings"; sessionId: string; settings: SettingsPatch; at: number };

/** A write the server refused: its optimistic copy is gone and the person is told (R42). */
export interface Failure {
  entry: Pending;
  code: string;
  reason: string;
  /** With `doc.save`'s `conflict`: the current `rev` and `text`; with `undo`'s `changed`: what a forced reversal would do. */
  detail?: unknown;
}

export class Refused extends Error {
  constructor(
    public code: string,
    public reason: string,
    public detail?: unknown,
  ) {
    super(`${code}: ${reason}`);
    this.name = "Refused";
  }
}

export interface ClientOptions {
  principal: Principal;
  /** `path` is relative to the API's root (`/feed`, `/sessions/…`, `/work/…`); the caller adds the prefix and the credential. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  connect(): Channel;
  storage: Storage;
  /** Keep a session's events in `storage` (section 26.3's "Remember this device"). Default: memory only. */
  keepEvents?: boolean;
  /** Runs `fn` as the one sender across tabs; a Web Lock in a browser. Default: runs it at once. */
  lock?(name: string, fn: () => Promise<void>): Promise<void>;
  /** For tests. */
  now?(): number;
  random?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface EventsUpdate {
  events: ApiEvent[];
  /** Drop the events held above `seq` (all of them when null) before applying `events`. */
  reset?: { seq: number | null };
}

export interface Client {
  /** A `cl_` id, made once and kept in storage. */
  clientId: string;
  status: Signal<"connecting" | "online" | "offline">;
  /**
   * The cursor and the rows are kept in storage. The first value is the rows held, as a frame with
   * `from: null`; any later frame with `from: null` (a snapshot after `reset`) replaces every row.
   */
  feed(kinds: string[]): Stream<FeedFrame>;
  events(sessionId: string, o?: { tailTurns?: number }): Stream<EventsUpdate>;
  deltas(sessionId: string): Stream<Delta>;
  mutate<N extends MutationName>(name: N, args: MutationArgs[N]): { settled: Promise<void> };
  createSession(body: CreateSessionBody): { id: string; turnId: string; settled: Promise<void> };
  send(sessionId: string, input: string, o?: { ifBusy?: IfBusy }): { turnId: string; settled: Promise<void> };
  answer(sessionId: string, askId: string, answer: Answer): { settled: Promise<void> };
  dismiss(sessionId: string, askId: string): { settled: Promise<void> };
  interrupt(sessionId: string): { settled: Promise<void> };
  settings(sessionId: string, settings: SettingsPatch): { settled: Promise<void> };
  /**
   * Puts a secret in the session's sealed store (`PUT /sessions/{id}/secrets/{name}`). Sent at once
   * and never queued, so the value is never stored; throws `Refused` on an error reply.
   */
  setSecret(sessionId: string, name: string, secret: { value: string; file: boolean }): Promise<void>;
  /**
   * Writes a tar archive to `workspace/{name}` (`PUT /sessions/{id}/workspace/archive`), the way
   * `opc push` does; the session's next turn begins with a note that it arrived. Sent at once and
   * never queued, so the bytes are never stored; throws `Refused` on an error reply.
   */
  upload(sessionId: string, name: string, tar: Blob): Promise<UploadReply>;
  pending(): Signal<Pending[]>;
  failures: Stream<Failure>;
  /** A read that is not a stream (`/work/threads`, `/work/search`, a review, a diff). Throws `Refused` on an error body. */
  read<T>(path: string): Promise<T>;
  /** Resolves when storage has been read: `pending()` and the feed's held rows are then current. */
  ready: Promise<void>;
  /** Stops the socket and the timers; storage is kept. */
  close(): void;
  /** Removes everything this client stored. */
  wipe(): Promise<void>;
}
