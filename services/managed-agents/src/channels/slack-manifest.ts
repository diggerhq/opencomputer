export interface HostedSlackManifest {
  manifest: Record<string, unknown>;
  createUrl: string;
  steps: string[];
}

export function normalizeSlackAppName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= 35 ? name : null;
}

/** Slack accepts only https redirect URLs without a fragment. */
export function assertSlackRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Slack redirect URLs must be absolute https URLs");
  }
  if (url.protocol !== "https:" || url.hash || value.includes("#")) {
    throw new Error("Slack redirect URLs must use https and carry no fragment");
  }
}

export function hostedSlackManifest(
  name: string,
  webhookUrl: string,
  options: {
    botScopes?: readonly string[];
    events?: readonly string[];
    /**
     * OpenComputer's OAuth callback. Slack only redirects an installation to a
     * URL the manifest declares, so it is declared here for every app the
     * platform generates, whether the user installs it by hand or through the
     * automated flow: both produce the same app.
     */
    redirectUri?: string;
  } = {},
): HostedSlackManifest {
  const normalizedName = normalizeSlackAppName(name);
  if (!normalizedName) {
    throw new Error("Slack app names must be between 1 and 35 characters");
  }
  if (options.redirectUri !== undefined) {
    assertSlackRedirectUri(options.redirectUri);
  }
  const botScopes = [
    ...new Set([
      ...(options.botScopes ?? [
        "app_mentions:read",
        "assistant:write",
        "chat:write",
        "im:history",
        "im:write",
      ]),
      // The platform names the speaker and conversation in each session's
      // transcript, which takes users.info and conversations.info whatever an
      // agent declares for itself — so every generated app asks for these on
      // top of its declared set.
      "channels:read",
      "groups:read",
      "users:read",
    ]),
  ].sort();
  const botEvents = [
    ...new Set(
      options.events ?? [
        "app_mention",
        "app_context_changed",
        "app_home_opened",
        "message.im",
      ],
    ),
  ].sort();
  return {
    manifest: {
      _metadata: { major_version: 1, minor_version: 1 },
      display_information: {
        name: normalizedName,
        description: `Run the ${normalizedName} OpenComputer agent from Slack.`,
        background_color: "#0B1220",
      },
      features: {
        ...(botScopes.includes("assistant:write")
          ? {
              agent_view: {
                agent_description: `Work with the ${normalizedName} agent.`,
                suggested_prompts: [
                  {
                    title: "Get started",
                    message: "Tell me what you can help with.",
                  },
                ],
              },
            }
          : {}),
        bot_user: { display_name: normalizedName, always_online: true },
      },
      oauth_config: {
        ...(options.redirectUri ? { redirect_urls: [options.redirectUri] } : {}),
        scopes: {
          bot: botScopes,
        },
      },
      settings: {
        event_subscriptions: {
          request_url: webhookUrl,
          bot_events: botEvents,
        },
        // Slack posts button clicks to a second URL, configured separately
        // from events. Without it declared here, an approval card renders and
        // nothing happens when anyone presses it.
        interactivity: {
          is_enabled: true,
          request_url: `${webhookUrl}/interactivity`,
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    createUrl: "https://api.slack.com/apps",
    steps: [
      "Create a Slack app from the generated manifest.",
      "Copy the App ID and Signing Secret from Basic Information.",
      "Install the app and copy its Bot User OAuth Token.",
      "Complete the connection in OpenComputer.",
    ],
  };
}
