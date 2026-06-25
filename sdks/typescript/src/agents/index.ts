export { OpenComputer, type OpenComputerOptions } from "./client.js";
export { connectSession, type ConnectSessionOptions } from "./connect.js";

export { Sessions, Session, ClientSession } from "./sessions.js";
export type {
  CreateSessionParams, StreamOptions, Envelope, ListPage,
  SessionSource, RegisteredRepoSource, InlineRepoSource, SourceAuth, SourceStatus,
  SourceErrorCode, SourceSummary,
} from "./sessions.js";
export { Agents } from "./agents.js";
export type { CreateAgentParams, UpdateAgentParams, Page } from "./agents.js";
export { Repos, GitHub, GitHubApps, GitHubInstallations } from "./repos.js";
export type {
  CreateRepoParams, UpdateRepoParams, Repo, RepoDefaults, GitHubPermission,
  GitHubApp, GitHubAppMode, GitHubAppStatus, GitHubInstallation,
  ListGitHubInstallationsParams,
} from "./repos.js";
export { Credentials } from "./credentials.js";
export type { CreateCredentialParams } from "./credentials.js";
export { Destinations, Deliveries } from "./destinations.js";
export type { CreateDestinationParams, UpdateDestinationParams } from "./destinations.js";
export { verifyWebhook, WebhookVerificationError } from "./webhooks.js";
export type { WebhookDelivery, VerifyWebhookOptions } from "./webhooks.js";

export * from "./types.js";
export * from "./errors.js";
