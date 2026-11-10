import { describe, expect, it, vi } from "vitest";

import { verifySlackSignature } from "../src/channels/slack-events.js";
import { gatewayUrl, publicError, sizeFor, sizeShape } from "../src/computer/config.js";
import { bytesToBase64Url, seal, unseal } from "../src/computer/crypto.js";
import { DEFINITION_REPO_LIMIT, EAGER_REPO_COUNT, selectTokenTarget, workspaceDefinition } from "../src/computer/github.js";
import { constantTimeEqual, hostAuthorized, hostToken } from "../src/computer/host-token.js";
import { takeHarnessPrefix } from "../src/computer/harnesses.js";
import {
  IDLE_PARK_MS,
  UNPAID_PARK_MS,
  UNPAID_WARN_MS,
  daysUnpaid,
  idleParkMs,
  parkingDecision,
  unpaidStage,
  unpaidWarning,
  unpaidWarningGiven,
} from "../src/computer/parking.js";
import { resolvePlan, sizeTier } from "../src/computer/plan.js";
import { decodeCalvinActionId, parseSessionKey } from "../src/computer/protocol.js";
import {
  decodeInstallState,
  decodeSlack,
  encodeInstallState,
  joinRequestMessages,
  normalizeJob,
  parseInteraction,
  parseSlackEnvelope,
  slackThreadUrl,
} from "../src/computer/slack.js";
import { TEAM_ACCOUNT_TTL_MS, TeamAccountCache } from "../src/computer/team-cache.js";
import { ThreadAccess, findThreadLinks, forwardedLinked, neutralizeBroadcasts, stripAttribution, threadRefFor } from "../src/computer/threads.js";

describe("new-thread harness prefixes", () => {
  it.each([
    ["+claude +smart fix it", { harness: "claude", text: "+smart fix it" }],
    ["+codex +fast fix it", { harness: "codex", text: "+fast fix it" }],
    ["  +CLAUDE\n+default go", { harness: "claude", text: "+default go" }],
    ["+codex go", { harness: "codex", text: "go" }],
    ["+claude", { harness: "claude", text: "" }],
    ["+smart go", { text: "+smart go" }],
    ["use +claude here", { text: "use +claude here" }],
    ["+claude-code go", { text: "+claude-code go" }],
    ["`+codex` go", { text: "`+codex` go" }],
  ])("%s", (input, expected) => expect(takeHarnessPrefix(input)).toEqual(expected));
});

describe("host tokens", () => {
  it("derives one token per organization with a gateway-only key", async () => {
    const a = await hostToken("key", "org_a");
    expect(a).toMatch(/^sph_[A-Za-z0-9_-]{43}$/);
    expect(await hostToken("key", "org_a")).toBe(a);
    expect(await hostToken("key", "org_b")).not.toBe(a);
    expect(await hostToken("other-key", "org_a")).not.toBe(a);
  });

  it("admits only the organization's own token; no key, no host", async () => {
    const token = await hostToken("key", "org_a");
    expect(await hostAuthorized(token, "org_a", "key")).toBe(true);
    expect(await hostAuthorized(token, "org_b", "key")).toBe(false);
    expect(await hostAuthorized(token, null, "key")).toBe(false);
    expect(await hostAuthorized(undefined, "org_a", "key")).toBe(false);
    expect(await hostAuthorized(token, "org_a", undefined)).toBe(false);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
});

describe("computer config and vocabulary", () => {
  it("sizes by plan and describes sizes without naming them", () => {
    const env = { ACCOUNTS: {} as DurableObjectNamespace };
    expect(sizeFor(env, "default")).toBe("Standard_D2as_v7");
    expect(sizeFor({ ...env, COMPUTER_MAX_SIZE: "Standard_D8as_v7" }, "max")).toBe("Standard_D8as_v7");
    expect(sizeFor({ ...env, COMPUTER_MAX_SIZE: "Standard_D8as_v7" }, "default")).toBe("Standard_D2as_v7");
    // The former name still works; the new one wins.
    expect(sizeFor({ ...env, COMPUTER_PAID_SIZE: "Standard_D4as_v7" }, "max")).toBe("Standard_D4as_v7");
    expect(sizeFor({ ...env, COMPUTER_PAID_SIZE: "Standard_D4as_v7", COMPUTER_MAX_SIZE: "Standard_D8as_v7" }, "max")).toBe("Standard_D8as_v7");
    expect(sizeFor({ ...env, COMPUTER_MAX_SIZE: "" }, "max")).toBe("Standard_D2as_v7");
    expect(sizeShape("Standard_D2as_v7")).toEqual({ vcpus: 2, memoryGiB: 8 });
    expect(sizeShape("Standard_E4as_v7")).toEqual({ vcpus: 4, memoryGiB: 32 });
    expect(sizeShape("Standard_D16as_v7")).toEqual({ vcpus: 16, memoryGiB: 64 });
  });

  it("builds the gateway URL the host dials", () => {
    expect(gatewayUrl("wss://managedagents.opencomputer.dev", "org_01H")).toBe(
      "wss://managedagents.opencomputer.dev/v1/computer/host?organizationId=org_01H",
    );
    expect(gatewayUrl("https://x.dev/", "a:b")).toBe("wss://x.dev/v1/computer/host?organizationId=a%3Ab");
  });

  it("keeps cloud details out of public errors", () => {
    for (const raw of [
      "computers are not configured: missing AZURE_COMPUTER_SUBNET_ID",
      "VM provisioning failed: Allocation failed in eastus for Standard_D2as_v7",
      "PUT Microsoft.Compute/virtualMachines/oc-org-1: 400 InvalidParameter",
    ]) {
      expect(publicError(raw)).not.toMatch(/azure|eastus|Standard_|Microsoft|oc-org/i);
    }
  });
});

describe("parking decision", () => {
  const base = { plan: "free" as const, state: "ready", hostConnected: true, busySessions: 0, pendingDispatches: 0, lastActivityAt: 0, now: IDLE_PARK_MS };
  it("parks a free, idle, ready computer after two hours", () => {
    expect(parkingDecision(base)).toEqual({ park: true, recheckAt: null });
    expect(parkingDecision({ ...base, now: IDLE_PARK_MS - 1 })).toEqual({ park: false, recheckAt: IDLE_PARK_MS });
  });
  it("never parks paid, busy, queued or non-ready computers", () => {
    expect(parkingDecision({ ...base, plan: "paid" }).park).toBe(false);
    expect(parkingDecision({ ...base, busySessions: 1 }).park).toBe(false);
    expect(parkingDecision({ ...base, pendingDispatches: 1 }).park).toBe(false);
    expect(parkingDecision({ ...base, state: "provisioning" })).toEqual({ park: false, recheckAt: null });
    // Free computers park after 30 idle minutes by default; configurable within bounds.
    expect(IDLE_PARK_MS).toBe(30 * 60_000);
    expect(parkingDecision({ ...base, now: 10 * 60_000, idleMs: 10 * 60_000 }).park).toBe(true);
  });
  it("never parks a warm pool computer", () => {
    expect(parkingDecision({ ...base, pool: true })).toEqual({ park: false, recheckAt: null });
  });
  it("does not trust session statuses while the host is away", () => {
    expect(parkingDecision({ ...base, hostConnected: false, busySessions: 3 }).park).toBe(true);
  });
  it("parks an unpaid paid computer like a free one, never mid-work", () => {
    expect(parkingDecision({ ...base, plan: "paid", unpaid: true })).toEqual({ park: true, recheckAt: null });
    expect(parkingDecision({ ...base, plan: "paid", unpaid: true, busySessions: 1 }).park).toBe(false);
    expect(parkingDecision({ ...base, plan: "paid", unpaid: true, pool: true }).park).toBe(false);
  });
  it("keeps a free computer on during its trial, and looks again when the trial ends", () => {
    const trialEndsAt = base.now + 60 * 60_000;
    expect(parkingDecision({ ...base, trialEndsAt })).toEqual({ park: false, recheckAt: base.now + IDLE_PARK_MS });
    expect(parkingDecision({ ...base, trialEndsAt: base.now + 60_000 })).toEqual({ park: false, recheckAt: base.now + 60_000 });
    // Over by the clock but not yet halted (billing lags): parks when idle, as free does.
    expect(parkingDecision({ ...base, trialEndsAt: base.now })).toEqual({ park: true, recheckAt: null });
    expect(parkingDecision({ ...base, trialEndsAt: null })).toEqual({ park: true, recheckAt: null });
    // A warm pool computer is never in a trial's way.
    expect(parkingDecision({ ...base, pool: true, trialEndsAt })).toEqual({ park: false, recheckAt: null });
  });
  it("parks a free computer billing refuses without waiting to be idle, never mid-work", () => {
    const active = { ...base, lastActivityAt: base.now, trialEndsAt: base.now + 60 * 60_000, halted: true };
    expect(parkingDecision(active)).toEqual({ park: true, recheckAt: null });
    expect(parkingDecision({ ...active, busySessions: 1 }).park).toBe(false);
    // `halted` is about free organizations; a paid one goes through the unpaid clock.
    expect(parkingDecision({ ...active, plan: "paid" }).park).toBe(false);
  });
  it("parks an unpaid computer without waiting to be idle: preview traffic does not keep it", () => {
    expect(parkingDecision({ ...base, plan: "paid", unpaid: true, lastActivityAt: base.now })).toEqual({ park: true, recheckAt: null });
    expect(parkingDecision({ ...base, plan: "paid", unpaid: true, lastActivityAt: base.now, pendingDispatches: 1 }).park).toBe(false);
  });
});

describe("unpaid computers (work 086)", () => {
  const day = 24 * 60 * 60_000;
  const haltedAt = 1_000 * day;
  it("does nothing before day 6 or when billing admits the organization", () => {
    expect(unpaidStage({ haltedAt: null, warnedAt: null, now: haltedAt + 30 * day })).toBe("none");
    expect(unpaidStage({ haltedAt, warnedAt: null, now: haltedAt + UNPAID_WARN_MS - 1 })).toBe("none");
  });
  it("warns on day 6 and parks on day 7", () => {
    expect(UNPAID_WARN_MS).toBe(6 * day);
    expect(UNPAID_PARK_MS).toBe(7 * day);
    expect(unpaidStage({ haltedAt, warnedAt: null, now: haltedAt + 6 * day })).toBe("warn");
    const warnedAt = haltedAt + 6 * day;
    expect(unpaidStage({ haltedAt, warnedAt, now: haltedAt + 7 * day - 1 })).toBe("wait");
    expect(unpaidStage({ haltedAt, warnedAt, now: haltedAt + 7 * day })).toBe("park");
  });
  it("parks no sooner than a day after the warning", () => {
    // First seen on day 9: warned now, parked tomorrow.
    expect(unpaidStage({ haltedAt, warnedAt: null, now: haltedAt + 9 * day })).toBe("warn");
    expect(unpaidStage({ haltedAt, warnedAt: haltedAt + 9 * day, now: haltedAt + 10 * day - 1 })).toBe("wait");
    expect(unpaidStage({ haltedAt, warnedAt: haltedAt + 9 * day, now: haltedAt + 10 * day })).toBe("park");
  });
  it("does not count a warning for an earlier halt", () => {
    expect(unpaidStage({ haltedAt, warnedAt: haltedAt - day, now: haltedAt + 7 * day })).toBe("warn");
  });
  it("counts a warning given only once delivered, or when nobody can be reached", () => {
    expect(unpaidWarningGiven({ reachable: true, sent: true })).toBe(true);
    expect(unpaidWarningGiven({ reachable: true, sent: false })).toBe(false);
    expect(unpaidWarningGiven({ reachable: false, sent: false })).toBe(true);
  });
  it("counts whole days and links billing", () => {
    expect(daysUnpaid(haltedAt, haltedAt + 7 * day + 5)).toBe(7);
    expect(unpaidWarning("https://app.opencomputer.dev")).toContain("https://app.opencomputer.dev/billing");
  });
});

describe("plan resolution", () => {
  const billing = (fields: { paid?: boolean; usagePlan?: "base" | "pro" | "max" | null }) => ({
    checkAdmission: async () => ({ allowed: true, isHalted: false, haltedAt: null, reason: null as null, ...fields }),
  });
  it("reads `paid` from the billing service and defaults to paid when it cannot tell", async () => {
    expect(await resolvePlan(billing({ paid: false }), "o")).toEqual({ plan: "free", known: true, usagePlan: null, haltedAt: null, trialEndsAt: null });
    expect(await resolvePlan(billing({ paid: true }), "o")).toEqual({ plan: "paid", known: true, usagePlan: null, haltedAt: null, trialEndsAt: null });
    expect(await resolvePlan(billing({}), "o")).toEqual({ plan: "paid", known: false, usagePlan: null, haltedAt: null, trialEndsAt: null });
    expect(await resolvePlan(undefined, "o")).toEqual({ plan: "paid", known: false, usagePlan: null, haltedAt: null, trialEndsAt: null });
    expect(await resolvePlan({ checkAdmission: async () => Promise.reject(new Error("down")) }, "o")).toEqual({ plan: "paid", known: false, usagePlan: null, haltedAt: null, trialEndsAt: null });
  });
  it("reads since when billing refuses the organization, in ms; admitted (the fallback) is not refused", async () => {
    const halted = (allowed: boolean) => ({
      checkAdmission: async () => ({ allowed, isHalted: true, haltedAt: 1_700_000_000, reason: null as null, paid: true }),
    });
    expect((await resolvePlan(halted(false), "o")).haltedAt).toBe(1_700_000_000_000);
    expect((await resolvePlan(halted(true), "o")).haltedAt).toBeNull();
  });
  it("reads when a free organization's trial ends, in ms; a service that predates it says none", async () => {
    const trial = { checkAdmission: async () => ({ allowed: true, isHalted: false, haltedAt: null, reason: null as null, paid: false, trialEndsAt: 1_793_500_000 }) };
    expect((await resolvePlan(trial, "o")).trialEndsAt).toBe(1_793_500_000_000);
    expect((await resolvePlan(billing({ paid: false }), "o")).trialEndsAt).toBeNull();
  });
  it("reads the usage plan: only max gets the bigger size, and an absent one resizes nothing", async () => {
    expect(await resolvePlan(billing({ paid: true, usagePlan: "max" }), "o")).toEqual({ plan: "paid", known: true, usagePlan: "max", haltedAt: null, trialEndsAt: null });
    expect(await resolvePlan(billing({ paid: true, usagePlan: "pro" }), "o")).toEqual({ plan: "paid", known: true, usagePlan: "pro", haltedAt: null, trialEndsAt: null });
    // null from a service that knows the field: no plan, the default size.
    expect(await resolvePlan(billing({ paid: false, usagePlan: null }), "o")).toEqual({ plan: "free", known: true, usagePlan: "base", haltedAt: null, trialEndsAt: null });
    expect(sizeTier("max")).toBe("max");
    expect(sizeTier("pro")).toBe("default");
    expect(sizeTier("base")).toBe("default");
    expect(sizeTier(null)).toBeNull();
  });
});

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("Slack", () => {
  it("verifies v0 signatures within five minutes", async () => {
    const now = 1_800_000_000_000;
    const ts = String(now / 1000);
    const headers = (signature: string, timestamp = ts) => new Headers({ "x-slack-signature": signature, "x-slack-request-timestamp": timestamp });
    const good = await sign("secret", ts, "{}");
    expect(await verifySlackSignature("{}", headers(good), "secret", now)).toBe(true);
    expect(await verifySlackSignature("{ }", headers(good), "secret", now)).toBe(false);
    expect(await verifySlackSignature("{}", headers(good), "other", now)).toBe(false);
    expect(await verifySlackSignature("{}", headers(good), "secret", now + 6 * 60_000)).toBe(false);
  });

  it("keeps a forwarded message's copy, which Slack sends in attachments, and skips link previews", () => {
    const event = (text: string) => ({
      type: "event_callback",
      event_id: "Ev2",
      team_id: "T1",
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text,
        ts: "2.2",
        attachments: [
          {
            // Slack's shape for a forward: both flags.
            is_share: true,
            is_msg_unfurl: true,
            from_url: "https://acme.slack.com/archives/C9/p1793394313352819",
            author_name: "Alec Watts",
            channel_name: "autumn-kino",
            ts: "1793394313.352819",
            text: "Checkout succeeded &amp; still on Free",
          },
          { is_msg_unfurl: true, text: "a link preview" },
        ],
      },
    });
    const parsed = parseSlackEnvelope(event("<@UBOT> check please"));
    if (parsed.kind !== "message") throw new Error(parsed.kind);
    expect(parsed.job.forwarded).toEqual([
      { url: "https://acme.slack.com/archives/C9/p1793394313352819", author: "Alec Watts", channel: "autumn-kino", ts: "1793394313.352819", text: "Checkout succeeded &amp; still on Free" },
    ]);
    expect(normalizeJob(parsed.job, "UBOT")?.text).toBe("check please");
    expect(forwardedLinked(parsed.job.forwarded)).toEqual([
      {
        url: "https://acme.slack.com/archives/C9/p1793394313352819",
        ok: true,
        forwarded: true,
        where: "#autumn-kino",
        messages: [{ name: "Alec Watts", ts: "1793394313.352819", text: "Checkout succeeded & still on Free" }],
      },
    ]);
    // A forward with no comment still reaches the session.
    const bare = parseSlackEnvelope(event(""));
    expect(bare.kind).toBe("message");
    if (bare.kind === "message") expect(normalizeJob(bare.job, "UBOT")).not.toBeNull();
  });

  it("parses challenges, messages, stops and ignores bots", () => {
    expect(parseSlackEnvelope({ type: "url_verification", challenge: "c" })).toEqual({ kind: "challenge", challenge: "c" });
    const parsed = parseSlackEnvelope(
      {
        type: "event_callback",
        event_id: "Ev1",
        team_id: "T1",
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "<@UBOT> hi",
          ts: "1.1",
          files: [{ id: "F1", name: "a.png", url_private: "https://files.slack.com/a", preview: "nope" }],
        },
      },
      5,
    );
    expect(parsed).toEqual({
      kind: "message",
      job: {
        eventId: "Ev1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1.1",
        messageTs: "1.1",
        userId: "U1",
        text: "<@UBOT> hi",
        files: [{ id: "F1", name: "a.png", url_private: "https://files.slack.com/a" }],
        mentioned: true,
        receivedAt: 5,
      },
    });
    expect(parseSlackEnvelope({ type: "event_callback", event_id: "E", team_id: "T", event: { type: "message", bot_id: "B", channel: "C", user: "U", text: "x", ts: "1" } }).kind).toBe("ignored");
    expect(parseSlackEnvelope({ type: "event_callback", event_id: "E", team_id: "T", event: { type: "app_uninstalled" } })).toEqual({ kind: "revoked", teamId: "T" });
    expect(parseSlackEnvelope({ type: "event_callback", event_id: "E", team_id: "T", event: { type: "tokens_revoked", tokens: { bot: ["UBOT"] } } })).toEqual({ kind: "revoked", teamId: "T" });
    // Only people's tokens revoked: the bot still works.
    expect(parseSlackEnvelope({ type: "event_callback", event_id: "E", team_id: "T", event: { type: "tokens_revoked", tokens: { oauth: ["U1"] } } }).kind).toBe("ignored");
    expect(parseSlackEnvelope({ type: "event_callback", event_id: "E", team_id: "T", event: { type: "agent_session_stopped", channel: "C", thread_ts: "1.1" } })).toEqual({
      kind: "stop",
      teamId: "T",
      channelId: "C",
      threadTs: "1.1",
      eventId: "E",
    });
  });

  it("normalizes text: strips this app's mention, decodes, notices other mentions", () => {
    const job = { eventId: "E", teamId: "T", channelId: "C", threadTs: "1", messageTs: "2", userId: "U", text: "", mentioned: false, receivedAt: 0 };
    expect(normalizeJob({ ...job, text: "<@UBOT> run a &amp;&amp; b" }, "UBOT")).toMatchObject({ text: "run a && b", mentioned: true, mentionsOthers: false });
    expect(normalizeJob({ ...job, text: "<@U2> can you look" }, "UBOT")).toMatchObject({ mentioned: false, mentionsOthers: true });
    expect(normalizeJob({ ...job, text: "<@UBOT>" }, "UBOT")).toBeNull();
    expect(decodeSlack("<https://x.dev|x.dev> <#C1|general>")).toBe("x.dev #general");
  });

  it("round-trips the install state and refuses forgeries", () => {
    const state = encodeInstallState("org_01H", "n".repeat(43));
    expect(decodeInstallState(state)).toEqual({ accountId: "org_01H", nonce: "n".repeat(43) });
    expect(decodeInstallState("garbage")).toBeNull();
    expect(decodeInstallState(`${state}.extra`)).toBeNull();
    expect(decodeInstallState("b3JnXzAxSA.short")).toBeNull();
  });

  it("parses interactions, prompt buttons, session keys and thread links", () => {
    const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", team: { id: "T1" } }) }).toString();
    expect(parseInteraction(body)).toMatchObject({ type: "block_actions", team: { id: "T1" } });
    expect(parseInteraction("x=1")).toBeNull();
    const key = "T1:C1:1.1";
    const id = `p:${btoa(key).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}:prompt1:yes`;
    expect(decodeCalvinActionId(id)).toEqual({ sessionKey: key, promptId: "prompt1", value: "yes" });
    expect(parseSessionKey(key)).toEqual({ teamId: "T1", channelId: "C1", threadTs: "1.1" });
    expect(slackThreadUrl("T1", "C1", "1.1")).toBe("https://app.slack.com/client/T1/C1/thread/C1-1.1");
    expect(slackThreadUrl(null, "C1", "1.1")).toBeNull();
  });

  it("words join requests without naming an organization", () => {
    const settingsUrl = "https://app.example/settings";
    const both = joinRequestMessages({ requesterUserId: "U2", installerUserId: "U1", settingsUrl });
    expect(both.requester).toContain("set up by <@U1>");
    expect(both.installer).toContain("<@U2> just tried");
    expect(both.installer).toContain(settingsUrl);
    expect(joinRequestMessages({ requesterUserId: "U2", installerUserId: null, settingsUrl })).toEqual({
      requester: "This Slack workspace already works with OpenComputer. Ask a teammate who uses it to invite you.",
      installer: null,
    });
    // The installer trying again from another organization: nobody to invite.
    const self = joinRequestMessages({ requesterUserId: "U1", installerUserId: "U1", settingsUrl });
    expect(self.installer).toBeNull();
    expect(self.requester).toContain("another organization you set it up for");
  });
});

describe("GitHub for the computer", () => {
  const installations = [
    { id: "gh_acme", accountLogin: "Acme" },
    { id: "gh_bob", accountLogin: "bob" },
  ];
  const repositories = [
    { installationId: "gh_acme", fullName: "Acme/api", defaultBranch: "main", archived: false },
    { installationId: "gh_acme", fullName: "Acme/web", defaultBranch: "trunk", archived: false },
    { installationId: "gh_bob", fullName: "bob/web", defaultBranch: "main", archived: false },
    { installationId: "gh_bob", fullName: "bob/old", defaultBranch: "main", archived: true },
  ];

  it("mints from the installation that owns the repositories, narrowed to them", () => {
    expect(selectTokenTarget(["acme/api", "Acme/web.git"], installations, repositories)).toEqual({
      ok: true,
      installationId: "gh_acme",
      repositories: ["api", "web"],
    });
    expect(selectTokenTarget(["api"], installations, repositories)).toEqual({ ok: true, installationId: "gh_acme", repositories: ["api"] });
    expect(selectTokenTarget(["web"], installations, repositories)).toMatchObject({ ok: false, error: expect.stringMatching(/ambiguous/) });
    expect(selectTokenTarget(["acme/api", "bob/web"], installations, repositories)).toMatchObject({ ok: false, error: expect.stringMatching(/different GitHub accounts/) });
    expect(selectTokenTarget(["stranger/x"], installations, repositories)).toMatchObject({ ok: false, error: expect.stringMatching(/not in a GitHub account connected/) });
    expect(selectTokenTarget(undefined, installations, repositories)).toEqual({ ok: true, installationId: "gh_acme" });
    expect(selectTokenTarget(["a/b"], [], [])).toMatchObject({ ok: false, error: expect.stringMatching(/not connected/) });
  });

  it("builds the welcome definition in Calvin's shape", () => {
    const definition = workspaceDefinition("organization", repositories);
    expect(definition).toEqual({
      name: "organization",
      about: expect.any(String),
      repos: [
        { name: "api", remote: "https://github.com/Acme/api", branch: "main" },
        { name: "Acme-web", remote: "https://github.com/Acme/web", branch: "trunk" },
        { name: "bob-web", remote: "https://github.com/bob/web", branch: "main" },
      ],
      rootFiles: { "AGENTS.md": "computer/AGENTS.md" },
    });
    const many = Array.from({ length: DEFINITION_REPO_LIMIT + 5 }, (_, i) => ({ installationId: "x", fullName: `o/r${i}`, defaultBranch: "", archived: false }));
    expect(workspaceDefinition("organization", many).repos).toHaveLength(DEFINITION_REPO_LIMIT);
  });

  it("clones the most recently pushed eagerly, the rest lazily, and carries index metadata", () => {
    const pushed = (fullName: string, day: number, extra = {}) => ({
      installationId: "x",
      fullName,
      defaultBranch: "main",
      archived: false,
      pushedAt: `2026-10-${String(day).padStart(2, "0")}T12:34:56Z`,
      ...extra,
    });
    const repos = workspaceDefinition("organization", [
      pushed("o/a", 1),
      pushed("o/b", 9, { description: "The API", language: "Go" }),
      pushed("o/c", 5),
      pushed("o/d", 7),
      pushed("o/e", 3),
    ]).repos;
    expect(repos.map((r) => [r.name, r.clone ?? "eager"])).toEqual([["a", "lazy"], ["b", "eager"], ["c", "eager"], ["d", "eager"], ["e", "lazy"]]);
    expect(repos[1]).toMatchObject({ description: "The API", language: "Go", pushedAt: "2026-10-09" });
    expect(EAGER_REPO_COUNT).toBe(3);
    // Pushes within a day do not reorder the eager set (each change would re-send the definition).
    const sameDay = (hour: string) => workspaceDefinition("organization", [pushed("o/a", 12), pushed("o/b", 12), pushed("o/c", 12), { ...pushed("o/d", 12), pushedAt: `2026-10-12T${hour}:00:00Z` }]);
    expect(sameDay("23")).toEqual(sameDay("01"));
    expect(sameDay("23").repos.find((r) => r.name === "d")?.clone).toBe("lazy");
    // Over the limit, the most recently pushed are kept.
    const many = Array.from({ length: DEFINITION_REPO_LIMIT + 1 }, (_, i) => pushed(`o/r${i}`, i === 0 ? 1 : 2));
    expect(workspaceDefinition("organization", many).repos.map((r) => r.name)).not.toContain("r0");
  });
});

describe("idle park setting", () => {
  it("accepts whole minutes from 5 to 1440 and falls back otherwise", () => {
    expect(idleParkMs("45")).toBe(45 * 60_000);
    expect(idleParkMs(undefined)).toBe(IDLE_PARK_MS);
    expect(idleParkMs("2")).toBe(IDLE_PARK_MS);
    expect(idleParkMs("abc")).toBe(IDLE_PARK_MS);
  });
});

describe("Slack workspace → organization cache", () => {
  it("asks the link object once per minute per workspace in an isolate, and never remembers an unlinked one", async () => {
    let now = 1_000;
    const cache = new TeamAccountCache(TEAM_ACCOUNT_TTL_MS, () => now);
    const asked: string[] = [];
    const links: Record<string, string | null> = { T1: "org_a", T2: null };
    const lookup = (teamId: string) => () => {
      asked.push(teamId);
      return Promise.resolve(links[teamId] ?? null);
    };

    expect(await cache.get("T1", lookup("T1"))).toEqual({ accountId: "org_a", cached: null });
    now += TEAM_ACCOUNT_TTL_MS - 1;
    expect(await cache.get("T1", lookup("T1"))).toEqual({ accountId: "org_a", cached: "memory" });
    expect(asked).toEqual(["T1"]);
    // Past the minute: asked again, and a relink is seen.
    links.T1 = "org_b";
    now += 1;
    expect((await cache.get("T1", lookup("T1"))).accountId).toBe("org_b");
    expect(asked).toEqual(["T1", "T1"]);

    // Unlinked: asked every time, so an install links at once.
    expect((await cache.get("T2", lookup("T2"))).accountId).toBeNull();
    links.T2 = "org_c";
    expect((await cache.get("T2", lookup("T2"))).accountId).toBe("org_c");
    expect(asked).toEqual(["T1", "T1", "T2", "T2"]);

    // Forgotten (a release here): the next event asks.
    await cache.forget("T2");
    links.T2 = null;
    expect((await cache.get("T2", lookup("T2"))).accountId).toBeNull();
    // Remembered (an install here): no lookup.
    await cache.remember("T3", "org_d");
    expect(await cache.get("T3", lookup("T3"))).toEqual({ accountId: "org_d", cached: "memory" });
    expect(asked).toEqual(["T1", "T1", "T2", "T2", "T2"]);
  });

  it("shares links between isolates through the colo layer, and survives its failures", async () => {
    const colo = new Map<string, string>();
    const shared = {
      get: async (teamId: string) => colo.get(teamId) ?? null,
      put: async (teamId: string, accountId: string) => void colo.set(teamId, accountId),
      delete: async (teamId: string) => void colo.delete(teamId),
    };
    const asked: string[] = [];
    const lookup = (teamId: string) => async () => (asked.push(teamId), "org_a");
    const first = new TeamAccountCache(TEAM_ACCOUNT_TTL_MS, Date.now, () => shared);
    const second = new TeamAccountCache(TEAM_ACCOUNT_TTL_MS, Date.now, () => shared);

    expect(await first.get("T1", lookup("T1"))).toEqual({ accountId: "org_a", cached: null });
    // Another isolate in the colo: no link-object call, then its own memory.
    expect(await second.get("T1", lookup("T1"))).toEqual({ accountId: "org_a", cached: "colo" });
    expect(await second.get("T1", lookup("T1"))).toEqual({ accountId: "org_a", cached: "memory" });
    expect(asked).toEqual(["T1"]);
    // A release forgets it in the colo too.
    await first.forget("T1");
    expect(colo.has("T1")).toBe(false);

    // A failing colo layer is a miss, never an error.
    const broken = new TeamAccountCache(TEAM_ACCOUNT_TTL_MS, Date.now, () => ({
      get: () => Promise.reject(new Error("cache down")),
      put: () => Promise.reject(new Error("cache down")),
      delete: () => Promise.reject(new Error("cache down")),
    }));
    expect(await broken.get("T9", lookup("T9"))).toEqual({ accountId: "org_a", cached: null });
    await broken.forget("T9");
  });
});

describe("sealing keys (work 068 §3d)", () => {
  it("derives each (master key, purpose) key once, and a new one for another purpose or master key", async () => {
    const master = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const other = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    try {
      const sealed = await seal("xoxb-memo", master, "slack-bot-token", "org\0T1");
      for (let i = 0; i < 5; i += 1) expect(await unseal(sealed, master, "slack-bot-token", "org\0T1")).toBe("xoxb-memo");
      expect(derive).toHaveBeenCalledTimes(1);
      await seal("sk-memo", master, "managed-model-key", "org\0openrouter");
      expect(derive).toHaveBeenCalledTimes(2);
      // Another master key (a rotation) neither reuses the memo nor opens the old ciphertext.
      await expect(unseal(sealed, other, "slack-bot-token", "org\0T1")).rejects.toThrow();
      expect(derive).toHaveBeenCalledTimes(3);
      // The context still binds the value: the memo is the key, not the plaintext.
      await expect(unseal(sealed, master, "slack-bot-token", "org\0T2")).rejects.toThrow();
      expect(derive).toHaveBeenCalledTimes(3);
    } finally {
      derive.mockRestore();
    }
  });

  it("does not remember a missing or malformed master key", async () => {
    await expect(seal("x", undefined, "session-secret", "c")).rejects.toThrow(/not configured/);
    await expect(seal("x", bytesToBase64Url(new Uint8Array(16)), "session-secret", "c")).rejects.toThrow(/32 bytes/);
    await expect(seal("x", bytesToBase64Url(new Uint8Array(16)), "session-secret", "c")).rejects.toThrow(/32 bytes/);
  });
});

describe("thread links (work 049 L3)", () => {
  const archives = "https://acme.slack.com/archives/C0PUB/p1700000001000100";
  const client = "https://app.slack.com/client/T0ACME/C0PUB/thread/C0PUB-1700000001.000200";

  it("finds both link forms in order, de-duplicated, three at most", () => {
    const reply = "https://Acme.slack.com/archives/c0pub/p1700000001000300?thread_ts=1700000001.000100&cid=C0PUB";
    const found = findThreadLinks(`see ${client} and ${archives}, ${archives} again, ${reply} and https://acme.slack.com/archives/C0PUB/p1700000001000400`);
    expect(found).toEqual([
      { url: client, teamId: "T0ACME", channel: "C0PUB", ts: "1700000001.000200" },
      { url: archives, host: "acme.slack.com", channel: "C0PUB", ts: "1700000001.000100" },
      { url: reply, host: "acme.slack.com", channel: "C0PUB", ts: "1700000001.000300", threadTs: "1700000001.000100" },
    ]);
    // A client link whose thread is in another channel than its path is not a thread link.
    expect(findThreadLinks("https://app.slack.com/client/T0ACME/C0PUB/thread/C0OTHER-1700000001.000200")).toEqual([]);
  });

  it("takes a tool's link, or a channel and ts", () => {
    expect(threadRefFor({ url: archives })).toMatchObject({ channel: "C0PUB", ts: "1700000001.000100" });
    expect(threadRefFor({ channel: "c0pub", ts: "1700000001.000100" })).toEqual({ url: "", channel: "C0PUB", ts: "1700000001.000100" });
    expect(threadRefFor({ url: "https://example.com" })).toBeNull();
    expect(threadRefFor({ channel: "C0PUB" })).toBeNull();
    expect(threadRefFor(undefined)).toBeNull();
  });

  it("neutralizes channel-wide mentions and keeps people's", () => {
    expect(neutralizeBroadcasts("<!channel> <!here|here> <!everyone> <!subteam^S123|@eng> <!subteam^S9> <@U1> <!date^1|x>")).toBe(
      "@channel here @everyone @eng @subteam <@U1> <!date^1|x>",
    );
  });

  it("leaves no broadcast behind when one pass would assemble another", () => {
    for (const nested of ["<<!x|!channel>>", "<!channel|<!here>>", "<!everyone|<!everyone>>", "<!here|<!here|<!here>>>", "<!channel|<!channel|"]) {
      expect(neutralizeBroadcasts(nested)).not.toMatch(/<!(?!date\^)/);
    }
    expect(neutralizeBroadcasts("<<!x|!channel>>")).toBe("@channel");
    expect(neutralizeBroadcasts("a <!channel|<!here> b")).toBe("a &lt;!channel|@here b");
  });

  it("drops a forged 'Posted for' line from a post", () => {
    expect(stripAttribution("Done.\n_Posted for <@UBOB> from <https://x|this thread>._\nMore.")).toBe("Done.\nMore.");
    expect(stripAttribution("  posted for <@UBOB> as well\nok")).toBe("ok");
    expect(stripAttribution("Posted for you earlier.")).toBe("Posted for you earlier.");
  });

  it("stops paging past the deadline, and treats a channel whose membership is unknown as not joined", async () => {
    let pages = 0;
    const slack = vi.fn(async (method: string, body: Record<string, unknown>) => {
      if (method === "auth.test") return { ok: true, url: "https://acme.slack.com/", team_id: "T0ACME" };
      if (method === "conversations.info") return { ok: true, channel: { name: "general", is_channel: true, ...(body.channel === "C0PUB" ? { is_member: true } : {}) } };
      if (method === "users.info") return { ok: true, user: { name: "ada" } };
      if (method === "conversations.replies") {
        pages++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true, messages: [{ ts: "1700000001.000100", user: "U1", text: "root" }, { ts: `1700000001.0002${pages}`, user: "U1", text: "r" }], response_metadata: { next_cursor: "more" } };
      }
      return { ok: false, error: "unexpected" };
    });
    const access = new ThreadAccess(slack as never);
    const ref = { url: "u", host: "acme.slack.com", channel: "C0PUB", ts: "1700000001.000100" };
    const slow = await access.read(ref, { owner: "U1", destination: "C0PUB", deadline: Date.now() + 50 });
    expect(slow).toMatchObject({ ok: false, reason: "reading it took too long; ask again to retry" });
    expect(pages).toBeLessThan(5);
    const unknown = await access.read({ ...ref, channel: "C0MAYBE" }, { owner: "U1", destination: "C0PUB" });
    expect(unknown).toMatchObject({ ok: false, reason: "the app is not in that channel; someone can invite it there" });
  });

  it("keeps the root, the linked reply and the latest 40 replies, and says what it left out", async () => {
    const replies = Array.from({ length: 100 }, (_, i) => ({ ts: `1700000001.${String(200 + i).padStart(6, "0")}`, user: "U1", text: `reply ${i}` }));
    const slack = vi.fn(async (method: string, body: Record<string, unknown>) => {
      if (method === "auth.test") return { ok: true, url: "https://acme.slack.com/", team_id: "T0ACME" };
      if (method === "conversations.info") return { ok: true, channel: { name: "general", is_channel: true, is_member: true } };
      if (method === "users.info") return { ok: true, user: { name: "ada" } };
      if (method === "conversations.replies") {
        expect(body).toMatchObject({ channel: "C0PUB", ts: "1700000001.000100" });
        return { ok: true, messages: [{ ts: "1700000001.000100", user: "U1", text: "x".repeat(5000), reply_count: 100 }, ...replies] };
      }
      return { ok: false, error: "unexpected" };
    });
    const access = new ThreadAccess(slack as never);
    const linked = await access.read(
      { url: "u", host: "acme.slack.com", channel: "C0PUB", ts: "1700000001.000205", threadTs: "1700000001.000100" },
      { owner: "U1", destination: "C0PUB" },
    );
    if (!linked.ok) throw new Error(linked.reason);
    expect(linked.messages[0]!.text).toBe(`${"x".repeat(4000)} …[cut]`);
    expect(linked.messages[1]).toMatchObject({ text: "reply 5", linked: true, skipped: 5 });
    expect(linked.messages[2]).toMatchObject({ text: "reply 60", skipped: 54 });
    expect(linked.messages).toHaveLength(42);
    expect(linked.omitted).toBe(59);
    // The destination is the source: one channel lookup, and people are cached.
    expect(slack.mock.calls.filter(([method]) => method === "conversations.info")).toHaveLength(1);
    // Asked again, the channel is looked at again: its state is never cached.
    await access.read({ url: "u", host: "acme.slack.com", channel: "C0PUB", ts: "1700000001.000100" }, { owner: "U1", destination: "C0PUB" });
    expect(slack.mock.calls.filter(([method]) => method === "conversations.info")).toHaveLength(2);
    expect(slack.mock.calls.filter(([method]) => method === "users.info")).toHaveLength(1);
  });
  it("with `before`, keeps only the messages above it, and does not call the rest unread", async () => {
    const slack = vi.fn(async (method: string) => {
      if (method === "auth.test") return { ok: true, url: "https://acme.slack.com/", team_id: "T0ACME" };
      if (method === "conversations.info") return { ok: true, channel: { name: "general", is_channel: true, is_member: true } };
      if (method === "users.info") return { ok: true, user: { name: "ada" } };
      if (method === "conversations.replies")
        return {
          ok: true,
          messages: ["100", "200", "300", "400"].map((n, i) => ({ ts: `1700000001.000${n}`, user: "U1", text: `m${i}`, ...(i ? {} : { reply_count: 3 }) })),
          response_metadata: { next_cursor: "more" },
        };
      return { ok: false, error: "unexpected" };
    });
    const access = new ThreadAccess(slack as never);
    const ref = { url: "", channel: "C0PUB", ts: "1700000001.000300", threadTs: "1700000001.000100" };
    const linked = await access.read(ref, { owner: "U1", destination: "C0PUB" }, ref.ts);
    if (!linked.ok) throw new Error(linked.reason);
    expect(linked.messages.map((m) => m.text)).toEqual(["m0", "m1"]);
    expect(linked.unread).toBeUndefined();
    expect(linked.omitted).toBeUndefined();
  });
});
