// The feed's rows (spec section 35.1: `{ kind, id, version, …fields in camelCase }`).

import type { MutationName } from "./mutation-table.js";
import type { Session } from "./session-objects.js";

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
  /** pr: open | merged | closed; preview: running | stopped. */
  state: string | null;
  stateAt: number | null;
  /** The agent's own notes on the result (`result.add`). */
  meta: Record<string, unknown> | null;
  /** A `pr` result: what the platform knows of the pull request. Null until GitHub has said anything. */
  pull: PullRecord | null;
}

export type MergeMethod = "squash" | "merge" | "rebase";

/** A pull request as GitHub reported it, and the merge or revert made of it from the surface. Times are ms. */
export interface PullRecord {
  /** The head commit, whether it is a draft, and the conclusion of the last check suite completed on that head. */
  head?: string | null;
  draft?: boolean | null;
  checks?: string | null;
  /** A merge or revert a person began here and GitHub has not answered yet. */
  merging?: { by: string; at: number; head: string };
  reverting?: { by: string; at: number };
  /** A merge made here. `op`: the row of its line. `method` is null until known. */
  merge?: { by: string; at: number; method: MergeMethod | null; base: string | null; sha: string | null; branchDeleted: boolean; op: string };
  /** The revert of that merge: its pull request, merged or left open (`why`, in GitHub's words). */
  revert?: { number: number; url: string; merged: boolean; by: string; at: number; why: string | null };
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
