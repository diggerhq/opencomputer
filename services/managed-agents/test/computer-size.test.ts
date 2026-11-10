import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";

/**
 * The computer follows its usage plan's size (work 052, 2026-10-13):
 * only the $200 plan ("max") gets COMPUTER_MAX_SIZE, Pro and free the
 * default. A running computer only grows, when ready, connected and idle;
 * it shrinks at its next wake; an unknown usage plan resizes nothing. While
 * it resizes, Slack messages wait and the thread is told once.
 */

const ORIGIN = "https://managedagents.test";
const KEY = "test-computer-host-token-key";
const SMALL = "Standard_D2as_v7";
const BIG = "Standard_D8as_v7";

type Stub = DurableObjectStub<ComputerDurableObject>;
type UsagePlan = "base" | "pro" | "max" | null | undefined;
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;
const row = (stub: Stub) => inside(stub, (instance) => instance.lifecycle.row() as { state: string; size: string } | undefined);
const alarms = (stub: Stub) => inside(stub, (_instance, state) => [...state.storage.sql.exec<{ purpose: string }>("SELECT purpose FROM alarms")].map((r) => r.purpose));

/** The organization's billing answer, and the big size configured; the plan cache is dropped so it is asked again. */
async function billing(stub: Stub, usagePlan: UsagePlan, paid = usagePlan === "max" || usagePlan === "pro") {
  await inside(stub, (instance) => {
    instance.env.COMPUTER_MAX_SIZE = BIG;
    instance.env.OPENCOMPUTER_BILLING = {
      checkAdmission: async () => ({
        allowed: true,
        isHalted: false,
        haltedAt: null,
        reason: null,
        paid,
        modelAccess: "full",
        ...(usagePlan === undefined ? {} : { usagePlan }),
      }),
    };
    instance.remove("planCheckedAt", "plan", "usagePlan");
  });
}

afterEach(async () => {
  // Durable Objects share the test Worker's env: leave it as it was.
  await inside(computers().getByName("org_size_reset"), (instance) => {
    delete instance.env.COMPUTER_MAX_SIZE;
    delete instance.env.OPENCOMPUTER_BILLING;
  });
});

async function runAlarms(stub: Stub, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
    await runDurableObjectAlarm(stub);
  }
}

async function settle(stub: Stub, until: string) {
  for (let i = 0; i < 30 && (await row(stub))?.state !== until; i += 1) await runAlarms(stub);
  expect((await row(stub))?.state).toBe(until);
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

async function connectHost(org: string, sessions: Array<{ key: string; status: string }> = []): Promise<WebSocket> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const welcomed = nextMessage(socket, "welcome");
  socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: org, version: "test", sessions }));
  await welcomed;
  return socket;
}

/** A ready computer on the default size (created while the organization was on Pro). */
async function readySmall(org: string): Promise<Stub> {
  const stub = computers().getByName(org);
  await billing(stub, "pro");
  expect(await stub.ensureComputer(org)).toEqual({ status: 202 });
  await settle(stub, "ready");
  expect((await row(stub))?.size).toBe(SMALL);
  return stub;
}

describe("computer size follows the usage plan", () => {
  it("creates a max organization's computer on the big size, and Pro's on the default", async () => {
    const max = computers().getByName("org_size_new_max");
    await billing(max, "max");
    await max.ensureComputer("org_size_new_max");
    expect((await row(max))?.size).toBe(BIG);
    const pro = computers().getByName("org_size_new_pro");
    await billing(pro, "pro");
    await pro.ensureComputer("org_size_new_pro");
    expect((await row(pro))?.size).toBe(SMALL);
  });

  it("grows a computer whose organization moved to max once it is connected and idle, queueing messages meanwhile", async () => {
    const ORG = "org_size_up";
    const stub = await readySmall(ORG);
    const socket = await connectHost(ORG);

    // Not before the host is free: a working session holds the resize.
    await inside(stub, (_instance, state) =>
      state.storage.sql.exec(
        "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, status, created_at, updated_at) VALUES ('T0SIZE:CSIZE:1.1', 'T0SIZE', 'CSIZE', '1.1', 'U1', 't', 'busy', 0, 0)",
      ),
    );
    await billing(stub, "max");
    await runAlarms(stub);
    expect(await row(stub)).toMatchObject({ state: "ready", size: SMALL });
    expect(await alarms(stub)).toContain("size");

    // Idle: it resizes (the VM restarts on the big size).
    await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE sessions SET status = 'idle'"));
    await runAlarms(stub);
    expect(await row(stub)).toMatchObject({ state: "resizing", size: BIG });
    expect((await stub.overview(ORG)).computer).toMatchObject({ state: "ready", vcpus: 8, memoryGiB: 32 });

    // A message meanwhile: queued, and the thread told once.
    await stub.linkSlack(ORG, { teamId: "T0SIZE", teamName: "Size", botUserId: "UBOT", botToken: "xoxb-size" });
    const job = { eventId: "EvS1", teamId: "T0SIZE", channelId: "CSIZE", threadTs: "1.1", messageTs: "1.2", userId: "U1", text: "<@UBOT> again", mentioned: true, receivedAt: Date.now() };
    for (const [eventId, ts] of [["EvS1", "1.2"], ["EvS2", "1.3"]] as const) {
      await stub.acceptSlackEvent(ORG, { ...job, eventId, messageTs: ts });
      await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
      await runDurableObjectAlarm(stub);
    }
    // Told once (the notices table is what makes it once; the fake Slack's
    // call log is shared with the other test file, so it is not read here).
    expect(await inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT thread_key AS t, kind FROM notices")])).toEqual([
      { t: "CSIZE:1.1", kind: "resizing" },
    ]);
    expect(await inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM dispatches WHERE state = 'pending'")][0])).toEqual({ n: 2 });

    // The resize ends: the queued messages go to the host.
    const delivered = nextMessage(socket, "deliver");
    await settle(stub, "ready");
    expect((await delivered).msg).toMatchObject({ ts: "1.2" });
    expect((await row(stub))?.size).toBe(BIG);
    socket.close();
  });

  it("looks at a resize as soon as the restarted host says hello, not at the next poll", async () => {
    const ORG = "org_size_hello";
    const stub = await readySmall(ORG);
    const first = await connectHost(ORG);
    await billing(stub, "max");
    await runAlarms(stub);
    expect(await row(stub)).toMatchObject({ state: "resizing", size: BIG });
    // The resize's own look is a poll away; the VM restarts and its host says hello again.
    await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = ? WHERE purpose = 'lifecycle'", Date.now() + 15_000));
    first.close();
    const before = Date.now();
    const second = await connectHost(ORG);
    const lifecycleAt = await inside(stub, (_instance, state) => [...state.storage.sql.exec<{ at: number }>("SELECT at FROM alarms WHERE purpose = 'lifecycle'")][0]?.at);
    // Looked at already (the alarm may have run and finished it), or due now.
    if (lifecycleAt !== undefined) expect(lifecycleAt).toBeLessThanOrEqual(Date.now());
    for (let i = 0; i < 20 && (await row(stub))?.state !== "ready"; i += 1) {
      await runDurableObjectAlarm(stub);
    }
    expect(await row(stub)).toMatchObject({ state: "ready", size: BIG });
    expect(Date.now() - before).toBeLessThan(15_000);
    second.close();
  });

  it("never resizes on an unknown usage plan, and never shrinks a running computer", async () => {
    const ORG = "org_size_unknown";
    const stub = await readySmall(ORG);
    const socket = await connectHost(ORG);
    // A billing service that predates usagePlan, though it says paid.
    await billing(stub, undefined, true);
    await runAlarms(stub, 2);
    expect(await row(stub)).toMatchObject({ state: "ready", size: SMALL });
    // Billing unreachable.
    await inside(stub, (instance) => {
      instance.env.OPENCOMPUTER_BILLING = { checkAdmission: async () => Promise.reject(new Error("down")) };
      instance.remove("planCheckedAt");
    });
    await runAlarms(stub, 2);
    expect(await row(stub)).toMatchObject({ state: "ready", size: SMALL });
    socket.close();

    const big = computers().getByName("org_size_down");
    await billing(big, "max");
    await big.ensureComputer("org_size_down");
    await settle(big, "ready");
    const bigSocket = await connectHost("org_size_down");
    await billing(big, "pro");
    await runAlarms(big, 2);
    expect(await row(big)).toMatchObject({ state: "ready", size: BIG });
    bigSocket.close();
  });

  it("wakes a parked computer on its plan's size: a downsize happens on wake only", async () => {
    const ORG = "org_size_wake";
    const stub = computers().getByName(ORG);
    await billing(stub, "max");
    await stub.ensureComputer(ORG);
    await settle(stub, "ready");
    expect((await row(stub))?.size).toBe(BIG);

    // Down to free: it keeps the big size while running, then parks.
    await billing(stub, "base", false);
    expect(await inside(stub, (instance) => instance.lifecycle.park() as Promise<boolean>)).toBe(true);
    await settle(stub, "parked");
    expect((await row(stub))?.size).toBe(BIG);

    // Woken (POST /v1/computer's path): the VM comes back on the default size.
    expect(await stub.ensureComputer(ORG)).toEqual({ status: 202 });
    expect((await row(stub))?.state).toBe("waking");
    await settle(stub, "ready");
    expect((await row(stub))?.size).toBe(SMALL);
    const vm = await (env as unknown as { RUNTIMES: Fetcher }).RUNTIMES.fetch("https://blue-platform/v1/computers/arm", {
      method: "POST",
      body: JSON.stringify({ op: "get", organizationId: ORG, prefix: "oc-org-size-wake", kind: "vm" }),
    });
    expect(((await vm.json()) as { resource: { vmSize: string } }).resource.vmSize).toBe(SMALL);

    // Unknown plan on a wake: it keeps the size it had.
    await inside(stub, (instance) => {
      instance.env.OPENCOMPUTER_BILLING = undefined;
      instance.remove("planCheckedAt");
    });
    expect(await inside(stub, (instance) => instance.lifecycle.park() as Promise<boolean>)).toBe(true);
    await settle(stub, "parked");
    await stub.ensureComputer(ORG);
    expect((await row(stub))?.size).toBe(SMALL);
  });
});
