// Workspace artifact exports — the shapes of the management API documented at
// docs/agents/artifacts.mdx. `oc.sessions.artifacts` sends and returns them;
// they also type the CLI's `--json` output (`oc artifacts ...`).
//
// An export copies one regular file out of a session's persisted `/workspace`
// into an immutable snapshot that is hashed and served byte-for-byte to the
// API key. The record is the manifest of that copy; it never carries file
// content, a signed URL or a destination credential.

import type { Environment } from "./types.js";

export type WorkspaceArtifactExportState =
  | "queued"
  | "snapshotting"
  | "delivering"
  | "delivered"
  | "failed"
  | "cancelled"
  | "expired";

/** The states an export never leaves. */
export const WORKSPACE_ARTIFACT_EXPORT_TERMINAL_STATES: readonly WorkspaceArtifactExportState[] = [
  "delivered",
  "failed",
  "cancelled",
  "expired",
];

export function isWorkspaceArtifactExportTerminal(state: WorkspaceArtifactExportState): boolean {
  return WORKSPACE_ARTIFACT_EXPORT_TERMINAL_STATES.includes(state);
}

/** Error codes the artifact export routes return, in `error.code` of a record or of a failed response. */
export type WorkspaceArtifactExportErrorCode =
  | "invalid_workspace_path"
  | "path_outside_workspace"
  | "artifact_not_found"
  | "artifact_not_regular_file"
  | "artifact_symlink_rejected"
  | "artifact_too_large"
  | "artifact_changed_during_snapshot"
  | "artifact_digest_mismatch"
  | "artifact_size_mismatch"
  | "destination_not_allowed"
  | "destination_unavailable"
  | "destination_rejected"
  | "export_idempotency_conflict"
  | "export_expired"
  | "export_cancelled"
  | "export_not_ready"
  | "session_not_exportable"
  | "export_not_found";

/** Why an export ended in `failed`, and whether repeating the same idempotency key is safe. */
export interface WorkspaceArtifactExportError {
  code: WorkspaceArtifactExportErrorCode;
  message: string;
  retrySafe: boolean;
}

/** When the manifest and the snapshot copy stop being available; `null` while not yet decided. */
export interface WorkspaceArtifactExportRetention {
  manifestRetainedUntil: string | null;
  snapshotRetainedUntil: string | null;
}

/** The manifest of one export, as every artifact route returns it. */
export interface WorkspaceArtifactExport {
  id: string;
  /** Allocated once the snapshot exists. */
  artifactId: string | null;
  projectId: string;
  environment: Environment;
  agentId: string;
  deploymentId: string | null;
  sessionId: string;
  /** Always `null` for an export requested through the API; never model-supplied. */
  turnId: string | null;
  toolCallId: string | null;
  workspacePath: string;
  snapshotId: string | null;
  mediaType: string | null;
  bytes: number | null;
  /** Lowercase hex SHA-256 of the snapshot; the same value `download` serves in its header. */
  sha256: string | null;
  state: WorkspaceArtifactExportState;
  error: WorkspaceArtifactExportError | null;
  /** `sha256:<hex>` of the Idempotency-Key the export was created under. */
  idempotencyKeyDigest: string;
  retention: WorkspaceArtifactExportRetention;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Sizes and digests the caller already measured; a mismatch fails the export rather than delivering it. */
export interface WorkspaceArtifactExpected {
  bytes?: number;
  /** Lowercase or uppercase hex SHA-256. */
  sha256?: string;
}

/** Parameters of `oc.sessions.artifacts.export`. */
export interface CreateWorkspaceArtifactExportParams {
  sessionId: string;
  /** Absolute path of one regular file under `/workspace/artifacts/`. */
  path: string;
  /** Recorded as metadata and served as the download's `Content-Type`. */
  mediaType?: string;
  expected?: WorkspaceArtifactExpected;
  /**
   * Required, 1 to 255 characters. The same key with the same session, path,
   * media type and expected values returns the existing export; anything
   * else under the key is `409 export_idempotency_conflict`.
   */
  idempotencyKey: string;
}

/** What `export` returns: the record, and whether this call created it. */
export interface WorkspaceArtifactExportCreated {
  export: WorkspaceArtifactExport;
  /** `false` when the key had already created the export (a `200` replay). */
  created: boolean;
}

export interface WaitUntilTerminalOptions {
  signal?: AbortSignal;
  /** Milliseconds between polls. Default 1000. */
  pollIntervalMs?: number;
}

export interface DownloadWorkspaceArtifactOptions {
  signal?: AbortSignal;
  /**
   * Hash the bytes as they stream and fail the stream with a
   * `WorkspaceArtifactIntegrityError` when the digest or byte count differs
   * from the headers. Default `true`.
   */
  verify?: boolean;
}

/** The content of a delivered export: the exact snapshot bytes with the metadata the API sent beside them. */
export interface WorkspaceArtifactDownload {
  /** The snapshot bytes, untransformed. Errors on an integrity failure when `verify` is on. */
  stream: ReadableStream<Uint8Array>;
  /** From `Content-Length`. */
  bytes: number;
  /** From `X-OpenComputer-Artifact-Sha256`, lowercase hex. */
  sha256: string;
  /** From `Content-Type`; `application/octet-stream` when no media type was recorded. */
  mediaType: string;
  /** From `X-OpenComputer-Artifact-Id`. */
  artifactId: string;
  /** From `X-OpenComputer-Export-Id`. */
  exportId: string;
}

export type WorkspaceArtifactIntegrityFailure = "artifact_digest_mismatch" | "artifact_size_mismatch";

/**
 * Thrown (as the download stream's error) when the streamed bytes do not
 * match the digest or byte count the API sent in its headers. The bytes
 * already read must not be treated as the artifact.
 */
export class WorkspaceArtifactIntegrityError extends Error {
  readonly code: WorkspaceArtifactIntegrityFailure;
  readonly exportId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(code: WorkspaceArtifactIntegrityFailure, exportId: string, expected: string, actual: string) {
    const what = code === "artifact_digest_mismatch" ? "SHA-256" : "byte count";
    super(`Export ${exportId}: downloaded ${what} ${actual} does not match the API's ${expected}`);
    this.name = "WorkspaceArtifactIntegrityError";
    this.code = code;
    this.exportId = exportId;
    this.expected = expected;
    this.actual = actual;
  }
}
