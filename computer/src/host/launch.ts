// How the host starts a runner outside its own process tree: a transient
// systemd user unit on Linux (the runner itself, or `podman start --attach`
// of its container, work 103), a detached process elsewhere. The one place to
// change how runners are launched.
//
// Invariants: a runner gets RUNNER_SPEC and every variable in RUNNER_ENV
// (runner-env.ts), each set even when empty, never credentials (those go over
// its socket); a systemd unit also inherits the user manager's environment,
// which sessions can change, so nothing a runner reads is left to it. A
// container's unit carries no environment at all: the container's is fixed at
// its creation and by boot.env (sandbox/boot-env.ts). A `podman` launch never
// falls back to anything else: without the bundle or the runners' user it throws.

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { promisify } from 'node:util';
import { HOST_RUN, type RunnerSpec } from '../protocol.js';
import { definitionFile } from '../workspaces/index.js';
import { systemdRunPrefix } from './runner-limits.js';
import { runnerUser } from './runner-user.js';
import { runnerVars } from '../runner-env.js';
import { PODMAN } from './sandbox/podman.js';
import { startArgs, unitName } from './sandbox/podman-args.js';

export type LaunchMode = 'systemd' | 'podman' | 'detached';

const SYSTEMD_RUN = systemdRunPrefix(os.totalmem());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The command that starts a runner from the release at `root`. */
export function launchCommand(rs: RunnerSpec, how: LaunchMode | string, env: NodeJS.ProcessEnv, root: string, has: (p: string) => boolean = existsSync) {
  if (how === 'podman') {
    // The container exists already (sandbox/containers.ts); its unit only holds `podman start --attach`.
    const as = runnerUser(env);
    if (!as) throw new Error('podman launch: no runner user (SP_RUNNER_USER); deploy/vm/sp-host.sh sets one up');
    const boot = path.join(root, 'dist/runner-boot.mjs');
    if (!has(boot)) throw new Error(`podman launch: ${boot} is absent, and a container has no tsx fallback`);
    if (!rs.id) throw new Error('podman launch: a runner without an id');
    const [cmd, ...pre] = [...as.sudo, '--', ...(env.SP_SYSTEMD_RUN || SYSTEMD_RUN).trim().split(/\s+/)];
    const args = [...pre, '-p', 'Delegate=yes', '-p', 'KillMode=mixed', '-p', 'TimeoutStopSec=20', '-p', 'StandardOutput=null', '-p', 'StandardError=journal',
      `--unit=${unitName(rs.id).replace(/\.service$/, '')}`, '--collect', '--quiet', '--', PODMAN, ...startArgs(rs.id)];
    return { cmd, args, env: env as Record<string, string>, detached: false };
  }
  // Every RUNNER_ENV variable, set even when empty: a systemd unit would otherwise take the user manager's, which sessions can change (runner-env.ts).
  const vars: Record<string, string> = { ...runnerVars(env), RUNNER_SPEC: JSON.stringify(rs), SP_RUN: HOST_RUN };
  // Linux sets no TMPDIR, and the system prompt points scratch work at $TMPDIR: an empty one
  // lands files in the worktree. Give runners the same directory os.tmpdir() (and send_file) uses.
  vars.TMPDIR ||= os.tmpdir();
  // The definition in effect, which is the gateway's once one arrived (a runner also finds it under SP_DATA).
  const def = definitionFile();
  if (def) vars.SP_DEFINITION = def;
  const node = runnerCommand(root);
  if (how === 'systemd') {
    const as = runnerUser(env);
    Object.assign(vars, as?.env);
    const [cmd, ...pre] = [...(as?.sudo ?? []), ...(env.SP_SYSTEMD_RUN || SYSTEMD_RUN).trim().split(/\s+/)];
    const unit = `sp-runner-${rs.id ?? createHash('sha1').update(rs.session!.key).digest('hex').slice(0, 12)}`;
    const args = [...pre, `--unit=${unit}`, '--collect', '--quiet', `--working-directory=${workingDirectory(rs, { ...env, ...as?.env })}`,
      ...Object.entries(vars).map(([k, v]) => `--setenv=${k}=${v}`), '--', ...node];
    return { cmd, args, env: env as Record<string, string>, detached: false };
  }
  return { cmd: node[0], args: node.slice(1), env: vars, detached: true };
}

/**
 * Node and its arguments for the runner of the release at `root`: the bundle
 * provision.sh built (scripts/bundle-runner.mjs, about 125 ms faster to start),
 * or the sources under tsx when there is none (a failed build) or `root` is not
 * a release. Only a release is trusted to have a bundle of its own sources:
 * `npm run check` builds one into a checkout too, and a laptop host starting
 * runners from it would run whatever `check` last saw, not the sources it runs
 * itself. provision.sh writes `.sp-version.env` for every release and nothing
 * else does.
 */
export function runnerCommand(root: string, has: (p: string) => boolean = existsSync) {
  const release = path.join(root, '.sp-version.env');
  const boot = path.join(root, 'dist/runner-boot.mjs'); // written after the bundle, so it implies one
  return has(release) && has(boot)
    ? [process.execPath, boot]
    : [process.execPath, '--import', import.meta.resolve('tsx'), path.join(root, 'src/runner/main.ts')];
}

/** The session's fork; a spare (work 069) has none yet and parks its Claude Code elsewhere. */
const workingDirectory = (rs: RunnerSpec, env: NodeJS.ProcessEnv) => rs.session?.forkPath ?? env.HOME ?? os.homedir();

/** Start the runner; resolves once it was spawned (not yet listening). `timeoutMs` bounds each try of a unit's start. */
export async function launch(rs: RunnerSpec, how: LaunchMode | string, env: NodeJS.ProcessEnv, root: string, timeoutMs?: number) {
  const c = launchCommand(rs, how, env, root);
  if (!c.detached) {
    // A unit's name repeats (a session's before work 069, a thread's container since work 103): one may still be held by a runner that just quit.
    // cwd: the runners' user cannot enter every directory the host runs in, and sudo keeps it.
    for (let i = 0; ; i++)
      try {
        await promisify(execFile)(c.cmd, c.args, { env: c.env, cwd: '/', timeout: timeoutMs, killSignal: 'SIGKILL' });
        return;
      } catch (e: any) {
        if (i >= 10 || !/already/.test(String(e?.stderr ?? e?.message))) throw e;
        await sleep(300);
      }
  }
  // Own session and process group, output to a log file: survives the host.
  const logs = path.join(HOST_RUN, 'logs');
  mkdirSync(logs, { recursive: true });
  const fd = openSync(path.join(logs, path.basename(rs.socket, '.sock') + '.log'), 'a');
  spawn(c.cmd, c.args, { cwd: workingDirectory(rs, env), env: c.env, detached: true, stdio: ['ignore', fd, fd] }).unref();
  closeSync(fd);
}
