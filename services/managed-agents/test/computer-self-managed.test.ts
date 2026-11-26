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
