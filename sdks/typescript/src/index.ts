import { configureHttp2, prewarmConnections } from "./http2.js";

// Switch the Node global fetch dispatcher to HTTP/2 on import (browser-safe
// no-op). Multiplexes concurrent requests over one connection — a large burst
// win for create(). Top-level await so the dispatcher is installed BEFORE the
// importer can issue any request (a dynamic `import("@opencomputer/sdk")` — how
// the leaderboard adapter loads us — fully settles this first); otherwise the
// first burst races the async undici import and leaks onto HTTP/1.1. The SDK is
// ESM-only, so top-level await breaks no existing (already-ESM) consumer, and
// configureHttp2 never rejects. See http2.ts.
await configureHttp2();

// Open the connection pool at IMPORT, not at the first create.
//
// prewarmConnections used to fire from Sandbox.create(), which put the pool's
// own setup INSIDE the window a burst measures — 48 connections cost ~153ms to
// establish, and the first creates race them. Starting here means an importer
// that loads the SDK before its timing loop (the leaderboard adapter does) has
// the pool ready by the time it matters. Same connection count, just earlier.
//
// Deliberately NOT awaited: import must not block on the network. It is
// memoized (warmPromise), so Sandbox.create()'s own call remains as the path
// that covers a programmatically-supplied apiUrl, and becomes a no-op here.
void prewarmConnections(
  (process.env?.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev").replace(/\/api\/?$/, ""),
);

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
// Managed Durable Agent Sessions (the OpenComputer client + Session handle).
export * from "./agents/index.js";
export { Filesystem, type EntryInfo } from "./filesystem.js";
export { Exec, ExecTimeoutError, type ProcessResult, type RunOpts, type ExecSession, type ExecSessionInfo, type ExecStartOpts, type ExecAttachOpts } from "./exec.js";
export { Mounts, type AddMountOpts, type MountInfo, type MountBackend } from "./mounts.js";
export { type Shell, type ShellOpts, type ShellRunOpts, ShellBusyError, ShellClosedError } from "./shell.js";
export { Pty, type PtySession, type PtyOpts } from "./pty.js";
export { Templates, type TemplateInfo } from "./template.js";
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
// Node.js-only modules (use crypto, fs, path) — import via "@opencomputer/sdk/node".
export type { ImageManifest, ImageStep } from "./image.js";
export type { SnapshotInfo, CreateSnapshotOpts, WaitForReadyOpts } from "./snapshot.js";
