import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

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
const SIGNING_SECRET = "computer-signing-secret";
const FORBIDDEN = /azure|eastus|westus|Standard_|D2as|oc-local|managedagents\.test|subscription|resourceGroup/i;

type Namespace = DurableObjectNamespace<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: Namespace }).COMPUTERS;
const computer = () => computers().getByName(ACCOUNT);

async function api(path: string, init: RequestInit = {}) {
  const response = await SELF.fetch(`${ORIGIN}${path}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? (JSON.parse(text) as any) : null };
}

async function signed(path: string, body: string, contentType = "application/json") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const signature = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body,
  });
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
    socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: ACCOUNT, version: "test", sessions: [] }));
    const welcome = await welcomed;
    expect(welcome).toMatchObject({ protocol: CALVIN_PROTOCOL_VERSION, people: [], credentials: { slackBotToken: "", anthropicApiKey: "sk-ant-test" } });
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
      ws.serializeAttachment({ ...attached, protocol: 4, welcomed: false });
      expect(apiHost()?.protocol).toBe(3);
      ws.serializeAttachment({ ...attached, protocol: 4, welcomed: true });
      expect(apiHost()?.protocol).toBe(4);
      // An attachment from before the flag was written after its welcome.
      const { welcomed: _w, ...older } = attached;
      ws.serializeAttachment({ ...older, protocol: 4 });
      expect(apiHost()?.protocol).toBe(4);
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
    expect(linked.body.slack).toEqual({ installed: true, teamId: "T0ACME", teamName: "Acme", botUserId: "UBOT" });
    expect(linked.text).not.toContain(SLACK_BOT_TOKEN);
    // Who approved the install is kept, to ask them when someone else tries to link it.
    expect(
      await runInDurableObject(computer(), (_instance, state) =>
        [...state.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = 'slackInstallerUserId'")][0]?.value,
      ),
    ).toBe("U0INSTALLER");
    // One workspace, one organization.
    expect(await computers().getByName("computer-slack-team:T0ACME").claimTeam("T0ACME", "org_other")).toEqual({ ok: false, holder: ACCOUNT });

    // Slack events: signature first, url_verification, then a mention becomes a delivery.
    const unsigned = await SELF.fetch(`${ORIGIN}/v1/webhooks/computer/slack/events`, { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(401);
    const challenge = await signed("/v1/webhooks/computer/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc" }));
    expect(await challenge.json()).toEqual({ challenge: "abc" });

    const event = {
      type: "event_callback",
      event_id: "Ev1",
      team_id: "T0ACME",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> fix the build", ts: "100.1" },
    };
    expect((await signed("/v1/webhooks/computer/slack/events", JSON.stringify(event))).status).toBe(200);
    // The edge hands the event over after answering; hand it over here too (the dedup makes it once).
    const job = { eventId: "Ev1", teamId: "T0ACME", channelId: "C1", threadTs: "100.1", messageTs: "100.1", userId: "U1", text: "<@UBOT> fix the build", mentioned: true, receivedAt: Date.now() };
    // Work 068: the accept drains the queue inline, so the frame may come before any alarm.
    const delivered = nextMessage(socket, "deliver");
    await computer().acceptSlackEvent(ACCOUNT, job);
    expect(await computer().acceptSlackEvent(ACCOUNT, { ...job, eventId: "Ev2" })).toEqual({ accepted: false });
    await runInDurableObject(computer(), (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
    await runDurableObjectAlarm(computer());
    const deliver = await delivered;
    expect(deliver).toMatchObject({
      session: { key: "T0ACME:C1:100.1", kind: "thread", channel: "C1", threadTs: "100.1", owner: { slackUserId: "U1" }, mode: "bypassPermissions" },
      msg: { userId: "U1", text: "fix the build", ts: "100.1", mentioned: true },
      credentials: { slackBotToken: SLACK_BOT_TOKEN },
      secrets: [],
    });
    socket.send(JSON.stringify({ t: "session", report: { key: "T0ACME:C1:100.1", status: "busy", speed: "standard" } }));
    socket.send(JSON.stringify({ t: "reply", id: deliver.id, ok: true }));

    // A token request with no GitHub connected answers with a clear error.
    const tokenAnswer = nextMessage(socket, "token");
    socket.send(JSON.stringify({ t: "token", id: "tok1", repos: ["acme/api"] }));
    expect(await tokenAnswer).toEqual({ t: "token", id: "tok1", error: expect.stringMatching(/GitHub is not connected/) });

    // An OpenComputer key carries the session the host names only when it is
    // a live session of this workspace (work 080).
    const named = await runInDurableObject(computer(), ((instance: any) =>
      ["T0ACME:C1:100.1", "T0ACME:C1:999.9", "T0OTHER:C1:100.1", 42].map((key) => instance.liveSessionKey(key))) as never);
    expect(named).toEqual(["T0ACME:C1:100.1", undefined, undefined, undefined]);
    // Connection grants are for that session and the Slack user who owns it.
    expect(await computer().grantAudience("T0ACME:C1:100.1")).toEqual({ sessionKey: "T0ACME:C1:100.1", ownerId: "U1" });
    expect(await computer().grantAudience("T0ACME:C1:999.9")).toBeNull();
    // A runner's reported speed (a `!speed` change) is kept, so the next delivery starts with it.
    const speed = await runInDurableObject(computer(), (_instance, state) =>
      [...state.storage.sql.exec<{ speed: string | null }>("SELECT speed FROM sessions WHERE runner_key = ?", "T0ACME:C1:100.1")][0]?.speed,
    );
    expect(speed).toBe("standard");

    const sessions = await api("/v1/computer/sessions");
    expect(sessions.body).toEqual({
      sessions: [
        {
          key: "T0ACME:C1:100.1",
          title: "fix the build",
          channelId: "C1",
          threadTs: "100.1",
          ownerSlackUserId: "U1",
          status: "busy",
          updatedAt: expect.any(String),
          slackUrl: "https://app.slack.com/client/T0ACME/C1/thread/C1-100.1",
        },
      ],
    });

    // Parking (decision 10): with the host gone and the computer parked, a
    // reply in the thread wakes it, says so once, and waits in the queue.
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(computer(), fn as never) as Promise<T>;
    await inside((_instance, state) => {
      for (const ws of state.getWebSockets()) ws.close(1000, "test");
      state.storage.sql.exec("UPDATE sessions SET status = 'idle'");
    });
    socket.close();
    expect(await inside((instance) => instance.lifecycle.park())).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
      await runDurableObjectAlarm(computer());
    }
    expect((await api("/v1/computer")).body.computer).toMatchObject({ state: "parked", connected: false });
    for (const [eventId, ts] of [["Ev3", "100.2"], ["Ev4", "100.3"]] as const) {
      await computer().acceptSlackEvent(ACCOUNT, { ...job, eventId, messageTs: ts, text: "and the tests too", mentioned: false });
    }
    await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
    await runDurableObjectAlarm(computer());
    expect((await api("/v1/computer")).body.computer.state).toBe("waking");
    expect(await inside((_instance, state) => [...state.storage.sql.exec("SELECT thread_key AS t, kind FROM notices")])).toEqual([
      { t: "C1:100.1", kind: "waking" },
    ]);
    expect(await inside((_instance, state) => [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM dispatches WHERE state = 'pending'")][0])).toEqual({ n: 2 });
    await settleAlarms();
    expect((await api("/v1/computer")).body.computer.state).toBe("ready");

    // Unlink: 204, then nothing linked; the workspace is free for another organization.
    expect((await api("/v1/computer/slack", { method: "DELETE" })).status).toBe(204);
    const again = await api("/v1/computer/slack", { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("computer_slack_not_installed");
    expect((await api("/v1/computer")).body.slack).toEqual({ installed: false });
    expect(await computers().getByName("computer-slack-team:T0ACME").claimTeam("T0ACME", "org_other")).toEqual({ ok: true });

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
    expect(after.slack).toEqual({ installed: true, teamId: "T0INSTALL", teamName: "Acme", botUserId: "UBOT" });
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
      // Day 8, never warned: the DM fails, so no warning is recorded and the VM stays.
      await inside((instance) => instance.idleCheck());
      expect(await setting("unpaidWarnedAt")).toBeUndefined();
      expect((await row())?.state).toBe("ready");
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

  it("links Slack even when the computer cannot be created on install", async () => {
    const ORG = "org_install_broken";
    // Computers not configured for this object: the claim fails, the install does not.
    await runInDurableObject(computers().getByName(ORG), ((instance: any) => {
      instance.env.COMPUTER_HOST_GATEWAY_URL = "";
    }) as never);
    const callback = await slackInstall(ORG, "join:T0BROKEN:U0INSTALLER");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://app.example/computer?slack=connected");
    const after = await computers().getByName(ORG).overview(ORG);
    expect(after.slack.installed).toBe(true);
    expect(after.computer).toBeNull();
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
    socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: ORG, version: "test", sessions: [{ key: KEY, status: "busy" }] }));
    const { credentials } = await welcomed;
    expect(credentials).toMatchObject({ anthropicApiKey: "sk-or-org-billed", anthropicBaseUrl: "https://openrouter.ai/api" });
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

  it("takes the working status or 👀 off a message that is never dispatched, from the queue row", async () => {
    const ORG = "org_ack_withdraw";
    const TEAM = "T0WITHDRAW";
    const org = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(org(), fn as never) as Promise<T>;
    await linkOther(ORG, TEAM, "U0OWNER");
    let mode: "down" | "refused" = "down";
    await inside((instance) => {
      instance.env.OPENCOMPUTER_BILLING = {
        checkAdmission: async () => {
          if (mode === "down") throw new Error("billing down");
          return { allowed: false, isHalted: true, haltedAt: 1, reason: "insufficient_credits", paid: false, modelAccess: null };
        },
      };
    });
    const runQueue = async () => {
      await inside((_instance, state) => {
        state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'");
        state.storage.sql.exec("UPDATE slack_queue SET available_at = 0 WHERE state = 'pending'");
      });
      await runDurableObjectAlarm(org());
    };
    const calls = async (channel: string) =>
      (await slackCalls()).filter((call) => (call.body.channel_id ?? call.body.channel) === channel && call.method !== "chat.postMessage").map((call) => `${call.method}:${call.body.status ?? call.body.name}`);
    const job = { teamId: TEAM, userId: "U0OWNER", text: "<@UBOTHELD> go", mentioned: true };
    const until = async (read: () => Promise<string[]>, length: number) => {
      for (let i = 0; i < 100 && (await read()).length < length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await slackCalls(true);

    // Billing down on every attempt: the job fails for good, and the status comes off.
    await org().acceptSlackEvent(ORG, { ...job, eventId: "EvW1", channelId: "CWITHDRAW", threadTs: "700.1", messageTs: "700.1", receivedAt: Date.now() });
    await until(() => calls("CWITHDRAW"), 1);
    for (let attempt = 0; attempt < 5; attempt += 1) await runQueue();
    expect(await inside((_instance, state) => [...state.storage.sql.exec("SELECT state FROM slack_queue")].map((row) => row.state))).toEqual(["failed"]);
    expect(await calls("CWITHDRAW")).toEqual(["agents.sessions.setStatus:processing", "agents.sessions.setStatus:active"]);

    // Where the status is unavailable (👀): retried once, the object's memory lost, then refused: the 👀 comes off.
    await org().acceptSlackEvent(ORG, { ...job, eventId: "EvW2", channelId: "CNOSTATUS1", threadTs: "700.2", messageTs: "700.2", receivedAt: Date.now() });
    await until(() => calls("CNOSTATUS1"), 2);
    expect(await inside((_instance, state) => JSON.parse([...state.storage.sql.exec<{ payload: string }>("SELECT payload FROM slack_queue WHERE state = 'pending'")][0]!.payload).ackIndicator)).toBe("reaction");
    await runQueue();
    await inside((instance) => instance.acks.clear());
    mode = "refused";
    await runQueue();
    expect(await calls("CNOSTATUS1")).toEqual([
      "agents.sessions.setStatus:processing",
      "reactions.add:eyes",
      "agents.sessions.setStatus:active",
      "reactions.remove:eyes",
    ]);
    await inside((instance) => {
      delete instance.env.OPENCOMPUTER_BILLING;
    });
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
    socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: ORG, version: "test", sessions: [] }));
    expect((await welcomed).credentials.anthropicApiKey).toBe("sk-or-first");

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
    expect((await delivered).credentials.anthropicApiKey).toBe("sk-or-first");
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
    expect((await rebound).credentials.anthropicApiKey).toBe("sk-or-second");

    // A deleted key clears the copy: the host falls back to the shared key, on Anthropic.
    await account().deleteManagedModelCredential("openrouter");
    const cleared = nextMessage(socket, "credentials");
    await fast().modelKeyChanged();
    const { credentials } = await cleared;
    expect(credentials.anthropicApiKey).toBe("sk-ant-test");
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

  it("holds an organization at v3 until COMPUTER_API_ORGS names it (work 084 rollout gate)", async () => {
    const ORG = "org_gate";
    const TEAM = "T0GATE";
    const gated = () => computers().getByName(ORG);
    const inside = <T,>(fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(gated(), fn as never) as Promise<T>;
    await linkOther(ORG, TEAM, "U0OWNER");
    const member = "usr_01jabcdefghjkmnpqrstvwxyz0";
    const apiCaller = { member, userId: "user_GATE", name: "Owner", email: null, via: "opc", client: "opc/0.1.0", scopes: ["sessions:read", "sessions:write"], requestId: "req_gate" } as const;

    /** One host connection under `setting`, saying `protocol`: its welcome, recorded protocol, an API call and a Slack delivery. */
    async function connect(setting: string, protocol: number, n: number) {
      await inside((instance) => {
        instance.env = {
          ...instance.env,
          COMPUTER_API_ORGS: setting,
          // An earlier test leaves a halted billing gate on the shared env.
          OPENCOMPUTER_BILLING: { checkAdmission: async () => ({ allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: null }) },
        };
      });
      const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${ORG}`, {
        headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken("test-computer-host-token-key", ORG)}` },
      });
      const socket = upgraded.webSocket!;
      socket.accept();
      const frames: any[] = [];
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)));
      });
      const welcomed = nextMessage(socket, "welcome");
      socket.send(JSON.stringify({ t: "hello", protocol, hostId: ORG, version: "test", sessions: [], journals: [] }));
      const welcome = await welcomed;
      const recorded = await inside((_instance, state) => (state.getWebSockets()[0]!.deserializeAttachment() as { protocol: number }).protocol);
      const listed = (await gated().computerApi(ORG, apiCaller as never, { op: "list", query: [] })) as { status: number; error?: unknown };
      const job = { eventId: `EvGate${n}`, teamId: TEAM, channelId: "C1", threadTs: "400.1", messageTs: `400.${n + 1}`, userId: "U0OWNER", text: "hi", mentioned: true, receivedAt: Date.now() };
      const delivered = nextMessage(socket, "deliver");
      await gated().acceptSlackEvent(ORG, job);
      await inside((_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
      await runDurableObjectAlarm(gated());
      const deliver = await delivered;
      socket.send(JSON.stringify({ t: "reply", id: deliver.id, ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.close();
      const { id: _id, msg: { ts: _ts, ...msg }, ...rest } = deliver;
      return { welcome, recorded, listed, deliver: { ...rest, msg }, access: frames.filter((f) => f.t === "access") };
    }

    // A v3 host, gate off: the baseline.
    const v3 = await connect("", 3, 0);
    // A v4 host, gate off (empty, or a list without this organization): exactly the v3 host's welcome, delivery and silence.
    const off = await connect("org_someone_else", 4, 1);
    // (`people` grows with the first thread's owner, after the baseline's welcome.)
    expect({ ...off.welcome, people: [] }).toEqual({ ...v3.welcome, people: [] });
    expect(off.welcome.protocol).toBe(3);
    expect(off.welcome).not.toHaveProperty("wire");
    expect(off.recorded).toBe(3);
    expect(off.listed).toMatchObject({ status: 409, error: { code: "feature_unavailable", feature: "sessions" } });
    expect(off.deliver).toEqual(v3.deliver);
    expect(off.deliver.session).not.toHaveProperty("sessionId");
    expect(off.access).toEqual([]);

    // Named (or `*`): v4 at the next hello; Slack deliveries carry the session's API id.
    const on = await connect(`org_someone_else, ${ORG}`, 4, 2);
    expect(on.welcome.protocol).toBe(CALVIN_PROTOCOL_VERSION);
    expect(on.recorded).toBe(4);
    expect(on.listed.status).toBe(200);
    expect(on.deliver.session).toMatchObject({ key: v3.deliver.session.key, sessionId: expect.stringMatching(/^cs_/), origin: { type: "slack" } });
    const { epoch, lastSeq, ...onRest } = on.deliver;
    expect({ epoch, lastSeq }).toEqual({ epoch: 1, lastSeq: 0 });
    expect({ ...onRest, session: v3.deliver.session }).toEqual(v3.deliver);
    expect(off.deliver).not.toHaveProperty("epoch");

    // Flipped back off: v3 again at the next hello, the API refuses again.
    const back = await connect("", 4, 3);
    expect(back.welcome.protocol).toBe(3);
    expect(back.recorded).toBe(3);
    expect(back.listed.status).toBe(409);
    expect(back.deliver.session).not.toHaveProperty("sessionId");
    expect(back.access).toEqual([]);
  }, 20_000);

  it("refuses a Slack workspace already linked to another organization", async () => {
    // Claimed by an organization whose object holds no link: nobody to ask.
    await computers().getByName("computer-slack-team:T0OTHER").claimTeam("T0OTHER", "org_other");
    const callback = await callbackWith("other-team");
    expect(callback.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=team_already_linked&notified=0");
    expect((await api("/v1/computer")).body.slack.installed).toBe(false);
  });

  it("DMs the requester and the installer with the holder's token, once a day, and never links", async () => {
    await linkOther("org_holder", "T0HELD", "U0OWNER");
    await joinCalls(true);

    const first = await callbackWith("join:T0HELD:U0NEWBIE");
    expect(first.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=team_already_linked&notified=1");
    expect(first.headers.get("location")).not.toMatch(/org_holder|T0HELD/);
    expect((await api("/v1/computer")).body.slack.installed).toBe(false);
    expect(await computers().getByName("computer-slack-team:T0HELD").teamAccount()).toBe("org_holder");

    const all = await slackCalls(true);
    const calls = all.filter((call) => call.token === "Bearer xoxb-holder-token");
    expect(calls.map((call) => [call.method, call.body.users ?? call.body.channel])).toEqual([
      // The holder's token is alive: the workspace stays theirs.
      ["auth.test", undefined],
      ["conversations.open", "U0NEWBIE"],
      ["chat.postMessage", "D-U0NEWBIE"],
      ["conversations.open", "U0OWNER"],
      ["chat.postMessage", "D-U0OWNER"],
    ]);
    // The holder's token, never the one this install was granted.
    for (const call of all.filter((call) => /U0NEWBIE|U0OWNER/.test(String(call.body.users ?? call.body.channel)))) {
      expect(call.token).toBe("Bearer xoxb-holder-token");
    }
    expect(calls[2]!.body.text).toBe(
      "This Slack workspace already works with OpenComputer, set up by <@U0OWNER>. We've let them know you'd like to join, so look out for an invite.",
    );
    expect(calls[4]!.body.text).toBe(
      "<@U0NEWBIE> just tried to set up OpenComputer for this workspace. It's already yours: invite them to your organization so they can use the computer with you: https://app.example/settings",
    );

    // Again within a day: the same answer, no more DMs.
    const again = await callbackWith("join:T0HELD:U0NEWBIE");
    expect(again.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=team_already_linked&notified=1");
    expect((await joinCalls(true)).map((call) => call.method)).toEqual(["auth.test"]);

    // A day later, or another person: DMs again.
    await runInDurableObject(computers().getByName("org_holder"), (_instance, state) =>
      state.storage.sql.exec("UPDATE join_requests SET notified_at = notified_at - 86400001"),
    );
    await callbackWith("join:T0HELD:U0NEWBIE");
    expect((await joinCalls(true)).length).toBe(5);
    await callbackWith("join:T0HELD:U0SECOND");
    expect((await joinCalls(true)).map((call) => call.body.users).filter(Boolean)).toEqual(["U0SECOND", "U0OWNER"]);
  });

  it("only tells the requester when nobody is known to have linked the workspace", async () => {
    await linkOther("org_legacy", "T0LEGACY", undefined);
    await joinCalls(true);
    const callback = await callbackWith("join:T0LEGACY:U0NEWBIE");
    expect(callback.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=team_already_linked&notified=0");
    const calls = await joinCalls(true);
    expect(calls.map((call) => call.method)).toEqual(["auth.test", "conversations.open", "chat.postMessage"]);
    expect(calls[2]!.body.text).toBe("This Slack workspace already works with OpenComputer. Ask a teammate who uses it to invite you.");
  });

  it("does not fail the redirect when a DM cannot be sent", async () => {
    await linkOther("org_gone", "T0GONE", "U0GONE");
    await joinCalls(true);
    const callback = await callbackWith("join:T0GONE:U0NEWBIE");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://app.example/computer?slack=error&reason=team_already_linked&notified=0");
    expect((await joinCalls(true)).map((call) => call.method)).toEqual(["auth.test", "conversations.open", "chat.postMessage", "conversations.open"]);
  });

  it("frees a workspace whose holder uninstalled the app, and links it", async () => {
    await linkOther("org_uninstalled", "T0FREED", "U0OWNER", REVOKED_SLACK_BOT_TOKEN);
    await joinCalls(true);
    const callback = await callbackWith("join:T0FREED:U0NEWBIE");
    expect(callback.headers.get("location")).toBe("https://app.example/computer?slack=connected");
    expect((await api("/v1/computer")).body.slack).toEqual({ installed: true, teamId: "T0FREED", teamName: "Acme", botUserId: "UBOT" });
    expect(await computers().getByName("computer-slack-team:T0FREED").teamAccount()).toBe(ACCOUNT);
    expect((await computers().getByName("org_uninstalled").overview("org_uninstalled")).slack).toEqual({ installed: false });
    // Only the dead token was tried; nobody was DMed with it.
    expect((await joinCalls(true)).map((call) => [call.method, call.token])).toEqual([["auth.test", `Bearer ${REVOKED_SLACK_BOT_TOKEN}`]]);
  });

  it("unlinks on app_uninstalled and tokens_revoked only when Slack says the token is dead", async () => {
    const uninstalled = (teamId: string, eventId: string) =>
      signed("/v1/webhooks/computer/slack/events", JSON.stringify({ type: "event_callback", event_id: eventId, team_id: teamId, event: { type: "app_uninstalled" } }));

    // A live token: the event changes nothing (it could be stale or replayed).
    await linkOther("org_live", "T0LIVE", "U0OWNER");
    expect((await uninstalled("T0LIVE", "EvU1")).status).toBe(200);
    await vi.waitFor(async () => expect((await slackCalls()).map((call) => call.method)).toContain("auth.test"));
    expect(await computers().getByName("computer-slack-team:T0LIVE").teamAccount()).toBe("org_live");
    expect((await computers().getByName("org_live").overview("org_live")).slack.installed).toBe(true);

    // A dead token: unlinked, and the workspace is free.
    await linkOther("org_dead", "T0DEAD", "U0OWNER", REVOKED_SLACK_BOT_TOKEN);
    expect((await uninstalled("T0DEAD", "EvU2")).status).toBe(200);
    await vi.waitFor(async () => expect(await computers().getByName("computer-slack-team:T0DEAD").teamAccount()).toBeNull());
    expect((await computers().getByName("org_dead").overview("org_dead")).slack).toEqual({ installed: false });

    // tokens_revoked for the bot does the same.
    await linkOther("org_revoked", "T0REVOKED", "U0OWNER", REVOKED_SLACK_BOT_TOKEN);
    const revoked = { type: "event_callback", event_id: "EvR1", team_id: "T0REVOKED", event: { type: "tokens_revoked", tokens: { bot: ["UBOTHELD"] } } };
    expect((await signed("/v1/webhooks/computer/slack/events", JSON.stringify(revoked))).status).toBe(200);
    await vi.waitFor(async () => expect(await computers().getByName("computer-slack-team:T0REVOKED").teamAccount()).toBeNull());
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

/** Starts an install as the `local` organization and returns Slack's callback with `code`. */
async function callbackWith(code: string) {
  const install = await api("/v1/computer/slack/install", { method: "POST" });
  const state = new URL(install.body.url).searchParams.get("state")!;
  return SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { redirect: "manual" });
}

/** Slack's OAuth callback with `code` for an install `accountId` started (POST /v1/computer/slack/install, minus the edge identity). */
async function slackInstall(accountId: string, code: string): Promise<Response> {
  const nonce = randomToken();
  await computers().getByName(accountId).startSlackInstall(accountId, "user_installer", nonce);
  return SELF.fetch(`${ORIGIN}/v1/computer/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(encodeInstallState(accountId, nonce))}`, {
    redirect: "manual",
  });
}

/** The fake's recorded Slack Web API calls; `reset` clears them. */
/**
 * Slack calls a join callback made: those with a held workspace's token.
 * Other test files share the fake Slack and run in parallel; their calls
 * (status updates, user lookups) carry their own tokens.
 */
async function joinCalls(reset = false): Promise<Array<{ method: string; token: string | null; body: any }>> {
  const held = new Set(["Bearer xoxb-holder-token", `Bearer ${REVOKED_SLACK_BOT_TOKEN}`]);
  return (await slackCalls(reset)).filter((call) => call.token !== null && held.has(call.token));
}

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
