// The ComputerDurableObject namespace as the edge routes reach it: an organization's object by name, and
// the names that are not an organization's.

import type { ComputerEdgeEnv } from "../actors/computer/config.js";
import type { ComputerDurableObject } from "../actors/computer/durable-object.js";
import { CONNECT_CODE_INDEX_PREFIX } from "../actors/connect-codes/codes.js";
import { POOL_OBJECT } from "../ids/computer-names.js";

export type ComputerStub = DurableObjectStub<ComputerDurableObject>;

export function computers(env: ComputerEdgeEnv): DurableObjectNamespace<ComputerDurableObject> | null {
  return (env.COMPUTERS as DurableObjectNamespace<ComputerDurableObject> | undefined) ?? null;
}

export function computerOf(env: ComputerEdgeEnv, accountId: string): ComputerStub {
  return computers(env)!.getByName(accountId);
}


/** Names of ComputerDurableObjects that are not an organization's: the pool's slot table, Slack team links and connect code routing. */
export function reservedName(name: string): boolean {
  return name === POOL_OBJECT || name.startsWith("computer-slack-team:") || name.startsWith(CONNECT_CODE_INDEX_PREFIX);
}
