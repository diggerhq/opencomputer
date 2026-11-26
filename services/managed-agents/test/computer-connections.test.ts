// Work 080 step 3: granting a connection to the computer from a Slack thread.
import { beforeEach, describe, expect, it } from "vitest";

import { CONNECTION_VIEW, ComputerConnections, connectionButtonId, decodeConnectionButtonId, type GrantScope } from "../src/computer/connections.js";
import type { SlackResult } from "../src/computer/slack.js";

const SESSION = { key: "T1:C1:100.1", ownerId: "U_OWNER", channelId: "C1", threadTs: "100.1" };
const OWNED: Record<string, Array<{ id: string; label: string; displayName?: string }>> = {
  dash_owner: [{ id: "conn_owner", label: "work", displayName: "Owner Co" }],
  dash_other: [],
};

let calls: Array<{ method: string; body: Record<string, unknown> }>;
let grants: Array<{ connectionId: string; ownerUserId: string; scope: GrantScope; subject: string; grantedBy: string }>;
let woken: Array<{ userId: string; text: string }>;
let c: ComputerConnections;

beforeEach(() => {
  calls = [];
  grants = [];
  woken = [];
  c = new ComputerConnections({
    slack: async (method, body): Promise<SlackResult> => {
      calls.push({ method, body });
      return { ok: true, ts: "200.1" };
    },
    session: (key) => (key === SESSION.key ? SESSION : undefined),
    linkOfSlack: (slackUserId) => ({ U_OWNER: "dash_owner", U_OTHER: "dash_other" })[slackUserId],
    grantable: async (user, service) => (service === "linear" ? (OWNED[user] ?? []) : []),
    grant: async (input) => void grants.push(input),
    wake: async (_session, userId, text) => void woken.push({ userId, text }),
    origin: () => "https://app.test",
  });
});

const last = (method: string) => calls.filter((call) => call.method === method).at(-1)?.body as Record<string, any>;
const button = connectionButtonId({ k: SESSION.key, s: "linear" });
const meta = { k: SESSION.key, s: "linear", ch: "C1", th: "100.1", rq: "300.1" };
function submission(connectionId: string, scope: string, m: Record<string, string> = meta) {
  return {
    callback_id: CONNECTION_VIEW,
    private_metadata: JSON.stringify(m),
    state: { values: { conn: { v: { selected_option: { value: connectionId } } }, scope: { v: { selected_option: { value: scope } } } } },
  };
}

describe("granting a connection from Slack (work 080)", () => {
  it("request_connection posts a Grant button in the session's thread, for known services only", async () => {
    await c.request(SESSION.key, { service: "linear", reason: "To file the bug" });
    const post = last("chat.postMessage");
    expect(post).toMatchObject({ channel: "C1", thread_ts: "100.1" });
    expect(decodeConnectionButtonId(post.blocks[1].elements[0].action_id)).toEqual({ k: SESSION.key, s: "linear" });
    await expect(c.request(SESSION.key, { service: "dropbox", reason: "" })).rejects.toThrow(/unknown service/);
    await expect(c.request("T1:C1:9.9", { service: "linear", reason: "" })).rejects.toThrow(/unknown session/);
  });

  it("the button shows the clicker only their own connections, and the thread and personal scopes", async () => {
    await c.open(button, "trig", { userId: "U_OWNER", channelId: "C1", messageTs: "300.1" });
    const view = last("views.open").view;
    expect(view.callback_id).toBe(CONNECTION_VIEW);
    expect(JSON.parse(view.private_metadata)).toEqual(meta);
    const options = (block: string) => view.blocks.find((b: any) => b.block_id === block).element.options.map((o: any) => o.value);
    expect(options("conn")).toEqual(["conn_owner"]);
    expect(options("scope")).toEqual(["session", "user"]);
  });

  it("explains how to link, or to connect, instead of offering anything", async () => {
    await c.open(button, "trig", { userId: "U_UNLINKED" });
    expect(last("views.open").view.callback_id).toBeUndefined();
    expect(JSON.stringify(last("views.open").view)).toContain("!link");
    await c.open(button, "trig", { userId: "U_OTHER" });
    expect(JSON.stringify(last("views.open").view)).toContain("https://app.test/managed-agents/connections");
  });

  it("grants to the thread, updates the request and wakes the session", async () => {
    const r = await c.submit(submission("conn_owner", "session"), "U_OWNER");
    expect(r.errors).toBeUndefined();
    await r.after?.();
    expect(grants).toEqual([{ connectionId: "conn_owner", ownerUserId: "dash_owner", scope: "session", subject: SESSION.key, grantedBy: "U_OWNER" }]);
    expect(last("chat.update")).toMatchObject({ channel: "C1", ts: "300.1" });
    expect(woken).toEqual([{ userId: "U_OWNER", text: expect.stringContaining("Linear is granted") }]);
  });

  it("a personal grant is for the clicker's own threads, so it wakes only their session", async () => {
    const r = await c.submit(submission("conn_owner", "user"), "U_OWNER");
    await r.after?.();
    expect(grants[0]).toMatchObject({ scope: "user", subject: "U_OWNER" });
    expect(woken).toHaveLength(1);
  });

  it("refuses a connection the clicker does not own, an unlinked clicker and an ended session", async () => {
    expect((await c.submit(submission("conn_owner", "session"), "U_OTHER")).errors).toHaveProperty("conn");
    expect((await c.submit(submission("conn_owner", "session"), "U_UNLINKED")).errors).toHaveProperty("conn");
    expect((await c.submit(submission("conn_owner", "session", { ...meta, k: "T1:C1:9.9" }), "U_OWNER")).errors).toHaveProperty("conn");
    expect((await c.submit(submission("conn_owner", "everyone"), "U_OWNER")).errors).toHaveProperty("scope");
    expect(grants).toEqual([]);
  });
});
