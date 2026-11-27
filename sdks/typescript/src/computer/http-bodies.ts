// The bodies of the HTTP API (spec section 37) as a client sees them; no runtime code here.

import type { PlaceRow, ResultRow, Row, SessionRow, TrackRow } from "./feed-rows.js";
import type { AccessInput, ApiEvent } from "./session-objects.js";

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

/** `PUT /sessions/{id}/workspace/archive`: what was written to `workspace/{path}`. */
export interface UploadReply {
  upload: { path: string; files: number; bytes: number; replaced: unknown };
}

/** `GET /work/search?q&limit`. */
export interface SearchReply {
  rows: (SessionRow | PlaceRow | TrackRow | ResultRow)[];
}

export interface CreateSessionBody {
  /** A `cs_` id; made by the client so a retry lands on the same session. */
  id?: string;
  /** Absent: no first turn yet, so files can be uploaded before the first message (`opc new --push`). */
  input?: string;
  /** The first turn's `tn_` id. */
  turnId?: string;
  trackId?: string | null;
  role?: "start";
  model?: string;
  effort?: string;
  mode?: string;
  /** Absent: the organization's `apiAccessDefault`. */
  access?: AccessInput;
  /** Ids of `ready` attachments (work 126), at most `ATTACHMENTS_PER_MESSAGE`. */
  attachments?: string[];
}

/** A change of a session's model, effort or mode (`PATCH /sessions/{id}`, spec 19.1). */
export type SettingsPatch = { model?: string; effort?: string; mode?: string };

/** `GET /capabilities`: what a session may be started with or changed to. */
export interface Capabilities {
  models: { id: string; name: string; efforts: string[]; default: boolean }[];
  modes: string[];
  /** `attachments`: the deployment has a store for files (work 126). An older server does not say: read a missing value as true. */
  features: { steer: boolean; attachments?: boolean };
}
