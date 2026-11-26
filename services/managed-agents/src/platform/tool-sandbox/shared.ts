/**
 * What the tool-sandbox providers and the platform Worker's routes share:
 * the environment, the provider interface, and the small helpers they
 * use. Kept free of provider imports so neither the provider, the
 * resolvers nor index.ts import each other in a cycle.
 */
import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import type { ComputerPlatformEnv } from "../computers/resources.js";
import type { SandboxEnsureInput } from "../sandbox-adapter.js";
import {
  WORKSPACE_EXPORT_ERRORS,
  type WorkspaceExportErrorCode,
  type WorkspaceExportExpectation,
  type WorkspaceExportFailure,
} from "../workspace-export.js";

/** The platform Worker's bindings. */
export interface PlatformEnv extends ComputerPlatformEnv {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN?: string;
  BLUE_AWS_REGION: string;
  BLUE_ARTIFACT_BUCKET: string;
  BLUE_SANDBOX_PROVIDER?: string;
  /** Which provider launches session runtimes: modal, or none when unset (work 078). */
  BLUE_SESSION_RUNTIME_PROVIDER?: string;
  MODAL_SHIM_URL?: string;
  MODAL_SHIM_TOKEN?: string;
  MODAL_SANDBOX_IMAGE?: string;
  MODAL_SANDBOX_APP?: string;
  MODAL_SANDBOX_REGION?: string;
  MODAL_SANDBOX_CPU?: string;
  MODAL_SANDBOX_MEMORY_MIB?: string;
  MODAL_VOLUME_PREFIX?: string;
  MODAL_DOWNLOAD_BASE_URL?: string;
  MODAL_ACCOUNT_ALLOWLIST?: string;
  MODAL_ROLLOUT_PERCENT?: string;
  /** Hex root key the fixed-IP exits derive credentials from (work 073). */
  EGRESS_ROOT_KEY?: string;
}

/** The platform environment once modalProviderEnabled has vouched for the shim. */
export type ModalPlatformEnv = PlatformEnv & {
  MODAL_SHIM_URL: string;
  MODAL_SHIM_TOKEN: string;
};

/** Where and how to reach a running sandbox's supervisor. */
export interface SupervisorEndpoint {
  base: string;
  token: string;
  port: number;
  /** The header the token travels in; without one the token is not sent. */
  tokenHeader?: string;
}

/** The account and workspace session a workspace-files request is scoped to. */
export interface WorkspaceScope {
  accountId: string;
  sessionId: string;
}

/** What retiring a sandbox needs; `preserve` is best effort (see SandboxTerminateInput). */
export interface ToolSandboxRetireInput {
  sandboxId: string;
  sessionID: string;
  generation: number;
  preserve: boolean;
}

/**
 * One request to a sandbox's supervisor through the platform's endpoint
 * cache. index.ts owns that cache; a provider that waits for its supervisor
 * through it leaves the endpoint warm for the session's first command.
 */
export type SupervisorRequest = (
  sandboxId: string,
  generation: number,
  path: string,
  timeoutMs: number,
) => Promise<Response>;

/**
 * A tool-sandbox backend: launching and retiring the computer a session's
 * tools run on, reaching its supervisor, and reading the workspace files it
 * mounts. Which provider serves a request is decided by the resolvers in
 * ./resolve.ts, never by the routes.
 */
export interface ToolSandboxProvider {
  readonly name: "modal" | "none";
  /**
   * Launches the computer for an ensure and waits until its supervisor
   * serves the session and generation. The response is the route's: 201
   * with sandboxId, accessPointId, maximumDurationSeconds, expiresAtMs and
   * timings, or a refusal.
   */
  ensure(
    input: SandboxEnsureInput,
    startedAt: number,
    supervisorRequest: SupervisorRequest,
  ): Promise<Response>;
  /**
   * Terminates the sandbox (snapshotting it first where `preserve` asks and
   * the provider can) and resolves once it is gone. Throws when that cannot
   * be confirmed, so the caller retries instead of freeing the workspace.
   */
  retire(input: ToolSandboxRetireInput): Promise<void>;
  /** Looks the sandbox up for its supervisor endpoint; its state when it is not running. */
  endpoint(sandboxId: string): Promise<SupervisorEndpoint | { unavailable: string }>;
  /**
   * The session-runtime routes' suspend/terminate/resume for a sandbox id
   * that reaches them.
   */
  runtimeAction?(
    sandboxId: string,
    action: "resume" | "suspend" | "terminate",
  ): Promise<void>;
  /** Whether a session runtime sandbox is still up; Modal only. */
  runtimeStatus?(sandboxId: string): Promise<"running" | "terminated">;
  /** One page of the workspace's exportable files. */
  listFiles(scope: WorkspaceScope, cursor: string | undefined): Promise<Response>;
  /**
   * Retains one workspace file as a content-addressed artifact in the
   * artifact bucket, refusing with the workspace-export error codes.
   */
  exportFile(
    scope: WorkspaceScope,
    path: string,
    expected: WorkspaceExportExpectation | null,
  ): Promise<Response>;
  /** A short-lived, signed download URL for one workspace file. */
  signDownload(scope: WorkspaceScope, path: string): Promise<Response>;
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** A workspace export refusal in the shape and status its code prescribes. */
export function refuseWorkspaceExport(
  code: WorkspaceExportErrorCode,
  message: string,
): Response {
  return json(
    { code, message } satisfies WorkspaceExportFailure,
    WORKSPACE_EXPORT_ERRORS[code].status,
  );
}

export function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function awsOptions(env: PlatformEnv): {
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
} {
  return {
    region: env.BLUE_AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    },
  };
}

export const WORKSPACE_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** The supervisor endpoint cache's validity. */
export const SUPERVISOR_TOKEN_MINUTES = 5;

/**
 * The staging key is this request's alone: discarding it can never touch
 * an object a manifest references. A delete that keeps failing is
 * reported so the leftover is visible rather than silently retained.
 */
export async function discardWorkspaceStaging(
  client: S3Client,
  bucket: string,
  stagingKey: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }),
      );
      return;
    } catch (error) {
      if (attempt === 2) {
        console.error(
          JSON.stringify({
            event: "workspace_export.staging_cleanup_failed",
            key: stagingKey,
            error: (error as { name?: string }).name ?? "Error",
          }),
        );
      }
    }
  }
}
