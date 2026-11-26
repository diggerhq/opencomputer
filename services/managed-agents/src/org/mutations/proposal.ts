// `proposal.create`, `proposal.accept`, `proposal.dismiss` (spec 39, 19.2).
//
// `args` by kind: `done` `{ outcome? }` on a thread or a track; `move` `{ trackId }` on a thread;
// `wrap` `{ name? }` on a thread; `edit` `{ baseRev, text, spans }` on a track (written by `doc.save`).

import { holdsTrack, isOwnSession, parse, readPlace, readTrack, type Tx } from "../tx.js";
import type { Principal } from "../../auth/principal.js";
import { crockfordId } from "../../ids/crockford.js";
import { byFor, isStr, isTid } from "./common.js";
import { openProposal, ownsTarget } from "./doc.js";
import { runMutation } from "./index.js";
import { applied, refuse, refuseKeeping, type MutationFn, type MutationRefusal } from "./outcome.js";
import type { MutationName } from "./table.js";

type ProposalRec = { id: string; kind: string; target: string; by: string; what: string | null; args: string | null; state: string; audience: string };
const isPid = (v: unknown): v is string => typeof v === "string" && /^prp_[0-9A-Za-z]{4,40}$/.test(v);

/** 19.2's agent clause: its own session, its track, or that track's threads. */
function agentReaches(tx: Tx, p: Principal, target: string): boolean {
  if (p.kind === "platform") return true;
  if (p.kind !== "agent") return false;
  if (target.startsWith("trk_")) return holdsTrack(p, readTrack(tx.sql, target));
  if (isOwnSession(p, target)) return true;
  const place = readPlace(tx.sql, target);
  return place?.track_id != null && holdsTrack(p, readTrack(tx.sql, place.track_id));
}

const proposalCreate: MutationFn = (tx, p, args) => {
  const { proposalId, kind, target, what } = args;
  const a = (args.args ?? {}) as Record<string, unknown>;
  if (!isPid(proposalId)) return refuse("invalid_request", "proposalId");
  if (!isStr(what, 500)) return refuse("invalid_request", "what");
  if (typeof target !== "string" || !/^(cs|trk)_[0-9A-Za-z]{4,40}$/.test(target)) return refuse("invalid_request", "target");
  if (typeof a !== "object" || a === null || Array.isArray(a)) return refuse("invalid_request", "args");
  const onTrack = target.startsWith("trk_");
  const shape =
    (kind === "done" && (a.outcome === undefined || isStr(a.outcome, 200))) ||
    (kind === "move" && !onTrack && isTid(a.trackId)) ||
    (kind === "wrap" && !onTrack && (a.name === undefined || isStr(a.name, 200))) ||
    (kind === "edit" && onTrack && Number.isInteger(a.baseRev) && typeof a.text === "string");
  if (!shape) return refuse("invalid_request", "kind");
  if (!agentReaches(tx, p, target)) return refuse("not_found");
  if (onTrack ? !readTrack(tx.sql, target) : !readPlace(tx.sql, target)) return refuse("not_found");
  if (tx.sql.exec("SELECT 1 FROM proposal WHERE id = ?", proposalId).length > 0) return refuse("taken");
  openProposal(tx, { id: proposalId, kind: kind as string, target, by: byFor(p, args), what, args: a });
  return applied();
};

const isRefusal = (v: unknown): v is MutationRefusal => typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

function openOf(tx: Tx, p: Principal, id: unknown): ProposalRec | MutationRefusal {
  if (!isPid(id)) return refuse("invalid_request", "proposalId");
  const r = tx.sql.exec<ProposalRec>("SELECT * FROM proposal WHERE id = ?", id)[0];
  if (!r || !ownsTarget(tx, p, r.target)) return refuse("not_found");
  if (r.state !== "open") return refuse("refused", "not_open");
  return r;
}

const settle = (tx: Tx, id: string, state: string) => {
  tx.sql.exec("UPDATE proposal SET state = ? WHERE id = ?", state, id);
  tx.stamp("proposal", id);
};

const proposalAccept: MutationFn = (tx, p, args) => {
  const r = openOf(tx, p, args.proposalId);
  if (isRefusal(r)) return r;
  const a = parse<Record<string, unknown>>(r.args, {});
  const onTrack = r.target.startsWith("trk_");
  const [name, margs]: [string, Record<string, unknown>] =
    r.kind === "done"
      ? onTrack
        ? ["track.done", { tid: r.target, outcome: a.outcome }]
        : ["thread.done", { sid: r.target, outcome: a.outcome }]
      : r.kind === "move"
        ? ["thread.place", { sid: r.target, trackId: a.trackId }]
        : r.kind === "wrap"
          ? ["track.create", { tid: crockfordId("trk"), agentSessionId: crockfordId("cs"), name: a.name, sid: r.target }]
          : ["doc.save", { tid: r.target, baseRev: a.baseRev, text: a.text, spans: a.spans ?? [] }];
  const out = runMutation(tx, p, name, margs);
  if (!out.ok) {
    if (r.kind === "edit" && out.code === "conflict") {
      const { ok: _ok, code, reason, ...more } = out;
      return refuseKeeping(code, reason, more, (k) => settle(k, r.id, "void"));
    }
    return out;
  }
  if (tx.sql.exec("SELECT 1 FROM proposal WHERE id = ?", r.id).length > 0) settle(tx, r.id, "accepted");
  return out;
};

const proposalDismiss: MutationFn = (tx, p, args) => {
  const r = openOf(tx, p, args.proposalId);
  if (isRefusal(r)) return r;
  settle(tx, r.id, "dismissed");
  return applied();
};

export const PROPOSAL_MUTATIONS = {
  "proposal.create": proposalCreate,
  "proposal.accept": proposalAccept,
  "proposal.dismiss": proposalDismiss,
} satisfies Partial<Record<MutationName, MutationFn>>;
