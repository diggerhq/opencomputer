import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { SlackDurableObject } from "../src/slack/durable-object.js";
import { seal } from "../src/computer/crypto.js";
import { sessionIdFor, turnIdFor } from "../src/slack/store.js";
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
