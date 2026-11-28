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

/** An attachment of a message not yet sent, from `attach` until its message is accepted. */
export interface PendingAttachment {
  /** `at_…`, made here. */
  id: string;
  sessionId: string;
  name: string;
  mimetype: string;
  bytes: number;
  /**
   * `queued`: waiting for a slot or the network; `failed`: refused by the server, or its upload was
   * cut by a reload (`attachment_lost`): remove it to send.
   */
  state: "queued" | "uploading" | "ready" | "failed";
  /** 0 to 1 while `uploading`; 1 once `ready`. */
  progress: number;
  /** With `failed`: the refusal. */
  error?: { code: string; reason: string };
}

/**
 * A file's bytes on their way to a signed URL (work 126, K3). `fetch` reports no progress, so a
 * browser host does the `PUT` with `XMLHttpRequest`. Sent with exactly these headers and no
 * credential: the URL is its own authority, on whatever host it names. Rejects when the network
 * does; an HTTP error is a reply. `signal` aborts it.
 */
export interface UploadRequest {
  method: "PUT";
  headers: Record<string, string>;
  body: Blob;
  onProgress(sent: number, total: number): void;
  signal: AbortSignal;
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
  /** `attachments`: ids the entry waits for before it goes (work 126, D2). */
  | { key: string; kind: "turn"; sessionId: string; turnId: string; input: string; ifBusy?: IfBusy; attachments?: string[]; at: number }
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
  /**
   * Sends an attachment's bytes to `url`, an absolute signed URL, without credentials (work 126).
   * Default: the global `fetch`, which reports no progress.
   */
  uploadTo?(url: string, req: UploadRequest): Promise<Response>;
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
  /** Events exist before the first one held: `earlier()` reads them. */
  hasEarlier: boolean;
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
  /**
   * A window on the end of the session's log: its last events, with no gaps. The first value is the
   * whole window, as one update with `reset: { seq: null }`; later ones are the changes to it.
   */
  events(sessionId: string): Stream<EventsUpdate>;
  /** Extends the window back by one page; `events()` tells what it read. Calls made while one runs share it. */
  earlier(sessionId: string): Promise<void>;
  /**
   * Reads the window as `events()` does, without following it, so a later `events()` has it at once.
   * Resolves with the window, as the update a first subscriber would get, or null when it could not be read.
   */
  prefetch(sessionId: string): Promise<EventsUpdate | null>;
  deltas(sessionId: string): Stream<Delta>;
  mutate<N extends MutationName>(name: N, args: MutationArgs[N]): { settled: Promise<void> };
  createSession(body: CreateSessionBody): { id: string; turnId: string; settled: Promise<void> };
  /** `attachments`: ids from `attach`; the turn waits until every one is `ready` (work 126, D2). */
  send(sessionId: string, input: string, o?: { ifBusy?: IfBusy; attachments?: string[] }): { turnId: string; settled: Promise<void> };
  /**
   * Uploads `file` to the session at once, ahead of its message (work 126). The id can name the
   * session before `createSession` has sent it (D8). The bytes are held in memory until the message
   * is accepted; the limits are the server's, and a file it refuses is `failed` with its reason.
   * `state` follows the upload; `attachments()` lists them all.
   */
  attach(sessionId: string, file: Blob, o?: { name?: string }): { id: string; state: Signal<PendingAttachment> };
  /**
   * Every pending attachment, from storage too: after a reload a `ready` one is still `ready`, and
   * one whose upload was not finished is `failed` (`attachment_lost`).
   */
  attachments(): Signal<PendingAttachment[]>;
  /** Drops a pending attachment: the upload stops, and the server's row is deleted (best effort). */
  removeAttachment(id: string): Promise<void>;
  /**
   * A signed URL of an attachment of a message (`GET …/url`), to show or, with `download`, to save.
   * It is read without credentials and ends after a few minutes; the client keeps it until shortly
   * before, so asking again is free. Throws `Refused`.
   */
  attachmentUrl(sessionId: string, id: string, o?: { download?: boolean }): Promise<string>;
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
