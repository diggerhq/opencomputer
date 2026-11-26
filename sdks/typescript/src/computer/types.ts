// The wire contract of tracks and threads, as a client sees it: spec sections 35 (rows), 37 (HTTP),
// 38 (socket), 39 (mutations) and 42.1 (this SDK). Shared by the client and the surface's store.
// No runtime code here. The review summary (`GET`/`PUT /work/results/{id}/review`, S9)
// is a schema with its types, in review.ts.

import type { MutationArgs, MutationName } from "./mutation-table.js";

// ---------- the session API's objects (services/managed-agents/src/computer/api-types.ts) ----------

export type SessionStatus = "starting" | "running" | "waiting" | "idle" | "suspended";
export type IfBusy = "queue" | "steer" | "interrupt";
export type AskKind = "approval" | "question" | "secret";
export type AskStatus = "open" | "answered" | "dismissed" | "declined" | "interrupted";

export interface Actor {
  id: string;
  name: string | null;
  via: string;
  client: string | null;
}

export interface Person {
  id: string;
  name: string;
  email: string | null;
}

export interface Origin {
  type: string;
  client: string | null;
  slack: { teamId: string | null; channelId: string; channelName: string | null; threadTs: string | null; url: string | null } | null;
}

export interface TurnError {
  code: string;
  message: string;
  [field: string]: unknown;
}

export interface TurnSummary {
  id: string;
  status: "completed" | "failed" | "cancelled";
  endedAt: string;
  text: string | null;
  error: TurnError | null;
  reason: string | null;
  forced: boolean | null;
}

export interface Ask {
  id: string;
  sessionId: string;
  turnId: string;
  kind: AskKind;
  status: AskStatus;
  createdAt: string;
  closedAt: string | null;
  closedBy: Actor | null;
  answer: unknown;
  /** `{ toolName, title, command?, … }` for an approval. */
  approval: Record<string, unknown> | null;
  /** `{ questions: [{ id, header, text, options: [{ label, description? }], multiSelect? }] }`. */
  question: Record<string, unknown> | null;
  secret: Record<string, unknown> | null;
}

export type Answer =
  | { decision: "allow" | "deny" | "always"; message?: string }
  | { answers: { questionId: string; choices: string[]; text: string | null }[] };

export interface ApiEvent {
  id: string;
  seq: number;
  createdAt: string;
  sessionId: string;
  turnId: string | null;
  type: string;
  actor: Actor | null;
  data: unknown;
}

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  archived: boolean;
  aside?: boolean;
  owner: Person;
  origin: Origin;
  settings: { model: string | null; effort: string | null; mode: string; speed: string | null };
  metadata: Record<string, string>;
  activeTurnId: string | null;
  queued: unknown[];
  asks: Ask[];
  subagents: unknown[];
  lastTurn: TurnSummary | null;
  lastText: string | null;
  context: { usedTokens: number | null; windowTokens: number | null };
  lastSeq: number;
  logEpoch: number;
  epochStartSeq: number;
  createdAt: string;
  lastActiveAt: string;
  syncedAt: string | null;
  urls: { dashboard: string | null };
}

// ---------- feed rows (section 35.1: `{ kind, id, version, …fields in camelCase }`) ----------

/** A principal as rows name it: `usr_…`, `agent:<session id>`, `rule:<name>`, `platform`. */
export type By = string;

interface RowBase<K extends string> {
  kind: K;
  id: string;
  version: number;
}

export interface InboxEntry {
  id: string;
  /** turn | answer | dismiss | interrupt | settings */
  kind: string;
  by: By;
  at: string;
  text: string | null;
  /** Set when the host refused the entry. */
  error: string | null;
}

export interface SessionRow extends RowBase<"session">, Omit<Session, "id"> {
  titleBy: By | null;
  agentTitle: string | null;
  lastAgentSeq: number;
  blocked: boolean;
  inbox: InboxEntry[];
  machine: string;
  role: null | "track" | "start";
}

/** `id` is the session's id. Times are epoch milliseconds. */
export interface PlaceRow extends RowBase<"place"> {
  sessionId: string;
  trackId: string | null;
  position: number;
  placedBy: By;
  parentSession: string | null;
  doneAt: number | null;
  outcome: string | null;
  doneBy: By | null;
  keep: boolean;
  broughtBackAt: number | null;
  earlierAt: number | null;
  readySeq: number | null;
  readyWhat: string | null;
  readyResult: string | null;
  attention: string | null;
}

export interface TrackRow extends RowBase<"track"> {
  owner: string;
  name: string | null;
  nameBy: By | null;
  formerNames: string[];
  stand: string | null;
  standAt: number | null;
  agentSession: string;
  position: number;
  keep: boolean;
  doneAt: number | null;
  outcome: string | null;
  createdBy: By;
}

export type ResultKind = "pr" | "changes" | "preview" | "file" | "document";

export interface ResultRow extends RowBase<"result"> {
  sessionId: string;
  /** The table's `kind` column: a row's `kind` is its table, so the column travels as `type`. */
  type: ResultKind;
  /** A pull request's URL, a preview's URL, a file's path. */
  ref: string;
  title: string | null;
  /** pr: draft | open | merged | closed, with `meta.checks`; preview: running | stopped. */
  state: string | null;
  stateAt: number | null;
  meta: Record<string, unknown> | null;
}

export type ProposalKind = "done" | "wrap" | "move" | "edit";

export interface ProposalRow extends RowBase<"proposal"> {
  /** The table's `kind` column, as on a result. */
  type: ProposalKind;
  /** A session id or a track id. */
  target: string;
  by: By;
  what: string | null;
  args: Record<string, unknown> | null;
  state: "open" | "accepted" | "dismissed" | "void";
  atSeq: number | null;
}

/** `id` is the track's id. */
export interface DocRow extends RowBase<"doc"> {
  trackId: string;
  rev: number;
  text: string;
  /** Line ranges a person wrote: `[{ from, to, by }]`. */
  spans: { from: number; to: number; by: By }[];
}

/** `id` is `<member>:<sessionId>`. */
export interface ReadRow extends RowBase<"read"> {
  member: string;
  sessionId: string;
  readSeq: number;
}

/** `id` is `<member>:<key>`. */
export interface PrefRow extends RowBase<"pref"> {
  member: string;
  key: string;
  value: unknown;
}

export interface MachineRow extends RowBase<"machine"> {
  state: string;
  revision: number;
}

export interface OpRow extends RowBase<"op"> {
  at: number;
  by: By;
  name: MutationName;
  args: Record<string, unknown>;
  inverse: unknown;
  fields: unknown;
  sessionId: string | null;
  trackId: string | null;
  atSeq: number | null;
  undoneBy: string | null;
}

export type Row = SessionRow | PlaceRow | TrackRow | ResultRow | ProposalRow | DocRow | ReadRow | PrefRow | MachineRow | OpRow;
export type RowKind = Row["kind"];
export type RowOf<K extends RowKind> = Extract<Row, { kind: K }>;

export const ROW_KINDS = ["session", "place", "track", "result", "proposal", "doc", "read", "pref", "machine", "op"] as const satisfies readonly RowKind[];

// ---------- HTTP (section 37) ----------

export interface FeedFrame {
  protocol: 1;
  org: string;
  subject: string;
  /** null for a snapshot: the reader replaces every row it holds with `rows`. */
  from: string | null;
  to: string;
  more: boolean;
  rows: Row[];
  gone: { kind: string; id: string }[];
  /** The feed version `to` names: a mutation is confirmed once the feed reaches the `version` of its reply. */
  version: number;
  counts?: { earlier: number; trackEarlier: Record<string, number> };
}

export type ErrorCode = "refused" | "not_found" | "taken" | "conflict" | "idempotency_conflict" | "principal_mismatch" | "reset" | (string & {});

/** Every 4xx and 5xx body. A `reset` (409) carries `cursor`, and `seq` for a session's events. */
export interface ErrorBody {
  error: { code: ErrorCode; reason?: string; message?: string; cursor?: string | null; seq?: number; [field: string]: unknown };
}

export interface MutateOk {
  protocol: 1;
  /** The feed version that holds the effect. */
  version: number;
  value?: unknown;
}

/** `GET /sessions/{id}/events?after=<cursor>&tailTurns&limit`. */
export interface EventPage {
  events: ApiEvent[];
  lastSeq: number;
  hasMore: boolean;
  /** The cursor after the last event returned. */
  cursor: string;
  earlierTurns?: unknown[] | null;
}

/** `GET /work/threads?earlier&track&before&limit`. */
export interface ThreadsPage {
  rows: (SessionRow | PlaceRow | ResultRow)[];
  next: string | null;
}

/** `GET /work/search?q&limit`. */
export interface SearchReply {
  rows: (SessionRow | PlaceRow | TrackRow | ResultRow)[];
}

export interface CreateSessionBody {
  /** A `cs_` id; made by the client so a retry lands on the same session. */
  id?: string;
  input: string;
  /** The first turn's `tn_` id. */
  turnId?: string;
  trackId?: string | null;
  role?: "start";
  model?: string;
  effort?: string;
  mode?: string;
}

/** A change of a session's model, effort or mode (`PATCH /sessions/{id}`, spec 19.1). */
export type SettingsPatch = { model?: string; effort?: string; mode?: string };

/** `GET /capabilities`: what a session may be started with or changed to. */
export interface Capabilities {
  models: { id: string; name: string; efforts: string[]; default: boolean }[];
  modes: string[];
  features: { steer: boolean };
}

// ---------- mutations (section 39; routes in section 37.3): the server's table, copied ----------

export type { MutationArgs, MutationName };

// ---------- the socket (section 38) ----------

/** `feed`, `events:<session id>` or `deltas:<session id>`. */
export type StreamName = string;

export type ClientFrame =
  | { t: "hello"; protocol: 1 }
  | { t: "sub"; stream: StreamName; after?: string; kinds?: string[] }
  | { t: "unsub"; stream: StreamName }
  | { t: "block"; session: string; blockId: string }
  | { t: "auth"; token: string }
  | { t: "ping" };

/** `computer/src/protocol-api.ts`'s `JournalDelta` plus `offset` (section 38.4). */
export interface Delta {
  session: string;
  /** `message.delta` | `reasoning.delta`; open. */
  type: string;
  turnId: string;
  /** `{ blockId, text }` for the text deltas. */
  data: { blockId?: string; text?: string; [field: string]: unknown };
  /** The length of the block's text before this delta. */
  offset: number;
  /** This delta holds the block so far; replace the copy held. */
  whole?: boolean;
}

export type ServerFrame =
  | { t: "ready"; connectionId: string; protocol: 1; org: string; subject: string; expiresAt: string; limits: Record<string, number> }
  | { t: "subd"; stream: StreamName; head: string | null }
  | ({ t: "feed" } & Pick<FeedFrame, "from" | "to" | "rows" | "gone" | "version">)
  | { t: "events"; session: string; from: string; to: string; events: ApiEvent[] }
  | ({ t: "delta" } & Delta)
  | { t: "behind"; stream: StreamName; head: string }
  | { t: "reset"; stream: StreamName; cursor: string | null; seq?: number }
  | { t: "detached"; stream: StreamName; reason: "forbidden" | "gone" | (string & {}) }
  | { t: "error"; code: string; message: string }
  | { t: "pong" };

// ---------- what a caller gives the client (section 42.1) ----------

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
  | { key: string; kind: "session"; sessionId: string; body: CreateSessionBody & { id: string; turnId: string }; at: number }
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
