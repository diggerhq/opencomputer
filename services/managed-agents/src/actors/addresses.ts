// How one actor reaches another (spec 17): a typed stub by name. The only place a binding is read.

import type { SessionLogRpc } from "../computer/session-log-contract.js";
import type { ComputerRpcAdded, LiveRpc, OrgRpc, SessionLogRpcAdded, SlackRpc } from "../actor/contracts.js";

export interface ActorEnv {
  ORGS?: DurableObjectNamespace;
  SESSION_LOG?: DurableObjectNamespace;
  COMPUTERS?: DurableObjectNamespace;
  SLACK?: DurableObjectNamespace;
  /** The `opencomputer-live` script's class, bound by `script_name`. */
  LIVE?: DurableObjectNamespace;
}

const stub = <T>(namespace: DurableObjectNamespace | undefined, binding: string, name: string): T => {
  if (!namespace) throw new Error(`${binding} is not bound`);
  return namespace.getByName(name) as unknown as T;
};

export const orgOf = (env: ActorEnv, org: string) => stub<OrgRpc>(env.ORGS, "ORGS", org);
export const logOf = (env: ActorEnv, sessionId: string) => stub<SessionLogRpc & SessionLogRpcAdded>(env.SESSION_LOG, "SESSION_LOG", sessionId);
/** A machine's Computer. The organization's first machine is named by the organization's id (spec 34.1). */
export const computerOf = (env: ActorEnv, machine: string) => stub<ComputerRpcAdded>(env.COMPUTERS, "COMPUTERS", machine);
export const slackOf = (env: ActorEnv, org: string) => stub<SlackRpc>(env.SLACK, "SLACK", org);
/** The organization's Live, in the `opencomputer-live` script. */
export const liveOf = (env: ActorEnv, org: string) => stub<LiveRpc>(env.LIVE, "LIVE", org);
