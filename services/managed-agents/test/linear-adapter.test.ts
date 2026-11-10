import { describe, expect, it } from "vitest";

import { bytesToHex, hmac } from "../src/channels/adapter.js";
import {
  linearWebhookFresh,
  parseLinearWebhook,
  verifyLinearDelivery,
  verifyLinearSignature,
} from "../src/channels/linear.js";

// Authored fixtures shaped like work 037's compact Linear contract; no real
// third-party content.
const SECRET = "lin_wh_test_signing_secret";
const NOW = Date.parse("2026-10-02T10:00:00.000Z");

const issue = {
  id: "issue-1",
  identifier: "ACME-1",
  title: "Add a health endpoint",
  description: "The service needs a health endpoint.",
  url: "https://linear.app/acme/issue/ACME-1",
  teamId: "team-1",
  team: { id: "team-1", key: "ACME", name: "Acme" },
};

function created(overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    createdAt: "2026-10-02T09:59:59.000Z",
    organizationId: "org-1",
    oauthClientId: "client-1",
    appUserId: "app-user-1",
    webhookId: "webhook-1",
    webhookTimestamp: NOW,
    agentSession: {
      id: "as-1",
      status: "pending",
      issueId: issue.id,
      issue,
      commentId: "comment-1",
      creatorId: "user-1",
      creator: { id: "user-1", name: "Pat Example" },
      createdAt: "2026-10-02T09:59:58.000Z",
    },
    agentActivity: null,
    promptContext: '<issue identifier="ACME-1"><title>Add a health endpoint</title></issue>',
    previousComments: null,
    guidance: null,
    ...overrides,
  };
}

function prompted(body: string, signal: string | null = null) {
  return {
    ...created(),
    action: "prompted",
    promptContext: undefined,
    agentActivity: {
      id: "activity-1",
      createdAt: "2026-10-02T09:59:59.500Z",
      updatedAt: "2026-10-02T09:59:59.500Z",
      sourceCommentId: "comment-2",
      userId: "user-1",
      user: { id: "user-1", name: "Pat Example", email: "pat@example.test", url: "https://linear.app/acme/profiles/pat" },
      signal,
      signalMetadata: null,
      ephemeral: false,
      queued: false,
      sentAt: "2026-10-02T09:59:59.600Z",
      executionSkippedReason: null,
      pushSummary: null,
      content: { type: "prompt", body },
    },
  };
}

async function sign(payload: string, secret = SECRET): Promise<string> {
  return bytesToHex(await hmac("SHA-256", secret, payload));
}

describe("linear adapter: verification", () => {
  it("accepts the hex HMAC-SHA256 of the raw body and nothing else", async () => {
    const payload = JSON.stringify(created());
    const signature = await sign(payload);
    expect(await verifyLinearSignature(payload, signature, SECRET)).toBe(true);
    expect(await verifyLinearSignature(payload, signature.toUpperCase(), SECRET)).toBe(true);
    expect(await verifyLinearSignature(`${payload} `, signature, SECRET)).toBe(false);
    expect(await verifyLinearSignature(payload, await sign(payload, "other"), SECRET)).toBe(false);
    expect(await verifyLinearSignature(payload, null, SECRET)).toBe(false);
    expect(await verifyLinearSignature(payload, signature, "")).toBe(false);
  });

  it("enforces the 60 s window on the body's webhookTimestamp", () => {
    expect(linearWebhookFresh({ webhookTimestamp: NOW - 60_000 }, NOW)).toBe(true);
    expect(linearWebhookFresh({ webhookTimestamp: NOW + 60_000 }, NOW)).toBe(true);
    expect(linearWebhookFresh({ webhookTimestamp: NOW - 60_001 }, NOW)).toBe(false);
    expect(linearWebhookFresh({ webhookTimestamp: NOW + 61_000 }, NOW)).toBe(false);
    expect(linearWebhookFresh({}, NOW)).toBe(false);
  });

  it("checks the signature before the body and freshness", async () => {
    const stale = JSON.stringify(created({ webhookTimestamp: NOW - 120_000 }));
    expect(
      await verifyLinearDelivery({ payload: stale, signature: "00", secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(
      await verifyLinearDelivery({ payload: stale, signature: await sign(stale), secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "stale" });
    const fresh = JSON.stringify(created());
    const verified = await verifyLinearDelivery({
      payload: fresh,
      signature: await sign(fresh),
      secret: SECRET,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
  });
});

describe("linear adapter: parsing", () => {
  it("types a created event with the session, issue and prompt context", () => {
    const event = parseLinearWebhook(created());
    expect(event).toMatchObject({
      kind: "session",
      action: "created",
      stop: false,
      organizationId: "org-1",
      agentSessionId: "as-1",
      issueId: "issue-1",
      sessionCreatedAt: "2026-10-02T09:59:58.000Z",
      issue: { id: "issue-1", identifier: "ACME-1", team: { id: "team-1", key: "ACME", name: "Acme" } },
      session: { id: "as-1", creator: { id: "user-1", name: "Pat Example" }, commentId: "comment-1" },
      promptContext: expect.stringContaining("ACME-1"),
    });
    // null guidance and previous comments are absent, not null.
    expect(event).not.toHaveProperty("guidance");
    expect(event).not.toHaveProperty("previousComments");
  });

  it("reads a prompt's body from content and its provider time from createdAt", () => {
    const event = parseLinearWebhook(prompted("Use the existing router."));
    expect(event).toMatchObject({
      kind: "session",
      action: "prompted",
      stop: false,
      activity: {
        id: "activity-1",
        createdAt: "2026-10-02T09:59:59.500Z",
        body: "Use the existing router.",
        userId: "user-1",
        sourceCommentId: "comment-2",
      },
    });
  });

  it("recognizes stop by its signal", () => {
    expect(parseLinearWebhook(prompted("stop", "stop"))).toMatchObject({ stop: true });
  });

  it("refuses a prompt without its activity", () => {
    expect(parseLinearWebhook({ ...prompted("x"), agentActivity: null })).toBeNull();
  });

  it("types revocation and permission changes, and ignores everything else", () => {
    expect(
      parseLinearWebhook({
        type: "OAuthApp",
        action: "revoked",
        organizationId: "org-1",
        oauthClientId: "client-1",
        createdAt: "2026-10-02T10:00:00.000Z",
        webhookTimestamp: NOW,
      }),
    ).toMatchObject({ kind: "revoked", organizationId: "org-1", oauthClientId: "client-1" });
    expect(
      parseLinearWebhook({
        type: "PermissionChange",
        action: "teamAccessChanged",
        organizationId: "org-1",
        canAccessAllPublicTeams: false,
        addedTeamIds: ["team-2"],
        removedTeamIds: ["team-1"],
        webhookTimestamp: NOW,
      }),
    ).toMatchObject({
      kind: "teams",
      canAccessAllPublicTeams: false,
      addedTeamIds: ["team-2"],
      removedTeamIds: ["team-1"],
    });
    expect(parseLinearWebhook({ type: "OAuthAuthorization", action: "created" })).toEqual({
      kind: "ignored",
      type: "OAuthAuthorization",
      action: "created",
    });
  });
});
