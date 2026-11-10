import type { DeploymentPoolDurableObject } from "./deployment-pool-do.js";
import type { AgentDeployment } from "../protocol.js";
import { regionPlacement } from "../deployment-region.js";
import { accountSelected } from "../rollout-bucket.js";

/** Bindings a runtime launch needs; a subset of the worker and DO env. */
export interface RuntimeLaunchEnv {
  RUNTIMES?: Fetcher;
  POOLS?: DurableObjectNamespace<DeploymentPoolDurableObject>;
  BLUE_RUNTIME_IMAGE_ARN?: string;
  BLUE_RUNTIME_IMAGE_VERSION?: string;
}

export function deploymentPool(
  env: RuntimeLaunchEnv,
  accountId: string,
  deployment: AgentDeployment,
): DurableObjectStub<DeploymentPoolDurableObject> {
  if (!env.POOLS) throw new Error("Deployment pool is not configured");
  return env.POOLS.getByName(
    [accountId, deployment.id, deployment.imageVersion].join(":"),
    regionPlacement(deployment.region),
  );
}

/** The edge settings that pick where a deployed agent's session runs. */
export interface SessionRuntimeSelectionEnv {
  EXTERNAL_SESSION_RUNTIME?: string;
  /**
   * Accounts whose new sessions run in the sandbox session runtime instead
   * of Workerd: comma-separated account ids, or '*' for everyone (work 078).
   */
  SESSION_SANDBOX_ACCOUNTS?: string;
  /** Percent of accounts (stable bucket) that join the sandbox runtime. */
  SESSION_SANDBOX_ROLLOUT_PERCENT?: string;
}

/**
 * Whether a deployed agent's session runs on the Workerd runtime. By
 * default yes, in production. Two things opt a session out:
 *
 * - EXTERNAL_SESSION_RUNTIME="true" moves the whole stack: the session
 *   waits for a runtime that connects itself over the session socket (a
 *   test fake, `npm run runtime`, or the sandbox runtime the DO-first start
 *   launches).
 * - SESSION_SANDBOX_ACCOUNTS / SESSION_SANDBOX_ROLLOUT_PERCENT move one
 *   account at a time: a selected account's new sessions run in the sandbox
 *   session runtime; everyone else stays on Workerd. The choice is made
 *   once, at session create, and stored on the session, so an account that
 *   later leaves the gate keeps operating its existing sessions where they
 *   started.
 */
export function sessionRunsOnWorkerd(
  env: object,
  accountId?: string,
): boolean {
  const selection = env as SessionRuntimeSelectionEnv;
  if (selection.EXTERNAL_SESSION_RUNTIME === "true") return false;
  if (
    accountId !== undefined &&
    accountSelected(
      accountId,
      selection.SESSION_SANDBOX_ACCOUNTS,
      selection.SESSION_SANDBOX_ROLLOUT_PERCENT,
    )
  ) {
    return false;
  }
  return true;
}
