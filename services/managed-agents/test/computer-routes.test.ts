import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/actors/computer/durable-object.js";
import { randomToken } from "../src/crypto/seal.js";
import { hostToken } from "../src/actors/computer/host-link/host-token.js";
import { CALVIN_PROTOCOL_VERSION } from "../src/host-protocol/protocol.js";
import { encodeInstallState } from "../src/slack-api/web-api.js";
import { SLACK_BOT_TOKEN } from "./fixtures/computer-fakes.mjs";
import { linkSlack } from "./fixtures/computer-link.js";

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
      const apiHost = () => (instance as unknown as { apiHost(): object | undefined }).apiHost();
      ws.serializeAttachment({ ...attached, welcomed: false });
      expect(apiHost()).toBeUndefined();
      ws.serializeAttachment({ ...attached, welcomed: true });
      expect(apiHost()).toBeDefined();
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
    expect(after.slack).toEqual({ installed: true, teamId: "T0INSTALL", teamName: "Acme", botUserId: "UBOT" });
    // Slack.forHost names the installer and the team (the day-6 unpaid DM goes to the installer).
    expect(await inside((instance) => [instance.setting("slackInstallerUserId"), instance.setting("slackTeamName")])).toEqual(["U0INSTALLER", "Acme"]);
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
    await inside((instance) => void (instance.admission = async () => ({ deliver: false })));
    expect(await org().wireWake()).toBe("asleep");
    expect((await row())?.state).toBe("parked");

    await inside((instance) => void (instance.admission = async () => ({ deliver: true })));
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

  it("a drain sends repositories connected after the hello, at most once a minute by the stored check time", async () => {
    const ORG = "org_drain_refresh";
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

    // Checked just now: a drain does not look again.
    const reads = await inside(async (instance) => {
      let n = 0;
      instance.put("definition", JSON.stringify({ repos: [] }));
      instance.put("definitionCheckedAt", String(Date.now()));
      instance.definition = async () => (n++, { repos: [{ name: "connected-later" }] });
      await instance.drain("cs_0000000000000000");
      await new Promise((r) => setTimeout(r, 20));
      return n;
    });
    expect(reads).toBe(0);

    // A minute later: the next drain re-reads them and the host gets a fresh welcome.
    const again = nextMessage(socket, "welcome");
    await inside(async (instance) => {
      instance.put("definitionCheckedAt", String(Date.now() - 61_000));
      instance.definition = async () => ({ repos: [{ name: "connected-later" }] });
      instance.previewWelcome = async () => ({ preview: { tunnelToken: "t", key: "wire-key", ports: [] } });
      await instance.drain("cs_0000000000000000");
    });
    expect((await again).definition).toEqual({ repos: [{ name: "connected-later" }] });
    expect(Number(await inside((instance) => instance.setting("definitionCheckedAt")))).toBeGreaterThan(Date.now() - 10_000);
    socket.close();
  });

});

/** Another organization with `teamId` linked, approved by `installer`. */
async function linkOther(accountId: string, teamId: string, installer: string | undefined, botToken = "xoxb-holder-token") {
  await linkSlack(computers().getByName(accountId) as unknown as DurableObjectStub, accountId, {
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

