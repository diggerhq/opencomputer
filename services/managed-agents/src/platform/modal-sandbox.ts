/**
 * Modal-backed tool-sandbox provider. The control plane (a small FastAPI
 * shim deployed on Modal) owns the gRPC SDK calls workerd cannot make;
 * everything past creation is plain HTTPS — the supervisor tunnel, the
 * snapshot lookup, suspend/terminate. Selected per environment with
 * BLUE_SANDBOX_PROVIDER=modal.
 */
import { accountSelected } from "../rollout-bucket.js";

export interface ModalEnv {
  BLUE_SANDBOX_PROVIDER?: string;
  MODAL_SHIM_URL?: string;
  MODAL_SHIM_TOKEN?: string;
  MODAL_SANDBOX_IMAGE?: string;
  MODAL_SANDBOX_APP?: string;
  MODAL_SANDBOX_REGION?: string;
  MODAL_SANDBOX_CPU?: string;
  MODAL_SANDBOX_MEMORY_MIB?: string;
  MODAL_VOLUME_PREFIX?: string;
  /**
   * Comma-separated account ids whose sandboxEnsure calls run on Modal,
   * or '*' for every account. Empty/unset selects nobody — the modal code
   * stays deployed but dormant.
   */
  MODAL_ACCOUNT_ALLOWLIST?: string;
  /**
   * Gradual-rollout knob (0-100): accounts whose deterministic bucket is
   * below it also select Modal. Bucketing is stable on the account id, so
   * raising the number only ever adds orgs — none flap back out.
   */
  MODAL_ROLLOUT_PERCENT?: string;
  /**
   * Public base the workspace download URLs are minted against — the shim's
   * custom domain (CNAME to the Modal web endpoint), e.g.
   * https://dl.opencomputer.dev. Required for /v1/workspaces/download on
   * the modal provider; without it the endpoint refuses rather than leak
   * the *.modal.run host into client-facing URLs.
   */
  MODAL_DOWNLOAD_BASE_URL?: string;
}

/** Modal sandbox object ids are `sb-…`; no other id is Modal's. */
export function isModalSandboxId(sandboxId: string): boolean {
  return sandboxId.startsWith("sb-");
}

export function modalProviderEnabled(
  env: ModalEnv,
): env is ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string } {
  return (
    env.BLUE_SANDBOX_PROVIDER === "modal" &&
    typeof env.MODAL_SHIM_URL === "string" &&
    env.MODAL_SHIM_URL.length > 0 &&
    typeof env.MODAL_SHIM_TOKEN === "string" &&
    env.MODAL_SHIM_TOKEN.length > 0
  );
}

/**
 * Per-org provider selection for the gated rollout: the modal infra must
 * be configured (modalProviderEnabled) and the account either named in
 * MODAL_ACCOUNT_ALLOWLIST ('*' selects everyone) or bucketed inside
 * MODAL_ROLLOUT_PERCENT. Selection happens at ensure time; everything
 * after that routes on the sb- sandbox id, so an org keeps operating its
 * existing Modal sandboxes even if it later leaves the gate.
 */
export function modalProviderSelected(
  env: ModalEnv,
  accountId: string,
): env is ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string } {
  if (!modalProviderEnabled(env)) return false;
  return accountSelected(
    accountId,
    env.MODAL_ACCOUNT_ALLOWLIST,
    env.MODAL_ROLLOUT_PERCENT,
  );
}

export interface ModalShimCreateRequest {
  image_name?: string;
  /** The supervisor's port in the image; the shim defaults to 8080. */
  supervisor_port?: number;
  snapshot_image_id?: string;
  cpu?: number;
  memory_mib?: number;
  region?: string;
  env?: Record<string, string>;
  volume_name?: string;
  mount_path?: string;
  timeout_seconds?: number;
  app_name?: string;
  run_hook_payload?: Record<string, unknown>;
  /**
   * Deliver the run hook after responding (work 078). The response's `hook`
   * is then `{ pending: true }`; a shim that predates the flag ignores it
   * and delivers synchronously.
   */
  run_hook_async?: boolean;
  session_id?: string;
  /**
   * Modal outbound allowlists (work 057). Sent together or not at all:
   * both present restricts the sandbox, both absent leaves it open.
   */
  outbound_domain_allowlist?: string[];
  outbound_cidr_allowlist?: string[];
}

export interface ModalShimCreateResponse {
  sandbox_id: string;
  tunnel_url: string;
  ready_ms: number;
  hook?:
    | { hookMs: number; response: string }
    | { pending: true; startedAt?: number }
    | null;
  /**
   * The allowlists the returned sandbox runs with, echoed by a shim that
   * applied them. A shim that predates egress omits it.
   */
  outbound_policy?: { domains: string[]; cidrs: string[] } | null;
}

export interface ModalShimStatusResponse {
  sandbox_id: string;
  status: "running" | "terminated";
  tunnel_url?: string;
  /** The BLUE_SANDBOX_TOKEN the sandbox was created with, stored by the shim. */
  sandbox_token?: string;
}

export class ModalShimError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ModalShimError";
  }
}

async function shimFetch<R>(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  method: string,
  path: string,
  payload: unknown,
  timeoutMs: number,
): Promise<R> {
  const base = env.MODAL_SHIM_URL.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-shim-token": env.MODAL_SHIM_TOKEN,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new ModalShimError(
      response.status,
      `Modal shim ${method} ${path} returned ${String(response.status)}`,
    );
  }
  return (await response.json()) as R;
}

export function modalVolumeName(env: ModalEnv, workspaceId: string): string {
  const prefix = env.MODAL_VOLUME_PREFIX ?? "oc-ws-";
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
  return `${prefix}${safe}`;
}

export async function modalSandboxCreate(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  request: ModalShimCreateRequest,
): Promise<ModalShimCreateResponse> {
  // The create call itself takes a few seconds (sandbox boot plus the run
  // hook round trip); the timeout is deliberately generous so a slow image
  // pull surfaces as a shim error rather than a client abort.
  return shimFetch(env, "POST", "/sandboxes", request, 300_000);
}

export async function modalSandboxStatus(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  sandboxId: string,
): Promise<ModalShimStatusResponse> {
  return shimFetch(
    env,
    "GET",
    `/sandboxes/${encodeURIComponent(sandboxId)}`,
    undefined,
    15_000,
  );
}

export interface ModalShimListedSandbox {
  sandbox_id: string;
  session_id: string | null;
  /** Unix seconds the shim first knew the sandbox (its create, or its first listing). */
  seen_at: number;
}

/** The running sandboxes of the session runtime app. */
export async function modalSandboxList(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
): Promise<ModalShimListedSandbox[]> {
  const app = encodeURIComponent(env.MODAL_SANDBOX_APP ?? "opencomputer-sandboxes");
  const listed = await shimFetch<{ sandboxes: ModalShimListedSandbox[] }>(
    env,
    "GET",
    `/sandboxes?app=${app}`,
    undefined,
    60_000,
  );
  return listed.sandboxes;
}

export async function modalSandboxTerminate(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  sandboxId: string,
): Promise<void> {
  await shimFetch(
    env,
    "POST",
    `/sandboxes/${encodeURIComponent(sandboxId)}/terminate`,
    {},
    30_000,
  );
}

export async function modalSandboxSuspend(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  sandboxId: string,
  sessionId?: string,
): Promise<{ image_id: string; snapshot_ms: number }> {
  return shimFetch(
    env,
    "POST",
    `/sandboxes/${encodeURIComponent(sandboxId)}/suspend`,
    { session_id: sessionId },
    300_000,
  );
}

/**
 * Retires a Modal sandbox. With `preserve`, the shim snapshots the
 * filesystem before terminating, and the next ensure for the session starts
 * from that snapshot, so state outside the workspace volume survives an idle
 * retirement. A failed snapshot must not leave the sandbox running or fail
 * the retirement (the caller frees the workspace only on success), so it
 * falls back to a plain terminate, whose failure does propagate.
 */
export async function modalSandboxRetire(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  sandboxId: string,
  options: { sessionId: string; preserve: boolean },
): Promise<
  | { preserved: true; imageId: string; snapshotMs: number }
  | { preserved: false; snapshotError?: string }
> {
  if (options.preserve) {
    try {
      const snapshot = await modalSandboxSuspend(env, sandboxId, options.sessionId);
      return {
        preserved: true,
        imageId: snapshot.image_id,
        snapshotMs: snapshot.snapshot_ms,
      };
    } catch (error) {
      await modalSandboxTerminate(env, sandboxId);
      return {
        preserved: false,
        snapshotError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  await modalSandboxTerminate(env, sandboxId);
  return { preserved: false };
}

export async function modalSnapshotForSession(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  sessionId: string,
): Promise<string | null> {
  const result = await shimFetch<{ image_id: string | null }>(
    env,
    "GET",
    `/snapshots/${encodeURIComponent(sessionId)}`,
    undefined,
    15_000,
  );
  return result.image_id;
}

// ---- workspace volume filesystem ----------------------------------------
// Modal Volume equivalents of the S3 Reads the /v1/workspaces/* endpoints
// do: list, stat (for refusal codes and sizes), export into a presigned S3
// PUT (the shim streams volume -> bucket so 1GiB exports never transit the
// worker), and HMAC-signed downloads served straight off the shim's custom
// domain — the presigned-URL analog.

export interface ModalShimFileEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: string | null;
  media_type?: string;
}

export async function modalVolumeList(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  volumeName: string,
  cursor?: string,
): Promise<{ entries: ModalShimFileEntry[]; next_cursor: string | null }> {
  return shimFetch(
    env,
    "GET",
    `/volumes/${encodeURIComponent(volumeName)}/list` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
    undefined,
    60_000,
  );
}

export async function modalVolumeStat(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  volumeName: string,
  path: string,
): Promise<ModalShimFileEntry | null> {
  try {
    return await shimFetch<ModalShimFileEntry>(
      env,
      "GET",
      `/volumes/${encodeURIComponent(volumeName)}/stat?path=${encodeURIComponent(path)}`,
      undefined,
      30_000,
    );
  } catch (error) {
    if (error instanceof ModalShimError && error.status === 404) return null;
    throw error;
  }
}

export type ModalVolumeExportResult =
  | { changed: true }
  | { changed: false; size: number; sha256: string; media_type: string };

/**
 * Streams the volume file into a presigned S3 PUT the platform issued for
 * its staging key. `changed` mirrors S3's CopySourceIfMatch refusal: the
 * shim stats the file before and after the transfer and reports a drift.
 */
export async function modalVolumeExport(
  env: ModalEnv & { MODAL_SHIM_URL: string; MODAL_SHIM_TOKEN: string },
  volumeName: string,
  path: string,
  putUrl: string,
): Promise<ModalVolumeExportResult> {
  try {
    const result = await shimFetch<{
      changed: boolean;
      size: number;
      sha256: string;
      media_type: string;
    }>(
      env,
      "POST",
      `/volumes/${encodeURIComponent(volumeName)}/export`,
      { path, put_url: putUrl },
      // Sized for the 1GiB export ceiling; volume reads plus the staging
      // PUT both run inside this window.
      600_000,
    );
    if (result.changed) return { changed: true };
    return {
      changed: false,
      size: result.size,
      sha256: result.sha256,
      media_type: result.media_type,
    };
  } catch (error) {
    if (error instanceof ModalShimError && error.status === 404) {
      return { changed: true };
    }
    throw error;
  }
}

const MODAL_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * Mints the public download URL the shim's /dl route verifies: the same
 * HMAC (shim token over vol\npath\nexp) on both sides, so the platform
 * signs without a round trip. The URL carries the same trust as a
 * presigned S3 GET — bearer, short-lived.
 */
export async function modalSignedDownloadUrl(
  env: ModalEnv & { MODAL_SHIM_TOKEN: string },
  baseUrl: string,
  volumeName: string,
  path: string,
): Promise<{ url: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1_000) + MODAL_DOWNLOAD_URL_TTL_SECONDS;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.MODAL_SHIM_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${volumeName}\n${path}\n${String(exp)}`),
  );
  const sig = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const resource = new URL("/dl", baseUrl.replace(/\/+$/, "") + "/");
  resource.searchParams.set("vol", volumeName);
  resource.searchParams.set("path", path);
  resource.searchParams.set("exp", String(exp));
  resource.searchParams.set("sig", sig);
  return {
    url: resource.toString(),
    expiresAt: new Date(exp * 1_000).toISOString(),
  };
}
