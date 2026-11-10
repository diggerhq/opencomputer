import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelAdapter,
  channelAdapterProviders,
  hmac,
  bytesToHex,
  registerChannelAdapter,
} from "../src/channels/adapter.js";
import {
  QUESTION_SUPERSEDED_LABEL,
  questionMarkdown,
  slackAdapter,
  slackTimestampIso,
  SLACK_MARKDOWN_BLOCK_LIMIT,
  SNAPSHOT_TRIMMED_NOTE,
} from "../src/channels/slack-adapter.js";
import { twilioAdapter } from "../src/channels/twilio-adapter.js";
import { channelPrincipalId } from "../src/channels/principal.js";
import {
  fetchRecording,
  transcribeRecording,
} from "../src/channels/twilio-transcribe.js";
import {
  configureNumber,
  listNumbers,
  verifyCredential,
} from "../src/channels/twilio-setup.js";

registerChannelAdapter(slackAdapter);
registerChannelAdapter(twilioAdapter);

const SLACK_SECRET = "slack-signing-secret";
const TWILIO_TOKEN = "twilio-auth-token";

async function slackHeaders(payload: string, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const digest = await hmac("SHA-256", SLACK_SECRET, `v0:${timestamp}:${payload}`);
  return new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${bytesToHex(digest)}`,
  });
}

async function twilioHeaders(url: string, payload: string) {
  const parameters = [...new URLSearchParams(payload)].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const message = url + parameters.map(([k, v]) => `${k}${v}`).join("");
  const digest = await hmac("SHA-1", TWILIO_TOKEN, message);
  return new Headers({
    "x-twilio-signature": btoa(String.fromCharCode(...digest)),
  });
}

const slackEvent = (event: Record<string, unknown>) =>
  JSON.stringify({
    type: "event_callback",
    event_id: "Ev123",
    api_app_id: "A1",
    team_id: "T1",
    event: { type: "message", channel: "C1", user: "U1", ts: "1.1", ...event },
  });

describe("the adapter registry", () => {
  it("resolves every registered provider and nothing else", () => {
    expect(channelAdapterProviders()).toEqual(["slack", "twilio"]);
    expect(channelAdapter("slack")).toBe(slackAdapter);
    expect(channelAdapter("twilio")).toBe(twilioAdapter);
    expect(channelAdapter("carrier-pigeon")).toBeUndefined();
  });
});

describe("slack adapter", () => {
  it("verifies a signed request and rejects a tampered one", async () => {
    const payload = slackEvent({ text: "hello" });
    const headers = await slackHeaders(payload);
    expect(
      await slackAdapter.verify({ payload, headers, url: "https://x/", secret: SLACK_SECRET }),
    ).toBe(true);
    expect(
      await slackAdapter.verify({
        payload: `${payload} `,
        headers,
        url: "https://x/",
        secret: SLACK_SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a replayed request outside the timestamp window", async () => {
    const payload = slackEvent({ text: "hello" });
    const stale = Date.now() - 10 * 60 * 1000;
    const headers = await slackHeaders(payload, stale);
    expect(
      await slackAdapter.verify({
        payload,
        headers,
        url: "https://x/",
        secret: SLACK_SECRET,
      }),
    ).toBe(false);
  });

  it("answers the url_verification handshake", async () => {
    const response = slackAdapter.handshake?.({
      type: "url_verification",
      challenge: "abc",
    });
    expect(await response?.json()).toEqual({ challenge: "abc" });
    expect(slackAdapter.handshake?.({ type: "event_callback" })).toBeNull();
  });

  it("keys a threaded reply to its thread and a new message to itself", () => {
    const top = slackAdapter.parseInbound(
      JSON.parse(slackEvent({ ts: "111.1", text: "start" })),
      new Headers(),
    );
    const reply = slackAdapter.parseInbound(
      JSON.parse(slackEvent({ ts: "222.2", thread_ts: "111.1", text: "more" })),
      new Headers(),
    );
    // Keyed by speaker and thread: the same person continues their own
    // conversation, and a second person in the thread starts their own.
    expect(top?.conversationKey).toBe("U1:111.1");
    expect(reply?.conversationKey).toBe("U1:111.1");
    expect(reply?.externalUserId).toBe("U1");
    expect(reply?.text).toBe("more");
  });

  it("names the workspace and conversation an agent may serve many of", () => {
    const message = slackAdapter.parseInbound(
      JSON.parse(slackEvent({ ts: "111.1", text: "start" })),
      new Headers(),
    )!;
    // The provider's own ids, not ours: what an agent joins against its own
    // customer records when one deployment sits behind many installations.
    expect(message.workspaceId).toBe("T1");
    expect(message.conversationId).toBe("C1");
  });

  it("ignores its own bot messages", () => {
    expect(
      slackAdapter.parseInbound(
        JSON.parse(slackEvent({ bot_id: "B1", text: "echo" })),
        new Headers(),
      ),
    ).toBeNull();
  });

  it("only accepts a message from the connection that owns it", () => {
    const message = slackAdapter.parseInbound(
      JSON.parse(slackEvent({ text: "hi" })),
      new Headers(),
    )!;
    const connected = { status: "connected", teamId: "T1", appId: "A1" };
    expect(slackAdapter.matchesConnection(message, connected)).toBe(true);
    expect(
      slackAdapter.matchesConnection(message, { ...connected, teamId: "T2" }),
    ).toBe(false);
    expect(
      slackAdapter.matchesConnection(message, { ...connected, status: "revoked" }),
    ).toBe(false);
  });
});

describe("slack question cards (slack-ux P2)", () => {
  const click = (actions: unknown[]) => ({
    type: "block_actions",
    api_app_id: "A1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "9.9", thread_ts: "1.1" },
    actions,
  });

  it("reads an option click: question, option, clicker, click time and thread", () => {
    expect(
      slackAdapter.parseQuestionAnswer!(
        click([{ action_id: "opencomputer_question_answer:2", value: "question_abc:2", action_ts: "1700000000.123456" }]),
        new Headers(),
      ),
    ).toEqual({
      questionId: "question_abc",
      optionIndex: 2,
      externalUserId: "U1",
      actionTimestamp: "1700000000.123456",
      messageId: "9.9",
      replyTarget: { channelId: "C1", threadTimestamp: "1.1" },
      scope: { teamId: "T1", appId: "A1" },
    });
  });

  it("leaves approval clicks and anything else to their own readers", () => {
    const approval = click([{ action_id: "opencomputer_approval_approve", value: "apr_1", action_ts: "1.2" }]);
    expect(slackAdapter.parseQuestionAnswer!(approval, new Headers())).toBeNull();
    expect(slackAdapter.parseDecision!(approval, new Headers())).toMatchObject({ approvalId: "apr_1" });
    const answer = click([{ action_id: "opencomputer_question_answer:0", value: "question_abc:0", action_ts: "1.2" }]);
    expect(slackAdapter.parseDecision!(answer, new Headers())).toBeNull();
    expect(
      slackAdapter.parseQuestionAnswer!(
        click([{ action_id: "opencomputer_question_answer:0", value: "no-index", action_ts: "1.2" }]),
        new Headers(),
      ),
    ).toBeNull();
  });

  it("puts the turn's snapshot above the question, and trims only the snapshot to fit Slack's markdown cap", () => {
    expect(questionMarkdown({ snapshot: "  ", question: "Go?", suffix: " [↗](u)" })).toBe("Go? [↗](u)");
    expect(questionMarkdown({ snapshot: "*design* · v1\nState.", question: "Go?", suffix: " [↗](u)" })).toBe(
      "*design* · v1\nState.\n\nGo? [↗](u)",
    );
    const question = "q".repeat(4000);
    const suffix = "\n\nReply with one of: a · b [↗](https://app.example/sessions/s)";
    const long = questionMarkdown({ snapshot: "s".repeat(20_000), question, suffix });
    expect(long.length).toBeLessThanOrEqual(SLACK_MARKDOWN_BLOCK_LIMIT);
    expect(long.endsWith(`\n${SNAPSHOT_TRIMMED_NOTE}\n\n${question}${suffix}`)).toBe(true);
    expect(long.startsWith("sss")).toBe(true);
    // Exactly at the cap, nothing is trimmed.
    const fits = "s".repeat(SLACK_MARKDOWN_BLOCK_LIMIT - question.length - suffix.length - 2);
    expect(questionMarkdown({ snapshot: fits, question, suffix })).toBe(`${fits}\n\n${question}${suffix}`);
  });

  it("converts a Slack ts to ISO on Slack's clock, to the millisecond", () => {
    expect(slackTimestampIso("1700000000.123456")).toBe("2023-11-14T22:13:20.123Z");
    expect(slackTimestampIso("555.6")).toBe("1970-01-01T00:09:15.600Z");
    expect(slackTimestampIso("not-a-ts")).toBeUndefined();
  });

  it("posts the question with one uniquely named button per option, and rewrites it with no buttons once resolved", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: String(input).split("/").at(-1)!,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ ok: true, ts: "5.5" });
      }),
    );
    try {
      const card = { questionId: "question_abc", text: "Which approach?", options: [{ label: "Go" }, { label: "Wait" }] };
      const target = { channelId: "C1", threadTimestamp: "1.1" };
      const credential = { botToken: "xoxb" };
      expect(await slackAdapter.sendQuestion!({ target, text: card.text, credential, card })).toBe("5.5");
      expect(calls[0]!.body.blocks).toEqual([
        { type: "markdown", text: "Which approach?" },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Go" }, action_id: "opencomputer_question_answer:0", value: "question_abc:0" },
            { type: "button", text: { type: "plain_text", text: "Wait" }, action_id: "opencomputer_question_answer:1", value: "question_abc:1" },
          ],
        },
      ]);
      await slackAdapter.updateQuestion!({
        target,
        text: card.text,
        credential,
        messageId: "5.5",
        card: { ...card, resolved: { kind: "chosen", choice: "a <b>", by: "U1" } },
      });
      expect(calls[1]).toMatchObject({ method: "chat.update", body: { channel: "C1", ts: "5.5" } });
      expect(calls[1]!.body.blocks).toEqual([
        { type: "markdown", text: "Which approach?" },
        { type: "context", elements: [{ type: "mrkdwn", text: "chosen: a &lt;b&gt; · by <@U1>" }] },
      ]);
      await slackAdapter.updateQuestion!({
        target,
        text: card.text,
        credential,
        messageId: "5.5",
        card: { ...card, resolved: { kind: "closed", reason: "stopped" } },
      });
      expect(calls[2]!.body.blocks).toEqual([
        { type: "markdown", text: "Which approach?" },
        { type: "context", elements: [{ type: "mrkdwn", text: "closed (stopped)" }] },
      ]);
      // The text gate: one plain message, no buttons.
      expect(
        await slackAdapter.sendQuestion!({
          target,
          text: "Which approach?\n\nReply with one of: Go · Wait",
          credential,
          card: { ...card, text: "Which approach?\n\nReply with one of: Go · Wait", textGate: true },
        }),
      ).toBe("5.5");
      expect(calls[3]!.method).toBe("chat.postMessage");
      expect(JSON.stringify(calls[3]!.body)).not.toContain('"actions"');
      expect(JSON.stringify(calls[3]!.body)).toContain("Reply with one of: Go · Wait");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rewrites a superseded card with its text kept, no buttons, and one quiet line", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: String(input).split("/").at(-1)!,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ ok: true, ts: "6.6" });
      }),
    );
    try {
      const text = "Brief v2 · two streams.\n\nWhich approach? [↗](u)";
      await slackAdapter.updateQuestion!({
        target: { channelId: "C1", threadTimestamp: "1.1" },
        text,
        credential: { botToken: "xoxb" },
        messageId: "6.6",
        card: {
          questionId: "question_abc",
          text,
          options: [{ label: "Go" }, { label: "Wait" }],
          resolved: { kind: "closed", reason: "superseded" },
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "chat.update", body: { channel: "C1", ts: "6.6" } });
      expect(calls[0]!.body.blocks).toEqual([
        { type: "markdown", text },
        { type: "context", elements: [{ type: "mrkdwn", text: QUESTION_SUPERSEDED_LABEL }] },
      ]);
      expect(QUESTION_SUPERSEDED_LABEL).toBe("answered in the thread");
      // The notification text keeps the card's text and adds the same line.
      expect(calls[0]!.body.text).toBe(`${text}\n${QUESTION_SUPERSEDED_LABEL}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says which providers hold a conversation behind an open question", () => {
    // Slack's thread keeps moving past a question; a text has no buttons, so
    // an SMS question keeps holding until it is answered.
    expect(slackAdapter.questionMode).toBe("flow");
    expect(twilioAdapter.questionMode).toBe("hold");
  });
});

describe("twilio adapter", () => {
  const url = "https://edge.example.com/channels/sms/conn_1";
  const payload = new URLSearchParams({
    AccountSid: "AC1",
    MessageSid: "SM1",
    From: "+15125550147",
    To: "+15125550100",
    Body: "my water heater is leaking",
  }).toString();

  it("verifies Twilio's URL-and-parameter signature", async () => {
    const headers = await twilioHeaders(url, payload);
    expect(await twilioAdapter.verify({ payload, headers, url, secret: TWILIO_TOKEN })).toBe(true);
    // The URL is part of the signed material, so a replay at another path fails.
    expect(
      await twilioAdapter.verify({
        payload,
        headers,
        url: `${url}x`,
        secret: TWILIO_TOKEN,
      }),
    ).toBe(false);
    expect(
      await twilioAdapter.verify({ payload, headers: new Headers(), url, secret: TWILIO_TOKEN }),
    ).toBe(false);
  });

  it("keys the conversation to the participant's number", () => {
    const message = twilioAdapter.parseInbound(payload, new Headers())!;
    expect(message.conversationKey).toBe("+15125550147");
    expect(message.externalUserId).toBe("+15125550147");
    expect(message.id).toBe("SM1");
    expect(message.text).toBe("my water heater is leaking");
  });

  it("names the Twilio account as the tenant and the number as the place", () => {
    const message = twilioAdapter.parseInbound(payload, new Headers())!;
    expect(message.workspaceId).toBe("AC1");
    expect(message.conversationId).toBe("+15125550100");
  });

  it("ignores a status callback with no body", () => {
    const status = new URLSearchParams({
      AccountSid: "AC1",
      MessageSid: "SM1",
      From: "+15125550147",
      To: "+15125550100",
      MessageStatus: "delivered",
    }).toString();
    expect(twilioAdapter.parseInbound(status, new Headers())).toBeNull();
  });

  it("refuses a delivery for a number this connection does not own", () => {
    const message = twilioAdapter.parseInbound(payload, new Headers())!;
    const connection = { status: "connected", accountSid: "AC1", from: "+15125550100" };
    expect(twilioAdapter.matchesConnection(message, connection)).toBe(true);
    expect(
      twilioAdapter.matchesConnection(message, { ...connection, from: "+15125550999" }),
    ).toBe(false);
    expect(
      twilioAdapter.matchesConnection(message, { ...connection, accountSid: "AC2" }),
    ).toBe(false);
  });
});

describe("participants across providers", () => {
  it("gives the same human a stable principal and different providers different ones", async () => {
    const slack = await channelPrincipalId("slack", "acct", "conn", "U1");
    const sms = await channelPrincipalId("twilio", "acct", "conn", "+15125550147");
    expect(slack).toBe(await channelPrincipalId("slack", "acct", "conn", "U1"));
    expect(slack).not.toBe(sms);
    expect(sms.startsWith("channel:twilio:")).toBe(true);
  });
});

describe("the verify seam a provider is checked through", () => {
  // What `AccountDurableObject.verifyChannelRequest` does with the stored
  // secret, expressed against the adapters directly: each provider signs
  // different material, and the seam hands over the whole request so it can.
  it("checks Slack against the body and Twilio against the URL", async () => {
    const slackBody = slackEvent({ text: "hi" });
    const slackSigned = await slackHeaders(slackBody);
    const url = "https://edge.example.com/channels/sms/conn_1";
    const smsBody = new URLSearchParams({
      AccountSid: "AC1",
      MessageSid: "SM2",
      From: "+15125550147",
      To: "+15125550100",
      Body: "hello",
    }).toString();
    const smsSigned = await twilioHeaders(url, smsBody);

    expect(
      await channelAdapter("slack")!.verify({
        payload: slackBody,
        headers: slackSigned,
        url,
        secret: SLACK_SECRET,
      }),
    ).toBe(true);
    expect(
      await channelAdapter("twilio")!.verify({
        payload: smsBody,
        headers: smsSigned,
        url,
        secret: TWILIO_TOKEN,
      }),
    ).toBe(true);

    // Each provider's signature is meaningless to the other, so a delivery
    // aimed at the wrong adapter fails rather than being waved through.
    expect(
      await channelAdapter("twilio")!.verify({
        payload: slackBody,
        headers: slackSigned,
        url,
        secret: SLACK_SECRET,
      }),
    ).toBe(false);
    expect(
      await channelAdapter("slack")!.verify({
        payload: smsBody,
        headers: smsSigned,
        url,
        secret: TWILIO_TOKEN,
      }),
    ).toBe(false);
  });
});

describe("sending a reply", () => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  beforeEach(() => {
    fetches.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetches.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, ts: "1.1" }), {
        headers: { "content-type": "application/json" },
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts a Slack reply into the thread it came from", async () => {
    const message = slackAdapter.parseInbound(
      JSON.parse(slackEvent({ ts: "111.1", text: "hi" })),
      new Headers(),
    )!;
    await slackAdapter.send({
      target: message.replyTarget,
      text: "on it",
      credential: { botToken: "xoxb-test" },
    });
    expect(fetches[0]!.url).toContain("chat.postMessage");
    const body = JSON.parse(String(fetches[0]!.init.body));
    expect(body).toMatchObject({ channel: "C1", thread_ts: "111.1" });
  });

  it("sends a text back to the number that texted, from the number they texted", async () => {
    const payload = new URLSearchParams({
      AccountSid: "AC1",
      MessageSid: "SM1",
      From: "+15125550147",
      To: "+15125550100",
      Body: "leak",
    }).toString();
    const message = twilioAdapter.parseInbound(payload, new Headers())!;
    // The reply reverses the delivery; getting this backwards texts ourselves.
    expect(message.replyTarget).toEqual({
      to: "+15125550147",
      from: "+15125550100",
    });
    await twilioAdapter.send({
      target: message.replyTarget,
      text: "We can help — what's the address?",
      credential: { accountSid: "AC1", authToken: "token" },
    });
    expect(fetches[0]!.url).toContain("/Accounts/AC1/Messages.json");
    const sent = new URLSearchParams(String(fetches[0]!.init.body));
    expect(sent.get("To")).toBe("+15125550147");
    expect(sent.get("From")).toBe("+15125550100");
  });

  it("trims a reply Twilio would reject outright", async () => {
    await twilioAdapter.send({
      target: { to: "+1512", from: "+1513" },
      text: "x".repeat(2000),
      credential: { accountSid: "AC1", authToken: "t" },
    });
    const sent = new URLSearchParams(String(fetches[0]!.init.body));
    expect(sent.get("Body")!.length).toBe(1600);
    expect(sent.get("Body")!.endsWith("...")).toBe(true);
  });

  it("says which providers can show progress by editing a message", () => {
    // Slack edits a status message in place; a text cannot be taken back, so
    // progress there has to be silence rather than a stream of interim texts.
    expect(slackAdapter.editableProgress).toBe(true);
    expect(twilioAdapter.editableProgress).toBe(false);
  });

  it("refuses to send without the provider's credential", async () => {
    await expect(
      twilioAdapter.send({ target: { to: "+1", from: "+2" }, text: "hi", credential: {} }),
    ).rejects.toThrow(/account SID or auth token/);
    await expect(
      slackAdapter.send({ target: { channelId: "C", threadTimestamp: "1" }, text: "hi", credential: {} }),
    ).rejects.toThrow(/bot token/);
  });
});

describe("voicemail", () => {
  it("keeps a lead when the recording cannot be read", async () => {
    // Whisper returning nothing usable, or throwing, must not lose the call:
    // the caller's number is reason enough to text them.
    const silent = { run: async () => ({ text: "  " }) };
    const broken = { run: async () => { throw new Error("model unavailable"); } };
    expect(await transcribeRecording(silent, new ArrayBuffer(8))).toBeNull();
    expect(await transcribeRecording(broken, new ArrayBuffer(8))).toBeNull();
  });

  it("ignores a transcript too short to be a message", async () => {
    // Whisper emits filler for silence; two words is not a voicemail.
    const filler = { run: async () => ({ text: "Thanks." }) };
    expect(await transcribeRecording(filler, new ArrayBuffer(8))).toBeNull();
  });

  it("returns a real message", async () => {
    const model = {
      run: async () => ({
        text: "  Hi, this is Marcy, my water heater is leaking.  ",
      }),
    };
    expect(await transcribeRecording(model, new ArrayBuffer(8))).toBe(
      "Hi, this is Marcy, my water heater is leaking.",
    );
  });

  it("downloads the recording with the connection's own credential", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response(new ArrayBuffer(16));
    });
    await fetchRecording("https://api.twilio.com/rec/RE1", {
      accountSid: "AC1",
      authToken: "token",
    });
    vi.unstubAllGlobals();
    // Twilio serves recordings from an authenticated URL, and appending the
    // format avoids a transcode on their side.
    expect(calls[0]!.url).toBe("https://api.twilio.com/rec/RE1.wav");
    expect(calls[0]!.auth).toBe(`Basic ${btoa("AC1:token")}`);
  });
})

describe("connecting Twilio", () => {
  const credential = { accountSid: "AC1", authToken: "token" };
  let calls: Array<{ url: string; method: string; body?: string; auth: string | null }>;

  function respond(handler: (url: string) => Response) {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        ...(init.body ? { body: String(init.body) } : {}),
        auth: new Headers(init.headers).get("authorization"),
      });
      return handler(String(url));
    });
  }

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names the account back so the operator can see they pasted the right one", async () => {
    respond(() =>
      Response.json({ friendly_name: "Dave's Plumbing", status: "active" }),
    );
    await expect(verifyCredential(credential)).resolves.toEqual({
      friendlyName: "Dave's Plumbing",
    });
    expect(calls[0]!.auth).toBe(`Basic ${btoa("AC1:token")}`);
  });

  it("tells the operator their credentials were rejected, not that we broke", async () => {
    respond(() => new Response("", { status: 401 }));
    await expect(verifyCredential(credential)).rejects.toMatchObject({
      code: "twilio_credentials_rejected",
    });
  });

  it("refuses a suspended account before anything is stored", async () => {
    respond(() => Response.json({ friendly_name: "x", status: "suspended" }));
    await expect(verifyCredential(credential)).rejects.toMatchObject({
      code: "twilio_account_inactive",
    });
  });

  it("reports what each number can actually do", async () => {
    respond(() =>
      Response.json({
        incoming_phone_numbers: [
          {
            sid: "PN1",
            phone_number: "+15125550100",
            friendly_name: "Main line",
            capabilities: { sms: true, voice: true },
          },
          {
            sid: "PN2",
            phone_number: "+15125550200",
            capabilities: { sms: true, voice: false },
          },
        ],
      }),
    );
    const numbers = await listNumbers(credential);
    expect(numbers).toHaveLength(2);
    // A number that cannot take a call cannot catch a missed one, and the
    // caller of this decides whether to offer it.
    expect(numbers[1]!.capabilities.voice).toBe(false);
    expect(numbers[1]!.friendlyName).toBe("+15125550200");
  });

  it("points a number at both endpoints, not just one", async () => {
    respond(() => Response.json({ sid: "PN1" }));
    await configureNumber(credential, "PN1", {
      smsUrl: "https://edge.example/v1/webhooks/twilio/c/t/sms",
      voiceUrl: "https://edge.example/v1/webhooks/twilio/c/t/voice",
    });
    const sent = new URLSearchParams(calls[0]!.body!);
    // Wiring only one leaves a system that half works in a way that is hard
    // to diagnose: texts arrive but missed calls vanish, or the reverse.
    expect(sent.get("SmsUrl")).toContain("/sms");
    expect(sent.get("VoiceUrl")).toContain("/voice");
    expect(sent.get("SmsMethod")).toBe("POST");
    expect(sent.get("VoiceMethod")).toBe("POST");
    expect(calls[0]!.url).toContain("/IncomingPhoneNumbers/PN1.json");
  });

  it("surfaces Twilio's own reason when it will not accept the configuration", async () => {
    respond(() => new Response("Number not owned by account", { status: 404 }));
    await expect(
      configureNumber(credential, "PN9", { smsUrl: "https://a", voiceUrl: "https://b" }),
    ).rejects.toMatchObject({ code: "twilio_number_configuration_failed" });
  });
});

describe("Twilio signatures behind a proxy", () => {
  // Found against a live account: Twilio signs the URL it finally reached,
  // which a TLS-terminating proxy or a tunnel that upgrades the connection can
  // spell differently from what the Worker reconstructs. Every delivery 401s,
  // and it reads as a bad signature rather than a scheme mismatch.
  const body = new URLSearchParams({
    AccountSid: "AC1",
    MessageSid: "SM1",
    From: "+15125550147",
    To: "+15125550100",
    Body: "hello",
  }).toString();

  async function signedFor(url: string) {
    const tail = [...new URLSearchParams(body)]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}${v}`)
      .join("");
    const digest = await hmac("SHA-1", TWILIO_TOKEN, url + tail);
    return new Headers({
      "x-twilio-signature": btoa(String.fromCharCode(...digest)),
    });
  }

  it("accepts a signature made over https when it received http", async () => {
    const headers = await signedFor("https://edge.example.com/hook");
    expect(
      await twilioAdapter.verify({
        payload: body,
        headers,
        url: "http://edge.example.com/hook",
        secret: TWILIO_TOKEN,
      }),
    ).toBe(true);
  });

  it("accepts the reverse, for a proxy that downgrades", async () => {
    const headers = await signedFor("http://edge.example.com/hook");
    expect(
      await twilioAdapter.verify({
        payload: body,
        headers,
        url: "https://edge.example.com/hook",
        secret: TWILIO_TOKEN,
      }),
    ).toBe(true);
  });

  it("still refuses a different host or path", async () => {
    const headers = await signedFor("https://edge.example.com/hook");
    for (const url of [
      "https://attacker.example.com/hook",
      "https://edge.example.com/other",
    ]) {
      expect(
        await twilioAdapter.verify({
          payload: body,
          headers,
          url,
          secret: TWILIO_TOKEN,
        }),
      ).toBe(false);
    }
  });
})

describe("a reply address survives storage", () => {
  // The bug this pins: the stored address was rebuilt as
  // `{channelId, threadTimestamp}` on the way out, so any provider that does
  // not address a channel and a thread got an empty target and its own adapter
  // refused to send. It failed silently — the agent answered, the delivery was
  // attempted, and nothing arrived.
  function roundTrip(ref: Record<string, unknown>) {
    return JSON.parse(JSON.stringify(ref)) as Record<string, unknown>;
  }

  it("hands Twilio back the numbers it stored, not a channel and a thread", async () => {
    const stored = roundTrip({ to: "+15125550147", from: "+15125550100" });
    const fetches: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      fetches.push(init);
      return Response.json({ sid: "SM1" });
    });
    await twilioAdapter.send({
      target: stored,
      text: "on our way",
      credential: { accountSid: "AC1", authToken: "t" },
    });
    const sent = new URLSearchParams(String(fetches[0]!.body));
    expect(sent.get("To")).toBe("+15125550147");
    expect(sent.get("From")).toBe("+15125550100");
    vi.unstubAllGlobals();
  });

  it("refuses to send when the address was emptied on the way through", async () => {
    // What the old shape produced for a Twilio row.
    await expect(
      twilioAdapter.send({
        target: { channelId: "", threadTimestamp: "" },
        text: "on our way",
        credential: { accountSid: "AC1", authToken: "t" },
      }),
    ).rejects.toThrow(/to or from number/);
  });
})
