import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import {
  APIError,
  workspaceContentSignal,
  type WorkspaceArtifact,
  type WorkspaceFile,
} from "./api.js";

/** The client surface this module needs; `OpenComputerClient` satisfies it. */
export type WorkspaceClient = {
  workspaceFiles(sessionId: string): Promise<WorkspaceFile[]>;
  workspaceArtifacts(sessionId: string): Promise<WorkspaceArtifact[]>;
  exportWorkspaceFile(
    sessionId: string,
    path: string,
  ): Promise<WorkspaceArtifact>;
  workspaceArtifactContent(
    artifact: Pick<WorkspaceArtifact, "sessionId" | "id">,
    signal?: AbortSignal,
  ): Promise<Response>;
};

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Turns SIGINT/SIGTERM into an abort for the duration of `run` so the
 * in-flight stream rejects and its cleanup runs before the process exits.
 */
async function withInterruptAbort<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let interrupted: (typeof INTERRUPT_SIGNALS)[number] | undefined;
  const onSignal = (signal: (typeof INTERRUPT_SIGNALS)[number]) => {
    interrupted = signal;
    controller.abort(new Error(`Interrupted by ${signal}.`));
  };
  const handlers = INTERRUPT_SIGNALS.map(
    (signal) => [signal, () => onSignal(signal)] as const,
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    return await run(controller.signal);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (interrupted) process.kill(process.pid, interrupted);
  }
}

export type DownloadResult = {
  path: string;
  destination: string;
  artifactId: string;
  size: number;
  sha256: string;
};

export class VerificationError extends Error {}

/**
 * Normalises a user-supplied /workspace path to the relative form the API
 * expects, rejecting anything that could point outside the workspace.
 */
export function normalizeWorkspacePath(input: string): string {
  let value = input.replace(/\\/g, "/");
  if (value.startsWith("/workspace/"))
    value = value.slice("/workspace/".length);
  else if (value === "/workspace") value = "";
  value = value.replace(/^\/+/, "");
  if (!value) throw new Error("A workspace file path is required.");
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Unsafe workspace path: ${input}`);
    }
    if (/[\0-\x1f\x7f]/.test(segment)) {
      throw new Error(`Unsafe workspace path: ${input}`);
    }
  }
  return segments.join("/");
}

/**
 * Where a workspace file lands under `root`, refusing any resolution that
 * escapes it (the server already rejects such paths; this is defence in depth).
 */
export function localPathFor(root: string, workspacePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...workspacePath.split("/"));
  const relative = path.relative(resolvedRoot, target);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error(
      `Refusing to write outside ${resolvedRoot}: ${workspacePath}`,
    );
  }
  return target;
}

export async function listWorkspaceFiles(
  client: WorkspaceClient,
  sessionId: string,
): Promise<WorkspaceFile[]> {
  const files = await client.workspaceFiles(sessionId);
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Exports (retains) the workspace file provider-side, then streams the retained
 * artifact to `destination`, verifying byte count and SHA-256 against the
 * manifest before the file becomes visible at its final path.
 */
export async function downloadWorkspaceFile(
  client: WorkspaceClient,
  sessionId: string,
  workspacePath: string,
  destination: string,
  root?: string,
): Promise<DownloadResult> {
  let artifact: WorkspaceArtifact;
  try {
    artifact = await client.exportWorkspaceFile(sessionId, workspacePath);
  } catch (error) {
    if (!isWorkspaceGone(error)) throw error;
    const retained = await latestRetainedArtifacts(client, sessionId);
    const fallback = retained.get(workspacePath);
    if (!fallback) throw error;
    artifact = fallback;
  }
  return downloadArtifact(client, artifact, destination, root);
}

/**
 * Once a session's workspace is gone (ended session, storage released) the
 * live listing and fresh exports fail, but retained artifacts stay
 * downloadable. Fall back to those in that case only.
 */
function isWorkspaceGone(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.code === "workspace_unavailable" ||
      error.code === "artifact_not_found")
  );
}

async function latestRetainedArtifacts(
  client: WorkspaceClient,
  sessionId: string,
): Promise<Map<string, WorkspaceArtifact>> {
  const latest = new Map<string, WorkspaceArtifact>();
  for (const artifact of await client.workspaceArtifacts(sessionId)) {
    const current = latest.get(artifact.path);
    if (!current || current.exportedAt < artifact.exportedAt) {
      latest.set(artifact.path, artifact);
    }
  }
  return latest;
}

/**
 * After the destination's directories exist, confirms that following any
 * symlinks among them still lands inside `root`.
 */
async function assertResolvedWithin(root: string, destination: string) {
  const resolvedRoot = await realpath(root);
  const resolvedParent = await realpath(path.dirname(destination));
  if (
    resolvedParent !== resolvedRoot &&
    !resolvedParent.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(
      `Refusing to write outside ${resolvedRoot}: ${destination} resolves to ${resolvedParent}`,
    );
  }
}

export async function downloadArtifact(
  client: WorkspaceClient,
  artifact: WorkspaceArtifact,
  destination: string,
  root?: string,
): Promise<DownloadResult> {
  await mkdir(path.dirname(destination), { recursive: true });
  if (root !== undefined) await assertResolvedWithin(root, destination);
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.part`;
  await withInterruptAbort(async (signal) => {
    try {
      await streamVerified(client, artifact, temporary, signal);
      signal.throwIfAborted();
      // Commit point: once renamed, the verified file stays even if an
      // interrupt lands during the rename itself.
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  return {
    path: artifact.path,
    destination,
    artifactId: artifact.id,
    size: artifact.size,
    sha256: artifact.sha256,
  };
}

async function streamVerified(
  client: WorkspaceClient,
  artifact: WorkspaceArtifact,
  temporary: string,
  interrupt: AbortSignal,
): Promise<void> {
  const signal = workspaceContentSignal(interrupt);
  const response = await client.workspaceArtifactContent(artifact, signal);
  if (!response.body) throw new VerificationError("Empty artifact response.");
  const hash = createHash("sha256");
  let received = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > artifact.size) {
        callback(
          new VerificationError(
            `Received more than the manifest size of ${artifact.size} bytes.`,
          ),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    verify,
    createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (received !== artifact.size) {
    throw new VerificationError(
      `Received ${received} bytes but the manifest says ${artifact.size}.`,
    );
  }
  const digest = hash.digest("hex");
  if (digest !== artifact.sha256.toLowerCase()) {
    throw new VerificationError(
      "Downloaded bytes do not match the manifest SHA-256.",
    );
  }
}

/** Downloads every workspace file into `root`, mirroring the workspace layout. */
export async function downloadWorkspace(
  client: WorkspaceClient,
  sessionId: string,
  root: string,
  onFile?: (result: DownloadResult) => void,
): Promise<DownloadResult[]> {
  let paths: string[];
  let retained: Map<string, WorkspaceArtifact> | undefined;
  try {
    paths = (await listWorkspaceFiles(client, sessionId)).map((f) => f.path);
  } catch (error) {
    if (!isWorkspaceGone(error)) throw error;
    retained = await latestRetainedArtifacts(client, sessionId);
    paths = [...retained.keys()].sort((a, b) => a.localeCompare(b));
  }
  await mkdir(root, { recursive: true });
  const results: DownloadResult[] = [];
  for (const filePath of paths) {
    const destination = localPathFor(root, filePath);
    const artifact = retained?.get(filePath);
    const result = artifact
      ? await downloadArtifact(client, artifact, destination, root)
      : await downloadWorkspaceFile(
          client,
          sessionId,
          filePath,
          destination,
          root,
        );
    results.push(result);
    onFile?.(result);
  }
  return results;
}

/** `aws s3 cp` semantics: a directory destination keeps the file's basename. */
export async function resolveSingleDestination(
  destination: string | undefined,
  workspacePath: string,
): Promise<string> {
  const basename = path.posix.basename(workspacePath);
  if (!destination) return path.resolve(basename);
  const endsWithSeparator = /[\\/]$/.test(destination);
  const existingDirectory = await stat(destination)
    .then((info) => info.isDirectory())
    .catch(() => false);
  if (endsWithSeparator || existingDirectory) {
    return localPathFor(destination, basename);
  }
  return path.resolve(destination);
}

export function formatSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}
