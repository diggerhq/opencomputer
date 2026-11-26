// Conformance tests of the client (spec sections 37, 38, 39, 42.1) against the fake server.

import { afterEach, describe, expect, it } from "vitest";
import { createFakeServer } from "./fake/index.js";
import type { FakeOptions, FakeServer } from "./fake/api.js";
import { createClient, makeId, memoryStorage, Refused, ROW_KINDS } from "./index.js";
import type { ApiEvent, Client, ClientOptions, Delta, EventsUpdate, Failure, FeedFrame, Row, SessionRow, Storage } from "./index.js";

const KINDS = [...ROW_KINDS];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The client's delays, 500 times shorter (a reconnect in 2 to 10 ms); the hourly checksum never fires. */
const fast: ClientOptions["setTimeout"] = (fn, ms) => (ms >= 600_000 ? null : setTimeout(fn, ms / 500));

const open: Client[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

function connect(fake: FakeServer, storage: Storage = memoryStorage(), more: Partial<ClientOptions> = {}): Client {
  const client = createClient({ principal: fake.principal, fetch: fake.fetch, connect: fake.connect, storage, setTimeout: fast, ...more });
  open.push(client);
  return client;
}

async function setup(o: FakeOptions = {}, storage: Storage = memoryStorage()) {
  const fake = createFakeServer({ seed: "empty", autoAgent: false, ...o });
  const client = connect(fake, storage);
  await client.ready;
  return { fake, client, storage };
}

async function until(fake: FakeServer, what: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await fake.idle();
    await sleep(1);
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

const sorted = <K extends (typeof KINDS)[number]>(fake: FakeServer, kind: K) => fake.rows(kind).sort((a, b) => a.id.localeCompare(b.id));

async function converged(fake: FakeServer, feed: ReturnType<typeof watchFeed>, kinds: string[] = KINDS): Promise<void> {
  const same = () => kinds.every((k) => JSON.stringify(feed.of(k)) === JSON.stringify(sorted(fake, k as (typeof KINDS)[number])));
  await until(fake, same).catch(() => {});
  for (const k of kinds) expect(feed.of(k), k).toEqual(sorted(fake, k as (typeof KINDS)[number]));
}

/** A thread with its first turn running (the agent is the test's to drive). */
async function thread(fake: FakeServer, client: Client, input = "Look into the slow request"): Promise<string> {
  const s = client.createSession({ input });
  await s.settled;
  await until(fake, () => fake.events(s.id).length > 0);
  return s.id;
}

describe("the feed", () => {
  it("gives a snapshot with from: null, then the live rows", async () => {
    const { fake, client } = await setup({ seed: "demo" });
    const feed = watchFeed(client);
    await until(fake, () => feed.frames.length > 0);
    expect(feed.frames[0].from).toBeNull();
    expect(feed.frames[0].rows.length).toBeGreaterThan(0);
    const sid = feed.of("place").find((p) => p.kind === "place" && p.doneAt == null)!.id;
    const before = feed.frames.length;
    fake.agent.mutate(sid, "thread.attention", { sid, what: "Needs a decision" });
    await until(fake, () => feed.frames.length > before);
    const live = feed.frames[feed.frames.length - 1];
    expect(live.from).toBe(feed.frames[before - 1].to);
    expect(live.rows.map((r) => `${r.kind}/${r.id}`)).toContain(`place/${sid}`);
    expect(feed.rows.get(`place/${sid}`)).toEqual(fake.row("place", sid));
  });

  it("keeps the rows in storage and replays them to a second client", async () => {
    const { fake, client, storage } = await setup({ seed: "demo" });
    const first = watchFeed(client);
    await until(fake, () => first.frames.length > 0);
    await sleep(2);
    client.close();
    expect((await storage.list("feed/row/")).length).toBe(first.rows.size);

    fake.setOffline(true); // what the second client shows can only come from storage
    const again = connect(fake, storage);
    const second = watchFeed(again);
    await until(fake, () => second.frames.length > 0);
    expect(second.frames[0].from).toBeNull();
    expect(second.frames[0].to).toBe(first.frames[first.frames.length - 1].to);
    expect([...second.rows.keys()].sort()).toEqual([...first.rows.keys()].sort());
    expect(again.clientId).toBe(client.clientId);
  });

  it("resumes by cursor after the sockets drop", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const sid = await thread(fake, client);
    await converged(fake, feed);
    fake.dropSockets();
    fake.agent.mutate(sid, "thread.attention", { sid, what: "While you were away" });
    fake.agent.tool(sid, "ls");
    await until(fake, () => client.status.get() === "online");
    await converged(fake, feed);
    expect(feed.frames.filter((f) => f.from === null).length).toBe(1); // no second snapshot
    for (let i = 1; i < feed.frames.length; i++) expect(feed.frames[i].from).toBe(feed.frames[i - 1].to);
  });

  it("recovers from a reset when Org raised the floor", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const sid = await thread(fake, client);
    await converged(fake, feed);
    fake.dropSockets();
    fake.agent.mutate(sid, "thread.attention", { sid, what: "Changed below the floor" });
    fake.raiseFloor();
    await until(fake, () => feed.frames.filter((f) => f.from === null).length === 2);
    await converged(fake, feed);
  });

  it("re-syncs with a snapshot when the checksum differs", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const sid = await thread(fake, client);
    await converged(fake, feed);
    fake.corrupt("session", sid);
    expect(feed.session(sid)!.version).not.toBe(fake.row("session", sid)!.version);
    fake.dropSockets(); // the checksum is asked on each connection
    await until(fake, () => fake.requests.some((r) => r.path === "/feed/mismatch"));
    await converged(fake, feed);
    expect(feed.frames[feed.frames.length - 1].from).toBeNull();
    expect(fake.requests.filter((r) => r.path === "/feed/mismatch").length).toBe(1);
  });

  it("converges while pushed frames are dropped, duplicated and reordered", async () => {
    const { fake, client } = await setup({ chaos: { drop: 0.3, duplicate: 0.3, reorder: 0.3, seed: 7 } });
    const feed = watchFeed(client);
    const sid = await thread(fake, client);
    const events = watchEvents(client, sid);
    for (let i = 0; i < 12; i++) {
      client.mutate("thread.rename", { sid, title: `Title ${i}` });
      fake.agent.mutate(sid, "thread.attention", { sid, what: `Attention ${i}` });
      fake.agent.tool(sid, `step ${i}`);
      if (i % 3 === 0) await fake.idle();
    }
    await until(fake, () => client.pending().get().length === 0);
    // A lost or held frame is noticed at the next one: section 38.3, step 3.
    fake.chaos({});
    fake.agent.mutate(sid, "thread.attention", { sid, what: null });
    fake.agent.endTurn(sid);
    await converged(fake, feed);
    await until(fake, () => events.held.length === fake.events(sid).length);
    expect(events.held).toEqual(fake.events(sid));
    expect(fake.rows("session").find((s) => s.id === sid)!.title).toBe("Title 11");
  });

  it("ignores a server that answers for another principal", async () => {
    const fake = createFakeServer({ seed: "demo" });
    const client = connect(fake, memoryStorage(), { principal: { org: fake.principal.org, subject: "usr_other" } });
    const feed = watchFeed(client);
    await until(fake, () => client.status.get() === "offline");
    await fake.idle();
    expect(feed.frames).toEqual([]);
  });
});

describe("mutations", () => {
  it("is in pending() at once, and leaves it in the step that applies the confirming frame", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const sid = await thread(fake, client);
    await converged(fake, feed);
    let pendingAtFrame = -1;
    client.feed(KINDS).subscribe((f) => {
      if (f.rows.some((r) => r.kind === "session" && r.id === sid && r.title === "Renamed") && pendingAtFrame < 0) pendingAtFrame = client.pending().get().length;
    });
    const m = client.mutate("thread.rename", { sid, title: "Renamed" });
    expect(client.pending().get()).toMatchObject([{ kind: "mutation", name: "thread.rename", args: { sid, title: "Renamed" } }]);
    await m.settled;
    expect(client.pending().get()).toEqual([]);
    expect(pendingAtFrame).toBe(0);
    expect(feed.session(sid)!.title).toBe("Renamed");
    expect(fake.requests.find((r) => r.path === `/work/threads/${sid}/title`)).toMatchObject({ method: "PUT", idem: expect.stringMatching(/^ib_/), status: 200 });
  });

  it("sends a mutation again when the reply is lost, and it is applied once", async () => {
    const { fake, client } = await setup();
    const sid = await thread(fake, client); // nobody reads the feed: only the reply confirms
    fake.chaos({ failAfter: 1 });
    const m = client.mutate("thread.rename", { sid, title: "Once" });
    const title = `/work/threads/${sid}/title`;
    await until(fake, () => fake.requests.some((r) => r.path === title && r.status === 503));
    expect(client.pending().get().length).toBe(1);
    fake.chaos({});
    await m.settled;
    const sent = fake.requests.filter((r) => r.path === title);
    expect(sent.length).toBeGreaterThan(1);
    expect(new Set(sent.map((r) => r.idem)).size).toBe(1);
    expect(sent[sent.length - 1].status).toBe(200);
    expect(fake.rows("op").filter((o) => o.name === "thread.rename").length).toBe(1);
    expect((fake.row("session", sid) as SessionRow).title).toBe("Once");
    expect(client.pending().get()).toEqual([]);
  });

  it("tells failures of a refused mutation and drops its optimistic copy", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const failures: Failure[] = [];
    client.failures.subscribe((f) => failures.push(f));
    const m = client.mutate("thread.rename", { sid: "cs_nosuchsession0000", title: "Nope" });
    await expect(m.settled).rejects.toBeInstanceOf(Refused);
    expect(failures).toMatchObject([{ code: "not_found", entry: { kind: "mutation", name: "thread.rename" } }]);
    expect(client.pending().get()).toEqual([]);
    // The next mutation is applied.
    const sid = await thread(fake, client);
    await client.mutate("thread.rename", { sid, title: "After a refusal" }).settled;
    await converged(fake, feed);
    expect(failures.length).toBe(1);
  });

  it("queues writes made offline and sends them in order afterwards", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const sid = await thread(fake, client);
    await converged(fake, feed);
    fake.setOffline(true);
    await until(fake, () => client.status.get() === "offline");
    const writes = ["One", "Two", "Three"].map((title) => client.mutate("thread.rename", { sid, title }));
    await sleep(5);
    const queued = client.pending().get();
    expect(queued.map((p) => p.kind === "mutation" && p.args.title)).toEqual(["One", "Two", "Three"]);
    const title = `/work/threads/${sid}/title`;
    expect(fake.requests.filter((r) => r.path === title && r.status !== 0)).toEqual([]);
    fake.setOffline(false);
    await Promise.all(writes.map((w) => w.settled));
    expect(fake.requests.filter((r) => r.status === 200 && r.path === title).map((r) => r.idem)).toEqual(queued.map((p) => p.key.slice(p.key.indexOf("-") + 1)));
    expect(client.pending().get()).toEqual([]);
    await converged(fake, feed);
    expect(feed.session(sid)!.title).toBe("Three");
  });

  it("keeps the queue in storage: a second client sends what the first could not", async () => {
    const { fake, client, storage } = await setup();
    const sid = await thread(fake, client);
    fake.setOffline(true);
    client.mutate("thread.rename", { sid, title: "From storage" });
    await sleep(2);
    client.close();
    fake.setOffline(false);
    const again = connect(fake, storage);
    await again.ready;
    expect(again.pending().get()).toMatchObject([{ kind: "mutation", name: "thread.rename" }]);
    await until(fake, () => again.pending().get().length === 0);
    expect((fake.row("session", sid) as SessionRow).title).toBe("From storage");
  });

  it("two tabs on one storage: both writes land, and neither tab's entry overwrites the other's", async () => {
    const fake = createFakeServer({ seed: "empty", autoAgent: false });
    const storage = memoryStorage();
    let chain: Promise<unknown> = Promise.resolve();
    const lock: NonNullable<ClientOptions["lock"]> = (_name, fn) => {
      const r = chain.then(() => fn());
      chain = r.catch(() => {});
      return r as never;
    };
    const a = connect(fake, storage, { lock });
    await a.ready;
    const sid = await thread(fake, a);
    const b = connect(fake, storage, { lock });
    await b.ready;
    watchFeed(a);
    watchFeed(b);
    const failures: Failure[] = [];
    a.failures.subscribe((f) => failures.push(f));
    b.failures.subscribe((f) => failures.push(f));
    fake.setOffline(true);
    const ma = a.mutate("thread.rename", { sid, title: "From tab A" });
    const mb = b.mutate("thread.keep", { sid, keep: true });
    await sleep(2);
    expect((await storage.list("queue/")).length).toBe(2);
    fake.setOffline(false);
    await Promise.all([ma.settled, mb.settled]);
    expect(failures).toEqual([]);
    expect((fake.row("session", sid) as SessionRow).title).toBe("From tab A");
    expect(fake.row("place", sid)).toMatchObject({ keep: true });
  });

  it("a refusal before the server sees the mutation (401 at the edge) fails that one only", async () => {
    const fake = createFakeServer({ seed: "empty", autoAgent: false });
    let deny = false;
    const fetch: ClientOptions["fetch"] = async (path, init) => {
      if (deny && path.startsWith("/work/")) {
        deny = false;
        return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      }
      return fake.fetch(path, init);
    };
    const client = connect(fake, memoryStorage(), { fetch });
    await client.ready;
    const sid = await thread(fake, client);
    deny = true;
    await expect(client.mutate("thread.rename", { sid, title: "Lost to 401" }).settled).rejects.toBeInstanceOf(Refused);
    await Promise.all([1, 2, 3].map((i) => client.mutate("thread.rename", { sid, title: `Later ${i}` }).settled));
    expect((fake.row("session", sid) as SessionRow).title).toBe("Later 3");
  });

  it("holds a write that names a row an earlier queued write creates", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const tid = makeId("trk");
    const track = client.mutate("track.create", { tid, agentSessionId: makeId("cs"), name: "Billing" });
    const s = client.createSession({ input: "Start on the invoices", trackId: tid });
    await Promise.all([track.settled, s.settled]);
    const order = fake.requests.filter((r) => r.method === "POST" && (r.path === "/work/tracks" || r.path === "/sessions")).map((r) => [r.path, r.status]);
    expect(order).toEqual([["/work/tracks", 200], ["/sessions", 201]]);
    await converged(fake, feed);
    expect(feed.rows.get(`place/${s.id}`)).toMatchObject({ trackId: tid });
  });
});

describe("a session", () => {
  it("createSession and a turn: the events arrive in seq order, with the deltas", async () => {
    const { fake, client } = await setup();
    const s = client.createSession({ input: "Say hello" });
    expect(client.pending().get()).toMatchObject([{ kind: "session", sessionId: s.id, body: { input: "Say hello", turnId: s.turnId } }]);
    await s.settled;
    const events = watchEvents(client, s.id);
    const deltas: Delta[] = [];
    client.deltas(s.id).subscribe((d) => deltas.push(d));
    await until(fake, () => events.held.length === 1);
    await sleep(2); // the `sub` for the deltas is on its way
    await fake.idle();
    const text = "Hello. This is the answer, streamed in pieces.";
    await fake.agent.say(s.id, text, { chunk: 7 });
    fake.agent.tool(s.id, "ls");
    fake.agent.endTurn(s.id);
    await until(fake, () => events.held.some((e) => e.type === "turn.completed"));
    expect(events.held).toEqual(fake.events(s.id));
    expect(events.seqs()).toEqual(events.held.map((_, i) => i + 1));
    expect(events.held.map((e) => e.type)).toEqual(["message.received", "message.completed", "tool.started", "tool.completed", "turn.completed"]);
    expect(events.held[0].turnId).toBe(s.turnId);
    expect(deltas.map((d) => d.data.text).join("")).toBe(text);
    expect(deltas.map((d) => d.offset)).toEqual(deltas.map((_, i) => i * 7));
    expect(client.pending().get()).toEqual([]);
  });

  it("send: the turn is pending until its message.received is seen", async () => {
    const { fake, client } = await setup();
    const feed = watchFeed(client);
    const sid = await thread(fake, client);
    const events = watchEvents(client, sid);
    fake.agent.endTurn(sid);
    await until(fake, () => events.held.some((e) => e.type === "turn.completed"));
    const t = client.send(sid, "And another thing");
    expect(client.pending().get()).toMatchObject([{ kind: "turn", sessionId: sid, turnId: t.turnId, input: "And another thing" }]);
    await t.settled;
    await until(fake, () => client.pending().get().length === 0);
    expect(events.held[events.held.length - 1]).toMatchObject({ type: "message.received", turnId: t.turnId });
    await converged(fake, feed);
    expect(feed.session(sid)).toMatchObject({ status: "running", activeTurnId: t.turnId });
  });

  it("answer closes an ask; a write to a session that is not there fails", async () => {
    const { fake, client } = await setup();
    const sid = await thread(fake, client);
    const events = watchEvents(client, sid);
    const askId = fake.agent.ask(sid, { kind: "approval", title: "Run the migration", command: "make migrate" });
    await client.answer(sid, askId, { decision: "allow" }).settled;
    await until(fake, () => events.held.some((e) => e.type === "ask.closed"));
    expect(events.held[events.held.length - 1].data).toMatchObject({ ask: { id: askId, status: "answered" } });
    const failures: Failure[] = [];
    client.failures.subscribe((f) => failures.push(f));
    await expect(client.send("cs_nosuchsession0000", "Anyone?").settled).rejects.toMatchObject({ code: "not_found" });
    expect(failures).toMatchObject([{ code: "not_found", entry: { kind: "turn" } }]);
    expect(client.pending().get()).toEqual([]);
  });

  it("resumes the events by cursor after the sockets drop, with no gap and no duplicate", async () => {
    const { fake, client } = await setup();
    const sid = await thread(fake, client);
    const events = watchEvents(client, sid);
    fake.agent.tool(sid, "before");
    await until(fake, () => events.held.length === 3);
    fake.dropSockets();
    fake.agent.tool(sid, "while away");
    await fake.agent.say(sid, "Said while the socket was down.");
    await until(fake, () => client.status.get() === "online");
    fake.agent.tool(sid, "after");
    fake.agent.endTurn(sid);
    await until(fake, () => events.held.length >= fake.events(sid).length);
    expect(events.seqs()).toEqual(fake.events(sid).map((e) => e.seq));
    expect(events.updates.some((u) => u.reset)).toBe(false);
    // The read after the reconnect asked for what follows the cursor, not for the log again.
    const reads = fake.requests.filter((r) => r.path.startsWith(`/sessions/${sid}/events`));
    expect(reads.filter((r) => r.path.includes("tailTurns")).length).toBe(1);
    expect(reads.some((r) => r.path.includes("after=e1.0.3"))).toBe(true);
  });

  it("recovers from a reset when the log lost its tail", async () => {
    const { fake, client } = await setup();
    const sid = await thread(fake, client);
    const events = watchEvents(client, sid);
    fake.agent.tool(sid, "one");
    fake.agent.tool(sid, "two");
    await until(fake, () => events.held.length === 5);
    fake.loseTail(sid, 2);
    await until(fake, () => events.updates.some((u) => u.reset));
    expect(events.updates.find((u) => u.reset)!.reset).toEqual({ seq: 2 });
    expect(events.seqs()).toEqual([1, 2]);
    const t = client.send(sid, "Carry on from there");
    await until(fake, () => events.held.length === 3);
    fake.agent.endTurn(sid);
    await until(fake, () => events.held.length === 4);
    expect(events.held).toEqual(fake.events(sid));
    expect(events.held[2]).toMatchObject({ seq: 3, type: "message.received", turnId: t.turnId });
  });

  it("recovers when the tail was lost while the client was away", async () => {
    const { fake, client } = await setup();
    const sid = await thread(fake, client);
    const events = watchEvents(client, sid);
    fake.agent.tool(sid, "one");
    await until(fake, () => events.held.length === 3);
    fake.dropSockets();
    fake.loseTail(sid, 1);
    await until(fake, () => events.updates.some((u) => u.reset));
    expect(events.seqs()).toEqual([1]);
    expect(events.held).toEqual(fake.events(sid));
  });

  it("with keepEvents, replays a session's events from storage", async () => {
    const fake = createFakeServer({ seed: "empty", autoAgent: false });
    const storage = memoryStorage();
    const client = connect(fake, storage, { keepEvents: true });
    await client.ready;
    const sid = await thread(fake, client);
    const events = watchEvents(client, sid);
    fake.agent.tool(sid, "one");
    await until(fake, () => events.held.length === 3);
    await sleep(2);
    client.close();
    fake.setOffline(true);
    const again = connect(fake, storage, { keepEvents: true });
    const held = watchEvents(again, sid);
    await until(fake, () => held.updates.length > 0);
    expect(held.held).toEqual(fake.events(sid));
  });
});

describe("the client", () => {
  it("status follows the socket", async () => {
    const { fake, client } = await setup();
    const seen: string[] = [];
    client.status.subscribe((s) => seen.push(s));
    await until(fake, () => client.status.get() === "online");
    fake.setOffline(true);
    await until(fake, () => client.status.get() === "offline");
    fake.setOffline(false);
    await until(fake, () => client.status.get() === "online");
    expect(seen[0]).toBe("online");
    expect(seen).toContain("offline");
    expect(seen[seen.length - 1]).toBe("online");
  });

  it("read answers a body, and throws Refused on an error body", async () => {
    const { fake, client } = await setup({ seed: "demo" });
    const page = await client.read<{ rows: Row[]; next: string | null }>("/work/threads?limit=5");
    expect(page.rows.length).toBeGreaterThan(0);
    await expect(client.read("/work/results/res_nosuch/review")).rejects.toMatchObject({ name: "Refused", code: "not_found" });
    expect(fake.requests.length).toBe(2);
  });

  it("wipe removes everything it stored", async () => {
    const { fake, client, storage } = await setup({ seed: "demo" });
    const feed = watchFeed(client);
    await until(fake, () => feed.frames.length > 0);
    await sleep(2);
    expect((await storage.list("")).length).toBeGreaterThan(1);
    await client.wipe();
    expect(await storage.list("")).toEqual([]);
  });
});
