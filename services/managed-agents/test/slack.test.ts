import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  postSlackDirectMessage,
  postSlackMessage,
  resolveSlackConversation,
  resolveSlackInstallation,
  resolveSlackUser,
  setSlackThreadStatus,
  updateSlackMessage,
} from "../src/channels/slack-api.js";
import {
  PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderRequestError,
  retryAfterFromMessage,
} from "../src/channels/adapter.js";
import {
  parseSlackEventCallback,
  verifySlackSignature,
} from "../src/channels/slack-events.js";
import {
  markdownMessageBody,
  markdownToSlackMrkdwn,
} from "../src/channels/slack-format.js";

describe("raw Slack channel adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Markdown as a native markdown block with an mrkdwn fallback", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |";
    expect(markdownMessageBody(`# Title\n\n${table}\n`)).toEqual({
      text: `*Title*\n\n*A* | *B*\n• 1: 2\n`,
      blocks: [{ type: "markdown", text: `# Title\n\n${table}\n` }],
    });
    expect(markdownMessageBody("    code\nprose").blocks).toEqual([
      { type: "markdown", text: "    code\nprose" },
    ]);
    const long = "x".repeat(12_001);
    expect(markdownMessageBody(long)).toEqual({ text: long, blocks: [] });
    expect(markdownMessageBody("  \n")).toEqual({ text: "  \n", blocks: [] });
  });

  it("converts standard Markdown to Slack mrkdwn", () => {
    expect(
      markdownToSlackMrkdwn(
        "# Inbox summary\n\n" +
          "**Urgent**\n" +
          "- **Reply:** Review [the incident](https://example.com/incidents/1)\n" +
          "- *Note:* ~~Resolved~~\n\n" +
          "```ts\nconst value = \"**literal**\";\n```\n" +
          "<!channel>",
      ),
    ).toBe(
      "*Inbox summary*\n\n" +
        "*Urgent*\n" +
        "- *Reply:* Review <https://example.com/incidents/1|the incident>\n" +
        "- _Note:_ ~Resolved~\n\n" +
        "```\nconst value = \"**literal**\";\n```\n" +
        "&lt;!channel&gt;",
    );
  });

  it("restores nested placeholders and flattens tables and rules", () => {
    expect(
      markdownToSlackMrkdwn(
        "### Latest Drift Run — `#3`\n\n" +
          "---\n\n" +
          "| | |\n" +
          "|---|---|\n" +
          "| **Status** | Complete (`processing_status: completed`) |\n" +
          "| **Commit** | `ce002e10` |\n\n" +
          "**Stack Summary**\n\n" +
          "| Status | Count |\n" +
          "|---|---|\n" +
          "| Clean | **40** |\n" +
          "| Drifted | 6 |\n\n" +
          "---\n\n" +
          "Done.",
      ),
    ).toBe(
      "*Latest Drift Run — `#3`*\n\n" +
        "• *Status*: Complete (`processing_status: completed`)\n" +
        "• *Commit*: `ce002e10`\n\n" +
        "*Stack Summary*\n\n" +
        "*Status* | *Count*\n" +
        "• Clean: *40*\n" +
        "• Drifted: 6\n\n" +
        "Done.",
    );
  });

  it("flattens wide tables with links into bullet rows", () => {
    expect(
      markdownToSlackMrkdwn(
        "| Name | Company | Score | Profile |\n" +
          "|---|---|---|---|\n" +
          "| Ethan Morgan | Amazon | 75 | [link](https://www.linkedin.com/in/ethan) |\n" +
          "| **Jing-Jing Li** | Modal | 65 | [link](https://www.linkedin.com/in/jing) |\n",
      ),
    ).toBe(
      "*Name* | *Company* | *Score* | *Profile*\n" +
        "• *Ethan Morgan* | Amazon | 75 | <https://www.linkedin.com/in/ethan|link>\n" +
        "• *Jing-Jing Li* | Modal | 65 | <https://www.linkedin.com/in/jing|link>\n",
    );
  });

  it("handles tables without outer pipes, escaped pipes, and empty cells", () => {
    expect(
      markdownToSlackMrkdwn(
        "Name | Note | Score\n" +
          "--- | --- | ---\n" +
          "Ada | uses a \\| pipe | 9\n" +
          "Bob |  | 7\n\n" +
          "| Key | Value |\n" +
          "|---|---|\n" +
          "| Only key | |\n",
      ),
    ).toBe(
      "*Name* | *Note* | *Score*\n" +
        "• *Ada* | uses a | pipe | 9\n" +
        "• *Bob* | — | 7\n\n" +
        "*Key* | *Value*\n" +
        "• Only key\n",
    );
  });

  it("keeps piped prose above a rule and respects backslash parity", () => {
    expect(markdownToSlackMrkdwn("A | B\n---\nDone")).toBe("A | B\nDone");
    expect(
      markdownToSlackMrkdwn("Path \\\\| Status\n---|---\nfile \\\\| ok\n"),
    ).toBe("*Path \\\\* | *Status*\n• file \\\\: ok\n");
  });

  it("verifies and parses signed Slack callbacks", async () => {
    const payload = JSON.stringify({
      type: "event_callback",
      api_app_id: "A123",
      event_id: "Ev_test",
      team_id: "T123",
      event: {
        type: "app_mention",
        channel: "C123",
        user: "U123",
        text: "<@U456> Hello",
        ts: "123.456",
      },
    });
    const secret = "slack-secret";
    const timestamp = "1784912400";
    const signature = createHmac("sha256", secret)
      .update(`v0:${timestamp}:${payload}`)
      .digest("hex");
    const headers = new Headers({
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    });
    const now = Number(timestamp) * 1_000;
    await expect(
      verifySlackSignature(payload, headers, secret, now),
    ).resolves.toBe(true);
    expect(parseSlackEventCallback(JSON.parse(payload) as unknown)).toEqual({
      id: "Ev_test",
      appId: "A123",
      teamId: "T123",
      data: {
        type: "app_mention",
        channel: "C123",
        user: "U123",
        text: "<@U456> Hello",
        ts: "123.456",
      },
    });
  });

  it("resolves an installation and uses native Slack methods", async () => {
    const requests: Array<{
      method: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const responses = [
      {
        ok: true,
        team_id: "T123",
        team: "Acme",
        user: "inbox-helper",
        user_id: "U123",
        bot_id: "B123",
      },
      { ok: true, bot: { id: "B123", app_id: "A123" } },
      { ok: true, channel: "C123", ts: "123.457" },
      { ok: true },
      { ok: true },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          method: String(input).split("/").at(-1) ?? "",
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json(responses.shift());
      }),
    );

    await expect(resolveSlackInstallation("xoxb-test")).resolves.toEqual({
      appId: "A123",
      appName: "inbox-helper",
      teamId: "T123",
      teamName: "Acme",
      botUserId: "U123",
      botId: "B123",
    });
    await expect(
      postSlackMessage("xoxb-test", {
        channelId: "C123",
        threadTimestamp: "123.456",
        text: "Hello",
      }),
    ).resolves.toBe("123.457");
    await updateSlackMessage("xoxb-test", {
      channelId: "C123",
      messageTimestamp: "123.457",
      text: "Updated",
    });
    await setSlackThreadStatus("xoxb-test", {
      channelId: "C123",
      threadTimestamp: "123.456",
      status: {
        status: "Thinking...",
        loadingMessages: ["Reading..."],
      },
    });

    expect(requests.map((request) => request.method)).toEqual([
      "auth.test",
      "bots.info",
      "chat.postMessage",
      "chat.update",
      "assistant.threads.setStatus",
    ]);
    expect(requests.every((request) =>
      request.authorization === "Bearer xoxb-test"
    )).toBe(true);
    expect(requests[4]?.body).toMatchObject({
      channel_id: "C123",
      thread_ts: "123.456",
      status: "Thinking...",
      loading_messages: ["Reading..."],
    });
  });

  it("sends a direct message using the Slack user ID", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          method: String(input).split("/").at(-1) ?? "",
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ ok: true, channel: "D123", ts: "123.456" });
      }),
    );

    await expect(
      postSlackDirectMessage("xoxb-test", {
        userId: "U123",
        text: "Connect Gmail: https://app.example/connect",
      }),
    ).resolves.toBe("123.456");
    expect(requests).toEqual([
      {
        method: "chat.postMessage",
        body: {
          channel: "U123",
          text: "Connect Gmail: https://app.example/connect",
          blocks: [
            {
              type: "markdown",
              text: "Connect Gmail: https://app.example/connect",
            },
          ],
        },
      },
    ]);
  });

  it("resolves Slack conversations with the canonical GET request", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return Response.json({
        ok: true,
        channel: {
          id: "C123",
          name: "pull-request-reviews",
          is_member: true,
          is_private: true,
          is_archived: false,
        },
        });
      }),
    );

    await expect(resolveSlackConversation("xoxb-test", "C123")).resolves.toEqual({
      id: "C123",
      name: "pull-request-reviews",
      isMember: true,
      isPrivate: true,
      isArchived: false,
    });
    expect(requests[0]?.url).toBe(
      "https://slack.com/api/conversations.info?channel=C123",
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  it("resolves Slack users to the name Slack displays", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return Response.json({
          ok: true,
          user: {
            id: "U123",
            name: "alovelace",
            real_name: "Ada Lovelace",
            profile: { display_name: "mo", real_name: "Ada Lovelace" },
          },
        });
      }),
    );

    await expect(resolveSlackUser("xoxb-test", "U123")).resolves.toEqual({
      id: "U123",
      displayName: "mo",
    });
    expect(requests[0]?.url).toBe(
      "https://slack.com/api/users.info?user=U123",
    );
    expect(requests[0]?.init?.method).toBe("GET");

    // No display name set: the real name is what Slack shows instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          user: {
            id: "U456",
            name: "jdoe",
            real_name: "Jane Doe",
            profile: { display_name: "", real_name: "Jane Doe" },
          },
        }),
      ),
    );
    await expect(resolveSlackUser("xoxb-test", "U456")).resolves.toEqual({
      id: "U456",
      displayName: "Jane Doe",
    });
  });
});


describe("Slack request timeout", () => {
  /** The outcome of a status call as a string, so a rejection can be awaited on fake timers. */
  function statusOutcome(): Promise<string> {
    return setSlackThreadStatus("xoxb-test", {
      channelId: "C123",
      threadTimestamp: "123.456",
      status: { status: "Working..." },
    }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  it("gives up on a request Slack never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("The operation was aborted.", "AbortError")),
              );
            }),
        ),
      );
      const outcome = statusOutcome();
      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS + 1);
      await expect(outcome).resolves.toContain("timed out");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("gives up on a body Slack never finishes, not just on missing headers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          // Headers at once; a body that never ends until the signal cuts it.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("The operation was aborted.", "AbortError")),
              );
            },
          });
          return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
      const outcome = statusOutcome();
      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS + 1);
      await expect(outcome).resolves.toContain("timed out");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("carries Slack's Retry-After with a rate-limited failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "60" },
          }),
      ),
    );
    try {
      const failure = await setSlackThreadStatus("xoxb-test", {
        channelId: "C123",
        threadTimestamp: "123.456",
        status: { status: "Working..." },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ProviderRequestError);
      expect((failure as ProviderRequestError).retryAfterMs).toBe(60_000);
      // The wait survives as text, which is all an RPC boundary keeps.
      expect(retryAfterFromMessage((failure as Error).message)).toBe(60_000);
      expect(retryAfterFromMessage("Slack chat.postMessage failed: ratelimited")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
