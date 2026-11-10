import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";
import { generateTelemetryKeys, verifyTelemetryCredential } from "../src/computer/telemetry/credential.js";
import { checkEvent } from "../src/computer/telemetry/validate.js";
import { SLACK_BOT_TOKEN } from "./fixtures/computer-fakes.mjs";

/**
 * The computer gateway's telemetry end to end (work 054, S5 on bluecode):
 * the edge Worker and ComputerDurableObject with TINYBIRD_API_URL and
 * TINYBIRD_APPEND_TOKEN set, a fake Tinybird, a fake host socket and fake
 * Slack. One message's trace from `message.received` through the Slack
 * queue, the acknowledgement and the dispatch to `deliver`; the re-flush
 * after a reconnect keeps it; the welcome carries a credential the
 * collector's public key accepts; and nothing content-shaped leaves.
 */

const ORIGIN = "https://managedagents.test";
const ORG = "org_telemetry";
const TEAM = "T0TELE";
/** Slack's `ts` for the message: a second ago, so `received_at − sent_at` is a real latency. */
const TS = `${Math.floor(Date.now() / 1000) - 1}.000100`;
const KEY = `${TEAM}:C1:${TS}`;
const SIGNING_SECRET = "computer-signing-secret";
const HOST_KEY = "test-computer-host-token-key";
const TEXT = "<@UBOTHELD> fix the flaky build";

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS;
const computer = () => computers().getByName(ORG);
const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(computer(), fn as never) as Promise<T>;

type Event = Record<string, any> & { event_name: string; data: string };
async function posts(reset = false): Promise<Array<{ datasource: string; token: string; down?: boolean; lines: Event[] }>> {
  const response = await fetch("https://tinybird.test/__posts", { method: reset ? "DELETE" : "GET" });
  return ((await response.json()) as { posts: Array<{ datasource: string; token: string; down?: boolean; lines: Event[] }> }).posts;
}
const events = async () => (await posts()).flatMap((post) => post.lines);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never: ${what}`);
}

async function signed(path: string, body: string, headers: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const signature = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature, ...headers },
    body,
  });
}

function nextMessage(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), 5000);
    const listener = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.t !== type) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(frame);
    };
    socket.addEventListener("message", listener);
  });
}

/** Every frame the gateway sends on `socket`, from now on. */
function record(socket: WebSocket): any[] {
  const frames: any[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    frames.push(JSON.parse(String(event.data)));
  });
  return frames;
}

async function connectHost(): Promise<{ socket: WebSocket; welcome: any; frames: any[] }> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ORG}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(HOST_KEY, ORG)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames = record(socket);
  const welcomed = nextMessage(socket, "welcome");
  socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: ORG, version: "host-1", sessions: [] }));
  return { socket, welcome: await welcomed, frames };
}

async function runSlackQueue() {
  await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
  await runDurableObjectAlarm(computer());
}

describe("computer telemetry", () => {
  it("traces a Slack message to the host, issues host credentials, and sends nothing content-shaped", async () => {
    const keys = await generateTelemetryKeys();
    await inside((instance) => {
      instance.env.TELEMETRY_SIGNING_KEY = keys.signingKey;
      instance.env.TELEMETRY_COLLECTOR_URL = "https://telemetry.example";
    });
    await computers().getByName(`computer-slack-team:${TEAM}`).claimTeam(TEAM, ORG);
    await computer().linkSlack(ORG, { teamId: TEAM, teamName: "Tele", botUserId: "UBOTHELD", botToken: SLACK_BOT_TOKEN });
    await posts(true);

    // The host: its welcome carries a credential for this organization and host.
    const { socket, welcome, frames } = await connectHost();
    expect(await verifyTelemetryCredential(keys.publicKey, welcome.telemetryCredential)).toEqual({
      org_id: ORG,
      host_id: ORG,
      exp: expect.any(Number),
    });
    expect(welcome.telemetryUrl).toBe("https://telemetry.example");
    const connected = await until(events, (all) => all.some((e) => e.event_name === "host.connected"), "host.connected");
    expect(connected.find((e) => e.event_name === "host.connected")).toMatchObject({ org_id: ORG, host_id: ORG, service_name: "gateway" });
    // The first hello read the organization's repositories (none connected here), timed by part;
    // its credentials came from this object's storage (linkSlack's push asked the account and stored the answer).
    const defined = (await until(events, (all) => all.some((e) => e.event_name === "definition.refreshed"), "definition.refreshed")).find(
      (e) => e.event_name === "definition.refreshed",
    )!;
    expect(defined).toMatchObject({ org_id: ORG, outcome: "completed", duration_ms: expect.any(Number) });
    expect(JSON.parse(defined.data)).toEqual({ account_ms: expect.any(Number), github_ms: 0, repos: 0, changed: true, timed_out: false });
    const resolved = (await until(events, (all) => all.some((e) => e.event_name === "credentials.resolved"), "credentials.resolved")).filter(
      (e) => e.event_name === "credentials.resolved",
    );
    expect(JSON.parse(resolved[0]!.data)).toEqual({ source: "local" });

    // A mention, redelivered by Slack once: `message.received` with Slack's retry headers and the trace.
    const event = { type: "event_callback", event_id: "EvT1", team_id: TEAM, event: { type: "app_mention", channel: "C1", user: "U1", text: TEXT, ts: TS } };
    const answer = await signed("/v1/webhooks/computer/slack/events", JSON.stringify(event), { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" });
    expect(answer.status).toBe(200);
    const received = (await until(events, (all) => all.some((e) => e.event_name === "message.received"), "message.received")).find(
      (e) => e.event_name === "message.received",
    )!;
    // The trace id comes from the event, not the queue row: the alarm may already have taken the job.
    const traceId: string = received.trace_id;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(received).toMatchObject({ org_id: ORG, surface_workspace_id: TEAM, conversation_id: "C1", person_id: "U1" });
    expect(received.duration_ms).toBeGreaterThanOrEqual(0);
    expect(received.duration_ms).toBeLessThan(60_000);
    expect(JSON.parse(received.data)).toEqual({ surface_event_id: "EvT1", redelivery: true, redelivery_reason: "http_timeout", kind: "mention", cached: false });

    // The alarm takes the job (the runtime may already have run it): queue.started,
    // dispatch.created and dispatch.sent in one batch, and the trace on `deliver`.
    // The acknowledgement started on accept: ack.done is in the accept's batch.
    await runSlackQueue();
    const deliver = (await until(async () => frames.filter((frame) => frame.t === "deliver"), (found) => found.length > 0, "deliver"))[0];
    expect(deliver.trace).toMatchObject({ id: traceId, sentAt: Math.round(Number(TS) * 1000), surface: "slack", surfaceWorkspaceId: TEAM, conversationId: "C1", personId: "U1", surfaceEventId: "EvT1", dispatchedAt: expect.any(Number) });
    expect(deliver.trace.dispatchedAt).toBeGreaterThanOrEqual(deliver.trace.receivedAt);
    const batch = (await until(posts, (all) => all.some((post) => post.lines.some((e) => e.event_name === "queue.started")), "the job's batch")).filter(
      (post) => post.lines.some((e) => e.event_name === "queue.started"),
    );
    expect(batch).toHaveLength(1);
    expect(batch[0]!.datasource).toBe("calvin_events");
    expect(batch[0]!.token).toBe("Bearer p.test-append");
    const names = batch[0]!.lines.map((e) => e.event_name);
    expect(names).toEqual(expect.arrayContaining(["queue.started", "admission.checked", "dispatch.created", "credentials.resolved", "dispatch.sent"]));
    // The gateway's steps on the message's path (058 step 5): the credit gate (asked: nothing cached yet) and the credentials.
    const admission = batch[0]!.lines.find((e) => e.event_name === "admission.checked")!;
    expect(admission).toMatchObject({ outcome: "completed", duration_ms: expect.any(Number) });
    expect(JSON.parse(admission.data)).toEqual({ cached: false, decision: "allowed" });
    const credentials = batch[0]!.lines.find((e) => e.event_name === "credentials.resolved")!;
    expect(credentials).toMatchObject({ outcome: "completed", duration_ms: expect.any(Number) });
    expect(JSON.parse(credentials.data)).toEqual({ source: "local" });
    // Accepted by the organization's object, with the working status started there.
    const accepted = (await events()).find((e) => e.event_name === "message.accepted")!;
    expect(accepted).toMatchObject({ trace_id: traceId, org_id: ORG, session_key: KEY, duration_ms: expect.any(Number) });
    expect(JSON.parse(accepted.data)).toEqual({ ack: true });
    for (const line of batch[0]!.lines) expect(line).toMatchObject({ trace_id: traceId, org_id: ORG, session_key: KEY });
    const sent = batch[0]!.lines.find((e) => e.event_name === "dispatch.sent")!;
    expect(sent).toMatchObject({ dispatch_id: deliver.id, host_id: ORG });
    // Work 068 §3f: how long the dispatch row waited, and how the job was taken.
    expect(JSON.parse(sent.data)).toEqual({ attempt: 1, wait_ms: expect.any(Number) });
    const started = batch[0]!.lines.find((e) => e.event_name === "queue.started")!;
    expect(JSON.parse(started.data)).toEqual({ attempt: 1, inline: expect.any(Boolean), parallel: 1 });
    const ack = (await until(events, (all) => all.some((e) => e.event_name === "ack.done"), "ack.done")).find((e) => e.event_name === "ack.done")!;
    expect(ack).toMatchObject({ outcome: "completed", trace_id: traceId, org_id: ORG, session_key: KEY });
    expect(JSON.parse(ack.data)).toMatchObject({ indicator: "status" });

    // A reconnect re-flushes the sent dispatch: `dispatch.resent`, the same trace, a new dispatchedAt.
    await posts(true);
    const redelivered = new Promise<any>((resolve) => {
      void (async () => {
        await inside((_instance, state) => {
          for (const ws of state.getWebSockets()) ws.close(1000, "test");
        });
        socket.close();
        const again = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ORG}`, {
          headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(HOST_KEY, ORG)}` },
        });
        const next = again.webSocket!;
        next.accept();
        const frame = nextMessage(next, "deliver");
        next.send(JSON.stringify({ t: "hello", protocol: 1, hostId: ORG, version: "host-1", sessions: [] }));
        resolve({ socket: next, frame: await frame });
      })();
    });
    const { socket: second, frame: again } = await redelivered;
    expect(again.id).toBe(deliver.id);
    expect(again.trace.id).toBe(traceId);
    const resent = await until(events, (all) => all.some((e) => e.event_name === "dispatch.resent"), "dispatch.resent");
    expect(resent.find((e) => e.event_name === "dispatch.resent")).toMatchObject({ trace_id: traceId, dispatch_id: deliver.id });
    expect(JSON.parse(resent.find((e) => e.event_name === "dispatch.resent")!.data)).toEqual({ attempt: 2 });
    expect(resent.some((e) => e.event_name === "host.disconnected")).toBe(true);

    // The host takes it: `dispatch.replied`.
    second.send(JSON.stringify({ t: "reply", id: deliver.id, ok: true }));
    const replied = await until(events, (all) => all.some((e) => e.event_name === "dispatch.replied"), "dispatch.replied");
    expect(replied.find((e) => e.event_name === "dispatch.replied")).toMatchObject({ trace_id: traceId, outcome: "completed" });

    // The boundary: every record is a valid envelope, and no content, token or credential left.
    const all = await events();
    for (const line of all) expect(checkEvent({ ...line, data: JSON.parse(line.data) }).ok, line.event_name).toBe(true);
    const wire = JSON.stringify(await posts());
    for (const secret of ["fix the flaky build", SLACK_BOT_TOKEN, welcome.telemetryCredential, keys.signingKey, "sk-ant-test"]) {
      expect(wire).not.toContain(secret);
    }
    second.close();
  });

  it("keeps a retried job's trace, and never lets a failing Tinybird delay or fail a delivery", async () => {
    const { socket, frames } = await connectHost();
    const job = {
      eventId: "EvT9",
      teamId: TEAM,
      channelId: "C2",
      threadTs: TS,
      messageTs: TS,
      userId: "U2",
      text: "<@UBOTHELD> again",
      mentioned: true,
      receivedAt: Date.now(),
      trace: { id: "019a0000-0000-7000-8000-000000000009", sentAt: Date.now() - 500, receivedAt: Date.now(), surface: "slack", surfaceWorkspaceId: TEAM, conversationId: "C2", personId: "U2" },
    };
    // Billing is unavailable for the first attempt: the queue backs the job off.
    // (The first test's message was admitted, and an admission is cached for a minute.)
    await inside((instance) => {
      instance.remove("admission");
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: async () => {
          throw new Error("billing down");
        },
      };
    });
    await posts(true);
    expect(await computer().acceptSlackEvent(ORG, job)).toEqual({ accepted: true });
    await runSlackQueue();
    const retried = await until(events, (all) => all.some((e) => e.event_name === "queue.retried"), "queue.retried");
    expect(retried.find((e) => e.event_name === "queue.retried")).toMatchObject({ trace_id: job.trace.id, outcome: "failed", error_type: "unknown" });

    // Billing is back, and Tinybird is down: the retry is delivered with the same trace all the same.
    await inside((instance) => {
      delete instance.env.OPENCOMPUTER_BILLING;
      instance.env.TINYBIRD_API_URL = "https://tinybird.test/down";
    });
    await inside((_instance, state) => state.storage.sql.exec("UPDATE slack_queue SET available_at = 0"));
    await runSlackQueue();
    const deliver = (await until(async () => frames.filter((frame) => frame.t === "deliver" && frame.msg.text === "again"), (found) => found.length > 0, "the retried delivery"))[0];
    expect(deliver.trace.id).toBe(job.trace.id);
    // One batch, tried twice (one retry), then dropped; nothing else was in its way.
    const down = await until(posts, (all) => all.filter((post) => post.down).length >= 2, "the failed posts");
    expect(down.filter((post) => post.down)).toHaveLength(2);
    await inside((instance) => {
      instance.env.TINYBIRD_API_URL = "https://tinybird.test";
    });
    socket.close();
  });

  it("issues no credential to a pool computer's host", async () => {
    const poolId = "pool-telemetry1";
    const stub = computers().getByName(poolId);
    const keys = await generateTelemetryKeys();
    await runInDurableObject(stub, ((instance: any) => {
      instance.env.TELEMETRY_SIGNING_KEY = keys.signingKey;
    }) as never);
    const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${poolId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(HOST_KEY, poolId)}` },
    });
    const socket = upgraded.webSocket!;
    socket.accept();
    const welcomed = nextMessage(socket, "welcome");
    socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: poolId, version: "host-1", sessions: [] }));
    expect(await welcomed).not.toHaveProperty("telemetryCredential");
    socket.close();
  });
});
