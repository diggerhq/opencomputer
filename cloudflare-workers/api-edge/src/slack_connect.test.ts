import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSlackConnectInvite,
  handleSlackConnectStatus,
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
            return { plan, billing_provider: "stripe" };
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
    SLACK_CONNECT_CHANNEL_ID: "C123",
    ...overrides,
  };
  return { env, kv };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slack connect status", () => {
  it("reports unavailable when the integration is not configured", async () => {
    const { env } = testEnv("pro", { SLACK_CONNECT_BOT_TOKEN: undefined });
    const res = await handleSlackConnectStatus(env, caller);
    expect(await res.json()).toEqual({
      available: false,
      eligible: false,
      email: null,
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
      invitedAt: null,
    });
  });
});

describe("slack connect invite", () => {
  it("rejects organizations without Pro or Max", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = testEnv("free");
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "slack_connect_plan_required" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invites the signed-in user's own email and remembers it", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({
        channel: "C123",
        emails: ["person@example.com"],
        external_limited: true,
      });
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer xoxb-test",
      );
      return Response.json({ ok: true, invite_id: "I1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { env, kv } = testEnv("max");

    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      invitedAt: string;
      alreadyInvited: boolean;
    };
    expect(body.email).toBe("person@example.com");
    expect(body.alreadyInvited).toBe(false);
    expect(kv.get("slack_connect_invite:org_1:user_1")).toBe(body.invitedAt);

    const again = await handleSlackConnectInvite(env, caller);
    expect(await again.json()).toMatchObject({
      alreadyInvited: true,
      invitedAt: body.invitedAt,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const status = await handleSlackConnectStatus(env, caller);
    expect(await status.json()).toMatchObject({ invitedAt: body.invitedAt });
  });

  it("maps Slack's already-invited errors without leaking provider text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: false, error: "already_in_channel" }),
      ),
    );
    const { env, kv } = testEnv("pro");
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "slack_connect_already_invited",
        message: "You're already a member of the shared channel.",
      },
    });
    expect(kv.size).toBe(0);
  });

  it("returns 502 with a generic message for unknown Slack errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false, error: "internal_error" })),
    );
    const { env } = testEnv("pro");
    const res = await handleSlackConnectInvite(env, caller);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { code: "slack_connect_invite_failed" },
    });
  });
});
