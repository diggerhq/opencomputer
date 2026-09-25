import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSlackConnectInvite,
  handleSlackConnectStatus,
  slackChannelName,
  type SlackConnectEnv,
} from "./slack_connect";

const caller = { orgID: "org_1", userID: "user_1" };

function testEnv(
  plan: string,
  overrides: Partial<SlackConnectEnv> = {},
): { env: SlackConnectEnv; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
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
    // Channel is kept for the org; the user invite is not recorded.
    expect(kv.has("slack_connect_channel:org_1")).toBe(true);
    expect(kv.has("slack_connect_invite:org_1:user_1")).toBe(false);
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
    expect(kv.size).toBe(0);
  });
});
