import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { WorkspaceArtifact, WorkspaceFile } from "./api.js";

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
  ): Promise<Response>;
};

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
  let value = input.trim().replace(/\\/g, "/");
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
    relative.startsWith("..") ||
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
): Promise<DownloadResult> {
  const artifact = await client.exportWorkspaceFile(sessionId, workspacePath);
  return downloadArtifact(client, artifact, destination);
}

export async function downloadArtifact(
  client: WorkspaceClient,
  artifact: WorkspaceArtifact,
  destination: string,
): Promise<DownloadResult> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.part`;
  try {
    const response = await client.workspaceArtifactContent(artifact);
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
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ),
      verify,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
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
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: artifact.path,
    destination,
    artifactId: artifact.id,
    size: artifact.size,
    sha256: artifact.sha256,
  };
}

/** Downloads every workspace file into `root`, mirroring the workspace layout. */
export async function downloadWorkspace(
  client: WorkspaceClient,
  sessionId: string,
  root: string,
  onFile?: (result: DownloadResult) => void,
): Promise<DownloadResult[]> {
  const files = await listWorkspaceFiles(client, sessionId);
  const results: DownloadResult[] = [];
  for (const file of files) {
    const destination = localPathFor(root, file.path);
    const result = await downloadWorkspaceFile(
      client,
      sessionId,
      file.path,
      destination,
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
