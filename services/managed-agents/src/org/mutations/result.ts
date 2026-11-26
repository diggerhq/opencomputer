// `result.add` and `review.save` (spec 39): an agent's own session only (19.2).

import { Validator, type Schema } from "@cfworker/json-schema";
// The review summary's schema: defined in the SDK (sdks/typescript/src/computer/review.ts), copied here by its `npm run schema`.
import reviewSchema from "../review.v1.json" with { type: "json" };
import { isOwnSession, readSession, type Tx } from "../tx.js";
import type { Principal } from "../../auth/principal.js";
import { byFor, isSid, isStr, optStr } from "./common.js";
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

export const RESULT_MUTATIONS = {
  "result.add": resultAdd,
  "review.save": reviewSave,
} satisfies Partial<Record<MutationName, MutationFn>>;
