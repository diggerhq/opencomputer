import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { driversCommandText, onlyMembersText, stateText, stoppedText } from "../src/computer/access.js";
import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";
import { SLACK_BOT_TOKEN } from "./fixtures/computer-fakes.mjs";

/**
 * Session roles at the computer's seams (work 112): `process` gates a message
 * in an existing session, `!access` is the gateway's, `slackStop` takes the
 * user, spawn copies `drivers`. The rules themselves are
 * computer-access-flow.test.ts's. The fake Slack's people (computer-fakes.mjs)
 * are full members of this test's workspace except UGUEST, a guest.
 */

const ORIGIN = "https://managedagents.test";
const SIGNING_SECRET = "computer-signing-secret";
const HOST_KEY = "test-computer-host-token-key";
const TS = "1700000000.000100";

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS;

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never: ${what}`);
}

async function signed(path: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const signature = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body,
  });
}

/** A linked organization with a connected host and one session UADA started in C1; this object's Slack calls recorded. */
async function withSession(org: string, team: string) {
  const computer = computers().getByName(org);
  // The outbound fake's call log is shared with files running in parallel: observe this object's own calls.
  // Its people are of workspace T0ACME; here they are of this test's.
  await runInDurableObject(computer, ((instance: any) => {
    instance.accessTestCalls = [];
    const slack = instance.slack.bind(instance);
    instance.slack = async (method: string, body: Record<string, unknown>) => {
      instance.accessTestCalls.push({ method, body });
      const result = await slack(method, body);
      return method === "users.info" && result.user ? { ...result, user: { ...result.user, team_id: team } } : result;
    };
  }) as never);
  const calls = () => runInDurableObject(computer, ((instance: any) => instance.accessTestCalls) as never) as Promise<Array<{ method: string; body: Record<string, any> }>>;
  await computers().getByName(`computer-slack-team:${team}`).claimTeam(team, org);
  await computer.linkSlack(org, { teamId: team, teamName: "Roles", botUserId: "UBOT", botToken: SLACK_BOT_TOKEN });
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(HOST_KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames: any[] = [];
  socket.addEventListener("message", (event: MessageEvent) => void frames.push(JSON.parse(String(event.data))));
  socket.send(JSON.stringify({ t: "hello", protocol: 6, hostId: org, version: "host-1", sessions: [] }));
  await until(() => frames, (all) => all.some((frame) => frame.t === "welcome"), "welcome");

  let n = 0;
  /** A message event, and the queue run that follows it. */
  const post = async (user: string, text: string, o: { mention?: boolean; threadTs?: string } = {}) => {
    const ts = o.threadTs === undefined ? TS : `1700000000.${String(200 + n).padStart(6, "0")}`;
    const event = {
      type: "event_callback",
      event_id: `Ev-${org}-${n++}`,
      team_id: team,
      event: { type: o.mention ? "app_mention" : "message", channel: "C1", user, text: o.mention ? `<@UBOT> ${text}` : text, ts, ...(o.threadTs ? { thread_ts: o.threadTs } : {}) },
    };
    expect((await signed("/v1/webhooks/computer/slack/events", JSON.stringify(event))).status).toBe(200);
    await runInDurableObject(computer, (_instance, state: DurableObjectState) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
    await runDurableObjectAlarm(computer);
    return ts;
  };
  const delivered = (ts: string) => until(() => frames.find((frame) => frame.t === "deliver" && frame.msg.ts === ts), (found) => !!found, `the delivery of ${ts}`);
  const say = (user: string, text: string, o: { mention?: boolean } = {}) => post(user, text, { ...o, threadTs: TS });
  const key = `${team}:C1:${TS}`;
  const first = await delivered(await post("UADA", "plan the work", { mention: true }));
  const drivers = () =>
    runInDurableObject(computer, (_instance, state: DurableObjectState) => [...state.storage.sql.exec<{ d: string }>("SELECT drivers AS d FROM sessions WHERE runner_key = ?", key)][0]?.d);
  return { computer, socket, frames, calls, key, first, say, delivered, drivers };
}

describe("computer session roles (work 112)", () => {
  it("gates messages in an existing session: drivers with a role, participants held, outsiders dropped", async () => {
    const s = await withSession("org_roles_gate", "T0ROLES1");
    // The message that starts a session is unchanged: no role.
    expect(s.first.msg.role).toBeUndefined();
    expect(await s.drivers()).toBe("*");
    expect((await s.delivered(await s.say("UGRACE", "and the tests"))).msg.role).toBe("driver");

    // `!access owner`: the gateway's, never delivered; 🔒 on the thread, the state to the owner.
    const restricted = await s.say("UADA", "!access owner");
    await until(s.drivers, (d) => d === "[]", "restricted");
    await until(s.calls, (all) => all.some((c) => c.method === "chat.postEphemeral" && c.body.text === stateText({ owner: "UADA", drivers: [] })), "the state");
    expect((await s.calls()).filter((c) => c.method === "reactions.add" && c.body.name === "lock")).toEqual([
      { method: "reactions.add", body: { channel: "C1", timestamp: TS, name: "lock" } },
    ]);

    const held = await s.say("UGRACE", "the logs say 503");
    const dropped = await s.say("UGUEST", "ship it", { mention: true });
    const next = await s.delivered(await s.say("UADA", "go on"));
    expect(next.msg.role).toBe("owner");
    expect(next.msg.linked).toMatchObject([{ context: true, messages: [{ ts: held, text: "the logs say 503" }] }]);
    expect(s.frames.filter((f) => f.t === "deliver" && [restricted, held, dropped].includes(f.msg.ts))).toEqual([]);
    expect((await s.calls()).filter((c) => c.method === "chat.postEphemeral" && c.body.user === "UGUEST").map((c) => c.body.text)).toEqual([onlyMembersText()]);
    s.socket.close();
  });

  it("stop: an outsider's is ignored, a participant's stops and names them", async () => {
    const s = await withSession("org_roles_stop", "T0ROLES2");
    await s.say("UADA", "!access owner");
    await until(s.drivers, (d) => d === "[]", "restricted");
    expect(await s.computer.slackStop("org_roles_stop", "C1", TS, "UGUEST")).toEqual({ delivered: false });
    expect(s.frames.filter((f) => f.t === "stop")).toEqual([]);
    expect(await s.computer.slackStop("org_roles_stop", "C1", TS, "UGRACE")).toEqual({ delivered: true });
    expect(s.frames.filter((f) => f.t === "stop")).toHaveLength(1);
    expect((await s.calls()).filter((c) => c.method === "chat.postMessage" && c.body.text === stoppedText("UGRACE"))).toHaveLength(1);
    s.socket.close();
  });

  it("in a session's thread the gateway's own commands need someone who can drive it", async () => {
    const s = await withSession("org_roles_commands", "T0ROLES4");
    await s.say("UADA", "!access owner");
    await until(s.drivers, (d) => d === "[]", "restricted");
    const asked = [await s.say("UGRACE", "!var X=1"), await s.say("UGRACE", "!secret add TOKEN")];
    const refusals = await until(
      async () => (await s.calls()).filter((c) => c.method === "chat.postEphemeral" && c.body.user === "UGRACE").map((c) => c.body.text),
      (all) => all.length === 2,
      "two refusals",
    );
    expect(refusals).toEqual([driversCommandText("var"), driversCommandText("secret")]);
    expect((await s.calls()).filter((c) => c.method === "views.open")).toEqual([]);
    expect(s.frames.filter((f) => f.t === "deliver" && asked.includes(f.msg.ts))).toEqual([]);
    s.socket.close();
  });

  it("a spawned session starts with its parent's drivers", async () => {
    const s = await withSession("org_roles_spawn", "T0ROLES3");
    // (The fake's ids are too short for `!access @U…`, which reads Slack's.)
    await s.say("UADA", "!access owner");
    await until(s.drivers, (d) => d === "[]", "restricted");
    const id = crypto.randomUUID();
    s.socket.send(JSON.stringify({ t: "spawn", id, from: s.key, req: { task: "Port it", brief: "b.md" } }));
    const spawned = await until(() => s.frames.find((f) => f.t === "spawned" && f.id === id), (found) => !!found, "spawned");
    const child = await runInDurableObject(s.computer, (_instance, state: DurableObjectState) =>
      [...state.storage.sql.exec<{ d: string }>("SELECT drivers AS d FROM sessions WHERE runner_key = ?", spawned.result.key)][0]?.d,
    );
    expect(child).toBe("[]");
    s.socket.close();
  });
});
