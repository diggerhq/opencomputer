// `Changes`, which writes a mutation's field changes with their side effects (access, the
// interrupt of a thread marked done, the dissolution of an emptied track) and records them, so the
// `op` row's `fields` and `inverse` follow from what was written and `undo` replays them the same way.
//
// An op written here has `fields: { rows, tracks }` and `inverse: { rows, restore, dissolve }`:
// - `rows`: `"<table>:<key>" → { column: value }` for `place`, `track` and `session` rows; in
//   `fields` the values the op gave, in `inverse` the values before it.
// - `tracks`: `trackId → 'present' | 'absent'`, a track the op made or removed.
// - `restore`: snapshots of tracks the op dissolved, which undo makes again (a new agent session).
// - `dissolve`: tracks the op made, which undo dissolves.

import { crockfordId } from "../../../ids/crockford.js";
import type { Origin } from "../../../api-objects/objects.js";
import { parse, readSession, readTrack, summaryOf, working, type TrackRec, type Tx } from "../tx.js";
import { placesOf } from "./places.js";
import { removeSession } from "./remove-session.js";
import { addTrackAgent, firstMachine } from "./track-agent.js";

export type Table = "place" | "track" | "session";
const KEY: Record<Table, string> = { place: "session_id", track: "id", session: "id" };
const COLUMNS: Record<Table, Set<string>> = {
  place: new Set(["track_id", "position", "placed_by", "done_at", "outcome", "done_by", "keep", "brought_back_at", "earlier_at"]),
  track: new Set(["name", "name_by", "former_names", "keep", "done_at", "outcome"]),
  session: new Set(["title", "title_by", "writers"]),
};

export type Values = Record<string, unknown>;
export type TrackSnapshot = {
  track: Omit<TrackRec, "version">;
  doc: { rev: number; text: string; spans: string } | null;
  agent: { origin: string; machine: string; ownerName: string | null; ownerEmail: string | null } | null;
};
export type OpFields = { rows: Record<string, Values>; tracks?: Record<string, "present" | "absent"> };
export type OpInverse = { rows: Record<string, Values>; restore?: TrackSnapshot[]; dissolve?: string[] };

export class Changes {
  readonly after: Record<string, Values> = {};
  readonly before: Record<string, Values> = {};
  readonly tracks: Record<string, "present" | "absent"> = {};
  readonly restored: TrackSnapshot[] = [];
  readonly made: string[] = [];
  private readonly dissolving = new Set<string>();

  constructor(
    readonly tx: Tx,
    readonly by: string,
  ) {}

  /** Write `values` to a row, stamp it, record it and apply the effects. False when there is no such row. */
  set(table: Table, key: string, values: Values): boolean {
    const tx = this.tx;
    const row = tx.sql.exec<Values>(`SELECT * FROM ${table} WHERE ${KEY[table]} = ?`, key)[0];
    if (!row) return false;
    const columns = Object.keys(values).filter((c) => COLUMNS[table].has(c));
    if (columns.length === 0) return true;
    const rk = `${table}:${key}`;
    const before = (this.before[rk] ??= {});
    for (const c of columns) if (!(c in before)) before[c] = row[c] ?? null;
    const after = (this.after[rk] ??= {});
    for (const c of columns) after[c] = values[c] ?? null;
    tx.sql.exec(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE ${KEY[table]} = ?`, ...columns.map((c) => values[c] ?? null), key);
    tx.stamp(table, key);

    if (table === "place" && "track_id" in values && row.track_id !== (values.track_id ?? null)) {
      tx.sendAccess(key);
      for (const tid of [row.track_id, values.track_id]) {
        if (typeof tid !== "string") continue;
        const track = readTrack(tx.sql, tid);
        if (track) tx.sendAccess(track.agent_session);
      }
      const left = row.track_id;
      if (typeof left === "string" && !this.dissolving.has(left) && placesOf(tx, left).length === 0) this.dissolve(left, "keep");
    }
    if (table === "place" && "done_at" in values && values.done_at !== null && values.done_at !== undefined && row.done_at === null) {
      const s = readSession(tx.sql, key);
      if (s && working(summaryOf(s))) tx.interrupt(key);
    }
    if (table === "session" && "writers" in values) tx.sendAccess(key);
    return true;
  }

  /** A track this mutation made: undo dissolves it. */
  created(trackId: string): void {
    this.tracks[trackId] = "present";
    this.made.push(trackId);
  }

  /**
   * `track.dissolve`'s effect (spec 39): each thread's `track_id` becomes null (`stop`: and it is
   * interrupted); the agent's session is stopped and removed; the track and its Doc are removed.
   * The track is snapshotted for undo. Proposals on the track go with it.
   */
  dissolve(trackId: string, threads: "keep" | "stop"): boolean {
    const tx = this.tx;
    const track = readTrack(tx.sql, trackId);
    if (!track) return false;
    this.dissolving.add(trackId);
    const doc = tx.sql.exec<{ rev: number; text: string; spans: string }>("SELECT rev, text, spans FROM doc WHERE track_id = ?", trackId)[0] ?? null;
    const agent = readSession(tx.sql, track.agent_session);
    const { version: _version, ...rest } = track;
    this.restored.push({
      track: rest,
      doc,
      agent: agent ? { origin: agent.origin, machine: agent.machine, ownerName: agent.owner_name, ownerEmail: agent.owner_email } : null,
    });
    for (const place of placesOf(tx, trackId)) {
      this.set("place", place.session_id, { track_id: null, placed_by: this.by });
      if (threads === "stop") {
        const s = readSession(tx.sql, place.session_id);
        if (s && working(summaryOf(s))) tx.interrupt(s.id);
      }
    }
    if (agent) removeSession(tx, agent);
    for (const r of tx.sql.exec<{ id: string }>("SELECT id FROM proposal WHERE target = ?", trackId)) tx.remove("proposal", r.id);
    tx.remove("doc", trackId);
    tx.remove("track", trackId);
    if (this.tracks[trackId] === "present") delete this.tracks[trackId];
    else this.tracks[trackId] = "absent";
    return true;
  }

  /** Make a dissolved track again (spec 39, undo of `track.dissolve`): its rows, its Doc, and a new agent session. */
  restore(snap: TrackSnapshot): boolean {
    const tx = this.tx;
    const t = snap.track;
    if (readTrack(tx.sql, t.id)) return false;
    const agentId = crockfordId("cs");
    tx.sql.exec(
      `INSERT INTO track (id, owner, name, name_by, former_names, stand, stand_at, agent_session, position, keep, done_at, outcome, created_by, version, audience)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id,
      t.owner,
      t.name,
      t.name_by,
      t.former_names,
      t.stand,
      t.stand_at,
      agentId,
      t.position,
      t.keep,
      t.done_at,
      t.outcome,
      t.created_by,
      tx.version(),
      t.audience,
    );
    const doc = snap.doc ?? { rev: 0, text: "", spans: "[]" };
    tx.sql.exec("INSERT OR REPLACE INTO doc (track_id, rev, text, spans, version, audience) VALUES (?, ?, ?, ?, ?, ?)", t.id, doc.rev, doc.text, doc.spans, tx.version(), t.audience);
    addTrackAgent(tx, {
      id: agentId,
      trackId: t.id,
      owner: t.owner,
      ownerName: snap.agent?.ownerName ?? null,
      ownerEmail: snap.agent?.ownerEmail ?? null,
      origin: parse<Origin>(snap.agent?.origin, { type: "api", client: null, slack: null }),
      machine: snap.agent?.machine ?? firstMachine(tx),
      by: this.by,
      name: t.name,
      firstInput: `This track ("${t.name ?? t.id}") was dissolved and has been restored by ${this.by}. Its Doc is as it was; read it, and the threads in the track, before you act.`,
    });
    if (this.tracks[t.id] === "absent") delete this.tracks[t.id];
    else this.tracks[t.id] = "present";
    this.made.push(t.id);
    return true;
  }

  /** The `op` row of what was written (spec 19.3). Its id. */
  op(o: { name: string; args: unknown; sessionId?: string | null; trackId?: string | null; audience: string }): string {
    return this.tx.op({
      by: this.by,
      name: o.name,
      args: o.args,
      fields: { rows: this.after, tracks: this.tracks } satisfies OpFields,
      inverse: { rows: this.before, restore: this.restored, dissolve: this.made } satisfies OpInverse,
      sessionId: o.sessionId ?? null,
      trackId: o.trackId ?? null,
      audience: o.audience,
    });
  }
}
