// Who this host is to the gateway: the WebSocket URL it dials, its bearer
// token and its id (work 052), and the code version it reports. They come from the environment (host.env),
// unless the gateway reassigned the host: a warm-pool computer (id `pool-…`)
// is claimed by an organization and told, with `assign`, to reconnect as it.
// The new identity is kept in <SP_DATA>/state/identity.json (0600, written
// atomically) so restarts keep it.
//
// Invariants: only a pool host can be reassigned, so an organization's
// computer can never be moved to another organization; the new URL must reach
// the same gateway (scheme and host) the pool host was dialing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface HostIdentity {
  gatewayUrl: string;
  token: string;
  hostId: string;
}

const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;

export const POOL_PREFIX = 'pool-';

/** The code version the host reports: SP_VERSION (the release's commit), else `git rev-parse` in `root`, else `dev`. */
export function codeVersion(explicit: string | undefined, root: string): string {
  if (explicit) return explicit;
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'dev';
  }
}

export function identityFile(dataDir: string) {
  return path.join(dataDir, 'state', 'identity.json');
}

/** The saved identity if there is a valid one, else the environment's. */
export function loadIdentity(env: NodeJS.ProcessEnv, file: string, fallbackId: string): HostIdentity {
  const fromEnv: HostIdentity = {
    gatewayUrl: env.SP_GATEWAY_URL ?? 'ws://localhost:3171/host',
    token: env.SP_HOST_TOKEN ?? '',
    hostId: env.SP_HOST_ID ?? fallbackId,
  };
  if (!existsSync(file)) return fromEnv;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<HostIdentity>;
    if (typeof saved.gatewayUrl === 'string' && typeof saved.token === 'string' && typeof saved.hostId === 'string' && saved.token && ORG_ID.test(saved.hostId)) {
      return { gatewayUrl: saved.gatewayUrl, token: saved.token, hostId: saved.hostId };
    }
  } catch {
    // A damaged file is ignored: the environment's identity still works.
  }
  return fromEnv;
}

/**
 * The identity an `assign` asks for, or an error saying why it is refused.
 * Pure: the caller saves it and reconnects.
 */
export function assignedIdentity(
  current: HostIdentity,
  m: { organizationId: string; hostToken: string; gatewayUrl: string },
): HostIdentity | { error: string } {
  if (!current.hostId.startsWith(POOL_PREFIX)) return { error: `host ${current.hostId} is not a pool host` };
  if (!ORG_ID.test(m.organizationId) || m.organizationId.startsWith(POOL_PREFIX)) return { error: 'bad organization id' };
  if (!m.hostToken) return { error: 'no host token' };
  let from: URL;
  let to: URL;
  try {
    from = new URL(current.gatewayUrl);
    to = new URL(m.gatewayUrl);
  } catch {
    return { error: 'bad gateway URL' };
  }
  if (from.protocol !== to.protocol || from.host !== to.host) return { error: 'gateway URL changes the gateway' };
  return { gatewayUrl: m.gatewayUrl, token: m.hostToken, hostId: m.organizationId };
}

export function saveIdentity(file: string, identity: HostIdentity) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
