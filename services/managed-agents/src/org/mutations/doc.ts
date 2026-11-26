// `doc.save`, `read.set`, `pref.set` (spec 39, 22.3).
//
// A Doc's `spans` are `{ from, to, by }[]`: 0-based line ranges, `to` exclusive, each with who wrote
// those lines. Only a person's spans matter: an agent's save may not change a line inside one. A
// person's span is unchanged when its lines still appear, in order and together, in the new text;
// the server then moves the span to where they are. An agent's own lines are not marked.

import type { Principal } from "../../actor/principal.js";
import { holdsTrack, isMember, isPerson, mint, ownsTrack, parse, readSession, readTrack, seesSession, seesTrack, type Tx } from "../tx.js";
import { anchorOf, byFor, isBy, isSid, isStr, isTid } from "./common.js";
import { applied, refuse, refuseKeeping, type MutationFn } from "./outcome.js";
import type { MutationName } from "./table.js";

export type Span = { from: number; to: number; by: string };

const lines = (text: string): string[] => (text === "" ? [] : text.split("\n"));

function validSpans(v: unknown, count: number): v is Span[] {
  return (
    Array.isArray(v) &&
    v.length <= 1000 &&
    v.every((s) => typeof s === "object" && s !== null && Number.isInteger(s.from) && Number.isInteger(s.to) && s.from >= 0 && s.from < s.to && s.to <= count && isBy(s.by))
  );
}

/**
 * The person's spans of `old` moved onto `text`, and whether every one survived. A span whose lines
 * are no longer there together is dropped (and `kept` is false).
 */
export function relocate(oldText: string, oldSpans: Span[], text: string): { spans: Span[]; kept: boolean } {
  const before = lines(oldText);
  const after = lines(text);
  const out: Span[] = [];
  let kept = true;
  let from = 0;
  for (const span of [...oldSpans].filter((s) => isPerson(s.by)).sort((a, b) => a.from - b.from)) {
    const block = before.slice(span.from, span.to);
    let at = -1;
    for (let i = from; i + block.length <= after.length; i++) {
      if (block.every((line, j) => after[i + j] === line)) {
        at = i;
        break;
      }
    }
    if (at < 0) {
      kept = false;
      continue;
    }
    out.push({ from: at, to: at + block.length, by: span.by });
    from = at + block.length;
  }
  return { spans: out, kept };
}

/** An open proposal of a kind on a target, voiding older open ones of that kind (spec 39, `proposal.create`). */
export function openProposal(tx: Tx, o: { id: string; kind: string; target: string; by: string; what: string; args: unknown }): void {
  const anchor = anchorOf(tx, o.target)!;
  for (const r of tx.sql.exec<{ id: string }>("SELECT id FROM proposal WHERE target = ? AND kind = ? AND state = 'open'", o.target, o.kind)) {
    tx.sql.exec("UPDATE proposal SET state = 'void' WHERE id = ?", r.id);
    tx.stamp("proposal", r.id);
  }
  tx.sql.exec(
    "INSERT INTO proposal (id, kind, target, by, what, args, state, at_seq, version, audience) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
    o.id,
    o.kind,
    o.target,
    o.by,
    o.what,
    o.args === undefined ? null : JSON.stringify(o.args),
    anchor.atSeq,
    tx.version(),
    anchor.audience,
  );
  tx.occur({ key: `${o.target}:org:${tx.version()}:proposal.created`, kind: "proposal.created", sessionId: anchor.sessionId, trackId: anchor.trackId, by: o.by, audience: anchor.audience });
}

// ------------------------------------------------------------------ doc.save

const docSave: MutationFn = (tx, p, args) => {
  const { tid, baseRev, text } = args;
  if (!isTid(tid)) return refuse("invalid_request", "tid");
  if (!Number.isInteger(baseRev)) return refuse("invalid_request", "baseRev");
  if (typeof text !== "string" || text.length > 200_000) return refuse("invalid_request", "text");
  const t = readTrack(tx.sql, tid);
  if (!t || !seesTrack(tx.sql, p, t)) return refuse("not_found");
  if (!(p.kind === "platform" || ownsTrack(p, t) || holdsTrack(p, t))) return refuse("not_found");
  const doc = tx.sql.exec<{ rev: number; text: string; spans: string }>("SELECT rev, text, spans FROM doc WHERE track_id = ?", tid)[0];
  if (!doc) return refuse("not_found");
  if (baseRev !== doc.rev) return refuse("conflict", "conflict", { rev: doc.rev, text: doc.text });
  const by = byFor(p, args);

  let spans: Span[];
  if (p.kind === "agent") {
    const moved = relocate(doc.text, parse<Span[]>(doc.spans, []), text);
    if (!moved.kept) {
      const proposalId = typeof args.proposalId === "string" && /^prp_[0-9A-Za-z]{4,40}$/.test(args.proposalId) ? args.proposalId : mint("prp");
      return refuseKeeping("refused", "proposed", { proposalId }, (k) =>
        openProposal(k, { id: proposalId, kind: "edit", target: tid, by, what: "A change to lines you wrote in the Doc", args: { baseRev: doc.rev, text, spans: moved.spans } }),
      );
    }
    spans = moved.spans;
  } else {
    if (!validSpans(args.spans, lines(text).length)) return refuse("invalid_request", "spans");
    spans = args.spans;
  }

  const rev = doc.rev + 1;
  tx.sql.exec("UPDATE doc SET rev = ?, text = ?, spans = ? WHERE track_id = ?", rev, text, JSON.stringify(spans), tid);
  tx.stamp("doc", tid);
  tx.sql.exec("INSERT OR REPLACE INTO doc_rev (track_id, rev, by, at, text) VALUES (?, ?, ?, ?, ?)", tid, rev, by, tx.now, text);
  return applied({ rev });
};

// ------------------------------------------------------------------ read.set, pref.set (a member's own)

const readSet: MutationFn = (tx, p, args) => {
  const { sid, seq } = args;
  if (!isSid(sid)) return refuse("invalid_request", "sid");
  if (!Number.isInteger(seq) || (seq as number) < 0) return refuse("invalid_request", "seq");
  if (!isMember(p)) return refuse("not_found");
  const s = readSession(tx.sql, sid);
  if (!s || !seesSession(tx.sql, p, s)) return refuse("not_found");
  const audience = `member:${p.subject}`;
  const now = tx.sql.exec<{ read_seq: number }>("SELECT read_seq FROM read WHERE member = ? AND session_id = ?", p.subject, sid)[0]?.read_seq;
  if (now !== undefined && now >= (seq as number)) return applied();
  tx.sql.exec("INSERT OR REPLACE INTO read (member, session_id, read_seq, version, audience) VALUES (?, ?, ?, ?, ?)", p.subject, sid, seq, tx.version(), audience);
  return applied();
};

const prefSet: MutationFn = (tx, p, args) => {
  const { key, value } = args;
  if (!isStr(key, 100)) return refuse("invalid_request", "key");
  const json = JSON.stringify(value ?? null);
  if (json.length > 20_000) return refuse("invalid_request", "value");
  if (!isMember(p)) return refuse("not_found");
  tx.sql.exec("INSERT OR REPLACE INTO pref (member, key, value, version, audience) VALUES (?, ?, ?, ?, ?)", p.subject, key, json, tx.version(), `member:${p.subject}`);
  return applied();
};

export const DOC_MUTATIONS = {
  "doc.save": docSave,
  "read.set": readSet,
  "pref.set": prefSet,
} satisfies Partial<Record<MutationName, MutationFn>>;

/** Whether `p` may answer a proposal on `target`: a member who owns it (19.2). */
export function ownsTarget(tx: Tx, p: Principal, target: string): boolean {
  if (p.kind === "platform") return true;
  const anchor = anchorOf(tx, target);
  return anchor !== null && isMember(p) && anchor.owner === p.subject;
}
