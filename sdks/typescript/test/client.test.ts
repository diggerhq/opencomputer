// Conformance tests of the client (spec sections 37, 38, 39, 42.1) against the managed-agents Worker,
// run locally (services/managed-agents/test/fixtures/stack.ts): Org, SessionLog, Computer and Live
// are the real ones, the computer is a scripted host, and the network between the client and the
// Worker is the test's to break.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startStack, type Caller, type Host, type Net, type Stack } from "../../../services/managed-agents/test/fixtures/stack.js";
import { createClient, makeId, memoryStorage, Refused, ROW_KINDS } from "../src/computer/index.js";
import type { ApiEvent, Client, ClientOptions, Delta, EventsUpdate, Failure, FeedFrame, Row, SessionRow, Storage } from "../src/computer/index.js";

const KINDS = [...ROW_KINDS];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The client's delays, 500 times shorter (a reconnect in 2 to 10 ms); none of ten minutes or more fires. */
const fast: ClientOptions["setTimeout"] = (fn, ms) => (ms >= 600_000 ? null : setTimeout(fn, ms / 500));

vi.setConfig({ testTimeout: 30_000 });

let stack: Stack;
let orgs = 0;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(() => stack?.close());

const open: Client[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

interface World {
  org: string;
  me: Caller;
  host: Host;
  net: Net;
  client: Client;
  storage: Storage;
}

function connect(w: Pick<World, "me" | "net">, storage: Storage, more: Partial<ClientOptions> = {}): Client {
  const { org, subject } = w.me.principal;
  const client = createClient({ principal: { org, subject }, fetch: w.net.fetch, connect: w.net.connect, storage, setTimeout: fast, ...more });
  open.push(client);
  return client;
}

/** A new org with its computer connected, and a member's client on it. */
async function setup(o: { storage?: Storage; seed?: number; client?: Partial<ClientOptions> } = {}): Promise<World> {
  const org = `org_c${++orgs}${Math.random().toString(36).slice(2, 8)}`;
  const me = await stack.member(org, "ada");
  const host = await stack.host(org);
  const net = me.net(o.seed);
  const storage = o.storage ?? memoryStorage();
  const client = connect({ me, net }, storage, o.client);
  await client.ready;
  return { org, me, host, net, client, storage };
}

async function until(what: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The rows a reader of the feed holds: a frame with `from: null` replaces them all. */
function watchFeed(client: Client, kinds: string[] = KINDS) {
  const frames: FeedFrame[] = [];
  const rows = new Map<string, Row>();
  const stop = client.feed(kinds).subscribe((f) => {
    frames.push(f);
    if (f.from === null) rows.clear();
    for (const r of f.rows) rows.set(`${r.kind}/${r.id}`, r);
    for (const g of f.gone) rows.delete(`${g.kind}/${g.id}`);
  });
  const of = (kind: string) => [...rows.values()].filter((r) => r.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
  const session = (id: string) => rows.get(`session/${id}`) as SessionRow | undefined;
  return { frames, rows, of, session, stop };
}

/** The events a reader holds: a `reset` drops those above its `seq`. */
function watchEvents(client: Client, sid: string) {
  const held: ApiEvent[] = [];
  const updates: EventsUpdate[] = [];
  const stop = client.events(sid).subscribe((u) => {
    updates.push(u);
    if (u.reset) {
      const keep = u.reset.seq;
      held.splice(0, held.length, ...held.filter((e) => keep !== null && e.seq <= keep));
    }
    held.push(...u.events);
  });
  return { held, updates, stop, seqs: () => held.map((e) => e.seq) };
}

// ---------------------------------------------------------------- the server's truth, read apart

/** What a snapshot of the feed holds for `me` now, by kind. */
async function rowsOf(me: Caller, kinds: string[] = KINDS): Promise<Map<string, Row[]>> {
  const res = await me.fetch(`/feed?kinds=${kinds.join(",")}`);
  const frame = (await res.json()) as FeedFrame;
  expect(frame.more).toBe(false);
  const by = new Map<string, Row[]>(kinds.map((k) => [k, []]));
  for (const r of frame.rows) by.get(r.kind)?.push(r);
  for (const list of by.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return by;
}

async function rowOf(me: Caller, kind: string, id: string): Promise<Row | undefined> {
  return (await rowsOf(me, [kind])).get(kind)!.find((r) => r.id === id);
}

/** The session's log as the server holds it. */
async function eventsOf(me: Caller, sid: string): Promise<ApiEvent[]> {
  const out: ApiEvent[] = [];
  let q = "tailTurns=50";
  for (;;) {
    const res = await me.fetch(`/sessions/${sid}/events?${q}`);
    const page = (await res.json()) as { events: ApiEvent[]; cursor: string; hasMore: boolean };
    if (!Array.isArray(page.events)) throw new Error(`events ${res.status}: ${JSON.stringify(page)}`);
    out.push(...page.events);
    if (!page.hasMore) return out;
    q = `after=${encodeURIComponent(page.cursor)}`;
  }
}

/** The feed held what the server held at one moment (a later change may be on its way to both). */
async function converged(me: Caller, feed: ReturnType<typeof watchFeed>, kinds: string[] = KINDS): Promise<void> {
  let truth = new Map<string, Row[]>();
  const same = async () => {
    truth = await rowsOf(me, kinds);
    return kinds.every((k) => JSON.stringify(feed.of(k)) === JSON.stringify(truth.get(k)));
  };
  await until(same).catch(() => {});
  for (const k of kinds) expect(feed.of(k), k).toEqual(truth.get(k));
}

// ---------------------------------------------------------------- the agent

/** A write by the session's agent, as its tools make it. */
async function agentWrite(w: World, sid: string, method: string, path: string, body: unknown): Promise<void> {
  const agent = await stack.agent(w.org, sid);
  const res = await agent.fetch(path, { method, body: JSON.stringify(body), headers: { "idempotency-key": makeId("idem") } });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
}

const attention = (w: World, sid: string, what: string | null) => agentWrite(w, sid, "PUT", `/work/threads/${sid}/attention`, { what });

/** A thread with its first turn running on the host (the agent is the test's to drive). */
async function thread(w: World, input = "Look into the slow request"): Promise<string> {
  const s = w.client.createSession({ input });
  await s.settled;
  await w.host.turn(s.id);
  return s.id;
}

describe("the feed", () => {
  it("gives a snapshot with from: null, then the live rows", async () => {
    const w = await setup();
    const sid = await thread(w);
    const feed = watchFeed(w.client);
    await until(() => feed.frames.length > 0);
    expect(feed.frames[0].from).toBeNull();
    expect(feed.frames[0].rows.length).toBeGreaterThan(0);
    await converged(w.me, feed);
    const before = feed.frames.length;
    await attention(w, sid, "Needs a decision");
    await until(() => feed.frames.some((f, i) => i >= before && f.rows.some((r) => r.kind === "place" && r.id === sid)));
    const live = feed.frames[before];
    expect(live.from).toBe(feed.frames[before - 1].to);
    expect(feed.rows.get(`place/${sid}`)).toEqual(await rowOf(w.me, "place", sid));
  });

  it("keeps the rows in storage and replays them to a second client", async () => {
    const w = await setup();
    await thread(w);
    const first = watchFeed(w.client);
    await converged(w.me, first);
    await sleep(5);
    w.client.close();
    expect((await w.storage.list("feed/row/")).length).toBe(first.rows.size);

    w.net.offline(true); // what the second client shows can only come from storage
    const again = connect(w, w.storage);
    const second = watchFeed(again);
    await until(() => second.frames.length > 0);
    expect(second.frames[0].from).toBeNull();
    expect(second.frames[0].to).toBe(first.frames[first.frames.length - 1].to);
    expect([...second.rows.keys()].sort()).toEqual([...first.rows.keys()].sort());
    expect(again.clientId).toBe(w.client.clientId);
  });

  it("resumes by cursor after the sockets drop", async () => {
    const w = await setup();
    const feed = watchFeed(w.client);
    const sid = await thread(w);
    await converged(w.me, feed);
    w.net.dropSockets();
    await attention(w, sid, "While you were away");
    w.host.tool(sid, "ls");
    await until(() => w.client.status.get() === "online");
    await converged(w.me, feed);
    expect(feed.frames.filter((f) => f.from === null).length).toBe(1); // no second snapshot
    for (let i = 1; i < feed.frames.length; i++) expect(feed.frames[i].from).toBe(feed.frames[i - 1].to);
  });

  it("recovers from a reset when the server cannot read on from its cursor", async () => {
    const w = await setup();
    const sid = await thread(w);
    const first = watchFeed(w.client);
    await converged(w.me, first);
    await sleep(5);
    w.client.close();
    // A cursor past Org's version, as one held across Org losing its tail: answered `reset`.
    await w.storage.put("feed/cursor", "f1.999999");
    await attention(w, sid, "Changed since");
    const again = connect(w, w.storage);
    const feed = watchFeed(again);
    await until(() => feed.frames.filter((f) => f.from === null).length === 2);
    await converged(w.me, feed);
  });

  it("converges while pushed frames are dropped, duplicated and reordered", async () => {
    const w = await setup({ seed: 7 });
    w.net.chaos({ drop: 0.3, duplicate: 0.3, reorder: 0.3 });
    const feed = watchFeed(w.client);
    const sid = await thread(w);
    const events = watchEvents(w.client, sid);
    for (let i = 0; i < 12; i++) {
      w.client.mutate("thread.rename", { sid, title: `Title ${i}` });
      await attention(w, sid, `Attention ${i}`);
      w.host.tool(sid, `step ${i}`);
    }
    await until(() => w.client.pending().get().length === 0);
    // A lost or held frame is noticed at the next one: section 38.3, step 3.
    w.net.chaos({});
    await attention(w, sid, null);
    w.host.end(sid);
    await converged(w.me, feed);
    await until(async () => events.held.length === (await eventsOf(w.me, sid)).length);
    expect(events.held).toEqual(await eventsOf(w.me, sid));
    expect((await rowOf(w.me, "session", sid)) as SessionRow).toMatchObject({ title: "Title 11" });
  });

  it("ignores a server that answers for another principal", async () => {
    const w = await setup();
    const client = createClient({ principal: { org: w.org, subject: "usr_other" }, fetch: w.net.fetch, connect: w.net.connect, storage: memoryStorage(), setTimeout: fast });
    open.push(client);
    const feed = watchFeed(client);
    await until(() => client.status.get() === "offline");
    await sleep(20);
    expect(feed.frames).toEqual([]);
  });
});

describe("mutations", () => {
  it("is in pending() at once, and has left it when the frame holding its effect is applied", async () => {
    const w = await setup();
    const feed = watchFeed(w.client);
    const sid = await thread(w);
    await converged(w.me, feed);
    // The moment it leaves pending(), the feed already shows its effect: no flicker back to the old title.
    let titleWhenLeft: string | undefined;
    w.client.pending().subscribe((list) => {
      if (list.length === 0 && titleWhenLeft === undefined) titleWhenLeft = feed.session(sid)?.title;
    });
    const m = w.client.mutate("thread.rename", { sid, title: "Renamed" });
    expect(w.client.pending().get()).toMatchObject([{ kind: "mutation", name: "thread.rename", args: { sid, title: "Renamed" } }]);
    await m.settled;
    await until(() => titleWhenLeft !== undefined);
    expect(w.client.pending().get()).toEqual([]);
    expect(titleWhenLeft).toBe("Renamed");
    expect(feed.session(sid)!.title).toBe("Renamed");
    expect(w.net.requests.find((r) => r.path === `/work/threads/${sid}/title`)).toMatchObject({ method: "PUT", status: 200 });
  });

  it("sends a mutation again when the reply is lost, and it is applied once", async () => {
    const w = await setup();
    const sid = await thread(w); // nobody reads the feed: only the reply confirms
    w.net.loseReplies(1_000);
    const m = w.client.mutate("thread.rename", { sid, title: "Once" });
    const path = `/work/threads/${sid}/title`;
    await until(() => w.net.requests.some((r) => r.path === path && r.status === 503));
    expect(w.client.pending().get().length).toBe(1);
    w.net.loseReplies(0);
    await m.settled;
    const sent = w.net.requests.filter((r) => r.path === path);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[sent.length - 1].status).toBe(200);
    const ops = (await rowsOf(w.me, ["op"])).get("op")!;
    expect(ops.filter((o) => o.kind === "op" && o.name === "thread.rename").length).toBe(1);
    expect(await rowOf(w.me, "session", sid)).toMatchObject({ title: "Once" });
    expect(w.client.pending().get()).toEqual([]);
  });

  it("tells failures of a refused mutation and drops its optimistic copy", async () => {
    const w = await setup();
    const feed = watchFeed(w.client);
    const failures: Failure[] = [];
    w.client.failures.subscribe((f) => failures.push(f));
    const m = w.client.mutate("thread.rename", { sid: makeId("cs"), title: "Nope" });
    await expect(m.settled).rejects.toBeInstanceOf(Refused);
    expect(failures).toMatchObject([{ code: "not_found", entry: { kind: "mutation", name: "thread.rename" } }]);
    expect(w.client.pending().get()).toEqual([]);
    // The queue goes on: the next mutation is applied.
    const sid = await thread(w);
    await w.client.mutate("thread.rename", { sid, title: "After a refusal" }).settled;
    await converged(w.me, feed);
    expect(feed.session(sid)!.title).toBe("After a refusal");
    expect(failures.length).toBe(1);
  });

  it("queues writes made offline and sends them in order afterwards", async () => {
    const w = await setup();
    const feed = watchFeed(w.client);
    const sid = await thread(w);
    await converged(w.me, feed);
    w.net.offline(true);
    await until(() => w.client.status.get() === "offline");
    const writes = ["One", "Two", "Three"].map((title) => w.client.mutate("thread.rename", { sid, title }));
    await sleep(20);
    expect(w.client.pending().get().map((p) => p.kind === "mutation" && p.args.title)).toEqual(["One", "Two", "Three"]);
    const path = `/work/threads/${sid}/title`;
    expect(w.net.requests.filter((r) => r.path === path && r.status !== 0)).toEqual([]);
    w.net.offline(false);
    await Promise.all(writes.map((x) => x.settled));
    expect(w.net.requests.filter((r) => r.path === path && r.status === 200).map((r) => (r.body as { title: string }).title)).toEqual(["One", "Two", "Three"]);
    expect(w.client.pending().get()).toEqual([]);
    await converged(w.me, feed);
    expect(feed.session(sid)!.title).toBe("Three");
  });

  it("keeps the queue in storage: a second client sends what the first could not", async () => {
    const w = await setup();
    const sid = await thread(w);
    w.net.offline(true);
    w.client.mutate("thread.rename", { sid, title: "From storage" });
    await sleep(5);
    w.client.close();
    w.net.offline(false);
    const again = connect(w, w.storage);
    await again.ready;
    expect(again.pending().get()).toMatchObject([{ kind: "mutation", name: "thread.rename" }]);
    await until(() => again.pending().get().length === 0);
    expect(await rowOf(w.me, "session", sid)).toMatchObject({ title: "From storage" });
  });

  it("holds a write that names a row an earlier queued write creates", async () => {
    const w = await setup();
    const feed = watchFeed(w.client);
    const tid = makeId("trk");
    const track = w.client.mutate("track.create", { tid, agentSessionId: makeId("cs"), name: "Billing" });
    const s = w.client.createSession({ input: "Start on the invoices", trackId: tid });
    await Promise.all([track.settled, s.settled]);
    // The session was sent once the track was answered (its row may reach the feed before its reply does).
    const order = w.net.requests.filter((r) => r.method === "POST" && (r.path === "/work/tracks" || r.path === "/sessions"));
    expect(order.map((r) => r.path)).toEqual(["/work/tracks", "/sessions"]);
    expect(order[0].status).toBe(200);
    await converged(w.me, feed);
    expect(feed.rows.get(`place/${s.id}`)).toMatchObject({ trackId: tid });
  });
});

describe("a session", () => {
  it("createSession and a turn: the events arrive in seq order, with the deltas", async () => {
    const w = await setup();
    const s = w.client.createSession({ input: "Say hello" });
    expect(w.client.pending().get()).toMatchObject([{ kind: "session", sessionId: s.id, body: { input: "Say hello", turnId: s.turnId } }]);
    await s.settled;
    await w.host.turn(s.id);
    const events = watchEvents(w.client, s.id);
    const deltas: Delta[] = [];
    w.client.deltas(s.id).subscribe((d) => deltas.push(d));
    await until(() => events.held.some((e) => e.type === "turn.started"));
    await sleep(50); // the `sub` for the deltas is on its way
    const text = "Hello. This is the answer, streamed in pieces.";
    w.host.stream(s.id, text, 7);
    w.host.tool(s.id, "ls");
    w.host.end(s.id);
    await until(() => events.held.some((e) => e.type === "turn.completed"));
    expect(events.held).toEqual(await eventsOf(w.me, s.id));
    expect(events.seqs()).toEqual(events.held.map((_, i) => i + 1));
    expect(events.held.map((e) => e.type).filter((t) => t !== "session.status_changed")).toEqual([
      "message.received", "turn.started", "message.completed", "tool.started", "tool.completed", "turn.completed",
    ]);
    expect(events.held[0].turnId).toBe(s.turnId);
    expect(deltas.map((d) => d.data.text).join("")).toBe(text);
    expect(deltas.map((d) => d.offset)).toEqual(deltas.map((_, i) => i * 7));
    expect(w.client.pending().get()).toEqual([]);
  });

  it("send: the turn is pending until its message.received is seen", async () => {
    const w = await setup();
    const feed = watchFeed(w.client);
    const sid = await thread(w);
    const events = watchEvents(w.client, sid);
    w.host.end(sid);
    await until(() => events.held.some((e) => e.type === "turn.completed"));
    const t = w.client.send(sid, "And another thing");
    expect(w.client.pending().get()).toMatchObject([{ kind: "turn", sessionId: sid, turnId: t.turnId, input: "And another thing" }]);
    await t.settled;
    await until(() => w.client.pending().get().length === 0);
    expect(events.held.find((e) => e.type === "message.received" && e.turnId === t.turnId)).toBeDefined();
    await converged(w.me, feed);
    expect(feed.session(sid)).toMatchObject({ status: "running", activeTurnId: t.turnId });
  });

  it("answer closes an ask; a write to a session that is not there fails", async () => {
    const w = await setup();
    const sid = await thread(w);
    const events = watchEvents(w.client, sid);
    const askId = w.host.ask(sid, { kind: "approval", approval: { title: "Run the migration", command: "make migrate" } });
    await until(() => events.held.some((e) => e.type === "ask.opened"));
    await w.client.answer(sid, askId, { decision: "allow" }).settled;
    await until(() => events.held.some((e) => e.type === "ask.closed"));
    expect(events.held.find((e) => e.type === "ask.closed")!.data).toMatchObject({ ask: { id: askId, status: "answered" } });
    const failures: Failure[] = [];
    w.client.failures.subscribe((f) => failures.push(f));
    await expect(w.client.send(makeId("cs"), "Anyone?").settled).rejects.toMatchObject({ code: "not_found" });
    expect(failures).toMatchObject([{ code: "not_found", entry: { kind: "turn" } }]);
    expect(w.client.pending().get()).toEqual([]);
  });

  it("resumes the events by cursor after the sockets drop, with no gap and no duplicate", async () => {
    const w = await setup();
    const sid = await thread(w);
    const events = watchEvents(w.client, sid);
    w.host.tool(sid, "before");
    await until(async () => events.held.length === (await eventsOf(w.me, sid)).length);
    w.net.dropSockets();
    w.host.tool(sid, "while away");
    w.host.say(sid, "Said while the socket was down.");
    await until(() => w.client.status.get() === "online");
    w.host.tool(sid, "after");
    w.host.end(sid);
    await until(async () => {
      const truth = await eventsOf(w.me, sid);
      return truth.some((e) => e.type === "turn.completed") && events.held.length >= truth.length;
    });
    expect(events.seqs()).toEqual((await eventsOf(w.me, sid)).map((e) => e.seq));
    expect(events.updates.some((u) => u.reset)).toBe(false);
    // The read after the reconnect asked for what follows the cursor, not for the log again.
    const reads = w.net.requests.filter((r) => r.path.startsWith(`/sessions/${sid}/events`));
    expect(reads.filter((r) => r.path.includes("tailTurns")).length).toBe(1);
    expect(reads.some((r) => r.path.includes("after="))).toBe(true);
  });

  it("recovers from a reset when its cursor is past the log's end", async () => {
    const w = await setup({ client: { keepEvents: true } });
    const sid = await thread(w);
    const events = watchEvents(w.client, sid);
    w.host.tool(sid, "one");
    await until(async () => events.held.length === (await eventsOf(w.me, sid)).length);
    await sleep(5);
    w.client.close();
    // Held past what the log kept, as across a log that lost its tail: answered `reset` to its end.
    const held = (await w.storage.get(`ev/${sid}/cursor`)) as string;
    const [, epoch] = held.split(".");
    await w.storage.put(`ev/${sid}/cursor`, `e1.${epoch}.999`);
    const again = connect(w, w.storage, { keepEvents: true });
    const after = watchEvents(again, sid);
    await until(() => after.updates.some((u) => u.reset));
    const t = again.send(sid, "Carry on from there");
    await t.settled;
    await until(async () => after.held.length === (await eventsOf(w.me, sid)).length);
    expect(after.held).toEqual(await eventsOf(w.me, sid));
    expect(after.held.find((e) => e.type === "message.received" && e.turnId === t.turnId)).toBeDefined();
  });

  it("with keepEvents, replays a session's events from storage", async () => {
    const w = await setup({ client: { keepEvents: true } });
    const sid = await thread(w);
    const events = watchEvents(w.client, sid);
    w.host.tool(sid, "one");
    await until(async () => events.held.length === (await eventsOf(w.me, sid)).length);
    await sleep(5);
    w.client.close();
    w.net.offline(true);
    const again = connect(w, w.storage, { keepEvents: true });
    const held = watchEvents(again, sid);
    await until(() => held.updates.length > 0);
    expect(held.held).toEqual(await eventsOf(w.me, sid));
  });
});

describe("the client", () => {
  it("status follows the socket", async () => {
    const w = await setup();
    const seen: string[] = [];
    w.client.status.subscribe((s) => seen.push(s));
    await until(() => w.client.status.get() === "online");
    w.net.offline(true);
    await until(() => w.client.status.get() === "offline");
    w.net.offline(false);
    await until(() => w.client.status.get() === "online");
    expect(seen[0]).toBe("online");
    expect(seen).toContain("offline");
    expect(seen[seen.length - 1]).toBe("online");
  });

  it("read answers a body, and throws Refused on an error body", async () => {
    const w = await setup();
    await thread(w);
    const before = w.net.requests.length;
    const page = await w.client.read<{ rows: Row[]; next: string | null }>("/work/threads?limit=5");
    expect(page.rows.length).toBeGreaterThan(0);
    await expect(w.client.read(`/work/results/${makeId("res")}/review`)).rejects.toMatchObject({ name: "Refused", code: "not_found" });
    expect(w.net.requests.length - before).toBe(2);
  });

  it("wipe removes everything it stored", async () => {
    const w = await setup();
    await thread(w);
    const feed = watchFeed(w.client);
    await until(() => feed.frames.length > 0);
    await sleep(5);
    expect((await w.storage.list("")).length).toBeGreaterThan(1);
    await w.client.wipe();
    expect(await w.storage.list("")).toEqual([]);
  });
});
