/**
 * Which tool-sandbox provider serves a request. These are the only places
 * that know whether one does; the routes in index.ts call whichever
 * provider they are handed.
 */
import {
  isModalSandboxId,
  modalProviderEnabled,
  modalProviderSelected,
} from "../modal-sandbox.js";
import { modalToolSandbox, modalVolumeExists } from "./modal.js";
import type { AgentDeployment } from "../../protocol.js";
import {
  hasManagedRuntimeProfile,
  managedRuntimeModalImage,
} from "../sandbox-adapter.js";
import {
  type PlatformEnv,
  type ToolSandboxProvider,
  json,
  refuseWorkspaceExport,
} from "./shared.js";

/**
 * What answers where Modal does not: an account outside the gate, a runtime
 * profile without a Modal image, a sandbox id Modal does not own and a
 * session without a Modal volume. It launches nothing and reads an empty
 * workspace. A sandbox id that is not Modal's belongs to a computer of a
 * provider that no longer exists, which ran an hour at most: it is gone, so
 * retiring it is already done and the callers' cleanup of old records stays
 * idempotent. A Modal id only arrives here while Modal is not configured;
 * that sandbox may still run, so nothing is confirmed about it.
 */
function noToolSandbox(): ToolSandboxProvider {
  const confirmGone = (sandboxId: string): void => {
    if (isModalSandboxId(sandboxId)) {
      throw new Error("The Modal sandbox provider is not configured");
    }
  };
  return {
    name: "none",
    ensure: async () =>
      json(
        {
          code: "sandbox_provider_unavailable",
          message: "No sandbox provider is configured",
        },
        503,
      ),
    retire: async ({ sandboxId }) => confirmGone(sandboxId),
    endpoint: async () => ({ unavailable: "unknown" }),
    runtimeAction: async (sandboxId, action) => {
      if (action !== "terminate") {
        throw new Error(`No sandbox provider can ${action} ${sandboxId}`);
      }
      confirmGone(sandboxId);
    },
    listFiles: async () => json({ files: [], nextCursor: null }),
    exportFile: async () =>
      refuseWorkspaceExport("artifact_not_found", "Workspace file not found"),
    signDownload: async () =>
      json({ code: "artifact_not_found", message: "Workspace file not found" }, 404),
  };
}

/**
 * The provider a new sandbox for this workspace launches on. Per-org gate:
 * the modal infra stays configured for every stack, but an account only
 * lands on it via MODAL_ACCOUNT_ALLOWLIST/ROLLOUT_PERCENT. An account
 * outside the gate has no provider, and its ensure is refused.
 */
export async function toolSandboxForEnsure(
  env: PlatformEnv,
  input: {
    accountId: string;
    workspace: { id: string };
    deployment?: AgentDeployment;
  },
): Promise<ToolSandboxProvider> {
  // An operator runtime profile brings its own image and
  // supervisor port. One without a Modal image has nowhere to run; one with
  // it follows the gate like everyone else.
  if (
    input.deployment &&
    hasManagedRuntimeProfile(input.deployment) &&
    !managedRuntimeModalImage(input.deployment)
  ) {
    return noToolSandbox();
  }
  if (modalProviderEnabled(env) && modalProviderSelected(env, input.accountId)) {
    return modalToolSandbox(env);
  }
  return noToolSandbox();
}

/**
 * The provider that owns an existing sandbox. Modal ids are `sb-…` and
 * only route to Modal while the provider is configured; no other id may
 * reach the shim (its terminate swallows not-found, which would report a
 * sandbox it never looked at as gone).
 */
export function toolSandboxForId(
  env: PlatformEnv,
  sandboxId: string,
): ToolSandboxProvider {
  if (modalProviderEnabled(env) && isModalSandboxId(sandboxId)) {
    return modalToolSandbox(env);
  }
  return noToolSandbox();
}

/**
 * The provider holding this session's workspace files. Selection is not a
 * signal: an org outside the gate can still own a volume (a session ensured
 * before it left the allowlist, or one it bucketed into under a percent
 * rollout since lowered). The volume's existence is the deciding signal. A
 * session without one, or a probe that fails, reads an empty workspace.
 */
export async function toolSandboxForWorkspace(
  env: PlatformEnv,
  sessionId: string,
): Promise<ToolSandboxProvider> {
  if (modalProviderEnabled(env) && (await modalVolumeExists(env, sessionId))) {
    return modalToolSandbox(env);
  }
  return noToolSandbox();
}
