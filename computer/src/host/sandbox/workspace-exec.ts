// Where a sandboxed thread's workspace files are reached (work 103, C13):
// the Place workspace-files.ts runs its scripts in. While the thread's
// container runs, a command is `podman exec` in it, as the session's user;
// while it is stopped, a helper container that mounts the workspace and
// nothing else, without a network, read-only unless the command writes.
//
// Invariants:
// - Either way the command sees the workspace at `/workspace` and runs as
//   uid 1500 inside a user namespace: a symlink a session left in its
//   workspace resolves there, never on the host.
// - `running` is what the host knew when the request came in. A container
//   that stopped since makes `podman exec` fail, and the request with it;
//   nothing falls back to the host.
// - This file builds and starts the command; it does not wait for it.

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { Place } from '../workspace-files.js';
import { HELPER_SCOPE, execArgs, filesHelperArgs } from './podman-args.js';
import { PODMAN } from './podman.js';

/** The workspace as every session sees its own. */
export const WORKSPACE_DIR = '/workspace';

/** A thread's sandbox as the `/files` routes and the terminal need it; api-host.ts fills it from the thread's record. */
export interface SandboxPlace {
  /** The sandbox id (`sp-runner-<id>`). */
  id: string;
  /** `person.dir`. */
  person: string;
  /** The workspace on the host. */
  workspace: string;
  /** The thread's container is running. */
  running: boolean;
}

export interface SandboxPlaces {
  /** `runnerUser(env).sudo`. */
  sudo: string[];
  /** SP_IMAGE: what a helper container runs. */
  image: string;
  /** Tests pass their own. */
  spawn?: (cmd: string, args: string[]) => ChildProcess;
}

/** The argv, after sudo's prefix, of `argv` over `sb`'s workspace. */
export function placeArgv(sb: SandboxPlace, image: string, argv: string[], o: { write?: boolean; stdin?: boolean }): string[] {
  if (sb.running) return [PODMAN, ...execArgs(sb.id, argv, { dir: WORKSPACE_DIR, interactive: o.stdin })];
  const helper = { person: sb.person, workspace: sb.workspace, image, write: o.write, interactive: o.stdin };
  return [...HELPER_SCOPE, PODMAN, ...filesHelperArgs(helper, WORKSPACE_DIR, argv)];
}

export function sandboxPlaces(o: SandboxPlaces): (sb: SandboxPlace) => Place {
  const start = o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] }));
  return (sb) => ({
    root: WORKSPACE_DIR,
    spawn(argv, mode) {
      const [cmd, ...args] = [...o.sudo, '--', ...placeArgv(sb, o.image, argv, mode)];
      return start(cmd, args);
    },
  });
}
