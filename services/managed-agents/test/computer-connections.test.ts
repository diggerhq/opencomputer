// Work 080 step 3: granting a connection to the computer from a Slack thread.
import { beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTION_VIEW,
  ComputerConnections,
  connectionButtonId,
  decodeConnectionButtonId,
  driversOnlyText,
  type GrantScope,
} from "../src/computer/connections.js";
import type { SlackResult } from "../src/computer/slack.js";
import { LOOKUP_FAILED_TEXT } from "../src/computer/threads.js";

const SESSION = { key: "T1:C1:100.1", ownerId: "U_OWNER", channelId: "C1", threadTs: "100.1" };
const OWNED: Record<string, Array<{ id: string; label: string; displayName?: string }>> = {
  dash_owner: [{ id: "conn_owner", label: "work", displayName: "Owner Co" }],
  dash_other: [],
  dash_driver: [{ id: "conn_driver", label: "driver's" }],
  dash_stranger: [{ id: "conn_stranger", label: "stranger's" }],
};
// Who can drive SESSION: its owner and the people it was shared with (U_STRANGER is only in the thread).
let drivers: Set<string> | "lookup-fails";

let calls: Array<{ method: string; body: Record<string, unknown> }>;
let grants: Array<{ connectionId: string; ownerUserId: string; scope: GrantScope; subject: string; grantedBy: string }>;
let woken: Array<{ userId: string; text: string }>;
let c: ComputerConnections;

beforeEach(() => {
  calls = [];
  grants = [];
  woken = [];
  drivers = new Set(["U_OWNER", "U_OTHER", "U_UNLINKED", "U_DRIVER"]);
  c = new ComputerConnections({
    slack: async (method, body): Promise<SlackResult> => {
      calls.push({ method, body });
      return { ok: true, ts: "200.1" };
    },
    session: (key) => (key === SESSION.key ? SESSION : undefined),
    instructs: async (key, userId) => {
      if (drivers === "lookup-fails") throw new Error("users.info failed");
      return key === SESSION.key && drivers.has(userId);
    },
    linkOfSlack: (slackUserId) =>
      ({ U_OWNER: "dash_owner", U_OTHER: "dash_other", U_DRIVER: "dash_driver", U_STRANGER: "dash_stranger" })[slackUserId],
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

  it("refuses, privately, a clicker who cannot drive the session, before showing any connection", async () => {
    await c.open(button, "trig", { userId: "U_STRANGER", channelId: "C1", threadTs: "100.1", messageTs: "300.1" });
    expect(last("views.open")).toBeUndefined();
    expect(last("chat.postEphemeral")).toEqual({ channel: "C1", user: "U_STRANGER", thread_ts: "100.1", text: driversOnlyText("Linear") });
  });

  it("refuses the submission of a clicker who cannot drive the session, even with their own connection", async () => {
    for (const scope of ["session", "user"]) {
      const r = await c.submit(submission("conn_stranger", scope), "U_STRANGER");
      expect(r.errors).toEqual({ conn: driversOnlyText("Linear") });
      expect(r.after).toBeUndefined();
    }
    expect(grants).toEqual([]);
    expect(woken).toEqual([]);
  });

  it("refuses a clicker who could drive when the button was posted but no longer can", async () => {
    await c.open(button, "trig", { userId: "U_DRIVER", channelId: "C1", messageTs: "300.1" });
    expect(last("views.open").view.callback_id).toBe(CONNECTION_VIEW);
    drivers = new Set(["U_OWNER"]);
    expect((await c.submit(submission("conn_driver", "session"), "U_DRIVER")).errors).toEqual({ conn: driversOnlyText("Linear") });
    expect(grants).toEqual([]);
  });

  it("lets a driver who is not the owner grant their own connection to the thread", async () => {
    const r = await c.submit(submission("conn_driver", "session"), "U_DRIVER");
    expect(r.errors).toBeUndefined();
    expect(grants).toEqual([{ connectionId: "conn_driver", ownerUserId: "dash_driver", scope: "session", subject: SESSION.key, grantedBy: "U_DRIVER" }]);
  });

  it("refuses when who can drive cannot be looked up", async () => {
    drivers = "lookup-fails";
    await c.open(button, "trig", { userId: "U_OWNER", channelId: "C1" });
    expect(last("views.open")).toBeUndefined();
    expect(last("chat.postEphemeral").text).toBe(LOOKUP_FAILED_TEXT);
    expect((await c.submit(submission("conn_owner", "session"), "U_OWNER")).errors).toEqual({ conn: LOOKUP_FAILED_TEXT });
    expect(grants).toEqual([]);
  });
});
