// The write queue (sections 19, 37.2, 37.3, 42.1): one ordered list in storage, `queue/<counter>`,
// holding mutations and session writes. What is in the list is what `pending()` shows.
//
// Sending. One sender (under `lock('oc-queue')`) drains the list in lanes: the mutations in order of
// `n`, each after the previous is answered; each session's writes (create, turns, answers, dismiss,
// interrupt) in order the same way; the lanes in parallel. An entry that names a row an earlier
// entry would create (a session by `createSession`; a track and its agent's session by
// `track.create`; a result; a proposal) waits until that entry is answered 2xx.
//
// Replies. 2xx: answered. 409 `out_of_order`: every mutation above the reply's `lastMutation` is
// sent again, in order (they are idempotent on `n`); if the one the server wants is no longer held,
// the entry fails. 429, 5xx and a network error: again after 1 s doubling to 60 s, or at once when
// the socket comes online. Any other 4xx: the entry fails.
//
// Failing. The entry leaves the list, `settled` rejects with `Refused`, and `failures` emits. The
// session writes that name a row it would have made fail with it, without being sent. A mutation
// that names such a row is still sent, so that `n` has no gap, and the server refuses it
// (`not_found`), which fails it the same way.
//
// Leaving `pending`:
// - a mutation, when a feed frame with `lastMutation >= n` is applied, in the step that emits the
//   frame; a frame's `errors` entry for `n` fails it there too, whatever became of the HTTP reply.
//   `settled` resolves then. If nobody reads the feed, the 2xx reply confirms it. If no frame has
//   confirmed it 2 s after the reply, the feed is read over HTTP.
// - `session`: when a feed frame carries the session's row (or names it in `gone`), or the row is
//   already held when the reply arrives; on the 2xx reply if nobody reads the feed.
// - `turn`: when `message.received` with its `turnId` arrives on the session's events; or when a
//   session row arrives whose `inbox` does not hold the turn, after the 2xx reply or after a row
//   whose `inbox` did hold it; or at the 2xx reply if nobody reads the feed, or the row held has
//   changed since the request was sent and its `inbox` does not hold the turn. (An accepted turn
//   always changes the session's row, so none of this can strand it.) An `inbox` entry with an
//   `error` fails it.
// - `answer`, `dismiss`, `interrupt`: on the 2xx reply.
// `settled` of a session write resolves on its 2xx reply: from there the server holds it.
//
// `mutate` and the session writes throw before `ready`: the counters live in storage.

import { refusal, transient, type Ctx, type Reply } from "./ctx.js";
import { makeId } from "./ids.js";
import { emitter, signal, type Emitter, type WritableSignal } from "./signal.js";
import { Refused, type ApiEvent, type Failure, type FeedFrame, type MutationName, type Pending, type Row, type SessionRow } from "./types.js";

const ROUTES: Record<MutationName, [method: string, path: string]> = {
  "thread.rename": ["PUT", "/work/threads/{sid}/title"],
  "thread.place": ["PUT", "/work/threads/{sid}/track"],
  "thread.done": ["PUT", "/work/threads/{sid}/done"],
  "thread.reopen": ["DELETE", "/work/threads/{sid}/done"],
  "thread.keep": ["PUT", "/work/threads/{sid}/keep"],
  "thread.ready": ["PUT", "/work/threads/{sid}/ready"],
  "thread.attention": ["PUT", "/work/threads/{sid}/attention"],
  "thread.writers": ["PUT", "/work/threads/{sid}/writers"],
  "thread.delete": ["DELETE", "/work/threads/{sid}"],
  "track.create": ["POST", "/work/tracks"],
  "track.rename": ["PUT", "/work/tracks/{tid}/name"],
  "track.set_stand": ["PUT", "/work/tracks/{tid}/stand"],
  "track.done": ["PUT", "/work/tracks/{tid}/done"],
  "track.reopen": ["DELETE", "/work/tracks/{tid}/done"],
  "track.keep": ["PUT", "/work/tracks/{tid}/keep"],
  "track.dissolve": ["POST", "/work/tracks/{tid}/dissolve"],
  "track.delete": ["DELETE", "/work/tracks/{tid}"],
  "read.set": ["PUT", "/work/reads/{sid}"],
  "pref.set": ["PUT", "/work/prefs/{key}"],
  "doc.save": ["PUT", "/work/tracks/{tid}/doc"],
  "result.add": ["PUT", "/work/results/{resultId}"],
  "review.save": ["PUT", "/work/results/{resultId}/review"],
  "proposal.create": ["POST", "/work/proposals"],
  "proposal.accept": ["POST", "/work/proposals/{proposalId}/accept"],
  "proposal.dismiss": ["POST", "/work/proposals/{proposalId}/dismiss"],
  undo: ["POST", "/work/ops/{opId}/undo"],
};

/** What storage holds for an entry. */
interface Stored {
  p: Pending;
  trace: string;
  /** The `Idempotency-Key` of a session write. */
  idem: string;
}

interface Entry extends Stored {
  answered: boolean;
  /** turn: a session row's `inbox` has held it. */
  inInbox: boolean;
  /** turn: the version of the session's row when the request was sent. */
  sentVersion: number | undefined;
}

export interface Meta {
  clientId: string;
  /** The last mutation number given out. */
  n: number;
  /** The last queue key given out. */
  k: number;
}

type Body = Pending extends infer P ? (P extends Pending ? Omit<P, "key" | "at"> : never) : never;

export interface Queue {
  pending: WritableSignal<Pending[]>;
  failures: Emitter<Failure>;
  load(meta: Meta, stored: Stored[]): void;
  add(p: Body, idem?: string): { n: number; settled: Promise<void> };
  /** Before a feed frame is emitted; what it answers runs after. */
  onFeed(frame: FeedFrame): () => void;
  onEvents(sessionId: string, events: ApiEvent[]): () => void;
  /** Start sending whatever can be sent. */
  pump(): void;
}

export interface FeedView {
  active(): boolean;
  row(kind: string, id: string): Row | undefined;
  catchUp(): void;
}

const pad = (k: number) => String(k).padStart(10, "0");
const lane = (p: Pending) => (p.kind === "mutation" ? "m" : `s:${p.sessionId}`);

function creates(p: Pending): string[] {
  if (p.kind === "session") return [p.sessionId];
  if (p.kind !== "mutation") return [];
  const a = p.args as Record<string, string>;
  if (p.name === "track.create") return [a.tid, a.agentSessionId];
  if (p.name === "result.add") return [a.resultId];
  if (p.name === "proposal.create") return [a.proposalId];
  return [];
}

function names(p: Pending): string[] {
  if (p.kind === "session") return p.body.trackId ? [p.body.trackId] : [];
  if (p.kind !== "mutation") return [p.sessionId];
  const made = creates(p);
  return Object.values(p.args).filter((v): v is string => typeof v === "string" && !made.includes(v));
}

function request(e: Stored, clientId: string): [path: string, init: RequestInit] {
  const p = e.p;
  const headers: Record<string, string> = { "content-type": "application/json", "x-oc-client": clientId, "x-oc-trace": e.trace };
  const post = (path: string, body: unknown): [string, RequestInit] => [path, { method: "POST", headers: { ...headers, "Idempotency-Key": e.idem }, body: JSON.stringify(body) }];
  switch (p.kind) {
    case "mutation": {
      const [method, template] = ROUTES[p.name];
      const body = { ...p.args };
      const path = template.replace(/\{(\w+)\}/g, (_, name: string) => {
        const v = body[name];
        delete body[name];
        return encodeURIComponent(String(v));
      });
      return [path, { method, headers: { ...headers, "x-oc-n": String(p.n) }, body: JSON.stringify(body) }];
    }
    case "session":
      return post("/sessions", p.body);
    case "turn":
      return post(`/sessions/${p.sessionId}/turns`, { id: p.turnId, input: p.input, ifBusy: p.ifBusy });
    case "answer":
      return post(`/sessions/${p.sessionId}/asks/${p.askId}/answer`, p.answer);
    case "dismiss":
      return post(`/sessions/${p.sessionId}/asks/${p.askId}/dismiss`, {});
    case "interrupt":
      return post(`/sessions/${p.sessionId}/interrupt`, {});
  }
}

export function createQueue(ctx: Ctx, feed: FeedView): Queue {
  const pending = signal<Pending[]>([]);
  const failures = emitter<Failure>();
  const entries: Entry[] = [];
  const waiters = new Map<string, { resolve(): void; reject(e: Refused): void }>();
  const running = new Set<string>();
  let meta: Meta | null = null;
  let sender: "idle" | "waiting" | "holding" = "idle";
  let release = () => {};
  const lanes = () => [...new Set(entries.map((e) => lane(e.p)))];
  let nudging = false;

  const held = (e: Entry) => entries.includes(e);
  const saveMeta = () => ({ put: "meta", value: meta });

  /**
   * Takes entries out of the list: `error` set, they failed. `pending` has its new value when this
   * returns; what it answers tells everyone, and is called once the frame that caused it is emitted.
   */
  function leave(out: Map<Entry, Refused | null>): () => void {
    if (!out.size) return () => {};
    // The session writes that name a row a failed entry would have made fail with it.
    for (const e of entries) {
      if (out.has(e) || e.p.kind === "mutation") continue;
      const cause = entries.slice(0, entries.indexOf(e)).find((x) => out.get(x) && creates(x.p).some((id) => names(e.p).includes(id)));
      if (cause) out.set(e, out.get(cause)!);
    }
    for (const e of out.keys()) entries.splice(entries.indexOf(e), 1);
    ctx.write([...out.keys()].map((e) => ({ delete: `queue/${e.p.key}` })));
    pending.setSilent(entries.map((e) => e.p));
    return () => {
      pending.notify();
      for (const [e, error] of out) {
        const w = waiters.get(e.p.key);
        waiters.delete(e.p.key);
        if (error) {
          failures.emit({ entry: e.p, code: error.code, reason: error.reason, detail: error.detail });
          w?.reject(error);
        } else w?.resolve();
      }
      pump();
    };
  }

  const fail = (e: Entry, error: Refused) => leave(new Map([[e, error]]))();
  const done = (e: Entry) => leave(new Map([[e, null]]))();

  function blocked(e: Entry): boolean {
    const wants = names(e.p);
    for (const x of entries) {
      if (x === e) return false;
      if (!x.answered && creates(x.p).some((id) => wants.includes(id))) return true;
    }
    return false;
  }

  /** The first entry of a lane not yet answered, unless it waits for another. */
  function next(l: string): Entry | undefined {
    const e = entries.find((x) => lane(x.p) === l && !x.answered);
    return e && !blocked(e) ? e : undefined;
  }

  function pump(): void {
    if (!meta || ctx.closed) return;
    if (sender === "holding") return startLanes();
    if (sender === "waiting" || !lanes().some(next)) return;
    sender = "waiting";
    // One sender across tabs: the lock is held while any lane has something to send.
    const run = () =>
      new Promise<void>((resolve) => {
        sender = "holding";
        release = resolve;
        startLanes();
        if (!running.size) resolve();
      });
    void (ctx.o.lock ? ctx.o.lock("oc-queue", run) : run())
      .catch(() => {})
      .finally(() => {
        sender = "idle";
        pump();
      });
  }

  function startLanes(): void {
    for (const l of lanes()) {
      if (running.has(l) || !next(l)) continue;
      running.add(l);
      void drain(l).finally(() => {
        running.delete(l);
        if (!ctx.closed) startLanes();
        if (!running.size) release();
      });
    }
  }

  async function drain(l: string): Promise<void> {
    const retry = ctx.backoff();
    for (let e = next(l); e && !ctx.closed; e = next(l)) {
      if (e.p.kind === "turn") e.sentVersion = feed.row("session", e.p.sessionId)?.version;
      const reply = await ctx.request(...request(e, ctx.clientId)).catch(() => null);
      if (ctx.closed) return;
      if (!held(e)) continue; // the feed confirmed or failed it meanwhile
      if (!reply || transient(reply.status)) await retry.wait();
      else {
        retry.reset();
        answer(e, reply);
        pump();
      }
    }
  }

  function answer(e: Entry, reply: Reply): void {
    const p = e.p;
    if (reply.status >= 300) {
      const error = refusal(reply);
      if (p.kind === "mutation" && error.code === "out_of_order") {
        const last = Number(reply.body?.error?.lastMutation ?? reply.body?.lastMutation ?? 0);
        const again = entries.filter((x) => x.p.kind === "mutation" && x.p.n > last);
        if (again.some((x) => x.p.kind === "mutation" && x.p.n === last + 1)) {
          for (const x of again) x.answered = false;
          return;
        }
      }
      return fail(e, error);
    }
    e.answered = true;
    if (p.kind === "mutation") {
      if (!feed.active()) return done(e);
      if (!nudging) {
        nudging = true;
        ctx.timer(() => {
          nudging = false;
          if (entries.some((x) => x.p.kind === "mutation" && x.answered)) feed.catchUp();
        }, 2000);
      }
      return;
    }
    waiters.get(p.key)?.resolve();
    waiters.delete(p.key);
    const row = feed.row("session", p.sessionId) as SessionRow | undefined;
    if (p.kind === "session") {
      if (row || !feed.active()) done(e);
    } else if (p.kind === "turn") {
      const inbox = row?.inbox?.some((i) => i.id === p.turnId);
      if (!feed.active() || (row && row.version !== e.sentVersion && !inbox)) done(e);
    } else done(e);
  }

  return {
    pending,
    failures,
    load(m, stored) {
      meta = m;
      for (const s of stored) entries.push({ ...s, answered: false, inInbox: false, sentVersion: undefined });
      pending.set(entries.map((e) => e.p));
    },
    add(body, idem) {
      if (!meta) throw new Error("the client is not ready: await client.ready before writing");
      const key = pad(++meta.k);
      const n = body.kind === "mutation" ? ++meta.n : 0;
      const p = { ...body, ...(body.kind === "mutation" ? { n } : {}), key, at: ctx.now() } as Pending;
      const stored: Stored = { p, trace: makeId("tr", ctx.random), idem: idem ?? makeId("ib", ctx.random) };
      entries.push({ ...stored, answered: false, inInbox: false, sentVersion: undefined });
      // The entry before the counters: a write lost between the two cannot leave a gap in `n`.
      ctx.write([{ put: `queue/${key}`, value: stored }, saveMeta()]);
      const settled = new Promise<void>((resolve, reject) => waiters.set(key, { resolve, reject }));
      settled.catch(() => {}); // `failures` tells of it too; a caller need not listen here
      pending.set(entries.map((e) => e.p));
      pump();
      return { n, settled };
    },
    onFeed(frame) {
      const out = new Map<Entry, Refused | null>();
      const errors = new Map((frame.errors ?? []).map((e) => [e.n, e]));
      const sessions = new Map<string, SessionRow>();
      for (const r of frame.rows) if (r.kind === "session") sessions.set(r.id, r);
      const gone = new Set(frame.gone.filter((g) => g.kind === "session").map((g) => g.id));
      for (const e of entries) {
        const p = e.p;
        if (p.kind === "mutation") {
          const error = errors.get(p.n);
          if (error) out.set(e, new Refused(error.code, error.reason, error));
          else if (frame.lastMutation !== undefined && frame.lastMutation >= p.n) out.set(e, null);
        } else if (p.kind === "session") {
          if (sessions.has(p.sessionId) || (e.answered && gone.has(p.sessionId))) out.set(e, null);
        } else if (p.kind === "turn") {
          const row = sessions.get(p.sessionId);
          if (!row) continue;
          const entry = row.inbox?.find((i) => i.id === p.turnId);
          if (entry?.error) out.set(e, new Refused(entry.error, "not sent", entry));
          else if (entry) e.inInbox = true;
          else if (e.answered || e.inInbox) out.set(e, null);
        }
      }
      return leave(out);
    },
    onEvents(sessionId, events) {
      const turns = new Set(events.filter((ev) => ev.type === "message.received").map((ev) => ev.turnId));
      const out = new Map<Entry, Refused | null>();
      for (const e of entries) if (e.p.kind === "turn" && e.p.sessionId === sessionId && turns.has(e.p.turnId)) out.set(e, null);
      return leave(out);
    },
    pump,
  };
}
