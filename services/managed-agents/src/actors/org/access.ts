// A session's access, from Org's rows (spec 36.2, 40.7).

import type { Access } from "../../auth/principal.js";
import type { Sql } from "../../durable/sql.js";
import { readPlace, readSession, readTrack, trackOfAgent } from "./records.js";
import { sharedWith } from "./audience.js";
import { parse } from "./parse-json.js";

/**
 * A session's access as its SessionLog and its machine hold it, from the rows as they are now.
 * `agents`: the track's agent and the session that started it may write and read; a track's agent
 * may be written to by its threads. `readers` also holds the people it is shared with.
 */
export function accessOf(sql: Sql, sessionId: string): Access | null {
  const s = readSession(sql, sessionId);
  if (!s) return null;
  const agents = new Set<string>();
  const place = readPlace(sql, sessionId);
  if (place?.parent_session) agents.add(`agent:${place.parent_session}`);
  if (place?.track_id) {
    const track = readTrack(sql, place.track_id);
    if (track) agents.add(`agent:${track.agent_session}`);
  }
  const readers = [...agents, ...sharedWith(s)];
  if (s.role === "track") {
    const track = trackOfAgent(sql, sessionId);
    if (track) for (const row of sql.exec<{ session_id: string }>("SELECT session_id FROM place WHERE track_id = ?", track.id)) agents.add(`agent:${row.session_id}`);
  }
  const writers = parse<"members" | string[]>(s.writers, "members");
  const version = sql.exec<{ version: number }>("SELECT version FROM meta WHERE k = 1")[0]!.version;
  return {
    owner: s.owner,
    audience: s.audience,
    writers: writers === "members" ? "members" : [...new Set([...writers, ...agents])],
    agents: [...agents],
    readers,
    machine: s.machine,
    revision: version,
  };
}
