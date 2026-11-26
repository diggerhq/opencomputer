// Credentials the gateway gives the host: Slack and model credentials, and short-lived tokens.

export interface CalvinHostCredentials {
  slackBotToken: string;
  slackBotUserId: string;
  teamId?: string;
  claudeOAuthToken?: string;
  /** Protocol 4 only, with `anthropicBaseUrl`: at 5 the key travels in a route's `vars` (`models`). */
  anthropicApiKey?: string;
  /**
   * Where `anthropicApiKey` is spent, when not Anthropic: the organization's
   * managed OpenRouter key comes with `https://openrouter.ai/api` (work 052,
   * model-key.ts). Calvin sets ANTHROPIC_BASE_URL for its runners from it.
   */
  anthropicBaseUrl?: string;
}

export interface CalvinGitHubToken {
  token: string;
  expiresAt: string;
  /** An OpenComputer key's API URL (`kind: "opencomputer"`). */
  apiUrl?: string;
  /** The automations repository's git remote and basic-auth user (`kind: "automation-repo"`). */
  remoteUrl?: string;
  username?: string;
}
