// The mutations of section 39, with their `op` rows and inverses, and how Org applies a member's
// request (section 37.3, rules 1 to 6).

import type { DocRow, MutationError, MutationName, OpRow, PlaceRow, ProposalRow, ResultRow, Row, RowKind, TrackRow } from "../types.js";
import { ReviewSummary } from "../review.js";
import { agentActor, clone, isPerson, personActor, PLATFORM, Refusal, statusOf, type Ctx } from "./ctx.js";

interface Ref {
  kind: RowKind;
  id: string;
  field: string;
  value: unknown;
}

/** What an `op` row stores for `undo`: fields to set back, rows to put back, or a mutation to run. */
interface Inverse {
  set?: Ref[];
  restore?: Row[];
  run?: { name: MutationName; args: Record<string, unknown> };
}

/** Records what a mutation sets: the old values are the inverse, the new ones the op's `fields`. */
class Rec {
  before: Ref[] = [];
  after: Ref[] = [];
  restore: Row[] = [];
}

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Refusal("invalid_request", `${name} is required`);
  return v;
};

export class Mutations {
  constructor(private ctx: Ctx) {}

  /** A member's request: `{ status, body }` as the HTTP reply. */
  member(clientId: string, n: number, name: MutationName, args: Args): { status: number; body: unknown } {
    const { org } = this.ctx;
    let c = org.clients.get(clientId);
    if (!c) org.clients.set(clientId, (c = { last: 0, errors: [] }));
    if (n <= c.last) return { status: 200, body: { protocol: 1, lastMutation: c.last } };
    if (n > c.last + 1) return { status: 409, body: { error: { code: "out_of_order", message: `expected ${c.last + 1}`, lastMutation: c.last } } };
    const client = c;
    return org.tx(() => {
      client.last = n;
      org.applied(clientId, n);
      try {
        const value = this.run(this.ctx.principal.subject, name, args);
        return { status: 200, body: { protocol: 1, lastMutation: n, ...(value === undefined ? {} : { value }) } };
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        const err: MutationError = { n, code: e.code, reason: e.reason };
        client.errors.push(err);
        return { status: statusOf(e.code), body: { error: { code: e.code, reason: e.reason, message: e.reason, lastMutation: n, ...e.detail } } };
      }
    });
  }

  /** Org's mutation function. `by` is a member id, `agent:<session>`, `rule:<name>` or `platform`. Throws `Refusal`. */
  run(by: string, name: string, args: Args): unknown {
    const fn = (this as unknown as Record<string, ((by: string, a: Args) => unknown) | undefined>)[name.replace(/[._]/g, "$")];
    if (!fn || !name.includes(".") && name !== "undo") throw new Refusal("not_found", `no mutation ${name}`);
    return this.ctx.org.tx(() => fn.call(this, by, args ?? {}));
  }

  // ---------- helpers

  private set(rec: Rec, row: Row, field: string, value: unknown): void {
    const r = row as unknown as Record<string, unknown>;
    if (JSON.stringify(r[field] ?? null) === JSON.stringify(value ?? null)) return;
    rec.before.push({ kind: row.kind, id: row.id, field, value: clone(r[field] ?? null) });
    rec.after.push({ kind: row.kind, id: row.id, field, value: clone(value ?? null) });
    r[field] = value;
    this.ctx.org.touch(row);
    if (row.kind === "place") this.ctx.org.sync(row.id);
  }

  private op(by: string, name: string, args: Args, rec: Rec, where: { sessionId?: string | null; trackId?: string | null }, inverse?: Inverse): string {
    const { org, ctx } = { org: this.ctx.org, ctx: this.ctx };
    const sid = where.sessionId ?? null;
    const tid = where.trackId ?? null;
    const anchor = sid ?? (tid ? org.get("track", tid)?.agentSession : null) ?? null;
    const row: OpRow = {
      kind: "op",
      id: ctx.id("op"),
      version: 0,
      at: ctx.now(),
      by,
      name: name as MutationName,
      args: clone(args),
      inverse: inverse ?? { set: rec.before, ...(rec.restore.length ? { restore: rec.restore } : {}) },
      fields: rec.after,
      sessionId: sid,
      trackId: tid ?? (sid ? (org.place(sid)?.trackId ?? null) : null),
      atSeq: anchor ? (org.get("session", anchor)?.lastSeq ?? null) : null,
      undoneBy: null,
    };
    org.put(row);
    return row.id;
  }

  private thread(sid: unknown): PlaceRow {
    return this.ctx.org.need("place", sid as string);
  }

  private titleOf(sid: string): string {
    return this.ctx.org.get("session", sid)?.title ?? "";
  }

  /** `thread.done`'s effect, into `rec`. */
  private finish(rec: Rec, p: PlaceRow, outcome: string, by: string): void {
    const { org, log } = this.ctx;
    if (p.doneAt != null) return;
    const s = org.get("session", p.id);
    if (s && (s.status === "running" || s.status === "starting" || s.status === "waiting")) log.interrupt(p.id, by);
    const now = this.ctx.now();
    this.set(rec, p, "doneAt", now);
    this.set(rec, p, "outcome", outcome);
    this.set(rec, p, "doneBy", by);
    this.set(rec, p, "earlierAt", now);
    for (const x of org.all("proposal")) if (x.target === p.id && x.type === "done" && x.state === "open") this.set(rec, x, "state", "accepted");
    org.occur("thread.done", `${p.id}:done:${now}`, { sessionId: p.id, by });
  }

  /** `track.dissolve`'s effect, into `rec`: the places leave, the agent's session, the Doc and the track go. */
  private dissolveInto(rec: Rec, t: TrackRow, threads: "keep" | "stop", by: string): void {
    const { org, log } = this.ctx;
    for (const p of org.threadsOf(t.id)) {
      this.set(rec, p, "trackId", null);
      if (threads === "stop") log.interrupt(p.id, by);
    }
    log.interrupt(t.agentSession, by);
    const doc = org.doc(t.id);
    const agent = org.get("session", t.agentSession);
    for (const x of org.all("proposal")) if (x.target === t.id && x.state === "open") this.set(rec, x, "state", "void");
    rec.restore.push(...clone([t, ...(doc ? [doc] : []), ...(agent ? [agent] : [])]));
    org.remove("doc", t.id);
    org.remove("session", t.agentSession);
    org.remove("track", t.id);
  }

  private dissolveIfEmpty(rec: Rec, tid: string | null, by: string): void {
    const t = tid ? this.ctx.org.get("track", tid) : undefined;
    if (t && this.ctx.org.threadsOf(t.id).length === 0) this.dissolveInto(rec, t, "keep", by);
  }

  /** R30: an agent does not rename what a person named. */
  private notOverPerson(by: string, setBy: string | null): void {
    if (!isPerson(by) && isPerson(setBy)) throw new Refusal("refused", "user_set");
  }

  // ---------- threads (method names are the mutation's, `.` and `_` as `$`)

  thread$rename(by: string, a: Args): void {
    const s = this.ctx.org.need("session", a.sid);
    const title = str(a.title, "title");
    this.notOverPerson(by, s.titleBy);
    const rec = new Rec();
    if (s.title && s.title !== title) this.ctx.log.sess(s.id).formerTitles.push(s.title);
    this.set(rec, s, "title", title);
    this.set(rec, s, "titleBy", by);
    this.op(by, "thread.rename", a, rec, { sessionId: s.id });
  }

  thread$place(by: string, a: Args): void {
    const { org } = this.ctx;
    const p = this.thread(a.sid);
    const to: string | null = a.trackId ?? null;
    if (to) org.need("track", to);
    const from = p.trackId;
    const rec = new Rec();
    this.set(rec, p, "trackId", to);
    this.set(rec, p, "placedBy", by);
    this.set(rec, p, "position", this.ctx.now());
    if (from && from !== to) this.dissolveIfEmpty(rec, from, by);
    this.op(by, "thread.place", a, rec, { sessionId: p.id, trackId: to });
    org.occur("thread.placed", `${p.id}:placed:${org.version + 1}`, { sessionId: p.id, trackId: to ?? from, by });
  }

  thread$done(by: string, a: Args): void {
    const p = this.thread(a.sid);
    if (p.doneAt != null) return;
    const rec = new Rec();
    this.finish(rec, p, a.outcome ?? "done", by);
    this.op(by, "thread.done", a, rec, { sessionId: p.id });
    this.ctx.agents.poke(p.id, "done", by);
  }

  thread$reopen(by: string, a: Args): void {
    const p = this.thread(a.sid);
    const rec = new Rec();
    this.set(rec, p, "doneAt", null);
    this.set(rec, p, "outcome", null);
    this.set(rec, p, "doneBy", null);
    this.set(rec, p, "earlierAt", null);
    this.set(rec, p, "broughtBackAt", this.ctx.now());
    this.op(by, "thread.reopen", a, rec, { sessionId: p.id });
  }

  thread$keep(by: string, a: Args): void {
    const p = this.thread(a.sid);
    const rec = new Rec();
    this.set(rec, p, "keep", !!a.keep);
    const kept = { before: [...rec.before], after: [...rec.after] };
    if (a.keep) this.set(rec, p, "earlierAt", null);
    // The inverse is the old `keep` alone.
    rec.before = kept.before;
    rec.after = kept.after;
    this.op(by, "thread.keep", a, rec, { sessionId: p.id });
  }

  thread$ready(by: string, a: Args): void {
    const { org } = this.ctx;
    const p = this.thread(a.sid);
    const s = org.need("session", p.id);
    p.readySeq = s.lastSeq;
    p.readyWhat = str(a.what, "what");
    p.readyResult = a.resultId ?? null;
    org.touch(p);
    org.occur("thread.ready", `${p.id}:ready:${s.lastSeq}`, { sessionId: p.id, by });
    this.ctx.agents.poke(p.id, "ready", by);
  }

  thread$attention(by: string, a: Args): void {
    const { org } = this.ctx;
    const p = this.thread(a.sid);
    p.attention = a.what ?? null;
    org.touch(p);
    org.sync(p.id);
    if (p.attention) {
      org.occur("thread.attention", `${p.id}:attention:${org.version + 1}`, { sessionId: p.id, by });
      this.ctx.agents.poke(p.id, "blocked", by);
    }
  }

  thread$writers(by: string, a: Args): void {
    const s = this.ctx.org.need("session", a.sid);
    const sess = this.ctx.log.sess(s.id);
    const rec = new Rec();
    sess.writers = a.writers;
    this.op(by, "thread.writers", a, rec, { sessionId: s.id });
  }

  thread$delete(by: string, a: Args): void {
    const p = this.thread(a.sid);
    const rec = new Rec();
    const tid = p.trackId;
    this.removeThread(p.id, by);
    this.dissolveIfEmpty(rec, tid, by);
  }

  private removeThread(sid: string, by: string): void {
    const { org, log } = this.ctx;
    log.interrupt(sid, by);
    for (const r of org.all("result")) if (r.sessionId === sid) (org.remove("result", r.id), org.reviews.delete(r.id));
    for (const x of org.all("proposal")) if (x.target === sid) org.remove("proposal", x.id);
    for (const o of org.all("op")) if (o.sessionId === sid) org.remove("op", o.id);
    for (const r of org.all("read")) if (r.sessionId === sid) org.remove("read", r.id);
    org.remove("place", sid);
    org.remove("session", sid);
    log.destroy(sid);
  }

  // ---------- tracks

  /** Section 40.7. */
  track$create(by: string, a: Args): void {
    const { org, log, ctx } = { org: this.ctx.org, log: this.ctx.log, ctx: this.ctx };
    const tid = str(a.tid, "tid");
    const agentSid = str(a.agentSessionId, "agentSessionId");
    if (org.get("track", tid) || org.get("session", agentSid)) throw new Refusal("taken", "the id exists");
    const wrapped = a.sid ? this.thread(a.sid) : null;
    const owner = isPerson(by) ? by : (org.get("session", by.replace(/^agent:/, ""))?.owner.id ?? ctx.principal.subject);
    const now = ctx.now();
    org.put<TrackRow>({
      kind: "track",
      id: tid,
      version: 0,
      owner,
      name: a.name ?? null,
      nameBy: a.name ? by : null,
      formerNames: [],
      stand: null,
      standAt: null,
      agentSession: agentSid,
      position: now,
      keep: false,
      doneAt: null,
      outcome: null,
      createdBy: by,
    });
    org.put<DocRow>({ kind: "doc", id: tid, version: 0, trackId: tid, rev: 0, text: "", spans: [] });
    log.insert(agentSid, { role: "track", title: a.name ?? "Track", createdBy: by });
    const rec = new Rec();
    if (wrapped) {
      const from = wrapped.trackId;
      this.set(rec, wrapped, "trackId", tid);
      this.set(rec, wrapped, "placedBy", by);
      if (from) this.dissolveIfEmpty(rec, from, by);
    }
    this.op(by, "track.create", a, rec, { sessionId: wrapped?.id ?? null, trackId: tid }, { run: { name: "track.dissolve", args: { tid, threads: "keep" } } });
    // The agent's first input: the person's message as its first entry (J3, J5), else a platform turn (A7).
    const person = isPerson(by);
    if (a.firstInput) log.accept(agentSid, { id: ctx.id("tn", 12), kind: "turn", input: String(a.firstInput) }, owner, personActor(ctx.principal));
    else
      log.accept(
        agentSid,
        {
          id: ctx.id("tn", 12),
          kind: "turn",
          input: `This track was made by ${person ? "the person" : `the agent of the thread "${this.titleOf(by.replace(/^agent:/, ""))}"`}.${wrapped ? ` It wraps the thread "${this.titleOf(wrapped.id)}".` : ""} Do not start threads until the person asks.`,
        },
        "platform",
        PLATFORM,
      );
  }

  track$rename(by: string, a: Args): void {
    const t = this.ctx.org.need("track", a.tid);
    const name = str(a.name, "name");
    this.notOverPerson(by, t.nameBy);
    const rec = new Rec();
    if (t.name && t.name !== name) this.set(rec, t, "formerNames", [...t.formerNames, t.name]);
    this.set(rec, t, "name", name);
    this.set(rec, t, "nameBy", by);
    this.op(by, "track.rename", a, rec, { trackId: t.id });
  }

  track$set$stand(_by: string, a: Args): void {
    const t = this.ctx.org.need("track", a.tid);
    t.stand = String(a.stand ?? "");
    t.standAt = this.ctx.now();
    this.ctx.org.touch(t);
  }

  track$done(by: string, a: Args): void {
    const { org } = this.ctx;
    const t = org.need("track", a.tid);
    const rec = new Rec();
    for (const p of org.threadsOf(t.id)) this.finish(rec, p, a.outcome ?? "done", by);
    this.ctx.log.interrupt(t.agentSession, by);
    this.set(rec, t, "doneAt", this.ctx.now());
    this.set(rec, t, "outcome", a.outcome ?? "done");
    for (const x of org.all("proposal")) if (x.target === t.id && x.type === "done" && x.state === "open") this.set(rec, x, "state", "accepted");
    this.op(by, "track.done", a, rec, { trackId: t.id });
  }

  track$reopen(by: string, a: Args): void {
    const t = this.ctx.org.need("track", a.tid);
    const rec = new Rec();
    this.set(rec, t, "doneAt", null);
    this.set(rec, t, "outcome", null);
    this.op(by, "track.reopen", a, rec, { trackId: t.id });
  }

  track$keep(by: string, a: Args): void {
    const t = this.ctx.org.need("track", a.tid);
    const rec = new Rec();
    this.set(rec, t, "keep", !!a.keep);
    this.op(by, "track.keep", a, rec, { trackId: t.id });
  }

  track$dissolve(by: string, a: Args): void {
    const t = this.ctx.org.need("track", a.tid);
    const rec = new Rec();
    this.dissolveInto(rec, t, a.threads === "stop" ? "stop" : "keep", by);
    this.op(by, "track.dissolve", a, rec, { trackId: t.id });
  }

  track$delete(by: string, a: Args): void {
    const { org } = this.ctx;
    const t = org.need("track", a.tid);
    for (const p of org.threadsOf(t.id)) this.removeThread(p.id, by);
    this.dissolveInto(new Rec(), t, "keep", by);
    for (const o of org.all("op")) if (o.trackId === t.id) org.remove("op", o.id);
  }

  // ---------- the rest

  read$set(by: string, a: Args): void {
    const { org } = this.ctx;
    org.need("session", a.sid);
    const id = `${by}:${a.sid}`;
    const seq = Number(a.seq) || 0;
    const row = org.get("read", id);
    if (!row) org.put({ kind: "read", id, version: 0, member: by, sessionId: a.sid, readSeq: seq });
    else if (seq > row.readSeq) {
      row.readSeq = seq;
      org.touch(row);
    }
  }

  pref$set(by: string, a: Args): void {
    const key = str(a.key, "key");
    this.ctx.org.put({ kind: "pref", id: `${by}:${key}`, version: 0, member: by, key, value: a.value ?? null });
  }

  /** `spans` are 0-based line ranges, `from` inclusive and `to` exclusive. */
  doc$save(by: string, a: Args): void {
    const { org, ctx } = { org: this.ctx.org, ctx: this.ctx };
    const t = org.need("track", a.tid);
    const doc = org.need("doc", t.id);
    if (a.baseRev !== doc.rev) throw new Refusal("conflict", "the Doc moved", { rev: doc.rev, text: doc.text });
    const text = String(a.text ?? "");
    if (!isPerson(by)) {
      const lines = doc.text.split("\n");
      const touched = doc.spans.some((s) => isPerson(s.by) && s.to > s.from && !`\n${text}\n`.includes(`\n${lines.slice(s.from, s.to).join("\n")}\n`));
      if (touched) {
        this.proposal$create(by, { proposalId: ctx.id("prp"), kind: "edit", target: t.id, what: "A change to lines you wrote in the Doc", args: { tid: t.id, baseRev: doc.rev, text, spans: a.spans ?? [] } });
        throw new Refusal("refused", "proposed");
      }
    }
    doc.rev += 1;
    doc.text = text;
    doc.spans = Array.isArray(a.spans) ? a.spans : [];
    org.touch(doc);
    this.saveRev(t.id, doc, by);
  }

  saveRev(tid: string, doc: DocRow, by: string): void {
    const revs = this.ctx.org.docRevs.get(tid) ?? [];
    revs.push({ trackId: tid, rev: doc.rev, by, at: this.ctx.now(), text: doc.text });
    this.ctx.org.docRevs.set(tid, revs);
  }

  result$add(by: string, a: Args): string {
    const { org } = this.ctx;
    const s = org.need("session", a.sid);
    const type = str(a.kind, "kind") as ResultRow["type"];
    const ref = str(a.ref, "ref");
    const meta: Record<string, unknown> | null = a.meta ?? null;
    let row = org.all("result").find((r) => r.sessionId === s.id && r.type === type && r.ref === ref);
    if (row) {
      row.title = a.title ?? row.title;
      row.meta = meta ?? row.meta;
      org.touch(row);
    } else {
      const id = str(a.resultId, "resultId");
      if (org.get("result", id)) throw new Refusal("taken", "the id exists");
      const state = type === "pr" ? ((meta?.state as string | undefined) ?? "open") : type === "preview" ? "running" : null;
      row = org.put<ResultRow>({ kind: "result", id, version: 0, sessionId: s.id, type, ref, title: a.title ?? null, state, stateAt: state ? this.ctx.now() : null, meta });
    }
    org.occur("result.changed", `${row.id}:${row.state ?? "added"}`, { sessionId: s.id, by });
    this.ctx.agents.poke(s.id, "result", by);
    return row.id;
  }

  review$save(_by: string, a: Args): void {
    const r = this.ctx.org.need("result", a.resultId);
    const body = ReviewSummary.safeParse({ head: a.head, parts: a.parts });
    if (!body.success) throw new Refusal("invalid_request", body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    this.ctx.org.reviews.set(r.id, { resultId: r.id, ...body.data });
  }

  proposal$create(by: string, a: Args): void {
    const { org } = this.ctx;
    const id = str(a.proposalId, "proposalId");
    const target = str(a.target, "target");
    if (org.get("proposal", id)) throw new Refusal("taken", "the id exists");
    const anchor = org.get("session", target) ?? org.get("session", org.need("track", target).agentSession);
    for (const x of org.all("proposal"))
      if (x.target === target && x.type === a.kind && x.state === "open") {
        x.state = "void";
        org.touch(x);
      }
    org.put<ProposalRow>({ kind: "proposal", id, version: 0, type: a.kind, target, by, what: a.what ?? null, args: a.args ?? null, state: "open", atSeq: anchor?.lastSeq ?? null });
    org.occur("proposal.created", id, { sessionId: org.get("session", target) ? target : null, trackId: org.get("track", target) ? target : null, by });
  }

  proposal$accept(by: string, a: Args): void {
    const { org } = this.ctx;
    const x = org.need("proposal", a.proposalId);
    if (x.state !== "open") throw new Refusal("refused", x.state);
    const args = x.args ?? {};
    const settle = (state: ProposalRow["state"]) => {
      x.state = state;
      org.touch(x);
    };
    try {
      if (x.type === "done") org.get("track", x.target) ? this.track$done(by, { tid: x.target, outcome: "done", ...args }) : this.thread$done(by, { sid: x.target, outcome: "done", ...args });
      else if (x.type === "move") this.thread$place(by, { sid: x.target, trackId: null, ...args });
      else if (x.type === "wrap") this.track$create(by, { sid: x.target, ...args });
      else if (x.type === "edit") this.doc$save(by, { tid: x.target, ...args });
    } catch (e) {
      // A stale `edit` voids its proposal.
      if (e instanceof Refusal && e.code === "conflict") settle("void");
      throw e;
    }
    settle("accepted");
  }

  proposal$dismiss(_by: string, a: Args): void {
    const x = this.ctx.org.need("proposal", a.proposalId);
    if (x.state !== "open") return;
    x.state = "dismissed";
    this.ctx.org.touch(x);
  }

  /** Section 19.3. */
  undo(by: string, a: Args): void {
    const { org, log } = this.ctx;
    const op = org.need("op", a.opId);
    if (op.undoneBy) throw new Refusal("refused", "undone");
    const inv = (op.inverse ?? {}) as Inverse;
    const given = op.fields as Ref[];
    const row = (r: Ref) => org.get(r.kind, r.id) as unknown as Record<string, unknown> | undefined;
    const changed = given.filter((r) => JSON.stringify(row(r)?.[r.field] ?? null) !== JSON.stringify(r.value));
    if (changed.length && a.resolution !== "force") throw new Refusal("refused", "changed", { changed, would: inv.set ?? [] });
    let undoneBy: string;
    if (inv.run) {
      this.run(by, inv.run.name, inv.run.args);
      undoneBy = org.all("op").sort((x, y) => y.at - x.at || y.version - x.version)[0]?.id ?? "undone";
      const last = org.all("op").filter((o) => o.name === inv.run!.name && o.undoneBy == null);
      undoneBy = last[last.length - 1]?.id ?? undoneBy;
    } else {
      const rec = new Rec();
      for (const r of inv.restore ?? []) {
        if (org.get(r.kind, r.id)) continue;
        org.put(clone(r));
        if (r.kind === "session") log.revive(r.id);
      }
      for (const r of inv.set ?? []) {
        const target = org.get(r.kind, r.id);
        if (target) this.set(rec, target, r.field, r.value);
      }
      const track = (inv.restore ?? []).find((r) => r.kind === "track");
      undoneBy = this.op(by, "undo", a, rec, { sessionId: op.sessionId, trackId: op.trackId }, track ? { run: { name: "track.dissolve", args: { tid: track.id, threads: "keep" } } } : { set: rec.before });
    }
    op.undoneBy = undoneBy;
    org.touch(op);
  }

  // ---------- rules that are not mutations (the end of section 39)

  /** `rule:reply`: a person's message arrived. */
  replied(sid: string): void {
    const { org } = this.ctx;
    const p = org.place(sid);
    if (!p) {
      // A message to a done track's agent reopens the track (T12).
      const t = org.trackOfAgent(sid);
      if (t?.doneAt != null) this.track$reopen("rule:reply", { tid: t.id });
      return;
    }
    org.tx(() => {
      if (p.attention) {
        p.attention = null;
        org.touch(p);
        org.sync(sid);
      }
      if (p.doneAt != null) {
        this.thread$reopen("rule:reply", { sid });
        const t = p.trackId ? org.get("track", p.trackId) : undefined;
        if (t?.doneAt != null) this.track$reopen("rule:reply", { tid: t.id });
      }
      this.active(sid);
    });
  }

  /** `rule:activity`. */
  active(sid: string): void {
    const p = this.ctx.org.place(sid);
    if (p?.earlierAt != null && p.doneAt == null) {
      p.earlierAt = null;
      this.ctx.org.touch(p);
    }
  }

  /** `acceptPull` (section 40.9) and `rule:pr-merged`. */
  pull(resultId: string, state: string, checks?: string): void {
    const { org } = this.ctx;
    const r = org.need("result", resultId);
    org.tx(() => {
      r.state = state;
      r.stateAt = this.ctx.now();
      if (checks) r.meta = { ...(r.meta ?? {}), checks };
      org.touch(r);
      org.occur("result.changed", `${r.id}:${state}:${checks ?? ""}`, { sessionId: r.sessionId, by: "platform" });
      const prs = org.all("result").filter((x) => x.sessionId === r.sessionId && x.type === "pr");
      const s = org.get("session", r.sessionId);
      if (prs.every((x) => x.state === "merged") && s && s.status !== "running" && s.status !== "starting") this.thread$done("rule:pr-merged", { sid: r.sessionId, outcome: "done" });
      else this.ctx.agents.poke(r.sessionId, "result", "platform");
    });
  }
}

export { agentActor };
