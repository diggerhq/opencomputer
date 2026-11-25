// The agents: what a test does as a session's agent (`FakeAgent`), and the scripts that answer
// turns on their own when `autoAgent` is on.
//
// What a scripted thread agent does is chosen by words in the person's message, case-folded:
//   "fail"                  the turn fails (the thread is blocked)
//   "sudo", "permission"    an approval ask for a command; the answer continues the turn
//   "ask"                   a question ask with three options; the answer continues the turn
//   "pr", "pull request"    a pull request and a changes result, a review, `thread.ready`, a `done` proposal
//   "long"                  a long answer with a code block
//   "track"                 (not the first message of a loose thread) a `wrap` proposal: make this a track
//   anything else           one tool call and a short reply
// A `start` session (the Start box): a message with " and ", "track", or over 120 characters becomes
// a track (section 23's `start_track`), and the start thread goes; anything else is a plain thread.
// A track's agent: its first message names the track, writes the Doc and starts two threads;
//   "start", "thread"       starts one thread with the message as its input
//   "tell"                  passes the message to every open thread of the track
//   anything else           is noted in the Doc.

import type { Ask, ReviewPart, TrackRow } from "../types.js";
import type { FakeAgent } from "./api.js";
import { agentActor, isPerson, Refusal, type Ctx } from "./ctx.js";
import type { Turn } from "./log.js";

const has = (text: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(text));

export function titleFrom(input: string): string {
  const line = input.trim().split(/[\n.?!]/)[0].replace(/\s+/g, " ").trim();
  const short = line.length > 48 ? `${line.slice(0, 48).replace(/\s+\S*$/, "")}…` : line;
  return short.charAt(0).toUpperCase() + short.slice(1) || "New thread";
}

const LONG = `Here is the whole of it.

The request path has three stages, and the slow one is the second:

\`\`\`ts
export async function handle(req: Request): Promise<Response> {
  const session = await authenticate(req)
  const rows = await loadRows(session.org) // 180 ms: one query per row
  return render(rows)
}
\`\`\`

- \`authenticate\` reads one cookie and one row: 4 ms.
- \`loadRows\` asks for each row on its own. With 60 rows that is 60 round trips.
- \`render\` is under a millisecond.

Loading the rows in one query takes the request from about 190 ms to 12 ms. I have not changed anything yet; say the word and I will.`;

export class Agents {
  api: FakeAgent;
  private prNumber = 500;

  constructor(private ctx: Ctx) {
    const { log, mutations } = { log: () => this.ctx.log, mutations: () => this.ctx.mutations };
    this.api = {
      say: (sid, text, o) => log().say(sid, text, o),
      tool: (sid, title, o) => log().tool(sid, title, o),
      ask: (sid, ask) => log().ask(sid, ask),
      endTurn: (sid, o) => log().endTurn(sid, o),
      mutate: (sid, name, args) => void mutations().run(`agent:${sid}`, name, args as Record<string, unknown>),
      startThread: (agentSid, title, input) => this.startThread(agentSid, title, input),
      pull: (resultId, state, checks) => mutations().pull(resultId, state, checks),
    };
  }

  private startThread(agentSid: string, title: string, input: string): string {
    const { org, log } = this.ctx;
    const track = org.trackOfAgent(agentSid);
    if (!track) throw new Refusal("not_found", "the session is not a track's agent");
    const sid = this.ctx.id("cs");
    const by = `agent:${agentSid}`;
    org.tx(() => {
      const row = log.insert(sid, { title, createdBy: by, trackId: track.id, parent: agentSid });
      row.agentTitle = title;
      log.accept(sid, { id: this.ctx.id("tn", 12), kind: "turn", input }, by, agentActor(agentSid));
      org.occur("thread.placed", `${sid}:placed:${org.version + 1}`, { sessionId: sid, trackId: track.id, by });
    });
    return sid;
  }

  // ---------- the scripts

  /** A turn began. */
  respond(sid: string, turn: Turn, n: number): void {
    const role = this.ctx.org.get("session", sid)?.role;
    const script = role === "track" ? this.track(sid, turn) : role === "start" ? this.start(sid, turn, n) : this.thread(sid, turn, n);
    this.ctx.job(script.catch((e) => this.ctx.log.endTurn(sid, { failed: e instanceof Error ? e.message : String(e) })));
  }

  /** One step of a script: waits `pace`, and says whether the turn is still the one in progress. */
  private async step(sid: string, turn: Turn): Promise<boolean> {
    await this.ctx.sleep(this.ctx.pace);
    return this.ctx.log.turn(sid) === turn;
  }

  private async thread(sid: string, turn: Turn, n: number): Promise<void> {
    const { org, log } = this.ctx;
    const a = this.api;
    const text = turn.input;
    if (!(await this.step(sid, turn))) return;
    const row = org.need("session", sid);
    if (n === 1 && !row.agentTitle) {
      row.agentTitle = titleFrom(text);
      if (!isPerson(row.titleBy)) row.title = row.agentTitle;
      org.touch(row);
    }
    if (has(text, "fail", "fails", "failing")) {
      a.tool(sid, "Ran `npm test`", { fail: true });
      if (!(await this.step(sid, turn))) return;
      return a.endTurn(sid, { failed: "The test run crashed before any test ran: exit 1" });
    }
    if (has(text, "sudo", "permission")) {
      a.tool(sid, "Checked what the machine has installed");
      await a.say(sid, "One step needs root on the test machine, so I'm asking first.");
      if (log.turn(sid) === turn) a.ask(sid, { kind: "approval", title: "Restart the service on the test machine", command: "sudo systemctl restart api" });
      return;
    }
    if (has(text, "ask")) {
      await a.say(sid, "Before I go on, one decision that is yours.");
      if (log.turn(sid) === turn) a.ask(sid, { kind: "question", question: "Which way should I take?", options: ["The smallest change", "Refactor first", "Show me both"] });
      return;
    }
    if (has(text, "pr", "pull request")) {
      a.tool(sid, "Read 12 files in `src`");
      if (!(await this.step(sid, turn))) return;
      a.tool(sid, "Edited 3 files · ran `npm test` · 212 passed");
      if (!(await this.step(sid, turn))) return;
      const number = ++this.prNumber;
      const title = org.need("session", sid).title;
      const resultId = this.ctx.id("res");
      const head = `h${number}a91c7`;
      const files = ["src/handler.ts", "src/rows.ts", "src/rows.test.ts"];
      a.mutate(sid, "result.add", { resultId, sid, kind: "pr", ref: `https://github.com/acme/console/pull/${number}`, title: `PR #${number}`, meta: { number, repo: "acme/console", title, state: "open", checks: "passed", head, add: 41, del: 9, files: 3 } });
      a.mutate(sid, "result.add", { resultId: this.ctx.id("res"), sid, kind: "changes", ref: `changes:${sid}`, title: "3 files changed", meta: { add: 41, del: 9, files: 3 } });
      const parts: ReviewPart[] = [
        { title: "Rows load in one query", note: "- `loadRows` asks once for every row of the organization.\n- **Worth your eye.** The order of the rows now comes from the query, not from the loop.", files: files.slice(0, 2), weight: "eye" },
        { title: "The test covers both orders", note: "- One test for an empty organization, one for sixty rows.", files: files.slice(2), weight: "rote" },
      ];
      a.mutate(sid, "review.save", { resultId, head, parts });
      org.diffs.set(
        resultId,
        files.map((f, i) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -${10 + i},3 +${10 + i},4 @@\n const org = session.org\n-const rows = await each(ids, loadRow)\n+const rows = await loadRows(org)\n+rows.sort(byPosition)\n return rows\n`).join(""),
      );
      await a.say(sid, `Done, and up as PR #${number}: the rows load in one query and the tests pass. One thing in it is worth your eye; the review has it first.`);
      if (log.turn(sid) !== turn) return;
      a.mutate(sid, "thread.ready", { sid, what: `PR #${number} is open and its checks passed`, resultId });
      a.mutate(sid, "proposal.create", { proposalId: this.ctx.id("prp"), kind: "done", target: sid, what: `I think this is done. PR #${number} is open and its checks passed.` });
      return a.endTurn(sid);
    }
    const place = org.place(sid);
    if (has(text, "track") && n > 1 && place && !place.trackId) {
      a.mutate(sid, "proposal.create", {
        proposalId: this.ctx.id("prp"),
        kind: "wrap",
        target: sid,
        what: "This has grown into several pieces of work. Make it a track?",
        args: { tid: this.ctx.id("trk"), agentSessionId: this.ctx.id("cs"), name: org.need("session", sid).title },
      });
      await a.say(sid, "This is more than one thread's worth. I've proposed making it a track; nothing changes until you accept.");
      return a.endTurn(sid);
    }
    if (has(text, "long")) {
      a.tool(sid, "Read 31 files in `src`");
      await a.say(sid, LONG);
      return a.endTurn(sid);
    }
    a.tool(sid, "Looked at the workspace");
    if (!(await this.step(sid, turn))) return;
    await a.say(sid, `On it: ${text.replace(/\s+/g, " ").slice(0, 140)}\n\nDone. Nothing else needs you here.`);
    a.endTurn(sid);
  }

  private async start(sid: string, turn: Turn, n: number): Promise<void> {
    const { org, mutations } = this.ctx;
    const text = turn.input;
    const row = org.need("session", sid);
    if (n === 1 && (has(text, "and", "track") || text.length > 120)) {
      if (!(await this.step(sid, turn))) return;
      const by = `agent:${sid}`;
      org.tx(() => {
        mutations.run(by, "track.create", { tid: this.ctx.id("trk"), agentSessionId: this.ctx.id("cs"), firstInput: text });
        mutations.run(by, "thread.delete", { sid });
      });
      return;
    }
    // A plain thread from here on.
    row.role = null;
    org.touch(row);
    return this.thread(sid, turn, n);
  }

  private async track(sid: string, turn: Turn): Promise<void> {
    const { org, log } = this.ctx;
    const a = this.api;
    const text = turn.input;
    if (!(await this.step(sid, turn))) return;
    const track = org.trackOfAgent(sid);
    if (!track) return a.endTurn(sid);
    const doc = org.need("doc", track.id);
    const threads = () => org.threadsOf(track.id);
    if (!isPerson(turn.by)) {
      await a.say(sid, turn.by === "platform" ? "Ready. Tell me what this track is for and I'll plan it with you." : "Noted.");
      this.restand(track);
      return a.endTurn(sid);
    }
    if (!doc.text) {
      const name = track.name ?? titleFrom(text);
      if (!track.name) a.mutate(sid, "track.rename", { tid: track.id, name });
      a.mutate(sid, "doc.save", { tid: track.id, baseRev: doc.rev, text: `## Goal\n\n${text.trim()}\n\n## Plan\n\n- Scope the work\n- Build it\n\n## Decided\n\nNothing yet.`, spans: [] });
      if (threads().length) await a.say(sid, "Taking that as the goal; it is in the Doc. The thread you had is the first one here.");
      else {
        await a.say(sid, "Taking that as the goal. I've written it to the Doc and started two threads.");
        if (log.turn(sid) !== turn) return;
        const one = `Scope: ${name}`.slice(0, 60);
        const two = `Build: ${name}`.slice(0, 60);
        a.startThread(sid, one, `Scope this and report what it takes: ${text}`);
        a.startThread(sid, two, `Build the first piece of: ${text}`);
        log.note(sid, "track.note", { text: `Started **${one}** and **${two}**` });
      }
    } else if (has(text, "start", "thread")) {
      const title = titleFrom(text.replace(/^\s*(please\s+)?start( a)?( new)?( thread)?( (for|to|on))?\s*/i, ""));
      a.startThread(sid, title, text);
      log.note(sid, "track.note", { text: `Started **${title}**` });
      await a.say(sid, `Started a thread for it: ${title}.`);
    } else if (has(text, "tell")) {
      const open = threads().filter((p) => p.doneAt == null);
      for (const p of open) log.accept(p.id, { id: this.ctx.id("tn", 12), kind: "turn", input: `From the track: ${text}`, ifBusy: "queue" }, `agent:${sid}`, agentActor(sid));
      await a.say(sid, `Passed it on to ${open.length} thread${open.length === 1 ? "" : "s"}.`);
    } else {
      const now = org.need("doc", track.id);
      a.mutate(sid, "doc.save", { tid: track.id, baseRev: now.rev, text: `${now.text}\n\n## Note\n\n${text.trim()}`, spans: now.spans });
      log.note(sid, "track.note", { text: "Doc updated: a note from you" });
      await a.say(sid, "Noted, and written to the Doc.");
    }
    if (log.turn(sid) !== turn) return;
    this.restand(track);
    a.endTurn(sid);
  }

  /** An ask was answered or dismissed: the turn goes on and ends. */
  afterAnswer(sid: string, turn: Turn, ask: Ask): void {
    const a = this.api;
    const run = async () => {
      if (!(await this.step(sid, turn))) return;
      const answer = ask.answer as { decision?: string; answers?: { choices: string[]; text: string | null }[] } | null;
      if (ask.status === "dismissed") await a.say(sid, "Left undecided. I went on with what I could do without it.");
      else if (ask.kind === "approval") {
        if (answer?.decision === "deny") await a.say(sid, "Understood, I did not run it. Tell me another way if there is one.");
        else {
          a.tool(sid, `Ran \`${String(ask.approval?.command ?? ask.approval?.title ?? "the command")}\``);
          await a.say(sid, "It ran cleanly. The rest went through after it.");
        }
      } else {
        const first = answer?.answers?.[0];
        await a.say(sid, `Going with "${first?.choices[0] ?? first?.text ?? "your answer"}". Done.`);
      }
      if (this.ctx.log.turn(sid) === turn && !this.ctx.org.get("session", sid)?.asks.length) a.endTurn(sid);
    };
    this.ctx.job(run().catch(() => undefined));
  }

  // ---------- a track's agent follows its threads

  private restand(track: TrackRow): void {
    const { org } = this.ctx;
    const count = { blocked: 0, ready: 0, working: 0, done: 0, quiet: 0 };
    for (const p of org.threadsOf(track.id)) {
      const m = org.markOf(p.id);
      count[m === "blocked" || m === "ready" || m === "working" || m === "done" ? m : "quiet"] += 1;
    }
    const parts = [count.blocked && `${count.blocked} blocked on you`, count.ready && `${count.ready} ready for you`, count.working && `${count.working} working`, count.done && `${count.done} done`].filter(Boolean);
    const stand = parts.join(" · ") || "Nothing in progress";
    if (stand !== track.stand) this.ctx.mutations.run(`agent:${track.agentSession}`, "track.set_stand", { tid: track.id, stand });
  }

  /** Something happened to a thread: its track's agent updates the stand and notes it in the Activity. */
  poke(sid: string, what: "done" | "ready" | "blocked" | "turn" | "result", by: string): void {
    if (!this.ctx.auto) return;
    this.ctx.later(() => {
      const { org, log } = this.ctx;
      const place = org.place(sid);
      const track = place?.trackId ? org.get("track", place.trackId) : undefined;
      if (!place || !track || !org.get("session", track.agentSession)) return;
      const agent = `agent:${track.agentSession}`;
      if (by === agent) return;
      org.tx(() => {
        this.restand(track);
        const title = org.get("session", sid)?.title ?? "A thread";
        const verb = { done: "done", ready: `is ready for you${place.readyWhat ? ` · ${place.readyWhat}` : ""}`, blocked: "is blocked on you", result: null, turn: null }[what];
        if (verb) log.note(track.agentSession, "track.note", { text: `**${title}** ${verb}`, sessionId: sid });
        const threads = org.threadsOf(track.id);
        const proposed = org.all("proposal").some((x) => x.target === track.id && x.type === "done" && x.state !== "void" && x.state !== "accepted");
        if (what === "done" && threads.every((p) => p.doneAt != null) && !track.keep && track.doneAt == null && !proposed)
          this.ctx.mutations.run(agent, "proposal.create", { proposalId: this.ctx.id("prp"), kind: "done", target: track.id, what: "Every thread here is done. Mark the track done?" });
      });
    }, 0);
  }
}
