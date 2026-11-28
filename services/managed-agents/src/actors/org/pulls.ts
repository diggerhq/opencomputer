// A pull request result's platform record (`result.pull`, work 118): who may merge it, the merge or
// revert a person began, and what is written when GitHub has made one. A merge is known twice, from
// the edge that asked GitHub for it (`result.merge`) and from GitHub's webhook (`acceptPull`), in
// either order or only one: both write through `recordMerge`, so the first makes the line and the
// second adds what it knows.

import { byOf, mayWrite, type Principal } from "../../auth/principal.js";
import { crockfordId } from "../../ids/crockford.js";
import type { Sql } from "../../durable/sql.js";
import { accessOf } from "./access.js";
import type { MergeMethod, PullRecord } from "./contract.js";
import { refuse, type MutationRefusal } from "./mutations/outcome.js";
import { parse } from "./parse-json.js";
import { readPlace, readSession, type SessionRec } from "./records.js";
import type { Tx } from "./tx.js";
import { isMember, seesSession } from "./who-may.js";

/** How long a begun merge or revert is taken as under way: nobody else begins one, and a webhook's merge of its head is its person's. */
export const MERGING_MS = 2 * 60_000;

export type PullRec = { id: string; session_id: string; kind: string; ref: string; state: string | null; pull: string | null; audience: string };
const COLUMNS = "id, session_id, kind, ref, state, pull, audience";

export const pullOf = (r: { pull: string | null }): PullRecord => parse<PullRecord>(r.pull, {});
export const isRid = (v: unknown): v is string => typeof v === "string" && /^res_[0-9A-Za-z]{4,40}$/.test(v);
const numberOf = (ref: string): number => Number(/\/pull\/(\d+)/.exec(ref)?.[1] ?? 0);

/** Write a result's record. Keys set to undefined are dropped. */
export function setPull(tx: Tx, id: string, pull: PullRecord): void {
  tx.sql.exec("UPDATE result SET pull = ? WHERE id = ?", JSON.stringify(pull), id);
  tx.stamp("result", id);
}

/** Who merges a thread's pull request, and reverts the merge: a person who may write to the thread. Never an agent. */
export function mayMerge(sql: Sql, p: Principal, s: SessionRec): boolean {
  const access = accessOf(sql, s.id);
  return isMember(p) && access !== null && mayWrite(p, "turn", access, s.id);
}

/** The result's pull request for `p` to merge or revert, or the refusal. */
export function pullFor(sql: Sql, p: Principal, resultId: unknown): { r: PullRec; s: SessionRec } | MutationRefusal {
  if (!isRid(resultId)) return refuse("invalid_request", "resultId");
  const r = sql.exec<PullRec>(`SELECT ${COLUMNS} FROM result WHERE id = ?`, resultId)[0];
  const s = r ? readSession(sql, r.session_id) : null;
  if (!r || !s || !seesSession(sql, p, s)) return refuse("not_found");
  if (r.kind !== "pr") return refuse("invalid_request", "kind");
  if (!mayMerge(sql, p, s)) return refuse("forbidden", "writers_only");
  return { r, s };
}

/**
 * Set (or with null, take off) the merge or revert `p` is about to ask GitHub for. Another person's,
 * begun less than `MERGING_MS` ago, is `refused` `merging`: one asks at a time.
 */
export function intend(tx: Tx, p: Principal, id: string, intent: { head: string } | "revert" | null): { ok: true } | MutationRefusal {
  const found = pullFor(tx.sql, p, id);
  if ("ok" in found) return found;
  const by = byOf(p);
  const { merging, reverting, ...pull } = pullOf(found.r);
  const other = [merging, reverting].find((i) => i !== undefined && i.by !== by && tx.now - i.at < MERGING_MS);
  if (intent === null) {
    // Theirs only: another person's stands.
    if (merging?.by === by || reverting?.by === by) setPull(tx, id, { ...pull, ...(merging && merging.by !== by ? { merging } : {}), ...(reverting && reverting.by !== by ? { reverting } : {}) });
    return { ok: true };
  }
  if (other) return refuse("refused", "merging", { by: other.by });
  setPull(tx, id, { ...pull, ...(intent === "revert" ? { reverting: { by, at: tx.now } } : { merging: { by, at: tx.now, head: intent.head } }) });
  return { ok: true };
}

/** The begun merge a merge of `head`, seen at `at`, belongs to; null when it is nobody's here. */
export function begunBy(pull: PullRecord, head: string | null | undefined, at: number): string | null {
  const m = pull.merging;
  return m && head === m.head && at - m.at < MERGING_MS ? m.by : null;
}

export type Merged = { method: MergeMethod | null; base: string | null; sha: string | null; branchDeleted: boolean };

/**
 * A merge `by` made from the surface: the result is `merged`, with its line (an `op`, whose reversal is
 * `result.revert`, not `undo`). Said again (the webhook after the edge, or the edge after the webhook),
 * it adds what the first did not know and makes no second line.
 */
export function recordMerge(tx: Tx, r: PullRec, by: string, m: Merged): NonNullable<PullRecord["merge"]> {
  const { merging: _merging, ...pull } = pullOf(r);
  const had = pull.merge;
  const fact = { method: m.method ?? had?.method ?? null, base: m.base ?? had?.base ?? null, branchDeleted: m.branchDeleted || had?.branchDeleted === true };
  const args = { resultId: r.id, number: numberOf(r.ref), ...fact };
  const trackId = readPlace(tx.sql, r.session_id)?.track_id ?? null;
  let op = had?.op;
  if (op === undefined) {
    op = tx.op({ by, name: "result.merge", args, inverse: null, fields: {}, sessionId: r.session_id, trackId, audience: r.audience });
  } else if (had!.method !== fact.method || had!.base !== fact.base || had!.branchDeleted !== fact.branchDeleted) {
    tx.sql.exec("UPDATE op SET args = ? WHERE id = ?", JSON.stringify(args), op);
    tx.stamp("op", op);
  }
  if (r.state !== "merged") tx.sql.exec("UPDATE result SET state = 'merged', state_at = ? WHERE id = ?", tx.now, r.id);
  const merge = { by: had?.by ?? by, at: had?.at ?? tx.now, ...fact, sha: m.sha ?? had?.sha ?? null, op };
  setPull(tx, r.id, { ...pull, merge });
  // The key `acceptPull` writes for the webhook of the same merge: one occurrence between them.
  tx.occur({ key: `${r.id}:merged`, kind: "result.changed", sessionId: r.session_id, trackId, by, audience: r.audience });
  settleReverts(tx, r.ref, by);
  return merge;
}

export type Reverted = { number: number; url: string; title: string; merged: boolean; why: string | null };

/**
 * The revert of a result's merge, as GitHub has it: on the record, and a `pr` result of the thread
 * itself, so its state is followed and one left open can be merged like any other.
 */
export function recordRevert(tx: Tx, r: PullRec, by: string, v: Reverted): { op: string | null } {
  const { reverting: _reverting, ...pull } = pullOf(r);
  const was = pull.revert;
  setPull(tx, r.id, { ...pull, revert: { number: v.number, url: v.url, merged: was?.merged === true, by: was?.by ?? by, at: was?.at ?? tx.now, why: v.merged ? null : v.why } });
  const state = v.merged ? "merged" : "open";
  const own = tx.sql.exec<{ id: string; state: string | null }>("SELECT id, state FROM result WHERE session_id = ? AND kind = 'pr' AND ref = ?", r.session_id, v.url)[0];
  if (!own) {
    tx.sql.exec(
      "INSERT INTO result (id, session_id, kind, ref, title, state, state_at, version, audience) VALUES (?, ?, 'pr', ?, ?, ?, ?, ?, ?)",
      crockfordId("res"),
      r.session_id,
      v.url,
      v.title,
      state,
      tx.now,
      tx.version(),
      r.audience,
    );
  } else if (v.merged && own.state !== "merged") {
    tx.sql.exec("UPDATE result SET state = 'merged', state_at = ? WHERE id = ?", tx.now, own.id);
    tx.stamp("result", own.id);
  }
  const trackId = readPlace(tx.sql, r.session_id)?.track_id ?? null;
  tx.occur({ key: `${r.id}:revert:${String(v.number)}:${String(v.merged)}`, kind: "result.changed", sessionId: r.session_id, trackId, by, audience: r.audience });
  return { op: v.merged ? settleReverts(tx, v.url, by) : null };
}

/**
 * The pull request at `url` is merged: every merge it is the revert of is reverted, wherever the merge
 * of the revert was made (here at once, here later from its own result, or on GitHub). The line's op, if one was made.
 */
export function settleReverts(tx: Tx, url: string, by: string): string | null {
  let made: string | null = null;
  for (const r of tx.sql.exec<PullRec>(`SELECT ${COLUMNS} FROM result WHERE kind = 'pr' AND json_extract(pull, '$.revert.url') = ?`, url)) {
    const pull = pullOf(r);
    if (!pull.revert || pull.revert.merged) continue;
    setPull(tx, r.id, { ...pull, revert: { ...pull.revert, merged: true, why: null } });
    if (pull.merge) {
      tx.sql.exec("UPDATE op SET undone_by = ? WHERE id = ? AND undone_by IS NULL", by, pull.merge.op);
      tx.stamp("op", pull.merge.op);
    }
    const trackId = readPlace(tx.sql, r.session_id)?.track_id ?? null;
    made = tx.op({ by, name: "result.revert", args: { resultId: r.id, number: pull.revert.number, url }, inverse: null, fields: {}, sessionId: r.session_id, trackId, audience: r.audience });
    tx.occur({ key: `${r.id}:revert:${String(pull.revert.number)}:true`, kind: "result.changed", sessionId: r.session_id, trackId, by, audience: r.audience });
  }
  return made;
}
