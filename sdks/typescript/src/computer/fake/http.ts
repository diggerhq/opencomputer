// The HTTP API of section 37: one function from a request to a status, a body and headers.

import type { Answer, MutationName } from "../types.js";
import { clone, personActor, Refusal, statusOf, type Ctx } from "./ctx.js";

export interface Reply {
  status: number;
  body?: unknown;
  /** A body that is not JSON (the diff). */
  text?: string;
  headers?: Record<string, string>;
}

/** Section 37.3's table: method, path, mutation, and what the path's parameter is called in its arguments. */
const MUTATIONS: [method: string, path: RegExp, name: MutationName, arg: string | null][] = [
  ["PUT", /^\/work\/threads\/([^/]+)\/title$/, "thread.rename", "sid"],
  ["PUT", /^\/work\/threads\/([^/]+)\/track$/, "thread.place", "sid"],
  ["PUT", /^\/work\/threads\/([^/]+)\/done$/, "thread.done", "sid"],
  ["DELETE", /^\/work\/threads\/([^/]+)\/done$/, "thread.reopen", "sid"],
  ["PUT", /^\/work\/threads\/([^/]+)\/keep$/, "thread.keep", "sid"],
  ["PUT", /^\/work\/threads\/([^/]+)\/ready$/, "thread.ready", "sid"],
  ["PUT", /^\/work\/threads\/([^/]+)\/attention$/, "thread.attention", "sid"],
  ["PUT", /^\/work\/threads\/([^/]+)\/writers$/, "thread.writers", "sid"],
  ["DELETE", /^\/work\/threads\/([^/]+)$/, "thread.delete", "sid"],
  ["POST", /^\/work\/tracks$/, "track.create", null],
  ["PUT", /^\/work\/tracks\/([^/]+)\/name$/, "track.rename", "tid"],
  ["PUT", /^\/work\/tracks\/([^/]+)\/stand$/, "track.set_stand", "tid"],
  ["PUT", /^\/work\/tracks\/([^/]+)\/done$/, "track.done", "tid"],
  ["DELETE", /^\/work\/tracks\/([^/]+)\/done$/, "track.reopen", "tid"],
  ["PUT", /^\/work\/tracks\/([^/]+)\/keep$/, "track.keep", "tid"],
  ["POST", /^\/work\/tracks\/([^/]+)\/dissolve$/, "track.dissolve", "tid"],
  ["DELETE", /^\/work\/tracks\/([^/]+)$/, "track.delete", "tid"],
  ["PUT", /^\/work\/reads\/([^/]+)$/, "read.set", "sid"],
  ["PUT", /^\/work\/prefs\/([^/]+)$/, "pref.set", "key"],
  ["PUT", /^\/work\/tracks\/([^/]+)\/doc$/, "doc.save", "tid"],
  ["PUT", /^\/work\/results\/([^/]+)\/review$/, "review.save", "resultId"],
  ["PUT", /^\/work\/results\/([^/]+)$/, "result.add", "resultId"],
  ["POST", /^\/work\/proposals$/, "proposal.create", null],
  ["POST", /^\/work\/proposals\/([^/]+)\/accept$/, "proposal.accept", "proposalId"],
  ["POST", /^\/work\/proposals\/([^/]+)\/dismiss$/, "proposal.dismiss", "proposalId"],
  ["POST", /^\/work\/ops\/([^/]+)\/undo$/, "undo", "opId"],
];

// A few of the server's models (managed-agents computer/capabilities.ts), for the pickers.
const CAPABILITIES = {
  models: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1_000_000, default: true },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1_000_000, default: false },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: ["low", "medium", "high"], contextWindow: 200_000, default: false },
  ],
  modes: ["default", "acceptEdits", "plan", "bypassPermissions"],
  features: { steer: true },
};

const num = (v: string | null, d: number, max: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d;
};

export async function route(ctx: Ctx, method: string, url: URL, headers: Headers, body: Record<string, unknown>): Promise<Reply> {
  try {
    return await handle(ctx, method, url, headers, body);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { status: statusOf(e.code), body: { error: { code: e.code, reason: e.reason, message: e.reason, ...e.detail } } };
  }
}

async function handle(ctx: Ctx, method: string, url: URL, headers: Headers, body: Record<string, unknown>): Promise<Reply> {
  const { org, log, mutations } = ctx;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;
  const me = ctx.principal.subject;
  const actor = personActor(ctx.principal);
  const key = headers.get("idempotency-key");
  let m: RegExpExecArray | null;

  // ---------- the feed and the occurrences

  if (method === "GET" && path === "/capabilities") return { status: 200, body: { capabilities: CAPABILITIES } };
  if (method === "GET" && path === "/feed") {
    const kinds = q.get("kinds");
    return { status: 200, body: await org.feed({ after: q.get("after"), kinds: kinds ? kinds.split(",").filter(Boolean) : null, sum: q.get("sum") === "1" }) };
  }
  if (method === "POST" && path === "/feed/mismatch") {
    org.mismatches.push(clone(body));
    return { status: 204 };
  }
  if (method === "GET" && path === "/occurrences") {
    const after = num(q.get("after"), 0, Infinity);
    const entries = org.occurrences.filter((o) => Number(o.n) > after).slice(0, num(q.get("limit"), 100, 1000));
    return { status: 200, body: { protocol: 1, entries: clone(entries), to: entries.length ? entries[entries.length - 1].n : String(after) } };
  }

  // ---------- sessions and turns

  if (method === "POST" && path === "/sessions") return log.create(body as Parameters<typeof log.create>[0], me, actor);
  if ((m = /^\/sessions\/([^/]+)$/.exec(path))) {
    const sid = decodeURIComponent(m[1]);
    const row = org.need("session", sid);
    if (method === "GET") return { status: 200, body: { session: clone(row) } };
    if (method === "PATCH") {
      org.tx(() => {
        if (typeof body.title === "string") mutations.run(me, "thread.rename", { sid, title: body.title });
        if (body.archived === true) mutations.run(me, "thread.done", { sid });
        if (body.archived === false) mutations.run(me, "thread.reopen", { sid });
        // The model, effort or mode (spec 19.1); the fake takes any.
        const settings = Object.fromEntries((["model", "effort", "mode"] as const).filter((k) => typeof body[k] === "string").map((k) => [k, body[k] as string]));
        if (Object.keys(settings).length) {
          row.settings = { ...row.settings, ...settings };
          org.touch(row);
        }
        if (body.metadata && typeof body.metadata === "object") {
          row.metadata = { ...row.metadata, ...(body.metadata as Record<string, string>) };
          org.touch(row);
        }
      });
      return { status: 200, body: { session: clone(row) } };
    }
  }
  // A secret is taken and dropped: the fake keeps no value.
  if (method === "PUT" && (m = /^\/sessions\/([^/]+)\/secrets\/([^/]+)$/.exec(path))) {
    org.need("session", decodeURIComponent(m[1]));
    if (typeof body.value !== "string" || !body.value) throw new Refusal("invalid_request", "value is required");
    return { status: 204 };
  }
  if (method === "GET" && (m = /^\/sessions\/([^/]+)\/events$/.exec(path))) {
    const tail = q.get("tailTurns");
    return { status: 200, body: log.read(decodeURIComponent(m[1]), { after: q.get("after"), tailTurns: tail == null ? null : num(tail, 0, 1000), limit: num(q.get("limit"), 500, 1000) }) };
  }
  if (method === "POST" && (m = /^\/sessions\/([^/]+)\/turns$/.exec(path))) {
    const sid = decodeURIComponent(m[1]);
    org.need("session", sid);
    if (typeof body.input !== "string" || !body.input) throw new Refusal("invalid_request", "input is required");
    const id = typeof body.id === "string" ? body.id : key ? `tn_${key}` : ctx.id("tn", 12);
    const ifBusy = body.ifBusy === "queue" || body.ifBusy === "steer" || body.ifBusy === "interrupt" ? body.ifBusy : undefined;
    const { duplicate } = log.accept(sid, { id, kind: "turn", input: body.input, ifBusy }, me, actor);
    return { status: 200, body: { turn: { id, status: "queued" }, delivery: "queued", duplicate } };
  }
  if (method === "POST" && (m = /^\/sessions\/([^/]+)\/asks\/([^/]+)\/(answer|dismiss)$/.exec(path))) {
    const sid = decodeURIComponent(m[1]);
    const row = org.need("session", sid);
    const ask = row.asks.find((a) => a.id === decodeURIComponent(m![2]));
    if (!ask || ask.status !== "open") throw new Refusal("ask_closed", "the ask is not open");
    const kind = m[3] === "answer" ? "answer" : "dismiss";
    log.accept(sid, { id: key ?? ctx.id("ib"), kind, askId: ask.id, answer: kind === "answer" ? (body as unknown as Answer) : undefined }, me, actor);
    return { status: 200, body: { ask: clone(ask) } };
  }
  if (method === "POST" && (m = /^\/sessions\/([^/]+)\/interrupt$/.exec(path))) {
    const sid = decodeURIComponent(m[1]);
    const row = org.need("session", sid);
    log.interrupt(sid, me);
    return { status: 200, body: { session: clone(row) } };
  }

  // ---------- the work reads

  if (method === "GET" && path === "/work/threads")
    return { status: 200, body: org.threads({ earlier: q.get("earlier") === "1" || q.get("earlier") === "true", track: q.get("track") || null, before: q.get("before"), limit: num(q.get("limit"), 50, 200) }) };
  if (method === "GET" && path === "/work/overview") return { status: 200, body: org.overview() };
  if (method === "GET" && path === "/work/search") return { status: 200, body: org.search(q.get("q") ?? "", num(q.get("limit"), 50, 50), (sid) => log.sess(sid).formerTitles) };
  if (method === "GET" && (m = /^\/work\/results\/([^/]+)\/review$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    org.need("result", id);
    const review = org.reviews.get(id);
    if (!review) throw new Refusal("not_found", "no review");
    return { status: 200, body: clone(review) };
  }
  if (method === "GET" && (m = /^\/work\/results\/([^/]+)\/diff$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    const r = org.need("result", id);
    const diff = org.diffs.get(id);
    if (r.type !== "pr" || diff == null) throw new Refusal("not_found", "not a pull request with a diff");
    const head = org.reviews.get(id)?.head ?? (r.meta?.head as string | undefined) ?? id;
    const etag = `"${head}"`;
    if (headers.get("if-none-match") === etag) return { status: 304, headers: { etag } };
    return { status: 200, body: { protocol: 1, head, diff }, headers: { etag } };
  }
  if (method === "GET" && (m = /^\/work\/tracks\/([^/]+)\/doc\/revisions(?:\/(\d+))?$/.exec(path))) {
    const tid = decodeURIComponent(m[1]);
    org.need("track", tid);
    const revs = org.docRevs.get(tid) ?? [];
    if (m[2] == null) return { status: 200, body: { protocol: 1, revisions: revs.map(({ text: _text, ...r }) => r).reverse() } };
    const rev = revs.find((r) => r.rev === Number(m![2]));
    if (!rev) throw new Refusal("not_found", "no such revision");
    return { status: 200, body: clone(rev) };
  }

  // ---------- the mutations

  for (const [verb, re, name, arg] of MUTATIONS) {
    if (verb !== method || !(m = re.exec(path))) continue;
    const args = { ...body, ...(arg ? { [arg]: decodeURIComponent(m[1]) } : {}) };
    return mutations.member(key, name, args);
  }

  throw new Refusal("not_found", `no route ${method} ${path}`);
}
