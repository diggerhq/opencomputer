// Starts the relay's local socket (work 084): C's wire-link with its terminals
// and workspace files, given the hooks api-host.ts answers with. Called once,
// on the first welcome from a v4 gateway, so a host behind a v3 gateway never
// creates `$HOST_RUN/wire`.
//
// Invariants:
// - Only where runners run as another user (SP_RUNNER_USER: the host is
//   sp-host, sp-host.sh migrate): that is where provision.sh runs the relay
//   (its unit needs the host-user-sp-host marker), and only there can the
//   socket be sp-wire's and out of the sessions' reach. Elsewhere (a host
//   still running as agent, a laptop) there is no wire socket at all.
// - The socket's directory and the terminals' sockets belong to group
//   `sp-wire`; without that group wire-link chowns nothing and fails closed.
// - On a `podman` host (work 103) a terminal is a shell in the session's
//   container and `/files` run inside it, or in a helper container while it
//   is stopped (sandbox/scripts.ts `filesPlace`); neither ever runs on the host.
// - Upload records live in `stateDir` (HOST_DATA/state/uploads), so a push's
//   per-name record survives a reboot.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { WireHooks, WireLinkLike } from './api-relay.js';
import { systemdRunPrefix } from './runner-limits.js';
import type { SandboxPlace } from './sandbox/scripts.js';
import type { RunnerUser } from './runner-user.js';
import { createTerminals } from './terminal.js';
import { serveWireLink, WIRE_DIR } from './wire-link.js';
import { createWorkspaceFiles, type Place } from './workspace-files.js';

export interface WireOptions {
  launch: string;
  /** The runners' user; absent (runners run as the host's user): no relay. */
  user?: RunnerUser;
  /** SP_SYSTEMD_RUN; absent: the runners' default prefix (runner-limits.ts). */
  systemdRun?: string;
  path?: string;
  /** Upload records (HOST_DATA/state/uploads). */
  stateDir: string;
  dir?: string;
  /** On a `podman` host: where a session's `/files` scripts run (sandbox/host.ts `files`). */
  files?(sandbox: SandboxPlace): Place;
}

/** The gid of `name`, or undefined where it does not exist. */
export function groupId(name: string, getent = (n: string) => execFileSync('/usr/bin/getent', ['group', n], { encoding: 'utf8' })): number | undefined {
  try {
    const gid = Number(getent(name).split(':')[2]);
    return Number.isInteger(gid) ? gid : undefined;
  } catch {
    return undefined;
  }
}

/** How api-host starts the relay's socket on this host, or undefined where it must not (see the header). */
export function wireFor(o: WireOptions): ((hooks: WireHooks) => Promise<WireLinkLike>) | undefined {
  if (!o.user) return undefined;
  const podman = o.launch === 'podman';
  if (podman && !o.files) throw new Error('SP_LAUNCH=podman: the wire socket needs the place of a session\'s files');
  const user = o.user;
  return (hooks) => {
    const dir = o.dir ?? WIRE_DIR;
    const group = groupId('sp-wire');
    const terminals = createTerminals({
      dir: path.join(dir, 'terminals'),
      launch: podman ? 'podman' : o.launch === 'systemd' ? 'systemd' : 'detached',
      user: o.user,
      systemdRun: o.systemdRun ?? systemdRunPrefix(os.totalmem()),
      path: o.path,
      group,
    });
    const inSandbox = podman ? o.files : undefined;
    const files = createWorkspaceFiles({
      dir: path.join(dir, 'files'), stateDir: o.stateDir, user,
      // On a podman host nothing reads a workspace outside a container: a workspace without a sandbox is an error, not the host's turn.
      place: inSandbox && ((ws) => {
        if (!ws.sandbox) throw new Error(`session ${ws.sessionId} has no sandbox`);
        return inSandbox(ws.sandbox);
      }),
    });
    return serveWireLink(hooks, { dir, group, terminals, files });
  };
}
