// `result.add` and `review.save` (spec 39): an agent's own session only (19.2).
// `result.merge` and `result.revert` (work 118): a person who may write to the result's thread. The
// edge does GitHub's part first (http/api/result-merge.ts) and these record what it did.

import { Validator, type Schema } from "@cfworker/json-schema";
// The review summary's schema: defined in the SDK (sdks/typescript/src/computer/review.ts), copied here by its `npm run schema`.
import reviewSchema from "../review.v1.json" with { type: "json" };
import { accessOf } from "../access.js";
import type { MergeFacts, RevertFacts } from "../contract.js";
import { parse } from "../parse-json.js";
import { readPlace, readSession, type SessionRec } from "../records.js";
import { summaryOf } from "../summary.js";
import type { Tx } from "../tx.js";
import { isMember, isOwnSession, seesSession } from "../who-may.js";
import { mayWrite, type Principal } from "../../../auth/principal.js";
import type { Sql } from "../../../durable/sql.js";
import { byFor, isSid, isStr, optStr } from "./args.js";
import { applied, refuse, type MutationFn } from "./outcome.js";
import type { MutationName } from "./table.js";

const KINDS = new Set(["pr", "changes", "preview", "file", "document"]);
const ownAgent = (p: Principal, sid: string): boolean => p.kind === "platform" || isOwnSession(p, sid);
const isRid = (v: unknown): v is string => typeof v === "string" && /^res_[0-9A-Za-z]{4,40}$/.test(v);

const resultAdd: MutationFn = (tx, p, args) => {
  const { resultId, sid, kind, ref, title, meta } = args;
  if (!isRid(resultId)) return refuse("invalid_request", "resultId");
  if (!isSid(sid)) return refuse("invalid_request", "sid");
  if (typeof kind !== "string" || !KINDS.has(kind)) return refuse("invalid_request", "kind");
  if (!isStr(ref, 2000)) return refuse("invalid_request", "ref");
  if (!optStr(title, 300)) return refuse("invalid_request", "title");
  if (meta !== undefined && meta !== null && (typeof meta !== "object" || JSON.stringify(meta).length > 20_000)) return refuse("invalid_request", "meta");
  const s = readSession(tx.sql, sid);
  if (!s || !ownAgent(p, sid)) return refuse("not_found");
  const metaText = meta === undefined || meta === null ? null : JSON.stringify(meta);
  const found = tx.sql.exec<{ id: string }>("SELECT id FROM result WHERE session_id = ? AND kind = ? AND ref = ?", sid, kind, ref)[0];
  let id = resultId;
  if (found) {
    id = found.id;
    tx.sql.exec("UPDATE result SET title = ?, meta = COALESCE(?, meta) WHERE id = ?", title ?? null, metaText, id);
    tx.stamp("result", id);
  } else {
    if (tx.sql.exec("SELECT 1 FROM result WHERE id = ?", resultId).length > 0) return refuse("taken");
    tx.sql.exec(
      "INSERT INTO result (id, session_id, kind, ref, title, meta, version, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      resultId,
      sid,
      kind,
      ref,
      title ?? null,
      metaText,
      tx.version(),
      s.audience,
    );
    // R20: a pull request waiting on the person is what makes its thread Ready, whether or not the agent says so.
    const place = kind === "pr" ? readPlace(tx.sql, sid) : null;
    if (place && place.done_at === null) {
      tx.sql.exec("UPDATE place SET ready_seq = ?, ready_what = ?, ready_result = ? WHERE session_id = ?", summaryOf(s).lastSeq, `Pull request: ${title ?? ref}`.slice(0, 500), resultId, sid);
      tx.stamp("place", sid);
      tx.occurFor("thread.ready", s, byFor(p, args), place.track_id);
    }
  }
  tx.occurFor("result.changed", s, byFor(p, args));
  return applied({ resultId: id });
};

const review = new Validator(reviewSchema as Schema, "2020-12", false);

const reviewSave: MutationFn = (tx: Tx, p, args) => {
  const { resultId, head, parts } = args;
  if (!isRid(resultId)) return refuse("invalid_request", "resultId");
  const checked = review.validate({ head, parts });
  if (!checked.valid) {
    // The deepest errors say what is wrong; the rest only say that a parent is.
    const why = checked.errors.filter((e) => !checked.errors.some((o) => o !== e && o.instanceLocation.startsWith(`${e.instanceLocation}/`)));
    const at = why[0]?.instanceLocation.split("/")[1] === "head" ? "head" : "parts";
    return refuse("invalid_request", at, { message: `The review summary does not fit its schema: ${why.slice(0, 5).map((e) => `${e.instanceLocation.slice(1) || "body"}: ${e.error}`).join("; ")}` });
  }
  if (JSON.stringify(parts).length > 500_000) return refuse("invalid_request", "parts");
  const r = tx.sql.exec<{ session_id: string }>("SELECT session_id FROM result WHERE id = ?", resultId)[0];
  if (!r || !ownAgent(p, r.session_id)) return refuse("not_found");
  tx.sql.exec("INSERT OR REPLACE INTO review (result_id, head, parts) VALUES (?, ?, ?)", resultId, head, JSON.stringify(parts));
  return applied();
};

/** Who merges a thread's pull request, and reverts the merge: a person who may write to the thread. Never an agent. */
export function mayMerge(sql: Sql, p: Principal, s: SessionRec): boolean {
  const access = accessOf(sql, s.id);
  return isMember(p) && access !== null && mayWrite(p, "turn", access, s.id);
}

type PullRec = { id: string; session_id: string; kind: string; ref: string; state: string | null; meta: string | null; audience: string };

/** The result's pull request for `p` to merge or revert, or the refusal. */
export function pullFor(sql: Sql, p: Principal, resultId: unknown): { r: PullRec; s: SessionRec } | ReturnType<typeof refuse> {
  if (!isRid(resultId)) return refuse("invalid_request", "resultId");
  const r = sql.exec<PullRec>("SELECT id, session_id, kind, ref, state, meta, audience FROM result WHERE id = ?", resultId)[0];
  const s = r ? readSession(sql, r.session_id) : null;
  if (!r || !s || !seesSession(sql, p, s)) return refuse("not_found");
  if (r.kind !== "pr") return refuse("invalid_request", "kind");
  if (!mayMerge(sql, p, s)) return refuse("forbidden", "writers_only");
  return { r, s };
}

const resultMerge: MutationFn = (tx, p, args) => {
  const found = pullFor(tx.sql, p, args.resultId);
  if ("ok" in found) return found;
  const { r, s } = found;
  const g = args.github as Partial<MergeFacts> | undefined;
  // Only the edge says GitHub merged it.
  if (!g || typeof g.number !== "number" || typeof g.base !== "string") return refuse("refused", "unmerged");
  const by = byFor(p, args);
  const { merging, ...meta } = parse<Record<string, unknown>>(r.meta, {});
  // Found merged: this person's, if they began it (the reply of their first try was lost); else someone's on GitHub.
  const mine = g.method ? true : (merging as { by?: string } | undefined)?.by === by && meta.merge === undefined && r.state !== "merged";
  const merge = mine ? { by, at: tx.now, method: g.method ?? null, base: g.base, sha: g.sha ?? null, branchDeleted: g.branchDeleted === true } : meta.merge;
  tx.sql.exec("UPDATE result SET state = 'merged', state_at = ?, meta = ? WHERE id = ?", tx.now, JSON.stringify(merge ? { ...meta, merge } : meta), r.id);
  tx.stamp("result", r.id);
  const trackId = readPlace(tx.sql, s.id)?.track_id ?? null;
  // The key `acceptPull` writes for the webhook of the same merge.
  tx.occur({ key: `${r.id}:merged`, kind: "result.changed", sessionId: s.id, trackId, by, audience: r.audience });
  // Someone else's merge: the state, and no line.
  if (!mine) return applied({ number: g.number, base: g.base, method: null });
  const op = tx.op({
    by,
    name: "result.merge",
    args: { resultId: r.id, number: g.number, base: g.base, method: g.method ?? null, branchDeleted: g.branchDeleted === true },
    // Its reversal is GitHub's (`result.revert`), not `undo`'s.
    inverse: null,
    fields: {},
    sessionId: s.id,
    trackId,
    audience: r.audience,
  });
  return applied({ op, number: g.number, base: g.base, method: g.method ?? null, branchDeleted: g.branchDeleted === true });
};

const resultRevert: MutationFn = (tx, p, args) => {
  const found = pullFor(tx.sql, p, args.resultId);
  if ("ok" in found) return found;
  const { r, s } = found;
  if (r.state !== "merged") return refuse("refused", "not_merged");
  const g = args.github as Partial<RevertFacts> | undefined;
  if (!g || typeof g.number !== "number" || typeof g.url !== "string") return refuse("refused", "unreverted");
  const by = byFor(p, args);
  const meta = parse<Record<string, unknown>>(r.meta, {});
  const revert = { number: g.number, url: g.url, merged: g.merged === true, by, at: tx.now };
  tx.sql.exec("UPDATE result SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, revert }), r.id);
  tx.stamp("result", r.id);
  const trackId = readPlace(tx.sql, s.id)?.track_id ?? null;
  tx.occur({ key: `${r.id}:revert:${String(g.number)}:${String(revert.merged)}`, kind: "result.changed", sessionId: s.id, trackId, by, audience: r.audience });
  // The revert is open and unmerged (it conflicts, or a rule holds it): the result says so, and the merge's line stands.
  if (!revert.merged) return applied({ number: g.number, url: g.url, merged: false });
  for (const merged of tx.sql.exec<{ id: string }>("SELECT id FROM op WHERE session_id = ? AND name = 'result.merge' AND undone_by IS NULL AND json_extract(args, '$.resultId') = ?", s.id, r.id)) {
    tx.sql.exec("UPDATE op SET undone_by = ? WHERE id = ?", by, merged.id);
    tx.stamp("op", merged.id);
  }
  const op = tx.op({ by, name: "result.revert", args: { resultId: r.id, number: g.number, url: g.url }, inverse: null, fields: {}, sessionId: s.id, trackId, audience: r.audience });
  return applied({ op, number: g.number, url: g.url, merged: true });
};

export const RESULT_MUTATIONS = {
  "result.add": resultAdd,
  "review.save": reviewSave,
  "result.merge": resultMerge,
  "result.revert": resultRevert,
} satisfies Partial<Record<MutationName, MutationFn>>;
