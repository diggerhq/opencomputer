// The whole contract between the actors of tracks and threads (spec sections 35 to 37): each
// class's RPC methods and the values they pass. No actor reads another's storage, and none calls a
// method not listed here. `p` is the caller's principal. Types only; nothing here runs.

import type { ApiEvent, LogSummary, Origin, Session, SessionSettings } from "../computer/api-types.js";
import type { PublicComputerState } from "../computer/config.js";
import type { CalvinPerson } from "../computer/protocol.js";
import type { SlackResult } from "../slack/slack-api.js";
import type { GrantingInstallation, RepositoriesQuery, Repository, RepositoryChoice } from "../org/repository.js";
import type { Access, Principal } from "./principal.js";
import type { Dead } from "./store.js";

export type { Access, Principal };

// ------------------------------------------------------------------ shared values

/** What SessionLog hands Org (spec 35.2): today's summary and four fields. */
export interface Summary extends LogSummary {
  /** Counts changes to this summary; never reused, also across epochs. */
  revision: number;
  /** seq of the newest message.completed, ask.opened, turn.completed or turn.failed. */
  lastAgentSeq: number;
  agentTitle: string | null;
  /** The entries that are `waiting` or `refused`. `text` is the first 280 characters of a turn's input. */
  inbox: { id: string; kind: string; by: string; at: string; text: string | null; error: string | null }[];
}

/** The `session` feed row and the API's object (spec 35.1): today's `Session` and Org's fields. */
export interface SessionRow extends Session {
  titleBy: string | null;
  agentTitle: string | null;
  lastAgentSeq: number;
  blocked: boolean;
  inbox: Summary["inbox"];
  machine: string;
  role: "track" | "start" | null;
}

/** A feed row: `{ kind, id, version, …the table's fields in camelCase }`. `audience` only between actors. */
export type Row = { kind: string; id: string; version: number; audience?: string; [field: string]: unknown };
export type PlaceRow = Row & { kind: "place"; trackId: string | null; position: number; parentSession: string | null; doneAt: string | null };
/** `kind` is the table; the table's own `kind` column is sent as `type` (lane 4's log). */
export type ResultRow = Row & { kind: "result"; sessionId: string; type: string; ref: string; title: string | null; state: string | null };
export type ReviewRow = { resultId: string; head: string; parts: unknown };
export type DocRev = { trackId: string; rev: number; by: string; at: string; text: string };

export type MachineState = PublicComputerState;
export type RoleSpec = { name: "track"; trackId: string } | { name: "start" };

export interface CreateSessionBody {
  id?: string;
  input?: string;
  title?: string;
  model?: string;
  effort?: string;
  mode?: string;
  speed?: "fast" | "standard";
  metadata?: Record<string, string>;
  /** `claude` | `codex`: the Slack actor's `!claude` or `!codex` prefix. Absent: the owner's. */
  harness?: string;
  /** The Slack actor only: the thread's origin, as the API shows it. */
  origin?: Origin;
}
export type CreateSession = CreateSessionBody & {
  trackId?: string;
  /** The agent caller's own session; set by the edge, never read from a request's body. */
  parent?: string;
  role?: "start";
  writers?: "members" | string[];
  slackThread?: string;
  /** The creating member's name and email, for `Session.owner`: the edge's, from its credential. An agent's child takes its parent's. */
  person?: { name: string | null; email: string | null };
};
export interface SessionPatch {
  title?: string;
  archived?: boolean;
  metadata?: Record<string, string | null>;
  /** `PUT`/`DELETE …/aside`: the ask the session is set aside for, or null. */
  aside?: string | null;
}
/** `GET /sessions`'s query, as today, plus `slackThread`. */
export interface ListQuery {
  owner?: string;
  status?: string[];
  origin?: string[];
  /** Absent: false. `all`: both. */
  archived?: boolean | "all";
  /** `metadata[key]=value` filters. */
  metadata?: Record<string, string>;
  q?: string;
  order?: "active" | "created";
  limit?: number;
  cursor?: string;
  slackThread?: string;
}
export interface SessionPage {
  sessions: SessionRow[];
  nextCursor: string | null;
}

/** A refusal an actor answers in place of throwing; the edge turns it into the HTTP error of spec 34.2. */
export type Refusal = { ok: false; code: string; status?: number; reason?: string; message?: string; [field: string]: unknown };
export type Reply<T> = ({ ok: true } & T) | Refusal;

// ------------------------------------------------------------------ Org (36.1)

export type FeedFrame = {
  protocol: 1;
  org: string;
  subject: string;
  /** Cursors; `from` is null for a snapshot. */
  from: string | null;
  to: string;
  /** true: read again from `to`. */
  more: boolean;
  rows: Row[];
  gone: { kind: string; id: string }[];
  /** The feed version `to` names: a mutation's reply names the one that holds its effect. */
  version: number;
  counts?: { earlier: number; trackEarlier: Record<string, number> };
  sum?: string;
};
/** What Org publishes to Live on `feed` (spec 40.4): rows and gone entries with their audience. */
export type FeedPush = {
  from: string;
  to: string;
  rows: (Row & { audience: string })[];
  gone: { kind: string; id: string; audience: string }[];
  version: number;
};
export type Occurrence = { n: string; key: string; kind: string; sessionId: string | null; trackId: string | null; by: string | null; at: string };
export type MutateRequest = {
  name: string;
  args: unknown;
  idem?: string;
  trace?: string;
  /** A member's or key's name and email, from the edge's credential, never a body's: `Session.owner` of a session the mutation makes (`track.create`'s agent). */
  person?: { name: string | null; email: string | null };
};
export type MutateReply =
  /** `version`: the feed version that holds the effect; a client's feed that reached it shows it. */
  | { protocol: 1; version: number; value?: unknown }
  | { error: { code: "refused" | "not_found" | "taken" | "conflict" | "idempotency_conflict" | "invalid_request" | "forbidden"; message?: string; reason?: string; [field: string]: unknown } };
export type Overview = { tracks: unknown[]; threads: unknown[] };
export type SlackEcho =
  | { kind: "refused"; threadKey: string; person: string; code: string }
  | { kind: "machine"; state: MachineState; threadKeys: string[] };
export type SummaryPub = {
  sessionId: string;
  revision: number;
  summary: Summary;
  occurrences: { epoch: number; seq: number; kind: string; by: string | null; at: number }[];
};
export type MachinePub = {
  machine: string;
  revision: number;
  state: MachineState;
  previews: { sessionId: string; name: string; url: string }[];
};
export type PullPub = { url: string; state: "open" | "merged" | "closed"; checks: string | null; title: string; at: number };

export interface OrgRpc {
  // the directory
  createSession(p: Principal, body: CreateSession): Promise<Reply<{ session: SessionRow; place: PlaceRow | null; duplicate: boolean }>>;
  getSession(p: Principal, id: string): Promise<Reply<{ session: SessionRow }>>;
  patchSession(p: Principal, id: string, patch: SessionPatch): Promise<Reply<{ session: SessionRow }>>;
  listSessions(p: Principal, q: ListQuery): Promise<Reply<SessionPage>>;

  // the feed and the work part
  feed(p: Principal, q: { after?: string; kinds?: string[]; sum?: boolean }): Promise<FeedFrame | { reset: true; cursor: null }>;
  mutate(p: Principal, m: MutateRequest): Promise<MutateReply>;
  threads(p: Principal, q: { earlier?: boolean; trackId?: string; before?: string; limit?: number }): Promise<{ rows: Row[]; next: string | null }>;
  /** One thread's `session`, `place` and `result` rows, as `threads` holds them; null when `p` may not see it. */
  thread(p: Principal, sessionId: string): Promise<{ rows: Row[] } | null>;
  search(p: Principal, q: { q: string; limit?: number }): Promise<{ rows: Row[] }>;
  result(p: Principal, id: string): Promise<ResultRow | null>;
  overview(p: Principal): Promise<Overview>;
  /** tell_track: the agent session of the caller's track. */
  trackAgent(p: Principal): Promise<string | null>;
  /** A track's `doc` row (doc_read): its agent cannot read it from the feed. */
  doc(p: Principal, trackId: string): Promise<Row | null>;
  docRevisions(p: Principal, trackId: string, rev?: number): Promise<DocRev[]>;
  review(p: Principal, resultId: string): Promise<ReviewRow | null>;
  mismatch(p: Principal, body: { clientId: string; cursor: string; server: string; client: string }): Promise<void>;

  // the occurrence stream
  occurrences(p: Principal, q: { after?: string; limit?: number }): Promise<{ entries: Occurrence[]; to: string } | { reset: true; cursor: null }>;

  // arrows in
  acceptSummary(pub: SummaryPub): Promise<{ accepted: boolean; revision: number }>;
  acceptMachine(pub: MachinePub): Promise<{ accepted: boolean }>;
  acceptPull(pub: PullPub): Promise<void>;
  /** SessionLog only, when it holds none. */
  access(sessionId: string): Promise<Access | null>;
  /** Computer only. */
  forHost(machine: string): Promise<{ sessions: { sessionId: string; access: Access }[]; admins: string[]; knowledge: string | null }>;
  repository(p: Principal): Promise<Repository | null>;
  setRepository(p: Principal, body: RepositoryChoice): Promise<Reply<{ repository: Repository }>>;
  /** `GET /work/repositories`: what the organization's GitHub installations grant. */
  repositories(p: Principal, q: RepositoriesQuery): Promise<Reply<{ installations: GrantingInstallation[] }>>;
  /** The Slack actor only: `slack:` sessions now owned by a member. */
  linkPerson(from: string, to: string): Promise<void>;
  /** For an operator (Computer's operator status): the owed calls that ran out of tries. */
  dead(): Promise<Dead[]>;
}

// ------------------------------------------------------------------ SessionLog (36.2)

/** What an inbox entry asks of the session's writer; every write reaches a host this way (spec 36.3). */
export type InboxKind = "turn" | "answer" | "dismiss" | "interrupt" | "settings" | "compact" | "suspend" | "resume" | "cancel" | "stop";
export interface InboxEntry {
  id: string;
  kind: InboxKind;
  body: unknown;
  /** `by` of who sent it (spec 34.1). */
  by: string;
  /** The principal it was accepted from, less its credential: what the host records as the actor. */
  actor: { subject: string; kind: Principal["kind"]; via: Principal["via"]; admin: boolean };
  trace: string | null;
  at: number;
}
export type Inbox = { entries: InboxEntry[]; epoch: number; lastSeq: number };
export type AcceptResult =
  /** `outcome`: the entry's as `accept` returned (`waiting` unless it waited and the drain was done). */
  | { ok: true; id: string; duplicate: boolean; outcome: EntryOutcome }
  | { ok: false; code: "not_found" | "forbidden" | "idempotency_conflict" | "inbox_full" | "agent_turns" };
/** A refused entry's error as the host (or the drain) gave it: its HTTP `status` when it has one, and its other fields (`turn`, `feature`, …). */
export type EntryError = { code: string; message: string; status?: number; [field: string]: unknown };
export type DeliveredOutcome = { ok: true; result?: unknown } | ({ ok: false } & EntryError);
/** One inbox entry's outcome, whichever drain delivered it (spec 40.2 steps 4 to 6). */
export type EntryOutcome = { state: "waiting" } | { state: "delivered"; result: unknown } | { state: "refused"; error: EntryError };
/** What SessionLog publishes to Live on `events:<cs_…>` (spec 40.4). */
export type EventPush = { from: string; to: string; events: ApiEvent[] };
/** The events read's answers (spec 37.1): a page with the cursor after its last event, or `reset`. */
export type EventsReset = { ok: false; error: "reset"; cursor: string | null; seq?: number };

/** Added to the existing `SessionLogRpc` (session-log-contract.ts), whose methods keep their signatures. */
export interface SessionLogRpcAdded {
  /** Kept only if `access.revision` is newer. */
  setAccess(access: Access): Promise<void>;
  /** `wait`: the drain is awaited (bounded) and `outcome` is the entry's after it; the API's writes. */
  accept(p: Principal, entry: { id: string; kind: InboxKind; body: unknown; trace?: string }, opts?: { wait?: boolean }): Promise<AcceptResult>;
  /** The entries that are `waiting`, in order. */
  inbox(): Promise<Inbox>;
  delivered(id: string, outcome: DeliveredOutcome): Promise<void>;
  /** The events cursor of the log's end; null when `p` may not read. */
  watch(p: Principal, until: number): Promise<{ head: string; machine: string } | null>;
  destroy(): Promise<void>;
}

// ------------------------------------------------------------------ Computer (36.3)

export type StartSpec = { session: SessionRow; settings: SessionSettings; role: RoleSpec | null; harness?: string; trace?: string };
/**
 * What the Slack actor carries over from Computer at cutover (spec 43.1): the install's settings (the bot token
 * sealed, as stored), the people the machine knows and their links to members. Nothing of a thread or a session.
 */
export interface SlackCarry {
  settings: Record<string, string>;
  people: { slack_user_id: string; dir: string; git_name: string; git_email: string; updated_at: number }[];
  links: { slackUser: string; member: string }[];
}

export interface ComputerRpcAdded {
  start(spec: StartSpec): Promise<void>;
  stop(sessionId: string): Promise<void>;
  /** SessionLog's owed `drain` only: the session's drain is owed here; resolves once delivered, or waiting for the host. */
  drain(sessionId: string): Promise<void>;
  watch(sessionId: string, until: number): Promise<void>;
  /** "Send this block so far." */
  block(sessionId: string, blockId: string): Promise<void>;
  /** Org only; relayed as the host's `access` frame. */
  setAccess(sessionId: string, access: Access, admins: string[]): Promise<void>;
  /**
   * The Slack actor only. `args`: the command's text after its name; for `grant`, the clicked button's action
   * id, with Slack's `triggerId`. `channelId` and `threadTs`: where the command was sent (absent: the
   * session's thread). `link`: `!link <code>`, whose code ModelAccess holds; `member` is the dashboard user
   * it linked the Slack person to.
   */
  command(
    p: Principal,
    c: { name: "secret" | "var" | "claude" | "codex" | "grant" | "link"; args: string; sessionId?: string; channelId?: string; threadTs?: string; triggerId?: string },
  ): Promise<{ reply: string; member?: string }>;
  /** Org: the knowledge repository; Slack: people or credentials. */
  changed(source: "org" | "slack"): Promise<void>;
  /** The Slack actor only, once: spec 43.1. */
  slackCarry(): Promise<SlackCarry>;
  /**
   * The Slack actor only: an interaction whose state is Computer's (secret, variable, connection and
   * subscription modals and their buttons: a `view_submission`, `s:`, `cn:`, `v:`, `mc:connect`,
   * `md:disconnect`, `cx:connect`, `cx:disconnect`). `sessionId`: a `v:` button's session. The reply is
   * the modal's answer: `errors` keep it open, `view` replaces it.
   */
  interaction(p: Principal, c: { interaction: unknown; sessionId?: string }): Promise<SlackModalReply>;
  /** The Slack actor only: a person left the workspace, was deactivated or became a guest; their subscriptions go. */
  memberLeft(slackUserId: string): Promise<void>;
}

/** A Slack modal's answer, as the edge returns it to Slack. */
export interface SlackModalReply {
  errors?: Record<string, string>;
  view?: Record<string, unknown>;
}

// ------------------------------------------------------------------ Live (36.4), lane 2's

/** A delta as the host sends it (`C/protocol-api.ts`'s `JournalDelta` plus `offset`), with its session's epoch. */
export type DeltaPush = { epoch: number; deltas: { type: string; turnId: string; data: unknown; offset: number; whole?: boolean }[] };

export interface LiveRpc {
  /** Streams: `feed`, `events:<cs_…>`, `deltas:<cs_…>`. The reply is the head Live now holds. */
  publish(stream: string, frame: FeedPush | EventPush | DeltaPush | { head: string }): Promise<{ head: string }>;
  revoke(credentialId: string): Promise<void>;
}

// ------------------------------------------------------------------ Slack (36.6)

export interface SlackGrant {
  teamId: string;
  teamName: string;
  botUserId: string;
  botToken: string;
  installerUserId: string;
}

export interface SlackRpc {
  /** Deduplicated, queued; the edge acknowledges Slack after it. */
  accept(e: { kind: "event" | "interaction"; id: string; body: unknown }): Promise<void>;
  /** An interaction, answered while Slack waits: a modal's or its button's goes to Computer; any other is `accept`ed. */
  interact(id: string, interaction: unknown): Promise<SlackModalReply>;
  install(p: Principal, grant: SlackGrant): Promise<void>;
  unlink(p: Principal): Promise<void>;
  // Computer only: it reaches Slack through these and holds no token of its own.
  /** A Web API call made with the bot token; `{ ok: false, error: "not_linked" }` when there is none. */
  api(method: string, body: Record<string, unknown>): Promise<SlackResult>;
  /** A Slack person's principal, or null when Slack does not report them a member of the workspace. Throws when Slack could not be asked. */
  principal(slackUser: string): Promise<Principal | null>;
  /** A Slack person's display name, or their id when Slack does not say. */
  userName(slackUser: string): Promise<string>;
  /** `installer`: who installed the app and the member they are, for Computer's model access (its rekey on install and unlink). */
  forHost(): Promise<{
    people: CalvinPerson[];
    slack: { botToken: string; botUserId: string; teamId: string; teamName?: string; installer?: { slackUser: string; member: string | null } } | null;
  }>;
  /** Org only. Idempotent on `sessionId`. */
  announce(child: { sessionId: string; parent: string; brief: string }): Promise<{ threadKey: string }>;
  /** Org only, the echo of an occurrence (spec 40.6). */
  notify(e: SlackEcho): Promise<void>;
  /** post_thread. */
  post(p: Principal, threadKey: string, text: string): Promise<Reply<{ ts: string }>>;

  // The install's edges, moved from Computer with the install (the edge's Slack routes call them).
  /** A nonce for the install's OAuth state, bound to the person starting it; ten minutes. */
  startInstall(p: Principal, nonce: string): Promise<void>;
  /** Spends an install nonce, once: the subject that started it. */
  consumeInstall(nonce: string): Promise<{ ok: true; subject: string } | { ok: false; reason: "invalid_state" | "state_expired" }>;
  /** Unlinks when Slack says the bot token is dead (asked with the token itself). Whether it did. */
  unlinkRevoked(teamId: string): Promise<{ unlinked: boolean }>;
  /** Someone in this workspace tried to link it to another organization: they and the installer are told. */
  joinRequest(teamId: string, requesterUserId: string): Promise<{ installerNotified: boolean }>;
  // The team router: the Slack object named `slack-team:<teamId>` holds which organization a workspace links to.
  claimTeam(teamId: string, org: string): Promise<{ ok: true } | { ok: false; holder: string }>;
  teamOrg(): Promise<string | null>;
  releaseTeam(org: string): Promise<void>;
}
