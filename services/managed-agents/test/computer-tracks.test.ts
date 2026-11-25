import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { DeliveredOutcome, ExportedSession, InboxEntry } from "../src/actor/contracts.js";
import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";

/**
 * Tracks and threads, the Computer actor (spec 36.3, 40.2, 40.5): `start` and `drain` against a fake
 * SessionLog and a fake host on protocol 6, deltas to a fake Live, the export Org adopts from.
 * Each test has its own organization.
 */

const ORIGIN = "https://managedagents.test";
const KEY = "test-computer-host-token-key";

type Stub = DurableObjectStub<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error(`${what} not reached`);
}

interface Fakes {
  entries: InboxEntry[];
  delivered: { id: string; outcome: DeliveredOutcome }[];
  published: { stream: string; frame: any }[];
  admitted: boolean;
  refused: boolean;
}

/** An organization's Computer with fake actors around it; no host yet. */
async function computer(org: string): Promise<{ stub: Stub; fakes: Fakes }> {
  const stub = computers().getByName(org);
  await stub.linkSlack(org, { teamId: `T${org}`, teamName: "Tracks", botUserId: "UBOT", botToken: "xoxb-tracks-token" });
  const fakes: Fakes = { entries: [], delivered: [], published: [], admitted: true, refused: false };
  await inside(stub, (instance) => {
    const log = {
      inbox: async () => ({ entries: fakes.entries.slice(), epoch: 3, lastSeq: 7 }),
      delivered: async (id: string, outcome: DeliveredOutcome) => {
        fakes.delivered.push({ id, outcome });
        fakes.entries = fakes.entries.filter((entry) => entry.id !== id);
      },
      epochTail: async () => null,
    };
    instance.actors.log = () => log;
    instance.actors.live = () => ({ publish: async (stream: string, frame: unknown) => (fakes.published.push({ stream, frame }), { head: "1" }) });
    instance.actors.org = () => ({ forHost: async () => ({ sessions: [], admins: [], knowledge: null }), acceptMachine: async () => ({ accepted: true }), adopt: async () => undefined });
    instance.actors.slack = () => ({ forHost: async () => ({ people: [], slack: null }), import: async () => undefined });
    instance.admitForApi = async () => fakes.admitted;
    instance.wakeForApi = async () => undefined;
    instance.api.deps.routeSession = async (session: unknown) =>
      fakes.refused
        ? { session, refused: true, error: { code: "model_unavailable", message: "No subscription.", status: 409, retryable: false } }
        : { session, model: { mode: "managed" } };
  });
  return { stub, fakes };
}

/** A fake host: says hello at `protocol`, collects frames, answers each `api` frame. */
async function host(org: string, protocol = 6): Promise<{ frames: any[]; socket: WebSocket; closed: Promise<number> }> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames: any[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    frames.push(frame);
    if (frame.t === "api") socket.send(JSON.stringify({ t: "api-result", id: frame.id, result: { accepted: frame.idempotencyKey } }));
    if (frame.t === "start") socket.send(JSON.stringify({ t: "started", id: frame.id, sessionId: frame.session.sessionId, status: "idle" }));
  });
  socket.send(JSON.stringify({ t: "hello", protocol, hostId: org, version: "test", sessions: [] }));
  if (protocol >= 6) await until(() => frames, (all) => all.some((frame) => frame.t === "welcome"), "welcome");
  return { frames, socket, closed };
}

function spec(org: string, id: string, role: unknown = null) {
  const now = new Date().toISOString();
  return {
    session: {
      id,
      title: "A thread",
      status: "idle",
      archived: false,
      owner: { id: "usr_01hzy3v8k2m4n6p8q0r2s4t6v8", name: "Ada", email: "ada@example.com" },
      origin: { type: "api", client: null, slack: null },
      settings: { model: null, effort: null, mode: "auto", speed: null },
      metadata: {},
      machine: org,
      role: null,
      createdAt: now,
      lastActiveAt: now,
    },
    settings: { model: null, effort: null, mode: "auto", speed: null },
    role,
  } as never;
}

const entry = (id: string, kind: InboxEntry["kind"] = "turn", body: unknown = { input: "go", turnId: `turn_${id}` }): InboxEntry => ({
  id,
  kind,
  body,
  by: "user:usr_01hzy3v8k2m4n6p8q0r2s4t6v8",
  actor: { subject: "usr_01hzy3v8k2m4n6p8q0r2s4t6v8", kind: "member", via: "api", admin: false },
  trace: "req_1",
  at: Date.now(),
});

const SESSION = (n: number) => `cs_${String(n).padStart(26, "0")}`;

describe("the Computer actor of tracks and threads", () => {
  it("closes a host on protocol 5 with 4426", async () => {
    await computer("tt-old-host");
    const { closed, frames } = await host("tt-old-host", 5);
    expect(await closed).toBe(4426);
    expect(frames.some((frame) => frame.t === "welcome")).toBe(false);
  });

  it("starts a session with nothing waiting by a start frame carrying its role", async () => {
    const { stub } = await computer("tt-start");
    const { frames } = await host("tt-start");
    await stub.start(spec("tt-start", SESSION(1), { name: "track", trackId: "trk_1" }));
    const start = await until(() => frames.find((frame) => frame.t === "start"), (frame) => !!frame, "start frame");
    expect(start).toMatchObject({ epoch: 3, lastSeq: 7, role: { name: "track", trackId: "trk_1" }, session: { sessionId: SESSION(1), kind: "api", role: { name: "track", trackId: "trk_1" } } });
  });

  it("drains an inbox entry as an api frame keyed by the entry's id and reports it delivered", async () => {
    const { stub, fakes } = await computer("tt-drain");
    const { frames } = await host("tt-drain");
    fakes.entries = [entry("in_1"), entry("in_2", "interrupt", {})];
    await stub.start(spec("tt-drain", SESSION(1)));
    const result = await stub.drain(SESSION(1), { wait: true });
    await until(() => fakes.delivered, (all) => all.length === 2, "delivered");
    const api = frames.filter((frame) => frame.t === "api");
    expect(api.map((frame) => [frame.method, frame.idempotencyKey])).toEqual([["turns.send", "in_1"], ["sessions.interrupt", "in_2"]]);
    expect(api[0]).toMatchObject({
      sessionId: SESSION(1),
      params: { sessionId: SESSION(1), input: "go", turnId: "turn_in_1" },
      member: "usr_01hzy3v8k2m4n6p8q0r2s4t6v8",
      epoch: 3,
      lastSeq: 7,
      model: { mode: "managed" },
      session: { sessionId: SESSION(1) },
    });
    expect(fakes.delivered).toEqual([
      { id: "in_1", outcome: { ok: true, result: { accepted: "in_1" } } },
      { id: "in_2", outcome: { ok: true, result: { accepted: "in_2" } } },
    ]);
    expect(result.state).toBe("delivered");
    // No runner row, no drain.
    fakes.entries = [entry("in_3")];
    expect(await stub.drain(SESSION(9), { wait: true })).toEqual({ state: "delivered", results: [] });
    expect(fakes.delivered).toHaveLength(2);
  });

  it("answers waking with no host and drains at hello", async () => {
    const { stub, fakes } = await computer("tt-waking");
    fakes.entries = [entry("in_1")];
    await stub.start(spec("tt-waking", SESSION(1)));
    expect(await stub.drain(SESSION(1), { wait: true })).toEqual({ state: "waking" });
    expect(fakes.delivered).toEqual([]);
    const { frames } = await host("tt-waking");
    await until(() => fakes.delivered, (all) => all.length === 1, "delivered at hello");
    expect(frames.filter((frame) => frame.t === "api").map((frame) => frame.idempotencyKey)).toEqual(["in_1"]);
    expect(fakes.delivered[0]).toEqual({ id: "in_1", outcome: { ok: true, result: { accepted: "in_1" } } });
  });

  it("reports no credits and a refused model route by their codes, sending nothing", async () => {
    const { stub, fakes } = await computer("tt-refused");
    const { frames } = await host("tt-refused");
    await stub.start(spec("tt-refused", SESSION(1)));
    await until(() => frames, (all) => all.some((frame) => frame.t === "start"), "start frame");
    fakes.admitted = false;
    fakes.entries = [entry("in_1")];
    const broke = await stub.drain(SESSION(1), { wait: true });
    expect(broke).toMatchObject({ state: "delivered", results: [{ id: "in_1", error: { code: "insufficient_credits" } }] });
    fakes.admitted = true;
    fakes.refused = true;
    fakes.entries = [entry("in_2")];
    const refused = await stub.drain(SESSION(1), { wait: true });
    expect(refused).toMatchObject({ state: "delivered", results: [{ id: "in_2", error: { code: "model_refused" } }] });
    expect(fakes.delivered.map((d) => [d.id, d.outcome.ok === false && d.outcome.code])).toEqual([["in_1", "insufficient_credits"], ["in_2", "model_refused"]]);
    expect(frames.filter((frame) => frame.t === "api")).toEqual([]);
  });

  it("forwards deltas to Live only for a session with a runner row, and relays watch and block", async () => {
    const { stub, fakes } = await computer("tt-delta");
    const { frames, socket } = await host("tt-delta");
    await stub.start(spec("tt-delta", SESSION(1)));
    const deltas = [{ type: "text", turnId: "turn_1", data: "he", offset: 0 }];
    socket.send(JSON.stringify({ t: "delta", sessionId: SESSION(2), epoch: 3, deltas }));
    socket.send(JSON.stringify({ t: "delta", sessionId: SESSION(1), epoch: 3, deltas }));
    await until(() => fakes.published, (all) => all.length > 0, "delta published");
    await sleep(50);
    expect(fakes.published).toEqual([{ stream: `deltas:${SESSION(1)}`, frame: { epoch: 3, deltas } }]);
    const lease = Date.now() + 60_000;
    await stub.watch(SESSION(1), lease);
    await stub.watch(SESSION(1), Date.now() - 1);
    await stub.watch(SESSION(2), lease);
    await stub.block(SESSION(1), "blk_1");
    await until(() => frames, (all) => all.some((frame) => frame.t === "block"), "block frame");
    expect(frames.filter((frame) => frame.t === "watch")).toEqual([{ t: "watch", sessionId: SESSION(1), until: lease }]);
    expect(frames.filter((frame) => frame.t === "block")).toEqual([{ t: "block", sessionId: SESSION(1), blockId: "blk_1" }]);
  });

  it("exports its sessions in pages, minting an id for a row that has none", async () => {
    const { stub } = await computer("tt-export");
    for (const n of [1, 2, 3]) await stub.start(spec("tt-export", SESSION(n)));
    await inside(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, created_at, updated_at) VALUES ('T1:C1:1.0', 'T1', 'C1', '1.0', 'U1', 'Old thread', 1, 1)",
      );
    });
    const page = (after: string | null, limit: number) =>
      stub.exportSessions(after, limit) as unknown as Promise<{ rows: ExportedSession[]; next: string | null; newestCreatedAt: number }>;
    const first = await page(null, 2);
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]).toMatchObject({ title: "Old thread", owner: "slack:T1:U1", slackThreadKey: "T1:C1:1.0", origin: { type: "slack" } });
    expect(first.rows[0]!.id).toMatch(/^cs_/);
    expect(first.next).not.toBeNull();
    const second = await page(first.next, 2);
    expect(second.rows).toHaveLength(2);
    expect(second.next).toBeNull();
    expect([first.rows[1]!.id, ...second.rows.map((row) => row.id)].sort()).toEqual([SESSION(1), SESSION(2), SESSION(3)]);
    expect(second.newestCreatedAt).toBeGreaterThan(1);
    // The minted id is kept.
    expect((await page(null, 1)).rows[0]!.id).toBe(first.rows[0]!.id);
  });
});
