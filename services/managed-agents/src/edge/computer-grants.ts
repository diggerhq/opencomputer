/**
 * What a computer call may use (work 080): only the
 * connections people granted to the organization's computer, never anyone's
 * personal connections. A grant is for one thread (the session the key was
 * minted for), for the Slack user who owns that thread, or for everyone; the
 * narrowest that has a match wins, as for secrets.
 */

import type { ComputerServiceAttachment, Connection } from "../protocol.js";
import type { RequestIdentity } from "./auth.js";
import type { AccountDurableObject } from "./account-do.js";
import type { ComputerDurableObject } from "../computer/durable-object.js";

/** Whom a computer key acts for: its live session and that session's owner, as the gateway has them. */
export interface ComputerGrantAudience {
  sessionKey: string;
  ownerId: string;
}

interface Env {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
  COMPUTERS?: unknown;
}

/** The granted connections for a service, from the narrowest audience that has any (optionally only one label). */
export function narrowestGrantedConnections(
  attachments: ComputerServiceAttachment[],
  audience: ComputerGrantAudience | null,
  label?: string,
): Connection[] {
  const tiers: Array<(a: ComputerServiceAttachment) => boolean> = [
    (a) => !!audience && a.scope === "session" && a.subject === audience.sessionKey,
    (a) => !!audience && a.scope === "user" && a.subject === audience.ownerId,
    (a) => a.scope === "everyone",
  ];
  const candidates = label ? attachments.filter((a) => a.label === label) : attachments;
  for (const inTier of tiers) {
    const matched = candidates.filter(inTier);
    if (matched.length > 0) return matched.map((a) => a.connection);
  }
  return [];
}

/**
 * Every granted connection the audience can reach, across services: for each
 * service and label, the narrowest audience's grants, as a call naming that
 * label would resolve them.
 */
export function reachableGrantedConnections(
  attachments: ComputerServiceAttachment[],
  audience: ComputerGrantAudience | null,
): Connection[] {
  const reachable = new Map<string, Connection>();
  const seen = new Set<string>();
  for (const { service, label } of attachments) {
    const key = `${service}\n${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ofService = attachments.filter((a) => a.service === service);
    for (const connection of narrowestGrantedConnections(ofService, audience, label)) {
      reachable.set(connection.id, connection);
    }
  }
  return [...reachable.values()];
}

/**
 * The live session a computer key acts for, and its owner. A key without one
 * (the host's own, or one whose thread has ended) reaches only grants for
 * everyone.
 */
async function grantAudience(env: Env, identity: RequestIdentity): Promise<ComputerGrantAudience | null> {
  const computers = env.COMPUTERS as DurableObjectNamespace<ComputerDurableObject> | undefined;
  return identity.sessionKey && computers
    ? await computers.getByName(identity.accountId).grantAudience(identity.sessionKey)
    : null;
}

/** The connections a computer key may use for a service. */
export async function computerGrantedConnections(
  env: Env,
  identity: RequestIdentity,
  service: string,
  label?: string,
): Promise<Connection[]> {
  const audience = await grantAudience(env, identity);
  const attachments = await env.ACCOUNTS.getByName(identity.accountId).listComputerServiceAttachments(service);
  return narrowestGrantedConnections(attachments, audience, label);
}

/** Every connection a computer key may use, for `GET /v1/connections`. */
export async function computerReachableConnections(env: Env, identity: RequestIdentity): Promise<Connection[]> {
  const audience = await grantAudience(env, identity);
  const attachments = await env.ACCOUNTS.getByName(identity.accountId).listComputerServiceAttachments();
  return reachableGrantedConnections(attachments, audience);
}

export const COMPUTER_GRANT_HINT =
  "The computer uses only connections people grant it. Ask the person in the thread to connect one and grant it to the computer.";
