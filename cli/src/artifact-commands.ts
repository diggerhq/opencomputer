import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  APIError,
  type OpenComputerClient,
  type WorkspaceArtifactExport,
  type WorkspaceArtifactExportState,
} from "./api.js";
import { CLIError } from "./errors.js";

// Workspace artifact exports (docs/agents/artifacts.mdx): the parts of the
// `artifacts` command group that talk to the API and have to be right
// independently of the terminal.

export const ARTIFACT_TERMINAL_STATES: ReadonlySet<WorkspaceArtifactExportState> =
  new Set(["delivered", "failed", "cancelled", "expired"]);

export interface ArtifactExportRequest {
  sessionId: string;
  path: string;
  mediaType?: string;
  expected?: { bytes?: number; sha256?: string };
  wait: boolean;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * The validated inputs of `artifacts export`. The path must be absolute and
 * the expected values well-formed here, so a typo fails before a request.
 */
export function parseArtifactExportOptions(input: {
  sessionId?: string;
  path?: string;
  mediaType?: string;
  expectedSha256?: string;
  expectedBytes?: string;
  wait: boolean;
}): ArtifactExportRequest {
  if (!input.sessionId) throw new Error("--session <id> is required.");
  if (!input.path) throw new Error("--path <workspace-path> is required.");
  if (!input.path.startsWith("/")) {
    throw new Error("--path must be an absolute path inside the session workspace, such as /workspace/artifacts/report.json.");
  }
  const expected: { bytes?: number; sha256?: string } = {};
  if (input.expectedSha256 !== undefined) {
    if (!SHA256_HEX.test(input.expectedSha256)) {
      throw new Error("--expected-sha256 must be 64 hexadecimal characters.");
    }
    expected.sha256 = input.expectedSha256.toLowerCase();
  }
  if (input.expectedBytes !== undefined) {
    const bytes = Number(input.expectedBytes);
    if (!/^\d+$/.test(input.expectedBytes) || !Number.isSafeInteger(bytes)) {
      throw new Error("--expected-bytes must be a non-negative integer.");
    }
    expected.bytes = bytes;
  }
  return {
    sessionId: input.sessionId,
    path: input.path,
    ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
    ...(Object.keys(expected).length ? { expected } : {}),
    wait: input.wait,
  };
}

/**
 * Creates the export. A reused CLI-wide `--idempotency-key` whose earlier
 * export in this project had a different session, path, media type or
 * expected values is a 409; name the cause.
 */
export async function createArtifactExport(
  client: OpenComputerClient,
  request: ArtifactExportRequest,
) {
  try {
    return await client.createWorkspaceArtifactExport({
      sessionId: request.sessionId,
      path: request.path,
      ...(request.mediaType !== undefined ? { mediaType: request.mediaType } : {}),
      ...(request.expected ? { expected: request.expected } : {}),
    });
  } catch (error) {
    if (error instanceof APIError && error.code === "export_idempotency_conflict") {
      throw new CLIError(
        "export_idempotency_conflict",
        "This --idempotency-key already requested a different export in this project (another session, path, media type or expected values).",
        "Pass a new --idempotency-key to request another export, or repeat the earlier command unchanged to get the existing one.",
        { status: 409, sessionId: request.sessionId, path: request.path },
      );
    }
    throw error;
  }
}

/**
 * Polls the manifest until it reaches a terminal state. The record is
 * returned whatever that state is; the caller decides whether a failed,
 * cancelled or expired export is an error for its command.
 */
export async function waitForArtifactExport(
  client: OpenComputerClient,
  exportId: string,
  options: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WorkspaceArtifactExport> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  for (;;) {
    options.signal?.throwIfAborted();
    const record = await client.workspaceArtifactExport(exportId, { signal: options.signal });
    if (ARTIFACT_TERMINAL_STATES.has(record.state)) return record;
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new CLIError(
        "export_wait_timeout",
        `Export ${exportId} is still ${record.state} after ${String(options.timeoutMs)}ms.`,
        `Run \`opencomputer artifacts inspect ${exportId}\` to follow it, or cancel it with \`opencomputer artifacts cancel ${exportId}\`.`,
        { export: record },
      );
    }
    await sleep(pollIntervalMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The error a command raises for an export that ended without delivering:
 * the export's own code when it has one, otherwise its terminal state.
 */
export function artifactExportFailure(record: WorkspaceArtifactExport): CLIError {
  const code = record.error?.code ?? `export_${record.state}`;
  const message = record.error
    ? `Export ${record.id} ${record.state}: ${record.error.message}`
    : `Export ${record.id} ended ${record.state}.`;
  const hint = record.error?.retrySafe
    ? "The failure was transient: request the export again with a new --idempotency-key (the same key returns this failed record)."
    : "Fix the request or the file, then request the export again with a new --idempotency-key.";
  return new CLIError(code, message, hint, { export: record });
}

export interface ArtifactDownloadResult {
  exportId: string;
  artifactId: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

/**
 * Streams the export's bytes into `sink`, hashing them on the way, and
 * checks the count and digest against what the response announced. A
 * mismatch is an error after the sink has been written; the caller owns
 * what happens to those bytes. A sink given as a function is opened only
 * once the content response has arrived, so its errors are always
 * observed by the pipeline.
 */
export async function streamArtifactExport(
  client: OpenComputerClient,
  exportId: string,
  sink: Writable | (() => Writable),
  options: { end?: boolean } = {},
): Promise<ArtifactDownloadResult> {
  const content = await client.workspaceArtifactContent(exportId);
  const hash = createHash("sha256");
  let seen = 0;
  await pipeline(
    Readable.fromWeb(content.body as NodeReadableStream<Uint8Array>),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        seen += chunk.byteLength;
        callback(null, chunk);
      },
    }),
    typeof sink === "function" ? sink() : sink,
    { end: options.end ?? true },
  );
  const actual = hash.digest("hex");
  if (seen !== content.bytes) {
    throw new CLIError(
      "artifact_size_mismatch",
      `Export ${exportId} announced ${String(content.bytes)} bytes but ${String(seen)} arrived.`,
      "Download the export again; if the sizes still differ, inspect the export and report it.",
      { exportId, expected: content.bytes, actual: seen },
    );
  }
  if (actual !== content.sha256) {
    throw new CLIError(
      "artifact_digest_mismatch",
      `Export ${exportId} announced SHA-256 ${content.sha256} but the downloaded bytes hash to ${actual}.`,
      "Download the export again; if the digests still differ, inspect the export and report it.",
      { exportId, expected: content.sha256, actual },
    );
  }
  return {
    exportId: content.exportId,
    artifactId: content.artifactId,
    mediaType: content.mediaType,
    bytes: seen,
    sha256: actual,
  };
}

/**
 * Downloads the export to `outputPath`. The bytes land in a sibling
 * `.part` file that is unique to this download and created exclusively,
 * and take the final name only after the digest and byte count check out,
 * so a verified file is the only file ever at the path and a failure only
 * removes what this download wrote.
 */
export async function downloadArtifactExportToFile(
  client: OpenComputerClient,
  exportId: string,
  outputPath: string,
): Promise<ArtifactDownloadResult> {
  const partial = `${outputPath}.${randomUUID()}.part`;
  try {
    const result = await streamArtifactExport(client, exportId, () =>
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    );
    await rename(partial, outputPath);
    return result;
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function formatArtifactExport(record: WorkspaceArtifactExport): string {
  const lines = [
    `Export:       ${record.id}`,
    `State:        ${record.state}`,
    `Session:      ${record.sessionId}`,
    `Path:         ${record.workspacePath}`,
    `Artifact:     ${record.artifactId ?? "—"}`,
    `Media type:   ${record.mediaType ?? "—"}`,
    `Bytes:        ${record.bytes === null ? "—" : String(record.bytes)}`,
    `SHA-256:      ${record.sha256 ?? "—"}`,
    `Created:      ${record.createdAt}`,
    `Completed:    ${record.completedAt ?? "—"}`,
  ];
  if (record.error) {
    lines.push(
      `Error:        ${record.error.code}: ${record.error.message}` +
        (record.error.retrySafe ? " (retry safe)" : ""),
    );
  }
  if (record.retention.manifestRetainedUntil || record.retention.snapshotRetainedUntil) {
    lines.push(
      `Retained:     manifest until ${record.retention.manifestRetainedUntil ?? "—"}, ` +
        `snapshot until ${record.retention.snapshotRetainedUntil ?? "—"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatArtifactExportRow(record: WorkspaceArtifactExport): string {
  return (
    `${record.id}  ${record.state.padEnd(12)}  ${record.workspacePath}` +
    `${record.bytes === null ? "" : `  ${String(record.bytes)} bytes`}` +
    `${record.sha256 ? `  ${record.sha256.slice(0, 12)}…` : ""}\n`
  );
}
