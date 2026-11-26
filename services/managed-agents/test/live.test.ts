import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { LIVE_SUBPROTOCOL, PRINCIPAL_HEADER, type LiveAttachment, type Principal, type ServerFrame } from "../src/live/contract.js";
import type { LiveDurableObject } from "../src/live/durable-object.js";
import type { FakeComputer, FakeSessionLog } from "./fixtures/live-test-worker.js";

const bindings = env as unknown as {
  LIVE: DurableObjectNamespace<LiveDurableObject>;
  SESSION_LOG: DurableObjectNamespace<FakeSessionLog>;
  COMPUTERS: DurableObjectNamespace<FakeComputer>;
};

const events = (...seqs: number[]): never => seqs.map((seq) => ({ seq })) as never;
const liveOf = (org: string): DurableObjectStub<LiveDurableObject> => bindings.LIVE.getByName(org);

const member = (org: string, over: Partial<Principal> = {}): Principal => ({
  org,
  subject: "user_1",
  kind: "member",
  via: "app",
  scopes: ["sessions:read", "work:read"],
  audiences: ["org", "member:user_1"],
  admin: false,
  credential: { id: "cred_1", expiresAt: null },
  ...over,
});

/** A test client: every frame it was sent, and a way to wait for the next of a kind. */
class Client {
  readonly frames: ServerFrame[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiting: (() => void)[] = [];

  constructor(readonly socket: WebSocket) {
    socket.accept();
    socket.addEventListener("message", (event) => {
      this.frames.push(JSON.parse(event.data as string) as ServerFrame);
      this.wake();
    });
    socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.wake();
    });
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The first frame of this type not yet taken; frames before it stay in `frames`. */
  private taken = 0;
  async next<T extends ServerFrame["t"]>(t: T): Promise<Extract<ServerFrame, { t: T }>> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      for (; this.taken < this.frames.length; this.taken += 1) {
        const frame = this.frames[this.taken]!;
        if (frame.t === t) {
          this.taken += 1;
          return frame as Extract<ServerFrame, { t: T }>;
        }
      }
      if (this.closed) throw new Error(`closed ${this.closed.code} while waiting for ${t}`);
      if (Date.now() > deadline) throw new Error(`no ${t} frame; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  /** A ping the handler answers (the bare one is answered without waking Live), so frames sent before it were handled. */
  async sync(): Promise<void> {
    this.send({ t: "ping", sync: true });
    await this.next("pong");
  }

  async end(): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + 3_000;
    while (!this.closed && Date.now() < deadline) await new Promise<void>((resolve) => { this.waiting.push(resolve); setTimeout(resolve, 100); });
    if (!this.closed) throw new Error("not closed");
    return this.closed;
  }
}

async function upgrade(org: string, principal: Principal | null): Promise<Response> {
  const headers: Record<string, string> = { upgrade: "websocket", "sec-websocket-protocol": LIVE_SUBPROTOCOL };
  if (principal) headers[PRINCIPAL_HEADER] = JSON.stringify(principal);
  return liveOf(org).fetch(new Request("https://live/v3/live", { headers }));
}

async function connect(org: string, principal: Principal = member(org)): Promise<Client> {
  const response = await upgrade(org, principal);
  expect(response.status).toBe(101);
  const client = new Client(response.webSocket!);
  client.send({ t: "hello", protocol: 1 });
  await client.next("ready");
  return client;
}

describe("Live: the socket", () => {
  it("refuses an upgrade without the principal the edge verified", async () => {
    expect((await upgrade("org_auth", null)).status).toBe(401);
    expect((await upgrade("org_auth", { org: "org_auth" } as Principal)).status).toBe(401);
    // A principal of another organization does not reach this one's Live.
    expect((await upgrade("org_auth", member("org_other"))).status).toBe(403);
  });

  it("answers hello with ready, and closes on another protocol", async () => {
    const response = await upgrade("org_hello", member("org_hello"));
    const client = new Client(response.webSocket!);
    client.send({ t: "hello", protocol: 1 });
    const ready = await client.next("ready");
    expect(ready).toMatchObject({ protocol: 1, org: "org_hello", subject: "user_1", expiresAt: null, limits: { sessions: 32, frameBytes: 64_000 } });
    expect(ready.connectionId).toMatch(/^cn_/);
    client.socket.send('{"t":"ping"}');
    await client.next("pong");

    const old = new Client((await upgrade("org_hello", member("org_hello"))).webSocket!);
    old.send({ t: "hello", protocol: 2 });
    expect((await old.end()).code).toBe(4400);
  });
});

describe("Live: the feed", () => {
  it("sends each subscriber the rows of its audiences and the range's version", async () => {
    const live = liveOf("org_feed");
    const mine = await connect("org_feed", member("org_feed"));
    const other = await connect("org_feed", member("org_feed", { subject: "user_2", audiences: ["org", "member:user_2"] }));
    mine.send({ t: "sub", stream: "feed" });
    other.send({ t: "sub", stream: "feed", kinds: ["thread"] });
    expect(await mine.next("subd")).toEqual({ t: "subd", stream: "feed", head: null });
    await other.next("subd");

    const published = await live.publish("feed", {
      from: "f1.4",
      to: "f1.5",
      rows: [
        { kind: "thread", id: "th_1", version: 1, audience: "org", title: "For all" },
        { kind: "thread", id: "th_2", version: 1, audience: "member:user_1", title: "Private" },
        { kind: "track", id: "tr_1", version: 1, audience: "org" },
      ],
      gone: [{ kind: "thread", id: "th_3", audience: "member:user_2" }],
      version: 5,
    });
    expect(published).toEqual({ head: "f1.5" });

    const a = await mine.next("feed");
    expect(a).toMatchObject({ from: "f1.4", to: "f1.5", gone: [], version: 5 });
    expect(a.rows.map((r) => (r as { id: string }).id)).toEqual(["th_1", "th_2", "tr_1"]);
    const b = await other.next("feed");
    expect(b.rows.map((r) => (r as { id: string }).id)).toEqual(["th_1"]);
    expect(b.gone).toEqual([{ kind: "thread", id: "th_3" }]);
    expect(b.version).toBe(5);

    // A range with nothing for a subscriber still reaches it, so it can tell a gap from nothing.
    await live.publish("feed", { from: "f1.5", to: "f1.6", rows: [{ kind: "thread", id: "th_4", version: 1, audience: "member:user_9" }], gone: [], version: 6 });
    expect(await mine.next("feed")).toMatchObject({ from: "f1.5", to: "f1.6", rows: [] });

    // After a reconnect the client resumes by its cursor: Live tells it the head it holds.
    mine.socket.close(1000, "bye");
    const again = await connect("org_feed", member("org_feed"));
    again.send({ t: "sub", stream: "feed", after: "f1.5" });
    expect(await again.next("subd")).toEqual({ t: "subd", stream: "feed", head: "f1.6" });
    await live.publish("feed", { from: "f1.6", to: "f1.7", rows: [], gone: [], version: 7 });
    expect(await again.next("feed")).toMatchObject({ from: "f1.6", to: "f1.7" });
    expect(other.frames.filter((f) => f.t === "feed")).toHaveLength(3);
  });

  it("limits a principal without work:read to the core kinds", async () => {
    const live = liveOf("org_core");
    const client = await connect("org_core", member("org_core", { scopes: ["sessions:read"] }));
    client.send({ t: "sub", stream: "feed", kinds: ["thread", "session"] });
    await client.next("subd");
    await live.publish("feed", {
      from: "f1.1",
      to: "f1.2",
      rows: [{ kind: "thread", id: "th_1", version: 1, audience: "org" }, { kind: "session", id: "cs_1", version: 1, audience: "org" }],
      gone: [],
      version: 2,
    });
    expect((await client.next("feed")).rows).toEqual([{ kind: "session", id: "cs_1", version: 1, audience: "org" }]);
  });

  it("tells subscribers they are behind when a range does not fit a frame", async () => {
    const live = liveOf("org_big");
    const client = await connect("org_big");
    client.send({ t: "sub", stream: "feed" });
    await client.next("subd");
    await live.publish("feed", { from: "f1.1", to: "f1.2", rows: [{ kind: "thread", id: "th_1", version: 1, audience: "org", body: "x".repeat(70_000) }], gone: [], version: 2 });
    expect(await client.next("behind")).toEqual({ t: "behind", stream: "feed", head: "f1.2" });
    await live.publish("feed", { head: "f1.3" });
    expect(await client.next("behind")).toEqual({ t: "behind", stream: "feed", head: "f1.3" });
  });
});

describe("Live: a session", () => {
  it("takes the lease, pushes events and deltas, and resumes by cursor after a reconnect", async () => {
    const org = "org_session";
    const live = liveOf(org);
    const log = bindings.SESSION_LOG.getByName("cs_one");
    await log.set({ head: "e1.1.4" });

    const client = await connect(org);
    client.send({ t: "sub", stream: "events:cs_one", after: "e1.1.4" });
    expect(await client.next("subd")).toEqual({ t: "subd", stream: "events:cs_one", head: "e1.1.4" });
    const [lease] = await log.calls();
    expect(lease!.subject).toBe("user_1");
    expect(lease!.until - Date.now()).toBeGreaterThan(25_000);

    await live.publish("events:cs_one", { from: "e1.1.4", to: "e1.1.6", events: events(5, 6) });
    expect(await client.next("events")).toEqual({ t: "events", session: "cs_one", from: "e1.1.4", to: "e1.1.6", events: events(5, 6) });

    await log.set({ head: "e1.1.6" });
    client.send({ t: "sub", stream: "deltas:cs_one" });
    expect(await client.next("subd")).toEqual({ t: "subd", stream: "deltas:cs_one", head: "e1.1.6" });
    await live.publish("deltas:cs_one", {
      epoch: 1,
      deltas: [
        { type: "text", turnId: "tn_1", data: { blockId: "b1", text: "Hel" }, offset: 0 },
        { type: "text", turnId: "tn_1", data: { blockId: "b1", text: "Hello" }, offset: 0, whole: true },
      ],
    });
    expect(await client.next("delta")).toEqual({ t: "delta", session: "cs_one", type: "text", turnId: "tn_1", data: { blockId: "b1", text: "Hel" }, offset: 0 });
    expect(await client.next("delta")).toMatchObject({ whole: true });
    client.send({ t: "block", session: "cs_one", blockId: "b1" });
    // The organization's first machine is named by the organization.
    await expect.poll(() => bindings.COMPUTERS.getByName(org).calls()).toEqual([
      { call: "watch", sessionId: "cs_one" },
      { call: "block", sessionId: "cs_one", blockId: "b1" },
    ]);

    // The socket drops; two more events are appended while the client is away.
    client.socket.close(1000, "bye");
    await log.set({ head: "e1.1.8" });
    const again = await connect(org);
    again.send({ t: "sub", stream: "events:cs_one", after: "e1.1.6" });
    // The head is past the client's cursor: it reads the gap over HTTP, then the pushes continue.
    expect(await again.next("subd")).toEqual({ t: "subd", stream: "events:cs_one", head: "e1.1.8" });
    await live.publish("events:cs_one", { from: "e1.1.8", to: "e1.1.9", events: events(9) });
    expect(await again.next("events")).toMatchObject({ from: "e1.1.8", to: "e1.1.9" });
    expect(client.frames.filter((f) => f.t === "events")).toHaveLength(1);

    again.send({ t: "unsub", stream: "events:cs_one" });
    await again.sync();
    await live.publish("events:cs_one", { from: "e1.1.9", to: "e1.1.10", events: events(10) });
    await again.sync();
    expect(again.frames.filter((f) => f.t === "events")).toHaveLength(1);
  });

  it("answers reset to a cursor it cannot read", async () => {
    const client = await connect("org_reset");
    client.send({ t: "sub", stream: "events:cs_reset", after: "41" });
    expect(await client.next("reset")).toEqual({ t: "reset", stream: "events:cs_reset", cursor: null });
    client.send({ t: "sub", stream: "feed", after: "e1.1.4" });
    expect(await client.next("reset")).toEqual({ t: "reset", stream: "feed", cursor: null });
    expect(await bindings.SESSION_LOG.getByName("cs_reset").calls()).toEqual([]);
  });

  it("detaches a subscriber the session refuses, at once and at a renewal", async () => {
    const org = "org_refused";
    const live = liveOf(org);
    const log = bindings.SESSION_LOG.getByName("cs_refused");
    await log.set({ allowed: false });
    const client = await connect(org);
    client.send({ t: "sub", stream: "events:cs_refused" });
    expect(await client.next("detached")).toEqual({ t: "detached", stream: "events:cs_refused", reason: "forbidden" });

    await log.set({ allowed: true });
    client.send({ t: "sub", stream: "events:cs_refused" });
    await client.next("subd");
    // The lease is renewed by the alarm, as each subscriber: one who lost the session stops receiving it.
    expect(await runDurableObjectAlarm(live)).toBe(true);
    expect((await log.calls()).length).toBe(3);
    await log.set({ allowed: false });
    expect(await runDurableObjectAlarm(live)).toBe(true);
    expect(await client.next("detached")).toEqual({ t: "detached", stream: "events:cs_refused", reason: "forbidden" });
    await live.publish("events:cs_refused", { from: "e1.1.0", to: "e1.1.1", events: events(1) });
    await client.sync();
    expect(client.frames.filter((f) => f.t === "events")).toHaveLength(0);
  });

  it("watches at most 32 sessions on one connection", async () => {
    const client = await connect("org_cap");
    for (let i = 0; i < 32; i += 1) client.send({ t: "sub", stream: `events:cs_cap_${String(i).padStart(22, "0")}` });
    for (let i = 0; i < 32; i += 1) await client.next("subd");
    client.send({ t: "sub", stream: "events:cs_cap_one_too_many" });
    expect(await client.next("error")).toMatchObject({ code: "too_many_subscriptions" });
    // A second stream of a session already watched is not another session.
    client.send({ t: "sub", stream: `deltas:cs_cap_${"0".repeat(22)}` });
    await client.next("subd");
  });
});

describe("Live: wait and revoke", () => {
  it("releases a long-poll when the stream moves, and answers at the timeout otherwise", async () => {
    const org = "org_wait";
    const live = liveOf(org);
    await bindings.SESSION_LOG.getByName("cs_wait").set({ head: "e1.1.2" });
    expect(await live.wait(member(org), "events:cs_wait", "e1.1.1", 1_000)).toEqual({ moved: true, head: "e1.1.2" });
    expect(await live.wait(member(org), "events:cs_wait", "e1.1.2", 50)).toEqual({ moved: false, head: "e1.1.2" });

    const waiting = live.wait(member(org), "events:cs_wait", "e1.1.2", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await live.publish("events:cs_wait", { from: "e1.1.2", to: "e1.1.3", events: events(3) });
    expect(await waiting).toEqual({ moved: true, head: "e1.1.3" });

    const feed = live.wait(member(org), "feed", "f1.1", 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await live.publish("feed", { from: "f1.1", to: "f1.2", rows: [], gone: [], version: 2 });
    expect(await feed).toEqual({ moved: true, head: "f1.2" });

    await bindings.SESSION_LOG.getByName("cs_wait_no").set({ allowed: false });
    expect(await live.wait(member(org), "events:cs_wait_no", "e1.1.0", 1_000)).toEqual({ moved: false, head: null });
  });

  it("closes the sockets of a revoked credential, by revoke and by the periodic check", async () => {
    const org = "org_revoke";
    const live = liveOf(org);
    const kept = await connect(org);
    const revoked = await connect(org, member(org, { credential: { id: "cred_2", expiresAt: null } }));
    await live.revoke("cred_2");
    expect(await revoked.end()).toMatchObject({ code: 4001 });
    await kept.sync();

    // The edge is asked about every credential older than five minutes; this one it calls revoked.
    const stale = await connect(org, member(org, { credential: { id: "cred_revoked", expiresAt: null } }));
    await runInDurableObject(live, (instance) => {
      for (const a of (instance as unknown as { sockets: Map<WebSocket, LiveAttachment> }).sockets.values()) a.v -= 6 * 60;
    });
    await runDurableObjectAlarm(live);
    expect(await stale.end()).toMatchObject({ code: 4001 });
    await kept.sync();

    const expiring = await connect(org, member(org, { credential: { id: "cred_3", expiresAt: Date.now() + 300 } }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await runDurableObjectAlarm(live);
    expect(await expiring.end()).toMatchObject({ code: 4001 });
  });

  it("renews a credential on auth, and closes when the principal differs", async () => {
    const org = "org_a";
    const client = await connect(org, member(org, { credential: { id: "cred_4", expiresAt: Date.now() + 60_000 } }));
    client.send({ t: "auth", token: "renewed" });
    const credentials = (): Promise<string[]> =>
      runInDurableObject(liveOf(org), (_, state) => state.getWebSockets().map((s) => (s.deserializeAttachment() as LiveAttachment).p.cred));
    await expect.poll(credentials).toEqual(["cred_renewed"]);
    await liveOf(org).revoke("cred_4");
    await client.sync();
    client.send({ t: "auth", token: "other" });
    expect(await client.end()).toMatchObject({ code: 4003 });
  });
});
