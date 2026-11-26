import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlackAppFromManifest,
  exchangeSlackOAuthCode,
  SlackApiError,
  verifySlackInstallation,
} from "../src/channels/slack-api.js";
import { slackCreationFailure } from "../src/channels/slack-setup.js";

const CONFIG_TOKEN = "xoxe.xoxp-1-configuration-token-must-not-leak";
const CLIENT_SECRET = "client-secret-must-not-leak";
const SIGNING_SECRET = "f".repeat(32);
const CODE = "1234.5678.authorization-code-must-not-leak";

interface Captured {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
}

function capture(
  respond: (call: Captured) => Response | Promise<Response>,
): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

async function failure(promise: Promise<unknown>): Promise<SlackApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SlackApiError);
    return error as SlackApiError;
  }
  throw new Error("expected the call to fail");
}

describe("Slack app provisioning calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  const manifest = { display_information: { name: "Coder" } };

  it("creates an app from a manifest, form-encoded, with the configuration token as bearer", async () => {
    const calls = capture(() =>
      Response.json({
        ok: true,
        app_id: "A0FAKE",
        credentials: {
          client_id: "111.222",
          client_secret: CLIENT_SECRET,
          verification_token: "legacy",
          signing_secret: SIGNING_SECRET,
        },
        oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111.222&scope=chat:write",
      }),
    );
    const created = await createSlackAppFromManifest(CONFIG_TOKEN, manifest);
    expect(created).toEqual({
      appId: "A0FAKE",
      clientId: "111.222",
      clientSecret: CLIENT_SECRET,
      signingSecret: SIGNING_SECRET,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.com/api/apps.manifest.create");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${CONFIG_TOKEN}`);
    expect(calls[0]!.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(calls[0]!.body);
    expect(JSON.parse(form.get("manifest") ?? "")).toEqual(manifest);
    expect(form.has("token")).toBe(false);
  });

  it("classifies an explicit rejection as recoverable and carries the manifest pointer", async () => {
    capture(() =>
      Response.json({
        ok: false,
        error: "invalid_manifest",
        errors: [
          { message: "Invalid request URL", pointer: "/settings/event_subscriptions/request_url" },
        ],
      }),
    );
    const error = await failure(createSlackAppFromManifest(CONFIG_TOKEN, manifest));
    expect(error.outcome).toBe("rejected");
    expect(error.code).toBe("invalid_manifest");
    expect(error.manifestErrors).toEqual([
      { message: "Invalid request URL", pointer: "/settings/event_subscriptions/request_url" },
    ]);
    expect(error.message).not.toContain(CONFIG_TOKEN);
    expect(error.message).not.toContain("Invalid request URL");
  });

  it("carries the rate-limit wait on a rejection", async () => {
    capture(() =>
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      }),
    );
    const error = await failure(createSlackAppFromManifest(CONFIG_TOKEN, manifest));
    expect(error.outcome).toBe("rejected");
    expect(error.code).toBe("ratelimited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("carries the rate-limit wait on a 429 without a body", async () => {
    capture(() => new Response(null, { status: 429, headers: { "retry-after": "7" } }));
    const error = await failure(createSlackAppFromManifest(CONFIG_TOKEN, manifest));
    expect(error.retryAfterMs).toBe(7_000);
  });

  it.each([
    ["a transport failure", () => { throw new TypeError("fetch failed"); }, "transport"],
    ["a 5xx", () => new Response("bad gateway", { status: 502 }), "http_502"],
    ["Slack's own internal_error", () => Response.json({ ok: false, error: "internal_error" }), "internal_error"],
    ["a success without credentials", () => Response.json({ ok: true, app_id: "A0FAKE" }), "malformed_response"],
    ["an unparseable body", () => new Response("<html>", { status: 200 }), "malformed_response"],
  ])("treats %s after dispatch as uncertain", async (_label, respond, code) => {
    capture(respond as () => Response);
    const error = await failure(createSlackAppFromManifest(CONFIG_TOKEN, manifest));
    expect(error.outcome).toBe("uncertain");
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(CONFIG_TOKEN);
  });

  it("never retries a create", async () => {
    const calls = capture(() => { throw new TypeError("fetch failed"); });
    await failure(createSlackAppFromManifest(CONFIG_TOKEN, manifest));
    expect(calls).toHaveLength(1);
  });

  it("exchanges an authorization code with the client credentials in the form body only", async () => {
    const calls = capture(() =>
      Response.json({
        ok: true,
        access_token: "xoxb-bot-token-must-not-leak",
        token_type: "bot",
        scope: "app_mentions:read,chat:write",
        bot_user_id: "U0BOT",
        app_id: "A0FAKE",
        team: { id: "T0TEAM", name: "Acme" },
        enterprise: null,
        authed_user: { id: "U0HUMAN" },
      }),
    );
    const grant = await exchangeSlackOAuthCode({
      clientId: "111.222",
      clientSecret: CLIENT_SECRET,
      code: CODE,
      redirectUri: "https://api.example/api/managed-agents/slack/callback",
    });
    expect(grant).toEqual({
      accessToken: "xoxb-bot-token-must-not-leak",
      tokenType: "bot",
      scopes: ["app_mentions:read", "chat:write"],
      botUserId: "U0BOT",
      appId: "A0FAKE",
      teamId: "T0TEAM",
      teamName: "Acme",
      authedUserId: "U0HUMAN",
      isEnterpriseInstall: false,
    });
    expect(calls[0]!.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("code")).toBe(CODE);
    expect(form.get("client_id")).toBe("111.222");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("redirect_uri")).toBe("https://api.example/api/managed-agents/slack/callback");
  });

  it("reports a used code as a rejection without echoing any secret", async () => {
    capture(() => Response.json({ ok: false, error: "invalid_code" }));
    const error = await failure(
      exchangeSlackOAuthCode({
        clientId: "111.222",
        clientSecret: CLIENT_SECRET,
        code: CODE,
        redirectUri: "https://api.example/cb",
      }),
    );
    expect(error.outcome).toBe("rejected");
    expect(error.code).toBe("invalid_code");
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain(CODE);
  });

  it("reads an enterprise grant back as such", async () => {
    capture(() =>
      Response.json({
        ok: true,
        access_token: "xoxb-x",
        token_type: "bot",
        scope: "chat:write",
        bot_user_id: "U0BOT",
        app_id: "A0FAKE",
        team: null,
        enterprise: { id: "E0", name: "Org" },
        is_enterprise_install: true,
      }),
    );
    const grant = await exchangeSlackOAuthCode({
      clientId: "111.222",
      clientSecret: CLIENT_SECRET,
      code: CODE,
      redirectUri: "https://api.example/cb",
    });
    expect(grant.isEnterpriseInstall).toBe(true);
    expect(grant.teamId).toBeUndefined();
  });
});

describe("Slack creation failure mapping", () => {
  it("returns only the documented side-effect-free rejections to prepared", () => {
    for (const code of [
      "invalid_auth",
      "not_authed",
      "token_expired",
      "token_revoked",
      "missing_scope",
      "not_allowed_token_type",
      "invalid_manifest",
      "managed_app_limit_reached",
      "invalid_team_id",
      "not_in_team",
      "ratelimited",
    ]) {
      const mapped = slackCreationFailure(
        new SlackApiError("apps.manifest.create", "rejected", code),
      );
      expect(mapped.outcome, code).toBe("rejected");
      // A rejected manifest is the one thing a resubmission under the same
      // setup cannot fix: the snapshot is what Slack refused.
      expect(mapped.error.recoverable, code).toBe(code !== "invalid_manifest");
    }
  });

  it("treats a rejection Slack does not document as side-effect-free as uncertain", () => {
    for (const code of ["failed_creating_app", "invalid_app", "something_new"]) {
      const mapped = slackCreationFailure(
        new SlackApiError("apps.manifest.create", "rejected", code),
      );
      expect(mapped.outcome, code).toBe("uncertain");
      expect(mapped.error.code, code).toBe("slack_creation_uncertain");
      expect(mapped.error.recoverable, code).toBe(false);
    }
  });
});

describe("Slack installation verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  const EXPECTED = { appId: "A0FAKE", teamId: "T0TEAM", botUserId: "U0BOT" };

  /** bots.info needs users:read, which installs minted before the name scopes lack. */
  function slack(authTest: Record<string, unknown>) {
    return capture((call) =>
      Response.json(
        call.url.endsWith("auth.test")
          ? authTest
          : { ok: false, error: "missing_scope" },
      ),
    );
  }

  it("proves the workspace and bot through auth.test alone", async () => {
    const calls = slack({
      ok: true,
      team_id: "T0TEAM",
      team: "Acme",
      user: "coder",
      user_id: "U0BOT",
      bot_id: "B0",
    });
    await expect(verifySlackInstallation("xoxb-x", EXPECTED)).resolves.toEqual({
      appId: "A0FAKE",
      appName: "coder",
      teamId: "T0TEAM",
      teamName: "Acme",
      botUserId: "U0BOT",
      botId: "B0",
    });
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual(["auth.test"]);
  });

  it("rejects a token that auth.test places in another workspace", async () => {
    slack({ ok: true, team_id: "T0OTHER", user_id: "U0BOT", bot_id: "B0" });
    const error = await failure(verifySlackInstallation("xoxb-x", EXPECTED));
    expect(error.outcome).toBe("rejected");
    expect(error.code).toBe("workspace_mismatch");
  });

  it("rejects a token whose bot is not the one the grant named", async () => {
    slack({ ok: true, team_id: "T0TEAM", user_id: "U0OTHER", bot_id: "B0" });
    const error = await failure(verifySlackInstallation("xoxb-x", EXPECTED));
    expect(error.code).toBe("bot_mismatch");
  });

  it("reports an unusable token as a rejection and a stalled Slack as uncertain", async () => {
    capture(() => Response.json({ ok: false, error: "invalid_auth" }));
    expect((await failure(verifySlackInstallation("xoxb-x", EXPECTED))).code).toBe("invalid_auth");
    capture(() => { throw new TypeError("fetch failed"); });
    expect((await failure(verifySlackInstallation("xoxb-x", EXPECTED))).outcome).toBe("uncertain");
  });
});
