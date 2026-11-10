/**
 * The Modal tool-sandbox provider: sandboxes created through the shim
 * (../modal-sandbox.ts is its client), workspaces on Modal Volumes, and
 * supervisors reached over the sandbox's encrypted tunnel.
 */
import {
  CopyObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { modalRegion } from "../../deployment-region.js";
import { platformEgressDomains } from "../../deployment-egress.js";
import {
  egressExitsFor,
  exitClientConfig,
  exitCredential,
  exitIdentity,
  utcDay,
} from "../../egress-exit.js";

import {
  ModalShimError,
  modalSandboxCreate,
  modalSandboxRetire,
  modalSandboxStatus,
  modalSandboxSuspend,
  modalSandboxTerminate,
  modalSignedDownloadUrl,
  modalSnapshotForSession,
  modalVolumeExport,
  modalVolumeList,
  modalVolumeName,
  modalVolumeStat,
} from "../modal-sandbox.js";
import {
  SANDBOX_MAXIMUM_DURATION_SECONDS,
  type SandboxEnsureInput,
  managedRuntimeModalImage,
  waitForSupervisorReady,
} from "../sandbox-adapter.js";
import {
  WORKSPACE_EXPORT_MAX_BYTES,
  type WorkspaceExportExpectation,
  type WorkspaceExportResult,
  type WorkspaceFile,
  expectationMismatch,
  exportableWorkspacePath,
  hex,
  workspaceArtifactPrefix,
} from "../workspace-export.js";
import {
  type ModalPlatformEnv,
  type SupervisorEndpoint,
  type ToolSandboxProvider,
  type ToolSandboxRetireInput,
  type WorkspaceScope,
  WORKSPACE_DOWNLOAD_URL_TTL_SECONDS,
  awsOptions,
  discardWorkspaceStaging,
  json,
  refuseWorkspaceExport as refuse,
  required,
} from "./shared.js";

/**
 * Whether the workspace has a Modal Volume. Any probe failure reads as
 * "no": shim trouble must never break a workspace read.
 */
export async function modalVolumeExists(
  env: ModalPlatformEnv,
  workspaceId: string,
): Promise<boolean> {
  try {
    await modalVolumeList(env, modalVolumeName(env, workspaceId));
    return true;
  } catch {
    return false;
  }
}

type OutboundPolicy = { domains: string[]; cidrs: string[] };

function policyKey(policy: OutboundPolicy): string {
  return JSON.stringify([[...policy.domains].sort(), [...policy.cidrs].sort()]);
}

function samePolicy(
  applied: OutboundPolicy | null | undefined,
  wanted: OutboundPolicy,
): boolean {
  return (
    !!applied &&
    Array.isArray(applied.domains) &&
    Array.isArray(applied.cidrs) &&
    policyKey(applied) === policyKey(wanted)
  );
}

/**
 * A fixed-IP sandbox's tunnel (work 073): Modal's allowlist holding only the
 * region's exits, and the supervisor's sing-box config with the credential
 * for today, which outlives the sandbox's hour. A 503 when the platform has
 * no root key, never a sandbox leaving from Modal's own IPs.
 */
async function exitTunnel(
  env: ModalPlatformEnv,
  input: SandboxEnsureInput,
): Promise<{ policy: OutboundPolicy; env: Record<string, string> } | Response> {
  const exits = egressExitsFor(input.deployment.fixedIps ?? "");
  if (!env.EGRESS_ROOT_KEY || exits.length === 0) {
    return json(
      {
        code: "fixed_ips_unavailable",
        message: "Fixed IPs are not available in this region right now",
      },
      503,
    );
  }
  const uuid = await exitCredential(
    env.EGRESS_ROOT_KEY,
    await exitIdentity(input.accountId, input.deployment.id),
    utcDay(),
  );
  return {
    policy: {
      domains: [],
      cidrs: [...new Set(exits.map((exit) => `${exit.server}/32`))].sort(),
    },
    env: {
      BLUE_EGRESS_CLIENT: JSON.stringify(exitClientConfig(exits, uuid)),
      // Always allowed on the exits (a platform host), so health probes
      // work whatever the deployment's allowlist.
      BLUE_EGRESS_PROBE_URL: `${input.edge.replace(/\/$/, "")}/v1/egress-ips`,
    },
  };
}

/** The Modal provider over an environment whose shim is configured. */
export function modalToolSandbox(env: ModalPlatformEnv): ToolSandboxProvider {
  return {
    name: "modal",
    ensure: (input, startedAt) => ensure(env, input, startedAt),
    retire: (input) => retire(env, input),
    endpoint: (sandboxId) => endpoint(env, sandboxId),
    runtimeAction: (sandboxId, action) => runtimeAction(env, sandboxId, action),
    runtimeStatus: (sandboxId) => runtimeStatus(env, sandboxId),
    listFiles: (scope, cursor) => listFiles(env, scope, cursor),
    exportFile: (scope, path, expected) => exportFile(env, scope, path, expected),
    signDownload: (scope, path) => signDownload(env, scope, path),
  };
}

/**
 * Modal-backed ensure: the workspace is a Modal Volume (resolved by name),
 * the supervisor is reached over its encrypted tunnel, and the run hook is
 * delivered by the shim after sandbox boot. A session snapshot from a
 * previous suspend restores the filesystem when present.
 */
async function ensure(
  env: ModalPlatformEnv,
  input: SandboxEnsureInput,
  startedAt: number,
): Promise<Response> {
  // With fixed IPs (work 073) everything leaves through the region's exits,
  // which enforce the deployment's allowlist; Modal lets the sandbox reach
  // the exits only, so it fails closed when the tunnel is down. Otherwise
  // the deployment's egress allowlist (work 057) plus the platform hosts
  // the supervisor itself needs. Absent leaves the sandbox open.
  const tunnel = input.deployment.fixedIps
    ? await exitTunnel(env, input)
    : undefined;
  if (tunnel instanceof Response) return tunnel;
  const volumeName = modalVolumeName(env, input.workspace.id);
  const runStartedAt = Date.now();
  const snapshotImageId = await modalSnapshotForSession(env, input.sessionID).catch(
    () => null,
  );
  const sandboxToken = crypto.randomUUID();
  const profileImage = managedRuntimeModalImage(input.deployment);
  // The deployment's region (work 057) wins over the platform default.
  const region = modalRegion(input.deployment.region) ?? env.MODAL_SANDBOX_REGION;
  const egress = tunnel
    ? tunnel.policy
    : input.deployment.egress
    ? {
        domains: [
          ...new Set([
            ...input.deployment.egress.domains,
            ...platformEgressDomains(input.edge, env.BLUE_AWS_REGION),
          ]),
        ].sort(),
        cidrs: input.deployment.egress.cidrs,
      }
    : undefined;
  const launched = await modalSandboxCreate(env, {
    image_name: profileImage?.image ?? env.MODAL_SANDBOX_IMAGE,
    ...(profileImage ? { supervisor_port: profileImage.supervisorPort } : {}),
    ...(env.MODAL_SANDBOX_APP ? { app_name: env.MODAL_SANDBOX_APP } : {}),
    ...(snapshotImageId ? { snapshot_image_id: snapshotImageId } : {}),
    cpu: env.MODAL_SANDBOX_CPU ? Number(env.MODAL_SANDBOX_CPU) : 2,
    memory_mib: env.MODAL_SANDBOX_MEMORY_MIB
      ? Number(env.MODAL_SANDBOX_MEMORY_MIB)
      : 4096,
    ...(region ? { region } : {}),
    ...(egress
      ? {
          outbound_domain_allowlist: egress.domains,
          outbound_cidr_allowlist: egress.cidrs,
        }
      : {}),
    env: {
      // Ambient AWS credentials for the supervisor's artifact fetch and any
      // S3-based tooling.
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN
        ? { AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN }
        : {}),
      AWS_DEFAULT_REGION: env.BLUE_AWS_REGION,
      AWS_REGION: env.BLUE_AWS_REGION,
      // Bearer for requests arriving over the public tunnel; the supervisor
      // requires it from non-loopback clients. The shim persists it so the
      // endpoint cache can resend it on later calls.
      BLUE_SANDBOX_TOKEN: sandboxToken,
      ...(tunnel?.env ?? {}),
    },
    volume_name: volumeName,
    mount_path: "/workspace",
    timeout_seconds: SANDBOX_MAXIMUM_DURATION_SECONDS,
    run_hook_payload: {
      toolSandbox: true,
      sessionId: input.sessionID,
      generation: input.generation,
      edge: input.edge,
      runtimeToken: input.runtimeToken,
      fileSystem: {
        id: volumeName,
        backend: "mounted",
        mountPath: "/workspace",
      },
      agentArtifact: input.deployment.artifact,
    },
    session_id: input.sessionID,
  });
  if (egress && !samePolicy(launched.outbound_policy, egress)) {
    // A shim that predates egress drops the allowlists and starts the
    // sandbox open; never hand that sandbox to a restricted deployment.
    await modalSandboxTerminate(env, launched.sandbox_id).catch(() => undefined);
    console.error(
      JSON.stringify({
        level: "error",
        event: "platform.sandbox_egress_unconfirmed",
        provider: "modal",
        sessionId: input.sessionID,
        deploymentId: input.deployment.id,
        sandboxId: launched.sandbox_id,
      }),
    );
    return json(
      {
        code: "egress_unconfirmed",
        message: "The sandbox could not confirm the deployment's egress allowlist",
      },
      503,
    );
  }
  const runMs = Date.now() - runStartedAt;
  // The shim already waited for liveness and delivered the run hook; this
  // check is the supervisor's own verdict (session + generation served)
  // and it measures the edge→tunnel round trip for the timings.
  const supervisorStartedAt = Date.now();
  await waitForSupervisorReady(
    { sessionID: input.sessionID, generation: input.generation },
    () =>
      fetch(`${launched.tunnel_url}/health`, {
        headers: { "x-sandbox-token": sandboxToken },
        signal: AbortSignal.timeout(10_000),
      }),
  ).catch(async (error: unknown) => {
    // The caller sees a failed ensure and never learns this sandbox; left
    // running it would bill until its maximum duration.
    await modalSandboxTerminate(env, launched.sandbox_id).catch(() => undefined);
    throw error;
  });
  const supervisorMs = Date.now() - supervisorStartedAt;
  console.log(
    JSON.stringify({
      level: "info",
      event: "platform.sandbox_ready",
      provider: "modal",
      sessionId: input.sessionID,
      generation: input.generation,
      deploymentId: input.deployment.id,
      agentId: input.deployment.agentId,
      sandboxId: launched.sandbox_id,
      resumedFromSnapshot: snapshotImageId !== null,
      shimReadyMs: launched.ready_ms,
      supervisorMs,
      totalMs: Date.now() - startedAt,
    }),
  );
  return json(
    {
      sandboxId: launched.sandbox_id,
      // The volume name fills the access-point slot so the response shape
      // is unchanged; nothing downstream parses it as an AWS identifier.
      accessPointId: volumeName,
      maximumDurationSeconds: SANDBOX_MAXIMUM_DURATION_SECONDS,
      expiresAtMs: runStartedAt + SANDBOX_MAXIMUM_DURATION_SECONDS * 1_000,
      timings: {
        accessPointMs: 0,
        runMs,
        supervisorMs,
        totalMs: Date.now() - startedAt,
      },
    },
    201,
  );
}

async function retire(
  env: ModalPlatformEnv,
  input: ToolSandboxRetireInput,
): Promise<void> {
  // No catch: a failed shim call must surface as a platform error so the
  // caller retries confirmation instead of freeing the workspace while the
  // sandbox still runs. A failed snapshot alone falls back to terminate.
  const retired = await modalSandboxRetire(env, input.sandboxId, {
    sessionId: input.sessionID,
    preserve: input.preserve,
  });
  if (input.preserve) {
    console.log(
      JSON.stringify({
        level: retired.preserved ? "info" : "warn",
        event: "platform.sandbox_preserved",
        provider: "modal",
        sessionId: input.sessionID,
        generation: input.generation,
        sandboxId: input.sandboxId,
        ...retired,
      }),
    );
  }
}

async function endpoint(
  env: ModalPlatformEnv,
  sandboxId: string,
): Promise<SupervisorEndpoint | { unavailable: string }> {
  // The tunnel URL is stable for the sandbox's life; auth is the
  // per-sandbox bearer the shim stored at create, sent as
  // x-sandbox-token.
  const status = await modalSandboxStatus(env, sandboxId);
  if (status.status !== "running" || !status.tunnel_url) {
    return { unavailable: status.status };
  }
  return {
    base: status.tunnel_url.replace(/\/$/, ""),
    token: status.sandbox_token ?? "",
    port: 443,
    tokenHeader: "x-sandbox-token",
  };
}

async function runtimeAction(
  env: ModalPlatformEnv,
  sandboxId: string,
  action: "resume" | "suspend" | "terminate",
): Promise<void> {
  if (action === "suspend") {
    await modalSandboxSuspend(env, sandboxId);
  } else if (action === "terminate") {
    await modalSandboxTerminate(env, sandboxId);
  } else {
    // Modal resume means a fresh sandbox from the session snapshot; the
    // ensure path does that, so a same-id resume cannot exist here.
    throw new Error(
      "resume is not supported by the modal provider; the next ensure restores the session snapshot",
    );
  }
}

async function runtimeStatus(
  env: ModalPlatformEnv,
  sandboxId: string,
): Promise<"running" | "terminated"> {
  try {
    return (await modalSandboxStatus(env, sandboxId)).status;
  } catch (error) {
    // The shim answers 404 for a sandbox Modal no longer knows.
    if (error instanceof ModalShimError && error.status === 404) return "terminated";
    throw error;
  }
}

/**
 * Modal-backed listing: the workspace is a Modal Volume named after the
 * workspace session id (the same id the ensure path resolves), read via
 * the shim — no running sandbox needed. Entries get the same
 * exportable-path filtering and shape as the S3 listing; volume objects
 * have no ETag, so the field is null.
 */
async function listFiles(
  env: ModalPlatformEnv,
  scope: WorkspaceScope,
  cursor: string | undefined,
): Promise<Response> {
  const listed = await modalVolumeList(
    env,
    modalVolumeName(env, scope.sessionId),
    cursor,
  );
  const files: WorkspaceFile[] = [];
  for (const entry of listed.entries) {
    if (entry.type !== "file") continue;
    const path = exportableWorkspacePath(entry.path);
    if (!path || path !== entry.path) continue;
    files.push({
      path,
      size: entry.size,
      lastModified: entry.mtime,
      etag: null,
    });
  }
  return json({ files, nextCursor: listed.next_cursor });
}

/**
 * Modal-backed export: same retain contract as the S3 path, but the
 * source read is the shim streaming the Modal Volume file straight into
 * a presigned PUT on the staging key — the bytes never transit the
 * worker. The shim reports the digest it computed plus a stat drift
 * flag that stands in for CopySourceIfMatch (volumes have no ETag), and
 * the platform verifies the staged byte count before publishing the
 * content-addressed copy.
 */
async function exportFile(
  env: ModalPlatformEnv,
  { accountId, sessionId }: WorkspaceScope,
  path: string,
  expected: WorkspaceExportExpectation | null,
): Promise<Response> {
  const volumeName = modalVolumeName(env, sessionId);
  const entry = await modalVolumeStat(env, volumeName, path);
  if (!entry) {
    return refuse("artifact_not_found", "Workspace file not found");
  }
  if (entry.type === "symlink") {
    return refuse("artifact_symlink_rejected", "Symbolic links are not exported");
  }
  if (entry.type !== "file") {
    return refuse("artifact_not_regular_file", "Only regular files can be exported");
  }
  if (entry.size > WORKSPACE_EXPORT_MAX_BYTES) {
    return refuse("artifact_too_large", "Workspace file is too large to export");
  }
  if (expected?.bytes !== undefined && expected.bytes !== entry.size) {
    return refuse(
      "artifact_size_mismatch",
      "Workspace file size differs from the expected byte count",
    );
  }
  const client = new S3Client(awsOptions(env));
  const pathDigest = hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)),
  );
  const artifactPrefix = `${workspaceArtifactPrefix(accountId, sessionId)}${pathDigest}/`;
  const stagingKey = `${artifactPrefix}pending/${crypto.randomUUID()}`;
  const discardStaging = () =>
    discardWorkspaceStaging(client, env.BLUE_ARTIFACT_BUCKET, stagingKey);
  const putUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: env.BLUE_ARTIFACT_BUCKET, Key: stagingKey }),
    { expiresIn: WORKSPACE_DOWNLOAD_URL_TTL_SECONDS },
  );
  const exported = await modalVolumeExport(env, volumeName, path, putUrl);
  if (exported.changed) {
    await discardStaging();
    return refuse(
      "artifact_changed_during_snapshot",
      "Workspace file changed during export",
    );
  }
  // Trust-but-verify on the streamed byte count: the staged object must
  // be exactly as long as the shim reported sending.
  const staged = await client.send(
    new HeadObjectCommand({ Bucket: env.BLUE_ARTIFACT_BUCKET, Key: stagingKey }),
  );
  if ((staged.ContentLength ?? -1) !== exported.size) {
    await discardStaging();
    return refuse(
      "artifact_changed_during_snapshot",
      "Workspace file changed during export",
    );
  }
  const mediaType = exported.media_type;
  const mismatch = expectationMismatch(expected, {
    size: exported.size,
    sha256: exported.sha256,
    mediaType,
  });
  if (mismatch) {
    await discardStaging();
    return refuse(mismatch, "Retained snapshot does not match what the caller expected");
  }
  const metadata = {
    "workspace-path": encodeURIComponent(path),
    "workspace-session": sessionId,
  };
  const artifactKey = `${artifactPrefix}${exported.sha256}`;
  let published;
  try {
    published = await client.send(
      new CopyObjectCommand({
        Bucket: env.BLUE_ARTIFACT_BUCKET,
        Key: artifactKey,
        CopySource: `${env.BLUE_ARTIFACT_BUCKET}/${stagingKey.split("/").map(encodeURIComponent).join("/")}`,
        MetadataDirective: "REPLACE",
        ContentType: mediaType,
        Metadata: metadata,
      }),
    );
  } finally {
    await discardStaging();
  }
  const result: WorkspaceExportResult = {
    path,
    size: exported.size,
    sha256: exported.sha256,
    mediaType,
    snapshotId: `sha256:${exported.sha256}`,
    sourceEtag: null,
    sourceVersionId: null,
    artifact: {
      bucket: env.BLUE_ARTIFACT_BUCKET,
      key: artifactKey,
      etag: published.CopyObjectResult?.ETag ?? null,
    },
  };
  return json(result, 201);
}

/**
 * Modal-backed download signing: stats the volume file through the shim
 * for the refusal codes, then returns an HMAC-signed URL on the shim's
 * public custom domain (MODAL_DOWNLOAD_BASE_URL) — the presigned-URL
 * analog, so the browser fetches bytes straight from Modal and the
 * *.modal.run host never surfaces.
 */
async function signDownload(
  env: ModalPlatformEnv,
  { sessionId }: WorkspaceScope,
  path: string,
): Promise<Response> {
  const volumeName = modalVolumeName(env, sessionId);
  const entry = await modalVolumeStat(env, volumeName, path);
  if (!entry) {
    return json(
      { code: "artifact_not_found", message: "Workspace file not found" },
      404,
    );
  }
  if (entry.type === "symlink") {
    return json(
      { code: "artifact_symlink_rejected", message: "Symbolic links are not downloadable" },
      422,
    );
  }
  if (entry.type !== "file") {
    return json(
      { code: "artifact_not_regular_file", message: "Only regular files can be downloaded" },
      422,
    );
  }
  const baseUrl = required(env.MODAL_DOWNLOAD_BASE_URL, "MODAL_DOWNLOAD_BASE_URL");
  const mediaType = entry.media_type ?? "application/octet-stream";
  const signed = await modalSignedDownloadUrl(env, baseUrl, volumeName, path);
  return json({
    path,
    size: entry.size,
    etag: null,
    versionId: null,
    lastModified: entry.mtime,
    mediaType,
    ...signed,
  });
}
