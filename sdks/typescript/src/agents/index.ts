// @opencomputer/sdk/agents: the management API client and its types.
//
// This module graph is portable: fetch, URL, Headers and Web Crypto only, no
// Node built-ins, nothing run at import. It loads the same in a Cloudflare
// Worker without Node compatibility, on Vercel, on Deno and on Node. The
// sandbox client at the package root is Node-only and lives apart on purpose.

export {
  OpenComputer,
  Sessions,
  Turns,
  Events,
  WorkspaceArtifacts,
  Projects,
  Memory,
  MemoryDocuments,
  Webhooks,
  EventSubscriptions,
  GitHub,
  Agents,
  Deployments,
  startSessionOnDocument,
  type OpenComputerOptions,
  type CallOptions,
  type CreateSessionOptions,
  type EnvironmentOptions,
  type DocumentWriteOptions,
  type ListDocumentsOptions,
  type StartSessionOnDocumentParams,
  type StartSessionOnDocumentResult,
} from "./client.js";
export { sessionIdempotencyKey, type StartOnDocumentParams, type StartOnDocumentResult } from "./start-on-document.js";
export { OpenComputerError, type ApiErrorEnvelope, type OpenComputerErrorDetails } from "./errors.js";
export { DEFAULT_BASE_URL, type HttpOptions } from "./http.js";
export {
  WorkspaceArtifactIntegrityError,
  WORKSPACE_ARTIFACT_EXPORT_TERMINAL_STATES,
  isWorkspaceArtifactExportTerminal,
  type WorkspaceArtifactExport,
  type WorkspaceArtifactExportState,
  type WorkspaceArtifactExportErrorCode,
  type WorkspaceArtifactExportError,
  type WorkspaceArtifactExportRetention,
  type WorkspaceArtifactExpected,
  type CreateWorkspaceArtifactExportParams,
  type WorkspaceArtifactExportCreated,
  type WaitUntilTerminalOptions,
  type DownloadWorkspaceArtifactOptions,
  type WorkspaceArtifactDownload,
  type WorkspaceArtifactIntegrityFailure,
} from "./artifacts.js";
export type * from "./types.js";
export type {
  MemoryEnvironment,
  MemoryAccess,
  MemoryAgentWrites,
  MemoryBinding,
  MemoryBindings,
  SessionMemoryBinding,
  MemoryWriter,
  MemoryDocumentMeta,
  MemoryDocument,
  MemoryDocumentPage,
  MemoryResource,
  MemoryResourceInventory,
  CreateMemoryDocumentBody,
  ReplaceMemoryDocumentBody,
  PatchMemoryDocumentBody,
  MemorySavedEvent,
  MemoryErrorCode,
} from "./memory.js";
export type {
  OutcomeEventType,
  SessionDestination,
  CreateEventSubscriptionBody,
  EventSubscription,
  OutcomeEvent,
  EventInput,
  TurnOutcomeDelivery,
  EventSubscriptionErrorCode,
} from "./event-subscriptions.js";
