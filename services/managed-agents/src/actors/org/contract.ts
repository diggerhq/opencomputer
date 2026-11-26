// Org's contract (tracks and threads, spec 35 and 36.1): its RPC methods and the values they pass,
// the session rows and feed rows the edge and other actors hold. Types only; nothing here runs.

import type { Origin, Session, SessionAccess } from "../../api-objects/objects.js";
import type { Access, Principal } from "../../auth/principal.js";
import type { Dead } from "../../durable/outbox.js";
import type { Reply } from "../../durable/rpc-reply.js";
import type { PublicComputerState } from "../computer/config.js";
import type { Summary } from "../session-log/contract.js";
import type { GrantingInstallation, RepositoriesQuery, Repository, RepositoryChoice } from "./repository.js";

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
  /** Who may use it (spec 36.2); absent: the organization's default. Not for a Slack or role session. */
  access?: AccessInput;
}
/** `access` of a create or patch: `people` as member ids (`usr_…`), WorkOS user ids or emails. */
export interface AccessInput {
  mode: SessionAccess["mode"];
  people?: string[];
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
  /** `PATCH` with `access`: Org checks it (org/sessions.ts `parseAccess`). */
  access?: AccessInput;
}
/** What one who manages a session's access but may not use it reads of it (an admin outside it). */
export type OutsideAccess = { session: null; access: SessionAccess; canManageAccess: boolean };
/** The organization's settings for the session API (spec 36.1). */
export interface OrgSettings {
  apiAccessDefault: "owner" | "org";
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
  /** `session` is null when `p` manages its access but may not use it (an admin outside it): only `access` changed. */
  patchSession(p: Principal, id: string, patch: SessionPatch): Promise<Reply<{ session: SessionRow } | OutsideAccess>>;
  listSessions(p: Principal, q: ListQuery): Promise<Reply<SessionPage>>;
  /** A session's access for one who manages it but may not use it (an admin outside it); anyone else `session_not_found`. */
  sessionAccess(p: Principal, id: string): Promise<Reply<OutsideAccess>>;
  settings(p: Principal): Promise<OrgSettings>;
  /** Admins only (`admin_required`). */
  setSettings(p: Principal, patch: Partial<OrgSettings>): Promise<Reply<{ settings: OrgSettings }>>;

  // the feed and the work part
  feed(p: Principal, q: { after?: string; kinds?: string[] }): Promise<FeedFrame | { reset: true; cursor: null }>;
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
