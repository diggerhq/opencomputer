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

  it("does not spin on a thread whose head is stranded or waiting out a retry", async () => {
    const org = "org_stranded";
    await linked(org);
    const job = (ts: string) => JSON.stringify({ eventId: `E${ts}`, teamId: "T1", channelId: "C9", threadTs: "1.1", messageTs: ts, userId: "U1", text: "x", mentioned: true, receivedAt: 0 });
    await inSlack(org, (exec) => {
      const now = Date.now();
      // Left running by an evicted drain, a pending row behind it; a head backing off, a due row behind it.
      exec("INSERT INTO slack_queue (payload, state, available_at, thread_key, started_at) VALUES (?, 'running', ?, 'C9:1.1', ?)", job("1.1"), now, now);
      exec("INSERT INTO slack_queue (payload, state, available_at, thread_key) VALUES (?, 'pending', ?, 'C9:1.1')", job("1.2"), now);
      exec("INSERT INTO slack_queue (payload, state, available_at, thread_key) VALUES (?, 'pending', ?, 'C9:2.1')", job("2.1"), now + 60_000);
      exec("INSERT INTO slack_queue (payload, state, available_at, thread_key) VALUES (?, 'pending', ?, 'C9:2.1')", job("2.2"), now);
    });
    // Another thread's message still runs: the drain yields.
    await slackOf(org).accept(message({ text: "still served", ts: "150.1" }));
    const sid = await sessionIdFor("T1:C1:150.1");
    for (let i = 0; i < 100 && !(await callsOf(logOf(sid))).length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await callsOf(logOf(sid))).toHaveLength(1);
    expect(await inSlack(org, (exec) => exec("SELECT thread_key, state FROM slack_queue ORDER BY sequence"))).toEqual([
      { thread_key: "C9:1.1", state: "running" },
      { thread_key: "C9:1.1", state: "pending" },
      { thread_key: "C9:2.1", state: "pending" },
      { thread_key: "C9:2.1", state: "pending" },
    ]);
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

describe("the Slack actor: post_thread", () => {
  it("wakes the session in the thread it posts into, as its owner, and no other", async () => {
    const org = "org_post_wake";
    await linked(org);
    const here = "T1:C1:810.1";
    const there = "T1:C2:820.1";
    await slackOf(org).accept(message({ text: "lane 1", ts: "810.1" }));
    await slackOf(org).accept(message({ text: "lane 2", ts: "820.1", channel: "C2" }));
    await settled(org);
    const [poster, target] = [await sessionIdFor(here), await sessionIdFor(there)];
    const agent = { org, subject: poster, kind: "agent", via: "agent", scopes: [], audiences: [], session: poster, admin: false, credential: { id: "k", expiresAt: null } };

    const posted = await slackOf(org).post(agent as never, there, "!secret X go ahead with the plan");
    expect(posted).toMatchObject({ ok: true });
    await settled(org);
    const woke = (await callsOf(logOf(target))).slice(1);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.args[0]).toMatchObject({ subject: "slack:T1:U1" });
    expect(woke[0]!.args[1]).toMatchObject({
      id: await turnIdFor(there, (posted as { ts: string }).ts),
      kind: "turn",
      body: { input: "Posted here for <@U1> by the session in <https://app.slack.com/client/T1/C1/thread/C1-810.1|another thread>:\n!secret X go ahead with the plan" },
    });
    // Not a command, and nothing back into the session that posted, nor into its own thread.
    expect((await callsOf(computerOf(org))).filter((c) => c.method === "command")).toEqual([]);
    expect(await callsOf(logOf(poster))).toHaveLength(1);
    await slackOf(org).post(agent as never, here, "a note to myself");
    await settled(org);
    expect(await callsOf(logOf(poster))).toHaveLength(1);
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

describe("the Slack actor: Computer's interactions and people who leave", () => {
  async function until<T>(fn: () => Promise<T | undefined>): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out");
  }

  it("forgets a person who left the workspace and has Computer drop their subscriptions, once", async () => {
    const org = "org_left";
    await linked(org);
    await inSlack(org, (exec) => exec("INSERT INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES ('U5', 'u5', 'U5', 'u5@x', 0)"));
    const left = { kind: "event" as const, id: "EvLeft", body: { type: "event_callback", event_id: "EvLeft", team_id: "T1", event: { type: "team_leave", user: { id: "U5" } } } };
    await slackOf(org).accept(left);
    await slackOf(org).accept(left);
    const calls = await until(async () => {
      const c = (await callsOf(computerOf(org))).filter((x) => x.method === "memberLeft");
      return c.length ? c : undefined;
    });
    expect(calls).toEqual([{ method: "memberLeft", args: ["U5"] }]);
    expect(await inSlack(org, (exec) => exec("SELECT * FROM people WHERE slack_user_id = 'U5'"))).toEqual([]);
  });

  it("hands modals and the secret, connection, variable and subscription buttons to Computer as the presser", async () => {
    const org = "org_modal";
    await linked(org);
    const key = "T1:C1:950.1";
    const sid = await sessionIdFor(key);
    await slackOf(org).accept(message({ text: "hi", ts: "950.1" }));
    await settled(org);
    const base = { team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" }, trigger_id: "tr1" };

    const errors = await slackOf(org).interact("i1", { ...base, type: "view_submission", view: { callback_id: "secret", state: { values: {} } } });
    expect(errors).toEqual({ errors: { value: "Enter a value" } });
    await slackOf(org).interact("i2", { ...base, type: "block_actions", actions: [{ action_id: "s:abc" }] });
    await slackOf(org).interact("i3", { ...base, type: "block_actions", actions: [{ action_id: "cx:connect" }] });
    await slackOf(org).interact("i4", { ...base, type: "block_actions", actions: [{ action_id: `v:${key}`, value: "X=1" }] });
    // A variable's button for a session that is gone: answered here, Computer not asked.
    await slackOf(org).interact("i5", { ...base, type: "block_actions", response_url: "https://hooks.slack.com/r", actions: [{ action_id: "v:T1:C1:1.1" }] });

    const handed = (await callsOf(computerOf(org))).filter((c) => c.method === "interaction");
    expect(handed.map((c) => (c.args[1] as { interaction: { actions?: { action_id: string }[]; type: string } }).interaction.actions?.[0]?.action_id ?? "view")).toEqual(["view", "s:abc", "cx:connect", `v:${key}`]);
    expect(handed[0]!.args[0]).toMatchObject({ org, subject: "slack:T1:U1", kind: "member", via: "slack" });
    expect(handed[3]!.args[1]).toMatchObject({ sessionId: sid });
    expect(handed[1]!.args[1]).not.toHaveProperty("sessionId");
  });

  it("returns a modal's errors to Slack from the edge", async () => {
    const org = "org_modal_edge";
    await linked(org);
    await slackOf("slack-team:T1").releaseTeam("org_edge"); // the edge test's link
    await slackOf("slack-team:T1").claimTeam("T1", org);
    const payload = { team: { id: "T1" }, user: { id: "U1" }, type: "view_submission", view: { callback_id: "secret", state: { values: {} } } };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("shh"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`v0:${ts}:${body}`)));
    const request = new Request("https://edge.test/v1/webhooks/computer/slack/interactivity", {
      method: "POST",
      body,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}` },
    });
    const response = await routeSlackPublic(request, { ...bindings, SLACK_COMPUTER_SIGNING_SECRET: "shh" } as unknown as SlackRouteEnv, createExecutionContext());
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ response_action: "errors", errors: { value: "Enter a value" } });
  });
});
