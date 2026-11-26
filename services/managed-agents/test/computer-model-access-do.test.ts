import { env, runInDurableObject } from "cloudflare:test";
import type { ApiRequest } from "../src/computer/sessions-api.js";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";

type Stub = DurableObjectStub<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error(`${what} not reached`);
}

it("tracks web sessions on the linked subscription for refreshes and reconnects", async () => {
  const stub = computers().getByName("org_web_subscription_tracking");
  const tracked = await inside(stub, (instance, state) => {
    const member = "usr_01jabcdefghjkmnpqrstvwxyz0";
    const key = "cs_0000000000000001";
    instance.access.agents.view = () => ({ linkedSlackUser: { id: "ULINKED" } });
    state.storage.sql.exec(
      `INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, title, created_at, updated_at,
        session_id, origin_type, owner_user_id, api_status)
       VALUES (?, '', '', '', 'Web session', 1, 2, ?, 'dashboard', ?, 'running')`,
      key, key, member,
    );
    return { session: instance.modelSession(key), live: instance.liveSessions() };
  });
  expect(tracked.session).toMatchObject({ key: "cs_0000000000000001", ownerId: "ULINKED" });
  expect(tracked.live).toEqual([{ ...tracked.session, status: "busy", activeAt: 2 }]);
});

describe("vault secrets for API sessions", () => {
  const LINKED = "usr_01jabcdefghjkmnpqrstvwxyz0";
  const UNLINKED = "usr_01jabcdefghjkmnpqrstvwxyz1";
  const A = "cs_00000000000000a1";
  const B = "cs_00000000000000b1";
  const SYSTEM = { id: "system", surface: "system" };

  /** Two live API sessions (one linked to Slack user U_LINKED, one not), one Slack thread of U_SLACK; sent frames collected. */
  async function seeded(org: string) {
    const stub = computers().getByName(org);
    await inside(stub, async (instance, state) => {
      instance.access.agents.view = (user: string) => (user === "user_01JABCDEFGHJKMNPQRSTVWXYZ0" ? { linkedSlackUser: { id: "U_LINKED" } } : {});
      for (const [key, member] of [[A, LINKED], [B, UNLINKED]]) {
        state.storage.sql.exec(
          `INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, title, status, created_at, updated_at, session_id, origin_type, owner_user_id, api_status)
           VALUES (?, '', '', '', 'API session', 'idle', 1, 2, ?, 'opc', ?, 'idle')`,
          key, key, member,
        );
      }
      state.storage.sql.exec(
        "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, status, created_at, updated_at) VALUES ('T1:C1:1.2', 'T1', 'C1', '1.2', 'U_SLACK', 'Slack thread', 'idle', 1, 2)",
      );
      instance.frames = [];
      instance.send = (frame: unknown) => (instance.frames.push(frame), true);
      // A welcomed host, as far as the session API can tell.
      instance.apiHost = () => ({ features: [] });
      await instance.secrets.put("workspace", "*", "ORG_TOKEN", "org-fixture", false, SYSTEM);
      await instance.secrets.put("workspace", "*", "SHARED", "from-workspace", false, SYSTEM);
      await instance.secrets.put("user", "U_LINKED", "USER_KEY", "linked-fixture", false, SYSTEM);
      await instance.secrets.put("user", "U_LINKED", "SHARED", "from-user", false, SYSTEM);
      await instance.secrets.put("user", "U_SLACK", "SLACK_KEY", "slack-fixture", false, SYSTEM);
      await instance.secrets.put("session", A, "SESSION_KEY", "session-fixture", false, SYSTEM);
      instance.frames = [];
    });
    return stub;
  }
  const frames = (stub: Stub) => inside(stub, (instance) => instance.frames as Array<{ t: string; sessionKey?: string; session?: { key: string }; secrets?: Array<{ name: string; value: string; scope: string }> }>);
  const named = (secrets: Array<{ name: string; scope: string }> | undefined) => (secrets ?? []).map((s) => `${s.scope}:${s.name}`).sort();

  it("start for an API session carries workspace and session secrets, and the linked owner's user secrets (narrowest winning)", async () => {
    const stub = await seeded("org_api_secrets_start");
    await inside(stub, (instance) => instance.api.onHostFrame({ t: "wake", sessionId: A }));
    await inside(stub, (instance) => instance.api.onHostFrame({ t: "wake", sessionId: B }));
    const starts = await until(async () => (await frames(stub)).filter((f) => f.t === "start"), (s) => s.length === 2, "two starts");
    const of = (key: string) => starts.find((s) => s.session?.key === key)!;
    expect(named(of(A).secrets)).toEqual(["session:SESSION_KEY", "user:SHARED", "user:USER_KEY", "workspace:ORG_TOKEN"]);
    expect(of(A).secrets!.find((s) => s.name === "SHARED")!.value).toBe("from-user");
    // Unlinked: no one's user scope, the workspace's value.
    expect(named(of(B).secrets)).toEqual(["workspace:ORG_TOKEN", "workspace:SHARED"]);
  });

  it("a web form write preserves scope resolution for pushes and later starts", async () => {
    const org = "org_api_secret_form";
    const stub = await seeded(org);
    const caller: ApiRequest = {
      principal: { org, subject: LINKED, kind: "member", via: "dashboard", scopes: ["secrets:write"], audiences: ["org", `member:${LINKED}`], admin: false, credential: { id: "ck_form", expiresAt: null } },
      name: "Owner",
      email: null,
      client: null,
      requestId: "req_form",
    };
    const write = (sessionId: string) => inside(stub, (instance) => instance.computerApi(org, caller, {
      op: "secrets.session.put", sessionId, name: "FORM_TOKEN", body: { value: "form-fixture" },
    }));
    expect(await write(A)).toEqual({ status: 204 });
    const pushed = (await frames(stub)).filter((f) => f.t === "secrets");
    expect(pushed.map((f) => f.sessionKey)).toEqual([A]);
    expect(named(pushed[0]?.secrets)).toEqual(["session:FORM_TOKEN", "session:SESSION_KEY", "user:SHARED", "user:USER_KEY", "workspace:ORG_TOKEN"]);
    await inside(stub, (instance) => instance.api.onHostFrame({ t: "wake", sessionId: A }));
    const starts = await until(async () => (await frames(stub)).filter((f) => f.t === "start"), (s) => s.length === 1, "form session start");
    expect(named(starts[0]?.secrets)).toEqual(named(pushed[0]?.secrets));
    expect(await write("cs_00000000000000ff")).toMatchObject({ status: 404, error: { code: "session_not_found" } });
  });

  it("pushSecrets reaches API sessions with no Slack owner, by linked owner too; Slack sessions as before", async () => {
    const stub = await seeded("org_api_secrets_push");
    await inside(stub, (instance) => instance.pushSecrets({}));
    const all = (await frames(stub)).filter((f) => f.t === "secrets");
    const of = (key: string) => all.find((f) => f.sessionKey === key);
    expect(named(of(A)?.secrets)).toEqual(["session:SESSION_KEY", "user:SHARED", "user:USER_KEY", "workspace:ORG_TOKEN"]);
    expect(named(of(B)?.secrets)).toEqual(["workspace:ORG_TOKEN", "workspace:SHARED"]);
    expect(named(of("T1:C1:1.2")?.secrets)).toEqual(["user:SLACK_KEY", "workspace:ORG_TOKEN", "workspace:SHARED"]);

    // A user secret of U_LINKED changed: their linked API session, not the unlinked one nor U_SLACK's thread.
    await inside(stub, (instance) => ((instance.frames = []), instance.pushSecrets({ owner: "U_LINKED" })));
    expect((await frames(stub)).map((f) => f.sessionKey)).toEqual([A]);
  });
});
