// How one actor reaches another (spec 17): a typed stub by name. The only place a binding is read.

import type { SessionLogRpc } from "./session-log/contract.js";
import type { ComputerRpc } from "./computer/contract.js";
import type { LiveRpc, LiveUpgrade } from "./live/contract.js";
import type { OrgRpc } from "./org/contract.js";
import type { SlackRpc } from "./slack/contract.js";

export interface ActorEnv {
  /** Bound in every deployment that runs the actors (wrangler.jsonc, wrangler.production.jsonc). */
  ORGS: DurableObjectNamespace;
  SESSION_LOG: DurableObjectNamespace;
  /** One ComputerDurableObject per organization, plus `computer-slack-team:<teamId>` link objects. */
  COMPUTERS: DurableObjectNamespace;
  SLACK: DurableObjectNamespace;
  /**
   * The `opencomputer-live` script's class, bound by `script_name` (spec 36.4). Only where that Worker is
   * deployed (wrangler.production.jsonc); `liveOf` is the one place its absence is an error.
   */
  LIVE?: DurableObjectNamespace;
}

const stub = <T>(namespace: DurableObjectNamespace, name: string): T => namespace.getByName(name) as unknown as T;

export const orgOf = (env: ActorEnv, org: string) => stub<OrgRpc>(env.ORGS, org);
export const logOf = (env: ActorEnv, sessionId: string) => stub<SessionLogRpc>(env.SESSION_LOG, sessionId);
/** A machine's Computer. The organization's first machine is named by the organization's id (spec 34.1). */
export const computerOf = (env: ActorEnv, machine: string) => stub<ComputerRpc>(env.COMPUTERS, machine);
export const slackOf = (env: ActorEnv, org: string) => stub<SlackRpc>(env.SLACK, org);
/** The organization's Live, in the `opencomputer-live` script: its methods, and the socket upgrade (`LiveUpgrade`). */
export const liveOf = (env: ActorEnv, org: string) => {
  if (!env.LIVE) throw new Error("LIVE is not bound: this deployment has no opencomputer-live Worker");
  return stub<LiveRpc & LiveUpgrade>(env.LIVE, org);
};
