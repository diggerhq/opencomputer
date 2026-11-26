// Protocol v4's frames (work 084): the Computer's streaming session API, as the
// processes pass it to each other. protocol.ts re-exports everything here and
// splices the gateway frames into its unions; this file exists only to keep
// protocol.ts under the size ratchet, and is part of the same contract
// (the backend's copy of the protocol mirrors both).
//
//   gateway ⇄ host    `start`/`started`, `api`/`api-result`, `journal`/`journal-ack`, `access`, `revoked`
//   relay   ⇄ host    WireToHost / HostToWire over $HOST_RUN/wire.sock (host/wire-link.ts)
//   relay, host ⇄ writer   ApiClientFrame / ApiWriterFrame over <runner id>.api.sock (the session's
//                     writer: its runner, or the host's session-writer when none runs)
//
// Invariants:
// - Every v4 field on a pre-v4 frame is optional; a v3 peer reads every frame it knows unchanged.
// - Bodies (`params`, `result`, `event.data`) are the public API's shapes, defined once in
//   src/api/schema.ts and published as schema/computer-api.v1.json; here they are opaque.
// - An operation is named by its WebSocket method (`turns.send`, …); its HTTP route is the same
//   operation, so one idempotency key covers both.
// - Ids: sessions `cs_…` (src/session-ids.ts); members are `usr_…` (Person.userId).

import type { HostCredentials, ModelRoute, Person, SessionSecret, SessionSpec } from './protocol.js';

/** Who acted, as every event and write carries it (API `Actor`). */
export interface ApiActor {
  /** `usr_…` for a person; a key's or the system's id otherwise. */
  id: string;
  name: string | null;
  /** `slack` | `opc` | `dashboard` | `api` | `system`; open. */
  via: string;
  /** The client and version, e.g. `opc/0.1.0`; null when unknown. */
  client: string | null;
}

/** An API error body: `code` is one of errors.mdx's codes (open), `status` its HTTP status. */
export interface ApiError {
  code: string;
  message: string;
  status: number;
  retryable?: boolean;
  /** Code-specific fields (`retryAfterMs`, `ask`, `session`, `field`, `reason`, …). */
  [field: string]: unknown;
}

/** One journal event in the public envelope (API `Event`); `data` per its `type`. */
export interface JournalEvent {
  /** `ev_…`, unique per session. */
  id: string;
  seq: number;
  /** ISO time. */
  createdAt: string;
  sessionId: string;
  turnId: string | null;
  type: string;
  actor: ApiActor | null;
  data: unknown;
}

/** A transient delta (API `Delta`): never journaled, never replayed after its record completes. */
export interface JournalDelta {
  type: string;
  sessionId: string;
  turnId: string | null;
  data: unknown;
}

/** Who may attach to a session (pushed by the gateway, forwarded to the relay). */
export interface SessionAccess {
  sessionId: string;
  /** `usr_…` of the owner; may always attach and open terminals. */
  owner: string;
  /** Others who may attach (read and write); null: every member of the organization. */
  members: string[] | null;
  /**
   * The organization's admins (`usr_…`), who may also open terminals in this session (attaching still follows
   * `members`). Absent: only the host's own list (the welcome's `people[].admin`) counts.
   */
  admins?: string[];
}

/** API session status (API `Session.status`). */
export type ApiSessionStatus = 'starting' | 'running' | 'waiting' | 'idle' | 'suspended';

// ---------------------------------------------------------------- gateway ⇄ host (v4)

/** Spliced into GatewayToHost. */
export type GatewayToHostV4 =
  /**
   * Claim a spare and fork for `session` with no input (a session created over the API); answered by
   * `started`. `epoch` and `lastSeq` seed the writer's journal (seq continues at max(local, lastSeq) + 1).
   */
  | { t: 'start'; id: string; session: SessionSpec; epoch: number; lastSeq: number;
      credentials?: HostCredentials; secrets?: SessionSecret[];
      model?: ModelRoute }
  /**
   * An API write or read for session `sessionId`, from an HTTP route: `method` is the WebSocket method of the same
   * operation, `params` its params. The host hands it to the session's writer; answered by `api-result` (15 s at the gateway).
   */
  | { t: 'api'; id: string; sessionId: string; method: string; params: unknown; actor: ApiActor;
      /** `usr_…` of the caller (the idempotency scope). */
      member: string; idempotencyKey?: string; requestId?: string;
      /** The session, when the host may not know it yet (a write to a session with no runner and no local journal). */
      session?: SessionSpec; epoch?: number; lastSeq?: number }
  /**
   * The SessionLog stored every event of `epoch` up to `seq`: the host may drop them from its spool. On a gap the DO
   * acks nothing and closes the socket with 4010 ("journal gap"); the host resends everything unacked after it reconnects.
   */
  | { t: 'journal-ack'; sessionId: string; epoch: number; seq: number }
  /**
   * The only frame that moves a session's epoch on a host (review r1 P1-1/P1-2, recovery-fix): the log is at `epoch`,
   * which began at `startSeq`; `tail` is every stored event `startSeq..lastSeq`, verbatim (at most 1000). Sent after a
   * recovery, after `hello` for each listed journal the log is ahead of, and on a `stale_epoch` batch. The host stops
   * the session's runner (or releases its own writer), cuts its journal at `startSeq`, appends `tail` and mirrors from
   * `lastSeq` under `epoch`. Idempotent: ignored at or above `epoch`. An epoch higher than the host's in `start`,
   * `deliver` or `api` is never adopted from those frames.
   */
  | { t: 'epoch'; sessionId: string; epoch: number; startSeq: number; lastSeq: number; tail: JournalEvent[] }
  /** A session's access list changed (or, after `welcome`, every session's: one frame per session). */
  | { t: 'access'; access: SessionAccess }
  /** API key `keyId` (or a ticket's key) was revoked: close its connections with 4001. */
  | { t: 'revoked'; keyId: string };

/** A journal on the host's disk, listed in `hello.journals` (every one): the gateway sends `epoch` where the log is ahead. */
export interface JournalReport {
  sessionId: string;
  /** 0: events with no epoch line yet (an adoption into a new file, torn before its commit record). */
  epoch: number;
  /** The epoch's first seq: `lastSeq < startSeq - 1 + tail.length` at the same epoch means the host lacks the log's events. */
  startSeq?: number;
  lastSeq: number;
}

/** Spliced into HostToGateway. */
export type HostToGatewayV4 =
  /** Answers `start`: the runner is claimed (or the session was already running). `error` when it could not start. */
  | { t: 'started'; id: string; sessionId: string; status: ApiSessionStatus; error?: ApiError }
  /** Answers `api`: the operation's result body (API "write results" or the read's body), or its error. */
  | { t: 'api-result'; id: string; result?: unknown; error?: ApiError }
  /**
   * The mirror: the next events of `sessionId` under `epoch`, in seq order, at least once. After a reconnect the host
   * resends from the last `journal-ack`. Flushed at once on turn ends, `ask.opened` and `session.status_changed`; else ≤ 100 ms.
   */
  | { t: 'journal'; sessionId: string; epoch: number; events: JournalEvent[] }
  /**
   * The latest `subagent.progress` values of the session's running subagents under `epoch` (never journaled; the
   * SessionLog merges them into reads). At most once a second per session, only when some changed; best effort, never resent.
   */
  | { t: 'subagent-progress'; sessionId: string; epoch: number; progress: SubagentProgress[] }
  /**
   * A send the host's writer queued for a session the host has no spec of (none came since it booted):
   * the gateway answers with `start`, as for a session created without a message. Ignored for an unknown session.
   */
  | { t: 'wake'; sessionId: string };

/** A `subagent.progress` delta's values (schema-events.ts). */
export interface SubagentProgress {
  subagentId: string;
  activity: string | null;
  toolCalls: number;
  tokens: number;
}

/** `welcome.wire`: the relay's edge key (the computer's key; today the previews key). */
export interface WireConfig {
  /** base64url, 32 bytes: verifies X-Wire-Auth (src/signed-header.ts). */
  key: string;
}

// ---------------------------------------------------------------- relay ⇄ host (wire-link.ts)

/** Sent by the relay on $HOST_RUN/wire.sock, one JSON object per line. Calls carry `id`; the host answers `result`. */
export type WireToHost =
  | { t: 'hello'; version: string }
  /** Where the session's writer listens; `result: WhereResult`, or `session_not_found`. */
  | { t: 'where'; id: string; sessionId: string }
  /** Start the session's runner if it is suspended (the interactive screen's attach with `resume=1`); `result: { status }`. */
  | { t: 'resume'; id: string; sessionId: string; actor: ApiActor }
  /** `result: { terminalId, socket, channel? }`; bytes then flow on `socket` (a PTY, raw both ways). */
  | { t: 'terminal.open'; id: string; sessionId: string; member: string; cols: number; rows: number;
      command?: string; tty: boolean; term?: string }
  | { t: 'terminal.resize'; id: string; terminalId: string; cols: number; rows: number }
  | { t: 'terminal.eof'; id: string; terminalId: string }
  /** Also sent for every terminal of a closing connection (SIGHUP, SIGKILL after 5 s). */
  | { t: 'terminal.close'; id: string; terminalId: string }
  /**
   * `/files`: `result: { socket }`, a one-shot unix socket. `put`: the relay streams the archive into it and half-closes;
   * `get`: the host streams the archive (or one file with `file`) out of it. The outcome follows as `files.done`.
   */
  | { t: 'files.put'; id: string; sessionId: string; member: string; path: string; format: 'tar' | 'tar+gzip' | 'tar+zstd'; bytes?: number }
  | { t: 'files.get'; id: string; sessionId: string; member: string; path: string; file?: boolean }
  /** One telemetry event (api/wire-events.ts `wire.*`, or an opc `cli.*` event); the host checks it and emits it into its spool. */
  | { t: 'telemetry'; name: string; fields: Record<string, number | string | boolean> };

export interface WhereResult {
  /** The writer's API socket. */
  socket: string;
  /** The socket's per-writer secret, sent first as `hello` (stands in for SO_PEERCRED, which node cannot read). */
  token: string;
  writer: 'runner' | 'host';
  epoch: number;
  /** The epoch's first seq (the journal's epoch line), for a relay that finds the epoch moved (`session.detached`). */
  epochStartSeq?: number;
}

/** Sent by the host to the relay. */
export type HostToWire =
  /** After `hello`, and again when any of it changes: the edge key and every session's access list. */
  | { t: 'welcome'; key: string | null; computer?: string; admins: string[]; access: SessionAccess[] }
  | { t: 'access'; access: SessionAccess }
  | { t: 'admins'; admins: string[] }
  | { t: 'revoked'; keyId: string }
  /** The session's writer changed (runner exited, started): ask `where` again and resubscribe after the last seq. */
  | { t: 'moved'; sessionId: string }
  | { t: 'terminal.exited'; terminalId: string; exitCode: number | null; signal: string | null }
  | { t: 'files.done'; id: string; result?: unknown; error?: ApiError }
  | { t: 'result'; id: string; result?: unknown; error?: ApiError };

// ---------------------------------------------------------------- client ⇄ writer (<id>.api.sock)

/**
 * Sent to the session's writer by the relay (one socket per attachment) or the host's api-bridge. Several calls may be
 * in flight; the writer answers each with `result`, in the order it accepted them. At most one `subscribe` per socket.
 */
export type ApiClientFrame =
  /** First on every connection: the writer's token (WhereResult.token); anything else first, or a wrong token, closes it. */
  | { t: 'hello'; token: string }
  | { t: 'call'; id: string; method: string; params: unknown; actor: ApiActor; member: string;
      idempotencyKey?: string; requestId?: string }
  /**
   * Replay then live: events with seq > `after` (or the last `tailTurns` turns), then every new one. `result` is the
   * `sessions.attached` body less `sessionId`; events follow it. `deltas: false` drops deltas.
   */
  | { t: 'subscribe'; id: string; after?: number; tailTurns?: number; deltas: boolean; resume?: boolean; mirror?: boolean }
  /** The client has everything up to `seq` (`sessions.ack`): the writer may drop it from this subscriber's queue. */
  | { t: 'ack'; seq: number };

export type ApiWriterFrame =
  | { t: 'result'; id: string; result?: unknown; error?: ApiError }
  | { t: 'event'; event: JournalEvent }
  | { t: 'delta'; delta: JournalDelta }
  /** The subscription ended: `too_far_behind` (its backlog), `moved` (the writer handed the journal on; ask `where`). */
  | { t: 'detached'; reason: 'too_far_behind' | 'moved' | 'access_lost' | 'epoch_changed'; logEpoch?: number; epochStartSeq?: number };

// ---------------------------------------------------------------- host ⇄ runner (v4)

/** RunnerSpec.api and `claim.api`: what makes a runner its session's writer. Absent: no API (a pre-v4 host). */
/** Work 084: a cold-started runner's RunnerApi with its token, sent once it registers; RUNNER_SPEC carries `token: ''` (argv and the unit's environment are readable). */
export type HostToRunnerV4 = { t: 'api'; api: RunnerApi };

export interface RunnerApi {
  /** The public id (`cs_…`). */
  sessionId: string;
  /** The session's JSONL journal: the runner takes its flock before writing (src/api/journal.ts). */
  journal: string;
  /** Seeds the journal: seq continues at max(local tail, lastSeq) + 1; a higher epoch than the file's truncates past lastSeq. */
  epoch: number;
  lastSeq: number;
  /** Where to listen for ApiClientFrame (`<runner id>.api.sock`), and the token every connection must open with. */
  socket: string;
  token: string;
}

/** Delivery.api: a message that came through the API, not Slack; recorded already by the host's writer when `turnId` is set. */
export interface ApiDelivery {
  actor: ApiActor;
  member: string;
  ifBusy: 'queue' | 'steer' | 'interrupt';
  /** The turn the host's writer recorded (`message.received`, `turn.queued`) while no runner ran. */
  turnId?: string;
  idempotencyKey?: string;
  model?: string;
  effort?: string;
  speed?: string;
  mode?: string;
}

// ---------------------------------------------------------------- Slack-bound narrowings

/** A person with a Slack identity: everyone the Slack gateway (src/gateway/) knows. */
export type SlackPerson = Person & { slackUserId: string };

/** A session bound to a Slack thread or channel: every session the Slack gateway creates. */
export type SlackSessionSpec = Omit<SessionSpec, 'kind' | 'channel' | 'owner'> & { kind: 'thread' | 'channel'; channel: string; owner: SlackPerson };

/** Whether a spec renders in Slack (SlackSurface) rather than nowhere (NullSurface). */
export const isSlackSpec = (spec: SessionSpec): spec is SessionSpec & SlackSessionSpec =>
  spec.kind !== 'api' && typeof spec.channel === 'string' && typeof spec.owner.slackUserId === 'string';
