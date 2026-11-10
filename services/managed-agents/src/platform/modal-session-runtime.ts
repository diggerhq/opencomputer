/**
 * The Modal session-runtime provider: the OpenCode process (the supervisor's
 * managed-agent run hook, `src/microvm/supervisor.ts`) in a Modal sandbox.
 * Selected per environment with
 * BLUE_SESSION_RUNTIME_PROVIDER=modal on top of the Modal tool-sandbox
 * configuration (../modal-sandbox.ts). Which accounts' sessions reach this
 * provider at all is the edge's call (SESSION_SANDBOX_ACCOUNTS /
 * SESSION_SANDBOX_ROLLOUT_PERCENT in edge/runtime-launch.ts): a session
 * admitted on Workerd never asks the platform for a runtime. The
 * tool-sandbox gate (MODAL_ACCOUNT_ALLOWLIST, MODAL_ROLLOUT_PERCENT) does
 * not apply here.
 *
 * The sandbox runs the same image and supervisor as a Modal tool sandbox.
 * The shim boots it, mounts the session's workspace volume and delivers the
 * run hook; the supervisor then starts OpenCode and the runtime process,
 * which connects itself to the edge over the session socket. Nothing on
 * the edge addresses the sandbox directly: suspend and terminate reach it
 * through the platform by its `sb-` id (tool-sandbox/resolve.ts).
 */
import { modalRegion } from "../deployment-region.js";
import type { AgentDeployment } from "../protocol.js";
import {
  type ModalEnv,
  type ModalShimCreateRequest,
  modalProviderEnabled,
  modalSandboxCreate,
  modalSandboxTerminate,
  modalSnapshotForSession,
  modalVolumeName,
} from "./modal-sandbox.js";
import {
  SESSION_RUNTIME_MAXIMUM_DURATION_SECONDS,
  managedRuntimeModalImage,
} from "./sandbox-adapter.js";

export interface SessionRuntimeProviderEnv extends ModalEnv {
  BLUE_SESSION_RUNTIME_PROVIDER?: string;
  BLUE_AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
}

export type ModalSessionRuntimeEnv = SessionRuntimeProviderEnv & {
  MODAL_SHIM_URL: string;
  MODAL_SHIM_TOKEN: string;
};

/**
 * Which provider launches session runtimes. `aws` unless the environment
 * asks for Modal, and nothing launches a runtime for `aws` now: the
 * platform refuses the start. Asking for Modal without a configured shim
 * is a configuration error, not a silent fallback.
 */
export function sessionRuntimeProvider(
  env: SessionRuntimeProviderEnv,
): "aws" | "modal" {
  const requested = env.BLUE_SESSION_RUNTIME_PROVIDER ?? "aws";
  if (requested === "aws" || requested === "") return "aws";
  if (requested !== "modal") {
    throw new Error(
      `Unknown BLUE_SESSION_RUNTIME_PROVIDER "${requested}" (expected aws or modal)`,
    );
  }
  if (!modalProviderEnabled(env)) {
    throw new Error(
      "BLUE_SESSION_RUNTIME_PROVIDER=modal needs BLUE_SANDBOX_PROVIDER=modal, MODAL_SHIM_URL and MODAL_SHIM_TOKEN",
    );
  }
  return "modal";
}

export function modalSessionRuntimeSelected(
  env: SessionRuntimeProviderEnv,
): env is ModalSessionRuntimeEnv {
  return sessionRuntimeProvider(env) === "modal";
}

export interface ModalSessionRuntimeInput {
  accountId: string;
  projectId: string;
  sessionId: string;
  runtimeToken: string;
  edge: string;
  deployment: AgentDeployment;
}

/**
 * The shim create request for a session runtime. The run hook is the
 * managed-agent payload (supervisor `parseRunConfiguration`), with the
 * workspace as a volume the infrastructure mounts at /workspace. The
 * volume is keyed by session id.
 */
export function modalSessionRuntimeCreateRequest(
  env: ModalSessionRuntimeEnv,
  input: ModalSessionRuntimeInput,
  options: { snapshotImageId: string | null; sandboxToken: string },
): ModalShimCreateRequest {
  const volumeName = modalVolumeName(env, input.sessionId);
  const profileImage = managedRuntimeModalImage(input.deployment);
  const region =
    modalRegion(input.deployment.region) ?? env.MODAL_SANDBOX_REGION;
  return {
    image_name: profileImage?.image ?? env.MODAL_SANDBOX_IMAGE,
    ...(profileImage ? { supervisor_port: profileImage.supervisorPort } : {}),
    ...(env.MODAL_SANDBOX_APP ? { app_name: env.MODAL_SANDBOX_APP } : {}),
    ...(options.snapshotImageId
      ? { snapshot_image_id: options.snapshotImageId }
      : {}),
    cpu: env.MODAL_SANDBOX_CPU ? Number(env.MODAL_SANDBOX_CPU) : 2,
    memory_mib: env.MODAL_SANDBOX_MEMORY_MIB
      ? Number(env.MODAL_SANDBOX_MEMORY_MIB)
      : 4096,
    ...(region ? { region } : {}),
    env: {
      // The supervisor fetches the agent artifact from S3 itself; scrubbed
      // from everything
      // the agent spawns (supervisor `sandboxChildEnv`).
      ...(env.AWS_ACCESS_KEY_ID ? { AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID } : {}),
      ...(env.AWS_SECRET_ACCESS_KEY
        ? { AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY }
        : {}),
      ...(env.AWS_SESSION_TOKEN ? { AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN } : {}),
      ...(env.BLUE_AWS_REGION
        ? { AWS_DEFAULT_REGION: env.BLUE_AWS_REGION, AWS_REGION: env.BLUE_AWS_REGION }
        : {}),
      // Bearer for requests over the sandbox's public tunnel (the codex
      // relay reaches the supervisor that way); the shim stores it so the
      // provider's endpoint lookup can resend it.
      BLUE_SANDBOX_TOKEN: options.sandboxToken,
    },
    volume_name: volumeName,
    mount_path: "/workspace",
    timeout_seconds: SESSION_RUNTIME_MAXIMUM_DURATION_SECONDS,
    // The edge starts a runtime inside a 30 s waitUntil budget; the hook
    // answers only once OpenCode and the runtime have connected (~15 s after
    // a ~13 s boot), so the shim delivers it after responding.
    run_hook_async: true,
    run_hook_payload: {
      edge: input.edge,
      projectId: input.projectId,
      deploymentId: input.deployment.id,
      agentId: input.deployment.agentId,
      sessionId: input.sessionId,
      runtimeToken: input.runtimeToken,
      agentArtifact: input.deployment.artifact,
      fileSystem: {
        id: volumeName,
        backend: "mounted",
        mountPath: "/workspace",
      },
    },
    session_id: input.sessionId,
  };
}

export interface ModalSessionRuntimeStarted {
  provider: "modal";
  /** The sandbox id; it fills the microvmId slot the edge binds the session to. */
  microvmId: string;
  endpoint: string;
  /** The volume name, in the access-point slot of the response. */
  accessPointId: string;
  resumedFromSnapshot: boolean;
  shimReadyMs: number;
  hookMs: number | null;
}

/**
 * Starts a session runtime on Modal. The shim's create is idempotent per
 * session id, so a retried start returns the live sandbox. The hook is
 * delivered by the shim after it responds (the edge's waitUntil budget is
 * shorter than boot plus OpenCode start), so a 201 here means the sandbox
 * is booted and the runtime will connect to the edge on its own; the edge
 * learns the session is ready from that connection. A
 * hook the shim fails to deliver terminates the sandbox on the shim side.
 */
export async function startModalSessionRuntime(
  env: ModalSessionRuntimeEnv,
  input: ModalSessionRuntimeInput,
): Promise<ModalSessionRuntimeStarted> {
  const snapshotImageId = await modalSnapshotForSession(env, input.sessionId).catch(
    () => null,
  );
  const sandboxToken = crypto.randomUUID();
  const request = modalSessionRuntimeCreateRequest(env, input, {
    snapshotImageId,
    sandboxToken,
  });
  const launched = await modalSandboxCreate(env, request);
  if (launched.hook === null || launched.hook === undefined) {
    // The shim only omits the hook when it did not deliver one; a runtime
    // that never received its configuration is an idle sandbox.
    await modalSandboxTerminate(env, launched.sandbox_id).catch(() => undefined);
    throw new Error("Modal shim started the sandbox without delivering the run hook");
  }
  return {
    provider: "modal",
    microvmId: launched.sandbox_id,
    endpoint: launched.tunnel_url,
    accessPointId: request.volume_name ?? "",
    resumedFromSnapshot: snapshotImageId !== null,
    shimReadyMs: launched.ready_ms,
    hookMs: "hookMs" in launched.hook ? launched.hook.hookMs : null,
  };
}
