// The seeds: `demo` is the prototype's organization (seed-data.ts), `empty` a new one (S8).
// The prototype's "now" (Wed 25 Nov, 17:00) is the server's now; every time is counted back from it.

import type { MachineRow, PlaceRow, ProposalRow, ReadRow, ResultRow, SessionRow, TrackRow } from "../types.js";
import type { Review, ReviewPart } from "../review.js";
import { agentActor, personActor, type Ctx } from "./ctx.js";
import { DEMO, type DemoMsg, type DemoReview, type DemoThread, type DemoTrack } from "./seed-data.js";

const MIN = 60_000;
const TODAY = 25;
const NOW = 17 * 60;

/** When each open thread last did something, today (the deploy thread: on the 23rd). */
const LAST: Record<string, string> = { dock: "11:48", sketch: "16:31", vm: "10:20", docs: "16:48", sbx: "16:40", pin: "16:52", invoice: "14:12", cache: "16:55", hn: "13:10", chart: "15:20", deploy: "11:30" };

const SBX: DemoMsg[] = [
  { day: "Today" },
  { who: "a", text: "Started by the track: fold the five stacked PRs, #1039 to #1045, into one that can be read in order." },
  { tool: "Rebased 5 branches onto `main` · 116 files" },
  { tool: "Ran `sandbox-check` on a real VM · 169 of 169 passed" },
];

const EARLIER = [
  "Rename the staging buckets",
  "Why did the nightly fail on Tuesday?",
  "Bump Node to 22 in CI",
  "Flaky test in `checkpoint_test.go`",
  "Draft the October changelog",
  "Which regions have spare capacity?",
  "Remove the old seats banner",
  "Rotate the preview signing key",
  "Explain the hibernation wake path",
  "Trim the Docker image by 200 MB",
  "Answer the support ticket about quotas",
  "Dead links in the README",
  "Compare two ways to pin the kernel",
  "Typo on the pricing page",
];

export function seedEmpty(ctx: Ctx): void {
  ctx.org.put<MachineRow>({ kind: "machine", id: "m_1", version: 0, state: "running", revision: 1 });
}

export function seedDemo(ctx: Ctx): void {
  const auto = ctx.auto;
  ctx.auto = false;
  ctx.org.tx(() => new Seeder(ctx).run());
  ctx.auto = auto;
}

class Seeder {
  private me: string;
  private position: number;

  constructor(private ctx: Ctx) {
    this.me = ctx.principal.subject;
    this.position = ctx.now();
  }

  /** A day of November and a minute of that day, as the server's time. */
  private at(day: number, minute: number): number {
    return this.ctx.now() + ((day - TODAY) * 1440 + minute - NOW) * MIN;
  }

  private nextPosition(): number {
    return (this.position -= 1000);
  }

  run(): void {
    seedEmpty(this.ctx);
    for (const k of DEMO.tracks) this.track(k);
    for (const t of DEMO.threads) this.thread(t, null, null);
    EARLIER.slice(0, DEMO.earlier).forEach((title, i) => {
      const day = TODAY - 2 - i * 2;
      this.earlier(title, null, null, this.at(day, 11 * 60 + i * 7), i % 4 === 3 ? null : this.me, `Done. ${title} is finished; nothing was left open.`, null);
    });
  }

  // ---------- events

  private read(sid: string, seq: number): void {
    this.ctx.org.put<ReadRow>({ kind: "read", id: `${this.me}:${sid}`, version: 0, member: this.me, sessionId: sid, readSeq: seq });
  }

  /** Writes a conversation to a session's log. Answers the turn left open, if the last one was not ended. */
  private write(sid: string, items: { m: DemoMsg; at: number }[], opener: () => { input: string; by: string }, end: boolean): string | null {
    const { log } = this.ctx;
    const s = log.sess(sid);
    const row = log.row(sid);
    let turn: string | null = null;
    let last = items.length ? items[0].at : this.ctx.now();
    const close = (at: number) => {
      if (!turn) return;
      log.append(sid, "turn.completed", {}, { turnId: turn, at });
      row.lastTurn = { id: turn, status: "completed", endedAt: this.ctx.iso(at), text: row.lastText, error: null, reason: null, forced: null };
      turn = null;
    };
    const open = (input: string, by: string, at: number) => {
      close(at);
      turn = this.ctx.id("tn", 12);
      s.seen.add(turn);
      s.turnCount += 1;
      log.append(sid, "message.received", { input }, { turnId: turn, at, actor: by === this.me ? personActor(this.ctx.principal) : agentActor(by.replace(/^agent:/, "")) });
    };
    for (const { m, at } of items) {
      last = at;
      if (m.who === "u") {
        open(m.text ?? "", this.me, at);
        continue;
      }
      if (!turn) {
        const o = opener();
        open(o.input, o.by, at - MIN);
      }
      if (m.who === "a" || m.img) {
        const text = m.img ? `_${m.cap ?? ""}_` : (m.text ?? "");
        row.lastText = text;
        log.append(sid, "message.completed", { text, blockId: `b${++s.blockN}` }, { turnId: turn, at });
      } else if (m.tool) {
        const data = { callId: this.ctx.id("call", 8), title: m.tool, toolName: "Bash" };
        log.append(sid, "tool.started", data, { turnId: turn, at });
        log.append(sid, "tool.completed", data, { turnId: turn, at });
      } else if (m.ev) log.append(sid, "track.note", { text: m.ev }, { turnId: turn, at });
    }
    if (end) close(last + MIN);
    return turn;
  }

  /** Gives every message a time: `at` where the prototype has one, else counted from its neighbours. */
  private timed(msgs: DemoMsg[], lastToday: number | null): { m: DemoMsg; at: number }[] {
    const days: { day: number; items: DemoMsg[] }[] = [];
    for (const m of msgs) {
      if (m.day) days.push({ day: m.day === "Today" ? TODAY : Number(/\d+/.exec(m.day)?.[0] ?? TODAY), items: [] });
      else (days[days.length - 1] ?? days[days.push({ day: TODAY, items: [] }) - 1]).items.push(m);
    }
    const out: { m: DemoMsg; at: number }[] = [];
    days.forEach((d, di) => {
      const minute = (m: DemoMsg) => (m.at ? Number(m.at.slice(0, 2)) * 60 + Number(m.at.slice(3)) : null);
      const n = d.items.length;
      const times: number[] = new Array<number>(n).fill(0);
      // The last day of a thread ends when the thread last did something.
      const endOfDay = di === days.length - 1 && lastToday != null ? lastToday : null;
      for (let i = n - 1; i >= 0; i--) {
        const own = minute(d.items[i]);
        times[i] = own ?? (i === n - 1 ? (endOfDay ?? -1) : times[i + 1] === -1 ? -1 : times[i + 1] - 3);
      }
      for (let i = 0; i < n; i++) if (times[i] === -1) times[i] = i === 0 ? 10 * 60 : times[i - 1] + 3;
      d.items.forEach((m, i) => out.push({ m, at: this.at(d.day, times[i]) }));
    });
    return out;
  }

  // ---------- threads

  private thread(t: DemoThread, track: TrackRow | null, k: DemoTrack | null): void {
    const { org, log } = this.ctx;
    const sid = this.ctx.id("cs");
    const [hh, mm] = (LAST[t.id] ?? "12:00").split(":").map(Number);
    let msgs = t.msgs;
    if (t.id === "sbx") msgs = [...SBX, { who: "a", text: `${DEMO.reviews.sbx.over}\n\n${t.line ?? ""}` }];
    if (!msgs.some((m) => m.day)) msgs = [{ day: "Today" }, ...msgs];
    const items = this.timed(msgs, hh * 60 + mm);
    const by = track ? `agent:${track.agentSession}` : this.me;
    const row = log.insert(sid, { title: t.name, createdBy: by, trackId: track?.id ?? null, parent: track?.agentSession ?? null, at: items[0]?.at });
    row.agentTitle = t.name;
    const place = org.need("place", sid);
    place.position = this.nextPosition();
    const live = t.state === "working" || t.state === "blocked";
    const turn = this.write(sid, items, () => ({ input: `Started by the track "${k?.name ?? ""}": ${t.name}`, by }), !live);
    const s = log.sess(sid);
    if (turn) {
      s.turn = { id: turn, input: "", by: this.me, actor: personActor(this.ctx.principal), blocks: new Map() };
      row.status = "running";
      row.activeTurnId = turn;
    }
    const lastAt = Date.parse(row.lastActiveAt);
    if (t.block?.type === "perm") log.ask(sid, { kind: "approval", title: t.block.q ?? "", command: t.block.cmd }, lastAt);
    if (t.block?.type === "q") log.ask(sid, { kind: "question", question: t.block.q ?? "", options: t.block.opts ?? [] }, lastAt);
    if (t.line) row.lastText = t.line;
    for (const r of t.results) this.result(sid, t, r, lastAt);
    let read = row.lastSeq;
    if (t.unread) read = Math.max(0, s.events.filter((e) => e.type === "message.completed").slice(-1)[0].seq - 1);
    if (t.state === "ready") {
      const pr = org.all("result").find((r) => r.sessionId === sid && r.type === "pr");
      if (!t.seen) {
        // Ready and not yet looked at, but nothing unread: the mark is past the last thing the agent wrote.
        read = row.lastAgentSeq;
        log.append(sid, "session.status_changed", { status: "idle" }, { turnId: null, at: lastAt });
      }
      place.readySeq = row.lastSeq;
      place.readyWhat = pr ? `${pr.title} is open and its checks passed` : t.line;
      place.readyResult = pr?.id ?? null;
      if (t.seen) read = row.lastSeq;
    }
    if (t.block?.type === "done") org.put<ProposalRow>({ kind: "proposal", id: this.ctx.id("prp"), version: 0, type: "done", target: sid, by: `agent:${sid}`, what: t.block.text ?? null, args: null, state: "open", atSeq: row.lastSeq });
    this.read(sid, read);
    org.sync(sid);
  }

  private result(sid: string, t: DemoThread, r: DemoThread["results"][number], at: number): void {
    const { org } = this.ctx;
    const id = this.ctx.id("res");
    const base = { kind: "result" as const, id, version: 0, sessionId: sid, title: r.title, stateAt: at };
    if (r.icon === "pr") {
      const number = Number(/\d+/.exec(r.title)?.[0] ?? 0);
      const repo = /opencomputer-deploy|docs|console/.exec(`${r.detail} ${r.meta}`)?.[0] ?? "opencomputer";
      const key = r.rv ?? t.id;
      const review = DEMO.reviews[key];
      const files = review?.parts.flatMap((p) => p.files) ?? [];
      const sum = (f: (x: { add: number; del: number }) => number) => files.reduce((a, x) => a + f(x), 0);
      org.put<ResultRow>({
        ...base,
        type: "pr",
        ref: `https://github.com/opencomputer/${repo}/pull/${number}`,
        state: r.detail?.startsWith("draft") ? "draft" : "open",
        meta: { number, repo: `opencomputer/${repo}`, title: t.name, checks: /running/.test(review?.checks ?? "") ? "pending" : "passed", detail: r.detail ?? null, note: r.meta ?? null, head: `${key}0a1b2c3d`, over: review?.over ?? null, look: review?.look ?? 0, add: sum((x) => x.add), del: sum((x) => x.del), files: files.length },
      });
      if (review) this.review(id, key, review);
    } else if (r.icon === "files") {
      const [add, del] = (r.detail ?? "").replace(/,/g, "").match(/\d+/g)?.map(Number) ?? [0, 0];
      org.put<ResultRow>({ ...base, type: "changes", ref: `changes:${sid}`, state: null, stateAt: null, meta: { add, del, files: Number(/\d+/.exec(r.title)?.[0] ?? 0) } });
    } else if (r.icon === "globe") org.put<ResultRow>({ ...base, type: "preview", ref: `https://${r.detail}.opencomputer.app`, state: "running", meta: { name: r.detail ?? null, note: r.note ?? null } });
    else org.put<ResultRow>({ ...base, type: "document", ref: r.title, state: null, stateAt: null, meta: { detail: r.detail ?? null, note: r.meta ?? null } });
  }

  private review(resultId: string, key: string, r: DemoReview): void {
    const review: Review = { resultId, head: `${key}0a1b2c3d`, parts: r.parts.map(demoPart) };
    this.ctx.org.reviews.set(resultId, review);
    let diff = "";
    for (const f of r.parts.flatMap((p) => p.files)) {
      if (!f.lines.length) continue;
      const olds = f.lines.filter((l) => l[1] !== "+").length;
      const news = f.lines.filter((l) => l[1] !== "-").length;
      const first = f.lines[0][0];
      diff += `diff --git a/${f.path} b/${f.path}\n${olds ? `--- a/${f.path}` : "new file mode 100644\n--- /dev/null"}\n+++ b/${f.path}\n@@ -${olds ? first : 0},${olds} +${first},${news} @@\n`;
      diff += f.lines.map((l) => `${l[1]}${l[2]}\n`).join("");
    }
    this.ctx.org.diffs.set(resultId, diff);
  }

  /** A thread in Earlier: one short turn, done (or, with `doneBy` null, only aged). */
  private earlier(title: string, track: TrackRow | null, k: DemoTrack | null, at: number, doneBy: string | null, text: string, result: { icon: string; title: string } | null): void {
    const { org, log } = this.ctx;
    const sid = this.ctx.id("cs");
    const by = track ? `agent:${track.agentSession}` : this.me;
    const row = log.insert(sid, { title, createdBy: by, trackId: track?.id ?? null, parent: track?.agentSession ?? null, at: at - 60 * MIN });
    row.agentTitle = title;
    const first: DemoMsg = track ? { who: "a", text } : { who: "u", text: title.charAt(0).toLowerCase() + title.slice(1) };
    this.write(
      sid,
      [{ m: first, at: at - 30 * MIN }, ...(track ? [] : [{ m: { who: "a", text } as DemoMsg, at: at - MIN }])],
      () => ({ input: `Started by the track "${k?.name ?? ""}": ${title}`, by }),
      true,
    );
    const place: PlaceRow = org.need("place", sid);
    place.position = at;
    place.earlierAt = at;
    if (doneBy) {
      place.doneAt = at;
      place.outcome = "done";
      place.doneBy = doneBy;
    }
    if (result) {
      const number = Number(/\d+/.exec(result.title)?.[0] ?? 0);
      const base = { kind: "result" as const, id: this.ctx.id("res"), version: 0, sessionId: sid, title: result.title, stateAt: at };
      if (result.icon === "pr") org.put<ResultRow>({ ...base, type: "pr", ref: `https://github.com/opencomputer/opencomputer/pull/${number}`, state: "merged", meta: { number, repo: "opencomputer/opencomputer", title, checks: "passed" } });
      else org.put<ResultRow>({ ...base, type: "document", ref: result.title, state: null, stateAt: null, meta: null });
    }
    this.read(sid, row.lastSeq);
    org.sync(sid);
  }

  // ---------- tracks

  private track(k: DemoTrack): void {
    const { org, log } = this.ctx;
    const tid = this.ctx.id("trk");
    const agentSid = this.ctx.id("cs");
    const items = this.timed(k.msgs, null);
    const agent: SessionRow = log.insert(agentSid, { role: "track", title: k.name, createdBy: this.me, at: items[0]?.at });
    agent.agentTitle = k.name;
    const lastAt = items.length ? items[items.length - 1].at : this.ctx.now();
    const track = org.put<TrackRow>({
      kind: "track",
      id: tid,
      version: 0,
      owner: this.me,
      name: k.name,
      nameBy: `agent:${agentSid}`,
      formerNames: [],
      stand: k.stand,
      standAt: lastAt,
      agentSession: agentSid,
      position: this.nextPosition(),
      keep: false,
      doneAt: null,
      outcome: null,
      createdBy: this.me,
    });
    const doc = org.put({ kind: "doc" as const, id: tid, version: 0, trackId: tid, rev: 1, text: k.doc, spans: [] });
    org.docRevs.set(tid, [{ trackId: tid, rev: 1, by: `agent:${agentSid}`, at: lastAt, text: doc.text }]);
    this.write(agentSid, items, () => ({ input: k.name, by: this.me }), true);
    this.read(agentSid, agent.lastSeq);
    for (const t of k.threads) this.thread(t, track, k);
    for (const p of k.past) {
      const title = p.detail.split(" · ")[0];
      const done = items.find((i) => i.m.ev?.startsWith(`**${title.replace(/usage_daily/, "`usage_daily`")}** done`));
      const at = done?.at ?? this.at(TODAY - 6, 15 * 60);
      this.earlier(title, track, k, at, p.icon === "pr" ? "rule:pr-merged" : this.me, `Done: ${p.title}. ${p.detail}.`, p);
    }
  }
}

const EYE = /^\*\*Worth your eye\.\*\*\s*/;

/** A demo part as an agent would write it: the note's first point is the claim, its "Worth your eye" points the eye items, and the opening lines of its first files the excerpts. */
function demoPart(p: DemoReview["parts"][number]): ReviewPart {
  const said = (p.note ?? "").split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean);
  const plain = said.filter((l) => !EYE.test(l));
  const eye = said.filter((l) => EYE.test(l)).map((l) => ({ text: l.replace(EYE, "") }));
  const excerpts = p.files
    .filter((f) => f.lines.some((l) => l[1] !== "-"))
    .slice(0, 2)
    .map((f) => {
      const news = f.lines.filter((l) => l[1] !== "-").length;
      return { path: f.path, start: f.lines[0][0], end: f.lines[0][0] + Math.min(news, 12) - 1 };
    });
  return {
    title: p.title,
    claim: plain[0] ?? p.title,
    ...(plain.length > 1 ? { points: plain.slice(1) } : {}),
    files: p.files.map((f) => ({ path: f.path })),
    ...(excerpts.length ? { excerpts } : {}),
    ...(eye.length ? { eye } : {}),
  };
}
