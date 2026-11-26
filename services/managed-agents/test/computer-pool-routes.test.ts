import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { randomToken } from "../src/computer/crypto.js";
import { hostToken } from "../src/computer/host-token.js";
import { encodeInstallState } from "../src/computer/slack.js";

/**
 * The warm pool through the edge Worker (work 052) with COMPUTER_POOL_SIZE=2:
 * the `computer-pool` object refills, pool computers boot (in-memory cloud)
 * and their hosts connect, two organizations claim concurrently and get
 * different computers (one through POST /v1/computer's path, one by
 * installing Slack), each host is told to become its organization, tags
 * move, and a third organization falls back to creating its own.
 */

const ORIGIN = "https://managedagents.test";
const KEY = "test-computer-host-token-key";

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
type Stub = DurableObjectStub<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS;
const platform = () => (env as unknown as { RUNTIMES: Fetcher }).RUNTIMES;
const pool = () => computers().getByName("computer-pool");

const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;

async function runAlarm(stub: Stub) {
  await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
  await runDurableObjectAlarm(stub);
}

const lifecycleRow = (stub: Stub) => inside(stub, (instance) => instance.lifecycle.row());

async function settle(stub: Stub, until = "ready") {
  for (let i = 0; i < 30 && (await lifecycleRow(stub))?.state !== until; i += 1) await runAlarm(stub);
  expect((await lifecycleRow(stub))?.state).toBe(until);
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

async function connectHost(id: string): Promise<{ socket: WebSocket; welcome: any }> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${id}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, id)}` },
  });
  expect(upgraded.status).toBe(101);
  const socket = upgraded.webSocket!;
  socket.accept();
  const welcomed = nextMessage(socket, "welcome");
  socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: id, version: "test", sessions: [] }));
  return { socket, welcome: await welcomed };
}

async function tagOf(prefix: string, kind: string): Promise<string | null> {
  const response = await platform().fetch("https://blue-platform/v1/computers/arm", {
    method: "POST",
    body: JSON.stringify({ op: "get", organizationId: "org_any", prefix, kind }),
  });
  return ((await response.json()) as { resource: { organization: string | null } | null }).resource?.organization ?? null;
}

describe("warm pool", () => {
  it("refills, claims warm computers for organizations, and falls back when empty", async () => {
    // The pool's own name and pool ids are not organizations a host can claim to be.
    const internal = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=computer-pool`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, "computer-pool")}` },
    });
    expect(internal.status).toBe(401);

    // The kick arms the pool's alarm for now; the runtime may already be running it.
    await pool().poolKick();
    for (let i = 0; i < 20 && (await pool().poolSlots()).length < 2; i += 1) {
      await runAlarm(pool());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const started = await pool().poolSlots();
    expect(started.map((slot) => slot.state)).toEqual(["provisioning", "provisioning"]);
    expect(started.every((slot) => slot.prefix === `oc-${slot.poolId}`)).toBe(true);

    // Each pool computer is an ordinary computer under its slot id, at the free size.
    const hosts: Array<{ poolId: string; prefix: string; socket: WebSocket }> = [];
    for (const slot of started) {
      const stub = computers().getByName(slot.poolId);
      await settle(stub);
      expect(await lifecycleRow(stub)).toMatchObject({ organizationId: slot.poolId, size: "Standard_D2as_v7", resourcePrefix: slot.prefix });
      expect(await tagOf(slot.prefix, "vm")).toBe("pool");
      const { socket, welcome } = await connectHost(slot.poolId);
      // A pool host gets no credentials: it runs no sessions until claimed.
      expect(welcome).toMatchObject({ credentials: { slackBotToken: "", slackBotUserId: "" }, people: [] });
      expect(welcome.credentials).not.toHaveProperty("anthropicApiKey");
      expect(welcome).not.toHaveProperty("definition");
      hosts.push({ poolId: slot.poolId, prefix: slot.prefix, socket });
      // Pool computers are never watched for idleness: they never park.
      await runAlarm(stub);
      expect(await inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT purpose FROM alarms")])).not.toContainEqual({ purpose: "idle" });
    }
    await runAlarm(pool());
    expect((await pool().poolSlots()).map((slot) => slot.state)).toEqual(["warm", "warm"]);

    // Two organizations at once: two different computers, each host told its
    // organization. org_b has none until it installs Slack: the install claims.
    expect((await computers().getByName("org_b").overview("org_b")).computer).toBeNull();
    // Both on the $200 plan: they claim all the same (the pool is the default size) and grow later.
    for (const org of ["org_a", "org_b"]) {
      await inside(computers().getByName(org), (instance) => {
        instance.env.COMPUTER_MAX_SIZE = "Standard_D8as_v7";
        instance.env.OPENCOMPUTER_BILLING = {
          checkAdmission: async () => ({ allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: "full", usagePlan: "max" }),
        };
      });
    }
    const assigns = Promise.all(hosts.map((host) => nextMessage(host.socket, "assign")));
    const [a, installed] = await Promise.all([computers().getByName("org_a").ensureComputer("org_a"), slackInstall("org_b")]);
    expect(a).toEqual({ status: 202 });
    expect(installed.status).toBe(302);
    expect(installed.headers.get("location")).toBe("https://app.example/computer?slack=connected");
    const frames = await assigns;
    expect(frames.map((frame) => frame.organizationId).sort()).toEqual(["org_a", "org_b"]);
    for (const frame of frames) {
      expect(frame).toEqual({
        t: "assign",
        organizationId: frame.organizationId,
        hostToken: await hostToken(KEY, frame.organizationId),
        gatewayUrl: `wss://managedagents.test/v1/computer/host?organizationId=${frame.organizationId}`,
      });
    }
    const hostOf = (org: string) => hosts[frames.findIndex((frame) => frame.organizationId === org)]!;

    // The install answered with org_b's computer already claimed: ready, on a warm slot.
    expect(await lifecycleRow(computers().getByName("org_b"))).toMatchObject({ organizationId: "org_b", state: "ready", poolSlot: expect.stringMatching(/^pool-/) });
    // Installing again claims nothing more: it has a computer.
    expect(await computers().getByName("org_b").ensureComputerOnInstall("org_b")).toBeNull();

    // The organization's computer is ready at once, on the pool computer's resources.
    const orgA = computers().getByName("org_a");
    expect(await lifecycleRow(orgA)).toMatchObject({
      organizationId: "org_a",
      state: "ready",
      resourcePrefix: hostOf("org_a").prefix,
      poolSlot: hostOf("org_a").poolId,
      osInitialized: 1,
    });
    const overview = await orgA.overview("org_a");
    expect(overview.computer).toMatchObject({ state: "ready", connected: false, vcpus: 2, memoryGiB: 8, diskGiB: 128 });
    expect(JSON.stringify(overview)).not.toMatch(/pool|oc-|Standard_|azure/i);
    // The pool computer's own object has let it go.
    expect((await lifecycleRow(computers().getByName(hostOf("org_a").poolId)))?.state).toBe("transferred");
    expect((await pool().poolSlots()).filter((slot) => slot.state === "claimed").map((slot) => slot.claimedBy).sort()).toEqual(["org_a", "org_b"]);

    // Tags move on the organization's alarm (armed for now by the claim; the runtime may have run it already).
    if ((await lifecycleRow(orgA))?.tagsPending) await runAlarm(orgA);
    expect((await lifecycleRow(orgA))?.tagsPending).toBe(0);
    for (const kind of ["vm", "nic", "dataDisk", "osDisk"]) expect(await tagOf(hostOf("org_a").prefix, kind)).toBe("org_a");

    // A host that missed its assign and reconnects as the pool computer is told again.
    const again = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${hostOf("org_b").poolId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, hostOf("org_b").poolId)}` },
    });
    const replay = again.webSocket!;
    replay.accept();
    const reassigned = nextMessage(replay, "assign");
    replay.send(JSON.stringify({ t: "hello", protocol: 1, hostId: hostOf("org_b").poolId, version: "test", sessions: [] }));
    expect(await reassigned).toMatchObject({ organizationId: "org_b", hostToken: await hostToken(KEY, "org_b") });
    replay.close();

    // The host reconnects as the organization: connected, with the organization's credentials.
    for (const host of hosts) host.socket.close();
    const { welcome } = await connectHost("org_a");
    expect(welcome.credentials).toMatchObject({ anthropicApiKey: "sk-ant-test" });
    expect((await orgA.overview("org_a")).computer).toMatchObject({ connected: true });
    expect(await inside(orgA, (instance) => instance.setting("assignPendingSince"))).toBeUndefined();

    // Connected and idle, tags moved: the max organization's computer grows to its size.
    if ((await lifecycleRow(orgA))?.state === "ready") await runAlarm(orgA);
    expect(await lifecycleRow(orgA)).toMatchObject({ state: "resizing", size: "Standard_D8as_v7" });
    await settle(orgA);
    expect((await orgA.overview("org_a")).computer).toMatchObject({ state: "ready", vcpus: 8, memoryGiB: 32 });

    // A claim refilled the pool; with nothing warm yet, the next organization creates its own.
    await runAlarm(pool());
    expect((await pool().poolSlots()).filter((slot) => slot.state === "provisioning")).toHaveLength(2);
    const orgC = computers().getByName("org_c");
    for (const field of ["COMPUTER_MAX_SIZE", "OPENCOMPUTER_BILLING"]) await inside(orgC, (instance) => delete instance.env[field]);
    expect(await orgC.ensureComputer("org_c")).toEqual({ status: 202 });
    expect(await lifecycleRow(orgC)).toMatchObject({ state: "provisioning", resourcePrefix: "oc-org-c", poolSlot: null });
    // Creating again does not claim: it has a computer.
    expect(await orgC.ensureComputer("org_c")).toEqual({ status: 200 });
  });
});

/** Slack's OAuth callback for an install `accountId` started (the dashboard's POST /v1/computer/slack/install, minus the edge identity). */
async function slackInstall(accountId: string): Promise<Response> {
  const nonce = randomToken();
  await computers().getByName(accountId).startSlackInstall(accountId, "user_installer", nonce);
  const state = encodeInstallState(accountId, nonce);
  return SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?code=good&state=${encodeURIComponent(state)}`, { redirect: "manual" });
}
