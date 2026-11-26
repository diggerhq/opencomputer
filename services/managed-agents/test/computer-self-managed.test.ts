import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";

/**
 * Self-managed VMs (work 105, COMPUTER_VMS=self-managed): the operator runs
 * each organization's VM and the gateway only accepts its host. No platform
 * Worker is bound here (RUNTIMES is taken away), so any cloud call would
 * fail the computer; none is made.
 */

const ORIGIN = "https://managedagents.test";
const KEY = "test-computer-host-token-key";

type Stub = DurableObjectStub<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;
const row = (stub: Stub) => inside(stub, (instance) => instance.lifecycle.row() as { state: string } | undefined);
const view = (stub: Stub) => inside(stub, (instance) => instance.lifecycle.view() as { state: string; connected: boolean } | null);
const alarms = (stub: Stub) => inside(stub, (_instance, state) => [...state.storage.sql.exec<{ purpose: string }>("SELECT purpose FROM alarms")].map((r) => r.purpose));

let platform: unknown;
let gatewayUrl: unknown;

// Durable Objects share the test Worker's env: changed here, put back after.
beforeEach(async () => {
  await inside(computers().getByName("org_self_env"), (instance) => {
    platform = instance.env.RUNTIMES;
    gatewayUrl = instance.env.COMPUTER_HOST_GATEWAY_URL;
    instance.env.COMPUTER_VMS = "self-managed";
    delete instance.env.RUNTIMES;
    delete instance.env.COMPUTER_HOST_GATEWAY_URL;
  });
});

afterEach(async () => {
  await inside(computers().getByName("org_self_env"), (instance) => {
    delete instance.env.COMPUTER_VMS;
    instance.env.RUNTIMES = platform;
    instance.env.COMPUTER_HOST_GATEWAY_URL = gatewayUrl;
  });
});

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

async function connectHost(org: string): Promise<WebSocket> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const welcomed = nextMessage(socket, "welcome");
  socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: org, version: "test", sessions: [] }));
  await welcomed;
  return socket;
}

async function runAlarms(stub: Stub, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
    await runDurableObjectAlarm(stub);
  }
}

describe("self-managed computer VMs", () => {
  it("a host that connects makes the computer: ready and connected, with no install first", async () => {
    const ORG = "org_self_hello";
    const stub = computers().getByName(ORG);
    expect(await row(stub)).toBeUndefined();
    const socket = await connectHost(ORG);
    expect(await view(stub)).toMatchObject({ state: "ready", connected: true });
    socket.close();
  });

  it("is ready and offline when asked for before its VM connects, then connected", async () => {
    const ORG = "org_self_install";
    const stub = computers().getByName(ORG);
    expect(await stub.ensureComputerOnInstall(ORG)).toEqual({ status: 200 });
    expect(await view(stub)).toMatchObject({ state: "ready", connected: false });
    const socket = await connectHost(ORG);
    expect(await view(stub)).toMatchObject({ state: "ready", connected: true });
    socket.close();
  });

  it("still refuses a host without the organization's token", async () => {
    const refused = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=org_self_auth`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, "org_self_other")}` },
    });
    expect(refused.status).toBe(401);
  });

  it("never parks or resizes it, and keeps no idle watch or warm pool", async () => {
    const ORG = "org_self_idle";
    const stub = computers().getByName(ORG);
    const socket = await connectHost(ORG);
    await inside(stub, async (instance) => {
      instance.env.COMPUTER_POOL_SIZE = "2";
      instance.env.COMPUTER_MAX_SIZE = "Standard_D8as_v7";
      instance.put("lastActivityAt", "0");
      await instance.schedule("idle", Date.now() + 1000);
      await instance.schedule("size", Date.now() + 1000);
      expect(instance.poolTarget()).toBe(0);
    });
    await runAlarms(stub, 3);
    await inside(stub, (instance) => {
      delete instance.env.COMPUTER_POOL_SIZE;
      delete instance.env.COMPUTER_MAX_SIZE;
    });
    expect(await row(stub)).toMatchObject({ state: "ready", size: "Standard_D2as_v7" });
    expect(await alarms(stub)).not.toContain("idle");
    expect(await alarms(stub)).not.toContain("lifecycle");
    socket.close();
  });

  it("tells a thread once that the computer is offline, and may tell it again after the host came back", async () => {
    const ORG = "org_self_offline";
    const stub = computers().getByName(ORG);
    await stub.ensureComputer(ORG);
    const notices = () => inside(stub, (_instance, state) => [...state.storage.sql.exec<{ kind: string }>("SELECT kind FROM notices")].map((r) => r.kind));
    await inside(stub, (instance) => instance.ensureAwake({ channelId: "CSELF", threadTs: "1.1" }));
    await inside(stub, (instance) => instance.ensureAwake({ channelId: "CSELF", threadTs: "1.1" }));
    expect(await notices()).toEqual(["offline"]);
    const socket = await connectHost(ORG);
    expect(await notices()).toEqual([]);
    // Connected: a waiting message is the host's to take, nothing to say.
    await inside(stub, (instance) => instance.ensureAwake({ channelId: "CSELF", threadTs: "1.1" }));
    expect(await notices()).toEqual([]);
    socket.close();
  });
});

async function slackCalls(): Promise<Array<{ method: string; body: any }>> {
  const response = await fetch("https://slack.test/__calls");
  return ((await response.json()) as { calls: Array<{ method: string; body: any }> }).calls;
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what} not reached`);
}

describe("the Community Edition session cap", () => {
  it("refuses a new session past COMPUTER_MAX_CONCURRENT_SESSIONS, tells its thread once, and never refuses a running session's follow-up", async () => {
    const ORG = "org_self_cap";
    const TEAM = "T0SELFCAP";
    const CHANNEL = "CSELFCAP";
    await computers().getByName(`computer-slack-team:${TEAM}`).claimTeam(TEAM, ORG);
    const stub = computers().getByName(ORG);
    await stub.linkSlack(ORG, { teamId: TEAM, teamName: "Cap", botUserId: "UBOTCAP", botToken: "xoxb-cap-token" });
    const socket = await connectHost(ORG);
    const frames: any[] = [];
    socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
    await inside(stub, (instance, state) => {
      instance.env.COMPUTER_MAX_CONCURRENT_SESSIONS = "2";
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES ('U1', 'slack-u1', 'Person U1 via Computer', 'u1@example.com', ?)",
        Date.now(),
      );
      // Two running: one mid-turn, one whose turn is over while its subagents still run.
      for (const [thread, status, subagents] of [
        ["1.1", "busy", 0],
        ["2.1", "idle", 1],
      ] as const) {
        state.storage.sql.exec(
          "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, status, subagents, created_at, updated_at) VALUES (?, ?, ?, ?, 'U1', 'Running', ?, ?, ?, ?)",
          `${TEAM}:${CHANNEL}:${thread}`,
          TEAM,
          CHANNEL,
          thread,
          status,
          subagents,
          Date.now(),
          Date.now(),
        );
      }
    });
    const before = (await slackCalls()).length;
    const posts = async () =>
      (await slackCalls())
        .slice(before)
        .filter((call) => call.method === "chat.postMessage" && call.body.channel === CHANNEL)
        .map((call) => `${call.body.thread_ts}:${call.body.text}`);
    const delivered = () => frames.filter((frame) => frame.t === "deliver").map((frame) => `${frame.session.threadTs}/${frame.msg.ts}`);
    const queueEmpty = () => inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT 1 FROM slack_queue WHERE state IN ('pending', 'running')")].length === 0);
    const message = async (threadTs: string, messageTs: string) => {
      await stub.acceptSlackEvent(ORG, {
        eventId: `Ev-cap-${messageTs}`,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs,
        messageTs,
        userId: "U1",
        text: "<@UBOTCAP> go",
        mentioned: true,
        receivedAt: Date.now(),
      });
      await until(queueEmpty, Boolean, `message ${messageTs} handled`);
    };

    try {
      // A new thread at the cap: not delivered, no session, and the thread is told once.
      await message("3.1", "3.1");
      await message("3.1", "3.2");
      const notice = "3.1::information_source: This organization already has 2 sessions running, the most the Community Edition allows. Try again when one finishes.";
      expect(await until(posts, (all) => all.length > 0, "the cap's notice")).toEqual([notice]);
      expect(delivered()).toEqual([]);
      expect(await inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT 1 FROM sessions WHERE thread_ts = '3.1'")].length)).toBe(0);

      // A follow-up to a running session is never the cap's to refuse.
      await message("1.1", "1.2");
      await until(delivered, (all) => all.includes("1.1/1.2"), "the follow-up's delivery");

      // "0": no cap. The refused thread is admitted, and a later refusal there would be told again.
      await inside(stub, (instance) => void (instance.env.COMPUTER_MAX_CONCURRENT_SESSIONS = "0"));
      await message("3.1", "3.3");
      await until(delivered, (all) => all.includes("3.1/3.3"), "the new session's delivery");
      expect(await posts()).toEqual([notice]);
      expect(await inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT kind FROM notices WHERE kind = 'capacity'")].length)).toBe(0);
    } finally {
      await inside(stub, (instance) => void delete instance.env.COMPUTER_MAX_CONCURRENT_SESSIONS);
      socket.close();
    }
  });

  it("refuses a session's spawn at the cap, though the parent itself is running", async () => {
    const ORG = "org_self_cap_spawn";
    const stub = computers().getByName(ORG);
    await inside(stub, async (instance, state) => {
      instance.env.COMPUTER_MAX_CONCURRENT_SESSIONS = "1";
      try {
        instance.put("slackTeamId", "T0CAPSPAWN");
        state.storage.sql.exec(
          "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, status, created_at, updated_at) VALUES ('T0CAPSPAWN:C1:1.1', 'T0CAPSPAWN', 'C1', '1.1', 'U1', 'Parent', 'busy', 0, 0)",
        );
        await expect(instance.spawn("T0CAPSPAWN:C1:1.1", { task: "more", brief: "docs/x.md" })).rejects.toThrow(
          "This organization already has 1 session running, the most the Community Edition allows. Try again when one finishes.",
        );
      } finally {
        delete instance.env.COMPUTER_MAX_CONCURRENT_SESSIONS;
      }
    });
  });
});
