import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";

/**
 * The data disk grows on its own near capacity (work 071): the host reports
 * `/data` every 5 minutes; at 80% used the computer grows the disk by half,
 * once until the filesystem catches up, never past COMPUTER_MAX_DISK_GIB.
 */

const ORIGIN = "https://managedagents.test";
const KEY = "test-computer-host-token-key";
const GIB = 2 ** 30;

type Stub = DurableObjectStub<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;
const row = (stub: Stub) => inside(stub, (instance) => instance.lifecycle.row() as { state: string; diskGiB: number } | undefined);

afterEach(async () => {
  await inside(computers().getByName("org_disk_reset"), (instance) => {
    delete instance.env.OPENCOMPUTER_BILLING;
    delete instance.env.COMPUTER_MAX_DISK_GIB;
  });
});

async function ready(org: string): Promise<Stub> {
  const stub = computers().getByName(org);
  await inside(stub, (instance) => {
    instance.env.OPENCOMPUTER_BILLING = {
      checkAdmission: async () => ({ allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: "full", usagePlan: "pro" }),
    };
  });
  expect(await stub.ensureComputer(org)).toEqual({ status: 202 });
  for (let i = 0; i < 30 && (await row(stub))?.state !== "ready"; i += 1) {
    await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
    await runDurableObjectAlarm(stub);
  }
  expect(await row(stub)).toMatchObject({ state: "ready", diskGiB: 128 });
  return stub;
}

async function connectHost(org: string): Promise<WebSocket> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const welcomed = new Promise((resolve) => socket.addEventListener("message", (e) => JSON.parse(String(e.data)).t === "welcome" && resolve(null)));
  socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: org, version: "test", sessions: [] }));
  await welcomed;
  return socket;
}

/** Report a filesystem of `fsGiB` with `usedPct` used, and let the object handle it. */
async function report(stub: Stub, socket: WebSocket, fsGiB: number, usedPct: number) {
  socket.send(JSON.stringify({ t: "disk", totalBytes: fsGiB * GIB, freeBytes: Math.round(fsGiB * GIB * (1 - usedPct / 100)) }));
  // Messages are handled in order: a round trip through the object means the report was.
  await new Promise((r) => setTimeout(r, 50));
  await row(stub);
}

describe("data disk auto-grow", () => {
  it("grows at 80% used, waits for the filesystem, and stops at the ceiling", async () => {
    const ORG = "org_disk_grow";
    const stub = await ready(ORG);
    const socket = await connectHost(ORG);

    await report(stub, socket, 125, 70);
    expect((await row(stub))?.diskGiB).toBe(128);

    await report(stub, socket, 125, 85);
    expect((await row(stub))?.diskGiB).toBe(192);

    // The filesystem has not grown yet: no second growth.
    await report(stub, socket, 125, 95);
    expect((await row(stub))?.diskGiB).toBe(192);

    // Grown and settled, still full: once more, up to the ceiling.
    await inside(stub, (instance) => {
      instance.env.COMPUTER_MAX_DISK_GIB = "256";
      instance.put("diskGrownAt", "0");
    });
    await report(stub, socket, 188, 90);
    expect((await row(stub))?.diskGiB).toBe(256);
    await inside(stub, (instance) => instance.put("diskGrownAt", "0"));
    await report(stub, socket, 251, 99);
    expect((await row(stub))?.diskGiB).toBe(256);
    socket.close();
  });
});
