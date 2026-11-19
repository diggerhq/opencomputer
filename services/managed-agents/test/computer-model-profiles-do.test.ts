import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";
import { modelKey } from "../src/computer/model-key.js";
import { CALVIN_MODEL_PROTOCOL, CALVIN_PROTOCOL_VERSION } from "../src/computer/protocol.js";

/**
 * Work 097, protocol 5 (design C2 and C8), in the real ComputerDurableObject:
 * a host whose hello says 5 gets its managed model as a route on a profile of
 * its model proxy, and no key in its credentials; a host that says 4 gets
 * what it always got. The host's hello decides, and nothing else.
 */

const ORIGIN = "https://managedagents.test";
const SHARED_KEY = "sk-ant-test";

type Stub = DurableObjectStub<ComputerDurableObject>;
type Account = {
  bindManagedModelCredential(input: Record<string, string>): Promise<string>;
  deleteManagedModelCredential(provider: string): Promise<boolean>;
};
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const account = (org: string) => (env as unknown as { ACCOUNTS: { getByName(name: string): Account } }).ACCOUNTS.getByName(org);
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;

const profile = (name: string, harness: string) => ({ name, vars: ["token"], harness: { [harness]: {} } });
const PROFILES = [profile("anthropic-key", "claude"), profile("openrouter", "claude")];

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

/** A linked organization whose billing gate admits it. */
async function organization(org: string, team: string): Promise<Stub> {
  await computers().getByName(`computer-slack-team:${team}`).claimTeam(team, org);
  const stub = computers().getByName(org);
  await stub.linkSlack(org, { teamId: team, teamName: "Profiles", botUserId: "UBOTPROF", botToken: "xoxb-profiles-token", installerUserId: "U0OWNER" });
  await inside(stub, (instance) => {
    instance.env = {
      ...instance.env,
      COMPUTER_API_ORGS: "*",
      // An earlier test may leave a halted billing gate on the shared env.
      OPENCOMPUTER_BILLING: { checkAdmission: async () => ({ allowed: true, isHalted: false, haltedAt: null, reason: null, paid: true, modelAccess: null }) },
    };
  });
  return stub;
}

/** The organization's host connects and says `hello`; its socket and the welcome it got. */
async function connect(org: string, hello: Record<string, unknown>): Promise<{ socket: WebSocket; welcome: any }> {
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken("test-computer-host-token-key", org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const welcomed = nextMessage(socket, "welcome");
  socket.send(JSON.stringify({ t: "hello", hostId: org, version: "test", sessions: [], journals: [], ...hello }));
  return { socket, welcome: await welcomed };
}

/** One Slack message into a new thread, as the host receives it. */
async function deliver(stub: Stub, org: string, team: string, socket: WebSocket, ts: string): Promise<any> {
  const delivered = nextMessage(socket, "deliver");
  await stub.acceptSlackEvent(org, { eventId: `EvProf${ts}`, teamId: team, channelId: "C1", threadTs: ts, messageTs: ts, userId: "U0OWNER", text: "hi", mentioned: true, receivedAt: Date.now() });
  await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0 WHERE purpose = 'slack'"));
  await runDurableObjectAlarm(stub);
  const frame = await delivered;
  socket.send(JSON.stringify({ t: "reply", id: frame.id, ok: true }));
  return frame;
}

const route = async (name: string, token: string) => ({ mode: "profile", profile: name, vars: { token }, key: await modelKey(name, { token }) });

describe("a host at protocol 5", () => {
  it("gets the managed model as a profile route, never as a key in its credentials", async () => {
    const ORG = "org_profiles";
    const TEAM = "T0PROFILES";
    await account(ORG).bindManagedModelCredential({ provider: "openrouter", key: "sk-or-profiles", orKeyHash: "or-hash-p1", operationId: "op-p1" });
    const stub = await organization(ORG, TEAM);

    const { socket, welcome } = await connect(ORG, { protocol: CALVIN_MODEL_PROTOCOL, profiles: PROFILES });
    expect(welcome.protocol).toBe(CALVIN_MODEL_PROTOCOL);
    expect(welcome.credentials).not.toHaveProperty("anthropicApiKey");
    expect(welcome.credentials).not.toHaveProperty("anthropicBaseUrl");
    expect(welcome.models).toEqual({ claude: await route("openrouter", "sk-or-profiles") });

    // A session's route is its delivery's `model`, else `models[harness]` (C2). The public build sends none of
    // its own; an implementation that routes sessions may. The organization's key either way.
    const frame = await deliver(stub, ORG, TEAM, socket, "500.1");
    expect(frame.model ?? welcome.models.claude).toEqual(await route("openrouter", "sk-or-profiles"));
    expect(frame.session.harness ?? "claude").toBe("claude");
    expect(JSON.stringify(frame.credentials)).not.toContain("sk-or-profiles");

    // What the proxy observed and bound is the hosted implementation's business: nothing answers, nothing breaks.
    const key = welcome.models.claude.key;
    socket.send(JSON.stringify({ t: "model-bound", sessionKey: frame.session.key, mode: "profile", profile: "openrouter", key }));
    socket.send(JSON.stringify({ t: "model-observed", sessionKey: frame.session.key, key, profile: "openrouter", status: 401, headers: {} }));
    socket.send(JSON.stringify({ t: "model-response", id: "nobody-asked", status: 200 }));

    // A deleted key: the shared one, on its own profile, pushed like any credential change.
    await account(ORG).deleteManagedModelCredential("openrouter");
    const pushed = nextMessage(socket, "credentials");
    await stub.modelKeyChanged();
    const credentials = await pushed;
    expect(credentials.models).toEqual({ claude: await route("anthropic-key", SHARED_KEY) });
    expect(JSON.stringify(credentials.credentials)).not.toContain(SHARED_KEY);
    socket.close();
  }, 20_000);

  it("is refused, in the backend's words, a profile its hello does not list", async () => {
    const ORG = "org_profiles_unlisted";
    await account(ORG).bindManagedModelCredential({ provider: "openrouter", key: "sk-or-unlisted", orKeyHash: "or-hash-p2", operationId: "op-p2" });
    await organization(ORG, "T0PROFUNL");

    const listed = await connect(ORG, { protocol: CALVIN_MODEL_PROTOCOL, profiles: [profile("anthropic-key", "claude")] });
    expect(listed.welcome.models).toEqual({ claude: { mode: "refuse", reason: "This computer has no model profile `openrouter`." } });

    // The same host with its model proxy down says no profiles: the last list stands.
    const again = nextMessage(listed.socket, "welcome");
    listed.socket.send(JSON.stringify({ t: "hello", protocol: CALVIN_MODEL_PROTOCOL, hostId: ORG, version: "test", sessions: [], journals: [] }));
    expect((await again).models.claude.mode).toBe("refuse");

    // The proxy back, with the profile: the route.
    const back = nextMessage(listed.socket, "welcome");
    listed.socket.send(JSON.stringify({ t: "hello", protocol: CALVIN_MODEL_PROTOCOL, hostId: ORG, version: "test", sessions: [], journals: [], profiles: PROFILES }));
    expect((await back).models).toEqual({ claude: await route("openrouter", "sk-or-unlisted") });
    listed.socket.close();
  }, 20_000);

  it("lists the harnesses its profiles serve", async () => {
    const ORG = "org_profiles_harness";
    const stub = await organization(ORG, "T0PROFHAR");
    const harnesses = () => inside(stub, (instance) => instance.harnesses() as string[]);

    const first = await connect(ORG, { protocol: CALVIN_MODEL_PROTOCOL, profiles: PROFILES });
    expect(await harnesses()).toEqual(["claude"]);
    const again = nextMessage(first.socket, "welcome");
    first.socket.send(JSON.stringify({ t: "hello", protocol: CALVIN_MODEL_PROTOCOL, hostId: ORG, version: "test", sessions: [], journals: [], profiles: [...PROFILES, profile("openai-key", "codex")] }));
    await again;
    expect(await harnesses()).toEqual(["claude", "codex"]);
    first.socket.close();
  });
});

describe("a host at protocol 4, after one at 5", () => {
  it("gets protocol 4's welcome and delivery: the key in its credentials, no route", async () => {
    const ORG = "org_profiles_back";
    const TEAM = "T0PROFBACK";
    const stub = await organization(ORG, TEAM);

    const five = await connect(ORG, { protocol: CALVIN_MODEL_PROTOCOL, profiles: PROFILES });
    expect(five.welcome.models).toEqual({ claude: await route("anthropic-key", SHARED_KEY) });
    five.socket.close();

    const four = await connect(ORG, { protocol: CALVIN_PROTOCOL_VERSION, features: ["model-proxy"] });
    expect(four.welcome.protocol).toBe(CALVIN_PROTOCOL_VERSION);
    expect(four.welcome.credentials.anthropicApiKey).toBe(SHARED_KEY);
    expect(four.welcome).not.toHaveProperty("models");
    const frame = await deliver(stub, ORG, TEAM, four.socket, "501.1");
    expect(frame.credentials.anthropicApiKey).toBe(SHARED_KEY);
    expect(frame).not.toHaveProperty("model");
    // The profiles went with the host that listed them.
    expect(await inside(stub, (instance) => instance.setting("hostProfiles"))).toBeUndefined();
    four.socket.close();
  }, 20_000);
});
