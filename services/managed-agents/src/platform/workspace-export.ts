/**
 * Workspace export contract: the session workspace S3 Files mounts at
 * `/workspace` is a prefix of an S3 bucket, so the provider reads and
 * retains files from the bucket directly. Nothing here touches the model,
 * events or logs; the caller only ever sees paths, sizes and digests.
 */

export const WORKSPACE_EXPORT_MAX_BYTES = 1024 * 1024 * 1024;

/** Directories the runtime seeds into the workspace, never user evidence. */
const NON_EXPORTABLE_SEGMENTS = new Set([
  ".opencode",
  ".opencomputer",
  ".git",
  "node_modules",
]);

const SEGMENT = /^[^\u0000-\u001f\u007f]{1,255}$/;

export function accountDirectory(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function workspacePrefix(accountId: string, sessionId: string): string {
  return `accounts/${accountDirectory(accountId)}/sessions/${sessionId}/`;
}

export function workspaceArtifactPrefix(
  accountId: string,
  sessionId: string,
): string {
  return `accounts/${accountDirectory(accountId)}/workspace-artifacts/${sessionId}/`;
}

/** A published, content-addressed artifact key belonging to this session. */
export function scopedWorkspaceArtifactKey(
  accountId: string,
  sessionId: string,
  input: unknown,
): string | null {
  if (typeof input !== "string") return null;
  const prefix = workspaceArtifactPrefix(accountId, sessionId);
  return input.startsWith(prefix) &&
    /^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(input.slice(prefix.length))
    ? input
    : null;
}

/** A safe basename for Content-Disposition on a signed object request. */
export function workspaceDownloadFilename(input: unknown): string | null {
  return typeof input === "string" &&
    input.length > 0 &&
    input.length <= 255 &&
    !/[\u0000-\u001f\u007f/\\]/.test(input)
    ? input
    : null;
}

/**
 * A workspace-relative path the provider will export: relative, normalised,
 * no traversal, no control characters and outside the seeded runtime
 * directories. Returns the canonical path or `null`.
 */
export function exportableWorkspacePath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let path = input;
  if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  else if (path.startsWith("./")) path = path.slice(2);
  if (!path || path.startsWith("/") || path.endsWith("/")) return null;
  if (path.length > 1024 || path.includes("\\")) return null;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (!SEGMENT.test(segment)) return null;
    if (NON_EXPORTABLE_SEGMENTS.has(segment)) return null;
  }
  return segments.join("/");
}

/**
 * S3 Files records the POSIX mode as `x-amz-meta-file-permissions`
 * (octal, with the file type bits). Only regular files export; a symlink
 * (`012xxxx`) or anything else is refused. Objects written outside the file
 * system carry no mode and are treated as regular files, as S3 Files does.
 */
export function regularFileMode(permissions: string | undefined): boolean {
  return fileTypeOfMode(permissions) === "regular";
}

/** The POSIX file type S3 Files recorded for an object, for the refusal code. */
export function fileTypeOfMode(
  permissions: string | undefined,
): "regular" | "symlink" | "other" {
  if (permissions === undefined || permissions === "") return "regular";
  if (!/^[0-7]{1,7}$/.test(permissions)) return "other";
  const type = Number.parseInt(permissions, 8) & 0o170000;
  if (type === 0 || type === 0o100000) return "regular";
  return type === 0o120000 ? "symlink" : "other";
}

/**
 * Error codes an export can end in. Each says whether a retry under the same
 * `Idempotency-Key` can succeed (`retrySafe`): a file that is not there or
 * not allowed will not become so, a race or an unavailable service might.
 */
export const WORKSPACE_EXPORT_ERRORS = {
  artifact_path_invalid: { status: 400, retrySafe: false },
  artifact_not_found: { status: 404, retrySafe: false },
  artifact_symlink_rejected: { status: 422, retrySafe: false },
  artifact_not_regular_file: { status: 422, retrySafe: false },
  artifact_too_large: { status: 413, retrySafe: false },
  artifact_changed_during_snapshot: { status: 409, retrySafe: true },
  artifact_size_mismatch: { status: 412, retrySafe: false },
  artifact_digest_mismatch: { status: 412, retrySafe: false },
  artifact_media_type_mismatch: { status: 412, retrySafe: false },
  export_idempotency_conflict: { status: 409, retrySafe: false },
  export_in_progress: { status: 202, retrySafe: true },
  export_expired: { status: 410, retrySafe: false },
  workspace_unavailable: { status: 503, retrySafe: true },
  workspace_export_failed: { status: 502, retrySafe: true },
} as const;

export type WorkspaceExportErrorCode = keyof typeof WORKSPACE_EXPORT_ERRORS;

export function isWorkspaceExportErrorCode(
  value: unknown,
): value is WorkspaceExportErrorCode {
  return typeof value === "string" && value in WORKSPACE_EXPORT_ERRORS;
}

/**
 * What the caller already knows about the file. Any field that disagrees
 * with the retained snapshot stops the export: nothing is recorded and the
 * mismatch is the answer.
 */
export interface WorkspaceExportExpectation {
  bytes?: number;
  sha256?: string;
  mediaType?: string;
}

/** Parses `expected` from a request body; `undefined` means malformed. */
export function workspaceExportExpectation(
  input: unknown,
): WorkspaceExportExpectation | null | undefined {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const expected: WorkspaceExportExpectation = {};
  if (value.bytes !== undefined) {
    if (
      typeof value.bytes !== "number" ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0
    ) {
      return undefined;
    }
    expected.bytes = value.bytes;
  }
  if (value.sha256 !== undefined) {
    if (typeof value.sha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value.sha256)) {
      return undefined;
    }
    expected.sha256 = value.sha256.toLowerCase();
  }
  if (value.mediaType !== undefined) {
    if (
      typeof value.mediaType !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.mediaType)
    ) {
      return undefined;
    }
    expected.mediaType = value.mediaType.toLowerCase();
  }
  return Object.keys(expected).length ? expected : null;
}

/**
 * SHA-256 of the canonical export request. Stored with the export so a
 * replayed `Idempotency-Key` can be told from a reused one.
 */
export async function workspaceExportFingerprint(request: {
  path: string;
  expected: WorkspaceExportExpectation | null;
}): Promise<string> {
  const canonical = JSON.stringify({
    path: request.path,
    expected: request.expected
      ? Object.fromEntries(
          Object.entries(request.expected).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : null,
  });
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
}

/** The mismatch, if any, between what the caller expected and what was retained. */
export function expectationMismatch(
  expected: WorkspaceExportExpectation | null,
  observed: { size: number; sha256: string; mediaType: string },
): WorkspaceExportErrorCode | null {
  if (!expected) return null;
  if (expected.bytes !== undefined && expected.bytes !== observed.size) {
    return "artifact_size_mismatch";
  }
  if (expected.sha256 !== undefined && expected.sha256 !== observed.sha256) {
    return "artifact_digest_mismatch";
  }
  if (
    expected.mediaType !== undefined &&
    expected.mediaType !== observed.mediaType.split(";")[0]?.trim().toLowerCase()
  ) {
    return "artifact_media_type_mismatch";
  }
  return null;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

export interface WorkspaceExportResult {
  path: string;
  size: number;
  sha256: string;
  /** Content type S3 recorded for the source: metadata, not a safety claim. */
  mediaType: string;
  /** Identity of the snapshot that was hashed and retained: the source version when the bucket is versioned, else its ETag. */
  snapshotId: string;
  sourceEtag: string | null;
  sourceVersionId: string | null;
  artifact: { bucket: string; key: string; etag: string | null };
}

/** A refusal from the platform export: the code decides status and retry safety. */
export interface WorkspaceExportFailure {
  code: WorkspaceExportErrorCode;
  message: string;
}

export function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
