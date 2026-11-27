// Org's tables' rows, as stored, and their reads by key.

import type { Sql } from "../../durable/sql.js";

export interface SessionRec {
  id: string;
  owner: string;
  owner_name: string | null;
  owner_email: string | null;
  origin: string;
  slack_thread_key: string | null;
  machine: string;
  role: "track" | "start" | null;
  created_at: number;
  created_by: string;
  title: string | null;
  title_by: string | null;
  former_titles: string;
  writers: string;
  aside: string | null;
  metadata: string | null;
  blocked: number;
  revision: number;
  summary: string;
  create_hash: string | null;
  last_active_at: number | null;
  version: number;
  audience: string;
}

export interface PlaceRec {
  session_id: string;
  track_id: string | null;
  position: number;
  placed_by: string;
  parent_session: string | null;
  done_at: number | null;
  outcome: string | null;
  done_by: string | null;
  keep: number;
  brought_back_at: number | null;
  earlier_at: number | null;
  ready_seq: number | null;
  ready_what: string | null;
  ready_result: string | null;
  attention: string | null;
  version: number;
  audience: string;
}

export interface TrackRec {
  id: string;
  owner: string;
  name: string | null;
  name_by: string | null;
  former_names: string;
  stand: string | null;
  stand_at: number | null;
  agent_session: string;
  position: number;
  keep: number;
  done_at: number | null;
  outcome: string | null;
  created_by: string;
  version: number;
  audience: string;
}

export type Raw = Record<string, unknown> & { version: number; audience: string };

export const readSession = (sql: Sql, id: string): SessionRec | null => sql.exec<SessionRec>("SELECT * FROM session WHERE id = ?", id)[0] ?? null;
export const readPlace = (sql: Sql, sessionId: string): PlaceRec | null => sql.exec<PlaceRec>("SELECT * FROM place WHERE session_id = ?", sessionId)[0] ?? null;
export const readTrack = (sql: Sql, id: string): TrackRec | null => sql.exec<TrackRec>("SELECT * FROM track WHERE id = ?", id)[0] ?? null;
/** The track whose agent is this session, if it holds a track role. */
export const trackOfAgent = (sql: Sql, sessionId: string): TrackRec | null => sql.exec<TrackRec>("SELECT * FROM track WHERE agent_session = ?", sessionId)[0] ?? null;

/** The sessions a session was shared into (its `share` rows): each one's agent reads it. */
export const sharedTo = (sql: Sql, sessionId: string): string[] => sql.exec<{ to_session: string }>("SELECT to_session FROM share WHERE session_id = ?", sessionId).map((r) => r.to_session);
/** Whether `sessionId` was shared into `toSession`. */
export const isSharedTo = (sql: Sql, sessionId: string, toSession: string): boolean => sql.exec("SELECT 1 FROM share WHERE session_id = ? AND to_session = ?", sessionId, toSession).length > 0;
