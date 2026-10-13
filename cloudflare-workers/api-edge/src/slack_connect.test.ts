import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSlackConnectInvite,
  handleSlackConnectStatus,
  slackChannelName,
  type SlackConnectEnv,
} from "./slack_connect";

const caller = { orgID: "org_1", userID: "user_1" };

const members = new Set(["user_1", "user_2"]);

function testEnv(
  plan: string,
  overrides: Partial<SlackConnectEnv> = {},
): { env: SlackConnectEnv; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: string[]) => ({
        first: async () => {
          if (sql.includes("FROM org_memberships")) {
            return members.has(args[0]) ? { ok: 1 } : null;
          }
          if (sql.includes("FROM orgs")) {
            return { plan, billing_provider: "stripe", name: "Acme Corp" };
          }
          if (sql.includes("FROM users")) {
            return { email: "person@example.com" };
          }
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
  const env: SlackConnectEnv = {
    OPENCOMPUTER_DB: db,
    SESSIONS_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    } as unknown as KVNamespace,
    SLACK_CONNECT_BOT_TOKEN: "xoxb-test",
    SLACK_CONNECT_TEAM_USER_IDS: "U1, U2",
    ...overrides,
  };
  return { env, kv };
}

type Call = { method: string; body: Record<string, unknown> };

// Slack Web API stub: routes by method name, records calls.
function stubSlack(
  handlers: Record<string, (body: Record<string, unknown>) => unknown>,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer xoxb-test",
      );
      const method = url.split("/").pop()!;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      calls.push({ method, body });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected slack call ${method}`);
      return Response.json(handler(body));
    }),
  );
  return calls;
}

const happySlack = {
  "conversations.create": (body: Record<string, unknown>) => ({
    ok: true,
    channel: { id: "C_NEW", name: body.name },
  }),
  "conversations.invite": () => ({ ok: true }),
  "conversations.inviteShared": () => ({ ok: true, invite_id: "I1" }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slackChannelName", () => {
  it("builds a valid Slack channel name", () => {
    expect(slackChannelName("oc-", "Acme Corp!", "org_ABC123")).toBe(
      "oc-acme-corp-abc123",
    );
    expect(slackChannelName("oc-", "", "org_ABC123", 2)).toBe(
      "oc-org-abc123-2",
    );
    expect(
      slackChannelName("oc-", "x".repeat(200), "org_1").length,
    ).toBeLessThanOrEqual(80);
    // A prefix that fills the limit must still leave room for retry suffixes.
    const long = "p".repeat(90);
    expect(slackChannelName(long, "acme", "org_1", 3)).toHaveLength(80);
    expect(slackChannelName(long, "acme", "org_1", 3).endsWith("-org1-3")).toBe(
      true,
    );
  });
});

describe("slack connect status", () => {
  it("reports unavailable when the integration is not configured", async () => {
    const { env } = testEnv("pro", { SLACK_CONNECT_TEAM_USER_IDS: undefined });
    const res = await handleSlackConnectStatus(env, caller);
    expect(await res.json()).toEqual({
      available: false,
      eligible: false,
      email: null,
      channelName: null,
      invitedAt: null,
    });
  });

  it("marks free organizations ineligible", async () => {
    const { env } = testEnv("free");
    const res = await handleSlackConnectStatus(env, caller);
    expect(await res.json()).toMatchObject({
      available: true,
      eligible: false,
    });
  });

  it.each(["pro", "max"])("marks %s organizations eligible", async (plan) => {
    const { env } = testEnv(plan);
    const res = await handleSlackConnectStatus(env, caller);
    expect(await res.json()).toEqual({
      available: true,
      eligible: true,
      email: "person@example.com",
      channelName: null,
      invitedAt: null,
    });
  });
});

describe("slack connect invite", () => {
  it("rejects organizations without Pro or Max", async () => {
    const calls = stubSlack(happySlack);
    const { env } = testEnv("free");
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "slack_connect_plan_required" },
    });
    expect(calls).toEqual([]);
  });

  it("creates the org channel, adds the team, and invites the caller", async () => {
    const calls = stubSlack(happySlack);
    const { env, kv } = testEnv("max");

    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      channelName: string;
      invitedAt: string;
      alreadyInvited: boolean;
    };
    expect(body).toMatchObject({
      email: "person@example.com",
      channelName: "oc-acme-corp-org1",
      alreadyInvited: false,
    });
    expect(calls).toEqual([
      {
        method: "conversations.create",
        body: { name: "oc-acme-corp-org1", is_private: true },
      },
      {
        method: "conversations.invite",
        body: { channel: "C_NEW", users: "U1,U2" },
      },
      {
        method: "conversations.inviteShared",
        body: {
          channel: "C_NEW",
          emails: ["person@example.com"],
          external_limited: true,
        },
      },
    ]);
    expect(kv.get("slack_connect_invite:org_1:user_1")).toBe(body.invitedAt);
    expect(JSON.parse(kv.get("slack_connect_channel:org_1")!)).toEqual({
      id: "C_NEW",
      name: "oc-acme-corp-org1",
      team: ["U1", "U2"],
    });

    const again = await handleSlackConnectInvite(env, caller);
    expect(await again.json()).toMatchObject({
      alreadyInvited: true,
      invitedAt: body.invitedAt,
      channelName: "oc-acme-corp-org1",
    });
    expect(calls).toHaveLength(3);

    const status = await handleSlackConnectStatus(env, caller);
    expect(await status.json()).toMatchObject({
      invitedAt: body.invitedAt,
      channelName: "oc-acme-corp-org1",
    });
  });

  it("reuses the org channel for a second user", async () => {
    const calls = stubSlack(happySlack);
    const { env } = testEnv("pro");
    await handleSlackConnectInvite(env, caller);
    await handleSlackConnectInvite(env, { orgID: "org_1", userID: "user_2" });
    expect(calls.map((c) => c.method)).toEqual([
      "conversations.create",
      "conversations.invite",
      "conversations.inviteShared",
      "conversations.inviteShared",
    ]);
    expect(calls[3].body.channel).toBe("C_NEW");
  });

  it("retries with a numeric suffix when the channel name is taken", async () => {
    let created = 0;
    const calls = stubSlack({
      ...happySlack,
      "conversations.create": (body) =>
        created++ === 0
          ? { ok: false, error: "name_taken" }
          : { ok: true, channel: { id: "C_NEW", name: body.name } },
    });
    const { env } = testEnv("pro");
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === "conversations.create")).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ name: "oc-acme-corp-org1" }),
      }),
      expect.objectContaining({
        body: expect.objectContaining({ name: "oc-acme-corp-org1-1" }),
      }),
    ]);
  });

  it("keeps the channel and retries the team invite when adding the team fails", async () => {
    let teamInvites = 0;
    const calls = stubSlack({
      ...happySlack,
      "conversations.invite": () =>
        teamInvites++ === 0
          ? { ok: false, error: "internal_error" }
          : { ok: true },
    });
    const { env, kv } = testEnv("pro");

    const first = await handleSlackConnectInvite(env, caller);
    expect(first.status).toBe(502);
    expect(JSON.parse(kv.get("slack_connect_channel:org_1")!)).toMatchObject({
      id: "C_NEW",
      team: [],
    });
    kv.delete("slack_connect_cooldown:org_1:user_1");

    const second = await handleSlackConnectInvite(env, caller);
    expect(second.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual([
      "conversations.create",
      "conversations.invite",
      "conversations.invite",
      "conversations.inviteShared",
    ]);
    expect(JSON.parse(kv.get("slack_connect_channel:org_1")!)).toMatchObject({
      team: ["U1", "U2"],
    });
  });

  it("adds newly configured team members to existing channels", async () => {
    const calls = stubSlack(happySlack);
    const { env } = testEnv("pro");
    await handleSlackConnectInvite(env, caller);
    env.SLACK_CONNECT_TEAM_USER_IDS = "U1,U2,U3";
    await handleSlackConnectInvite(env, { orgID: "org_1", userID: "user_2" });
    const invites = calls.filter((c) => c.method === "conversations.invite");
    expect(invites.map((c) => c.body.users)).toEqual(["U1,U2", "U3"]);
  });

  it("rejects callers who are no longer members of the org", async () => {
    const calls = stubSlack(happySlack);
    const { env } = testEnv("pro");
    const res = await handleSlackConnectInvite(env, {
      orgID: "org_1",
      userID: "user_gone",
    });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("applies a cooldown after a Slack failure", async () => {
    const calls = stubSlack({
      ...happySlack,
      "conversations.inviteShared": () => ({
        ok: false,
        error: "internal_error",
      }),
    });
    const { env } = testEnv("pro");
    expect((await handleSlackConnectInvite(env, caller)).status).toBe(502);
    const again = await handleSlackConnectInvite(env, caller);
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({
      error: { code: "slack_connect_rate_limited" },
    });
    expect(
      calls.filter((c) => c.method === "conversations.inviteShared"),
    ).toHaveLength(1);
  });

  it("still reports success when the invite bookkeeping write fails", async () => {
    stubSlack(happySlack);
    const { env } = testEnv("pro");
    const put = env.SESSIONS_KV.put.bind(env.SESSIONS_KV);
    env.SESSIONS_KV.put = (async (key: string, ...rest: unknown[]) => {
      if (key.startsWith("slack_connect_invite:")) throw new Error("kv down");
      return (put as (...a: unknown[]) => Promise<void>)(key, ...rest);
    }) as KVNamespace["put"];
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyInvited: false });
  });

  it("maps Slack's already-invited errors without leaking provider text", async () => {
    stubSlack({
      ...happySlack,
      "conversations.inviteShared": () => ({
        ok: false,
        error: "already_in_channel",
      }),
    });
    const { env, kv } = testEnv("pro");
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "slack_connect_already_invited",
        message: "You're already a member of your shared channel.",
      },
    });
    // Channel is kept for the org and Slack's view (already invited) is
    // mirrored so Settings stops offering the button.
    expect(kv.has("slack_connect_channel:org_1")).toBe(true);
    expect(kv.has("slack_connect_invite:org_1:user_1")).toBe(true);
    const status = await handleSlackConnectStatus(env, caller);
    expect(await status.json()).toMatchObject({
      invitedAt: expect.any(String),
    });
  });

  it("returns 502 with a generic message for unknown Slack errors", async () => {
    stubSlack({
      ...happySlack,
      "conversations.create": () => ({ ok: false, error: "missing_scope" }),
    });
    const { env, kv } = testEnv("pro");
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { code: "slack_connect_invite_failed" },
    });
    expect([...kv.keys()]).toEqual(["slack_connect_cooldown:org_1:user_1"]);
  });
});
