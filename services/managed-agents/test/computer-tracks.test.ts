import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { DeliveredOutcome, InboxEntry } from "../src/actors/session-log/contract.js";
import type { ComputerDurableObject } from "../src/actors/computer/durable-object.js";
import { hostToken } from "../src/actors/computer/host-link/host-token.js";
import { linkSlack } from "./fixtures/computer-link.js";

/**
 * Tracks and threads, the Computer actor (spec 36.3, 40.2, 40.5): `start` and `drain` against a fake
 * SessionLog and a fake host on protocol 6, deltas to a fake Live.
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
  /** Billing's answer beyond `admitted`: a refusal's plan and halt reason, an admission's warning. */
  onPro: boolean;
  haltReason: string | null;
  warning: { reason: string; since: number | null } | null;
  /** What Slack was owed (`billing`), and what it answers. */
  billing: any[];
  told: "shown" | "known" | "missed";
  events: [string, unknown][];
  wakes: number;
}

/** An organization's Computer with fake actors around it; no host yet. */
async function computer(org: string): Promise<{ stub: Stub; fakes: Fakes }> {
  const stub = computers().getByName(org);
  await linkSlack(stub, org, { teamId: `T${org}`, teamName: "Tracks", botUserId: "UBOT", botToken: "xoxb-tracks-token" });
  const fakes: Fakes = { entries: [], delivered: [], published: [], admitted: true, refused: false, onPro: false, haltReason: null, warning: null, billing: [], told: "shown", events: [], wakes: 0 };
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
    instance.actors.org = () => ({ forHost: async () => ({ sessions: [], admins: [], knowledge: null }), acceptMachine: async () => ({ accepted: true }) });
    instance.actors.slack = () => ({
      forHost: async () => ({ people: [], slack: null }),
      import: async () => undefined,
      billing: async (n: unknown) => (fakes.billing.push(n), fakes.told),
    });
    instance.admission = async () =>
      fakes.admitted ? { deliver: true, ...(fakes.warning ? { warning: fakes.warning } : {}) } : { deliver: false, onPro: fakes.onPro, haltReason: fakes.haltReason };
    instance.wakeForApi = async () => void fakes.wakes++;
    // The billing funnel's events, as emitted (calvin_events is off in tests).
    const within = instance.telemetry.within.bind(instance.telemetry);
    instance.telemetry.within = (t: unknown, fn: (t: any) => Promise<unknown>) =>
      within(t, (gt: any) => {
        const emit = gt.emit.bind(gt);
        gt.emit = (name: string, fields: unknown) => (name.startsWith("billing.") && fakes.events.push([name, fields]), emit(name, fields));
        return fn(gt);
      });
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

/** A session started from a Slack thread of the organization's workspace (`T<org>`, as computer() links it). */
function slackSpec(org: string, id: string) {
  const start = spec(org, id) as any;
  start.session.owner = { id: `slack:T${org}:U1`, name: "Ada", email: null };
  start.session.origin = { type: "slack", client: null, slack: { teamId: `T${org}`, channelId: "C1", channelName: null, threadTs: "1.2", url: "https://slack.test/t" } };
  return start as never;
}

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
    await stub.drain(SESSION(1));
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
    // No runner row, no drain.
    fakes.entries = [entry("in_3")];
    await stub.drain(SESSION(9));
    expect(fakes.delivered).toHaveLength(2);
  });

  it("a turn entry's id is the turnId the host is sent (spec 40.2): one id from the inbox to the log", async () => {
    const { stub, fakes } = await computer("tt-turn-id");
    const { frames } = await host("tt-turn-id");
    const turn = "tn_0123456789ab";
    fakes.entries = [entry(turn, "turn", { input: "go", ifBusy: "queue" }), entry("ie_0123456789abcdef", "interrupt", {})];
    await stub.start(spec("tt-turn-id", SESSION(1)));
    await stub.drain(SESSION(1));
    await until(() => fakes.delivered, (all) => all.length === 2, "delivered");
    const api = frames.filter((frame) => frame.t === "api");
    expect(api[0]).toMatchObject({ method: "turns.send", idempotencyKey: turn, params: { input: "go", ifBusy: "queue", turnId: turn } });
    expect(api[1]!.params).toEqual({ sessionId: SESSION(1) });
  });

  it("takes the drain with no host, owes it, and drains at hello", async () => {
    const { stub, fakes } = await computer("tt-waking");
    fakes.entries = [entry("in_1")];
    await stub.start(spec("tt-waking", SESSION(1)));
    await stub.drain(SESSION(1));
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
    await stub.drain(SESSION(1));
    fakes.admitted = true;
    fakes.refused = true;
    fakes.entries = [entry("in_2")];
    await stub.drain(SESSION(1));
    expect(fakes.delivered.map((d) => [d.id, d.outcome.ok === false && d.outcome.code])).toEqual([["in_1", "insufficient_credits"], ["in_2", "model_refused"]]);
    expect(frames.filter((frame) => frame.t === "api")).toEqual([]);
  });

  it("an organization out of credits: the turn is refused before the computer wakes, and its Slack thread owed the paywall with plan and halt reason", async () => {
    const { stub, fakes } = await computer("tt-paywall");
    await stub.start(slackSpec("tt-paywall", SESSION(1)));
    fakes.admitted = false;
    fakes.onPro = true;
    fakes.haltReason = "payment";
    fakes.entries = [entry("in_1")];
    await stub.drain(SESSION(1));
    await until(() => fakes.events, (all) => all.length > 0, "paywall measured");
    expect(fakes.delivered.map((d) => [d.id, d.outcome.ok === false && d.outcome.code])).toEqual([["in_1", "insufficient_credits"]]);
    expect(fakes.wakes).toBe(0);
    expect(fakes.billing).toEqual([{ kind: "paywall", sessionId: SESSION(1), onPro: true, haltReason: "payment" }]);
    expect(fakes.events).toEqual([["billing.paywall_shown", { data: { reason: "payment", surface: "slack" } }]]);
  });

  it("admitted again: Slack is owed `admitted` once, and a standing warning once per reason and run", async () => {
    const { stub, fakes } = await computer("tt-admitted");
    await stub.start(slackSpec("tt-admitted", SESSION(1)));
    fakes.admitted = false;
    fakes.entries = [entry("in_1")];
    await stub.drain(SESSION(1));
    await until(() => fakes.billing, (all) => all.length === 1, "paywall owed");
    fakes.admitted = true;
    fakes.warning = { reason: "credits_low", since: 5 };
    fakes.entries = [entry("in_2")];
    await stub.drain(SESSION(1));
    await until(() => fakes.billing, (all) => all.length === 3, "admitted and warning owed");
    fakes.entries = [entry("in_3")];
    await stub.drain(SESSION(1));
    fakes.warning = { reason: "credits_low", since: 9 };
    fakes.entries = [entry("in_4")];
    await stub.drain(SESSION(1));
    await until(() => fakes.billing, (all) => all.length === 4, "the new run's warning owed");
    await sleep(50);
    expect(fakes.billing).toEqual([
      { kind: "paywall", sessionId: SESSION(1), onPro: false, haltReason: null },
      { kind: "admitted" },
      { kind: "warning", reason: "credits_low", since: 5, sessionId: SESSION(1) },
      { kind: "warning", reason: "credits_low", since: 9, sessionId: SESSION(1) },
    ]);
    expect(fakes.events.filter(([name]) => name === "billing.warning_shown")).toEqual([
      ["billing.warning_shown", { data: { reason: "credits_low", surface: "slack" } }],
      ["billing.warning_shown", { data: { reason: "credits_low", surface: "slack" } }],
    ]);
    expect(fakes.wakes).toBeGreaterThan(0);
  });

  it("a warning Slack could not tell anyone is owed again on the next turn; an API session hears no paywall", async () => {
    const { stub, fakes } = await computer("tt-missed");
    await stub.start(spec("tt-missed", SESSION(1)));
    fakes.warning = { reason: "trial_days", since: null };
    fakes.told = "missed";
    fakes.entries = [entry("in_1")];
    await stub.drain(SESSION(1));
    await until(() => fakes.billing, (all) => all.length === 1, "warning owed");
    await sleep(20);
    fakes.told = "shown";
    fakes.entries = [entry("in_2")];
    await stub.drain(SESSION(1));
    await until(() => fakes.billing, (all) => all.length === 2, "warning owed again");
    fakes.admitted = false;
    fakes.entries = [entry("in_3")];
    await stub.drain(SESSION(1));
    await sleep(50);
    expect(fakes.billing.map((n) => n.kind)).toEqual(["warning", "warning"]);
    expect(fakes.events.map(([name]) => name)).toEqual(["billing.warning_shown"]);
  });

  it("a turn the model provider refused for credits owes its thread the paywall", async () => {
    const { stub, fakes } = await computer("tt-midturn");
    await stub.start(slackSpec("tt-midturn", SESSION(1)));
    await inside(stub, (instance) => instance.outOfCredits("Ttt-midturn:C1:1.2"));
    await until(() => fakes.billing, (all) => all.length === 1, "paywall owed");
    expect(fakes.billing).toEqual([{ kind: "paywall", sessionId: SESSION(1), onPro: false, haltReason: null }]);
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

  it("takes the Slack actor's interactions as the presser, and forgets a person who left", async () => {
    const { stub } = await computer("tt-interact");
    await inside(stub, (instance) => {
      instance.put("slackSeen", "1");
      instance.put("slackLinked", "T0INTERACT");
      instance.seen = [];
      instance.secrets.open = async (actionId: string, triggerId: string, where: unknown) => void instance.seen.push({ actionId, triggerId, where });
      instance.secrets.submit = async (_view: unknown, userId: string) => ({ errors: { name: `no, ${userId}` } });
      instance.access.models.memberRemoved = async (userId: string) => void instance.seen.push({ left: userId });
    });
    const p = { org: "tt-interact", subject: "slack:T0INTERACT:U1", kind: "member", via: "slack", scopes: [], audiences: [], admin: false, credential: { id: "slack:T0INTERACT:U1", expiresAt: null } };
    const from = { user: { id: "U1" }, team: { id: "T0INTERACT" } };
    expect(await stub.interaction(p as never, { interaction: { ...from, type: "block_actions", trigger_id: "trig", actions: [{ action_id: "s:abc" }], channel: { id: "C1" } } })).toEqual({});
    expect(await stub.interaction(p as never, { interaction: { ...from, type: "view_submission", view: { callback_id: "secret" } } })).toEqual({ errors: { name: "no, U1" } });
    // Another workspace's interaction is not this Computer's.
    expect(await stub.interaction(p as never, { interaction: { ...from, team: { id: "T0OTHER" }, type: "view_submission", view: { callback_id: "secret" } } })).toEqual({});
    await stub.memberLeft("U1");
    expect(await inside(stub, (instance) => instance.seen)).toEqual([{ actionId: "s:abc", triggerId: "trig", where: { userId: "U1", channelId: "C1" } }, { left: "U1" }]);
  });

  it("hands the Slack actor its old install once: settings, people and links", async () => {
    const { stub } = await computer("tt-carry");
    await linkSlack(stub, "tt-carry", { teamId: "T1", teamName: "Acme", botUserId: "UBOT", botToken: "xoxb-old" });
    await inside(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES ('U1', 'ann', 'Ann', 'ann@example.com', 1)");
    });
    const carry = await stub.slackCarry();
    expect(Object.keys(carry.settings).sort()).toEqual(["slackBotToken", "slackBotUserId", "slackTeamId", "slackTeamName"]);
    expect(carry.settings.slackBotToken).not.toBe("xoxb-old");
    expect(carry.people).toEqual([{ slack_user_id: "U1", dir: "ann", git_name: "Ann", git_email: "ann@example.com", updated_at: 1 }]);
    expect(carry.links).toEqual([]);
  });

  it("hands Org the default access it held, once read, null where it held none", async () => {
    const { stub } = await computer("tt-access-carry");
    expect(await stub.accessCarry()).toEqual({ accessDefault: null, apiAccessDefault: null });
    await inside(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('accessDefault', 'owner'), ('apiAccessDefault', 'org')");
    });
    expect(await stub.accessCarry()).toEqual({ accessDefault: "owner", apiAccessDefault: "org" });
  });
});
