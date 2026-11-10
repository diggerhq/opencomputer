import { describe, expect, it } from "vitest";
import {
  hostedSlackManifest,
  normalizeSlackAppName,
} from "../src/channels/slack-manifest.js";

describe("hosted Slack manifests", () => {
  it("uses the chosen app name and the per-connection webhook", () => {
    const result = hostedSlackManifest(
      "  Inbox   Helper  ",
      "https://managed.example/v1/webhooks/slack/connection/token",
    );
    expect(result.manifest).toMatchObject({
      display_information: { name: "Inbox Helper" },
      features: { bot_user: { display_name: "Inbox Helper" } },
      settings: {
        event_subscriptions: {
          request_url:
            "https://managed.example/v1/webhooks/slack/connection/token",
        },
      },
      oauth_config: {
        scopes: {
          bot: expect.arrayContaining([
            "channels:read",
            "chat:write",
            "groups:read",
            "im:write",
            "users:read",
          ]),
        },
      },
    });
    expect(result.createUrl).toBe("https://api.slack.com/apps");
  });

  it("points button clicks at the interactivity endpoint", () => {
    const result = hostedSlackManifest(
      "Inbox Helper",
      "https://managed.example/v1/webhooks/slack/connection/token",
    );
    // Slack configures this separately from events. Without it an approval
    // card renders and pressing Approve does nothing at all.
    expect(result.manifest).toMatchObject({
      settings: {
        interactivity: {
          is_enabled: true,
          request_url:
            "https://managed.example/v1/webhooks/slack/connection/token/interactivity",
        },
      },
    });
  });

  it("rejects empty and overlong names", () => {
    expect(normalizeSlackAppName("   ")).toBeNull();
    expect(normalizeSlackAppName("x".repeat(36))).toBeNull();
  });

  it("renders deployment-declared scopes and events", () => {
    const result = hostedSlackManifest(
      "Review Agent",
      "https://managed.example/v1/webhooks/slack/connection/token",
      {
        botScopes: ["chat:write", "channels:read", "app_mentions:read"],
        events: ["app_mention"],
      },
    );
    // Declared scopes are additive: the name-resolution scopes the platform
    // itself needs ride along with whatever the deployment asked for.
    expect(result.manifest).toMatchObject({
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "channels:read",
            "chat:write",
            "groups:read",
            "users:read",
          ],
        },
      },
      settings: {
        event_subscriptions: { bot_events: ["app_mention"] },
      },
    });
    expect(
      (result.manifest.features as Record<string, unknown>).agent_view,
    ).toBeUndefined();
  });
});

describe("hosted Slack manifests and OAuth", () => {
  it("declares the configured callback as the only redirect URL", () => {
    const result = hostedSlackManifest(
      "Inbox Helper",
      "https://managed.example/v1/webhooks/slack/connection/token",
      { redirectUri: "https://api.example/api/managed-agents/slack/callback" },
    );
    expect(result.manifest).toMatchObject({
      oauth_config: {
        redirect_urls: [
          "https://api.example/api/managed-agents/slack/callback",
        ],
      },
    });
  });

  it("omits redirect URLs when no callback is configured", () => {
    const result = hostedSlackManifest(
      "Inbox Helper",
      "https://managed.example/v1/webhooks/slack/connection/token",
    );
    expect(
      (result.manifest.oauth_config as Record<string, unknown>).redirect_urls,
    ).toBeUndefined();
  });

  it("refuses a redirect URL Slack would reject", () => {
    for (const redirectUri of [
      "http://api.example/callback",
      "https://api.example/callback#fragment",
    ]) {
      expect(() =>
        hostedSlackManifest("Inbox Helper", "https://managed.example/hook", {
          redirectUri,
        }),
      ).toThrow(/redirect/i);
    }
  });
});
