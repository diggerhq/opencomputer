// Runners as another user (work 077): on a computer whose host runs as
// `sp-host`, runners run as `agent`, so the model proxy can tell them apart
// by uid and the host's control socket stays out of their reach. The host
// starts their units in agent's user manager through sudo, which the
// computer's sudoers allows (deploy/vm/sp-host.sh).

import { execFileSync } from 'node:child_process';

export interface RunnerUser {
  /** Goes before systemd-run. */
  sudo: string[];
  /** Their uid: what a socket of theirs belongs to. */
  uid: number;
  /** The user's own HOME, USER, SHELL (and PATH, when the host's differs), over the host's. */
  env: Record<string, string>;
}

/** The host's environment this reads: the user, and the PATH their processes get. */
export type RunnerUserEnv = { SP_RUNNER_USER?: string; SP_RUNNER_PATH?: string };

const known = new Map<string, RunnerUser>();

// Absolute: the host's PATH must never decide what runs as the host (sp-host.sh sets a
// root-owned one), and these two run on every launch and workspace operation.
const SUDO = '/usr/bin/sudo';
const GETENT = '/usr/bin/getent';

/** The runner user's launch prefix and environment; undefined when unset (runners run as the host's user). */
export function runnerUser(env: RunnerUserEnv, passwd = (n: string) => execFileSync(GETENT, ['passwd', n], { encoding: 'utf8' })): RunnerUser | undefined {
  const name = env.SP_RUNNER_USER;
  if (!name) return undefined;
  let u = known.get(name);
  if (!u) {
    // name:x:uid:gid:gecos:home:shell
    const [, , uid, , , home, shell] = passwd(name).trim().split(':');
    if (!uid || !home) throw new Error(`SP_RUNNER_USER: no user ${name}`);
    const run = `/run/user/${uid}`;
    // sudoers keeps these two (env_keep), so systemd-run --user finds agent's manager.
    u = {
      uid: Number(uid),
      sudo: [SUDO, '-n', '-u', name, `XDG_RUNTIME_DIR=${run}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${run}/bus`],
      env: { HOME: home, USER: name, SHELL: shell || '/bin/bash', ...(env.SP_RUNNER_PATH ? { PATH: env.SP_RUNNER_PATH } : {}) },
    };
    known.set(name, u);
  }
  return u;
}
