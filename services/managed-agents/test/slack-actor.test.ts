import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { SlackDurableObject } from "../src/slack/durable-object.js";
import { seal } from "../src/computer/crypto.js";
import { routeSlackPublic, type SlackRouteEnv } from "../src/slack/routes.js";
import { entryIdFor, sessionIdFor, turnIdFor } from "../src/slack/store.js";
import type { Call, FakeComputer, FakeOrg, FakeSessionLog } from "./fixtures/slack-test-worker.js";

const bindings = env as unknown as {
  SLACK: DurableObjectNamespace<SlackDurableObject>;
  ORGS: DurableObjectNamespace<FakeOrg>;
  SESSION_LOG: DurableObjectNamespace<FakeSessionLog>;
  COMPUTERS: DurableObjectNamespace<FakeComputer>;
  BLUE_CHANNEL_ENCRYPTION_KEY: string;
};

const slackOf = (org: string) => bindings.SLACK.getByName(org);
const orgOf = (org: string) => bindings.ORGS.getByName(org);
const logOf = (sid: string) => bindings.SESSION_LOG.getByName(sid);
const computerOf = (machine: string) => bindings.COMPUTERS.getByName(machine);
/** What a fake was called with (RPC types `unknown[]` away). */
const callsOf = async (stub: { calls(): Promise<unknown> }): Promise<Call[]> => (await stub.calls()) as Call[];

type Exec = (query: string, ...params: unknown[]) => Record<string, unknown>[];
const inSlack = <T>(org: string, fn: (exec: Exec) => T | Promise<T>): Promise<T> =>
  runInDurableObject(slackOf(org), (_instance, state) => fn((q, ...p) => state.storage.sql.exec(q, ...(p as never[])).toArray() as Record<string, unknown>[]));

/** A workspace linked as `install` leaves it: team T1, the bot UBOT, the token sealed for the organization. */
async function linked(org: string): Promise<void> {
  const token = await seal("xoxb-test", bindings.BLUE_CHANNEL_ENCRYPTION_KEY, "slack-bot-token", `${org}\0T1`);
  await slackOf(org).forHost(); // migrations
  await inSlack(org, (exec) => {
    for (const [key, value] of [["slackTeamId", "T1"], ["slackTeamName", "Acme"], ["slackBotUserId", "UBOT"], ["slackBotToken", token]]) {
      exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    }
  });
}

/** Until the queue is empty. */
async function settled(org: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const left = await inSlack(org, (exec) => exec("SELECT COUNT(*) AS n FROM slack_queue WHERE state IN ('pending', 'running')")[0]!.n as number);
    if (left === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the queue did not settle");
}

let n = 0;
/** A Slack event envelope of a message. */
function message(o: { text: string; ts: string; thread?: string; user?: string; channel?: string; mention?: boolean; id?: string }) {
  n += 1;
  return {
    kind: "event" as const,
    id: o.id ?? `Ev${n}`,
    body: {
      type: "event_callback",
      event_id: o.id ?? `Ev${n}`,
      team_id: "T1",
      event: {
        type: o.mention === false ? "message" : "app_mention",
        channel: o.channel ?? "C1",
        user: o.user ?? "U1",
        text: o.mention === false ? o.text : `<@UBOT> ${o.text}`,
        ts: o.ts,
        ...(o.thread ? { thread_ts: o.thread } : {}),
        channel_type: "channel",
      },
    },
  };
}

describe("the Slack actor: accept, the queue, turns", () => {
  it("processes an event accepted twice once", async () => {
    const org = "org_dup";
    await linked(org);
    const e = message({ text: "hello", ts: "100.1" });
    await slackOf(org).accept(e);
    await slackOf(org).accept(e);
    // The same message under another event id (Slack's `message` beside its `app_mention`).
    await slackOf(org).accept({ ...e, id: "EvOther" });
    await settled(org);
    const sid = await sessionIdFor("T1:C1:100.1");
    expect((await callsOf(orgOf(org))).filter((c) => c.method === "createSession")).toHaveLength(1);
    expect(await callsOf(logOf(sid))).toHaveLength(1);
  });

  it("creates a new thread's session through Org and accepts its turn in the SessionLog", async () => {
    const org = "org_new";
    await linked(org);
    await slackOf(org).accept(message({ text: "+codex fix the build", ts: "200.1" }));
    await settled(org);
    const key = "T1:C1:200.1";
    const sid = await sessionIdFor(key);
    expect(sid).toMatch(/^cs_[0-9a-hjkmnp-tv-z]{16}$/);

    const [create] = (await callsOf(orgOf(org))).filter((c) => c.method === "createSession");
    const [p, body] = create!.args as [Record<string, unknown>, Record<string, unknown>];
    expect(p).toMatchObject({ org, subject: "slack:T1:U1", kind: "member", via: "slack", audiences: [], admin: false });
    expect(body).toMatchObject({ id: sid, writers: "members", slackThread: key, harness: "codex", origin: { type: "slack", slack: { teamId: "T1", channelId: "C1", threadTs: "200.1" } } });

    const [accepted] = await callsOf(logOf(sid));
    const [tp, entry] = accepted!.args as [Record<string, unknown>, Record<string, unknown>];
    expect(tp).toMatchObject({ subject: "slack:T1:U1", via: "slack" });
    expect(entry).toEqual({
      id: await turnIdFor(key, "200.1"),
      kind: "turn",
      body: { input: "fix the build", slack: { userId: "U1", ts: "200.1", files: [], mentioned: true, context: [], linked: [] } },
    });
    expect(await inSlack(org, (exec) => exec("SELECT key, session_id FROM thread"))).toEqual([{ key, session_id: sid }]);
  });

  it("makes a linked person's principal from the member", async () => {
    const org = "org_linked";
    await linked(org);
    await inSlack(org, (exec) => exec("INSERT INTO link (slack_user, member) VALUES ('U1', 'usr_abc')"));
    await slackOf(org).accept(message({ text: "hi", ts: "250.1" }));
    await settled(org);
    const [accepted] = await callsOf(logOf(await sessionIdFor("T1:C1:250.1")));
    expect(accepted!.args[0]).toMatchObject({ subject: "usr_abc", audiences: ["org", "member:usr_abc"] });
  });

  it("refuses a person Slack does not report as a full member", async () => {
    const org = "org_guest";
    await linked(org);
    await slackOf(org).accept(message({ text: "hi", ts: "260.1", user: "UGUEST1" }));
    await settled(org);
    expect(await callsOf(orgOf(org))).toEqual([]);
    expect(await callsOf(logOf(await sessionIdFor("T1:C1:260.1")))).toEqual([]);
  });

  it("keeps two messages of one thread in order", async () => {
    const org = "org_order";
    await linked(org);
    const key = "T1:C1:300.1";
    const sid = await sessionIdFor(key);
    await logOf(sid).set({ delayMs: 200 });
    await slackOf(org).accept(message({ text: "first", ts: "300.1" }));
    await slackOf(org).accept(message({ text: "second", ts: "300.2", thread: "300.1", mention: false }));
    await settled(org);
    const inputs = (await callsOf(logOf(sid))).map((c) => ((c.args[1] as { body: { input: string } }).body.input));
    expect(inputs).toEqual(["first", "second"]);
    // One session: the second message continues the thread.
    expect((await callsOf(orgOf(org))).filter((c) => c.method === "createSession")).toHaveLength(1);
  });

  it("gives the host its people and the bot credentials", async () => {
    const org = "org_host";
    await linked(org);
    await slackOf(org).accept(message({ text: "hi", ts: "400.1", user: "U7" }));
    await settled(org);
    for (let i = 0; i < 50 && !(await slackOf(org).forHost()).people.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const host = await slackOf(org).forHost();
    expect(host.slack).toEqual({ botToken: "xoxb-test", botUserId: "UBOT", teamId: "T1" });
    expect(host.people).toMatchObject([{ slackUserId: "U7", gitEmail: "u7@example.com" }]);
    expect((await callsOf(computerOf(org))).filter((c) => c.method === "changed")).toEqual([{ method: "changed", args: ["slack"] }]);
  });
});

/** A prompt button's action id, as the runner makes it. */
const promptAction = (key: string, promptId: string, value: string) => `p:${btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}:${promptId}:${value}`;

describe("the Slack actor: commands, buttons, held messages", () => {
  it("makes `!stop` an interrupt entry, not a turn", async () => {
    const org = "org_stop";
    await linked(org);
    const key = "T1:C1:500.1";
    const sid = await sessionIdFor(key);
    await slackOf(org).accept(message({ text: "work on it", ts: "500.1" }));
    await slackOf(org).accept(message({ text: "!stop", ts: "500.2", thread: "500.1" }));
    await settled(org);
    const entries = (await callsOf(logOf(sid))).map((c) => c.args[1] as { id: string; kind: string; body: unknown });
    expect(entries.map((e) => e.kind)).toEqual(["turn", "interrupt"]);
    expect(entries[1]).toEqual({ id: await entryIdFor("in", `${key}\0${"500.2"}`), kind: "interrupt", body: {} });
  });

  it("holds a refused message as context, asks the owner, and runs it once allowed", async () => {
    const org = "org_held";
    await linked(org);
    const key = "T1:C1:600.1";
    const sid = await sessionIdFor(key);
    await slackOf(org).accept(message({ text: "start", ts: "600.1" }));
    await settled(org);
    await orgOf(org).set({ writers: ["user:slack:T1:U1"] });
    await logOf(sid).set({ answer: { ok: false, code: "forbidden" } });
    await slackOf(org).accept(message({ text: "let me in", ts: "600.2", thread: "600.1", user: "U2" }));
    await settled(org);
    expect(await inSlack(org, (exec) => exec("SELECT key, user_id, ts, text FROM session_context"))).toEqual([{ key, user_id: "U2", ts: "600.2", text: "let me in" }]);
    const [request] = await inSlack(org, (exec) => exec("SELECT key, user_id, state, message_ts FROM access_requests"));
    expect(request).toMatchObject({ key, user_id: "U2", state: "open" });
    expect(request!.message_ts).not.toBe("");

    // The owner allows: U2 is added to the writers, and the held message runs as U2's turn.
    await logOf(sid).set({ answer: null });
    const allow = `ac:${btoa(key).replace(/=+$/, "")}:allow:U2`;
    await slackOf(org).accept({ kind: "interaction", id: "I1", body: { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, container: { thread_ts: "600.1" }, actions: [{ action_id: allow }] } });
    await settled(org);
    const mutate = (await callsOf(orgOf(org))).find((c) => c.method === "mutate");
    expect(mutate!.args[1]).toEqual({ name: "thread.writers", args: { sid, writers: ["user:slack:T1:U1", "user:slack:T1:U2"] } });
    const last = (await callsOf(logOf(sid))).at(-1)!;
    expect(last.args[0]).toMatchObject({ subject: "slack:T1:U2" });
    expect(last.args[1]).toMatchObject({ id: await turnIdFor(key, "600.2"), kind: "turn", body: { input: "let me in" } });
    expect(await inSlack(org, (exec) => exec("SELECT state FROM access_requests"))).toEqual([{ state: "closed" }]);
    expect(await inSlack(org, (exec) => exec("SELECT COUNT(*) AS n FROM session_context"))).toEqual([{ n: 0 }]);
  });

  it("makes a prompt's button an answer entry naming the ask", async () => {
    const org = "org_button";
    await linked(org);
    const key = "T1:C1:700.1";
    const sid = await sessionIdFor(key);
    await slackOf(org).accept(message({ text: "deploy", ts: "700.1" }));
    await settled(org);
    const press = { kind: "interaction" as const, id: "I7", body: { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, container: { thread_ts: "700.1" }, actions: [{ action_id: promptAction(key, "pr1", "allow") }] } };
    await slackOf(org).accept(press);
    await slackOf(org).accept(press);
    await settled(org);
    const entries = (await callsOf(logOf(sid))).map((c) => c.args[1]);
    expect(entries.slice(1)).toEqual([{ id: await entryIdFor("an", "I7"), kind: "answer", body: { askId: "pr1", answer: { value: "allow" } } }]);
  });

  it("posts into a thread for whoever may read its session, and announces a child once", async () => {
    const org = "org_post";
    await linked(org);
    const key = "T1:C1:800.1";
    const sid = await sessionIdFor(key);
    await slackOf(org).accept(message({ text: "hi", ts: "800.1" }));
    await settled(org);
    const p = (await callsOf(logOf(sid)))[0]!.args[0] as never;
    expect(await slackOf(org).post(p, key, "done")).toMatchObject({ ok: true });
    expect(await slackOf(org).post(p, "T1:C1:999.9", "done")).toMatchObject({ ok: false, code: "not_found" });
    const first = await slackOf(org).announce({ sessionId: "cs_child", parent: sid, brief: "a child" });
    expect(first.threadKey).toMatch(/^T1:C1:\d+\.\d+$/);
    expect(await slackOf(org).announce({ sessionId: "cs_child", parent: sid, brief: "a child" })).toEqual(first);
  });
});

describe("the Slack actor: install, unlink, import", () => {
  it("imports Computer's Slack state in two pages, once", async () => {
    const org = "org_import";
    const people = Array.from({ length: 199 }, (_, i) => ({ type: "row" as const, table: "people", row: { slack_user_id: `UP${i}`, dir: `up${i}`, git_name: `P ${i}`, git_email: `p${i}@example.com`, updated_at: 1 } }));
    const rows = [
      { type: "setting" as const, key: "slackTeamId", value: "T9" },
      { type: "setting" as const, key: "slackBotUserId", value: "UBOT" },
      ...people,
      { type: "link" as const, slackUser: "UP1", member: "usr_p1" },
      { type: "thread" as const, key: "T9:C1:1.1", sessionId: "cs_imported" },
      { type: "dispatch" as const, sessionId: "cs_imported", entry: { id: "tn_imported", kind: "turn" as const, body: { input: "pending" }, by: "user:usr_p1" } },
    ];
    await computerOf(org).set({ rows });
    await Promise.all([slackOf(org).import(), slackOf(org).import()]);
    await slackOf(org).import();
    expect((await callsOf(computerOf(org))).filter((c) => c.method === "exportSlack").map((c) => c.args)).toEqual([[null, 200], ["200", 200]]);
    expect(await inSlack(org, (exec) => exec("SELECT COUNT(*) AS n FROM people"))).toEqual([{ n: 199 }]);
    expect(await inSlack(org, (exec) => exec("SELECT slack_user, member FROM link"))).toEqual([{ slack_user: "UP1", member: "usr_p1" }]);
    expect(await inSlack(org, (exec) => exec("SELECT key, session_id FROM thread"))).toEqual([{ key: "T9:C1:1.1", session_id: "cs_imported" }]);
    expect(await inSlack(org, (exec) => exec("SELECT imported FROM meta"))).toEqual([{ imported: 1 }]);
    const [accepted] = await callsOf(logOf("cs_imported"));
    expect(accepted!.args[0]).toMatchObject({ org, subject: "usr_p1", kind: "member" });
    expect(accepted!.args[1]).toEqual({ id: "tn_imported", kind: "turn", body: { input: "pending" } });
    // The workspace routes to this organization.
    expect(await slackOf("slack-team:T9").teamOrg()).toBe(org);
  });

  it("installs and unlinks a workspace", async () => {
    const org = "org_install";
    const p = { org, subject: "usr_admin", kind: "member" as const, via: "app" as const, scopes: [], audiences: ["org"], admin: true, credential: { id: "k", expiresAt: null } };
    await slackOf(org).startInstall(p as never, "nonce-1");
    expect(await slackOf(org).consumeInstall("nonce-1")).toEqual({ ok: true, subject: "usr_admin" });
    expect(await slackOf(org).consumeInstall("nonce-1")).toEqual({ ok: false, reason: "invalid_state" });
    await slackOf(org).install(p as never, { teamId: "T1", teamName: "Acme", botUserId: "UBOT", botToken: "xoxb-new", installerUserId: "UINST" });
    expect((await slackOf(org).forHost()).slack).toEqual({ botToken: "xoxb-new", botUserId: "UBOT", teamId: "T1" });
    expect((await callsOf(orgOf(org))).filter((c) => c.method === "linkPerson")).toEqual([{ method: "linkPerson", args: ["slack:T1:UINST", "usr_admin"] }]);
    await slackOf(org).unlink(p as never);
    expect((await slackOf(org).forHost()).slack).toBeNull();
    expect((await callsOf(computerOf(org))).filter((c) => c.method === "changed")).toHaveLength(2);
  });
});

describe("the edge's Slack routes", () => {
  async function signed(body: string, secret: string): Promise<Request> {
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`)));
    const signature = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    return new Request("https://edge.test/v1/webhooks/computer/slack/events", { method: "POST", body, headers: { "x-slack-request-timestamp": ts, "x-slack-signature": signature } });
  }

  it("verifies an event's signature and accepts it in the workspace's organization", async () => {
    const org = "org_edge";
    await linked(org);
    await slackOf("slack-team:T1").claimTeam("T1", org);
    const routeEnv = { ...bindings, SLACK_COMPUTER_SIGNING_SECRET: "shh" } as unknown as SlackRouteEnv;
    const e = message({ text: "from the edge", ts: "900.1" });

    const forged = await routeSlackPublic(await signed(JSON.stringify(e.body), "wrong"), routeEnv, createExecutionContext());
    expect(forged?.status).toBe(401);

    const context = createExecutionContext();
    const response = await routeSlackPublic(await signed(JSON.stringify(e.body), "shh"), routeEnv, context);
    expect(response?.status).toBe(200);
    await waitOnExecutionContext(context);
    await settled(org);
    const sid = await sessionIdFor("T1:C1:900.1");
    expect((await callsOf(logOf(sid))).map((c) => (c.args[1] as { id: string }).id)).toEqual([await turnIdFor("T1:C1:900.1", "900.1")]);
  });
});
