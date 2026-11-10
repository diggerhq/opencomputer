import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";
import { SLACK_BOT_TOKEN } from "./fixtures/computer-fakes.mjs";

/**
 * spawn_thread on the computer (Calvin work 047): a session asks for a new
 * thread; the gateway posts it in the parent's channel, starts a session on
 * it owned by the parent's owner with the parent's mode and model, and
 * delivers the brief to the host. The fake Slack answers every post `999.1`.
 */

const ORIGIN = "https://managedagents.test";
const SIGNING_SECRET = "computer-signing-secret";
const HOST_KEY = "test-computer-host-token-key";
const TS = "1700000000.000100";
const SPAWNED_TS = "999.1";

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

/** A linked organization with a connected host and one session started by U1's mention in C1. */
async function withSession(org: string, team: string) {
  const computer = computers().getByName(org);
  // The outbound fake's call log is shared and other files clear it in
  // parallel. Observe this object's calls before forwarding to the real fake.
  await runInDurableObject(computer, ((instance: any) => {
    instance.spawnTestPosts = [];
    const slack = instance.slack.bind(instance);
    instance.slack = (method: string, body: Record<string, unknown>) => {
      if (method === "chat.postMessage") instance.spawnTestPosts.push({ method, body });
      return slack(method, body);
    };
  }) as never);
  const posts = () => runInDurableObject(computer, ((instance: any) => instance.spawnTestPosts) as never) as Promise<Array<{ method: string; body: Record<string, any> }>>;
  await computers().getByName(`computer-slack-team:${team}`).claimTeam(team, org);
  await computer.linkSlack(org, { teamId: team, teamName: "Spawn", botUserId: "UBOT", botToken: SLACK_BOT_TOKEN });
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(HOST_KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames: any[] = [];
  socket.addEventListener("message", (event: MessageEvent) => void frames.push(JSON.parse(String(event.data))));
  socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: org, version: "host-1", sessions: [] }));
  await until(() => frames, (all) => all.some((frame) => frame.t === "welcome"), "welcome");

  const event = { type: "event_callback", event_id: `Ev-${org}`, team_id: team, event: { type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> plan the work", ts: TS } };
  expect((await signed("/v1/webhooks/computer/slack/events", JSON.stringify(event))).status).toBe(200);
  await runInDurableObject(computer, (_instance, state: DurableObjectState) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
  await runDurableObjectAlarm(computer);
  const parent = `${team}:C1:${TS}`;
  await until(() => frames, (all) => all.some((frame) => frame.t === "deliver" && frame.session.key === parent), "the parent's delivery");
  // The runner reports what the parent runs with.
  socket.send(JSON.stringify({ t: "session", report: { key: parent, status: "busy", mode: "acceptEdits", model: "claude-opus-5-5" } }));
  return { socket, frames, parent, posts };
}

function spawn(socket: WebSocket, frames: any[], from: string, req: Record<string, unknown>) {
  const id = crypto.randomUUID();
  socket.send(JSON.stringify({ t: "spawn", id, from, req }));
  return until(() => frames.find((frame) => frame.t === "spawned" && frame.id === id), (found) => !!found, "spawned");
}

describe("computer spawn_thread", () => {
  it("posts the thread, starts its session like the parent's, and delivers the brief", async () => {
    const { socket, frames, parent, posts } = await withSession("org_spawn", "T0SPAWN");

    const spawned = await spawn(socket, frames, parent, { task: "Port the thing", brief: "ws/.agents/work/047.md", briefUrl: "https://github.test/brief" });
    expect(spawned).toEqual({
      t: "spawned",
      id: spawned.id,
      result: { key: `T0SPAWN:C1:${SPAWNED_TS}`, url: `https://app.slack.com/client/T0SPAWN/C1/thread/C1-${SPAWNED_TS}` },
    });

    const post = (await posts()).find((call) => String(call.body.text).includes("Port the thing"));
    expect(post?.body).toMatchObject({ channel: "C1" });
    expect(post?.body.text).toContain("<@U1> ↳ Port the thing\nBrief: <https://github.test/brief|ws/.agents/work/047.md>");

    const deliver = await until(() => frames.find((frame) => frame.t === "deliver" && frame.session.key === spawned.result.key), (found) => !!found, "the brief");
    expect(deliver.session).toMatchObject({ channel: "C1", threadTs: SPAWNED_TS, owner: { slackUserId: "U1" }, mode: "acceptEdits", model: "claude-opus-5-5", title: "Port the thing" });
    expect(deliver.msg).toMatchObject({ userId: "U1", ts: SPAWNED_TS });
    expect(deliver.msg.mentioned).toBeUndefined();
    expect(deliver.msg.text).toMatch(/^Task: Port the thing\n\nBrief: ws\/\.agents\/work\/047\.md\nStarted by the session in thread T0SPAWN:C1:/);
    socket.close();
  });

  it("leaves the model to the runner when a tier is asked for", async () => {
    const { socket, frames, parent } = await withSession("org_spawn_tier", "T0TIER");
    const spawned = await spawn(socket, frames, parent, { task: "Think hard", brief: "b.md", tier: "smart" });
    const deliver = await until(() => frames.find((frame) => frame.t === "deliver" && frame.session.key === spawned.result.key), (found) => !!found, "the brief");
    expect(deliver.session.model).toBeUndefined();
    expect(deliver.session.mode).toBe("acceptEdits");
    expect(deliver.msg.text).toMatch(/^\+smart Task: Think hard\n/);
    socket.close();
  });

  it("refuses an unknown session, an unknown tier and a missing brief, and posts nothing", async () => {
    const { socket, frames, parent, posts } = await withSession("org_spawn_refused", "T0REFUSED");
    expect((await spawn(socket, frames, "T0REFUSED:C9:1.1", { task: "never posted", brief: "b.md" })).error).toBe("unknown session T0REFUSED:C9:1.1");
    expect((await spawn(socket, frames, parent, { task: "never posted", brief: "b.md", tier: "turbo" })).error).toMatch(/^unknown tier turbo/);
    expect((await spawn(socket, frames, parent, { task: "never posted" })).error).toBe("a task and a brief are required");
    expect((await posts()).filter((call) => String(call.body.text).includes("never posted"))).toEqual([]);
    socket.close();
  });

  it("escapes the agent's task in the post", async () => {
    const { socket, frames, parent, posts } = await withSession("org_spawn_escape", "T0ESCAPE");
    await spawn(socket, frames, parent, { task: "<!channel> ship & tell", brief: "b|c.md" });
    const post = (await posts()).find((call) => String(call.body.text).includes("ship &amp; tell"));
    expect(post?.body.text).toContain("↳ &lt;!channel&gt; ship &amp; tell\nBrief: `b|c.md`");
    socket.close();
  });
});
