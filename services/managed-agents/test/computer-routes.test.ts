import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { randomToken } from "../src/computer/crypto.js";
import { hostToken } from "../src/computer/host-token.js";
import { CALVIN_PROTOCOL_VERSION } from "../src/computer/protocol.js";
import { encodeInstallState } from "../src/computer/slack.js";
import { REVOKED_SLACK_BOT_TOKEN, SLACK_BOT_TOKEN } from "./fixtures/computer-fakes.mjs";

/**
 * The computer end to end through the edge Worker (work 052): the dashboard
 * routes and their exact shapes, the host WebSocket and Calvin's protocol,
 * the Slack install, signed events into a delivery, and unlinking. The cloud
 * behind the platform binding is in memory; Slack is a fake.
 *
 * In development the edge's identity is the `local` organization.
 */

const ORIGIN = "https://managedagents.test";
const ACCOUNT = "local";
const FORBIDDEN = /azure|eastus|westus|Standard_|D2as|oc-local|managedagents\.test|subscription|resourceGroup/i;

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS;
const computer = () => computers().getByName(ACCOUNT);

async function api(path: string, init: RequestInit = {}) {
  const response = await SELF.fetch(`${ORIGIN}${path}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? (JSON.parse(text) as any) : null };
}

async function settleAlarms(limit = 30) {
  for (let i = 0; i < limit; i += 1) {
    const state = await runInDurableObject(computer(), (instance: ComputerDurableObject) =>
      (instance as unknown as { lifecycle: { row(): { state: string } | undefined } }).lifecycle.row()?.state,
    );
    if (state === "ready") return;
    await runInDurableObject(computer(), (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
    await runDurableObjectAlarm(computer());
  }
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

describe("computer routes", () => {
  it("serves the dashboard contract, a host, the Slack app and a delivery", async () => {
    // GET with nothing yet: the exact shape, no computer.
    const empty = await api("/v1/computer");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      computer: null,
      slack: { installed: false },
      github: { connected: false, installations: [] },
      plan: "paid",
      // Work 081: the dashboard user's agent.
      agent: { choice: null, linked: false, subscription: null, subscriptions: { claude: null, codex: null }, managedModel: "Claude Opus 5.5", harnesses: ["claude", "codex"] },
    });

    // POST creates it; the body is GET's.
    const created = await api("/v1/computer", { method: "POST" });
    expect(created.status).toBe(202);
    expect(Object.keys(created.body).sort()).toEqual(["agent", "computer", "github", "plan", "slack"]);
    expect(created.body.computer).toEqual({
      state: "provisioning",
      connected: false,
      vcpus: 2,
      memoryGiB: 8,
      diskGiB: 128,
      lastError: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    // `agent.subscription` is the person's Claude subscription (work 081); nothing else may name Azure's.
    const { agent: _agent, ...rest } = created.body;
    expect(JSON.stringify(rest)).not.toMatch(FORBIDDEN);
    await settleAlarms();
    const ready = await api("/v1/computer", { method: "POST" });
    expect(ready.status).toBe(200);
    expect(ready.body.computer).toMatchObject({ state: "ready", connected: false });

    // The host: only this organization's token opens the socket.
    const token = await hostToken("test-computer-host-token-key", ACCOUNT);
    const refused = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ACCOUNT}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken("test-computer-host-token-key", "someone-else")}` },
    });
    expect(refused.status).toBe(401);
    const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ACCOUNT}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    });
    expect(upgraded.status).toBe(101);
    const socket = upgraded.webSocket!;
    socket.accept();
    const welcomed = nextMessage(socket, "welcome");
    socket.send(JSON.stringify({ t: "hello", protocol: 6, hostId: ACCOUNT, version: "test", sessions: [] }));
    const welcome = await welcomed;
    expect(welcome).toMatchObject({ protocol: CALVIN_PROTOCOL_VERSION, people: [], credentials: { slackBotToken: "" } });
    // No managed key bound for the organization yet: the shared key, on Anthropic.
    expect(welcome.credentials.anthropicBaseUrl).toBeUndefined();
    // Telemetry is off (work 054: no TELEMETRY_SIGNING_KEY): no host credential.
    expect(welcome).not.toHaveProperty("telemetryCredential");
    expect((await api("/v1/computer")).body.computer.connected).toBe(true);
    // Work 084 (review r3 P2-3): the sessions API counts the host as v4 only once its welcome went.
    await runInDurableObject(computer(), (instance: ComputerDurableObject, state) => {
      const ws = state.getWebSockets()[0]!;
      const attached = ws.deserializeAttachment() as Record<string, unknown>;
      expect(attached.welcomed).toBe(true);
      const apiHost = () => (instance as unknown as { apiHost(): { protocol: number } | undefined }).apiHost();
      ws.serializeAttachment({ ...attached, protocol: 6, welcomed: false });
      expect(apiHost()?.protocol).toBe(5);
      ws.serializeAttachment({ ...attached, protocol: 6, welcomed: true });
      expect(apiHost()?.protocol).toBe(6);
      // An attachment from before the flag was written after its welcome.
      const { welcomed: _w, ...older } = attached;
      ws.serializeAttachment({ ...older, protocol: 6 });
      expect(apiHost()?.protocol).toBe(6);
      ws.serializeAttachment(attached);
    });

    // Slack install: Slack's authorize URL with a state bound to the organization.
    const install = await api("/v1/computer/slack/install", { method: "POST" });
    expect(install.status).toBe(200);
    const authorize = new URL(install.body.url);
    expect(authorize.origin + authorize.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://app.example/api/managed-agents/computer/slack/callback");
    const state = authorize.searchParams.get("state")!;

    const forged = await SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?code=x&state=${encodeURIComponent(`${state.split(".")[0]}.${"x".repeat(43)}`)}`, { redirect: "manual" });
    expect(forged.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=invalid_state");
    const cancelled = await SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?error=access_denied&state=${state}`, { redirect: "manual" });
    expect(cancelled.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=access_denied");

    const credentialsFrame = nextMessage(socket, "credentials");
    const callback = await SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?code=good&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://app.example/computer?slack=connected");
    expect((await credentialsFrame).credentials).toMatchObject({ slackBotToken: SLACK_BOT_TOKEN, slackBotUserId: "UBOT", teamId: "T0ACME" });
    // The nonce is spent.
    const replay = await SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?code=good&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(replay.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=invalid_state");

    const linked = await api("/v1/computer");
    expect(linked.body.slack).toEqual({ installed: true, teamId: "T0ACME", botUserId: "UBOT" });
    expect(linked.text).not.toContain(SLACK_BOT_TOKEN);
    // Unlink: 204, then nothing linked.
    expect((await api("/v1/computer/slack", { method: "DELETE" })).status).toBe(204);
    const again = await api("/v1/computer/slack", { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("computer_slack_not_installed");
    expect((await api("/v1/computer")).body.slack).toEqual({ installed: false });

    // Work 054: TINYBIRD_API_URL is set here but the append token is not, so
    // telemetry is off: through all of the above, nothing reached Tinybird.
    const tinybird = (await (await fetch("https://off.tinybird.test/__posts")).json()) as { posts: unknown[] };
    expect(tinybird.posts).toEqual([]);
  });

  it("creates the computer when Slack is installed, not when the page is visited", async () => {
    // Its own organization: the `local` one above already has a computer.
    const ORG = "org_install";
    const org = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(org(), fn as never) as Promise<T>;
    const row = () => inside((instance) => instance.lifecycle.row() as { state: string } | undefined);

    // Visiting the page (GET's overview) creates nothing.
    for (let i = 0; i < 2; i += 1) expect((await org().overview(ORG)).computer).toBeNull();
    expect(await row()).toBeUndefined();

    // The install's callback: the pool is empty here, so the computer is
    // created cold. The redirect does not wait for the VM: it answers with
    // the computer provisioning, and the alarm builds it.
    const callback = await slackInstall(ORG, "join:T0INSTALL:U0INSTALLER");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://app.example/computer?slack=connected");
    const after = await org().overview(ORG);
    expect(after.slack).toEqual({ installed: true, teamId: "T0INSTALL", botUserId: "UBOT" });
    expect(after.computer).toMatchObject({ state: "provisioning", connected: false });

    // Creating again (POST /v1/computer's path) stays idempotent.
    expect(await org().ensureComputer(ORG)).toEqual({ status: 200 });
    for (let i = 0; i < 30 && (await row())?.state !== "ready"; i += 1) {
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
      await runDurableObjectAlarm(org());
    }
    expect((await row())?.state).toBe("ready");

    // Reinstalling never wakes a parked computer.
    expect(await inside((instance) => instance.lifecycle.park() as Promise<boolean>)).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
      await runDurableObjectAlarm(org());
    }
    expect((await row())?.state).toBe("parked");
    expect((await slackInstall(ORG, "join:T0INSTALL:U0INSTALLER")).headers.get("location")).toBe("https://app.example/computer?slack=connected");
    expect((await row())?.state).toBe("parked");
  });

  it("wakes a parked computer for the wire's 530, unless billing refuses it", async () => {
    const ORG = "org_wire_wake";
    const org = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(org(), fn as never) as Promise<T>;
    const row = () => inside((instance) => instance.lifecycle.row() as { state: string } | undefined);

    expect(await org().wireWake()).toBe("gone");
    expect(await slackInstall(ORG, "join:T0WIREWAKE:U0INSTALLER")).toMatchObject({ status: 302 });
    for (let i = 0; i < 30 && (await row())?.state !== "ready"; i += 1) {
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
      await runDurableObjectAlarm(org());
    }
    expect((await row())?.state).toBe("ready");
    expect(await inside((instance) => instance.lifecycle.park() as Promise<boolean>)).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
      await runDurableObjectAlarm(org());
    }
    expect((await row())?.state).toBe("parked");

    // A free trial over: it stays asleep.
    await inside((instance) => void (instance.admitForApi = async () => false));
    expect(await org().wireWake()).toBe("asleep");
    expect((await row())?.state).toBe("parked");

    await inside((instance) => void (instance.admitForApi = async () => true));
    expect(await org().wireWake()).toBe("waking");
    expect((await row())?.state).toBe("waking");
  });

  it("unpaid (work 086): retries a DM that failed, parks despite preview traffic, counts the VM gone only once it is", async () => {
    const ORG = "org_unpaid";
    const org = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(org(), fn as never) as Promise<T>;
    const row = () => inside((instance) => instance.lifecycle.row() as { state: string } | undefined);
    const day = 24 * 60 * 60_000;
    // Installed by U0GONE: Slack cannot open a DM with them.
    expect((await slackInstall(ORG, "join:T0UNPAID:U0GONE")).status).toBe(302);
    for (let i = 0; i < 30 && (await row())?.state !== "ready"; i += 1) {
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
      await runDurableObjectAlarm(org());
    }
    expect((await row())?.state).toBe("ready");
    const haltedAt = Math.floor((Date.now() - 8 * day) / 1000);
    const setting = (key: string) =>
      inside((_instance, state) => [...state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)][0]?.value);
    try {
      await inside((instance, state) => {
        instance.env.COMPUTER_UNPAID_TERMINATION = "on";
        instance.env.OPENCOMPUTER_BILLING = {
          checkAdmission: async () => ({ allowed: false, isHalted: true, haltedAt, reason: "insufficient_credits", paid: true, modelAccess: null }),
        };
        instance.terminated = [];
        instance.telemetry.vmTerminated = (days: number) => instance.terminated.push(days);
        state.storage.sql.exec("DELETE FROM settings WHERE key = 'planCheckedAt'");
      });
      // A later check reaches the installer: warned now, the VM stays a day more.
      await inside((instance) => instance.put("slackInstallerUserId", "U0INSTALLER"));
      await inside((instance) => instance.idleCheck());
      expect(Number(await setting("unpaidWarnedAt"))).toBeGreaterThan(Date.now() - 60_000);
      expect((await row())?.state).toBe("ready");
      // A day after the warning, with a preview hit a moment ago: it parks anyway.
      await inside((instance) => {
        instance.put("unpaidWarnedAt", String(Date.now() - day - 1));
        instance.put("lastActivityAt", String(Date.now()));
      });
      await inside((instance) => instance.idleCheck());
      expect((await row())?.state).toBe("parking");
      // Parking has only begun: nothing counted until the VM is gone.
      expect(await inside((instance) => instance.terminated)).toEqual([]);
      for (let i = 0; i < 10 && (await row())?.state !== "parked"; i += 1) {
        await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
        await runDurableObjectAlarm(org());
      }
      expect((await row())?.state).toBe("parked");
      expect(await inside((instance) => instance.terminated)).toEqual([8]);
      expect(await setting("unpaidParking")).toBeUndefined();
    } finally {
      await inside((instance) => {
        delete instance.env.COMPUTER_UNPAID_TERMINATION;
        delete instance.env.OPENCOMPUTER_BILLING;
      });
    }
  });

  it("bills a computer like a serverless agent: managed key, working time, credit gate", async () => {
    const ORG = "org_billed";
    const KEY = "T0BILL:C9:200.1";
    const billed = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(billed(), fn as never) as Promise<T>;
    const segments = () => billed().runtimeSegments() as Promise<Array<{ runnerKey: string; closeReason: string; quantitySeconds: number }>>;
    const until = async <T,>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
      for (let i = 0; i < 100; i += 1) {
        const value = await read();
        if (done(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("condition not reached");
    };

    // The organization's managed OpenRouter key, as the public edge binds it.
    type Accounts = { getByName(name: string): { bindManagedModelCredential(input: Record<string, string>): Promise<string> } };
    await (env as unknown as { ACCOUNTS: Accounts }).ACCOUNTS.getByName(ORG).bindManagedModelCredential({
      provider: "openrouter",
      key: "sk-or-org-billed",
      orKeyHash: "or-hash-billed",
      operationId: "op-billed",
    });
    await linkOther(ORG, "T0BILL", "U0OWNER");

    // The host gets the organization's key and OpenRouter's base URL, not the shared key.
    const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ORG}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken("test-computer-host-token-key", ORG)}` },
    });
    const socket = upgraded.webSocket!;
    socket.accept();
    const welcomed = nextMessage(socket, "welcome");
    socket.send(JSON.stringify({ t: "hello", protocol: 6, hostId: ORG, version: "test", sessions: [{ key: KEY, status: "busy" }] }));
    const { credentials } = await welcomed;
    expect(credentials.claudeOAuthToken).toBeUndefined();

    // Working time: the session reported busy at hello is billed until idle.
    await until(() => inside((instance) => instance.billing.working() as string[]), (keys) => keys.length === 1);
    socket.send(JSON.stringify({ t: "session", report: { key: KEY, status: "idle" } }));
    await until(segments, (rows) => rows.length === 1);
    // Busy again, then the host goes away: billing stops with it.
    socket.send(JSON.stringify({ t: "session", report: { key: KEY, status: "busy" } }));
    await until(() => inside((instance) => instance.billing.working() as string[]), (keys) => keys.length === 1);
    socket.close(1000, "host restart");
    const closed = await until(segments, (rows) => rows.length === 2);
    expect(closed.map((row) => [row.runnerKey, row.closeReason])).toEqual([
      [KEY, "idle"],
      [KEY, "host_disconnected"],
    ]);
    expect(await inside((instance) => instance.billing.working())).toEqual([]);

    // The credit gate: a halted free organization's message is not delivered,
    // and its thread is told once.
    await inside((instance) => {
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: async () => ({ allowed: false, isHalted: true, haltedAt: 1, reason: "insufficient_credits", paid: false, modelAccess: null }),
      };
    });
    await slackCalls(true);
    const job = { eventId: "EvB1", teamId: "T0BILL", channelId: "C9", threadTs: "300.1", messageTs: "300.1", userId: "U9", text: "<@UBOTHELD> do it", mentioned: true, receivedAt: Date.now() };
    for (const [eventId, ts] of [["EvB1", "300.1"], ["EvB2", "300.2"]] as const) {
      await billed().acceptSlackEvent(ORG, { ...job, eventId, messageTs: ts });
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
      await runDurableObjectAlarm(billed());
    }
    // Other test files share the fake Slack's call log: only this thread's calls count.
    const calls = (await slackCalls(true)).filter((call) => (call.body.channel ?? call.body.channel_id) === "C9");
    expect(calls.filter((call) => call.method === "chat.postMessage").map((call) => call.body)).toEqual([
      {
        channel: "C9",
        thread_ts: "300.1",
        text: ":information_source: You've used your free credits, so I can't take this on. Upgrade to Pro ($200/mo) at https://app.example/billing?plan=max to keep going, then mention me again.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: ":information_source: You've used your free credits, so I can't take this on. Upgrade to Pro ($200/mo) to keep going, then mention me again." } },
          {
            type: "actions",
            elements: [{ type: "button", text: { type: "plain_text", text: "Upgrade to Pro ($200/mo)" }, url: "https://app.example/billing?plan=max", action_id: "billing_link" }],
          },
        ],
      },
    ]);
    // The working status starts on accept (before the gate); each refusal resets it.
    expect(calls.filter((call) => call.method === "agents.sessions.setStatus").map((call) => call.body.status)).toEqual(["processing", "active", "processing", "active"]);
    expect(await inside((_instance, state) => [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM dispatches")][0])).toEqual({ n: 0 });
    expect(await inside((_instance, state) => [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM sessions WHERE thread_ts = '300.1'")][0])).toEqual({ n: 0 });
  });

  it("starts the working status when a message is accepted, before the credit gate and the queue", async () => {
    const ORG = "org_early_ack";
    const TEAM = "T0EARLY";
    const early = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(early(), fn as never) as Promise<T>;
    await linkOther(ORG, TEAM, "U0OWNER");
    const checks: string[] = [];
    let allowed = false;
    // Billing does not answer until the test says so: whatever Slack sees before that came before the gate.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    await inside((instance) => {
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: async (orgId: string) => {
          checks.push(orgId);
          await gate;
          return allowed
            ? { allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: null }
            : { allowed: false, isHalted: true, haltedAt: 1, reason: "insufficient_credits", paid: false, modelAccess: null };
        },
      };
    });
    const statuses = async () =>
      (await slackCalls()).filter((call) => call.method === "agents.sessions.setStatus" && call.body.channel_id === "C7").map((call) => `${call.body.thread_ts}:${call.body.status}`);
    const runQueue = async () => {
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
      await runDurableObjectAlarm(early());
    };
    const job = { eventId: "EvEarly1", teamId: TEAM, channelId: "C7", threadTs: "500.1", messageTs: "500.1", userId: "U0OWNER", text: "<@UBOTHELD> look", mentioned: true, receivedAt: Date.now() };
    await slackCalls(true);

    // Accepted: the status is on while billing has not answered (the queue may already be waiting on it).
    await early().acceptSlackEvent(ORG, job);
    for (let i = 0; i < 50 && !(await statuses()).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await statuses()).toEqual(["500.1:processing"]);
    const queued = await inside((_instance, state) => [...state.storage.sql.exec<{ payload: string }>("SELECT payload FROM slack_queue")].map((row) => JSON.parse(row.payload).acked));
    expect(queued).toEqual([true]);

    // Refused by the gate: the reset lands after the status, and nothing is delivered.
    open();
    await runQueue();
    for (let i = 0; i < 50 && (await statuses()).length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(checks).toEqual([ORG]);
    expect(await statuses()).toEqual(["500.1:processing", "500.1:active"]);

    // Admitted: the queue does not start the status a second time.
    allowed = true;
    await early().acceptSlackEvent(ORG, { ...job, eventId: "EvEarly2", threadTs: "500.2", messageTs: "500.2" });
    await runQueue();
    expect((await statuses()).filter((status) => status.startsWith("500.2"))).toEqual(["500.2:processing"]);
    expect(await inside((_instance, state) => [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM dispatches")][0])).toEqual({ n: 1 });

    // A `!` command and a reply aimed at someone else get none, on accept or later.
    await early().acceptSlackEvent(ORG, { ...job, eventId: "EvEarly3", threadTs: "500.3", messageTs: "500.3", text: "<@UBOTHELD> !secret list" });
    await early().acceptSlackEvent(ORG, { ...job, eventId: "EvEarly4", messageTs: "500.4", text: "<@U0SOMEONE> over to you", mentioned: false });
    await runQueue();
    expect((await statuses()).filter((status) => !status.startsWith("500.1") && !status.startsWith("500.2"))).toEqual([]);
    await inside((instance) => {
      delete instance.env.OPENCOMPUTER_BILLING;
    });
  });

  it("warns before the stop: the installer by DM once per warning, or the thread when the installer is unknown", async () => {
    const run = async (org: string, team: string, installer: string | undefined) => {
      const object = () => computers().getByName(org);
      const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(object(), fn as never) as Promise<T>;
      await linkOther(org, team, installer);
      await inside((instance) => {
        instance.env.OPENCOMPUTER_BILLING = {
          checkAdmission: async () => ({
            allowed: true, isHalted: false, haltedAt: null, reason: null, paid: false, modelAccess: "full", warning: "trial_minutes", warningSince: 1_800_000_000,
          }),
        };
      });
      const job = { eventId: `Ev${team}1`, teamId: team, channelId: "C6", threadTs: "600.1", messageTs: "600.1", userId: "U6", text: "<@UBOTHELD> go", mentioned: true, receivedAt: Date.now() };
      // Two messages in one thread, one in another.
      for (const [eventId, threadTs, messageTs] of [[`Ev${team}1`, "600.1", "600.1"], [`Ev${team}2`, "600.2", "600.2"], [`Ev${team}3`, "600.1", "600.3"]] as const) {
        await object().acceptSlackEvent(org, { ...job, eventId, threadTs, messageTs });
        await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
        await runDurableObjectAlarm(object());
      }
      await inside((instance) => {
        delete instance.env.OPENCOMPUTER_BILLING;
      });
    };
    const warnings = async (channel: (c: string) => boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return (await slackCalls())
        .filter((call) => call.method === "chat.postMessage" && channel(call.body.channel) && String(call.body.text).startsWith(":warning:"))
        .map((call) => ({ channel: call.body.channel, thread: call.body.thread_ts, button: call.body.blocks?.[1]?.elements?.[0]?.url }));
    };
    await slackCalls(true);

    await run("org_warned", "T0WARN", "U0WARNOWNER");
    expect(await warnings((c) => c === "D-U0WARNOWNER")).toEqual([{ channel: "D-U0WARNOWNER", thread: undefined, button: "https://app.example/billing" }]);

    // A link from before installers were kept: each thread hears it once.
    await run("org_warned_old", "T0WARNOLD", undefined);
    expect(await warnings((c) => c === "C6")).toEqual([
      { channel: "C6", thread: "600.1", button: "https://app.example/billing" },
      { channel: "C6", thread: "600.2", button: "https://app.example/billing" },
    ]);
  });

  it("keeps a warning told across a wake, retries one Slack failed to post, and tells a new installer", async () => {
    const ORG = "org_warned_again";
    const TEAM = "T0WARNAGAIN";
    const object = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(object(), fn as never) as Promise<T>;
    let n = 0;
    const message = async (threadTs: string) => {
      n += 1;
      await inside((instance) => {
        instance.env.OPENCOMPUTER_BILLING = {
          checkAdmission: async () => ({
            allowed: true, isHalted: false, haltedAt: null, reason: null, paid: false, modelAccess: "full", warning: "trial_days", warningSince: 1_800_000_100,
          }),
        };
      });
      const job = { eventId: `EvAgain${n}`, teamId: TEAM, channelId: "C7", threadTs, messageTs: `${threadTs}${n}`, userId: "U7", text: "<@UBOTHELD> go", mentioned: true, receivedAt: Date.now() };
      await object().acceptSlackEvent(ORG, job);
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
      await runDurableObjectAlarm(object());
      // Each message asks billing afresh.
      await inside((instance) => {
        delete instance.env.OPENCOMPUTER_BILLING;
        instance.put("admission", "");
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    const warned = async () =>
      (await slackCalls())
        .filter((call) => call.method === "chat.postMessage" && String(call.body.text).startsWith(":warning:"))
        .map((call) => ({ channel: call.body.channel, thread: call.body.thread_ts, ok: call.token !== `Bearer ${REVOKED_SLACK_BOT_TOKEN}` }));
    await slackCalls(true);

    // No installer and Slack refuses the post: nothing is kept, and once Slack takes posts the same thread hears it.
    await linkOther(ORG, TEAM, undefined, REVOKED_SLACK_BOT_TOKEN);
    await message("700.1");
    expect(await warned()).toEqual([{ channel: "C7", thread: "700.1", ok: false }]);
    await slackCalls(true);
    await linkOther(ORG, TEAM, undefined);
    await message("700.1");
    await message("700.1");
    expect(await warned()).toEqual([{ channel: "C7", thread: "700.1", ok: true }]);

    // The installer hears it once; a wake (onReady clears the notices) does not repeat it.
    await slackCalls(true);
    await linkOther(ORG, TEAM, "U0WARNAGAIN");
    await message("700.2");
    await inside((instance) => instance.lifecycle.deps.onReady());
    await message("700.3");
    expect(await warned()).toEqual([{ channel: "D-U0WARNAGAIN", thread: undefined, ok: true }]);

    // A new installer hears the standing warning.
    await slackCalls(true);
    await linkOther(ORG, TEAM, "U0WARNNEW");
    await message("700.4");
    expect(await warned()).toEqual([{ channel: "D-U0WARNNEW", thread: undefined, ok: true }]);
  }, 30_000);

  it("admits stale-while-revalidate: no billing call on the path, a re-check at most once a minute, refusals at once", async () => {
    const ORG = "org_cached_gate";
    const TEAM = "T0GATE";
    const gate = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(gate(), fn as never) as Promise<T>;
    await linkOther(ORG, TEAM, "U0OWNER");
    // Admission checks only (the plan asks billing too): the object's own call to billing's admission.
    let checks = 0;
    let answer: "allowed" | "fallback" | "refused" = "allowed";
    await inside((instance) => {
      const real = instance.checkAdmission.bind(instance);
      instance.checkAdmission = (accountId: string) => {
        checks += 1;
        return real(accountId);
      };
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: async () =>
          answer === "refused"
            ? { allowed: false, isHalted: true, haltedAt: 1, reason: "insufficient_credits", paid: false, modelAccess: null }
            : { allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: answer === "fallback" ? "fallback" : "full" },
      };
    });
    const dispatches = async () => (await inside((_instance, state) => [...state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dispatches")][0]!)).n;
    const stored = () => inside((instance) => instance.storedAdmission() as { allowed: boolean; checkedAt: number } | null);
    /** Ages the stored admission (and the in-memory re-check throttle) by `ms`. */
    const age = (ms: number) =>
      inside((instance) => {
        const current = instance.storedAdmission();
        instance.put("admission", JSON.stringify({ ...current, checkedAt: current.checkedAt - ms }));
        instance.admissionRecheckedAt -= ms;
      });
    let n = 0;
    const message = async () => {
      n += 1;
      const ts = `600.${n}`;
      await gate().acceptSlackEvent(ORG, { eventId: `EvGate${n}`, teamId: TEAM, channelId: "C8", threadTs: ts, messageTs: ts, userId: "U0OWNER", text: "<@UBOTHELD> go", mentioned: true, receivedAt: Date.now() });
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
      await runDurableObjectAlarm(gate());
    };
    const settled = async (read: () => Promise<unknown>, want: unknown) => {
      for (let i = 0; i < 100 && (await read()) !== want; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await read()).toBe(want);
    };

    // Nothing stored: billing is asked on the path, and its admission is stored.
    await message();
    expect(checks).toBe(1);
    expect(await dispatches()).toBe(1);
    expect(await stored()).toMatchObject({ allowed: true });

    // Fresh (under a minute): billing is not asked at all, even though it would now say no.
    answer = "refused";
    await message();
    expect(checks).toBe(1);
    expect(await dispatches()).toBe(2);

    // Stale (over a minute, under ten): served from storage, re-checked off the path; the refusal lands.
    await age(5 * 60_000);
    await message();
    expect(await dispatches()).toBe(3);
    await settled(async () => (await stored())?.allowed, false);
    expect(checks).toBe(2);

    // Refused: the next message asks billing on the path, and is refused; refusals are never served.
    await message();
    expect(checks).toBe(3);
    expect(await dispatches()).toBe(3);
    answer = "allowed";
    await message();
    expect(checks).toBe(4);
    expect(await dispatches()).toBe(4);

    // Past ten minutes an admission is asked for again on the path.
    await age(11 * 60_000);
    await message();
    expect(checks).toBe(5);
    expect(await dispatches()).toBe(5);

    // A halted paid organization (billing's fallback model) is refused like a free one: Claude Code cannot use the fallback.
    answer = "fallback";
    await age(11 * 60_000);
    await message();
    expect(await dispatches()).toBe(5);
    expect(await stored()).toMatchObject({ allowed: false });
    const spans = await inside(async (instance) => {
      const recorded: any[] = [];
      const t = {
        start: (name: string, fields: any) => ({ end: (more: any) => recorded.push({ name, ...fields, ...more }) }),
        emit: (name: string, fields: any) => recorded.push({ name, ...fields }),
      };
      expect(await instance.admitWith(t, "C8", "600.99", undefined)).toBe(false);
      return recorded;
    });
    expect(spans).toEqual([
      { name: "admission.checked", outcome: "completed", data: { cached: false, decision: "refused" } },
      { name: "billing.paywall_shown", data: { reason: "credits_exhausted", surface: "slack" } },
    ]);

    await inside((instance) => {
      delete instance.env.OPENCOMPUTER_BILLING;
      delete instance.checkAdmission;
    });
  });

  it("never lets a slow re-check overwrite a newer refusal", async () => {
    const ORG = "org_stale_recheck";
    const stale = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stale(), fn as never) as Promise<T>;
    const allowed = { allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: "full" };
    const refused = { allowed: false, isHalted: true, haltedAt: 1, reason: "insufficient_credits", paid: false, modelAccess: null };
    let release!: () => void;
    const result = await inside(async (instance) => {
      instance.bind(ORG);
      instance.put("admission", JSON.stringify({ generation: 0, allowed: true, checkedAt: Date.now() - 5 * 60_000 }));
      let call = 0;
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: () => {
          call += 1;
          // The background re-check answers "allowed", but only after the foreground refusal.
          if (call === 1) return new Promise((resolve) => (release = () => resolve(allowed)));
          return Promise.resolve(refused);
        },
      };
      instance.recheckAdmission(ORG);
      const background = instance.recheckingAdmission;
      expect((await instance.checkAdmission(ORG)).deliver).toBe(false);
      release();
      await background;
      const stored = instance.storedAdmission();
      delete instance.env.OPENCOMPUTER_BILLING;
      return stored;
    });
    expect(result).toMatchObject({ allowed: false });
  });

  it("sends without waiting on the account or GitHub, from a stored key kept current by push (work 058)", async () => {
    const ORG = "org_instant";
    const TEAM = "T0FAST";
    const fast = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(fast(), fn as never) as Promise<T>;
    type Account = {
      bindManagedModelCredential(input: Record<string, string>): Promise<string>;
      deleteManagedModelCredential(provider: string): Promise<boolean>;
    };
    const account = () => (env as unknown as { ACCOUNTS: { getByName(name: string): Account } }).ACCOUNTS.getByName(ORG);
    await account().bindManagedModelCredential({ provider: "openrouter", key: "sk-or-first", orKeyHash: "or-hash-1", operationId: "op-1" });
    await linkOther(ORG, TEAM, "U0OWNER");

    const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ORG}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken("test-computer-host-token-key", ORG)}` },
    });
    const socket = upgraded.webSocket!;
    socket.accept();
    const delivers: any[] = [];
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.t === "deliver") delivers.push(frame);
    });
    const welcomed = nextMessage(socket, "welcome");
    socket.send(JSON.stringify({ t: "hello", protocol: 6, hostId: ORG, version: "test", sessions: [] }));
    await welcomed;

    // The first lookup stored the key sealed in this object's own storage, never in plaintext.
    const stored = await inside((_instance, state) => [
      ...state.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'modelKey%' ORDER BY key"),
    ]);
    expect(stored.map((row) => row.key)).toEqual(["modelKeySealed", "modelKeyStoredAt"]);
    expect(JSON.stringify(stored)).not.toContain("sk-or-first");

    // Neither the account nor GitHub is on the message path: with both hanging, the message is still sent,
    // with the stored key, and the definition refresh (due) runs after it.
    await inside((instance) => {
      // An earlier test leaves a halted billing gate on the shared env.
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: async () => ({ allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: null }),
      };
      const real = instance.account();
      const hanging = new Set(["resolveManagedModelCredential", "listGitHubInstallations"]);
      instance.account = () =>
        new Proxy({}, { get: (_target, name: string) => (hanging.has(name) ? () => new Promise(() => {}) : (...args: unknown[]) => real[name](...args)) });
      instance.put("definitionCheckedAt", "0");
    });
    const job = { eventId: "EvFast1", teamId: TEAM, channelId: "C1", threadTs: "300.1", messageTs: "300.1", userId: "U0OWNER", text: "hi", mentioned: true, receivedAt: Date.now() };
    const delivered = nextMessage(socket, "deliver");
    await fast().acceptSlackEvent(ORG, job);
    await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
    await runDurableObjectAlarm(fast());
    await delivered;
    await inside((instance) => {
      delete instance.account;
    });

    // Two flushes that overlap send a pending dispatch once.
    delivers.length = 0;
    await inside(async (instance, state) => {
      state.storage.sql.exec("UPDATE dispatches SET state = 'pending'");
      await Promise.all([instance.flush(), instance.flush()]);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(delivers).toHaveLength(1);

    // A rebound key is pushed to the host (the edge's bind route calls modelKeyChanged).
    await account().bindManagedModelCredential({ provider: "openrouter", key: "sk-or-second", orKeyHash: "or-hash-2", operationId: "op-2" });
    const rebound = nextMessage(socket, "credentials");
    await fast().modelKeyChanged();
    await rebound;

    // A deleted key clears the copy: the host falls back to the shared key, on Anthropic.
    await account().deleteManagedModelCredential("openrouter");
    const cleared = nextMessage(socket, "credentials");
    await fast().modelKeyChanged();
    const { credentials } = await cleared;
    expect(credentials.anthropicBaseUrl).toBeUndefined();
    expect(await inside((instance) => instance.setting("modelKeySealed"))).toBeUndefined();
    socket.close();
  }, 20_000);

  it("keeps the relay's key in the fresh welcome a changed definition sends a v4 host (work 084)", async () => {
    const ORG = "org_rewelcome";
    const computer = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(computer(), fn as never) as Promise<T>;
    const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ORG}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken("test-computer-host-token-key", ORG)}` },
    });
    const socket = upgraded.webSocket!;
    socket.accept();
    const first = nextMessage(socket, "welcome");
    socket.send(JSON.stringify({ t: "hello", protocol: CALVIN_PROTOCOL_VERSION, hostId: ORG, version: "test", sessions: [], journals: [] }));
    await first;

    // A repository connected later: the refresh's welcome carries the previews key as the first one would.
    const again = nextMessage(socket, "welcome");
    await inside(async (instance) => {
      instance.put("definition", JSON.stringify({ repos: [] }));
      instance.definition = async () => ({ repos: [{ name: "opc-bench" }] });
      instance.previewWelcome = async () => ({ preview: { tunnelToken: "t", key: "wire-key", ports: [] } });
      await instance.refreshDefinition();
    });
    const welcome = await again;
    expect(welcome.definition).toEqual({ repos: [{ name: "opc-bench" }] });
    expect(welcome.wire).toEqual({ key: "wire-key" });
    socket.close();
  });

});

/** Another organization with `teamId` linked, approved by `installer` (or a link from before installers were kept). */
async function linkOther(accountId: string, teamId: string, installer: string | undefined, botToken = "xoxb-holder-token") {
  await computers().getByName(`computer-slack-team:${teamId}`).claimTeam(teamId, accountId);
  await computers()
    .getByName(accountId)
    .linkSlack(accountId, {
      teamId,
      teamName: "Held",
      botUserId: "UBOTHELD",
      botToken,
      ...(installer ? { installerUserId: installer } : {}),
    });
}

/** Slack's OAuth callback with `code` for an install `accountId` started (POST /v1/computer/slack/install, minus the edge identity). */
async function slackInstall(accountId: string, code: string): Promise<Response> {
  const nonce = randomToken();
  // The install's nonce is the Slack actor's; the link reaches the computer as `changed("slack")`.
  const installer = { org: accountId, subject: "user_installer", kind: "member", via: "dashboard", scopes: [], audiences: ["org"], admin: true, credential: { id: "test", expiresAt: null } };
  await (env as unknown as { SLACK: { getByName(name: string): { startInstall(p: unknown, nonce: string): Promise<void> } } }).SLACK.getByName(accountId).startInstall(installer, nonce);
  return SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(encodeInstallState(accountId, nonce))}`, {
    redirect: "manual",
  });
}

/** The fake's recorded Slack Web API calls; `reset` clears them. */
// The fake is shared with the other test files of this project, so a reset only moves this file's cursor:
// clearing the fake would drop calls another file is about to read.
let slackCursor = 0;

async function slackCalls(reset = false): Promise<Array<{ method: string; token: string | null; body: any }>> {
  const response = await fetch("https://slack.test/__calls");
  const all = ((await response.json()) as { calls: Array<{ method: string; token: string | null; body: any }> }).calls;
  const fresh = all.slice(slackCursor);
  if (reset) slackCursor = all.length;
  return fresh;
}
