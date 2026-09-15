// @opencomputer/sdk: the sandbox client. Node-only: the image builder reads
// the filesystem and the transport pools HTTP/2 connections through undici.
// Nothing runs at import; the connection pool is created on the first
// request and warmed on the first `Sandbox.create`.
//
// The management API client for Serverless Agents lives on its own portable
// subpath, `@opencomputer/sdk/managed-agents`, whose module graph has no Node
// dependency. It is not re-exported here so that importing it never drags
// this graph along.

export {
  Sandbox,
  ScalingLockedError,
  PlanLimitError,
  SandboxFamilyLimitError,
  type SandboxOpts,
  type CheckpointInfo,
  type CheckpointRetentionPolicy,
  type CreateCheckpointOptions,
  type PatchInfo,
  type PatchResult,
  type ScaleResult,
  type AutoscaleConfig,
  type AutoscaleStatus,
  type ScalingLockStatus,
  type AllowedHostsInfo,
  type SandboxKillOptions,
} from "./sandbox.js";
export {
  Browser,
  BrowserProfile,
  BrowserProfileAuthCheck,
  type BrowserCreateOpts,
  type BrowserData,
  type BrowserProfileAuthCheckCreateOpts,
  type BrowserProfileAuthCheckData,
  type BrowserProfileAuthCheckWaitOpts,
  type BrowserProfileCreateOpts,
  type BrowserProfileData
} from "./browser.js";
export { SandboxAgent, type SandboxAgentEvent, type SandboxAgentConfig, type SandboxAgentStartOpts, type SandboxAgentSession, type McpServerConfig } from "./agent.js";
export { Filesystem, type EntryInfo } from "./filesystem.js";
export { Exec, ExecTimeoutError, type ProcessResult, type RunOpts, type ExecSession, type ExecSessionInfo, type ExecStartOpts, type ExecAttachOpts } from "./exec.js";
export { Mounts, type AddMountOpts, type MountInfo, type MountBackend } from "./mounts.js";
export { type Shell, type ShellOpts, type ShellRunOpts, ShellBusyError, ShellClosedError } from "./shell.js";
export { Pty, type PtySession, type PtyOpts } from "./pty.js";
export { Templates, type TemplateInfo } from "./template.js";
export { SDK_VERSION, SDK_VERSION_HEADER } from "./version.js";
// Warm the sandbox client's connection pool ahead of a burst. `Sandbox.create`
// does this on first use; a program that measures creates calls it earlier.
export { prewarmConnections } from "./http2.js";
export {
  Webhooks,
  WebhookDeliveries,
  type WebhooksOptions,
  type CreateWebhookParams,
  type CreateWebhookResult,
  type UpdateWebhookParams,
  type WebhookDestination,
  type WebhookDeliveryRecord,
  type WebhookDeliveryStatus,
  type WebhookTestResult,
  type ListPage,
  type SandboxWebhookDelivery,
  type SandboxLifecycleEvent,
  type SandboxLifecycleEventBase,
  type SandboxStopReason,
  type SandboxWebhookEventType,
} from "./webhooks.js";
export {
  verifyWebhook,
  WebhookVerificationError,
  type WebhookDelivery,
  type WebhookEvent,
  type VerifyWebhookOptions,
} from "./verify-webhook.js";
export { SecretStore, type SecretStoreInfo, type SecretEntryInfo, type SecretStoreOpts, type CreateSecretStoreOpts, type UpdateSecretStoreOpts } from "./project.js";
export {
  Usage,
  Tags,
  type UsageSandboxItem,
  type UsageTagItem,
  type UsageTotals,
  type UsageUntaggedBucket,
  type UsageBySandboxResponse,
  type UsageByTagResponse,
  type UsageQueryOpts,
  type UsageFilterMap,
  type SandboxUsageResponse,
  type SandboxUsagePoint,
  type SandboxUsageTotals,
  type TagKeyInfo,
} from "./usage.js";
// Node.js-only modules (use crypto, fs, path) — also exported via "@opencomputer/sdk/node".
// The Image builder and the Snapshots client are exported as VALUES, not only
// as types. Both were type-only, so `import { Image } from "@opencomputer/sdk"`
// — which the Image reference documents — failed at runtime with "does not
// provide an export named 'Image'", and there was no supported way to define a
// template through the SDK at all.
export { Image } from "./image.js";
export type { ImageManifest, ImageStep } from "./image.js";
export { Snapshots } from "./snapshot.js";
export type { SnapshotInfo, CreateSnapshotOpts, WaitForReadyOpts } from "./snapshot.js";
