// `undo { opId, resolution?, threads? }` (spec 19.3, 39).
//
// It applies the op's inverse if every field in the op's `fields` still has the value the op gave
// it, and every track the op made or removed is still so; otherwise it is `refused` `changed` with
// `would` (what a reversal would now do), and `resolution: 'force'` does it anyway. Where the
// reversal dissolves a track whose agent started threads (T8u), `threads: 'keep' | 'stop'` is the
// choice; without it, `refused` `choose_threads`. The reversal is itself an op, named `undo`.

import { parse } from "../parse-json.js";
import { readSession, readTrack } from "../records.js";
import type { Tx } from "../tx.js";
import { isMember } from "../who-may.js";
import type { Principal } from "../../../auth/principal.js";
import { byFor } from "./args.js";
import { Changes, type OpFields, type OpInverse, type Table, type Values } from "./changes.js";
import { applied, refuse, type MutationFn } from "./outcome.js";
import type { MutationName } from "./table.js";
import { deleteThread } from "./thread.js";

type OpRec = { id: string; name: string; args: string; inverse: string | null; fields: string; session_id: string | null; track_id: string | null; undone_by: string | null; audience: string };
type Plan = { fields: OpFields; inverse: OpInverse };

const KEYS: Record<Table, string> = { place: "session_id", track: "id", session: "id" };

/** The op's fields and inverse in the one shape; `thread.rename` writes its own two-field form. */
function planOf(op: OpRec): Plan {
  const fields = parse<Record<string, unknown>>(op.fields, {});
  const inverse = parse<Record<string, unknown>>(op.inverse, {});
  if ("rows" in fields) return { fields: fields as OpFields, inverse: { rows: {}, ...(inverse as Partial<OpInverse>) } };
  const rk = `session:${op.session_id}`;
  return { fields: { rows: { [rk]: { title: fields.title ?? null, title_by: fields.title_by ?? null } } }, inverse: { rows: { [rk]: { title: inverse.title ?? null, title_by: inverse.titleBy ?? null } } } };
}

/** The member the op's row belongs to. */
function ownerOf(tx: Tx, op: OpRec): string | null {
  const s = op.session_id ? readSession(tx.sql, op.session_id) : null;
  if (s) return s.owner;
  const t = op.track_id ? readTrack(tx.sql, op.track_id) : null;
  if (t) return t.owner;
  return op.audience.startsWith("member:") ? op.audience.slice(7) : null;
}

const split = (rk: string): [Table, string] => {
  const i = rk.indexOf(":");
  return [rk.slice(0, i) as Table, rk.slice(i + 1)];
};

const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

/** Where the rows are not as the op left them: `{ row, column, now, op, back }`. */
function drift(tx: Tx, plan: Plan): Values[] {
  const out: Values[] = [];
  for (const [rk, values] of Object.entries(plan.fields.rows)) {
    const [table, key] = split(rk);
    const row = tx.sql.exec<Values>(`SELECT * FROM ${table} WHERE ${KEYS[table]} = ?`, key)[0];
    for (const [column, value] of Object.entries(values)) {
      const now = row ? (row[column] ?? null) : undefined;
      if (!same(now, value)) out.push({ row: rk, column, now: now === undefined ? "gone" : now, op: value, back: plan.inverse.rows[rk]?.[column] ?? null });
    }
  }
  for (const [tid, state] of Object.entries(plan.fields.tracks ?? {})) {
    const there = readTrack(tx.sql, tid) !== null;
    if (there !== (state === "present")) out.push({ row: `track:${tid}`, column: "exists", now: there, op: state === "present", back: state !== "present" });
  }
  return out;
}

const undo: MutationFn = (tx, p: Principal, args) => {
  const { opId, resolution, threads } = args;
  if (typeof opId !== "string" || !/^op_[0-9A-Za-z]{4,40}$/.test(opId)) return refuse("invalid_request", "opId");
  if (resolution !== undefined && resolution !== null && resolution !== "force") return refuse("invalid_request", "resolution");
  if (threads !== undefined && threads !== null && threads !== "keep" && threads !== "stop") return refuse("invalid_request", "threads");
  const op = tx.sql.exec<OpRec>("SELECT * FROM op WHERE id = ?", opId)[0];
  if (!op) return refuse("not_found");
  if (p.kind !== "platform" && !(isMember(p) && ownerOf(tx, op) === p.subject)) return refuse("not_found");
  if (op.undone_by !== null) return refuse("refused", "undone");
  // A merge is undone on GitHub, by `result.revert`.
  if (op.name === "result.merge" || op.name === "result.revert") return refuse("refused", "on_github");

  const plan = planOf(op);
  const changed = drift(tx, plan);
  if (changed.length > 0 && resolution !== "force") return refuse("refused", "changed", { would: changed });

  // T8u: the threads the track's agent started, in a track this reversal dissolves.
  const started: string[] = [];
  for (const tid of plan.inverse.dissolve ?? []) {
    const t = readTrack(tx.sql, tid);
    if (!t) continue;
    for (const r of tx.sql.exec<{ session_id: string }>("SELECT session_id FROM place WHERE track_id = ? AND parent_session = ?", tid, t.agent_session)) started.push(r.session_id);
  }
  if (started.length > 0 && !threads) return refuse("refused", "choose_threads", { threads: started });

  const by = byFor(p, args);
  if (threads === "stop") {
    for (const sid of started) {
      const s = readSession(tx.sql, sid);
      if (s) deleteThread(tx, by, s, tx.sql.exec<never>("SELECT * FROM place WHERE session_id = ?", sid)[0] ?? null);
    }
  }
  const ch = new Changes(tx, by);
  for (const snap of plan.inverse.restore ?? []) ch.restore(snap);
  for (const [rk, values] of Object.entries(plan.inverse.rows)) {
    const [table, key] = split(rk);
    ch.set(table, key, values);
  }
  for (const tid of plan.inverse.dissolve ?? []) ch.dissolve(tid, "keep");

  tx.sql.exec("UPDATE op SET undone_by = ? WHERE id = ?", by, op.id);
  tx.stamp("op", op.id);
  // Undoing an undo makes the first op undoable again.
  if (op.name === "undo") {
    const first = parse<{ opId?: string }>(op.args, {}).opId;
    if (first && tx.sql.exec("UPDATE op SET undone_by = NULL WHERE id = ? RETURNING id", first).length > 0) tx.stamp("op", first);
  }
  const sessionId = op.session_id && readSession(tx.sql, op.session_id) ? op.session_id : null;
  const id = ch.op({ name: "undo", args: { opId: op.id, resolution: resolution ?? null, threads: threads ?? null }, sessionId, trackId: op.track_id, audience: op.audience });
  return applied({ op: id });
};

export const UNDO_MUTATIONS = { undo } satisfies Partial<Record<MutationName, MutationFn>>;
